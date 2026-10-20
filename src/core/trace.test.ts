import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import block358 from "../fixtures/block-358-swap.json";
import tx358 from "../fixtures/tx-358-deposit.json";
import tx6b from "../fixtures/tx-6b-deposit.json";
import { decodeBlockOutcomes, decodeTxStatus, type NeardataBlock, type TxRecord, type TxStatusResult } from "./decode.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./fastnear.js";
import { originOf, payingWithdrawal, tokenRoute, traceOrder } from "./trace.js";

const ACCOUNT_358 = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
const ACCOUNT_6B = "26b9cc669c90eae37285e4c52c35e0fc814314b2a6566250329a8ad497acb5fb";
const USDT_ETH = "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near";
const TRX = "nep141:tron.omft.near";
const HOUR_NS = 3_600n * 1_000_000_000n;

const deposit358 = decodeTxStatus(tx358.result as unknown as TxStatusResult, {
  height: 215243812,
  timestampNs: 1789144024048223792n,
});
const swap358 = decodeBlockOutcomes(block358 as unknown as NeardataBlock)[0];
if (!swap358) throw new Error("fixture block has no transaction");
const deposit6b = decodeTxStatus(tx6b.result as unknown as TxStatusResult, {
  height: 203_000_000,
  timestampNs: 1776_000_000_000_000_000n, // 2026-04-12
});
const NOW = 1791_000_000_000_000_000n; // 2026-10-09

describe("traceOrder on near/intents #358 (TRX → USDT, settled 16 days late)", () => {
  const report = traceOrder({ account: ACCOUNT_358, txs: [swap358, deposit358], nowNs: NOW });

  it("proves the origin from the PoA BRIDGED_FROM memo", () => {
    expect(report.origin).toEqual({
      status: "proven",
      kind: "poa",
      chain: "tron:mainnet",
      txHash: "d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67",
      how: "BRIDGED_FROM memo on the bridge deposit",
    });
  });

  it("records the credit on NEAR", () => {
    expect(report.deposits).toHaveLength(1);
    expect(report.deposits[0]).toMatchObject({
      status: "proven",
      token: TRX,
      amount: "575830000000",
      tx: "8a33DkKfZMWRKbK2pXuQAWVLXSy4AyZF6PfcENvCJgCb",
      timestampNs: 1789144024048223792n,
    });
  });

  it("records the swap with what was given and received, and the counterparties", () => {
    expect(report.swaps).toHaveLength(1);
    expect(report.swaps[0]).toMatchObject({
      status: "proven",
      tx: "E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB",
      gave: { [TRX]: "574678340000" },
      got: { [USDT_ETH]: "190995593894" },
      referral: "1click-unknown",
      intentHash: "6HSyVnHDrdcKgHrZbfnLRQ5Gj2EMGwaYrtrWvyhT4Fkj",
    });
    expect(report.swaps[0]?.counterparties).toEqual([
      "6247d9c671ca6a80cf2c75e26edb8cd75ebf00fcd3c56c39107d6ca20c9cfb29",
      "0x8c60fa34790d4661ae4b5302f2a654539352e81b",
    ]);
  });

  it("records the fee transfer out of the order account", () => {
    expect(report.transfers).toEqual([
      {
        tx: "E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB",
        timestampNs: 1790507776780473251n,
        height: 217478802,
        to: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd",
        toLabel: null,
        tokens: { [TRX]: "1151660000" },
      },
    ]);
  });

  it("records the withdrawal with its destination chain and address", () => {
    expect(report.withdrawals).toHaveLength(1);
    expect(report.withdrawals[0]).toMatchObject({
      status: "proven",
      token: USDT_ETH,
      amount: "190995593894",
      chain: "eth",
      destination: "0x632F5D32448DE43b8b9cfD063aCfcDac09108bad",
      bridge: "poa",
    });
  });

  it("marks the PoA payout as not provable from NEAR", () => {
    expect(report.payout).toEqual({ status: "unverified", chain: "eth", bridge: "poa", destination: "0x632F5D32448DE43b8b9cfD063aCfcDac09108bad" });
  });

  it("leaves no balance behind and flags the late settlement", () => {
    expect(report.balances).toEqual({});
    expect(report.flags).toEqual([
      { kind: "settled_late", delaySec: 1_363_752, detail: "16 days from credit to the first intent" },
    ]);
    expect(report.verdict).toBe("settled");
  });

  it("gives the same answer whatever order the transactions arrive in", () => {
    const reversed = traceOrder({ account: ACCOUNT_358, txs: [deposit358, swap358], nowNs: NOW });
    expect(reversed).toEqual(report);
  });
});

describe("traceOrder on one-click-sdk #6 order 2 (48.28 ETH credited, never swapped)", () => {
  const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b], nowNs: NOW });

  it("proves the origin on Ethereum", () => {
    expect(report.origin).toMatchObject({ status: "proven", kind: "poa", chain: "eth:1", txHash: "0x032c9cf59668a4ff2a2b8f7f9d05bb4dda950b3c0a8ed555d099652bd7be4f4f" });
  });

  it("has a credit but no later hops, and the balance still in the account", () => {
    expect(report.deposits).toHaveLength(1);
    expect(report.swaps).toEqual([]);
    expect(report.withdrawals).toEqual([]);
    expect(report.payout).toEqual({ status: "missing" });
    expect(report.balances).toEqual({ "nep141:eth.omft.near": "48280000000000000000" });
  });

  it("flags the deposit as stalled with how long it has waited, and calls the order stuck", () => {
    const waitedSec = Number((NOW - 1776_000_000_000_000_000n) / 1_000_000_000n);
    expect(report.flags).toEqual([{ kind: "stalled", waitedSec, detail: "credited, no intent since" }]);
    expect(report.verdict).toBe("stuck");
  });
});

