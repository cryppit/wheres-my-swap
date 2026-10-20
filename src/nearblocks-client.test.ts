// The NearBlocks client against the answers recorded on 2026-10-14 (src/fixtures/nearblocks/, keyless, "Powered by
// Nearblocks.io APIs"): the history of two real orders, pacing at the free tier's 6 calls a minute on an injected
// clock, Retry-After on 429, the page cap, and the NearClient the checker can fall back to.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { TxRecord } from "./core/decode.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./core/fastnear.js";
import { NEARBLOCKS_ATTRIBUTION, parseNearBlocksJson, type NbEnvelope, type NbMtTxn } from "./core/nearblocks.js";
import { traceOrder } from "./core/trace.js";
import { NEARBLOCKS_API, nearBlocksClient, nearBlocksHistory, nearBlocksNearClient, type NearBlocksClient } from "./nearblocks-client.js";

const ACCOUNT_358 = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
const ACCOUNT_6 = "26b9cc669c90eae37285e4c52c35e0fc814314b2a6566250329a8ad497acb5fb";
const SWAP_TX = "E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB";
const DEPOSIT_TX = "8a33DkKfZMWRKbK2pXuQAWVLXSy4AyZF6PfcENvCJgCb";
const MINT_RECEIPT = "9sEgpLCva7GVAiEJci9PcfVfkVRKkhhwrwvCpLVsqYVu";
const UNKNOWN = "11111111111111111111111111111111";
const LIST_358 = `/v3/accounts/${ACCOUNT_358}/mt-txns?limit=25`;
const NOW = 1_792_000_000_000_000_000n; // 2026-10-14

interface Recorded {
  responses: Record<string, unknown>;
}
const recorded = (name: string): Recorded => parseNearBlocksJson<Recorded>(readFileSync(new URL(`./fixtures/nearblocks/${name}`, import.meta.url), "utf8"));
const ANSWERS: Record<string, unknown> = { ...recorded("order-358.json").responses, ...recorded("order-6.json").responses, ...recorded("failed-receipt.json").responses };
const ITEMS_358 = (ANSWERS[LIST_358] as NbEnvelope<NbMtTxn[]>).data ?? [];

const fastnear = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-txs-358.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
const fast = (hash: string): TxRecord | undefined => fastnear.find((t) => t.hash === hash);

/** A clock that moves only when the client sleeps. */
function fakeTime() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

interface Call {
  at: number;
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/** Serves the recorded answers by path (a path never recorded is a 404); `special` may answer first. */
function recordedFetch(calls: Call[], now: () => number, special?: (path: string, n: number) => Response | undefined): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    calls.push({ at: now(), url: url.origin, path, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const answer = special?.(path, calls.length);
    if (answer) return answer;
    const body = ANSWERS[path];
    return body === undefined ? json({ data: null, errors: [{ message: "not recorded", path }] }, 404) : json(body);
  }) as typeof fetch;
}

function setup(special?: (path: string, n: number) => Response | undefined, apiKey?: string): { client: NearBlocksClient; calls: Call[]; time: ReturnType<typeof fakeTime> } {
  const time = fakeTime();
  const calls: Call[] = [];
  const client = nearBlocksClient({ fetch: recordedFetch(calls, time.now, special), now: time.now, sleep: time.sleep, ...(apiKey ? { apiKey } : {}) });
  return { client, calls, time };
}

