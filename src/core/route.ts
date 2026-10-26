// The route an order took, as the five stops the page draws and animates: where it began, the credit on NEAR, the
// swap, the withdrawal and the payout. Pure: built from the report alone, so the animation can only replay what the
// check proved.

import { chainName } from "./chains.js";
import { describeDuration, payingWithdrawal, payoutTransfer, type Flag, type OrderReport } from "./trace.js";

/** `stopped`: the first stop that never happened on an order that is stuck; `waiting`: the next stop of one still running. */
export type StopState = "done" | "unverified" | "private" | "stopped" | "waiting" | "not_reached";

export interface RouteStop {
  key: "origin" | "credit" | "swap" | "withdrawal" | "payout";
  title: string;
  place: string;
  state: StopState;
  atNs: bigint | null;
  /** The chain the stop is on, as the checker names chains ("eth", "near", "sol"); null where the report does not say. */
  chain: string | null;
  /** Why the route stopped here, in a few words ("Locked 187 days"). */
  reason?: string;
}

export interface Route {
  stops: RouteStop[];
  /** The chain the money came from and the one it was paid out on; null where the report does not say. */
  from: string | null;
  to: string | null;
  refunded: boolean;
  stopIndex: number | null;
  /** Seconds between each stop and the next, where both times are known. */
  segmentsSec: (number | null)[];
  totalSec: number | null;
}

type Raw = "done" | "unverified" | "private" | "missing" | "failed" | "waiting";

const REASON: Partial<Record<Flag["kind"], string>> = {
  locked: "Locked",
  stalled: "Stalled",
  payout_not_found: "Payout not found",
  payout_bounced: "Payout bounced",
  withdrawal_returned: "Withdrawal returned",
  withdrawal_refused: "Withdrawal refused",
  destination_missing: "No such account",
  executing: "Still executing",
};

function reasonOf(flags: Flag[]): string | undefined {
  for (const f of flags) {
    const label = REASON[f.kind];
    if (label) return "waitedSec" in f ? `${label} ${describeDuration(f.waitedSec)}` : label;
  }
  return undefined;
}

export function routeOf(r: OrderReport): Route {
  const refunded = r.verdict === "refunded";
  const o = r.origin;
  const viaTransfer = payoutTransfer(r);
  const paying = payingWithdrawal(r);
  const lastW = r.withdrawals.at(-1);
  const p = r.payout;

  const origin: Raw = o.status === "proven" ? "done" : o.status === "unverified" ? "unverified" : "missing";
  const credit: Raw = r.deposits.length ? "done" : "missing";
  const swap: Raw = r.verdict === "confidential" ? "private" : r.swaps.length || viaTransfer || (refunded && r.withdrawals.length) ? "done" : "missing";
  const withdrawal: Raw = viaTransfer ? "done" : paying ? "done" : lastW ? "failed" : "missing";
  const payout: Raw =
    p.status === "arrived" ? "done" : p.status === "ambiguous" || p.status === "unverified" ? "unverified" : p.status === "waiting" ? "waiting" : p.status === "not_found" ? "failed" : "missing";

  const swapAt = r.swaps[0]?.timestampNs ?? (refunded ? (r.withdrawals[0]?.timestampNs ?? null) : null);
  const withdrawAt = viaTransfer ? viaTransfer.transfer.timestampNs : (paying ?? lastW)?.timestampNs ?? null;
  const payoutAt = viaTransfer
    ? viaTransfer.transfer.timestampNs
    : p.status === "arrived" && p.delaySec !== null && withdrawAt !== null
      ? withdrawAt + BigInt(p.delaySec) * 1_000_000_000n
      : null;

  const key = (c: string | null | undefined): string | null => (c ? (c.split(":")[0] ?? c) : null);
  const draft: { stop: Omit<RouteStop, "state">; raw: Raw }[] = [
    { raw: origin, stop: { key: "origin", title: "Deposit", place: o.status === "proven" ? chainName(o.chain) : "Your chain", atNs: null, chain: o.status === "proven" ? key(o.chain) : null } },
    { raw: credit, stop: { key: "credit", title: "Credit", place: "NEAR Intents", atNs: r.deposits[0]?.timestampNs ?? null, chain: "near" } },
    { raw: swap, stop: { key: "swap", title: refunded ? "Refund" : r.verdict === "confidential" ? "Private leg" : "Swap", place: "NEAR Intents", atNs: swapAt, chain: "near" } },
    { raw: withdrawal, stop: { key: "withdrawal", title: refunded ? "Sent back" : "Withdrawal", place: viaTransfer ? "inside NEAR Intents" : lastW?.chain ? `to ${chainName(lastW.chain)}` : "NEAR Intents", atNs: withdrawAt, chain: "near" } },
    { raw: payout, stop: { key: "payout", title: refunded ? "Returned" : "Payout", place: "chain" in p && p.chain ? chainName(p.chain) : "Destination", atNs: payoutAt, chain: "chain" in p ? key(p.chain) : null } },
  ];

  const passes = (raw: Raw): boolean => raw === "done" || raw === "unverified" || raw === "private";
  const firstGap = draft.findIndex((d) => !passes(d.raw));
  const stopIndex = firstGap === -1 ? null : firstGap;
  const running = r.verdict === "in_progress" || r.verdict === "confidential";

  const stops: RouteStop[] = draft.map((d, i) => {
    if (stopIndex === null || i < stopIndex) return { ...d.stop, state: d.raw === "done" ? "done" : (d.raw as "unverified" | "private") };
    if (i > stopIndex) return { ...d.stop, state: "not_reached" };
    if (d.raw === "waiting" || (running && d.raw !== "failed")) return { ...d.stop, state: "waiting" };
    const reason = reasonOf(r.flags);
    return { ...d.stop, state: "stopped", ...(reason ? { reason } : {}) };
  });

  const segmentsSec = stops.slice(1).map((s, i) => {
    const a = stops[i]?.atNs;
    const b = s.atNs;
    return a != null && b != null && b >= a ? Number((b - a) / 1_000_000_000n) : null;
  });
  const times = stops.filter((s) => s.state === "done" && s.atNs != null).map((s) => s.atNs as bigint);
  const first = times[0];
  const last = times.at(-1);
  const totalSec = times.length >= 2 && first !== undefined && last !== undefined ? Number((last - first) / 1_000_000_000n) : null;

  const payoutChain = "chain" in p && p.chain ? chainName(p.chain) : null;
  return {
    stops,
    from: o.status === "proven" ? chainName(o.chain) : null,
    to: stops[4]?.state === "done" || stops[4]?.state === "unverified" || stops[4]?.state === "waiting" ? payoutChain : null,
    refunded,
    stopIndex,
    segmentsSec,
    totalSec,
  };
}