describe("traceOrder on one-click-sdk #6 order 2 once intents.near has locked the account", () => {
  // The real force_lock_account of 2026-04-21 11:47:36 UTC, four minutes after the credit (FastNEAR /v0/transactions),
  // which emits dip4 account_locked for the order account. A locked account cannot move its own balances
  // (near/intents contracts/defuse/src/accounts.rs), so this is not a stall that 1Click can end.
  const lock = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("../fixtures/fastnear-force-lock-6b.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx)[0];
  if (!lock) throw new Error("fixture has no transaction");
  const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, lock], nowNs: NOW });

  it("flags the lock, its transaction and how long it has held, instead of a stall, and calls the order stuck", () => {
    const waitedSec = Number((NOW - (lock.timestampNs ?? 0n)) / 1_000_000_000n);
    expect(report.flags).toEqual([
      {
        kind: "locked",
        tx: "8d8P4EkX88vCJXZZuv64WNKh5e1WYKTKLfey6BXj2bpx",
        waitedSec,
        detail: "intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it",
      },
    ]);
    expect(report.verdict).toBe("stuck");
    expect(report.balances).toEqual({ "nep141:eth.omft.near": "48280000000000000000" });
  });

  it("an unlock after the lock clears it, and the order is stalled again", () => {
    const unlock: TxRecord = { ...lock, hash: "UNLOCK", timestampNs: (lock.timestampNs ?? 0n) + HOUR_NS, events: lock.events.map((e) => (e.event === "account_locked" ? { ...e, event: "account_unlocked" } : e)) };
    const r = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, lock, unlock], nowNs: NOW });
    expect(r.flags.map((f) => f.kind)).toEqual(["stalled"]);
  });

  it("a lock of another account is not this order's", () => {
    const other: TxRecord = { ...lock, events: lock.events.map((e) => ({ ...e, data: e.data.map((d) => ({ ...d, account_id: "someone-else.near" })) })) };
    expect(traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, other], nowNs: NOW }).flags.map((f) => f.kind)).toEqual(["stalled"]);
  });
});

describe("traceOrder on a refund (same token in and out, no swap)", () => {
  const refundTx: TxRecord = {
    hash: "RefundTx",
    signer: "relayer.near",
    receiver: "intents.near",
    height: 203_000_010,
    timestampNs: 1776_000_000_000_000_000n + HOUR_NS * 30n,
    actions: [],
    receiptActions: [],
    plainLogs: [],
    events: [
      {
        standard: "dip4",
        version: "0.3.0",
        event: "ft_withdraw",
        executor: "intents.near",
        failed: false,
        data: [
          {
            intent_hash: "RefundIntent",
            account_id: ACCOUNT_6B,
            token: "eth.omft.near",
            receiver_id: "eth.omft.near",
            amount: "48280000000000000000",
            memo: "WITHDRAW_TO:0x3000eAbB000000000000000000000000000000aa",
          },
        ],
      },
    ],
  };
  const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, refundTx], nowNs: NOW });

  it("flags the refund and calls the order refunded", () => {
    expect(report.swaps).toEqual([]);
    expect(report.withdrawals[0]).toMatchObject({ token: "nep141:eth.omft.near", amount: "48280000000000000000", chain: "eth", destination: "0x3000eAbB000000000000000000000000000000aa" });
    expect(report.balances).toEqual({});
    expect(report.flags).toEqual([{ kind: "refunded", detail: "the deposited token was withdrawn without a swap" }]);
    expect(report.verdict).toBe("refunded");
  });
});

describe("traceOrder on an account with no deposit", () => {
  it("reports not_found", () => {
    const report = traceOrder({ account: ACCOUNT_6B, txs: [], nowNs: NOW });
    expect(report.verdict).toBe("not_found");
    expect(report.origin).toEqual({ status: "missing" });
    expect(report.flags).toEqual([]);
  });
});

describe("traceOrder within the stall threshold", () => {
  it("calls a fresh credit in_progress, not stuck", () => {
    const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b], nowNs: 1776_000_000_000_000_000n + HOUR_NS / 2n });
    expect(report.flags).toEqual([]);
    expect(report.verdict).toBe("in_progress");
  });
});

describe("traceOrder on an order that moves into Confidential Intents", () => {
  const TREASURY = "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";
  const shieldTx: TxRecord = {
    hash: "ShieldTx",
    signer: "relayer.near",
    receiver: "intents.near",
    height: 203_000_020,
    timestampNs: 1776_000_000_000_000_000n + HOUR_NS,
    actions: [],
    receiptActions: [],
    plainLogs: [],
    events: [
      {
        standard: "dip4",
        version: "0.3.0",
        event: "transfer",
        executor: "intents.near",
        failed: false,
        data: [{ intent_hash: "ShieldIntent", account_id: ACCOUNT_6B, receiver_id: TREASURY, tokens: { "nep141:eth.omft.near": "48280000000000000000" } }],
      },
    ],
  };
  const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, shieldTx], nowNs: NOW });

  it("labels the transfer and calls the order confidential, not stuck", () => {
    expect(report.transfers[0]?.toLabel).toBe("Confidential Intents treasury");
    expect(report.balances).toEqual({});
    expect(report.flags).toEqual([{ kind: "confidential", detail: "funds moved into Confidential Intents; later legs are not visible on public NEAR" }]);
    expect(report.verdict).toBe("confidential");
  });
});

