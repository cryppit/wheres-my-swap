// The ZEC route page's pure part. NEAR Intents' ZEC token is zec.omft.near, carried since 2026 by the Omni Zcash bridge:
// a withdrawal to Zcash is a dip4 ft_withdraw of that token to omni.bridge.near whose recipient is `zcash:…`. Each one is
// read with the checker's own trace, so the page and the checker agree on what a withdrawal is.

import type { TxRecord } from "./decode.js";
import { isOrderId, traceOrder, type PayoutHop, type WithdrawHop } from "./trace.js";

export const ZEC_TOKEN = "zec.omft.near";

export interface ZecWithdrawal {
  /** The NEAR Intents account the ZEC left: a 1Click order account, a solver, or a user. */
  account: string;
  withdrawal: WithdrawHop;
}

export interface ZecRouteRow extends ZecWithdrawal {
  payout: PayoutHop;
}

export interface ZecRouteSummary {
  checked: number;
  arrived: number;
  waiting: number;
  notFound: number;
  unverified: number;
  /** Over the payouts that arrived with a known delay, from the withdrawal on NEAR to the payout on Zcash. */
  medianDelaySec: number | null;
  slowestDelaySec: number | null;
}

/** The withdrawals of ZEC from NEAR Intents to a Zcash address in these transactions, newest first. */
export function zecWithdrawals(txs: readonly TxRecord[], nowNs: bigint): ZecWithdrawal[] {
  const out: ZecWithdrawal[] = [];
  for (const tx of txs) {
    const accounts = new Set<string>();
    for (const e of tx.events) {
      if (e.failed || e.executor !== "intents.near" || e.standard !== "dip4" || e.event !== "ft_withdraw") continue;
      for (const d of e.data) {
        const account = d["account_id"];
        if (typeof account === "string" && d["token"] === ZEC_TOKEN) accounts.add(account);
      }
    }
    for (const account of accounts) {
      for (const withdrawal of traceOrder({ account, txs: [tx], nowNs }).withdrawals) {
        if (withdrawal.tx === tx.hash && withdrawal.chain === "zec") out.push({ account, withdrawal });
      }
    }
  }
  return out.sort((a, b) => newestFirst(a.withdrawal.timestampNs, b.withdrawal.timestampNs));
}

const newestFirst = (a: bigint | null, b: bigint | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a > b ? -1 : 1);

export type RouteStatus = "arrived" | "waiting" | "not_found" | "unverified";

/** Where a payout stands; an ambiguous or missing one cannot be confirmed, so it counts as unverified. */
export function routeStatus(p: PayoutHop): RouteStatus {
  if (p.status === "arrived" || p.status === "waiting" || p.status === "not_found") return p.status;
  return "unverified";
}

export function zecRouteSummary(rows: readonly ZecRouteRow[]): ZecRouteSummary {
  const count = (s: RouteStatus): number => rows.filter((r) => routeStatus(r.payout) === s).length;
  const delays = rows
    .flatMap((r) => (r.payout.status === "arrived" && r.payout.delaySec !== null ? [r.payout.delaySec] : []))
    .sort((a, b) => a - b);
  const mid = Math.floor(delays.length / 2);
  const median = delays.length === 0 ? null : delays.length % 2 === 1 ? (delays[mid] ?? null) : Math.round(((delays[mid - 1] ?? 0) + (delays[mid] ?? 0)) / 2);
  return {
    checked: rows.length,
    arrived: count("arrived"),
    waiting: count("waiting"),
    notFound: count("not_found"),
    unverified: count("unverified"),
    medianDelaySec: median,
    slowestDelaySec: delays.length === 0 ? null : (delays[delays.length - 1] ?? null),
  };
}

/** The kind of Zcash address in an Omni recipient (`zcash:t1…`). */
export function zecAddressKind(destination: string | null): string {
  const a = destination?.replace(/^zcash:/, "") ?? "";
  if (a.startsWith("t1")) return "transparent";
  if (a.startsWith("t3")) return "transparent (P2SH)";
  if (a.startsWith("tex1")) return "TEX";
  if (a.startsWith("u1")) return "unified";
  if (a.startsWith("zs1")) return "Sapling";
  return "unknown";
}

/** A raw ZEC amount (8 decimals) in ZEC, without trailing zeros. */
export function zecAmount(raw: string): string {
  if (!/^\d+$/.test(raw)) return raw;
  const padded = raw.padStart(9, "0");
  const whole = padded.slice(0, -8).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-8).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** A 1Click order account (the trace's order-id shapes), or a named NEAR account (a solver, an app or a user). */
export function accountKind(account: string): "order account" | "named account" {
  return isOrderId(account) ? "order account" : "named account";
}
