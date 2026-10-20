// The refund page's report for a Bitcoin or Zcash deposit: the verdict, the deposit's facts, and the steps left.
import { describe, expect, it } from "vitest";

import { btcDepositVerdict, refundSteps, type BoardRow, type BtcDepositFacts, type RefundConfig } from "./core/btc-refund.js";
import { renderBtcRefundHtml, renderRefundBoardHtml } from "./render-btc-refund-html.js";

const CONFIG: RefundConfig = { refundTimelockSec: 172_800, unsafeRefundTimelockSec: 1_209_600, minDepositSat: 2_500, maxGasFeeSat: 5_000, refundFeeSat: 5_000, requestDepositYocto: 2n * 10n ** 24n, executeDepositYocto: 10n ** 24n };
const ORDER = "f3de655c605a4ca01e000e7961a969687678efaf3bd6c6dff13cea3cb50ab807";
const SENDER = "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t";
const FACTS: BtcDepositFacts = {
  chain: "btc",
  txid: "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39",
  vout: 0,
  amountSat: 9_997_900,
  depositAddress: "bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62",
  confirmedAtSec: 1_787_159_956,
  senders: [SENDER],
  msg: { recipient_id: "intents.near", safe_deposit: { msg: `{"receiver_id":"${ORDER}"}` } },
  bridgeHolds: false,
  spentBy: null,
  request: { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false, gasFeeSat: 5_000 },
  funding: { kind: "transparent", pools: [] },
};
const NOW = 1_791_900_000;
const html = (facts: BtcDepositFacts, nowSec = NOW, orderAccount: string | null = ORDER): string => {
  const verdict = btcDepositVerdict(facts, CONFIG, nowSec);
  return renderBtcRefundHtml({ facts, verdict, steps: refundSteps(facts, verdict, CONFIG), config: CONFIG, orderAccount }, nowSec);
};
/** What a reader sees, with typographic apostrophes as plain ones. */
const text = (s: string): string => s.replace(/<[^>]*>/g, "").replace(/’/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("renderBtcRefundHtml", () => {
  it("a refund past its lock that nobody executed: the verdict, the facts, and every step with its command to copy", () => {
    const h = html(FACTS);
    expect(h).toContain('<h2 class="hi">Ready to refund</h2>');
    expect(text(h)).toContain("The refund was requested on 2026-08-19 and its lock ended on 2026-09-02, 41 days ago. Nobody has executed it yet.");
    expect(text(h)).toContain(`The bridge can only send it to ${SENDER}.`);
    expect(h).toContain(`<a class="ext" href="https://mempool.space/tx/${FACTS.txid}" target="_blank" rel="noopener noreferrer"><code>${FACTS.txid}</code></a> (output 0)`);
    expect(text(h)).toContain("0.09997900 BTC");
    expect(h).toContain(`<a href="/#q=${ORDER}"><code>${ORDER}</code></a>`);
    expect(text(h)).toContain("Execute the refund (1 NEAR, not returned)");
    expect(h).toContain('<button type="button" class="ghost" data-copy="near account import-account using-web-wallet network-config mainnet">Copy command</button>');
    expect(text(h)).toContain("look the transaction up on nearblocks.io before sending it again");
    expect(text(h)).toContain("We never hold keys or sign anything.");
    expect(text(h)).toContain("Sources: mempool.space; the Omni bridge indexer's deposit message, checked against btc-connector.bridge.near");
  });

  it("a stuck deposit nobody asked about: where the refund would go, the fee, and the request step", () => {
    const h = html({ ...FACTS, request: null });
    expect(h).toContain("<h2>Stuck</h2>");
    expect(text(h)).toContain("Confirmed 2026-08-19 and never credited on NEAR. The bridge's own refund can send it back.");
    expect(text(h)).toContain(`The deposit names no refund address; the refund would go to the wallet that sent it: ${SENDER}.`);
    expect(text(h)).toContain("A refund returns 0.09992900 BTC: the deposit minus the 5000-satoshi refund fee");
    expect(text(h)).toContain(`--refund-address ${SENDER}`);
  });

  it("a deposit too small to refund says so and gives no steps", () => {
    const h = html({ ...FACTS, request: null, amountSat: 2_000 });
    expect(text(h)).toContain("It is below the bridge's 2,500-satoshi minimum deposit, which is likely why it was never credited.");
    expect(text(h)).toContain("It is not larger than the refund fee (5,000 satoshis), so the contract would refuse a refund request.");
    expect(h).not.toContain("<ol");
  });

  it("a Zcash refund to a shielded address explains the Ironwood pool and that shielded is not hidden", () => {
    const UA = "u1egfcnx27m4406w892hrp96n8akl66juj8pn0agqa2w2zrylpmq5yurssz0tlq3k4rmhag7y6kljezxp6me4j3h03ezs0tzrqynz2tdcnwenqqepl85f6qcxekcjv60wheqyyt5lk560t0m3tx7y2zqzwr56wr9fg76dumq08jspxmncv";
    const h = html({ ...FACTS, chain: "zcash", amountSat: 41_000_000, request: { ...FACTS.request!, refundAddress: UA, amountSat: 41_000_000, gasFeeSat: 10_000 } });
    expect(text(h)).toContain("0.41000000 ZEC");
    expect(text(h)).toContain("the refund lands in the Ironwood pool");
    expect(text(h)).toContain("Shielded is not hidden");
    expect(text(h)).not.toContain("stay off the transparent chain");
    expect(h).toContain("https://blockchair.com/zcash/transaction/");
    expect(text(h)).toContain("Sources: Blockchair;");
  });

  it("credited, refunded and not-a-deposit link where the money went", () => {
    expect(html({ ...FACTS, request: null, bridgeHolds: true })).toContain(`<a href="/#q=${ORDER}">Follow the order</a>`);
    const refunded = html({ ...FACTS, request: null, spentBy: { txid: "ab".repeat(32), inputs: 1, paysTo: [SENDER] } });
    expect(refunded).toContain('<h2 class="hi">Refunded</h2>');
    expect(refunded).toContain(`href="https://mempool.space/tx/${"ab".repeat(32)}"`);
    const none = html({ ...FACTS, request: null, msg: null }, NOW, null);
    expect(none).toContain("<h2>Not an Omni BTC deposit</h2>");
    expect(none).toContain(`<a href="/#q=${FACTS.txid}">main checker</a>`);
    expect(none).not.toContain("For NEAR account");
  });

  it("an old deposit is too old to request, and says until when it could have been", () => {
    const h = html({ ...FACTS, request: null }, FACTS.confirmedAtSec! + 367 * 86_400);
    expect(h).toContain("<h2>Too old to request</h2>");
    expect(text(h)).toContain("keeps about a year of Bitcoin blocks and no longer has this deposit's (since about 2027-08-20)");
  });

  it("escapes everything that came from a chain or an API", () => {
    const h = html({ ...FACTS, senders: ['<img src=x onerror="alert(1)">'], request: null }, NOW, '"><script>alert(1)</script>');
    expect(h).not.toContain("<img src=x");
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("renderBtcRefundHtml on the bridge's 100-year lock (unsafe_refund_timelock_sec since 2026-10-16)", () => {
  const LOCKED: RefundConfig = { ...CONFIG, unsafeRefundTimelockSec: 3_153_600_000 };
  const locked = (facts: BtcDepositFacts): string => {
    const verdict = btcDepositVerdict(facts, LOCKED, NOW);
    return renderBtcRefundHtml({ facts, verdict, steps: refundSteps(facts, verdict, LOCKED), config: LOCKED, orderAccount: ORDER }, NOW);
  };

  it("a stuck deposit that named no refund address: no steps, why, and nothing to pay for", () => {
    const h = locked({ ...FACTS, request: null });
    expect(h).toContain("<h2>Stuck</h2>");
    expect(text(h)).toContain("Confirmed 2026-08-19 and never credited on NEAR.");
    expect(text(h)).not.toContain("The bridge's own refund can send it back.");
    expect(text(h)).toContain("The deposit names no refund address, and the bridge now locks a refund requested for such a deposit for 100 years");
    expect(text(h)).toContain("A request would cost 2 NEAR, not returned");
    expect(h).not.toContain("<ol");
    expect(text(h)).not.toContain("A refund returns");
  });

  it("a request already made on that lock says nobody can execute it before then", () => {
    const h = locked(FACTS);
    expect(h).toContain("<h2>Refund requested</h2>");
    expect(text(h)).toContain("That is the bridge's 100-year lock for a refund whose deposit named no refund address");
  });
});

describe("renderRefundBoardHtml", () => {
  const row = (over: Partial<BoardRow>): BoardRow => ({ chain: "btc", txid: "cd".repeat(32), vout: 1, amountSat: 12_345_678, refundTo: SENDER, requestedAtSec: NOW - 30 * 86_400, unlocksAtSec: NOW - 16 * 86_400, state: "ready", readyForSec: 16 * 86_400, ...over });

  it("lists every open request with its state, amount, address and a link that checks the deposit", () => {
    const h = renderRefundBoardHtml([row({}), row({ chain: "zcash", state: "locked", unlocksAtSec: NOW + 86_400, readyForSec: 0, txid: "ef".repeat(32) }), row({ state: "executed", readyForSec: 0 })], NOW);
    expect(h).toContain('<td class="hi">Ready, 16 days</td>');
    expect(text(h)).toContain("Locked until 2026-10-14");
    expect(text(h)).toContain("Executed");
    expect(text(h)).toContain("0.12345678 BTC");
    expect(text(h)).toContain("0.12345678 ZEC");
    expect(h).toContain(`<a href="#q=${"cd".repeat(32)}:1"><code>cdcdcdcdcd…cdcdcd</code></a>`);
  });

  it("marks a request on the bridge's 100-year lock", () => {
    const h = renderRefundBoardHtml([row({ state: "locked", readyForSec: 0, requestedAtSec: NOW, unlocksAtSec: NOW + 3_153_600_000 })], NOW);
    expect(text(h)).toContain("Locked for 100 years (until 2126-");
    expect(text(h)).toContain("A 100-year lock is the bridge's lock for a refund whose deposit named no refund address");
  });

  it("says so when no request is open", () => {
    expect(renderRefundBoardHtml([], NOW)).toBe('<p class="note">No refund requests are open.</p>');
  });
});