describe("traceOrder labels documented fee accounts on transfers", () => {
  it("names the protocol fee collector", () => {
    const feeTx: TxRecord = {
      hash: "FeeTx",
      signer: "relayer.near",
      receiver: "intents.near",
      height: 203_000_030,
      timestampNs: 1776_000_000_000_000_000n + HOUR_NS,
      actions: [],
      receiptActions: [],
      plainLogs: [],
      events: [
        {
          standard: "dip4",
          version: "0.3.0",
          event: "transfer",
          executor: "intents.near",
          failed: false,
          data: [{ account_id: ACCOUNT_6B, receiver_id: "7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05", tokens: { "nep141:eth.omft.near": "1" } }],
        },
      ],
    };
    const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, feeTx], nowNs: NOW });
    expect(report.transfers[0]?.toLabel).toBe("NEAR Intents protocol fee");
  });
});

describe("closest 1Click status", () => {
  it("maps each verdict to the 1Click status word a user may have seen", () => {
    expect(traceOrder({ account: ACCOUNT_358, txs: [swap358, deposit358], nowNs: NOW }).oneClickStatus).toBe("SUCCESS");
    expect(traceOrder({ account: ACCOUNT_6B, txs: [deposit6b], nowNs: NOW }).oneClickStatus).toBe("PROCESSING");
    expect(traceOrder({ account: ACCOUNT_6B, txs: [], nowNs: NOW }).oneClickStatus).toBe("PENDING_DEPOSIT");
  });
});

describe("originOf: a Bitcoin deposit through the Omni BTC bridge", () => {
  // G1 order f78dc041…: the relayer's verify_deposit_v2 on btc-connector.bridge.near (FastNEAR tx API, recorded 2026-10-13).
  const raw = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("../fixtures/tx-omni-btc-deposit.json", import.meta.url), "utf8")).transactions[0];
  if (!raw) throw new Error("fixture has no transaction");

  it("names the Bitcoin transaction and output that the bridge added as its coin", () => {
    expect(originOf(decodeFastnearTx(raw))).toEqual({
      status: "proven",
      kind: "omni-utxo",
      chain: "btc:mainnet",
      txHash: "82d074e17c7a697181a87e4b78ec0811743e7578011904ae5eb0eb2a05e9f4cb",
      vout: 0,
      how: "utxo_added event of btc-connector.bridge.near on the deposit",
    });
  });
});

const fastnearTxs = (name: string): TxRecord[] =>
  parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
const LATER = 1_792_000_000_000_000_000n; // 2026-10-14

describe("originOf trusts an origin claim only from its own contract, and only when that step succeeded", () => {
  // docs.near.org /integrations/fungible-tokens: "Authenticate executor_id against the approved token contract; another
  // contract can print the same log." A log or call from a failed receipt proves nothing either (/integrations/deposits).
  const first = (name: string): TxRecord => {
    const txs = fastnearTxs(name).sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    if (!txs[0]) throw new Error("empty fixture");
    return txs[0];
  };
  const NONE = { status: "unverified", kind: "unknown", how: "no origin reference recognised in the deposit transaction" };
  const omni = first("audit/269868c0.json");
  const isFin = (l: { log: string }): boolean => l.log.includes("FinTransferEvent");

  it("the Omni bridge's own FinTransferEvent is proven (order 269868c0…, from Solana)", () => {
    expect(omni.plainLogs.filter(isFin).map((l) => l.executor)).toEqual(["omni.bridge.near"]);
    expect(originOf(omni)).toMatchObject({ status: "proven", kind: "omni", chain: "sol", originNonce: "863549" });
  });

  it("the same FinTransferEvent printed by another contract proves nothing", () => {
    expect(originOf({ ...omni, plainLogs: omni.plainLogs.map((l) => (isFin(l) ? { ...l, executor: "not-the-bridge.near" } : l)) })).toEqual(NONE);
  });

  it("a FinTransferEvent logged by a receipt that failed proves nothing", () => {
    expect(originOf({ ...omni, plainLogs: omni.plainLogs.map((l) => (isFin(l) ? { ...l, failed: true as const } : l)) })).toEqual(NONE);
  });

  it("a BRIDGED_FROM memo on a failed ft_transfer proves nothing", () => {
    expect(originOf({ ...deposit358, events: deposit358.events.map((e) => (e.executor.endsWith(".omft.near") ? { ...e, failed: true } : e)) })).toEqual(NONE);
  });

  it("a HOT mt_deposit_call whose receipt failed proves nothing (order 2230e772…)", () => {
    const hot = first("audit/2230e772.json");
    expect(originOf(hot)).toMatchObject({ status: "proven", kind: "hot" });
    expect(originOf({ ...hot, receiptActions: hot.receiptActions.map((a) => (a.method === "mt_deposit_call" ? { ...a, failed: true as const } : a)) })).toEqual(NONE);
  });

  it("decodes whether the receipt that printed a plain log failed", () => {
    expect(omni.plainLogs.filter(isFin)[0]).not.toHaveProperty("failed");
  });
});

describe("traceOrder on a SOL payout through the Omni bridge, its fee paid in wNEAR (order 4f2fd107…)", () => {
  // FastNEAR tx API, recorded 2026-10-14. A HOT BSC token swapped to SOL; the swap also bought 0.0055 wNEAR, and the
  // withdrawal to omni.bridge.near burned the SOL and that wNEAR (the Omni native fee) together, in one mt_burn.
  const ACCOUNT = "4f2fd1070a623656669739d0c8d95f742469bba6c1c9fbf1ad760db9eb0b774b";
  const report = traceOrder({ account: ACCOUNT, txs: fastnearTxs("fastnear-omni-sol-order.json"), nowNs: LATER });

  it("routes the withdrawal through the Omni bridge to the Solana recipient", () => {
    expect(report.withdrawals).toHaveLength(1);
    expect(report.withdrawals[0]).toMatchObject({ token: "nep141:sol.omft.near", amount: "384642580", bridge: "omni", chain: "sol", destination: "sol:Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5" });
  });

  it("counts the wNEAR the withdrawal burned, so nothing is left and the order is settled, not stuck", () => {
    expect(report.balances).toEqual({});
    expect(report.flags).toEqual([]);
    expect(report.verdict).toBe("settled");
  });
});

