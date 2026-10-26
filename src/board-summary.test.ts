import { describe, expect, it } from "vitest";

import { boardSummary } from "./board-summary.js";
import type { BoardRow } from "./core/btc-refund.js";

const NOW = 1_792_000_000;
const row = (over: Partial<BoardRow>): BoardRow => ({ chain: "btc", txid: "aa", vout: 0, amountSat: 10_000_000, refundTo: "bc1q", requestedAtSec: NOW - 3_600, unlocksAtSec: NOW + 169_200, state: "locked", readyForSec: 0, ...over });

describe("boardSummary: the open refund requests, as the home page's card shows them", () => {
  it("counts each state and each coin, and names the longest-waiting ready refund", () => {
    const s = boardSummary([row({ state: "ready", readyForSec: 7_200, amountSat: 48_000_000 }), row({ chain: "zcash" }), row({ state: "executed" })], NOW);
    expect(s).toMatchObject({ open: 3, ready: 1, locked: 1, executed: 1, byChain: { btc: 2, zcash: 1 } });
    expect(s.firstReady).toMatchObject({ amountSat: 48_000_000, readyForSec: 7_200 });
  });

  it("gives the next unlock among ordinary locks, and counts the bridge's 100-year locks apart", () => {
    const s = boardSummary([row({ unlocksAtSec: NOW + 90_000 }), row({ unlocksAtSec: NOW + 40_000 }), row({ requestedAtSec: NOW - 100, unlocksAtSec: NOW + 3_153_600_000 })], NOW);
    expect(s.nextUnlockInSec).toBe(40_000);
    expect(s.longLocked).toBe(1);
    expect(s.locked).toBe(3);
  });

  it("is all zeros for an empty board", () => {
    expect(boardSummary([], NOW)).toEqual({ open: 0, ready: 0, locked: 0, executed: 0, longLocked: 0, byChain: { btc: 0, zcash: 0 }, firstReady: null, nextUnlockInSec: null });
  });
});
