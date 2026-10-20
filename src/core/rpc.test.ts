// NEAR JSON-RPC with retries and fallback providers: a busy provider (429, 5xx, network error) is retried with backoff,
// then the next provider is tried; a provider that cannot serve the request (a gateway's -32601, an error without
// NEAR's name, a block it does not hold) is skipped at once, ending on the archival nodes for a block nobody else
// holds; a chain answer (a contract error included) is returned as is, never retried. nearRpcBatch sends `query`
// entries as one batch where batches are accepted and asks the rest one by one. Clock, sleep and fetch are injected.
import { describe, expect, it } from "vitest";

import {
  NEAR_ARCHIVAL_PROVIDERS,
  NEAR_BATCH_MAX,
  NEAR_BATCH_PROVIDERS,
  NEAR_RPC_PROVIDERS,
  NearRpcUnavailable,
  nearRpc,
  nearRpcBatch,
  type NearRpcRequest,
  type RpcEvent,
} from "./rpc.js";

const OK = { jsonrpc: "2.0", id: 1, result: { result: [123], block_height: 1 } };
const CONTRACT_ERROR = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "x" } };
const BODY = { jsonrpc: "2.0", id: 1, method: "status", params: [] };

/** A NEAR handler error as nearcore sends it. */
const nearError = (cause: string, id: unknown = 1) => ({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: cause, info: {} }, code: -32000, message: "Server error" } });

type Canned = number | "network" | { status?: number; body: unknown; headers?: Record<string, string> };
/** A canned reply, or one built from the posted body (a batch's entries, a single call's id). */
type Reply = Canned | ((sent: unknown) => Canned);

/** A fetch that answers each provider from its own queue of replies, recording every call and every posted body. */
function fakeFetch(replies: Record<string, Reply[]>, calls: string[] = [], sent: unknown[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const posted: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push(posted);
    const reply = replies[url]?.shift();
    const next = typeof reply === "function" ? reply(posted) : reply;
    if (next === undefined) throw new Error(`unexpected call to ${url}`);
    if (next === "network") throw new TypeError("fetch failed");
    if (typeof next === "number") return new Response("busy", { status: next });
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  }) as typeof fetch;
}

/** A fake clock: sleep advances it, so the wait budget is checked without real time passing. */
function fakeTime() {
  let t = 0;
  const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits };
}

const A = "https://a.example";
const B = "https://b.example";
const ARCH = "https://archive.example";

