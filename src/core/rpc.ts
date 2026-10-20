// NEAR JSON-RPC with retries and fallback providers. Public RPCs rate-limit shared IPs (a Cloudflare Worker, an office
// NAT, one person with many tabs), so a single 429 must not reach the user as "HTTP 429". A busy provider (HTTP 408,
// 425, 429, 5xx, a network error, a body that is not JSON, or a provider-side timeout) is retried with exponential
// backoff and jitter, honouring Retry-After, then the next provider is tried. A provider that cannot serve the request
// is skipped at once: a refusal (403, 404, 410), a gateway's "method is not available" (-32601) or -32600, an error
// without NEAR's `name`, or a block that node does not hold (UNKNOWN_BLOCK or GARBAGE_COLLECTED_BLOCK from a
// non-archival node, which keeps about 1.5 days); a block no provider holds is asked of the archival nodes, last. Any
// other NEAR answer, contract errors included, is returned as is: every provider serves the same chain, so the answer
// does not depend on which one replied. `nearRpcBatch` sends `query` entries as one JSON-RPC batch to providers that
// take batches and asks whatever a batch did not answer one by one through `nearRpc`. The clock, sleep, randomness and
// fetch are injected so tests are deterministic.

/** Mainnet providers for `query` view calls, CORS open to browsers, in the order they are asked: fastest first,
 *  rpc.mainnet.near.org (about 3 s a call) last. FastNEAR and near.org were checked 2026-10-13. Intear and Shitzu
 *  were added 2026-10-14, after the docs.near.org RPC read probed them (nearcore nodes keeping about 1.5 days of blocks)
 *  and a check from the site's origin: each answers the CORS preflight and a `call_function` POST with
 *  `access-control-allow-origin` (Shitzu echoes the origin, about 0.5 s, no published limits; Intear `*`, about 1.7 s
 *  because it slows keyless calls by 1 s). Never: near.lava.build (410, discontinued), 1rpc.io/near (no `query`),
 *  BlockPI and ZAN (their keyless endpoints need keys now), and dRPC (its terms, §1.3, rule out our use; removed
 *  2026-10-18, after the payout readers dropped it in 06d7ee9). */
export const NEAR_RPC_PROVIDERS: readonly string[] = [
  "https://rpc.mainnet.fastnear.com",
  "https://free.rpc.fastnear.com",
  "https://rpc.shitzuapes.xyz",
  "https://rpc.intea.rs",
  "https://rpc.mainnet.near.org",
];

/** Archival mainnet nodes, never in the default list: `nearRpc` asks them last, and only after a provider said it does
 *  not hold the block. Pass them as `providers` for reads known to be old (past blocks, proofs). The only keyless one
 *  (2026-10-14): "severely rate limited", 3.5-4 s a call, CORS `*`, no batches; it served a June 2026 block. */
export const NEAR_ARCHIVAL_PROVIDERS: readonly string[] = ["https://archival-rpc.mainnet.near.org"];

/** Providers that take a JSON-RPC batch (checked 2026-10-14): Intear, 1 s slower without a key. FastNEAR, near.org,
 *  Shitzu and the archival node run nearcore 2.13.4 and refuse an array (HTTP 400 PARSE_ERROR); re-probe after 2.14.
 *  Whatever a batch leaves unanswered is asked one by one through `nearRpc`. */
export const NEAR_BATCH_PROVIDERS: readonly string[] = ["https://rpc.intea.rs"];

/** Entries per batch request: nearcore's default `batch_size_limit`. */
export const NEAR_BATCH_MAX = 100;

export type RpcEvent =
  | { kind: "retry"; provider: string; attempt: number; waitMs: number; reason: string }
  | { kind: "fallback"; provider: string };

export interface NearRpcOptions {
  providers?: readonly string[];
  /** Archival nodes, asked after `providers` only when one of them did not hold the block (default
   *  NEAR_ARCHIVAL_PROVIDERS). An archival node's UNKNOWN_BLOCK is the chain's answer. */
  archival?: readonly string[];
  fetch?: typeof fetch;
  /** Milliseconds since some origin; only differences are used. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** In [0, 1): the jitter source. */
  random: () => number;
  /** Attempts per provider (default 3). */
  attempts?: number;
  /** Total time a call may spend waiting between attempts (default 8000 ms). */
  budgetMs?: number;
  onEvent?: (e: RpcEvent) => void;
}

export interface NearRpcBatchOptions extends NearRpcOptions {
  /** Providers that take batches (default NEAR_BATCH_PROVIDERS); `providers` and `archival` serve the single calls. */
  batchProviders?: readonly string[];
}

