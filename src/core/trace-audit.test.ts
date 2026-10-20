// Real orders from the checker accuracy audit (2026-10-14): each fixture is the FastNEAR tx API's answer for every
// transaction of one order account, recorded during the audit. The audit compared the checker with RPC balances and
// the destination chains; these tests pin the cases it found wrong.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { TxRecord } from "./decode.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./fastnear.js";
import { whoCanMove } from "./custody.js";
import { dustThresholds } from "./dust.js";
import { findOrderAccount, originOf, tokenRoute, traceOrder } from "./trace.js";

const auditTxs = (prefix: string): TxRecord[] =>
  parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL(`../fixtures/audit/${prefix}.json`, import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
const NOW = 1_792_000_000_000_000_000n; // 2026-10-14
const WNEAR = "nep141:wrap.near";
const USDT = "nep141:usdt.tether-token.near";

describe("an order funded by a direct NEP-245 mt_transfer (the NEAR Mobile app), with no dip4 event", () => {
  const ACCOUNT = "97bd4a1e1a35bd5df58f222417026bbd574b8d0d30038c17f11c90900099f734";
  const report = traceOrder({ account: ACCOUNT, txs: auditTxs("97bd4a1e"), nowNs: NOW });

  it("counts the incoming mt_transfer as the credit, from the wallet that sent it", () => {
    expect(report.deposits).toEqual([
      {
        status: "proven",
        tx: "BAx5vqz2KzoExReTgPCxKNvmxjvejMpfEYizo317zr3C",
        timestampNs: expect.any(BigInt),
        height: 218850260,
        token: WNEAR,
        amount: "468644188628436835253080000",
        via: "transfer",
        from: "akb5911.near",
      },
    ]);
  });

  it("is settled by the transfer of the swapped USDT back to that wallet, with no history gap", () => {
    expect(report.verdict).toBe("settled");
    expect(report.balances).toEqual({});
    expect(report.flags).toEqual([]);
    expect(report.payout).toMatchObject({ status: "arrived", destination: "akb5911.near", amount: "2380462381" });
    expect(report.swaps).toMatchObject([{ got: { [USDT]: "2380462381" }, referral: "1click-near-mobile" }]);
    expect(report.origin).toMatchObject({ status: "unverified", how: "funded by a transfer inside NEAR Intents from akb5911.near" });
  });

  it("a second NEAR Mobile order (NPRO to wNEAR) is settled the same way", () => {
    const other = traceOrder({ account: "ecc97a0dab7eaf984156f36539e9ae3f3a9075060dae1b6445b12cee43032834", txs: auditTxs("ecc97a0d"), nowNs: NOW });
    expect(other.deposits).toMatchObject([{ token: "nep141:npro.nearmobile.near", amount: "11805837897333958672850000", via: "transfer", from: "03c478bd5324e135c885ae206bfd9645bcc694096ba8140ab54c644d5843f8ff" }]);
    expect(other.verdict).toBe("settled");
    expect(other.flags).toEqual([]);
    expect(other.payout).toMatchObject({ status: "arrived", destination: "03c478bd5324e135c885ae206bfd9645bcc694096ba8140ab54c644d5843f8ff", amount: "938779404030369824187365" });
  });
});

describe("a leftover swept out of the order account by a direct mt_batch_transfer (order 38f7db08…)", () => {
  const ACCOUNT = "38f7db08ab47b93f5a81c67f1409197051dc3a54cc73aa4c64977e8826ca265e";
  const SOL_USDT = "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
  const report = traceOrder({ account: ACCOUNT, txs: auditTxs("38f7db08"), nowNs: NOW });

  it("debits the swept tokens as a transfer out, so the balance is the RPC balance (1300)", () => {
    expect(report.transfers).toMatchObject([{ tx: "8Szzq4DMjNaQVz3n5pBeqyZC984jjya21Zm6ipCY55SK", to: "a8b8bab0e77a64f4f15a7db00c7a2cd30aa8f8dbe5b7c22896c0400640018f3a", tokens: { [SOL_USDT]: "103424" } }]);
    expect(report.balances).toEqual({ [SOL_USDT]: "1300" });
  });
});

describe("HOT bridge withdrawals to TON and Stellar", () => {
  it("native TON (`1117_`, no address after the underscore) routes through HOT to TON, the receiver in TON's own form", () => {
    expect(tokenRoute("nep245:v2_1.omni.hot.tg:1117_")).toEqual({ chain: "ton", bridge: "hot" });
    const report = traceOrder({ account: "1349171342fcec7536c9f5f54c3e1a1a248e94104267cb186316b5b8964d0f9c", txs: auditTxs("13491713"), nowNs: NOW });
    // HOT's bridge indexer names the same receiver for this withdrawal (near_trx Gaz2BLXF…).
    expect(report.withdrawals).toMatchObject([{ token: "nep245:v2_1.omni.hot.tg:1117_", amount: "9378457613", chain: "ton", bridge: "hot", destination: "UQC_4kYeH5qQnIjtB6t9ivTyNKLAC5pq-LFfr-iKZn_vPecm" }]);
    expect(report.payout).toMatchObject({ status: "unverified", chain: "ton", bridge: "hot", destination: "UQC_4kYeH5qQnIjtB6t9ivTyNKLAC5pq-LFfr-iKZn_vPecm" });
  });

  it("a second native TON payout (intents.tg) reads the same way", () => {
    const report = traceOrder({ account: "3d513a51dbe024ab8142c8caca9b98f52248238cd71d3a06116df1076312f919", txs: auditTxs("3d513a51"), nowNs: NOW });
    expect(report.withdrawals).toMatchObject([{ chain: "ton", bridge: "hot", destination: "UQB-3gn8kN1Y9DDX4bznsE3mPKh0A5IhcuZWlmea2huA4QUA" }]);
  });

  it("Stellar: the XLM gas leg (msg.amount_native) is not a withdrawal of its own, and the receiver is a G… address", () => {
    const report = traceOrder({ account: "2f8aff68d7606ead07d96102dc1e6bc2f82557100d5960c8a5ea300bbbc738dc", txs: auditTxs("2f8aff68"), nowNs: NOW });
    // HOT's bridge indexer: withdraw_token CCW67TSZ… (USDC on Stellar), receiver GC5VFZAI…, amount 16608561.
    expect(report.withdrawals).toEqual([
      expect.objectContaining({ token: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu", amount: "16608561", chain: "stellar", bridge: "hot", destination: "GC5VFZAIWBHRZZWCW6YEBBAZDIKLCOHTPB6AQ7YXDUAHENZ3V6FO7EYT" }),
    ]);
    expect(report.verdict).toBe("settled");
  });
});

describe("withdrawals paid to a NEAR account, of tokens whose contract is not *.near or that live on another chain", () => {
  const cases: [string, string, string, string, string][] = [
    // [fixture, account, token, amount, NEAR receiver]
    ["038bcc75", "038bcc75cbe96863094918c63c2cf0493e94e58dd30774d7247c05be212ed559", "nep141:token.sweat", "56178536377862279012", "a6768b15401bae46bc7a4737090d18a76a43b52e1cd2e0b321c14fa7eacf3f40"],
    ["0969f61f", "0969f61f8c6f40283c515b28112494811ba99a06c55fb68f15dd8ceeccd42e3e", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "310211033", "74cb2f079f8da84087f715ae45592741028171f0997154a024508743d97e8ead"],
    ["fa98289b", "fa98289b5f135dd33c9f95cab826b94187d0f8d7aeec3a3eba9607c9a970760d", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "28798710865", "becf915c5fc69a435f8fc0155ac04d299887c15adf35f76c951191a8d0e1437d"],
    ["38e7e63b", "38e7e63b1f1209582f96662754713c446e187d27c6eaae66ba139be8a94fd0a6", "nep141:zec.omft.near", "12928058", "hideon.near"],
    ["07c1ba27", "07c1ba271749e7fc6ea51d809230dd6c8fe8db1d76c509aef3f483a64c3e6f19", "nep141:zec.omft.near", "53835257", "2c4f7ae147d9ccf84ff5fe53d0eed63faf459b3d935046031843683abfadeaf9"],
  ];
  it.each(cases)("%s: routed to NEAR by its receiver, and the payout proven by the token's ft_transfer", (prefix, account, token, amount, receiver) => {
    const report = traceOrder({ account, txs: auditTxs(prefix), nowNs: NOW });
    expect(report.withdrawals.at(-1)).toMatchObject({ token, amount, chain: "near", bridge: "near", destination: receiver });
    expect(report.payout).toMatchObject({ status: "arrived", how: "proven", chain: "near", bridge: "near", destination: receiver, amount });
  });

  it("a NEAR-native token whose contract is not *.near lives on NEAR", () => {
    expect(tokenRoute("nep141:token.sweat")).toEqual({ chain: "near", bridge: "near" });
    expect(tokenRoute("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1")).toEqual({ chain: "near", bridge: "near" });
  });
});

describe("a native NEAR payout (native_withdraw), paid by a Transfer action receipt (order 373dde4d…)", () => {
  const ACCOUNT = "373dde4de823895a57e957954abbe1579394f35b43fd4a40b0153db8970a49a4";
  const DEST = "4c94f4800bb5890e6e9804fd2aaa83972b0f53a0f953ec83e2fb26332d8efc6b";
  const txs = auditTxs("373dde4d");

  it("decodes the receipts' Transfer actions, gas refunds from `system` left out", () => {
    const tx = txs.find((t) => t.hash === "71CxKXGrdd8VohL2adLciuermw7H6FsMSHvMYpvC75rw");
    expect(tx?.nativeTransfers).toEqual([
      { from: "wrap.near", to: "intents.near", deposit: "90000000000000000000001", failed: false, receipt: "E3Q7chXkieM5eTSrXPAsNujqz8PoQJ9ECcZUa8kr8CRe" },
      { from: "intents.near", to: DEST, deposit: "90000000000000000000000", failed: false, receipt: "7MvLmnEM4prSrR6qEo6Dg5usuGMbUBrA35Rb4EsimZA" },
    ]);
  });

  it("proves the payout from the successful transfer of the withdrawn amount to the receiver", () => {
    const report = traceOrder({ account: ACCOUNT, txs, nowNs: NOW });
    expect(report.payout).toEqual({ status: "arrived", how: "proven", chain: "near", bridge: "near", destination: DEST, tx: "71CxKXGrdd8VohL2adLciuermw7H6FsMSHvMYpvC75rw", amount: "90000000000000000000000", delaySec: 0, confirmed: true });
  });
});

describe("dust left in the order account after the payout", () => {
  // Thresholds for 5 US cents at the 1Click token list's prices of 2026-10-14 (ETH 2501.41, USDT 0.999353).
  const dustBelow = { "nep141:base.omft.near": "19988726358333", "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": "50032" };

  it("a SWEAT-app micro order that left 1.3e-8 ETH is settled, the remainder named as dust (order 1dc2887e…)", () => {
    const report = traceOrder({ account: "1dc2887e846e7c24952efb0ded767aa8a851198f0a89a35db4d860e7efb376a5", txs: auditTxs("1dc2887e"), nowNs: NOW, params: { dustBelow } });
    expect(report.verdict).toBe("settled");
    expect(report.balances).toEqual({ "nep141:base.omft.near": "13294652443" });
    expect(report.flags.map((f) => f.kind)).toEqual(["dust"]);
  });

  it("a refund that left 0.0013 USDT behind is refunded, not stuck (order 38f7db08…)", () => {
    const report = traceOrder({ account: "38f7db08ab47b93f5a81c67f1409197051dc3a54cc73aa4c64977e8826ca265e", txs: auditTxs("38f7db08"), nowNs: NOW, params: { dustBelow } });
    expect(report.verdict).toBe("refunded");
    expect(report.flags.map((f) => f.kind)).toEqual(["refunded", "dust"]);
  });

  it("without prices nothing is called dust", () => {
    const report = traceOrder({ account: "1dc2887e846e7c24952efb0ded767aa8a851198f0a89a35db4d860e7efb376a5", txs: auditTxs("1dc2887e"), nowNs: NOW });
    expect(report.verdict).toBe("stuck");
  });

  it("an amount at or above the threshold is not dust", () => {
    const report = traceOrder({ account: "1dc2887e846e7c24952efb0ded767aa8a851198f0a89a35db4d860e7efb376a5", txs: auditTxs("1dc2887e"), nowNs: NOW, params: { dustBelow: { "nep141:base.omft.near": "13294652443" } } });
    expect(report.verdict).toBe("stuck");
  });
});

describe("dustThresholds", () => {
  it("is the raw amount worth 5 US cents at each listed price, skipping tokens without a price", () => {
    expect(
      dustThresholds([
        { assetId: "nep141:base.omft.near", decimals: 18, price: 2501.41 },
        { assetId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", decimals: 6, price: 0.999353 },
        { assetId: "nep141:token.sweat", decimals: 18, price: 8.458e-5 },
        { assetId: "nep141:unpriced.near", decimals: 18, price: 0 },
      ]),
    ).toEqual({
      "nep141:base.omft.near": "19988726358333",
      "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": "50032",
      "nep141:token.sweat": "591156301726176378880",
    });
  });
});

describe("a shield and unshield round trip through Confidential Intents, then a public withdrawal", () => {
  it("ETH shielded, unshielded and withdrawn to Ethereum is finished, not confidential (order 4de03c74…)", () => {
    const report = traceOrder({ account: "4de03c7449f417669444d7eeb66c0f908237834acdf1f2b5ae8fd6c674696ff1", txs: auditTxs("4de03c74"), nowNs: NOW });
    expect(report.verdict).toBe("refunded");
    expect(report.flags).toContainEqual({ kind: "confidential", detail: "part of the order went through Confidential Intents and came back; the withdrawal after it is public" });
    expect(report.payout).toMatchObject({ chain: "eth", bridge: "poa", destination: "0x75d8716e73585324edf0eebe1945cea2ac3ccdce" });
  });

  it("SOL round trip whose only swap buys the Omni fee in wNEAR: settled, and the SOL withdrawal is the payout, not unused input (order 86cfa1df…)", () => {
    const report = traceOrder({ account: "86cfa1df8b871bbafc02979b97cb304e56fc06c96dba7d5d0bf24d08df9d0957", txs: auditTxs("86cfa1df"), nowNs: NOW });
    expect(report.verdict).toBe("settled");
    expect(report.withdrawals).toHaveLength(1);
    expect(report.withdrawals[0]?.excessRefund).toBeUndefined();
    expect(report.flags.map((f) => f.kind)).toEqual(["confidential"]);
  });
});

describe("origins the deposit transaction shows only in its receipts", () => {
  const firstTx = (prefix: string): TxRecord => {
    const txs = auditTxs(prefix).sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    if (!txs[0]) throw new Error("empty fixture");
    return txs[0];
  };

  it("a NEAR deposit relayed as a meta-transaction (bridge-mng.near): the sender is the account that called ft_transfer_call", () => {
    expect(originOf(firstTx("3db0c7fb"))).toEqual({
      status: "proven",
      kind: "near-native",
      chain: "near:mainnet",
      txHash: "AAnz33mBUYyFKgWKX4qpmhmB7PCw7yTEuX2mo1CQJpiL",
      sender: "c034841ed5933e7e2a1e8abb479f087c1824dfe1f0aac51493f03fc694d9b91a",
      how: "ft_transfer_call to intents.near, relayed by bridge-mng.near",
    });
  });

  it("the SWEAT app's relayer (sweat-relayer.near) the same way", () => {
    expect(originOf(firstTx("038bcc75"))).toMatchObject({ kind: "near-native", sender: "a6768b15401bae46bc7a4737090d18a76a43b52e1cd2e0b321c14fa7eacf3f40", how: "ft_transfer_call to intents.near, relayed by sweat-relayer.near" });
  });

  it("a HOT bridge deposit (mt_deposit_call) names its chain and HOT's deposit nonce", () => {
    expect(originOf(firstTx("2230e772"))).toEqual({ status: "proven", kind: "hot", chain: "ton", originNonce: "1791795150000000127427", how: "mt_deposit_call on the HOT bridge, signed by HOT for chain 1117" });
    expect(originOf(firstTx("97bb8cac"))).toMatchObject({ kind: "hot", chain: "pol", originNonce: "1791925179000000274706" });
  });
});

describe("the same token in and out to another chain is a cross-chain move, not a refund", () => {
  it("ZEC deposited from Solana and withdrawn to a shielded Zcash address is settled (order 269868c0…)", () => {
    const report = traceOrder({ account: "269868c03cfa5e2620dd85720c48503330d1bbb5f6d39d40d18a6b035f341da1", txs: auditTxs("269868c0"), nowNs: NOW });
    expect(report.verdict).toBe("settled");
    expect(report.flags).toEqual([]);
  });

  it("wNEAR from NEAR to Hyperliquid core (Omni hlevm with DestHexMsg \"core\") is settled, chain hypercore (order 3db0c7fb…)", () => {
    const report = traceOrder({ account: "3db0c7fb8c887a95ba781440615232fbcd5d6a1fff0185bd65639a38741e78dc", txs: auditTxs("3db0c7fb"), nowNs: NOW });
    expect(report.verdict).toBe("settled");
    expect(report.withdrawals[0]).toMatchObject({ chain: "hypercore", bridge: "omni", destination: "hlevm:0x8E3d5e109837c11DDd373d97c9B3E4D716F1423A" });
  });

  it("back to the chain it came from is still a refund (order 38f7db08…: USDT from Solana, back to Solana)", () => {
    const report = traceOrder({ account: "38f7db08ab47b93f5a81c67f1409197051dc3a54cc73aa4c64977e8826ca265e", txs: auditTxs("38f7db08"), nowNs: NOW });
    expect(report.flags.map((f) => f.kind)).toContain("refunded");
  });
});

// Thresholds for 5 US cents: an account's history is split into separate orders only where the later credit is
// known to be worth more than dust; without prices a later credit stays part of the order before it.
const PRICED = {
  dustBelow: {
    "nep141:sol.omft.near": "333333",
    "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": "50000",
    "nep141:eth.omft.near": "20000000000000",
  },
};

describe("a deposit sent to a finished order's account (f980556a…: 0.08 SOL shielded, then 1.85 SOL sent again)", () => {
  const ACCOUNT = "f980556a4cb3468298672e9da9da35995c5d35cc2d86cc4f31609a2a4a1aff9b";

  it("pasted as an account, the report follows the later deposit: stuck, and only 1Click can move it", () => {
    const report = traceOrder({ account: ACCOUNT, txs: auditTxs("f980556a"), nowNs: NOW, params: PRICED });
    expect(report.verdict).toBe("stuck");
    expect(report.deposits).toMatchObject([{ tx: "4vJ1EvfGmj9Nh2YVquZ19JknsZFS7jBMGhahhqBjUpz7", amount: "1852403840" }]);
    expect(report.balances).toEqual({ "nep141:sol.omft.near": "1852403840" });
    expect(report.flags.map((f) => f.kind)).toEqual(["several_orders", "stalled"]);
    const c = whoCanMove(report);
    expect(c).toMatchObject({ place: "order_account", needsHelp: true });
    expect(c.canMove).toBe("Only 1Click. It holds this order account's key: not you, not the app you swapped in, and not us.");
  });

  it("with the first order's transaction, it follows the confidential swap", () => {
    const report = traceOrder({ account: ACCOUNT, txs: auditTxs("f980556a"), nowNs: NOW, params: PRICED, focusTx: "CYGegw51rj3gtzRrperPM1iUdv861tTFKVtjD7TnbCaj" });
    expect(report.verdict).toBe("confidential");
    expect(report.flags).toContainEqual({
      kind: "several_orders",
      count: 2,
      shown: 1,
      detail: "this account received 2 separate deposits, each finished before the next arrived; this report follows the one with the transaction you gave (1 of 2). Paste another one's NEAR transaction to see it.",
    });
  });

  it("without prices the later credit stays part of the order before it, named as a later deposit", () => {
    const report = traceOrder({ account: ACCOUNT, txs: auditTxs("f980556a"), nowNs: NOW });
    expect(report.verdict).toBe("confidential");
    expect(report.flags.map((f) => f.kind)).toEqual(["confidential", "later_deposit"]);
  });

  it("a later credit worth less than 5 US cents is dust left with the order, not an order of its own", () => {
    const report = traceOrder({ account: ACCOUNT, txs: auditTxs("f980556a"), nowNs: NOW, params: { dustBelow: { "nep141:sol.omft.near": "1852403841" } } });
    expect(report.verdict).toBe("confidential");
    expect(report.flags.map((f) => f.kind)).toEqual(["confidential", "dust"]);
  });
});

describe("an account with several separate orders (62f55aaa…: two USDT deposits from TRON a day apart, each sent on by a transfer)", () => {
  const ACCOUNT = "62f55aaa5b8879f8fe78e209270b62eaf179500b19c6e59017fc37007d5cf1a3";

  it("pasted as an account, the report follows the latest order and says there are two", () => {
    const report = traceOrder({ account: ACCOUNT, txs: auditTxs("62f55aaa"), nowNs: NOW, params: PRICED });
    expect(report.deposits).toMatchObject([{ tx: "Buh2WGtUmBcYET98anQ6CUjEhviuajrWd4kAVFwdGetZ", amount: "10500000" }]);
    expect(report.payout).toMatchObject({ status: "arrived", destination: "f46d044760548bad7ae11fd42d9a4f86e5a308c6dd024a6a88675c01bb953672" });
    expect(report.flags[0]).toEqual({
      kind: "several_orders",
      count: 2,
      shown: 2,
      detail: "this account received 2 separate deposits, each finished before the next arrived; this report follows the latest (2 of 2). Paste another one's NEAR transaction to see it.",
    });
  });

  it("with the first order's transaction, it follows that one and its own payout", () => {
    const report = traceOrder({ account: ACCOUNT, txs: auditTxs("62f55aaa"), nowNs: NOW, params: PRICED, focusTx: "HBaDdSdy4pa8wrmJ6J3sW8MJCXA4PmjDKwjawVw8E7FU" });
    expect(report.deposits).toMatchObject([{ tx: "HrHkph6YoTSQ29VP4W8JUhGyL43ZJb6pgaxnAjDGKLLK", amount: "9740000" }]);
    expect(report.payout).toMatchObject({ status: "arrived", destination: "ccbcc365b7cd1f563c612957e81c1ba437bb4a0a41464f0900cb18337f264abc" });
  });

  it("a confidential round trip is one order, not two (4de03c74…)", () => {
    const report = traceOrder({ account: "4de03c7449f417669444d7eeb66c0f908237834acdf1f2b5ae8fd6c674696ff1", txs: auditTxs("4de03c74"), nowNs: NOW, params: PRICED });
    expect(report.flags.map((f) => f.kind)).not.toContain("several_orders");
    expect(report.deposits).toHaveLength(2);
  });
});

describe("an account that signs its own transactions (94a9339a…: NPRO sent from its own wallet, traded by transfers)", () => {
  const ACCOUNT = "94a9339a79aca648a7e066d0c2b25e4ca94676091b08948acee78674947049da";
  const report = traceOrder({ account: ACCOUNT, txs: auditTxs("94a9339a"), nowNs: NOW });

  it("is flagged as held by its owner", () => {
    expect(report.flags).toContainEqual({ kind: "own_key", detail: "this account signs its own transactions, so its owner holds its key: it is not a 1Click order account" });
  });

  it("custody says its owner can move it, with no support message", () => {
    const c = whoCanMove(report);
    expect(c.canMove).toBe("Whoever holds this account's key: it signs its own transactions, so it is not a 1Click order account.");
    expect(c.needsHelp).toBe(false);
  });
});

describe("findOrderAccount on transactions the audit resolved wrongly", () => {
  const find = (prefix: string, hash: string): string | null => {
    const tx = auditTxs(prefix).find((t) => t.hash === hash);
    if (!tx) throw new Error(`${hash} is not in the ${prefix} fixture`);
    return findOrderAccount(tx);
  };
  it.each([
    // A solver's Ref round trip mints to solver-ref.near (memo "deposit") in the same batch as the user's swap.
    ["ecc97a0d", "5B2FYMDQfSnLd1Ahv4pZWRdDxaYBa3Qi9iLNENW8LiP7", "ecc97a0dab7eaf984156f36539e9ae3f3a9075060dae1b6445b12cee43032834"],
    ["3d513a51", "D8GM6RVXFfH52APLpWPUKzk1XFPBxFvcJ2osTKcp1sm2", "3d513a51dbe024ab8142c8caca9b98f52248238cd71d3a06116df1076312f919"],
    // Transfer-only: the order is the account being funded (unshielded from the treasury, sent by a wallet)...
    ["78736d9a", "FmHEbcxyTQeMsS11svih1VSGU1LbzEYugBJH3xtZu7nv", "78736d9a15af72621df81571c1cfb3c8dbfac36017135bd25d2eabe3f438667c"],
    ["2f8aff68", "FdQ48hDk9neSQPnGyXByod3udkkALnmqpPfi97ejawUA", "2f8aff68d7606ead07d96102dc1e6bc2f82557100d5960c8a5ea300bbbc738dc"],
    ["97bd4a1e", "BAx5vqz2KzoExReTgPCxKNvmxjvejMpfEYizo317zr3C", "97bd4a1e1a35bd5df58f222417026bbd574b8d0d30038c17f11c90900099f734"],
    ["ecc97a0d", "361h55w1ihRPipT6ZFoffCf7mEG8gHT1n1P83UzQtM7a", "ecc97a0dab7eaf984156f36539e9ae3f3a9075060dae1b6445b12cee43032834"],
    // ...or, when it pays a documented account (shielding into the treasury), the account paying.
    ["4de03c74", "B5rF6tWwi6ZPCXbPrUbZgqLcZExW9Cvx3k4g6arTWkdv", "4de03c7449f417669444d7eeb66c0f908237834acdf1f2b5ae8fd6c674696ff1"],
  ])("%s: %s belongs to %s", (prefix, hash, account) => {
    expect(find(prefix, hash)).toBe(account);
  });

  it("a bridge deposit still resolves to the credited account", () => {
    expect(find("4de03c74", "3W86XWv5Wq4qXAd7DsMwxe4EDaanNQtr4kXFhjH5UCka")).toBe("4de03c7449f417669444d7eeb66c0f908237834acdf1f2b5ae8fd6c674696ff1");
  });
});

describe("decodeFastnearTx: receipt actions carry whether their receipt failed", () => {
  it("marks a failed receipt's actions", () => {
    const raw = {
      transaction: { hash: "H", signer_id: "intents.near", receiver_id: "intents.near", actions: [] },
      execution_outcome: { block_hash: "B", block_height: 1, block_timestamp: "1", outcome: { executor_id: "intents.near", logs: [], status: { SuccessReceiptId: "R" } } },
      receipts: [
        {
          execution_outcome: { block_height: 2, block_timestamp: "2", outcome: { executor_id: "sol.omft.near", logs: [], status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked" } } } } } } },
          receipt: { predecessor_id: "intents.near", receiver_id: "sol.omft.near", receipt: { Action: { signer_id: "intents.near", actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: btoa('{"receiver_id":"omni.bridge.near"}'), gas: 1, deposit: "1" } }] } } },
        },
      ],
    };
    expect(decodeFastnearTx(raw).receiptActions).toEqual([{ method: "ft_transfer_call", args: { receiver_id: "omni.bridge.near" }, executor: "sol.omft.near", failed: true }]);
  });
});
