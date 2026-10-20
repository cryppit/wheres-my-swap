// The decoder against the protocol spec's checklist (the NEAR protocol spec, nomicon.io, §1). Each test names
// the checklist item it covers.
import { describe, expect, it } from "vitest";

import { checkOrder, type NearClient } from "../check.js";
import { decodeTxStatus, type NepEvent, type TxRecord, type TxStatusResult } from "./decode.js";
import { whoCanMove } from "./custody.js";
import { traceOrder } from "./trace.js";

const ACCT = "a".repeat(64);
const NOW = 1791_000_000_000_000_000n;
const T0 = 1790_000_000_000_000_000n;

function tx(hash: string, height: number, events: Omit<NepEvent, "executor" | "failed">[], extra: Partial<TxRecord> = {}): TxRecord {
  return {
    hash,
    signer: "relayer.near",
    receiver: "intents.near",
    height,
    timestampNs: T0 + BigInt(height) * 1_000_000_000n,
    actions: [],
    receiptActions: [],
    plainLogs: [],
    events: events.map((e) => ({ ...e, executor: "intents.near", failed: false })),
    ...extra,
  };
}
const mint = (amount: unknown, tokenIds: unknown = ["nep141:eth.omft.near"]) => ({ standard: "nep245", version: "1.0.0", event: "mt_mint", data: [{ owner_id: ACCT, token_ids: tokenIds, amounts: [amount], memo: "deposit" }] });

describe("decoder audit (nomicon checklist)", () => {
  it("#11 parses EVENT_JSON with whitespace after the prefix and keeps other logs as plain text", () => {
    const result = {
      transaction: { hash: "H", signer_id: "s.near", receiver_id: "intents.near", actions: [] },
      transaction_outcome: { block_hash: "B", outcome: { executor_id: "s.near", logs: [], status: { SuccessReceiptId: "R" } } },
      receipts_outcome: [
        { id: "R", block_hash: "B", outcome: { executor_id: "intents.near", status: { SuccessValue: "" }, logs: ['EVENT_JSON:  {"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[]}', "EVENT_JSON:{not json", 'EVENT_JSON:{"version":"1.0.0","event":"x"}', "plain log"] } },
      ],
    } as unknown as TxStatusResult;
    const d = decodeTxStatus(result, { height: 1, timestampNs: 1n });
    expect(d.events.map((e) => e.event)).toEqual(["mt_mint"]);
    expect(d.plainLogs.map((l) => l.log)).toEqual(["EVENT_JSON:{not json", "plain log"]);
  });

  it("#15 a malformed or numeric amount is skipped, never crashes the trace", () => {
    const r = traceOrder({ account: ACCT, txs: [tx("D1", 1, [mint("12.5")]), tx("D2", 2, [mint(7)]), tx("D3", 3, [mint("100")])], nowNs: NOW });
    expect(r.deposits.map((d) => d.amount)).toEqual(["100"]);
    expect(r.balances).toEqual({ "nep141:eth.omft.near": "100" });
  });

  it("#15 a malformed token_diff value is skipped, never crashes the trace", () => {
    const r = traceOrder({
      account: ACCT,
      txs: [tx("D", 1, [mint("100")]), tx("S", 2, [{ standard: "dip4", version: "0.3.0", event: "token_diff", data: [{ account_id: ACCT, diff: { "nep141:eth.omft.near": "-1e3", "nep141:usdt.near": "50" } }] }])],
      nowNs: NOW,
    });
    expect(r.swaps[0]?.got).toEqual({ "nep141:usdt.near": "50" });
    expect(r.swaps[0]?.gave).toEqual({});
  });

  it("#13 mt events with mismatched token_ids and amounts use only the aligned pairs", () => {
    const r = traceOrder({ account: ACCT, txs: [tx("D", 1, [mint("5", ["nep141:a.near", "nep141:b.near"])])], nowNs: NOW });
    expect(r.deposits.map((d) => d.token)).toEqual(["nep141:a.near"]);
  });

  it("accepts any dip4 version (live chain runs 0.3.x and 0.4.x)", () => {
    const r = traceOrder({ account: ACCT, txs: [tx("D", 1, [mint("10")]), tx("S", 2, [{ standard: "dip4", version: "0.4.3", event: "token_diff", data: [{ account_id: ACCT, diff: { "nep141:eth.omft.near": "-10", "nep141:usdt.near": "9" } }] }])], nowNs: NOW });
    expect(r.swaps).toHaveLength(1);
  });

  it("#6 receipts executed by `system` (refunds) are never read as intents", () => {
    const refund: TxRecord = { ...tx("R", 2, []), events: [{ standard: "dip4", version: "0.3.0", event: "transfer", executor: "system", failed: false, data: [{ account_id: ACCT, receiver_id: "x.near", tokens: { "nep141:eth.omft.near": "10" } }] }] };
    const r = traceOrder({ account: ACCT, txs: [tx("D", 1, [mint("10")]), refund], nowNs: NOW });
    expect(r.transfers).toEqual([]);
    expect(r.balances).toEqual({ "nep141:eth.omft.near": "10" });
  });

  it("the same transaction listed twice in an account's history is counted once", async () => {
    const d = tx("D", 1, [mint("10")]);
    const client: NearClient = {
      async accountTxs() {
        return [
          { hash: "D", height: 1, timestampNs: 1n },
          { hash: "D", height: 1, timestampNs: 1n },
        ];
      },
      async transactions(hashes) {
        return hashes.map(() => d);
      },
    };
    const r = await checkOrder(ACCT, client, NOW);
    expect(r.txCount).toBe(1);
    expect(r.balances).toEqual({ "nep141:eth.omft.near": "10" });
  });
});

