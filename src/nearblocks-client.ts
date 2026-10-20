// NearBlocks API v3 (https://api.nearblocks.io) as the checker's second source of order history, independent of
// FastNEAR (another team, its own indexer; Neardata and Stream NEAR are FastNEAR's and fail with it). The I/O half:
// keyless GETs paced to the free tier, Retry-After on 429, a page cap; core/nearblocks.ts maps the answers to the
// records the trace reads, the same ones decodeFastnearTx makes (pinned on two real orders in nearblocks.test.ts).
//
// How check.ts should use it (the wiring belongs to check.ts):
// - FastNEAR stays the primary. Fall back to NearBlocks only when FastNEAR is unavailable: HTTP 429 after
//   fastnearClient's own retries, HTTP 5xx, or fetch throwing (unreachable); today those surface as an Error
//   "FastNEAR <path>: HTTP <status>" and a TypeError from fetch. (A 401 or 403, should FastNEAR start requiring its
//   key, is unavailability too.) Never on an empty history, an unknown hash or another 4xx: those are answers, and
//   NearBlocks would only answer slower and see less.
// - Keep one `nearBlocks = nearBlocksClient()` per process (the web page, the CLI, the recorder): the pacing lives in
//   it, and the free tier's limit is per IP. On a FastNEAR outage, run the same check again with
//   `checkOrder(input, nearBlocksNearClient(nearBlocks), nowNs, params, payouts)`: a new nearBlocksNearClient per check
//   (it remembers that check's blocks and transactions). It reads the order account, a NEAR transaction or a receipt
//   id; origin-chain hashes need FastNEAR's block-range search (accountTxsBetween, blockTime, latestTx), which it does
//   not offer. To replace only the history step, `nearBlocksHistory(account, nearBlocks)` gives the history and its
//   decoded transactions in one call.
// - Mark the report as read from NearBlocks and print NEARBLOCKS_ATTRIBUTION (core/nearblocks.ts) with a link to
//   https://nearblocks.io: the free tier requires the credit for anything but personal use. An empty history from
//   NearBlocks means no credited deposit yet, not "no order": say "this backup source sees only credited deposits;
//   paste your deposit transaction".
//
// The terms (nearblocks.io/apis, api.nearblocks.io/openapi.json, nearblocks.io/terms, read 2026-10-14): the keyless
// free tier allows 6 calls a minute, 333 a day and 10,000 a month, is labelled "Personal Use" and requires
// attribution; the API docs ask any other use for the credit; the site's general terms want "prior written consent"
// for third-party applications that interact with the services (§5) and "full and clear credit" for excerpts (§7).
// Nothing on caching: we keep nothing, every check reads afresh. Startup ($67.15 a month) allows 190 a minute and
// "Commercial Use". Before the public site leans on the free tier, ask NearBlocks or buy Startup.
//
// The budget: each 25 items asked for count as one call, so pages are asked 25 at a time. A check costs one call per
// 25 transfers in the account's listing plus one per transaction; a pasted transaction hash costs one more (its
// block), a pasted receipt id two more (the search and the block). #6 takes 2 calls, #358 takes 3; a typical order of
// 2 to 4 transactions takes 3 to 5, which go out at once when the minute's 6 are free; behind other checks they wait
// for the minute to roll over (at most 60 s; 20 to 40 s when calls go out evenly, one per 10 s). A big order is slow:
// 20 transactions take 21 calls, over 3 minutes, so a history over `maxTxs` (20) is refused, as is a listing over
// `maxPages` (4 pages, 100 transfers: a wallet account, not one swap). 333 calls a day is about 100 order checks,
// shared by everyone behind the same IP.

import type { TxRecord } from "./core/decode.js";
import { NEARBLOCKS_ATTRIBUTION, decodeNearBlocksTx, mtTxnsHistory, parseNearBlocksJson, type NbBlock, type NbEnvelope, type NbMtTxn, type NbReceipt, type NbReceiptHit, type NbTxn } from "./core/nearblocks.js";
import type { AccountTx, NearClient } from "./near-client.js";

export const NEARBLOCKS_API = "https://api.nearblocks.io";
/** The keyless free tier: 6 calls a minute (and 333 a day, 10,000 a month). */
export const NEARBLOCKS_FREE_PER_MINUTE = 6;

/** Each 25 items asked for count as one call: a page of 25 is one call. */
const PAGE = 25;
const MAX_PAGES = 4;
const MAX_TXS = 20;
const MINUTE_MS = 60_000;
/** Waits before retrying a 429 that gives no Retry-After; after the last one the 429 is reported. */
const RATE_LIMIT_WAITS_MS = [10_000, 30_000, 60_000];
/** A Retry-After longer than this means the day's or month's calls are spent: reported at once, not waited out. */
const MAX_RETRY_AFTER_MS = MINUTE_MS;
const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface NearBlocksOptions {
  fetch?: typeof fetch;
  base?: string;
  /** Milliseconds now and a way to wait, for the pacing; injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Calls allowed in any rolling minute (free tier: 6; Startup: 190). */
  perMinute?: number;
  /** A paid plan's API key, sent as a bearer token. The free tier needs none; never put a key in the browser bundle. */
  apiKey?: string;
}