/** One JSON-RPC call for `nearRpcBatch`. */
export interface NearRpcRequest {
  method: string;
  params: unknown;
}

/** Answers in request order, each the parsed response object (result or a chain error) as `nearRpc` returns it. With
 *  `pin`, every `query` entry reads that one block (`block_id` replaces `finality`), so the answers are one moment. */
export type NearRpcBatchCall = (requests: readonly NearRpcRequest[], pin?: { blockId: number | string }) => Promise<unknown[]>;

/** Every provider was busy or unreachable. The message is safe to show to users. */
export class NearRpcUnavailable extends Error {
  constructor(
    readonly attempts: number,
    readonly lastReason: string,
  ) {
    super("NEAR is busy right now: every public NEAR RPC we use is rate-limiting or unreachable. Try again in a minute.");
    this.name = "NearRpcUnavailable";
  }
}

const BUSY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/**
 * JSON-RPC error causes that describe the provider, not the chain: another try (or provider) can answer.
 * UNAVAILABLE_SHARD: that node does not track the shard the account lives on.
 */
const BUSY_CAUSES = new Set(["TIMEOUT_ERROR", "INTERNAL_ERROR", "NO_SYNCED_BLOCKS", "NOT_SYNCED_YET", "UNAVAILABLE_SHARD"]);
/**
 * Causes that mean "this node does not hold that block", not "there is no such block". A non-archival node keeps about
 * 1.5 days and answers UNKNOWN_BLOCK ("DB Not Found Error: BLOCK HEADER") for anything older (probed 2026-10-14; the
 * docs' tables name GARBAGE_COLLECTED_BLOCK); a lagging node lacks a block that is too new. Only an archival node's is
 * an answer.
 */
const MISSING_BLOCK_CAUSES = new Set(["UNKNOWN_BLOCK", "GARBAGE_COLLECTED_BLOCK"]);
/** Statuses some providers put on a JSON-RPC error about the request itself: NEAR's error is the answer. */
const REQUEST_ERROR_STATUS = new Set([400, 422]);
/** Single calls in flight at once after a batch falls back (the refund views already go 3 or 4 at a time). */
const SINGLES_AT_ONCE = 4;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One try at one provider: its answer, a busy provider (retry it, then the next), or one that cannot serve this
 *  request (the next, at once; `missingBlock` when it lacks the block, `forGood` when it will never take a batch). */
type Try<T> =
  | { kind: "answer"; value: T }
  | { kind: "busy"; reason: string; retryAfterMs: number | null }
  | { kind: "skip"; reason: string; missingBlock?: boolean; forGood?: boolean };

const busy = (reason: string, retryAfterMs: number | null = null): Try<never> => ({ kind: "busy", reason, retryAfterMs });
const skip = (reason: string): Try<never> => ({ kind: "skip", reason });

const causeOf = (err: Record<string, unknown>): string | null => (isObj(err["cause"]) && typeof err["cause"]["name"] === "string" ? err["cause"]["name"] : null);
/** A short name for a JSON-RPC error: NEAR's cause, else the gateway's message, else its code. */
const errorName = (err: Record<string, unknown>): string => causeOf(err) ?? (typeof err["message"] === "string" ? err["message"] : `JSON-RPC error ${String(err["code"])}`);

