import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CheckResult } from "./check.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./core/fastnear.js";
import { traceOrder } from "./core/trace.js";
import { explorerUrl, formatAmount, renderHtml } from "./render-html.js";

const ACCOUNT_358 = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
const records = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-txs-358.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
const result: CheckResult = { ...traceOrder({ account: ACCOUNT_358, txs: records, nowNs: 1791_000_000_000_000_000n }), resolvedFrom: { kind: "account", account: ACCOUNT_358 }, resolvedVia: "account", txCount: 2 };

describe("formatAmount for HOT's tokens (their metadata on v2_1.omni.hot.tg, read 2026-10-17)", () => {
  it("shows the coin and its decimals instead of the raw id", () => {
    expect(formatAmount("nep245:v2_1.omni.hot.tg:1117_", "678060479")).toBe("0.678060479 TON");
    expect(formatAmount("nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr", "2046950201")).toBe("2,046.950201 USDT (Polygon)");
    expect(formatAmount("nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", "99337474623233980402")).toBe("99.337474623233980402 USDT (BNB Chain)");
    expect(formatAmount("nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu", "16608561")).toBe("1.6608561 USDC (Stellar)");
  });
});

describe("explorerUrl", () => {
  it("knows the explorers for the chains NEAR Intents bridges to", () => {
    expect(explorerUrl("tx", "tron:mainnet", "d9b9")).toBe("https://tronscan.org/#/transaction/d9b9");
    expect(explorerUrl("tx", "zcash:mainnet", "6de2")).toBe("https://blockchair.com/zcash/transaction/6de2");
    expect(explorerUrl("tx", "eth:1", "0xab")).toBe("https://etherscan.io/tx/0xab");
    expect(explorerUrl("address", "eth", "0x63")).toBe("https://etherscan.io/address/0x63");
    expect(explorerUrl("address", "base", "0x63")).toBe("https://basescan.org/address/0x63");
    expect(explorerUrl("tx", "btc:mainnet", "f00")).toBe("https://mempool.space/tx/f00");
    expect(explorerUrl("address", "sol", "So1")).toBe("https://solscan.io/account/So1");
    expect(explorerUrl("tx", "near", "E887")).toBe("https://nearblocks.io/txns/E887");
  });
  it("and for the EVM chains HOT, PoA and Omni pay out on (each page checked to load, 2026-10-17)", () => {
    expect(explorerUrl("tx", "monad", "0x9b")).toBe("https://monadscan.com/tx/0x9b");
    expect(explorerUrl("tx", "hood", "0xac")).toBe("https://robinhoodchain.blockscout.com/tx/0xac");
    for (const chain of ["xlayer", "plasma", "scroll", "adi", "abs", "bsc", "pol", "avax", "bera"]) expect(explorerUrl("tx", chain, "0x1"), chain).toMatch(/^https:\/\/.+\/tx\/0x1$/);
  });
  it("drops the chain prefix the Omni bridge puts on addresses, and links no shielded Zcash address (explorers cannot show one)", () => {
    expect(explorerUrl("address", "sol", "sol:Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5")).toBe("https://solscan.io/account/Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5");
    expect(explorerUrl("address", "btc", "btc:bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz")).toBe("https://mempool.space/address/bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz");
    expect(explorerUrl("address", "zec", "zcash:t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua")).toBe("https://blockchair.com/zcash/address/t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua");
    expect(explorerUrl("address", "zec", "zcash:u1jfupn9sjcjfhp3ytfhkxqedyjv8hxq9hz9wdyfpq2x3g3nfc2uwm")).toBeNull();
    expect(explorerUrl("tx", "zec", "064ff3c012168e5a07d797395cc43b1770cc8167cc1ff4ab163871870ecfb6a4")).toBe("https://blockchair.com/zcash/transaction/064ff3c012168e5a07d797395cc43b1770cc8167cc1ff4ab163871870ecfb6a4");
  });

  it("knows Omni's name for BNB Chain (bnb) and HOT's for Monad", () => {
    expect(explorerUrl("tx", "bnb", "0xab")).toBe("https://bscscan.com/tx/0xab");
  });

  it("returns null for a chain it does not know", () => {
    expect(explorerUrl("tx", "kaspa:mainnet", "x")).toBeNull();
  });
});