/** One call each, read-only GETs. */
export interface NearBlocksClient {
  /** A page of the account's NEP-245 transfers (newest first) and the cursor of the next page, null on the last. */
  mtTxns(account: string, next?: string): Promise<{ items: NbMtTxn[]; next: string | null }>;
  /** The transaction's receipt tree; null when NearBlocks does not know the hash. */
  receipts(hash: string): Promise<NbReceipt | null>;
  /** The transaction at its own block; null when NearBlocks does not know the hash. */
  txn(hash: string): Promise<NbTxn | null>;
  /** The transaction a receipt belongs to; null when NearBlocks does not know the receipt. */
  receiptTxHash(receiptId: string): Promise<string | null>;
  /** Calls sent so far, each counted against the free tier's limits. */
  readonly calls: number;
}

/** Seconds, or an HTTP date, until the server takes calls again; null when it does not say. */
function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

const one = <T>(data: T | T[] | null): T | null => (Array.isArray(data) ? (data[0] ?? null) : data);

export function nearBlocksClient(opts: NearBlocksOptions = {}): NearBlocksClient {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? NEARBLOCKS_API;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? sleepFor;
  const perMinute = opts.perMinute ?? NEARBLOCKS_FREE_PER_MINUTE;
  const headers: Record<string, string> = { accept: "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) };
  /** When each call of the last minute went out. */
  const sent: number[] = [];
  let calls = 0;

  /** Waits until a call fits in the rolling minute, then takes its place. */
  async function pace(): Promise<void> {
    for (;;) {
      const t = now();
      while (sent.length > 0 && t - (sent[0] ?? t) >= MINUTE_MS) sent.shift();
      const oldest = sent[0];
      if (sent.length < perMinute || oldest === undefined) {
        sent.push(t);
        calls++;
        return;
      }
      await sleep(MINUTE_MS - (t - oldest));
    }
  }

  async function get<T>(path: string): Promise<NbEnvelope<T>> {
    for (let attempt = 0; ; attempt++) {
      await pace();
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, { method: "GET", headers });
      } catch (e) {
        throw new Error(`NearBlocks ${path}: unreachable (${e instanceof Error ? e.message : String(e)})`, { cause: e });
      }
      if (res.status === 429) {
        const after = retryAfterMs(res.headers.get("retry-after"), now());
        const backoff = RATE_LIMIT_WAITS_MS[attempt];
        if (backoff === undefined || (after !== null && after > MAX_RETRY_AFTER_MS)) {
          throw new Error(`NearBlocks ${path}: HTTP 429 (rate limited${after !== null ? `, retry after ${Math.ceil(after / 1000)} s` : ""}; the free tier allows 6 calls a minute and 333 a day)`);
        }
        await sleep(after ?? backoff);
        continue;
      }
      if (!res.ok) throw new Error(`NearBlocks ${path}: HTTP ${res.status}`);
      const body = parseNearBlocksJson<NbEnvelope<T>>(await res.text());
      if (body.errors && body.errors.length > 0) throw new Error(`NearBlocks ${path}: ${body.errors.map((e) => e.message).join("; ")}`);
      return body;
    }
  }

  return {
    async mtTxns(account, next) {
      const r = await get<NbMtTxn[]>(`/v3/accounts/${encodeURIComponent(account)}/mt-txns?limit=${PAGE}${next ? `&next=${encodeURIComponent(next)}` : ""}`);
      return { items: r.data ?? [], next: r.meta?.next_page || null };
    },
    async receipts(hash) {
      return one((await get<NbReceipt | NbReceipt[]>(`/v3/txns/${encodeURIComponent(hash)}/receipts`)).data);
    },
    async txn(hash) {
      return one((await get<NbTxn | NbTxn[]>(`/v3/txns/${encodeURIComponent(hash)}`)).data);
    },
    async receiptTxHash(receiptId) {
      const hits = (await get<NbReceiptHit[]>(`/v3/search/receipts?keyword=${encodeURIComponent(receiptId)}`)).data ?? [];
      return hits.find((h) => h.receipt_id === receiptId)?.transaction_hash ?? null;
    },
    get calls() {
      return calls;
    },
  };
}

export interface NearBlocksLimits {
  /** Pages of 25 transfers read before the account is refused as a wallet account (default 4: 100 transfers). */
  maxPages?: number;
  /** Transactions read before the order is refused as too long for 6 calls a minute (default 20). */
  maxTxs?: number;
}