describe("nearRpc", () => {
  it("keeps FastNEAR first and asks the slowest provider, rpc.mainnet.near.org (about 3 s a call), last", () => {
    expect(NEAR_RPC_PROVIDERS[0]).toBe("https://rpc.mainnet.fastnear.com");
    expect(NEAR_RPC_PROVIDERS).toEqual([
      "https://rpc.mainnet.fastnear.com",
      "https://free.rpc.fastnear.com",
      "https://rpc.shitzuapes.xyz",
      "https://rpc.intea.rs",
      "https://rpc.mainnet.near.org",
    ]);
  });

  it("keeps the rate-limited archival node out of the default list, batches only where batches are taken, and never lists keyed, query-less or dRPC hosts", () => {
    expect(NEAR_ARCHIVAL_PROVIDERS).toEqual(["https://archival-rpc.mainnet.near.org"]);
    for (const a of NEAR_ARCHIVAL_PROVIDERS) expect(NEAR_RPC_PROVIDERS).not.toContain(a);
    expect(NEAR_BATCH_PROVIDERS).toEqual(["https://rpc.intea.rs"]);
    for (const b of NEAR_BATCH_PROVIDERS) expect(NEAR_RPC_PROVIDERS).toContain(b); // the same CORS check
    expect(NEAR_BATCH_MAX).toBe(100);
    // dRPC: its terms (§1.3) rule out our use; no 1RPC either
    for (const p of [...NEAR_RPC_PROVIDERS, ...NEAR_ARCHIVAL_PROVIDERS, ...NEAR_BATCH_PROVIDERS]) expect(p).not.toMatch(/blockpi|zan\.top|1rpc|lava\.build|drpc/);
  });

  it("retries a 429 on the same provider and returns the answer", async () => {
    const calls: string[] = [];
    const time = fakeTime();
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [429, { body: OK }] }, calls), ...time, random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, A]);
    expect(time.waits).toHaveLength(1);
  });

  it("honours Retry-After when it fits the budget", async () => {
    const time = fakeTime();
    const rpc = nearRpc({
      providers: [A],
      fetch: fakeFetch({ [A]: [{ status: 429, body: {}, headers: { "retry-after": "2" } }, { body: OK }] }),
      ...time,
      random: () => 0.5,
    });
    expect(await rpc(BODY)).toEqual(OK);
    expect(time.waits).toEqual([2000]);
  });

  it("falls back to the next provider after a provider's retries run out", async () => {
    const calls: string[] = [];
    const events: RpcEvent[] = [];
    const rpc = nearRpc({
      providers: [A, B],
      fetch: fakeFetch({ [A]: [429, 503, "network"], [B]: [{ body: OK }] }, calls),
      ...fakeTime(),
      random: () => 0.5,
      onEvent: (e) => events.push(e),
    });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, A, A, B]);
    expect(events.some((e) => e.kind === "retry")).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "fallback", provider: B });
  });

  it("returns a contract error as the answer, without retrying or falling back", async () => {
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ body: CONTRACT_ERROR }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(CONTRACT_ERROR);
    expect(calls).toEqual([A]);
  });

  it("moves to the next provider at once when one refuses for good (HTTP 410)", async () => {
    const calls: string[] = [];
    const time = fakeTime();
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [410], [B]: [{ body: OK }] }, calls), ...time, random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, B]);
    expect(time.waits).toEqual([]);
  });

  it("treats a provider-side timeout error as busy and tries again", async () => {
    const timeout = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } };
    const rpc = nearRpc({ providers: [A], fetch: fakeFetch({ [A]: [{ body: timeout }, { body: OK }] }), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
  });

  it("a node that does not track the shard (UNAVAILABLE_SHARD) is busy: another try or provider can answer", async () => {
    const shard = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNAVAILABLE_SHARD", info: {} } } };
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ body: shard }, { body: shard }, { body: shard }], [B]: [{ body: OK }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, A, A, B]);
  });

  it("an HTTP 400 or 422 carrying a JSON-RPC error is the answer (a bad request is not a busy NEAR)", async () => {
    const invalid = { jsonrpc: "2.0", id: 1, error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" }, message: "x" } };
    for (const status of [400, 422]) {
      const calls: string[] = [];
      const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ status, body: invalid }] }, calls), ...fakeTime(), random: () => 0.5 });
      expect(await rpc(BODY)).toEqual(invalid);
      expect(calls).toEqual([A]);
    }
  });

  it("throws a typed NearRpcUnavailable when every provider is busy", async () => {
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [429, 429, 429], [B]: [500, "network", 502] }), ...fakeTime(), random: () => 0.5 });
    const err = await rpc(BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NearRpcUnavailable);
    expect((err as NearRpcUnavailable).attempts).toBe(6);
    expect((err as NearRpcUnavailable).message).toMatch(/NEAR is busy/);
  });

  it("stops waiting once the time budget is spent", async () => {
    const time = fakeTime();
    const rpc = nearRpc({
      providers: [A, B],
      fetch: fakeFetch({ [A]: [{ status: 429, body: {}, headers: { "retry-after": "60" } }], [B]: [{ body: OK }] }),
      ...time,
      random: () => 0.5,
      budgetMs: 8000,
    });
    // a 60 s Retry-After does not fit an 8 s budget: skip straight to the next provider
    expect(await rpc(BODY)).toEqual(OK);
    expect(time.now()).toBeLessThanOrEqual(8000);
  });

  it("never sleeps past the budget across providers", async () => {
    const time = fakeTime();
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [429, 429, 429], [B]: [429, 429, 429] }), ...time, random: () => 1, budgetMs: 1000 });
    await expect(rpc(BODY)).rejects.toBeInstanceOf(NearRpcUnavailable);
    expect(time.now()).toBeLessThanOrEqual(1000);
  });
});