describe("nearBlocksHistory", () => {
  it("reads #358 in three calls (its transfer list, then each transaction's receipts) into FastNEAR's records and trace", async () => {
    const { client, calls, time } = setup();
    const h = await nearBlocksHistory(ACCOUNT_358, client);
    expect(calls.map((c) => c.path)).toEqual([LIST_358, `/v3/txns/${DEPOSIT_TX}/receipts`, `/v3/txns/${SWAP_TX}/receipts`]);
    expect(calls.every((c) => c.url === NEARBLOCKS_API && c.method === "GET" && c.headers["authorization"] === undefined)).toBe(true);
    expect(time.slept).toEqual([]);
    expect(h.calls).toBe(3);
    expect(h.attribution).toBe(NEARBLOCKS_ATTRIBUTION);
    expect(h.history).toEqual([
      { hash: DEPOSIT_TX, height: 215243812, timestampNs: 1789144024048223792n },
      { hash: SWAP_TX, height: 217478802, timestampNs: 1790507776780473251n },
    ]);
    expect(h.txs).toEqual([fast(DEPOSIT_TX), fast(SWAP_TX)]);
    const report = traceOrder({ account: ACCOUNT_358, txs: h.txs, nowNs: NOW });
    expect(report).toEqual(traceOrder({ account: ACCOUNT_358, txs: fastnear, nowNs: NOW }));
    expect(report.verdict).toBe("settled");
  });

  it("reads #6 in two calls: stuck, 48.28 ETH still in the order account", async () => {
    const { client, calls } = setup();
    const h = await nearBlocksHistory(ACCOUNT_6, client);
    expect(calls).toHaveLength(2);
    const report = traceOrder({ account: ACCOUNT_6, txs: h.txs, nowNs: NOW });
    expect(report.verdict).toBe("stuck");
    expect(report.balances).toEqual({ "nep141:eth.omft.near": "48280000000000000000" });
  });

  it("refuses to trace part of an order: a listed transaction NearBlocks has no receipts for yet stops it", async () => {
    const { client } = setup((path) => (path === `/v3/txns/${SWAP_TX}/receipts` ? json({ data: null }) : undefined));
    await expect(nearBlocksHistory(ACCOUNT_358, client)).rejects.toThrow(`NearBlocks lists ${SWAP_TX} for ${ACCOUNT_358} but has no receipts for it yet`);
  });

  it("gives an account with no NEP-245 transfers an empty history: this source sees only transactions that moved its tokens", async () => {
    const { client, calls } = setup((path) => (path === `/v3/accounts/${UNKNOWN}/mt-txns?limit=25` ? json({ data: [] }) : undefined));
    expect(await nearBlocksHistory(UNKNOWN, client)).toMatchObject({ history: [], txs: [], calls: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe("nearBlocksClient: the free tier's limits", () => {
  it("never sends more than 6 calls in any minute, waiting on the injected clock", async () => {
    const { client, calls } = setup();
    for (let i = 0; i < 3; i++) await nearBlocksHistory(ACCOUNT_358, client);
    expect(calls).toHaveLength(9);
    expect(client.calls).toBe(9);
    expect(calls.slice(0, 6).map((c) => c.at)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(calls[6]?.at).toBe(60_000);
    for (let i = 0; i + 6 < calls.length; i++) expect((calls[i + 6]?.at ?? 0) - (calls[i]?.at ?? 0)).toBeGreaterThanOrEqual(60_000);
  });

  it("waits out a 429 for its Retry-After, then sends the same request again", async () => {
    const { client, calls, time } = setup((_path, n) => (n === 1 ? new Response("Too Many Requests", { status: 429, headers: { "retry-after": "7" } }) : undefined));
    const h = await nearBlocksHistory(ACCOUNT_6, client);
    expect(h.txs).toHaveLength(1);
    expect(time.slept).toEqual([7_000]);
    expect(calls.map((c) => c.path).slice(0, 2)).toEqual([`/v3/accounts/${ACCOUNT_6}/mt-txns?limit=25`, `/v3/accounts/${ACCOUNT_6}/mt-txns?limit=25`]);
  });

  it("without a Retry-After backs off 10, 30 and 60 s, then reports the rate limit", async () => {
    const { client, calls, time } = setup(() => new Response("Too Many Requests", { status: 429 }));
    await expect(nearBlocksHistory(ACCOUNT_6, client)).rejects.toThrow(/^NearBlocks \/v3\/accounts\/[0-9a-f]{64}\/mt-txns\?limit=25: HTTP 429 \(rate limited; the free tier allows 6 calls a minute and 333 a day\)$/);
    expect(time.slept).toEqual([10_000, 30_000, 60_000]);
    expect(calls).toHaveLength(4);
  });

  it("reports a Retry-After longer than a minute at once (the day's or month's calls are spent)", async () => {
    const { client, calls, time } = setup(() => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "3600" } }));
    await expect(nearBlocksHistory(ACCOUNT_6, client)).rejects.toThrow("HTTP 429 (rate limited, retry after 3600 s; the free tier allows 6 calls a minute and 333 a day)");
    expect([calls.length, time.slept]).toEqual([1, []]);
  });

  it("reports a server error at once, without retrying: the checker then has neither source", async () => {
    const { client, calls } = setup(() => new Response("Bad Gateway", { status: 502 }));
    await expect(nearBlocksHistory(ACCOUNT_6, client)).rejects.toThrow(`NearBlocks /v3/accounts/${ACCOUNT_6}/mt-txns?limit=25: HTTP 502`);
    expect(calls).toHaveLength(1);
  });

  it("names an unreachable NearBlocks as such", async () => {
    const client = nearBlocksClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      now: () => 0,
      sleep: async () => {},
    });
    await expect(nearBlocksHistory(ACCOUNT_6, client)).rejects.toThrow(`NearBlocks /v3/accounts/${ACCOUNT_6}/mt-txns?limit=25: unreachable (fetch failed)`);
  });

  it("reports an answer's own errors", async () => {
    const { client } = setup(() => json({ data: null, errors: [{ message: "Invalid account", path: "account" }] }));
    await expect(nearBlocksHistory(ACCOUNT_6, client)).rejects.toThrow("Invalid account");
  });

  it("sends no key on the free tier, and a paid plan's key as a bearer token", async () => {
    const { client, calls } = setup(undefined, "paid-key");
    await nearBlocksHistory(ACCOUNT_6, client);
    expect(calls.map((c) => c.headers["authorization"])).toEqual(["Bearer paid-key", "Bearer paid-key"]);
  });
});

describe("nearBlocksClient: pages", () => {
  // The recorded #358 listing, served as two pages to show the cursor walk (the real answer had one page).
  const paged = (path: string): Response | undefined => {
    if (path === LIST_358) return json({ data: ITEMS_358.slice(0, 3), meta: { next_page: "eyJ0IjoxfQ==" } });
    if (path === `${LIST_358}&next=eyJ0IjoxfQ%3D%3D`) return json({ data: ITEMS_358.slice(3) });
    return undefined;
  };

  it("follows next_page cursors, passing each back as it came", async () => {
    const { client, calls } = setup(paged);
    const h = await nearBlocksHistory(ACCOUNT_358, client);
    expect(calls.map((c) => c.path).slice(0, 2)).toEqual([LIST_358, `${LIST_358}&next=eyJ0IjoxfQ%3D%3D`]);
    expect(h.txs).toEqual([fast(DEPOSIT_TX), fast(SWAP_TX)]);
  });

  it("stops at the page cap and refuses the history, as a wallet account and not one swap", async () => {
    const { client, calls } = setup(() => json({ data: ITEMS_358, meta: { next_page: "more" } }));
    await expect(nearBlocksHistory(ACCOUNT_358, client, { maxPages: 2 })).rejects.toThrow(`${ACCOUNT_358} has more than 50 token transfers: that is a wallet account, not one swap`);
    expect(calls).toHaveLength(2);
  });

  it("refuses an order with more transactions than it reads at 6 calls a minute, before reading any", async () => {
    const { client, calls } = setup();
    await expect(nearBlocksHistory(ACCOUNT_358, client, { maxTxs: 1 })).rejects.toThrow(`${ACCOUNT_358} has 2 transactions: more than the backup source reads while FastNEAR is unavailable`);
    expect(calls).toHaveLength(1);
  });
});

describe("nearBlocksNearClient: the checker's NearClient on NearBlocks", () => {
  it("reads a pasted transaction once: its receipts, its block from /v3/txns/{hash}; the history then reuses it", async () => {
    const { client, calls } = setup();
    const near = nearBlocksNearClient(client);
    expect(await near.transactions([DEPOSIT_TX])).toEqual([fast(DEPOSIT_TX)]);
    const history = await near.accountTxs(ACCOUNT_358);
    expect(await near.transactions(history.map((t) => t.hash))).toEqual([fast(DEPOSIT_TX), fast(SWAP_TX)]);
    expect(calls.map((c) => c.path)).toEqual([`/v3/txns/${DEPOSIT_TX}/receipts`, `/v3/txns/${DEPOSIT_TX}`, LIST_358, `/v3/txns/${SWAP_TX}/receipts`]);
  });

  it("finds the transaction of a pasted receipt id through the receipt search", async () => {
    const { client, calls } = setup();
    expect(await nearBlocksNearClient(client).receiptTx?.(MINT_RECEIPT)).toEqual(fast(DEPOSIT_TX));
    expect(calls.map((c) => c.path)).toEqual([`/v3/search/receipts?keyword=${MINT_RECEIPT}`, `/v3/txns/${DEPOSIT_TX}/receipts`, `/v3/txns/${DEPOSIT_TX}`]);
  });

  it("leaves out a hash NearBlocks does not know, as FastNEAR does (recorded answer: {\"data\":null})", async () => {
    const { client, calls } = setup();
    expect(await nearBlocksNearClient(client).transactions([UNKNOWN])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("keeps a pasted transaction that names the account when the transfer list does not have it yet", async () => {
    // NearBlocks indexes transfers a few seconds after transactions (6.1 s against 3.7 s, measured): a transaction
    // pasted right after it ran can be readable before the account's listing shows it.
    const { client } = setup((path) => (path === LIST_358 ? json({ data: [] }) : undefined));
    const near = nearBlocksNearClient(client);
    await near.transactions([DEPOSIT_TX]);
    expect(await near.accountTxs(ACCOUNT_358)).toEqual([{ hash: DEPOSIT_TX, height: 215243812, timestampNs: 1789144024048223792n }]);
    expect(await nearBlocksNearClient(client).accountTxs(ACCOUNT_358)).toEqual([]);
  });
});