/** Does the record name the account anywhere the trace reads (calls, events, logs)? */
const names = (tx: TxRecord, account: string): boolean => JSON.stringify([tx.actions, tx.receiptActions, tx.events, tx.plainLogs]).includes(account);

/**
 * The checker's NearClient on NearBlocks, for one check. `accountTxs` is the account's mt-txns listing: the
 * transactions that moved its NEP-245 tokens inside intents.near, oldest first, at their own blocks (see
 * core/nearblocks.ts for what that listing cannot see), plus any transaction this check already read that names the
 * account (a pasted one NearBlocks has not listed yet). `transactions` reads one receipt tree per hash, and the
 * transaction's block too when the listing did not give it; a hash NearBlocks does not know is left out, as FastNEAR
 * leaves it out. `receiptTx` finds a receipt's transaction through NearBlocks' receipt search.
 */
export function nearBlocksNearClient(client: NearBlocksClient, limits: NearBlocksLimits = {}): NearClient {
  const maxPages = limits.maxPages ?? MAX_PAGES;
  const maxTxs = limits.maxTxs ?? MAX_TXS;
  const blocks = new Map<string, NbBlock>();
  const read = new Map<string, TxRecord>();

  async function decode(hash: string): Promise<TxRecord | null> {
    const known = read.get(hash);
    if (known) return known;
    const tree = await client.receipts(hash);
    if (!tree) return null;
    const at = blocks.get(hash) ?? (await client.txn(hash))?.block;
    if (!at) return null;
    const record = decodeNearBlocksTx(hash, tree, at);
    read.set(hash, record);
    return record;
  }

  return {
    async accountTxs(account) {
      const items: NbMtTxn[] = [];
      let next: string | null = null;
      for (let page = 0; ; page++) {
        if (page === maxPages) throw new Error(`${account} has more than ${maxPages * PAGE} token transfers: that is a wallet account, not one swap. Paste the swap's NEAR transaction or your deposit transaction instead.`);
        const r: { items: NbMtTxn[]; next: string | null } = await client.mtTxns(account, next ?? undefined);
        items.push(...r.items);
        next = r.next;
        if (!next) break;
      }
      const history = mtTxnsHistory(items);
      for (const t of history) blocks.set(t.hash, t.block);
      const listed = new Set(history.map((t) => t.hash));
      const out: AccountTx[] = history.map(({ hash, height, timestampNs }) => ({ hash, height, timestampNs }));
      for (const r of read.values()) {
        if (r.height !== null && r.timestampNs !== null && !listed.has(r.hash) && names(r, account)) out.push({ hash: r.hash, height: r.height, timestampNs: r.timestampNs });
      }
      if (out.length > maxTxs) throw new Error(`${account} has ${out.length} transactions: more than the backup source reads while FastNEAR is unavailable (NearBlocks, 6 calls a minute). Try again in a few minutes.`);
      return out.sort((a, b) => a.height - b.height);
    },
    async transactions(hashes) {
      const out: TxRecord[] = [];
      for (const hash of hashes) {
        const record = await decode(hash);
        if (record) out.push(record);
      }
      return out;
    },
    async receiptTx(receiptId) {
      const hash = await client.receiptTxHash(receiptId);
      return hash ? decode(hash) : null;
    },
  };
}

export interface NearBlocksHistory {
  account: string;
  /** The transactions that moved the account's NEP-245 tokens, oldest first, at their own blocks. */
  history: AccountTx[];
  /** Those transactions as the trace reads them (the records decodeFastnearTx makes), in the same order. */
  txs: TxRecord[];
  /** Calls the client sent while reading it: this history's cost, unless other checks share the client meanwhile. */
  calls: number;
  /** The credit the report must carry when it shows this history. */
  attribution: string;
}

/**
 * One order account's history from NearBlocks, decoded for traceOrder: one call per 25 transfers listed, then one per
 * transaction. A listed transaction whose receipts NearBlocks does not have yet stops it, rather than trace part of
 * the order.
 */
export async function nearBlocksHistory(account: string, client: NearBlocksClient, limits?: NearBlocksLimits): Promise<NearBlocksHistory> {
  const before = client.calls;
  const near = nearBlocksNearClient(client, limits);
  const history = await near.accountTxs(account);
  const txs = await near.transactions(history.map((t) => t.hash));
  const missing = history.filter((t) => !txs.some((r) => r.hash === t.hash)).map((t) => t.hash);
  if (missing.length > 0) throw new Error(`NearBlocks lists ${missing.join(", ")} for ${account} but has no receipts for ${missing.length === 1 ? "it" : "them"} yet; try again in a minute`);
  return { account, history, txs, calls: client.calls - before, attribution: NEARBLOCKS_ATTRIBUTION };
}