describe("traceOrder on a ZEC payout through the Omni bridge (order 496c306d…, swapped in the ZODL wallet)", () => {
  // FastNEAR tx API, recorded 2026-10-14: LTC in, swapped to ZEC, withdrawn to omni.bridge.near for a unified address.
  const ACCOUNT = "496c306d31e6cf622c6ebba95a2ce795bfc11c076abb5f1ac0170104b1743f2c";
  const UA = "zcash:u1jfupn9sjcjfhp3ytfhkxqedyjv8hxq9hz9wdyfpq2x3g3nfc2uwmjq6nq5maana7m8xgytcue0nt57wvy6k20ngcas7crnyeuakaewmf2zk769pq6tywfkzc63k3m0e0wj8hrjq3rxq4nw00fn3vuwzf3klhrt04p8rxhslqyy3amj7h";
  const report = traceOrder({ account: ACCOUNT, txs: fastnearTxs("fastnear-omni-zec-order.json"), nowNs: LATER });

  it("routes zec.omft.near through the Omni bridge to the Zcash unified address, not through the PoA bridge", () => {
    expect(report.withdrawals[0]).toMatchObject({ token: "nep141:zec.omft.near", amount: "55158859", bridge: "omni", chain: "zec", destination: UA });
  });

  it("is settled with nothing left; the payout is for the Zcash side to show", () => {
    expect(report.balances).toEqual({});
    expect(report.verdict).toBe("settled");
    expect(report.payout).toEqual({ status: "unverified", chain: "zec", bridge: "omni", destination: UA });
  });
});

describe("tokenRoute", () => {
  it("PoA tokens route through the PoA bridge, by the chain in their name", () => {
    expect(tokenRoute("nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near")).toEqual({ chain: "eth", bridge: "poa" });
    expect(tokenRoute("nep141:sol-2dc7b64e5dd3c717fc85abaf51cdcd4b18687f09.omft.near")).toEqual({ chain: "sol", bridge: "poa" });
  });

  it("the 17 PoA tokens the Intents SDK now withdraws through the Omni bridge route through Omni", () => {
    expect(tokenRoute("nep141:zec.omft.near")).toEqual({ chain: "zec", bridge: "omni" });
    expect(tokenRoute("nep141:sol.omft.near")).toEqual({ chain: "sol", bridge: "omni" });
    expect(tokenRoute("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near")).toEqual({ chain: "sol", bridge: "omni" });
    expect(tokenRoute("nep141:aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near")).toEqual({ chain: "aptos", bridge: "omni" });
    expect(tokenRoute("nep141:starknet.omft.near")).toEqual({ chain: "starknet", bridge: "omni" });
  });

  it("tokens the Omni bridge deploys (*.omdep.near) and nBTC route through Omni", () => {
    expect(tokenRoute("nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near")).toEqual({ chain: "sol", bridge: "omni" });
    expect(tokenRoute("nep141:base-0xc2bc2a4cd04358281c7cf36a057fc15e5552b18b.omdep.near")).toEqual({ chain: "base", bridge: "omni" });
    expect(tokenRoute("nep141:abs.omdep.near")).toEqual({ chain: "abs", bridge: "omni" });
    expect(tokenRoute("nep141:nbtc.bridge.near")).toEqual({ chain: "btc", bridge: "omni" });
  });
});

/** A transaction on intents.near carrying the given events, an hour after deposit6b. */
function intentsTx(hash: string, events: Omit<TxRecord["events"][number], "executor" | "failed" | "version">[], hours = 1n): TxRecord {
  return {
    hash,
    signer: "relayer.near",
    receiver: "intents.near",
    height: 203_000_100 + Number(hours),
    timestampNs: 1776_000_000_000_000_000n + HOUR_NS * hours,
    actions: [],
    receiptActions: [],
    plainLogs: [],
    events: events.map((e) => ({ ...e, version: e.standard === "dip4" ? "0.4.3" : "1.0.0", executor: "intents.near", failed: false })),
  };
}
const ETH_TOKEN = "nep141:eth.omft.near";
const ETH_AMOUNT = "48280000000000000000";

describe("traceOrder routes each withdrawal by its receiver", () => {
  it("a token that is not on the migrated list still goes through Omni when it is sent to omni.bridge.near", () => {
    const tx = intentsTx("OmniBase", [
      { standard: "dip4", event: "ft_withdraw", data: [{ account_id: ACCOUNT_6B, token: "eth.omft.near", receiver_id: "omni.bridge.near", amount: ETH_AMOUNT, msg: '{"recipient":"base:0x3000eAbB000000000000000000000000000000aa","fee":"0","native_token_fee":"0"}' }] },
    ]);
    const w = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, tx], nowNs: NOW }).withdrawals[0];
    expect(w).toMatchObject({ bridge: "omni", chain: "base", destination: "base:0x3000eAbB000000000000000000000000000000aa" });
  });

  it("a migrated token burned on its own PoA contract (an older withdrawal) is still the PoA bridge", () => {
    const tx = intentsTx("PoaSol", [
      { standard: "dip4", event: "ft_withdraw", data: [{ account_id: ACCOUNT_6B, token: "sol.omft.near", receiver_id: "sol.omft.near", amount: "5", memo: "WITHDRAW_TO:Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5" }] },
    ]);
    const w = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, tx], nowNs: NOW }).withdrawals[0];
    expect(w).toMatchObject({ bridge: "poa", chain: "sol", destination: "Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5" });
  });
});

