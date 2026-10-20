// The ZEC route page's data: the newest NEAR Intents ZEC withdrawals to Zcash, each checked for its payout with the
// checker's own search, a few at a time. Driven by five real zec.omft.near transactions (18 Oct 2026) and fake payouts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fastnearClient } from "./check.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./core/fastnear.js";
import type { PayoutHop, WithdrawHop } from "./core/trace.js";
import type { NearClient } from "./near-client.js";
import { fastnearZecSource, ZEC_ROUTE_DEFAULTS, zecRoute, type ZecRouteSource } from "./zec-route.js";

const records = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/zec-route/zec-omft-sample.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
const NEWEST_FIRST = [...records].sort((a, b) => ((b.timestampNs ?? 0n) > (a.timestampNs ?? 0n) ? 1 : -1)).map((t) => t.hash);
const NOW = 1_792_330_000_000_000_000n;
const T_SOLVER = "4sRsUgMYRPdpcUeksWPqbP7BXxc592eECpSrPgQAvVKm";
const T_UNIFIED = "7WzMgqHdumrPtdrKAPRGwgc7AHXLk5AAN6bKXgCVu64g";
const T_TRANSPARENT = "6cBY53NcHDaXzKq9pvsVDPQzMbXEjmrHc1uUD1EjdR8X";

function source(recent: [string, number][] = []): ZecRouteSource {
  return {
    recentTxs: async (account, limit) => {
      recent.push([account, limit]);
      return NEWEST_FIRST;
    },
    transactions: async (hashes) => records.filter((t) => hashes.includes(t.hash)),
  };
}
const arrived = (w: WithdrawHop, delaySec: number): PayoutHop => ({ chain: w.chain, bridge: w.bridge, destination: w.destination, status: "arrived", how: "confirmed", tx: `Z-${w.tx}`, amount: w.amount, delaySec, confirmed: true });

describe("zecRoute", () => {
  it("reads the ZEC token's newest transactions, then checks each withdrawal to Zcash, newest first", async () => {
    const recent: [string, number][] = [];
    const r = await zecRoute(source(recent), async (w) => arrived(w, 600), NOW, { scan: 40 });
    expect(recent).toEqual([["zec.omft.near", 40]]);
    expect(r.scanned).toBe(5);
    expect(r.rows.map((x) => x.withdrawal.tx)).toEqual([T_SOLVER, T_UNIFIED, T_TRANSPARENT]);
    expect(r.summary).toMatchObject({ checked: 3, arrived: 3, medianDelaySec: 600 });
    expect(r.checkedAtNs).toBe(NOW);
  });

  it("asks for at most 20 transactions per call", async () => {
    const sizes: number[] = [];
    const many = Array.from({ length: 45 }, (_, i) => `h${i}`);
    await zecRoute({ recentTxs: async () => many, transactions: async (h) => (sizes.push(h.length), []) }, async () => Promise.reject(new Error("no withdrawal expected")), NOW);
    expect(sizes).toEqual([20, 20, 5]);
  });

  it("checks at most `withdrawals`, the newest", async () => {
    const r = await zecRoute(source(), async (w) => arrived(w, 1), NOW, { withdrawals: 2 });
    expect(r.rows.map((x) => x.withdrawal.tx)).toEqual([T_SOLVER, T_UNIFIED]);
  });

  it("runs at most `concurrency` payout checks at once, and reports the rows as they finish", async () => {
    let running = 0;
    let most = 0;
    const seen: number[] = [];
    const slow = async (w: WithdrawHop): Promise<PayoutHop> => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return arrived(w, 1);
    };
    const r = await zecRoute(source(), slow, NOW, { concurrency: 2, onRow: (rows) => seen.push(rows.length) });
    expect(most).toBe(2);
    expect(seen).toEqual([1, 2, 3]);
    expect(r.rows.map((x) => x.withdrawal.tx)).toEqual([T_SOLVER, T_UNIFIED, T_TRANSPARENT]);
  });

  it("a payout check that fails makes that row unverified, not the page", async () => {
    const r = await zecRoute(source(), async (w) => (w.tx === T_UNIFIED ? Promise.reject(new Error("Blockchair is down")) : arrived(w, 60)), NOW);
    expect(r.rows.find((x) => x.withdrawal.tx === T_UNIFIED)?.payout).toMatchObject({ status: "unverified", reason: "the payout check failed: Blockchair is down" });
    expect(r.summary).toMatchObject({ checked: 3, arrived: 2, unverified: 1 });
  });
});

describe("ZEC_ROUTE_DEFAULTS", () => {
  it("checks the newest 10, two at a time: each payout costs about two calls to the Zcash source's free tier", () => {
    expect(ZEC_ROUTE_DEFAULTS).toEqual({ scan: 120, withdrawals: 10, concurrency: 2 });
  });
});

describe("fastnearZecSource", () => {
  it("takes the hashes from the client's newest-first history and the transactions from the client", async () => {
    const client = {
      recentTxs: async (account: string, limit: number) => [{ hash: `${account}:${limit}`, height: 1, timestampNs: 1n }],
      transactions: async (hashes: string[]) => records.filter((t) => hashes.includes(t.hash)),
    } as unknown as NearClient;
    const s = fastnearZecSource(client);
    expect(await s.recentTxs("zec.omft.near", 7)).toEqual(["zec.omft.near:7"]);
    expect((await s.transactions([T_UNIFIED])).map((t) => t.hash)).toEqual([T_UNIFIED]);
  });

  it("says so when the client cannot list an account's newest transactions", async () => {
    const s = fastnearZecSource({ transactions: async () => [] } as unknown as NearClient);
    await expect(s.recentTxs("zec.omft.near", 1)).rejects.toThrow("this NEAR client cannot list an account's newest transactions");
  });
});

describe("fastnearClient.recentTxs", () => {
  it("asks for the account's newest transactions, newest first, at most 200", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const account_txs = [
        { account_id: "zec.omft.near", transaction_hash: "A", tx_block_height: 2, tx_block_timestamp: "20", is_success: true },
        { account_id: "zec.omft.near", transaction_hash: "B", tx_block_height: 1, tx_block_timestamp: "10", is_success: true },
      ];
      return new Response(JSON.stringify({ account_txs }), { status: 200 });
    }) as typeof fetch;
    const got = await fastnearClient(fetchImpl, undefined, async () => undefined).recentTxs?.("zec.omft.near", 300);
    expect(bodies).toEqual([{ account_id: "zec.omft.near", desc: true, limit: 200 }]);
    expect(got).toEqual([
      { hash: "A", height: 2, timestampNs: 20n },
      { hash: "B", height: 1, timestampNs: 10n },
    ]);
  });
});