describe("nearRpc: a provider that cannot serve the request is skipped, not believed", () => {
  // dRPC's answer to a method it does not run (tx_status, 2026-10-14): HTTP 400, no NEAR `name`.
  const NOT_AVAILABLE = { jsonrpc: "2.0", id: 1, error: { message: "method is not available", code: -32601 } };

  it("a gateway's -32601 'method is not available' tries the next provider at once (HTTP 400 or 200)", async () => {
    for (const status of [400, 200]) {
      const calls: string[] = [];
      const time = fakeTime();
      const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ status, body: NOT_AVAILABLE }], [B]: [{ body: OK }] }, calls), ...time, random: () => 0.5 });
      expect(await rpc(BODY)).toEqual(OK);
      expect(calls).toEqual([A, B]);
      expect(time.waits).toEqual([]);
    }
  });

  it("so do nearcore's own METHOD_NOT_FOUND (an older node), -32600, and any error without NEAR's name", async () => {
    const cannot = [
      { jsonrpc: "2.0", id: 1, error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND", info: { method_name: "tx_status" } }, code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "upstream request failed" } },
    ];
    for (const body of cannot) {
      const calls: string[] = [];
      const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ body }], [B]: [{ body: OK }] }, calls), ...fakeTime(), random: () => 0.5 });
      expect(await rpc(BODY)).toEqual(OK);
      expect(calls).toEqual([A, B]);
    }
  });

  it("when no provider serves the method, it gives up after one try each and names the reason", async () => {
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ status: 400, body: NOT_AVAILABLE }], [B]: [{ status: 400, body: NOT_AVAILABLE }] }), ...fakeTime(), random: () => 0.5 });
    const err = await rpc(BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NearRpcUnavailable);
    expect((err as NearRpcUnavailable).attempts).toBe(2);
    expect((err as NearRpcUnavailable).lastReason).toMatch(/method is not available/);
  });

  it("still returns real chain answers as is: an unknown account, a contract panic, no contract code, the legacy result.error", async () => {
    const answers = [
      nearError("UNKNOWN_ACCOUNT"),
      { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: "MethodResolveError(MethodNotFound)" } }, code: -32000, message: "Server error" } },
      nearError("NO_CONTRACT_CODE"),
      { jsonrpc: "2.0", id: 1, result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", logs: [], block_height: 1, block_hash: "B" } },
    ];
    for (const body of answers) {
      const calls: string[] = [];
      const rpc = nearRpc({ providers: [A, B], archival: [ARCH], fetch: fakeFetch({ [A]: [{ body }] }, calls), ...fakeTime(), random: () => 0.5 });
      expect(await rpc(BODY)).toEqual(body);
      expect(calls).toEqual([A]);
    }
  });
});