describe("round-1 incident bugs", () => {
  const out = (h: string, height: number, receiver: string, amount: string) => tx(h, height, [{ standard: "dip4", version: "0.3.0", event: "transfer", data: [{ account_id: ACCT, receiver_id: receiver, tokens: { "nep141:eth.omft.near": amount } }] }]);
  const withdraw = (h: string, height: number, amount: string) => tx(h, height, [{ standard: "dip4", version: "0.3.0", event: "ft_withdraw", data: [{ account_id: ACCT, token: "eth.omft.near", receiver_id: "eth.omft.near", amount, memo: "WITHDRAW_TO:0xabc" }] }]);

  it("a refund followed by a later small deposit is still a refund, with the later deposit named, not stuck", () => {
    const r = traceOrder({ account: ACCT, txs: [tx("D1", 1, [mint("1000")]), withdraw("W", 2, "1000"), tx("D2", 3, [mint("1")])], nowNs: NOW });
    expect(r.verdict).toBe("refunded");
    expect(r.flags.map((f) => f.kind)).toEqual(["refunded", "later_deposit"]);
    expect(r.balances).toEqual({ "nep141:eth.omft.near": "1" });
  });

  it("counts transfers into the account as credits", () => {
    const incoming = tx("IN", 1, [{ standard: "dip4", version: "0.3.0", event: "transfer", data: [{ account_id: "x.near", receiver_id: ACCT, tokens: { "nep141:eth.omft.near": "50" } }] }]);
    const r = traceOrder({ account: ACCT, txs: [incoming, out("O", 2, "y.near", "20")], nowNs: NOW });
    expect(r.balances).toEqual({ "nep141:eth.omft.near": "30" });
  });

  it("never shows a negative balance; flags the history as incomplete instead", () => {
    const r = traceOrder({ account: ACCT, txs: [out("O", 2, "y.near", "20")], nowNs: NOW });
    expect(r.balances).toEqual({});
    expect(r.flags).toEqual([{ kind: "incomplete_history", detail: "more left the account than we saw arrive; part of its history is missing" }]);
  });
});

describe("a withdrawal whose ft_transfer_call to the bridge failed (defuse ft_resolve_withdraw does not credit it back)", () => {
  // Constructed from the contract's documented behaviour (near/intents nep141/withdraw.rs; docs "refunds can only be
  // processed when ft_transfer is used"): no live case was seen in the 337-order audit.
  const withdrawal = { standard: "dip4", version: "0.3.0", event: "ft_withdraw", data: [{ account_id: ACCT, token: "sol.omft.near", receiver_id: "omni.bridge.near", amount: "1000", msg: '{"recipient":"sol:Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5"}' }] };
  const burn = { standard: "nep245", version: "1.0.0", event: "mt_burn", data: [{ owner_id: ACCT, token_ids: ["nep141:sol.omft.near"], amounts: ["1000"], memo: "withdraw" }] };
  const solMint = mint("1000", ["nep141:sol.omft.near"]);
  const failedCall = { executor: "sol.omft.near", method: "ft_transfer_call", args: { receiver_id: "omni.bridge.near", amount: "1000" }, failed: true as const };

  it("marks the withdrawal refused, says so, and does not wait an hour to call it stuck", () => {
    const r = traceOrder({ account: ACCT, txs: [tx("D", 1, [solMint]), tx("W", 2, [withdrawal, burn], { receiptActions: [failedCall] })], nowNs: T0 + 3n * 1_000_000_000n });
    expect(r.withdrawals[0]).toMatchObject({ amount: "1000", bridge: "omni", refused: true });
    expect(r.verdict).toBe("stuck");
    expect(r.payout).toEqual({ status: "missing" });
    expect(r.flags).toContainEqual({ kind: "withdrawal_refused", detail: "the transfer to the bridge failed, and NEAR Intents does not credit a failed ft_transfer_call back: the tokens stay with intents.near, outside the order account" });
  });

  it("custody says the intents.near contract holds it, and asks for help", () => {
    const r = traceOrder({ account: ACCT, txs: [tx("D", 1, [solMint]), tx("W", 2, [withdrawal, burn], { receiptActions: [failedCall] })], nowNs: NOW });
    const c = whoCanMove(r);
    expect(c).toMatchObject({ place: "intents_contract", needsHelp: true });
    expect(c.canMove).toBe("Only NEAR Intents, which runs intents.near, when 1Click asks it to: not you, not the app you swapped in, and not us.");
  });

  it("a failed call whose tokens came back (mt_mint memo refund) is a returned withdrawal, not a refused one", () => {
    const back = { standard: "nep245", version: "1.0.0", event: "mt_mint", data: [{ owner_id: ACCT, token_ids: ["nep141:sol.omft.near"], amounts: ["1000"], memo: "refund" }] };
    const r = traceOrder({ account: ACCT, txs: [tx("D", 1, [solMint]), tx("W", 2, [withdrawal, burn, back], { receiptActions: [failedCall] })], nowNs: NOW });
    expect(r.withdrawals[0]?.refused).toBeUndefined();
    expect(r.withdrawals[0]?.returned).toBe("1000");
  });
});