describe("traceOrder on a multi-token (NEP-245) withdrawal", () => {
  // intents.near keys a NEP-245 balance as nep245:<contract>:<token id> (near/intents, Nep245TokenId), and that is how
  // the deposit is minted; the mt_withdraw event names the contract and the bare id separately.
  const HOT = "nep245:v2_1.omni.hot.tg:56_11111111111111111111";
  const deposit = intentsTx("HotIn", [{ standard: "nep245", event: "mt_mint", data: [{ owner_id: ACCOUNT_6B, token_ids: [HOT], amounts: ["1000"], memo: "deposit" }] }], 1n);
  const withdraw = intentsTx("HotOut", [
    { standard: "dip4", event: "mt_withdraw", data: [{ account_id: ACCOUNT_6B, token: "v2_1.omni.hot.tg", receiver_id: "v2_1.omni.hot.tg", token_ids: ["56_11111111111111111111"], amounts: ["1000"], msg: '{"receiver_id":"0x3000eabb000000000000000000000000000000aa"}' }] },
  ], 2n);
  const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit, withdraw], nowNs: NOW });

  it("debits the full token id, so the account is empty and the order a refund", () => {
    expect(report.withdrawals[0]).toMatchObject({ token: HOT, amount: "1000" });
    expect(report.balances).toEqual({});
    expect(report.verdict).toBe("refunded");
  });
});

describe("traceOrder on a withdrawal that failed and came back", () => {
  // near/intents ft_resolve_withdraw: when the transfer out fails, the amount is minted back with memo "refund".
  const failed = intentsTx("FailedOut", [
    { standard: "dip4", event: "ft_withdraw", data: [{ account_id: ACCOUNT_6B, token: "eth.omft.near", receiver_id: "omni.bridge.near", amount: ETH_AMOUNT, msg: '{"recipient":"eth:0x3000eAbB000000000000000000000000000000aa","fee":"0","native_token_fee":"0"}' }] },
    { standard: "nep245", event: "mt_burn", data: [{ owner_id: ACCOUNT_6B, token_ids: [ETH_TOKEN], amounts: [ETH_AMOUNT], memo: "withdraw" }] },
    { standard: "nep245", event: "mt_mint", data: [{ owner_id: ACCOUNT_6B, token_ids: [ETH_TOKEN], amounts: [ETH_AMOUNT], memo: "refund" }] },
  ]);
  const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, failed], nowNs: NOW });

  it("marks the withdrawal returned and keeps the money in the order account", () => {
    expect(report.withdrawals[0]).toMatchObject({ token: ETH_TOKEN, amount: ETH_AMOUNT, returned: ETH_AMOUNT });
    expect(report.balances).toEqual({ [ETH_TOKEN]: ETH_AMOUNT });
    expect(payingWithdrawal(report)).toBeUndefined();
    expect(report.payout).toEqual({ status: "missing" });
  });

  it("says the withdrawal failed, and calls the order stuck, not refunded", () => {
    expect(report.flags.map((f) => f.kind)).toEqual(["withdrawal_returned", "stalled"]);
    expect(report.flags[0]).toEqual({ kind: "withdrawal_returned", detail: "a withdrawal failed and its tokens came back to the order account" });
    expect(report.verdict).toBe("stuck");
  });
});

describe("traceOrder debits a withdrawal's storage deposit", () => {
  it("takes the storage deposit from wNEAR when the withdrawal names one and no burn event is there to count", () => {
    const deposit = intentsTx("TwoIn", [{ standard: "nep245", event: "mt_mint", data: [{ owner_id: ACCOUNT_6B, token_ids: [ETH_TOKEN, "nep141:wrap.near"], amounts: [ETH_AMOUNT, "1250000000000000000000"], memo: "deposit" }] }], 1n);
    const withdraw = intentsTx("OutWithStorage", [
      { standard: "dip4", event: "ft_withdraw", data: [{ account_id: ACCOUNT_6B, token: "eth.omft.near", receiver_id: "eth.omft.near", amount: ETH_AMOUNT, memo: "WITHDRAW_TO:0x3000eAbB000000000000000000000000000000aa", storage_deposit: "1250000000000000000000" }] },
    ], 2n);
    expect(traceOrder({ account: ACCOUNT_6B, txs: [deposit, withdraw], nowNs: NOW }).balances).toEqual({});
  });
});