describe("nearRpc: a block a node does not hold is not a fact about the chain", () => {
  // What every non-archival node answered for a 2026-06-25 block on 2026-10-14: UNKNOWN_BLOCK, never GARBAGE_COLLECTED_BLOCK.
  const UNKNOWN_BLOCK = {
    jsonrpc: "2.0",
    id: 1,
    error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} }, code: -32000, message: "Server error", data: "DB Not Found Error: BLOCK HEADER: GegGzv2j71CXo66i9s9j9tnz42fhz72yxFmx2a9rMPGF" },
  };
  const PINNED = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", account_id: "intents.near", block_id: "GegGzv2j71CXo66i9s9j9tnz42fhz72yxFmx2a9rMPGF" } };

  it("UNKNOWN_BLOCK from a non-archival node tries the next provider, and the archival nodes last (at any HTTP status)", async () => {
    const calls: string[] = [];
    const events: RpcEvent[] = [];
    const rpc = nearRpc({
      providers: [A, B],
      archival: [ARCH],
      fetch: fakeFetch({ [A]: [{ body: UNKNOWN_BLOCK }], [B]: [{ status: 422, body: UNKNOWN_BLOCK }], [ARCH]: [{ body: OK }] }, calls),
      ...fakeTime(),
      random: () => 0.5,
      onEvent: (e) => events.push(e),
    });
    expect(await rpc(PINNED)).toEqual(OK);
    expect(calls).toEqual([A, B, ARCH]);
    expect(events).toEqual([{ kind: "fallback", provider: B }, { kind: "fallback", provider: ARCH }]);
  });

  it("GARBAGE_COLLECTED_BLOCK too; a node that holds the block answers before any archival node is asked", async () => {
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [A, B], archival: [ARCH], fetch: fakeFetch({ [A]: [{ body: nearError("GARBAGE_COLLECTED_BLOCK") }], [B]: [{ body: OK }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(PINNED)).toEqual(OK);
    expect(calls).toEqual([A, B]);
  });

  it("an archival node's UNKNOWN_BLOCK is the chain's answer: there is no such block", async () => {
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [A], archival: [ARCH], fetch: fakeFetch({ [A]: [{ body: UNKNOWN_BLOCK }], [ARCH]: [{ body: UNKNOWN_BLOCK }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(PINNED)).toEqual(UNKNOWN_BLOCK);
    expect(calls).toEqual([A, ARCH]);
  });

  it("a read sent straight to the archival nodes takes their answer", async () => {
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [ARCH], archival: [ARCH], fetch: fakeFetch({ [ARCH]: [{ body: UNKNOWN_BLOCK }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(PINNED)).toEqual(UNKNOWN_BLOCK);
    expect(calls).toEqual([ARCH]);
  });

  it("the archival nodes are asked only about a block someone did not hold, never because providers are busy", async () => {
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [A, B], archival: [ARCH], fetch: fakeFetch({ [A]: [429, 429, 429], [B]: [503, 503, 503] }, calls), ...fakeTime(), random: () => 0.5 });
    await expect(rpc(PINNED)).rejects.toBeInstanceOf(NearRpcUnavailable);
    expect(calls).not.toContain(ARCH);
  });

  it("a busy archival node means NEAR is busy, never that the block does not exist", async () => {
    const rpc = nearRpc({ providers: [A], archival: [ARCH], fetch: fakeFetch({ [A]: [{ body: UNKNOWN_BLOCK }], [ARCH]: [429, 429, 429] }), ...fakeTime(), random: () => 0.5 });
    await expect(rpc(PINNED)).rejects.toBeInstanceOf(NearRpcUnavailable);
  });
});

describe("nearRpcBatch", () => {
  const S = "https://single.example";
  const HASH = "84jwR4khU8pMuDqj87Wx8PEAbDUpco9rJ2Zb7RazLUUQ";
  const view = (n: number) => ({ request_type: "call_function", account_id: "c.near", method_name: `m${n}`, args_base64: "e30=" });
  const q = (n: number): NearRpcRequest => ({ method: "query", params: { ...view(n), finality: "final" } });
  const okFor = (id: unknown) => ({ jsonrpc: "2.0", id, result: { result: [id], block_height: 7, block_hash: "H" } });
  const idOf = (entry: unknown): unknown => (typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined);
  /** Answers whatever it is sent: every entry of a batch, or the single call, each under its own id. */
  const echo: Reply = (sent) => ({ body: Array.isArray(sent) ? (sent as unknown[]).map((e) => okFor(idOf(e))) : okFor(idOf(sent)) });
  const each = (n: number, r: Reply): Reply[] => Array.from({ length: n }, () => r);
  const single = (id: number) => ({ jsonrpc: "2.0", id, method: "query", params: q(id).params });
  // nearcore 2.13.4 (FastNEAR, near.org, Shitzu, the archival node) answers an array like this.
  const PARSE_ERROR = {
    status: 400,
    body: { jsonrpc: "2.0", error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR", info: { error_message: "JSON RPC Request format was expected" } }, code: -32700, message: "Parse error" }, id: null },
  };

  it("sends the query entries as one batch and matches the answers by id, whatever their order", async () => {
    const calls: string[] = [];
    const sent: unknown[] = [];
    const reversed: Reply = (s) => ({ body: (s as unknown[]).map((e) => okFor(idOf(e))).reverse() });
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [reversed] }, calls, sent), ...fakeTime(), random: () => 0.5 });
    expect(await batch([q(1), q(2), q(3)])).toEqual([okFor(1), okFor(2), okFor(3)]);
    expect(calls).toEqual([A]);
    expect(sent[0]).toEqual([single(1), single(2), single(3)]);
  });

  it("pins every query entry to one block when asked: block_id replaces finality", async () => {
    const sent: unknown[] = [];
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [echo] }, [], sent), ...fakeTime(), random: () => 0.5 });
    await batch([q(1), q(2)], { blockId: HASH });
    expect(sent[0]).toEqual([1, 2].map((id) => ({ jsonrpc: "2.0", id, method: "query", params: { ...view(id), block_id: HASH } })));
  });

  it("a provider that refuses batches (400 PARSE_ERROR, a gateway's -32601 or -32005, a reply that is not an array) gets each entry on its own through nearRpc", async () => {
    const refusals: Canned[] = [
      PARSE_ERROR,
      { status: 400, body: { jsonrpc: "2.0", id: null, error: { message: "method is not available", code: -32601 } } },
      { body: { jsonrpc: "2.0", id: null, error: { code: -32005, message: "batch requests are not supported by this server" } } },
      { body: okFor(1) },
    ];
    for (const refusal of refusals) {
      const calls: string[] = [];
      const sent: unknown[] = [];
      const events: RpcEvent[] = [];
      const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [refusal], [S]: each(2, echo) }, calls, sent), ...fakeTime(), random: () => 0.5, onEvent: (e) => events.push(e) });
      expect(await batch([q(1), q(2)])).toEqual([okFor(1), okFor(2)]);
      expect(calls).toEqual([A, S, S]);
      expect(sent.slice(1)).toEqual([single(1), single(2)]);
      expect(events).toEqual([{ kind: "fallback", provider: S }]);
    }
  });

  it("never asks a provider that refused to batch again (for the caller's lifetime)", async () => {
    const calls: string[] = [];
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [PARSE_ERROR], [S]: each(4, echo) }, calls), ...fakeTime(), random: () => 0.5 });
    await batch([q(1), q(2)]);
    expect(await batch([q(1), q(2)])).toEqual([okFor(1), okFor(2)]);
    expect(calls).toEqual([A, S, S, S, S]);
  });

  it("tries the next batch provider before going one by one", async () => {
    const calls: string[] = [];
    const events: RpcEvent[] = [];
    const batch = nearRpcBatch({ batchProviders: [A, B], providers: [S], fetch: fakeFetch({ [A]: [PARSE_ERROR], [B]: [echo] }, calls), ...fakeTime(), random: () => 0.5, onEvent: (e) => events.push(e) });
    expect(await batch([q(1), q(2)])).toEqual([okFor(1), okFor(2)]);
    expect(calls).toEqual([A, B]);
    expect(events).toEqual([{ kind: "fallback", provider: B }]);
  });

  it("retries a busy batch provider with backoff and Retry-After, with the same events as a single call", async () => {
    const calls: string[] = [];
    const events: RpcEvent[] = [];
    const time = fakeTime();
    const batch = nearRpcBatch({
      batchProviders: [A],
      providers: [S],
      fetch: fakeFetch({ [A]: [{ status: 429, body: {}, headers: { "retry-after": "2" } }, "network", echo] }, calls),
      ...time,
      random: () => 0.5,
      onEvent: (e) => events.push(e),
    });
    expect(await batch([q(1), q(2)])).toEqual([okFor(1), okFor(2)]);
    expect(calls).toEqual([A, A, A]);
    expect(time.waits).toEqual([2000, 500]);
    expect(events).toEqual([
      { kind: "retry", provider: A, attempt: 1, waitMs: 2000, reason: "HTTP 429" },
      { kind: "retry", provider: A, attempt: 2, waitMs: 500, reason: "fetch failed" },
    ]);
  });

  it("a batch that was only too big (HTTP 413, -32010, -32011) goes one by one this time and is batched again next time", async () => {
    const tooBig: Canned[] = [
      413,
      { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32010, message: "too many requests in batch" } } },
      { body: { jsonrpc: "2.0", id: null, error: { code: -32011, message: "response too big" } } },
    ];
    for (const reply of tooBig) {
      const calls: string[] = [];
      const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [reply, echo], [S]: each(2, echo) }, calls), ...fakeTime(), random: () => 0.5 });
      await batch([q(1), q(2)]);
      expect(await batch([q(1), q(2)])).toEqual([okFor(1), okFor(2)]);
      expect(calls).toEqual([A, S, S, A]);
    }
  });

  it("asks one by one for what a batch did not answer: a busy shard, a block that provider lacks, a missing entry", async () => {
    const calls: string[] = [];
    const sent: unknown[] = [];
    const partial: Reply = () => ({ body: [okFor(1), nearError("UNAVAILABLE_SHARD", 2), nearError("UNKNOWN_BLOCK", 3)] });
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [partial], [S]: each(3, echo) }, calls, sent), ...fakeTime(), random: () => 0.5 });
    expect(await batch([q(1), q(2), q(3), q(4)])).toEqual([okFor(1), okFor(2), okFor(3), okFor(4)]);
    expect(calls).toEqual([A, S, S, S]);
    expect(sent.slice(1).map(idOf)).toEqual([2, 3, 4]);
  });

  it("a pinned block that only the archival nodes still hold is answered there, still pinned", async () => {
    const calls: string[] = [];
    const sent: unknown[] = [];
    const lacksAll: Reply = (s) => ({ body: (s as unknown[]).map((e) => nearError("UNKNOWN_BLOCK", idOf(e))) });
    const lacks: Reply = (s) => ({ body: nearError("UNKNOWN_BLOCK", idOf(s)) });
    const batch = nearRpcBatch({
      batchProviders: [A],
      providers: [S],
      archival: [ARCH],
      fetch: fakeFetch({ [A]: [lacksAll], [S]: each(2, lacks), [ARCH]: each(2, echo) }, calls, sent),
      ...fakeTime(),
      random: () => 0.5,
    });
    expect(await batch([q(1), q(2)], { blockId: 204242398 })).toEqual([okFor(1), okFor(2)]);
    expect(calls[0]).toBe(A);
    expect(calls.filter((c) => c === S)).toHaveLength(2);
    expect(calls.filter((c) => c === ARCH)).toHaveLength(2);
    for (const s of sent.slice(1)) expect(s).toMatchObject({ params: { block_id: 204242398 } });
  });

  it("contract errors inside a batch are answers, never asked again", async () => {
    const calls: string[] = [];
    const panic = { jsonrpc: "2.0", id: 2, error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: {} }, code: -32000, message: "Server error" } };
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [{ body: [panic, okFor(1)] }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await batch([q(1), q(2)])).toEqual([okFor(1), panic]);
    expect(calls).toEqual([A]);
  });

  it("only query runs inside a batch: any other method goes on its own, never pinned", async () => {
    const calls: string[] = [];
    const sent: unknown[] = [];
    const events: RpcEvent[] = [];
    const block: NearRpcRequest = { method: "block", params: { finality: "final" } };
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [echo], [S]: [echo] }, calls, sent), ...fakeTime(), random: () => 0.5, onEvent: (e) => events.push(e) });
    expect(await batch([q(1), block, q(3)], { blockId: 5 })).toEqual([okFor(1), okFor(2), okFor(3)]);
    expect(calls).toEqual([A, S]);
    expect((sent[0] as unknown[]).map(idOf)).toEqual([1, 3]);
    expect(sent[1]).toEqual({ jsonrpc: "2.0", id: 2, method: "block", params: { finality: "final" } });
    expect(events).toEqual([]);
  });

  it(`splits more than ${NEAR_BATCH_MAX} query entries into batches of at most ${NEAR_BATCH_MAX}`, async () => {
    const sent: unknown[] = [];
    const requests = Array.from({ length: 150 }, (_, i) => q(i + 1));
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [echo, echo] }, [], sent), ...fakeTime(), random: () => 0.5 });
    expect(await batch(requests)).toEqual(requests.map((_, i) => okFor(i + 1)));
    expect(sent.map((s) => (s as unknown[]).length)).toEqual([100, 50]);
  });

  it("asks nothing for no requests", async () => {
    const calls: string[] = [];
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({}, calls), ...fakeTime(), random: () => 0.5 });
    expect(await batch([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("says NEAR is busy when neither a batch nor single calls get through", async () => {
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [503, 503, 503], [S]: [503, 503, 503] }), ...fakeTime(), random: () => 0.5 });
    await expect(batch([q(1)])).rejects.toBeInstanceOf(NearRpcUnavailable);
  });

  it("skips a batch provider whose Retry-After does not fit the budget", async () => {
    const time = fakeTime();
    const batch = nearRpcBatch({ batchProviders: [A], providers: [S], fetch: fakeFetch({ [A]: [{ status: 429, body: {}, headers: { "retry-after": "60" } }], [S]: [echo] }), ...time, random: () => 0.5 });
    expect(await batch([q(1)])).toEqual([okFor(1)]);
    expect(time.waits).toEqual([]);
  });

  it("never sleeps past the time budget, batch and single calls together", async () => {
    const time = fakeTime();
    const batch = nearRpcBatch({
      batchProviders: [A],
      providers: [S],
      // 900 ms of the 1000 ms budget go on the batch provider: the single calls may not wait the 125 ms they would want
      fetch: fakeFetch({ [A]: [{ status: 429, body: {}, headers: { "retry-after": "0.9" } }, 429], [S]: [429, 429, 429] }),
      ...time,
      random: () => 0,
      budgetMs: 1000,
    });
    await expect(batch([q(1)])).rejects.toBeInstanceOf(NearRpcUnavailable);
    expect(time.waits).toEqual([900]);
    expect(time.now()).toBeLessThanOrEqual(1000);
  });
});
