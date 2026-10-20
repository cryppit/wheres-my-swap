import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CheckResult } from "./check.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./core/fastnear.js";
import { traceOrder } from "./core/trace.js";
import { renderText } from "./render-text.js";

const ACCOUNT_358 = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
const records = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-txs-358.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
const result: CheckResult = { ...traceOrder({ account: ACCOUNT_358, txs: records, nowNs: 1791_000_000_000_000_000n }), resolvedFrom: { kind: "account", account: ACCOUNT_358 }, resolvedVia: "account", txCount: 2 };

describe("renderText", () => {
  const text = renderText(result);

  it("states the verdict and every hop with how it is known", () => {
    expect(text).toContain("Verdict        SETTLED");
    expect(text).toContain("1 Origin       proven   tron:mainnet  d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67");
    expect(text).toContain("2 Credit       proven   575830000000 tron.omft.near  at 2026-09-11 16:27:04 UTC");
    expect(text).toContain("4 Withdrawal   proven   190995593894 eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near -> eth 0x632F5D32448DE43b8b9cfD063aCfcDac09108bad");
    expect(text).toContain("5 Payout       unverified");
  });

  it("names the closest 1Click status", () => {
    expect(text).toContain("1Click would say SUCCESS");
  });

  it("names documented accounts and the confidential verdict", () => {
    const conf: CheckResult = { ...result, verdict: "confidential", oneClickStatus: "PROCESSING", transfers: [{ tx: "T", timestampNs: null, height: null, to: "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe", toLabel: "Confidential Intents treasury", tokens: { "nep141:eth.omft.near": "1" } }], flags: [{ kind: "confidential", detail: "funds moved into Confidential Intents; later legs are not visible on public NEAR" }] };
    const out = renderText(conf);
    expect(out).toContain("Verdict        CONFIDENTIAL");
    expect(out).toContain("(Confidential Intents treasury)");
    expect(out).toContain("FLAG confidential   funds moved into Confidential Intents");
    // 1Click reports SUCCESS once the private leg delivers, which public NEAR does not show.
    expect(out).toContain("1Click would say PROCESSING, or SUCCESS once the private leg has delivered");
  });

  it("lists the flags in plain words", () => {
    expect(text).toContain("FLAG settled late  16 days from credit to the first intent");
    expect(text).toContain("Still in the order account: nothing");
  });
});

describe("renderText: where the money is", () => {
  it("says where the money is, who can move it, and what to do", () => {
    const stuck: CheckResult = { ...result, verdict: "stuck", withdrawals: [], balances: { "nep141:tron.omft.near": "575830000000" }, flags: [{ kind: "stalled", waitedSec: 86_400, detail: "credited, nothing since" }] };
    const text = renderText(stuck);
    expect(text).toContain(`Where it is    It is in the order account ${ACCOUNT_358} on NEAR Intents (intents.near): 575830000000 nep141:tron.omft.near.`);
    expect(text).toContain("Who can move   Only 1Click.");
    expect(text).toContain("What to do     Send the support message below");
    expect(text).toContain("Support message (copy and send):");
    expect(text).toContain(`Order account: ${ACCOUNT_358}`);
  });

  it("a locked order account: the lock flag with how long it has held, and the operators as the only ones who can move it", () => {
    const locked: CheckResult = { ...result, verdict: "stuck", withdrawals: [], balances: { "nep141:tron.omft.near": "575830000000" }, flags: [{ kind: "locked", tx: "LCK", waitedSec: 180 * 86_400, detail: "intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it" }] };
    const text = renderText(locked);
    expect(text).toContain("FLAG locked        intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it (180 days)");
    expect(text).toContain("Who can move   Only the NEAR Intents operators, who run intents.near");
    expect(text).toContain("Could you please escalate this to NEAR Intents?");
  });

  it("no support message when nothing needs chasing", () => {
    expect(renderText({ ...result, verdict: "in_progress", withdrawals: [], balances: { "nep141:tron.omft.near": "1" }, flags: [] })).not.toContain("Support message");
  });
});

describe("renderText: the payout hop", () => {
  const base = { chain: "eth", bridge: "poa" as const, destination: "0x63" };
  it("names the payout transaction and how it was found", () => {
    const text = renderText({ ...result, payout: { status: "arrived", how: "matched", ...base, tx: "0xpay", amount: "1", delaySec: 40, confirmed: true } });
    expect(text).toContain("5 Payout       matched  eth 0x63  tx 0xpay  40 s after the withdrawal (amount and time)");
  });
  it("a payout the bridge names is confirmed, with who sent it", () => {
    const text = renderText({ ...result, payout: { status: "arrived", how: "confirmed", ...base, tx: "0xpay", amount: "1", delaySec: 40, confirmed: true, sender: { address: "0x2CfF890f0378a11913B6129B2E97417a2c302680", treasury: "NEAR Intents" }, bridgeReport: { status: "COMPLETED", tx: "0xpay" } } });
    expect(text).toContain("5 Payout       confirmed  eth 0x63  tx 0xpay  40 s after the withdrawal (named by the bridge)");
    expect(text).toContain("               Sent from 0x2CfF890f0378a11913B6129B2E97417a2c302680, NEAR Intents' published treasury wallet.");
  });
  it("says not found, and flags it", () => {
    const text = renderText({ ...result, payout: { status: "not_found", ...base, waitedSec: 7_200 }, flags: [{ kind: "payout_not_found", waitedSec: 7_200, detail: "no transfer reached it" }] });
    expect(text).toContain("5 Payout       NOT FOUND  eth 0x63  nothing arrived in 2 h");
    expect(text).toContain("FLAG payout not found  no transfer reached it (2 h)");
  });
});