describe("traceOrder on an order funded inside NEAR Intents: unshielded from Confidential Intents (order d44643b6…)", () => {
  // FastNEAR tx API, recorded 2026-10-14: the Confidential Intents treasury transfers Arbitrum USDC into the order
  // account (the public leg of a confidential swap), which withdraws it through the PoA bridge.
  const ACCOUNT = "d44643b640ee2117df9904884f7490904a5217bff1446ffa2e5059fcc52fae90";
  const TREASURY = "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";
  const report = traceOrder({ account: ACCOUNT, txs: fastnearTxs("fastnear-unshielded-order.json"), nowNs: LATER });

  it("counts the transfer in as the order's credit, from the treasury, so the order is found", () => {
    expect(report.deposits[0]).toMatchObject({ status: "proven", via: "transfer", from: TREASURY, token: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" });
    expect(report.origin).toEqual({ status: "unverified", kind: "unknown", how: "unshielded from the Confidential Intents treasury: the private leg before it is not public" });
  });

  it("is settled, not refunded: the swap happened on the private side", () => {
    expect(report.withdrawals[0]).toMatchObject({ bridge: "poa", chain: "arb" });
    expect(report.balances).toEqual({});
    expect(report.verdict).toBe("settled");
    expect(report.flags).toContainEqual({ kind: "confidential", detail: "funded from Confidential Intents; the legs before it are not visible on public NEAR" });
  });
});

describe("traceOrder on an order emptied by a transfer inside NEAR Intents (recipient or refund type INTENTS)", () => {
  const swapAndSend = intentsTx("IntentsOut", [
    { standard: "dip4", event: "token_diff", data: [{ account_id: ACCOUNT_6B, diff: { [ETH_TOKEN]: `-${ETH_AMOUNT}`, "nep141:wrap.near": "5000" }, referral: "1click-test" }] },
    { standard: "dip4", event: "transfer", data: [{ account_id: ACCOUNT_6B, receiver_id: "alice.near", tokens: { "nep141:wrap.near": "5000" } }] },
  ]);
  const report = traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, swapAndSend], nowNs: NOW });

  it("is settled, with the transfer to the recipient's NEAR Intents account as the payout, proven", () => {
    expect(report.balances).toEqual({});
    expect(report.verdict).toBe("settled");
    expect(report.payout).toMatchObject({ status: "arrived", how: "proven", chain: "near", bridge: "near", destination: "alice.near", tx: "IntentsOut", amount: "5000" });
  });
});

describe("traceOrder when unused input is refunded in the same transaction as the payout (order 5b9ba4db…)", () => {
  // FastNEAR tx API, recorded 2026-10-14: wNEAR swapped to ETH; one transaction withdraws the ETH through the PoA bridge
  // (the payout) and then returns the unused wNEAR to the refund address with native_withdraw (1Click refunds excess input).
  const ACCOUNT = "5b9ba4db12f7e8960784e2e57c0cff7dde8a4f788701b37dca16ff8bab0e0ed1";
  const report = traceOrder({ account: ACCOUNT, txs: fastnearTxs("fastnear-excess-refund-order.json"), nowNs: LATER });

  it("pays out the swapped ETH, and marks the NEAR withdrawal as the refund of unused input", () => {
    expect(report.withdrawals.map((w) => [w.token, w.excessRefund ?? false])).toEqual([
      ["nep141:eth.omft.near", false],
      ["nep141:wrap.near", true],
    ]);
    expect(payingWithdrawal(report)?.token).toBe("nep141:eth.omft.near");
    expect(report.payout).toEqual({ status: "unverified", chain: "eth", bridge: "poa", destination: "0xBC9eCD86F7036f6205969a4c3D8360D91AFc9843" });
    expect(report.verdict).toBe("settled");
  });
});

describe("traceOrder on a HOT bridge withdrawal (order 35748b81…)", () => {
  // FastNEAR tx API, recorded 2026-10-14: HOT's gasless withdrawal mt_withdraws the token and a native-coin fee leg
  // (token_ids[1], whose amount is msg.amount_native) to bridge-refuel.hot.tg; msg.receiver_id is the destination,
  // base58-encoded (HOT omni-sdk buildGaslessWithdrawIntent).
  const ACCOUNT = "35748b81aa0121a1a2a2a38087b47714c1673fcfe31c920b14c182330ee355de";
  const report = traceOrder({ account: ACCOUNT, txs: fastnearTxs("fastnear-unshielded-hot-order.json"), nowNs: LATER });

  it("is one withdrawal of BSC USDT through the HOT bridge to the decoded EVM address; the fee leg is not a hop", () => {
    expect(report.withdrawals).toHaveLength(1);
    expect(report.withdrawals[0]).toMatchObject({
      token: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
      amount: "143898261062558980480",
      bridge: "hot",
      chain: "bsc",
      destination: "0x28c25b0ceb8d76cb3a611c03ea4f9c1d463c0156",
    });
    expect(report.balances).toEqual({});
    expect(report.verdict).toBe("settled");
  });
});

describe("tokenRoute: HOT bridge tokens", () => {
  it("names the chain from the HOT chain id", () => {
    expect(tokenRoute("nep245:v2_1.omni.hot.tg:56_11111111111111111111")).toEqual({ chain: "bsc", bridge: "hot" });
    expect(tokenRoute("nep245:v2_1.omni.hot.tg:1117_11111111111111111111")).toEqual({ chain: "ton", bridge: "hot" });
    expect(tokenRoute("nep245:v2_1.omni.hot.tg:143_11111111111111111111")).toEqual({ chain: "monad", bridge: "hot" });
    expect(tokenRoute("nep245:v2_1.omni.hot.tg:999999_11111111111111111111")).toEqual({ chain: null, bridge: "hot" });
  });
});