describe("renderHtml", () => {
  const html = renderHtml(result);

  it("shows the verdict, each hop with its status label, and the flags", () => {
    expect(html).toContain('data-verdict="settled"');
    expect(html).toMatch(/Origin[\s\S]*?class="status proven"/);
    expect(html).toMatch(/Payout[\s\S]*?class="status unverified"/);
    expect(html).toContain("16 days from credit to the first intent");
  });

  it("shows the closest 1Click status and labels documented accounts", () => {
    expect(html).toContain("1Click would say <code>SUCCESS</code>");
    const conf: CheckResult = { ...result, verdict: "confidential", oneClickStatus: "PROCESSING", transfers: [{ tx: "T", timestampNs: null, height: null, to: "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe", toLabel: "Confidential Intents treasury", tokens: { "nep141:eth.omft.near": "1" } }], flags: [{ kind: "confidential", detail: "funds moved into Confidential Intents; later legs are not visible on public NEAR" }] };
    const out = renderHtml(conf);
    expect(out).toContain('data-verdict="confidential"');
    expect(out).toContain("Confidential Intents treasury");
    expect(out).toContain("<b>Confidential</b>");
    expect(out).toContain("1Click would say <code>PROCESSING</code>, or <code>SUCCESS</code> once the private leg has delivered");
  });

  it("links every hop to its explorer", () => {
    expect(html).toContain('href="https://tronscan.org/#/transaction/d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67"');
    expect(html).toContain('href="https://nearblocks.io/txns/E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB"');
    expect(html).toContain('href="https://etherscan.io/address/0x632F5D32448DE43b8b9cfD063aCfcDac09108bad"');
  });

  it("escapes chain data before putting it in the page", () => {
    const hostile: CheckResult = structuredClone(result);
    const w = hostile.withdrawals[0];
    if (!w) throw new Error("fixture has no withdrawal");
    w.destination = '<img src=x onerror="alert(1)">';
    const out = renderHtml(hostile);
    // Our own logo images are fine; the hostile one must only appear escaped.
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("writes amounts in token units, not raw integers, for the tokens it knows", () => {
    expect(html).toContain("575,830 TRX");
    expect(html).toContain("190,995.593894 USDT");
  });
});

describe("renderHtml: where the money is", () => {
  it("a stuck order: the custody answer and a support message to copy", () => {
    const stuck: CheckResult = { ...result, verdict: "stuck", withdrawals: [], balances: { "nep141:tron.omft.near": "575830000000" }, flags: [{ kind: "stalled", waitedSec: 86_400, detail: "credited, nothing since" }] };
    const html = renderHtml(stuck);
    expect(html).toContain('<section class="custody" data-place="order_account">');
    expect(html).toContain("Only 1Click.");
    expect(html).toContain('<textarea class="support" readonly');
    expect(html).toContain("on NEAR Intents (intents.near): 575,830 TRX.");
  });

  it("a locked order account: the lock flag, and the operators as the only ones who can move it", () => {
    const locked: CheckResult = { ...result, verdict: "stuck", withdrawals: [], balances: { "nep141:tron.omft.near": "575830000000" }, flags: [{ kind: "locked", tx: "LCK", waitedSec: 180 * 86_400, detail: "intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it" }] };
    const html = renderHtml(locked);
    expect(html).toContain('<li class="flag locked"><b>Locked</b> intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it (180 days)</li>');
    expect(html).toContain("Only the NEAR Intents operators, who run intents.near");
  });
});

describe("renderHtml: the payout hop", () => {
  const base = { chain: "eth", bridge: "poa" as const, destination: "0x632F5D32448DE43b8b9cfD063aCfcDac09108bad" };
  const withPayout = (payout: CheckResult["payout"], flags: CheckResult["flags"] = result.flags) => renderHtml({ ...result, payout, flags });

  it("an amount-and-time match is labelled matched, with the payout transaction linked", () => {
    const html = withPayout({ status: "arrived", how: "matched", ...base, tx: "0xpay", amount: "1", delaySec: 40, confirmed: true });
    expect(html).toMatch(/Payout[\s\S]*?class="status matched"/);
    expect(html).toContain("https://etherscan.io/tx/0xpay");
    expect(html).toContain("40 s after the withdrawal");
    expect(html).toContain("Matched, not proven");
    expect(html.match(/and time/g)?.length).toBe(1); // said once, not twice
  });
  it("a payout the bridge names is labelled confirmed, with the sender and the bridge's word", () => {
    const html = withPayout({ status: "arrived", how: "confirmed", ...base, tx: "0xpay", amount: "1", delaySec: 40, confirmed: true, sender: { address: "0x2CfF890f0378a11913B6129B2E97417a2c302680", treasury: "NEAR Intents" }, bridgeReport: { status: "COMPLETED", tx: "0xpay" } });
    expect(html).toMatch(/Payout[\s\S]*?class="status confirmed"/);
    expect(html).toContain("Confirmed by the bridge");
    expect(html).toContain("NEAR Intents&#39; published treasury wallet");
  });
  it("a proven NEAR payout is labelled proven", () => {
    expect(withPayout({ status: "arrived", how: "proven", chain: "near", bridge: "near", destination: "alice.near", tx: "W", amount: "1", delaySec: 0, confirmed: true })).toMatch(/Payout[\s\S]*?class="status proven"/);
  });
  it("a payout not found is shown as missing and flagged", () => {
    const html = withPayout({ status: "not_found", ...base, waitedSec: 7_200 }, [{ kind: "payout_not_found", waitedSec: 7_200, detail: "no transfer of about the withdrawn amount reached the destination address" }]);
    expect(html).toMatch(/Payout[\s\S]*?class="status missing"/);
    expect(html).toContain("<b>Payout not found</b> no transfer of about the withdrawn amount reached the destination address (2 h)");
  });
  it("waiting, ambiguous and unverified say what they mean", () => {
    expect(withPayout({ status: "waiting", ...base, waitedSec: 120 })).toContain("Not seen yet");
    expect(withPayout({ status: "ambiguous", ...base, txs: ["0xa", "0xb"] })).toContain("https://etherscan.io/tx/0xb");
    expect(withPayout({ status: "unverified", ...base, reason: "could not read eth: HTTP 503" })).toContain("could not read eth: HTTP 503");
  });
});

describe("renderHtml: an order found from the user's own transaction", () => {
  it("says so under the verdict", () => {
    const html = renderHtml({ ...result, resolvedVia: "origin", foundBy: { chain: "tron", originTx: "d9b9", depositTx: "8a33" } });
    expect(html).toContain("Found from your TRON transaction");
    expect(html).toContain("https://nearblocks.io/txns/8a33");
  });
  it("a deposit found in the Omni bridge's records says so, with the NEAR transaction that credited it", () => {
    const html = renderHtml({ ...result, resolvedVia: "origin", foundBy: { chain: "sol", originTx: "4UXu", depositTx: "4x2d", via: "omni" } });
    expect(html).toContain("Found from your Solana transaction");
    expect(html).toContain("through the Omni bridge's record of it, credited on NEAR in");
    expect(html).toContain("https://nearblocks.io/txns/4x2d");
  });
  it("an Omni BTC deposit names the bridge's record instead of a NEAR deposit", () => {
    const html = renderHtml({ ...result, resolvedVia: "origin", foundBy: { chain: "btc", originTx: "82d0" } });
    expect(html).toContain("through the Omni bridge's record of the deposit address it paid.");
  });
});

describe("renderHtml: a withdrawal that failed and came back", () => {
  it("says so on the withdrawal hop and in the flags", () => {
    const w = result.withdrawals[0];
    if (!w) throw new Error("fixture lacks the withdrawal");
    const html = renderHtml({
      ...result,
      verdict: "stuck",
      withdrawals: [{ ...w, returned: w.amount }],
      payout: { status: "missing" },
      balances: { [w.token]: w.amount },
      flags: [{ kind: "withdrawal_returned", detail: "a withdrawal failed and its tokens came back to the order account" }],
    });
    expect(html).toContain("The transfer out failed");
    expect(html).toContain('<li class="flag withdrawal_returned"><b>Withdrawal returned</b> a withdrawal failed and its tokens came back to the order account</li>');
  });
});

describe("renderHtml: a NEAR payout that bounced (DERIVED from order 373dde4d…)", () => {
  // fixtures/derived/…: the recorded order with its native_withdraw sent to a named account nobody created (see its _derived note).
  const account = "373dde4de823895a57e957954abbe1579394f35b43fd4a40b0153db8970a49a4";
  const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/derived/373dde4d-native-payout-bounced.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const html = renderHtml({ ...traceOrder({ account, txs, nowNs: 1_792_000_000_000_000_000n }), resolvedFrom: { kind: "account", account }, resolvedVia: "account", txCount: txs.length });

  it("says on the withdrawal that NEAR returned it, shows no payout, flags it and puts it with intents.near", () => {
    expect(html).toContain('data-verdict="stuck"');
    expect(html).toContain("NEAR could not deliver it (that account does not exist) and returned it to intents.near, which does not credit it back to the order account.");
    expect(html).toContain("Nothing was paid out: the withdrawal did not reach its destination.");
    expect(html).toContain('<li class="flag payout_bounced"><b>Payout bounced</b> NEAR could not deliver the payout to nobody-made-this.near (that account does not exist)');
    expect(html).toContain('<section class="custody" data-place="intents_contract">');
    expect(html).toContain('<textarea class="support" readonly');
  });
});

describe("renderHtml: a HOT bridge deposit", () => {
  it("names the chain and HOT's deposit nonce", () => {
    const account = "2230e7729bd469fd8f06a8b3aceadc427b44c0ac754207c89ffd302f84e64a41";
    const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/2230e772.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
    const html = renderHtml({ ...traceOrder({ account, txs, nowNs: 1_792_000_000_000_000_000n }), resolvedFrom: { kind: "account", account }, resolvedVia: "account", txCount: txs.length });
    expect(html).toContain("<b>ton</b> · <code>HOT deposit nonce 1791795150000000127427</code>");
  });
});

describe("renderHtml: an order paid out by a transfer inside NEAR Intents (97bd4a1e…, NEAR Mobile)", () => {
  const account = "97bd4a1e1a35bd5df58f222417026bbd574b8d0d30038c17f11c90900099f734";
  const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/97bd4a1e.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const html = renderHtml({ ...traceOrder({ account, txs, nowNs: 1_792_000_000_000_000_000n }), resolvedFrom: { kind: "account", account }, resolvedVia: "account", txCount: txs.length });

  it("labels the paying transfer as the payout and the other as the integrator's fee", () => {
    expect(html).toContain("The payout, inside NEAR Intents.");
    expect(html).toContain("Usually the integrator's fee.");
  });

  it("words the payout as a transfer inside NEAR Intents, not as a withdrawal", () => {
    expect(html).toContain("<b>2,380.462381 USDT (NEAR)</b> to <b>near</b>");
    expect(html).toContain("inside NEAR Intents ·");
    expect(html).not.toContain("after the withdrawal");
    expect(html).toContain("Proven: the transfer to the destination inside NEAR Intents is in this transaction; it credits that account&#39;s NEAR Intents balance.");
  });
});

describe("renderHtml: a transaction still executing", () => {
  it("flags it and puts the custody answer on hold", () => {
    const html = renderHtml({ ...result, verdict: "in_progress", flags: [{ kind: "executing", tx: "E887", detail: "NEAR is still executing transaction E887 (3 of its steps have not run yet): this is not final, check again in a minute" }] });
    expect(html).toContain('<li class="flag executing"><b>Still executing</b> NEAR is still executing transaction E887');
    expect(html).toContain('<section class="custody" data-place="executing">');
  });
});

describe("renderHtml: a payout to a name nobody has created", () => {
  it("flags it", () => {
    const html = renderHtml({ ...result, flags: [{ kind: "destination_missing", account: "hideon.near", detail: "no NEAR account is named hideon.near yet" }] });
    expect(html).toContain('<li class="flag destination_missing"><b>No such account</b> no NEAR account is named hideon.near yet</li>');
  });
});

describe("renderHtml: the balance checked against intents.near", () => {
  it("says so under the balance, with the block", () => {
    const html = renderHtml({ ...result, balanceCheck: { status: "verified", blockHeight: 219_921_623, blockHash: "8LvS9PHrRdffJp2SosWPUDXLH7pcmgEw4EwkewG74xo2" } });
    expect(html).toContain('<p class="small balance-check">Checked against intents.near at block 219,921,623 (<code>8LvS9PHrRdffJp2SosWPUDXLH7pcmgEw4EwkewG74xo2</code>): it holds the same for this account.</p>');
  });
});

describe("renderHtml: history read from the backup source", () => {
  it("credits NearBlocks with a link and says what it cannot see", () => {
    const html = renderHtml({ ...result, historySource: "nearblocks" });
    expect(html).toContain('<a href="https://nearblocks.io"');
    expect(html).toContain("Powered by Nearblocks.io APIs");
    expect(html).toContain("a deposit not credited yet does not show here");
    expect(renderHtml(result)).not.toContain("Nearblocks.io APIs");
  });
});