/** What one JSON-RPC response object is: NEAR's answer, a busy provider, or a provider that cannot serve the request. */
function judge(body: unknown, archival: boolean): Try<unknown> {
  if (!isObj(body)) return busy("not a JSON-RPC object");
  if ("result" in body) return { kind: "answer", value: body };
  const err = body["error"];
  if (typeof err === "string") return busy(err); // a gateway's own error, not NEAR's
  if (!isObj(err)) return busy("no result");
  const cause = causeOf(err);
  if (cause !== null && BUSY_CAUSES.has(cause)) return busy(cause);
  if (err["code"] === 429 || err["code"] === -32005) return busy("rate limited");
  // This provider does not run the method (a gateway's -32601 "method is not available", an older nearcore's
  // METHOD_NOT_FOUND), will not take the request (-32600), or is not NEAR answering (no `name`): another one may.
  if (err["code"] === -32601 || err["code"] === -32600 || cause === "METHOD_NOT_FOUND" || typeof err["name"] !== "string") return skip(errorName(err));
  if (!archival && cause !== null && MISSING_BLOCK_CAUSES.has(cause)) return { kind: "skip", reason: cause, missingBlock: true };
  return { kind: "answer", value: body };
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (v === null) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

// `fetchImpl` is always called as a plain function: browsers and Workers reject a `fetch` called with another `this`.
const post = (fetchImpl: typeof fetch, provider: string, body: unknown): Promise<Response> =>
  fetchImpl(provider, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** One single call at one provider. */
async function askOne(fetchImpl: typeof fetch, provider: string, body: unknown, archival: boolean): Promise<Try<unknown>> {
  const res = await post(fetchImpl, provider, body);
  if (BUSY_STATUS.has(res.status)) return busy(`HTTP ${res.status}`, retryAfterMs(res));
  if (REQUEST_ERROR_STATUS.has(res.status)) {
    // NEAR's error about our request is the answer from any provider; anything else, try the next one.
    const parsed = await readJson(res);
    const t = isObj(parsed) && isObj(parsed["error"]) ? judge(parsed, archival) : null;
    if (t === null) return skip(`HTTP ${res.status}`);
    return t.kind === "busy" ? skip(t.reason) : t;
  }
  if (!res.ok) return skip(`HTTP ${res.status}`); // refused for good by this provider (403, 404, 410…)
  return judge(await readJson(res), archival);
}

interface Entry {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

/** One batch at one provider: the reply's entries, a busy provider, or one that will not take this batch. */
async function askBatch(fetchImpl: typeof fetch, provider: string, entries: readonly Entry[]): Promise<Try<unknown[]>> {
  const res = await post(fetchImpl, provider, entries);
  if (BUSY_STATUS.has(res.status)) return busy(`HTTP ${res.status}`, retryAfterMs(res));
  const parsed = await readJson(res);
  if (res.ok && Array.isArray(parsed)) return { kind: "answer", value: parsed as unknown[] };
  if (res.ok && parsed === undefined) return busy("not JSON");
  const err = isObj(parsed) && isObj(parsed["error"]) ? parsed["error"] : null;
  const cause = err !== null ? causeOf(err) : null;
  if (res.ok && (err?.["code"] === 429 || (cause !== null && BUSY_CAUSES.has(cause)))) return busy(cause ?? "rate limited");
  // Anything else is a refusal: nearcore 2.13.4's HTTP 400 PARSE_ERROR, a gateway's -32601, -32005 (batches are off),
  // a reply that is not an array. Too many entries or too big a reply (HTTP 413, -32010, -32011) is about this batch
  // only, so the provider is asked to batch again next time.
  const tooBig = res.status === 413 || err?.["code"] === -32010 || err?.["code"] === -32011;
  return { kind: "skip", reason: `no batch: ${err !== null ? errorName(err) : `HTTP ${res.status}`}`, forGood: !tooBig };
}

interface Settings {
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  attempts: number;
  budgetMs: number;
  onEvent: ((e: RpcEvent) => void) | undefined;
}

const settingsOf = (opts: NearRpcOptions): Settings => ({
  fetchImpl: opts.fetch ?? fetch,
  now: opts.now,
  sleep: opts.sleep,
  random: opts.random,
  attempts: opts.attempts ?? 3,
  budgetMs: opts.budgetMs ?? 8000,
  onEvent: opts.onEvent,
});

/** One call's walk over providers: retries with backoff and jitter inside the time budget that started at `start`,
 *  retry and fallback events, and what to throw when nobody answered. */
function walk(s: Settings, start: number) {
  let tried = 0;
  let asked = 0;
  let lastReason = "no provider";
  return {
    /** Up to `attempts` tries at one provider while it is busy: its answer, or null to move on. */
    async at<T>(provider: string, once: () => Promise<Try<T>>): Promise<{ value: T } | null> {
      if (asked++ > 0) s.onEvent?.({ kind: "fallback", provider });
      for (let attempt = 1; attempt <= s.attempts; attempt++) {
        tried++;
        let t: Try<T>;
        try {
          t = await once();
        } catch (e) {
          t = busy(e instanceof Error ? e.message : "network error");
        }
        if (t.kind === "answer") return { value: t.value };
        lastReason = t.reason;
        if (t.kind === "skip" || attempt === s.attempts) return null;
        const waitMs = Math.round(t.retryAfterMs ?? 250 * 2 ** (attempt - 1) * (0.5 + s.random()));
        if (waitMs > s.budgetMs - (s.now() - start)) return null; // this provider cannot answer in time: try the next one now
        s.onEvent?.({ kind: "retry", provider, attempt, waitMs, reason: lastReason });
        await s.sleep(waitMs);
      }
      return null;
    },
    unavailable: () => new NearRpcUnavailable(tried, lastReason),
  };
}

/** A JSON-RPC caller: posts `body` (one request object; batches go through `nearRpcBatch`) and returns the parsed
 *  response object (result or a chain error). */
export function nearRpc(opts: NearRpcOptions): (body: unknown) => Promise<unknown> {
  const s = settingsOf(opts);
  const providers = opts.providers ?? NEAR_RPC_PROVIDERS;
  const archival = opts.archival ?? NEAR_ARCHIVAL_PROVIDERS;

  return async (body: unknown) => {
    const run = walk(s, s.now());
    let missingBlock = false;
    const ask = async (list: readonly string[]): Promise<{ value: unknown } | null> => {
      for (const provider of list) {
        const got = await run.at(provider, async () => {
          const t = await askOne(s.fetchImpl, provider, body, archival.includes(provider));
          if (t.kind === "skip" && t.missingBlock === true) missingBlock = true;
          return t;
        });
        if (got) return got;
      }
      return null;
    };
    // A provider that did not hold the block sends the call on to the archival nodes, last.
    const got = (await ask(providers)) ?? (missingBlock ? await ask(archival.filter((a) => !providers.includes(a))) : null);
    if (got) return got.value;
    throw run.unavailable();
  };
}

/** `query` params read at one block: `block_id` replaces `finality` and `sync_checkpoint`. */
function pinned(params: unknown, blockId: number | string): unknown {
  if (!isObj(params)) return params;
  const { finality: _finality, sync_checkpoint: _syncCheckpoint, ...rest } = params;
  return { ...rest, block_id: blockId };
}

/** Runs `work` on every item, at most `size` at a time; the first failure stops new work and is thrown. */
async function inTurns<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = items.values();
  let failed = false;
  const worker = async (): Promise<void> => {
    for (const item of queue) {
      if (failed) return;
      try {
        await work(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/**
 * A batch caller: the `query` entries go as one JSON-RPC batch (at most NEAR_BATCH_MAX a request, matched by id) to the
 * first batch provider that takes it, retried while busy like `nearRpc`. A provider that refuses batches is not asked
 * to batch again by this caller. Whatever no batch answered (other methods, a busy shard, a block that provider lacks,
 * a missing entry, or no provider taking batches) is asked one by one through `nearRpc`, so every entry gets NEAR's
 * answer or the call throws NearRpcUnavailable. Batching saves round trips, not quota: providers may bill each entry.
 */
export function nearRpcBatch(opts: NearRpcBatchOptions): NearRpcBatchCall {
  const s = settingsOf(opts);
  const batchProviders = opts.batchProviders ?? NEAR_BATCH_PROVIDERS;
  const archival = opts.archival ?? NEAR_ARCHIVAL_PROVIDERS;
  const firstSingle = (opts.providers ?? NEAR_RPC_PROVIDERS)[0];
  const refused = new Set<string>(); // providers that refused a batch: single calls only, from now on

  return async (requests, pin) => {
    const start = s.now();
    const entries = requests.map(
      (r, i): Entry => ({ jsonrpc: "2.0", id: i + 1, method: r.method, params: pin !== undefined && r.method === "query" ? pinned(r.params, pin.blockId) : r.params }),
    );
    const answers = new Map<number, unknown>();
    // Only `query` runs inside a batch (docs.near.org /api/rpc/batching).
    const queries = entries.filter((e) => e.method === "query");
    let batched = false;
    for (let from = 0; from < queries.length; from += NEAR_BATCH_MAX) {
      const chunk = queries.slice(from, from + NEAR_BATCH_MAX);
      const run = walk(s, start);
      for (const provider of batchProviders.filter((p) => !refused.has(p))) {
        batched = true;
        const got = await run.at(provider, async () => {
          const t = await askBatch(s.fetchImpl, provider, chunk);
          if (t.kind === "skip" && t.forGood === true) refused.add(provider);
          return t;
        });
        if (!got) continue;
        // Entries come back in any order and are judged one by one, like single answers.
        const ids = new Map(chunk.map((e) => [String(e.id), e.id]));
        for (const reply of got.value) {
          const id = isObj(reply) ? ids.get(String(reply["id"])) : undefined;
          if (id !== undefined && !answers.has(id) && judge(reply, archival.includes(provider)).kind === "answer") answers.set(id, reply);
        }
        break;
      }
    }
    const rest = entries.filter((e) => !answers.has(e.id));
    if (batched && firstSingle !== undefined && rest.some((e) => e.method === "query")) s.onEvent?.({ kind: "fallback", provider: firstSingle });
    await inTurns(rest, SINGLES_AT_ONCE, async (e) => {
      const single = nearRpc({ ...opts, budgetMs: Math.max(0, s.budgetMs - (s.now() - start)) });
      answers.set(e.id, await single(e));
    });
    return entries.map((e) => answers.get(e.id));
  };
}