describe("a native NEAR payout that bounced off a named account nobody created (DERIVED from order 373dde4d…)", () => {
  // NOT a recording: fixtures/derived/373dde4d-native-payout-bounced.json is audit order 373dde4d with its
  // native_withdraw sent to nobody-made-this.near; the Transfer receipt fails with AccountDoesNotExist and spawns the
  // system refund of the deposit to intents.near (its _derived note says exactly what changed). A plain transfer to a
  // named account that does not exist fails and is refunded to the sender (docs.near.org /integrations/create-transactions),
  // and intents.near pays native NEAR with a bare transfer and no callback (near/intents nep141/native.rs), so the
  // refund lands in intents.near's own balance, not the order account.
  const ACCOUNT = "373dde4de823895a57e957954abbe1579394f35b43fd4a40b0153db8970a49a4";
  const NAMED = "nobody-made-this.near";
  const TX = "71CxKXGrdd8VohL2adLciuermw7H6FsMSHvMYpvC75rw";
  const txs = fastnearTxs("derived/373dde4d-native-payout-bounced.json");
  const report = traceOrder({ account: ACCOUNT, txs, nowNs: LATER });

  it("decodes the failed transfer with the chain's reason and the system refund that returned it to intents.near", () => {
    expect(txs.find((t) => t.hash === TX)?.nativeTransfers).toContainEqual({
      from: "intents.near",
      to: NAMED,
      deposit: "90000000000000000000000",
      failed: true,
      receipt: "7MvLmnEM4prSrR6qEo6Dg5usuGMbUBrA35Rb4EsimZA",
      error: "AccountDoesNotExist",
      refund: "DerivedBa1anceRefund11111111111111111111111",
    });
  });

  it("marks the withdrawal bounced, so it is not the payout, and calls the order stuck, not settled", () => {
    expect(report.withdrawals).toMatchObject([
      { kind: "native_withdraw", token: "nep141:wrap.near", destination: NAMED, bounced: { reason: "transfer_failed", error: "AccountDoesNotExist", receipt: "7MvLmnEM4prSrR6qEo6Dg5usuGMbUBrA35Rb4EsimZA", refund: "DerivedBa1anceRefund11111111111111111111111" } },
    ]);
    expect(payingWithdrawal(report)).toBeUndefined();
    expect(report.payout).toEqual({ status: "missing" });
    expect(report.balances).toEqual({});
    expect(report.verdict).toBe("stuck");
  });

  it("flags the bounce, citing the refund to intents.near", () => {
    expect(report.flags).toEqual([
      {
        kind: "payout_bounced",
        detail: `NEAR could not deliver the payout to ${NAMED} (that account does not exist) and returned it to intents.near (refund receipt DerivedBa1anceRefund11111111111111111111111); NEAR Intents does not credit a failed NEAR payout back: it stays with intents.near, outside the order account`,
      },
    ]);
  });

  it("the recorded original, paid to an implicit account, is still a proven payout", () => {
    const original = traceOrder({ account: ACCOUNT, txs: fastnearTxs("audit/373dde4d.json"), nowNs: LATER });
    expect(original.withdrawals[0]?.bounced).toBeUndefined();
    expect(original.payout).toMatchObject({ status: "arrived", how: "proven" });
    expect(original.verdict).toBe("settled");
  });
});

describe("native NEAR payouts that failed inside intents.near, or that the source cannot judge", () => {
  const NAMED = "nobody-made-this.near";
  const AMOUNT = "90000000000000000000000";
  const credit = intentsTx("NearIn", [{ standard: "nep245", event: "mt_mint", data: [{ owner_id: ACCOUNT_6B, token_ids: ["nep141:wrap.near"], amounts: [AMOUNT], memo: "deposit" }] }], 1n);
  const withdrawal = (extra: Partial<TxRecord>): TxRecord => ({
    ...intentsTx("NearOut", [
      { standard: "dip4", event: "native_withdraw", data: [{ account_id: ACCOUNT_6B, receiver_id: NAMED, amount: AMOUNT }] },
      { standard: "nep245", event: "mt_burn", data: [{ owner_id: ACCOUNT_6B, token_ids: ["nep141:wrap.near"], amounts: [AMOUNT], memo: "withdraw" }] },
    ], 2n),
    ...extra,
  });

  it("intents.near's own unwrapping failed (near_withdraw, then do_native_withdraw panics): bounced, nothing was sent", () => {
    const failedSteps = [
      { executor: "wrap.near", method: "near_withdraw", args: { amount: AMOUNT }, failed: true as const, receipt: "UnwrapR" },
      { executor: "intents.near", method: "do_native_withdraw", args: { withdraw: { receiver_id: NAMED, amount: AMOUNT } }, failed: true as const, receipt: "PayStepR" },
    ];
    const r = traceOrder({ account: ACCOUNT_6B, txs: [credit, withdrawal({ receiptActions: failedSteps, nativeTransfers: [] })], nowNs: NOW });
    expect(r.withdrawals[0]?.bounced).toEqual({ reason: "unwrap_failed", step: "near_withdraw", receipt: "UnwrapR" });
    expect(r.verdict).toBe("stuck");
    expect(r.flags).toContainEqual({
      kind: "payout_bounced",
      detail: `intents.near's own payout step (near_withdraw) failed, so no NEAR was sent to ${NAMED}; NEAR Intents does not credit a failed NEAR payout back: it stays with intents.near, outside the order account`,
    });
  });

  it("a source without receipts (nativeTransfers absent) cannot tell: the payout stays unverified and the order settled", () => {
    const r = traceOrder({ account: ACCOUNT_6B, txs: [credit, withdrawal({})], nowNs: NOW });
    expect(r.withdrawals[0]?.bounced).toBeUndefined();
    expect(r.payout).toMatchObject({ status: "unverified", destination: NAMED });
    expect(r.verdict).toBe("refunded");
  });

  it("receipts with no transfer and no failed step prove nothing either way: unverified, not bounced", () => {
    const r = traceOrder({ account: ACCOUNT_6B, txs: [credit, withdrawal({ nativeTransfers: [] })], nowNs: NOW });
    expect(r.withdrawals[0]?.bounced).toBeUndefined();
    expect(r.payout).toMatchObject({ status: "unverified", reason: "no successful transfer of the withdrawn NEAR to the destination in the withdrawal transaction" });
  });

  it("a bounced refund of unused input does not hide behind a payout that arrived", () => {
    const swap = intentsTx("Swap", [{ standard: "dip4", event: "token_diff", data: [{ account_id: ACCOUNT_6B, diff: { "nep141:wrap.near": "-1", [ETH_TOKEN]: ETH_AMOUNT }, referral: "1click-test" }] }], 2n);
    const out = intentsTx("Out", [
      { standard: "dip4", event: "ft_withdraw", data: [{ account_id: ACCOUNT_6B, token: "eth.omft.near", receiver_id: "eth.omft.near", amount: ETH_AMOUNT, memo: "WITHDRAW_TO:0x3000eAbB000000000000000000000000000000aa" }] },
      { standard: "dip4", event: "native_withdraw", data: [{ account_id: ACCOUNT_6B, receiver_id: NAMED, amount: "89999999999999999999999" }] },
    ], 3n);
    const bounced = { ...out, nativeTransfers: [{ from: "intents.near", to: NAMED, deposit: "89999999999999999999999", failed: true, error: "AccountDoesNotExist" }] };
    const r = traceOrder({ account: ACCOUNT_6B, txs: [credit, swap, bounced], nowNs: NOW });
    expect(r.withdrawals.map((w) => [w.token, w.excessRefund ?? false, w.bounced?.reason ?? null])).toEqual([
      [ETH_TOKEN, false, null],
      ["nep141:wrap.near", true, "transfer_failed"],
    ]);
    expect(payingWithdrawal(r)?.token).toBe(ETH_TOKEN);
    expect(r.verdict).toBe("settled");
    expect(r.flags.map((f) => f.kind)).toEqual(["payout_bounced"]);
  });
});

