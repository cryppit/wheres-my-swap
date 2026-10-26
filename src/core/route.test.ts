import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./fastnear.js";
import { routeOf } from "./route.js";
import { traceOrder, type OrderReport, type WithdrawHop } from "./trace.js";

const S = 1_000_000_000n;
const T = 1_780_000_000n * S;
const credit = { status: "proven" as const, tx: "DEP", timestampNs: T, height: 1, token: "nep141:eth.omft.near", amount: "1000" };
const swap = { status: "proven" as const, tx: "SWP", timestampNs: T + 12n * S, height: 2, intentHash: null, gave: {}, got: {}, fees: {}, referral: null, counterparties: [] };
const withdrawal: WithdrawHop = { status: "proven", tx: "WDR", timestampNs: T + 20n * S, height: 3, intentHash: null, kind: "ft_withdraw", token: "nep141:sol.omft.near", amount: "900", chain: "sol", bridge: "poa", destination: "So1", externalId: null };
const origin = { status: "proven" as const, kind: "poa" as const, chain: "eth:1", txHash: "0xab", how: "named by the deposit" };

const report = (over: Partial<OrderReport>): OrderReport => ({
  account: "acc",
  verdict: "settled",
  oneClickStatus: "SUCCESS",
  origin,
  deposits: [credit],
  swaps: [swap],
  transfers: [],
  withdrawals: [withdrawal],
  payout: { status: "arrived", how: "confirmed", tx: "PAY", amount: "890", delaySec: 40, confirmed: true, chain: "sol", bridge: "poa", destination: "So1" },
  balances: {},
  flags: [],
  ...over,
});

const states = (r: OrderReport): string[] => routeOf(r).stops.map((s) => s.state);

describe("routeOf: the five stops of an order, as the route the page draws", () => {
  it("a settled order: every stop done, from the origin chain to the payout chain, with the time between stops", () => {
    const route = routeOf(report({}));
    expect(route.stops.map((s) => s.key)).toEqual(["origin", "credit", "swap", "withdrawal", "payout"]);
    expect(states(report({}))).toEqual(["done", "done", "done", "done", "done"]);
    expect(route.from).toBe("Ethereum");
    expect(route.to).toBe("Solana");
    expect(route.stops.map((s) => s.chain)).toEqual(["eth", "near", "near", "near", "sol"]);
    expect(route.stopIndex).toBeNull();
    // The origin has no NEAR timestamp; credit → swap 12 s, swap → withdrawal 8 s, withdrawal → payout 40 s.
    expect(route.segmentsSec).toEqual([null, 12, 8, 40]);
    expect(route.totalSec).toBe(60);
  });

  it("a stuck order stops at the first stop that never happened, with the flag's reason; later stops are not reached", () => {
    const r = report({ verdict: "stuck", oneClickStatus: "PROCESSING", swaps: [], withdrawals: [], payout: { status: "missing" }, flags: [{ kind: "stalled", waitedSec: 16_200_000, detail: "credited, no intent since" }] });
    expect(states(r)).toEqual(["done", "done", "stopped", "not_reached", "not_reached"]);
    const route = routeOf(r);
    expect(route.stopIndex).toBe(2);
    expect(route.stops[2]?.reason).toBe("Stalled 188 days");
    expect(route.to).toBeNull();
  });

  it("a locked account names the lock as the reason", () => {
    const r = report({ verdict: "stuck", swaps: [], withdrawals: [], payout: { status: "missing" }, flags: [{ kind: "locked", tx: "LCK", waitedSec: 16_156_800, detail: "locked by the operators" }] });
    expect(routeOf(r).stops[2]?.reason).toBe("Locked 187 days");
  });

  it("an order still running waits at its next stop instead of stopping", () => {
    const r = report({ verdict: "in_progress", oneClickStatus: "PROCESSING", payout: { status: "waiting", waitedSec: 30, chain: "sol", bridge: "poa", destination: "So1" } });
    expect(states(r)).toEqual(["done", "done", "done", "done", "waiting"]);
  });

  it("a payout no transfer fits stops at the payout", () => {
    const r = report({ verdict: "stuck", payout: { status: "not_found", waitedSec: 7_200, chain: "sol", bridge: "poa", destination: "So1" }, flags: [{ kind: "payout_not_found", waitedSec: 7_200, detail: "no transfer fits" }] });
    expect(states(r)).toEqual(["done", "done", "done", "done", "stopped"]);
    expect(routeOf(r).stops[4]?.reason).toBe("Payout not found 2 h");
  });

  it("a withdrawal that bounced stops at the withdrawal", () => {
    const bounced = { ...withdrawal, chain: "near", bridge: "near" as const, destination: "nobody.near", bounced: { reason: "transfer_failed" as const, error: "AccountDoesNotExist" } };
    const r = report({ verdict: "stuck", withdrawals: [bounced], payout: { status: "missing" }, flags: [{ kind: "payout_bounced", detail: "returned to intents.near" }] });
    expect(states(r)).toEqual(["done", "done", "done", "stopped", "not_reached"]);
    expect(routeOf(r).stops[3]?.reason).toBe("Payout bounced");
  });

  it("a refund is marked as one: the swap stop reads Refund and the money goes back to where it came from", () => {
    const r = report({ verdict: "refunded", oneClickStatus: "REFUNDED", swaps: [], withdrawals: [{ ...withdrawal, chain: "eth", token: "nep141:eth.omft.near" }], payout: { status: "arrived", how: "confirmed", tx: "BACK", amount: "990", delaySec: 30, confirmed: true, chain: "eth", bridge: "poa", destination: "0xme" }, flags: [{ kind: "refunded", detail: "the deposit left without a swap" }] });
    const route = routeOf(r);
    expect(route.refunded).toBe(true);
    expect(route.stops[2]?.title).toBe("Refund");
    expect(states(r)).toEqual(["done", "done", "done", "done", "done"]);
    expect(route.to).toBe("Ethereum");
  });

  it("an unverified origin or payout is drawn as unverified, not as done", () => {
    const r = report({ origin: { status: "unverified", kind: "unknown", how: "?" }, payout: { status: "unverified", chain: "movement", bridge: "omni", destination: "0x1" } });
    expect(states(r)).toEqual(["unverified", "done", "done", "done", "unverified"]);
    expect(routeOf(r).from).toBeNull();
  });

  it("a payout inside NEAR Intents needs no withdrawal", () => {
    const transfer = { tx: "TRF", timestampNs: T + 15n * S, height: 3, to: "me.near", toLabel: null, tokens: { "nep141:wrap.near": "5" } };
    const r = report({ withdrawals: [], transfers: [transfer], payout: { status: "arrived", how: "proven", tx: "TRF", amount: "5", delaySec: 0, confirmed: true, chain: "near", bridge: "near", destination: "me.near", via: "transfer" } });
    expect(states(r)).toEqual(["done", "done", "done", "done", "done"]);
    expect(routeOf(r).stops[3]?.place).toBe("inside NEAR Intents");
  });

  it("the real order of near/intents #358 (575,830 TRX, settled 16 days late) draws a complete route", () => {
    const account = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
    const records = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("../fixtures/fastnear-txs-358.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
    const route = routeOf(traceOrder({ account, txs: records, nowNs: 1_791_000_000_000_000_000n }));
    expect(route.stopIndex).toBeNull();
    // The credit → swap gap is the 16 days the order waited.
    expect(route.segmentsSec[1]).toBeGreaterThan(15 * 86_400);
  });
});