describe("renderText: an order found from the user's own transaction", () => {
  it("says which transaction and which NEAR deposit led to the order", () => {
    const text = renderText({ ...result, resolvedVia: "origin", foundBy: { chain: "tron", originTx: "d9b9", depositTx: "8a33" } });
    expect(text).toContain("Found from     your TRON transaction d9b9, through the NEAR deposit 8a33 that names it");
  });
  it("an Omni BTC deposit is found through the bridge's record of the address it paid", () => {
    const text = renderText({ ...result, resolvedVia: "origin", foundBy: { chain: "btc", originTx: "82d0" } });
    expect(text).toContain("Found from     your Bitcoin transaction 82d0, through the Omni bridge's record of the deposit address it paid");
  });
  it("a Solana deposit found in the Omni bridge's records, and the NEAR transaction that credited it", () => {
    expect(renderText({ ...result, resolvedVia: "origin", foundBy: { chain: "sol", originTx: "4UXu", depositTx: "4x2d", via: "omni" } })).toContain(
      "Found from     your Solana transaction 4UXu, through the Omni bridge's record of it, credited on NEAR in 4x2d",
    );
    expect(renderText({ ...result, resolvedVia: "origin", foundBy: { chain: "sol", originTx: "4UXu", via: "omni" } })).toContain("through the Omni bridge's record of it, not credited on NEAR yet");
  });
});

describe("renderText: a withdrawal that failed and came back", () => {
  const w = result.withdrawals[0];
  if (!w) throw new Error("fixture lacks the withdrawal");
  const back: CheckResult = {
    ...result,
    verdict: "stuck",
    withdrawals: [{ ...w, returned: w.amount }],
    payout: { status: "missing" },
    balances: { [w.token]: w.amount },
    flags: [{ kind: "withdrawal_returned", detail: "a withdrawal failed and its tokens came back to the order account" }],
  };
  const text = renderText(back);

  it("marks the withdrawal returned and flags it", () => {
    expect(text).toMatch(/4 Withdrawal {3}proven .* RETURNED: the transfer out failed and .* came back/);
    expect(text).toContain("FLAG withdrawal returned  a withdrawal failed and its tokens came back to the order account");
  });
});

describe("renderText: a NEAR payout that bounced (DERIVED from order 373dde4d…)", () => {
  // fixtures/derived/…: the recorded order with its native_withdraw sent to a named account nobody created (see its _derived note).
  const account = "373dde4de823895a57e957954abbe1579394f35b43fd4a40b0153db8970a49a4";
  const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/derived/373dde4d-native-payout-bounced.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const text = renderText({ ...traceOrder({ account, txs, nowNs: 1_792_000_000_000_000_000n }), resolvedFrom: { kind: "account", account }, resolvedVia: "account", txCount: txs.length });

  it("marks the withdrawal bounced, says nothing was paid out, flags it and asks for help", () => {
    expect(text).toContain("Verdict        STUCK");
    expect(text).toMatch(/4 Withdrawal {3}proven {3}90000000000000000000000 wrap\.near -> near nobody-made-this\.near .* BOUNCED: that account does not exist; NEAR returned it to intents\.near/);
    expect(text).toContain("5 Payout       missing  nothing was paid out: the withdrawal did not reach its destination");
    expect(text).toContain("FLAG payout bounced  NEAR could not deliver the payout to nobody-made-this.near (that account does not exist)");
    expect(text).toContain("Where it is    NEAR could not deliver 90000000000000000000000 nep141:wrap.near to nobody-made-this.near (that account does not exist)");
    expect(text).toContain("Support message (copy and send):");
  });
});

describe("renderText: a payout into a Zcash shielded pool", () => {
  it("labels it shielded and named by the bridge", () => {
    const text = renderText({ ...result, payout: { status: "arrived", how: "shielded", chain: "zec", bridge: "omni", destination: "zcash:u1jfupn9", tx: "064ff3c0", amount: "55133859", delaySec: 93, confirmed: true, shieldedPool: "Ironwood" } });
    expect(text).toContain("5 Payout       shielded  zec zcash:u1jfupn9  tx 064ff3c0  2 min after the withdrawal (named by the bridge, into the Ironwood pool)");
  });
});

