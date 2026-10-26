// The open refund requests on the Omni Bitcoin and Zcash connectors, summed up for the home page's card: how many sit in
// each state and on each coin, the ready one that has waited longest, and when the next ordinary lock opens.

import type { BoardRow, UtxoChain } from "./core/btc-refund.js";

/** A lock longer than this is the bridge's unsafe-refund lock (100 years since 2026-10-16), not a wait anyone sees end. */
const LONG_LOCK_SEC = 10 * 365 * 86_400;

export interface BoardSummary {
  open: number;
  ready: number;
  locked: number;
  executed: number;
  longLocked: number;
  byChain: Record<UtxoChain, number>;
  firstReady: BoardRow | null;
  nextUnlockInSec: number | null;
}

export function boardSummary(rows: BoardRow[], nowSec: number): BoardSummary {
  const byChain: Record<UtxoChain, number> = { btc: 0, zcash: 0 };
  for (const r of rows) byChain[r.chain] += 1;
  const locked = rows.filter((r) => r.state === "locked");
  const long = locked.filter((r) => r.unlocksAtSec - r.requestedAtSec > LONG_LOCK_SEC);
  const waits = locked.filter((r) => !long.includes(r)).map((r) => r.unlocksAtSec - nowSec).filter((s) => s > 0);
  const ready = rows.filter((r) => r.state === "ready").sort((a, b) => b.readyForSec - a.readyForSec);
  return {
    open: rows.length,
    ready: ready.length,
    locked: locked.length,
    executed: rows.filter((r) => r.state === "executed").length,
    longLocked: long.length,
    byChain,
    firstReady: ready[0] ?? null,
    nextUnlockInSec: waits.length ? Math.min(...waits) : null,
  };
}
