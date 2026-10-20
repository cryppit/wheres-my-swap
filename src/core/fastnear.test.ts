import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import tx358 from "../fixtures/tx-358-deposit.json";
import { decodeTxStatus, type TxStatusResult } from "./decode.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./fastnear.js";

const text = readFileSync(new URL("../fixtures/fastnear-txs-358.json", import.meta.url), "utf8");

describe("parseFastnearJson", () => {
  it("keeps 64-bit block timestamps exact instead of rounding them through a double", () => {
    const parsed = parseFastnearJson<FastnearTransactionsResponse>(text);
    const swap = parsed.transactions.find((t) => t.transaction.hash === "E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB");
    expect(swap?.execution_outcome.block_timestamp).toBe("1790507776780473251");
  });
});

describe("decodeFastnearTx", () => {
  const parsed = parseFastnearJson<FastnearTransactionsResponse>(text);
  const [swapRaw, depositRaw] = parsed.transactions;
  if (!swapRaw || !depositRaw) throw new Error("fixture has fewer than two transactions");

  it("takes the block position from the transaction's execution outcome", () => {
    const swap = decodeFastnearTx(swapRaw);
    expect(swap.hash).toBe("E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB");
    expect(swap.height).toBe(217478802);
    expect(swap.timestampNs).toBe(1790507776780473251n);
    expect(swap.events.filter((e) => e.event === "token_diff")).toHaveLength(3);
  });

  it("yields the same identity, actions and events as the archival RPC for the same transaction", () => {
    const viaRpc = decodeTxStatus(tx358.result as unknown as TxStatusResult, { height: 215243812, timestampNs: 1789144024048223792n });
    const viaFastnear = decodeFastnearTx(depositRaw);
    expect(viaFastnear.hash).toBe(viaRpc.hash);
    expect(viaFastnear.signer).toBe(viaRpc.signer);
    expect(viaFastnear.actions).toEqual(viaRpc.actions);
    expect(viaFastnear.height).toBe(215243812);
    expect(viaFastnear.timestampNs).toBe(1789144024048223792n);
    const key = (e: { standard: string; event: string; executor: string; data: unknown }) => JSON.stringify([e.standard, e.event, e.executor, e.data]);
    expect(viaFastnear.events.map(key).sort()).toEqual(viaRpc.events.map(key).sort());
  });

  it("exposes receipt-level actions, which the RPC transaction does not carry", () => {
    const swap = decodeFastnearTx(swapRaw);
    expect(swap.receiptActions.some((a) => a.executor === "intents.near" && a.method === "execute_intents")).toBe(true);
  });
});

describe("decodeFastnearTx: a transaction that is still executing", () => {
  // docs.near.org /integrations/fungible-tokens: "A missing outcome is pending." Every receipt an outcome spawns
  // (its `receipt_ids`, action receipts only) must be in the answer before the transaction is complete.
  const fixture = (name: string): FastnearTransactionsResponse => parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
  const raw = fixture("audit/373dde4d.json").transactions.find((t) => t.transaction.hash === "71CxKXGrdd8VohL2adLciuermw7H6FsMSHvMYpvC75rw");
  if (!raw) throw new Error("fixture lacks the native withdrawal");

  it("a complete transaction has nothing pending", () => {
    expect(decodeFastnearTx(raw).pendingReceipts).toBeUndefined();
  });

  it("read mid-flight (nothing after block 219,285,954 has run yet), the receipts spawned but not in the answer are pending", () => {
    const midFlight = { ...raw, receipts: raw.receipts.filter((r) => r.execution_outcome.block_height <= 219_285_954) };
    expect(decodeFastnearTx(midFlight).pendingReceipts).toEqual(["7MvLmnEM4prSrR6qEo6Dg5usuGMbUBrA35Rb4EsimZA", "3V9j2kBFXqdk3Xc2SkADZMsA7VLLed6ouzStj76Wu3UG"]);
  });

  it("before its first receipt has run, that receipt is pending", () => {
    expect(decodeFastnearTx({ ...raw, receipts: [] }).pendingReceipts).toEqual(["CmyWSFPhXj6TdTHjnHzpi8nCgqVnyGPWjaoWNixfmhP6"]);
  });

  it("every transaction recorded under fixtures/ is complete, so the check raises no false alarm", () => {
    const root = new URL("../fixtures/", import.meta.url);
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
    const pending: string[] = [];
    let checked = 0;
    for (const f of files) {
      const parsed: unknown = parseFastnearJson(readFileSync(new URL(f, root), "utf8"));
      const txs = typeof parsed === "object" && parsed !== null && "transactions" in parsed && Array.isArray(parsed.transactions) ? (parsed.transactions as unknown[]) : [];
      for (const t of txs) {
        if (typeof t !== "object" || t === null || !("receipts" in t)) continue;
        const tx = decodeFastnearTx(t as FastnearTransactionsResponse["transactions"][number]);
        checked++;
        if (tx.pendingReceipts) pending.push(`${f} ${tx.hash}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(70);
    expect(pending).toEqual([]);
  });
});