describe("an order whose transaction is still executing ('A missing outcome is pending', docs.near.org /integrations/fungible-tokens)", () => {
  // Audit order 373dde4d… read mid-flight: its recording cut at a block height, so the receipts after it have not run
  // yet. At 219,285,954 the burn is done and the native transfer to the destination is not.
  const ACCOUNT = "373dde4de823895a57e957954abbe1579394f35b43fd4a40b0153db8970a49a4";
  const TX = "71CxKXGrdd8VohL2adLciuermw7H6FsMSHvMYpvC75rw";
  const raw = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("../fixtures/audit/373dde4d.json", import.meta.url), "utf8")).transactions;
  const cut = (height: number): TxRecord[] => raw.map((t) => decodeFastnearTx({ ...t, receipts: t.receipts.filter((r) => r.execution_outcome.block_height <= height) }));
  const midFlight = cut(219_285_954);
  const sentAt = midFlight.find((t) => t.hash === TX)?.timestampNs ?? 0n;
  const SEC = 1_000_000_000n;

  it("is in progress and says so, not settled; the payout is waiting, not unverified", () => {
    const r = traceOrder({ account: ACCOUNT, txs: midFlight, nowNs: sentAt + 5n * SEC });
    expect(r.verdict).toBe("in_progress");
    expect(r.flags).toEqual([{ kind: "executing", tx: TX, detail: `NEAR is still executing transaction ${TX} (2 of its steps have not run yet): this is not final, check again in a minute` }]);
    expect(r.payout).toEqual({ status: "waiting", chain: "near", bridge: "near", destination: "4c94f4800bb5890e6e9804fd2aaa83972b0f53a0f953ec83e2fb26332d8efc6b", waitedSec: 5 });
  });

  it("a deposit whose first step has not run yet is in progress, not 'no order found'", () => {
    const deposit = cut(219_285_940).find((t) => t.hash === "FsABsRBrKKALKsXR6PvwL9Lftf6gibWMTZXyacK3TjtA");
    if (!deposit?.timestampNs) throw new Error("fixture lacks the deposit");
    const r = traceOrder({ account: ACCOUNT, txs: [deposit], nowNs: deposit.timestampNs + 2n * SEC });
    expect(r.deposits).toEqual([]);
    expect(r.verdict).toBe("in_progress");
    expect(r.flags.map((f) => f.kind)).toEqual(["executing"]);
  });

  it("steps still missing long after the transaction are a gap in the data, not execution: flagged, and traced as it stands", () => {
    const r = traceOrder({ account: ACCOUNT, txs: midFlight, nowNs: LATER });
    expect(r.verdict).toBe("settled");
    expect(r.flags).toEqual([{ kind: "incomplete_history", detail: `transaction ${TX} is missing 2 of its steps in the data we read, long after it ran: part of it is not traced` }]);
  });

  it("the complete recording is settled, with nothing flagged", () => {
    const r = traceOrder({ account: ACCOUNT, txs: cut(Number.MAX_SAFE_INTEGER), nowNs: sentAt + 5n * SEC });
    expect(r.verdict).toBe("settled");
    expect(r.flags).toEqual([]);
  });
});

describe("traceOrder reads a PoA destination with a memo or tag", () => {
  it("WITHDRAW_TO:<address>:<memo> keeps the address apart from the memo (XRP destination tags)", () => {
    const tx = intentsTx("XrpOut", [
      { standard: "dip4", event: "ft_withdraw", data: [{ account_id: ACCOUNT_6B, token: "xrp.omft.near", receiver_id: "xrp.omft.near", amount: "5", memo: "WITHDRAW_TO:rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH:123456" }] },
    ]);
    expect(traceOrder({ account: ACCOUNT_6B, txs: [deposit6b, tx], nowNs: NOW }).withdrawals[0]).toMatchObject({ destination: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", externalId: "123456" });
  });
});