describe("renderText: a credit transferred in inside NEAR Intents", () => {
  it("says where it came from (order d44643b6…, unshielded from Confidential Intents)", () => {
    const account = "d44643b640ee2117df9904884f7490904a5217bff1446ffa2e5059fcc52fae90";
    const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-unshielded-order.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
    const text = renderText({ ...traceOrder({ account, txs, nowNs: 1_792_000_000_000_000_000n }), resolvedFrom: { kind: "account", account }, resolvedVia: "account", txCount: txs.length });
    expect(text).toMatch(/2 Credit {7}proven {3}153910459 arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831\.omft\.near .*\(transferred in from the Confidential Intents treasury\)/);
  });
});

describe("renderText: a HOT bridge deposit", () => {
  it("names the chain and HOT's deposit nonce", () => {
    const account = "2230e7729bd469fd8f06a8b3aceadc427b44c0ac754207c89ffd302f84e64a41";
    const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/2230e772.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
    const text = renderText({ ...traceOrder({ account, txs, nowNs: 1_792_000_000_000_000_000n }), resolvedFrom: { kind: "account", account }, resolvedVia: "account", txCount: txs.length });
    expect(text).toContain("1 Origin       proven   ton  nonce 1791795150000000127427  (mt_deposit_call on the HOT bridge, signed by HOT for chain 1117)");
  });
});

describe("renderText: an order paid out by a transfer inside NEAR Intents (97bd4a1e…, NEAR Mobile)", () => {
  it("marks the paying transfer", () => {
    const account = "97bd4a1e1a35bd5df58f222417026bbd574b8d0d30038c17f11c90900099f734";
    const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/97bd4a1e.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
    const text = renderText({ ...traceOrder({ account, txs, nowNs: 1_792_000_000_000_000_000n }), resolvedFrom: { kind: "account", account }, resolvedVia: "account", txCount: txs.length });
    expect(text).toMatch(/Transfer {5}proven {3}2380462381 usdt\.tether-token\.near -> akb5911\.near .*\(the payout\)/);
    expect(text).toContain("5 Payout       proven  near akb5911.near  tx 61qvaRyvoxxK8DfqDpf7Vk4sCqYXw85nfmm6js8NYEbp  inside NEAR Intents");
  });
});

describe("renderText: a transaction still executing", () => {
  it("flags it and says nothing is final yet, with no support message", () => {
    const text = renderText({ ...result, verdict: "in_progress", flags: [{ kind: "executing", tx: "E887", detail: "NEAR is still executing transaction E887 (3 of its steps have not run yet): this is not final, check again in a minute" }] });
    expect(text).toContain("FLAG executing     NEAR is still executing transaction E887 (3 of its steps have not run yet): this is not final, check again in a minute");
    expect(text).toContain("Where it is    NEAR is still executing this order's transaction E887, so where the money ends up is not final yet.");
    expect(text).not.toContain("Support message");
  });
});

describe("renderText: a payout to a name nobody has created", () => {
  it("flags it", () => {
    const text = renderText({ ...result, flags: [{ kind: "destination_missing", account: "hideon.near", detail: "no NEAR account is named hideon.near yet" }] });
    expect(text).toContain("FLAG no such account  no NEAR account is named hideon.near yet");
  });
});

describe("renderText: the balance checked against intents.near", () => {
  const BLOCK = "8LvS9PHrRdffJp2SosWPUDXLH7pcmgEw4EwkewG74xo2";
  it("verified, different, or not checked", () => {
    expect(renderText({ ...result, balanceCheck: { status: "verified", blockHeight: 219_921_623, blockHash: BLOCK } })).toContain(`Checked against intents.near at block 219,921,623 (${BLOCK}): it holds the same for this account.`);
    expect(renderText({ ...result, balanceCheck: { status: "differs", blockHeight: 219_921_623, blockHash: BLOCK, differences: [{ token: "nep141:tron.omft.near", ledger: "0", chain: "5" }] } })).toContain(`Checked against intents.near at block 219,921,623 (${BLOCK}): it holds 5 tron.omft.near for this account, not what the history adds up to (see the flag).`);
    expect(renderText({ ...result, balanceCheck: { status: "not_verified", reason: "NEAR's RPCs did not answer" } })).toContain("Not checked against intents.near: NEAR's RPCs did not answer.");
  });
});

describe("renderText: history read from the backup source", () => {
  it("credits NearBlocks and says what it cannot see", () => {
    const out = renderText({ ...result, historySource: "nearblocks" });
    expect(out).toContain("History from   NearBlocks, because FastNEAR was unavailable. Powered by Nearblocks.io APIs (https://nearblocks.io)");
    expect(out).toContain("NearBlocks lists only transactions that moved this order's tokens: a deposit not credited yet does not show here.");
    expect(renderText(result)).not.toContain("NearBlocks");
  });
});
