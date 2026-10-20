// HTML report for the page. Pure string building; every value that came from the chain is escaped.

import type { CheckResult } from "./check.js";
import { chainName } from "./core/chains.js";
import { supportMessage, whoCanMove } from "./core/custody.js";
import { NEARBLOCKS_LINK } from "./core/nearblocks.js";
import { payoutEvidence } from "./core/payout.js";
import { bounceCause, creditSource, describeDuration, payingWithdrawal, payoutTransfer } from "./core/trace.js";
import { groupDigits } from "./core/views.js";
import { whenUtc } from "./render-text.js";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type Explorer = { tx: string; address: string };
const EXPLORERS: Record<string, Explorer> = {
  eth: { tx: "https://etherscan.io/tx/", address: "https://etherscan.io/address/" },
  base: { tx: "https://basescan.org/tx/", address: "https://basescan.org/address/" },
  arb: { tx: "https://arbiscan.io/tx/", address: "https://arbiscan.io/address/" },
  op: { tx: "https://optimistic.etherscan.io/tx/", address: "https://optimistic.etherscan.io/address/" },
  bsc: { tx: "https://bscscan.com/tx/", address: "https://bscscan.com/address/" },
  bnb: { tx: "https://bscscan.com/tx/", address: "https://bscscan.com/address/" },
  pol: { tx: "https://polygonscan.com/tx/", address: "https://polygonscan.com/address/" },
  avax: { tx: "https://snowtrace.io/tx/", address: "https://snowtrace.io/address/" },
  gnosis: { tx: "https://gnosisscan.io/tx/", address: "https://gnosisscan.io/address/" },
  bera: { tx: "https://berascan.com/tx/", address: "https://berascan.com/address/" },
  monad: { tx: "https://monadscan.com/tx/", address: "https://monadscan.com/address/" },
  xlayer: { tx: "https://www.oklink.com/xlayer/tx/", address: "https://www.oklink.com/xlayer/address/" },
  plasma: { tx: "https://plasmascan.to/tx/", address: "https://plasmascan.to/address/" },
  scroll: { tx: "https://scrollscan.com/tx/", address: "https://scrollscan.com/address/" },
  adi: { tx: "https://explorer.adifoundation.ai/tx/", address: "https://explorer.adifoundation.ai/address/" },
  hood: { tx: "https://robinhoodchain.blockscout.com/tx/", address: "https://robinhoodchain.blockscout.com/address/" },
  abs: { tx: "https://abscan.org/tx/", address: "https://abscan.org/address/" },
  tron: { tx: "https://tronscan.org/#/transaction/", address: "https://tronscan.org/#/address/" },
  btc: { tx: "https://mempool.space/tx/", address: "https://mempool.space/address/" },
  ltc: { tx: "https://blockchair.com/litecoin/transaction/", address: "https://blockchair.com/litecoin/address/" },
  bch: { tx: "https://blockchair.com/bitcoin-cash/transaction/", address: "https://blockchair.com/bitcoin-cash/address/" },
  dash: { tx: "https://blockchair.com/dash/transaction/", address: "https://blockchair.com/dash/address/" },
  doge: { tx: "https://blockchair.com/dogecoin/transaction/", address: "https://blockchair.com/dogecoin/address/" },
  zec: { tx: "https://blockchair.com/zcash/transaction/", address: "https://blockchair.com/zcash/address/" },
  zcash: { tx: "https://blockchair.com/zcash/transaction/", address: "https://blockchair.com/zcash/address/" },
  xrp: { tx: "https://xrpscan.com/tx/", address: "https://xrpscan.com/account/" },
  sol: { tx: "https://solscan.io/tx/", address: "https://solscan.io/account/" },
  ton: { tx: "https://tonviewer.com/transaction/", address: "https://tonviewer.com/" },
  sui: { tx: "https://suiscan.xyz/mainnet/tx/", address: "https://suiscan.xyz/mainnet/account/" },
  stellar: { tx: "https://stellar.expert/explorer/public/tx/", address: "https://stellar.expert/explorer/public/account/" },
  cardano: { tx: "https://cardanoscan.io/transaction/", address: "https://cardanoscan.io/address/" },
  aptos: { tx: "https://explorer.aptoslabs.com/txn/", address: "https://explorer.aptoslabs.com/account/" },
  starknet: { tx: "https://starkscan.co/tx/", address: "https://starkscan.co/contract/" },
  hlevm: { tx: "https://hyperevmscan.io/tx/", address: "https://hyperevmscan.io/address/" },
  hypercore: { tx: "https://hyperevmscan.io/tx/", address: "https://hyperevmscan.io/address/" },
  near: { tx: "https://nearblocks.io/txns/", address: "https://nearblocks.io/address/" },
};

/** The public explorer page for a transaction or address on a chain ("eth:1", "tron:mainnet", "eth", "near"). */
export function explorerUrl(kind: "tx" | "address", chain: string, id: string): string | null {
  const key = chain.split(":")[0] ?? chain;
  const ex = EXPLORERS[key];
  // Omni names addresses with their chain (`sol:…`, `zcash:…`); no address or hash we link contains a colon otherwise.
  const bare = id.replace(/^[a-z]+:/, "");
  // A shielded Zcash address (unified `u1…`, Sapling `zs…`) has no public page: its payments are encrypted.
  if (kind === "address" && (key === "zec" || key === "zcash") && /^(u1|zs)/.test(bare)) return null;
  return ex ? `${ex[kind]}${encodeURIComponent(bare)}` : null;
}

/**
 * Display names and decimals for the tokens orders use most (the rest are shown raw with their contract): symbols and
 * decimals from each contract's own `ft_metadata` on NEAR (read 2026-10-14), with the chain added where a symbol is
 * on several.
 */
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "nep141:eth.omft.near": { symbol: "ETH", decimals: 18 },
  "nep141:base.omft.near": { symbol: "ETH (Base)", decimals: 18 },
  "nep141:arb.omft.near": { symbol: "ETH (Arbitrum)", decimals: 18 },
  "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near": { symbol: "USDT", decimals: 6 },
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": { symbol: "USDC", decimals: 6 },
  "nep141:tron.omft.near": { symbol: "TRX", decimals: 6 },
  "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": { symbol: "USDT (TRON)", decimals: 6 },
  "nep141:sol.omft.near": { symbol: "SOL", decimals: 9 },
  "nep141:nbtc.bridge.near": { symbol: "BTC", decimals: 8 },
  "nep141:btc.omft.near": { symbol: "BTC", decimals: 8 },
  "nep141:doge.omft.near": { symbol: "DOGE", decimals: 8 },
  "nep141:xrp.omft.near": { symbol: "XRP", decimals: 6 },
  "nep141:zec.omft.near": { symbol: "ZEC", decimals: 8 },
  "nep141:wrap.near": { symbol: "NEAR", decimals: 24 },
  "nep141:usdt.tether-token.near": { symbol: "USDT (NEAR)", decimals: 6 },
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC (NEAR)", decimals: 6 },
  "nep141:token.sweat": { symbol: "SWEAT", decimals: 18 },
  "nep141:npro.nearmobile.near": { symbol: "NPRO", decimals: 24 },
  "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near": { symbol: "AURORA", decimals: 18 },
  "nep141:d9c2d319cd7e6177336b0a9c93c21cb48d84fb54.factory.bridge.near": { symbol: "HAPI", decimals: 18 },
  "nep141:eth.bridge.near": { symbol: "ETH (Rainbow bridge)", decimals: 18 },
  "nep141:nearly-993927.nearlytrade.near": { symbol: "NEARLY", decimals: 18 },
  "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near": { symbol: "DAI", decimals: 18 },
  "nep141:eth-0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce.omft.near": { symbol: "SHIB", decimals: 18 },
  "nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near": { symbol: "WBTC", decimals: 8 },
  "nep141:eth-0xb4b9dc1c77bdbb135ea907fd5a08094d98883a35.omft.near": { symbol: "SWEAT (Ethereum)", decimals: 18 },
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": { symbol: "USDC (Base)", decimals: 6 },
  "nep141:base-0x227d920e20ebac8a40e7d6431b7d724bb64d7245.omft.near": { symbol: "SWEAT (Base)", decimals: 18 },
  "nep141:base-0xe62bfbe57763ec24c0f130426f34dbce11fc5b06.omft.near": { symbol: "TITN", decimals: 18 },
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": { symbol: "USDC (Arbitrum)", decimals: 6 },
  "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near": { symbol: "USDT (Arbitrum)", decimals: 6 },
  "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near": { symbol: "ARB", decimals: 18 },
  "nep141:gnosis.omft.near": { symbol: "xDAI", decimals: 18 },
  "nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near": { symbol: "USDC (Gnosis)", decimals: 6 },
  "nep141:plasma-0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb.omft.near": { symbol: "USDT (Plasma)", decimals: 6 },
  "nep141:hood.omft.near": { symbol: "ETH (Robinhood)", decimals: 18 },
  "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near": { symbol: "USDG", decimals: 6 },
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": { symbol: "USDC (Solana)", decimals: 6 },
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": { symbol: "USDT (Solana)", decimals: 6 },
  "nep141:sol-91914f13d3b54f8126a2824d71632d4b078d7403.omft.near": { symbol: "xBTC", decimals: 8 },
  "nep141:sui.omft.near": { symbol: "SUI", decimals: 9 },
  "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near": { symbol: "USDC (Sui)", decimals: 6 },
  "nep141:ltc.omft.near": { symbol: "LTC", decimals: 8 },
  "nep141:bch.omft.near": { symbol: "BCH", decimals: 8 },
  "nep141:cardano.omft.near": { symbol: "ADA", decimals: 6 },
  "nep141:aptos.omft.near": { symbol: "APT", decimals: 8 },
  "nep141:starknet.omft.near": { symbol: "STRK", decimals: 18 },
  "nep141:qtc.omft.near": { symbol: "QTC", decimals: 12 },
  // HOT's NEP-245 tokens, from v2_1.omni.hot.tg's own mt_metadata_base_by_token_id (read 2026-10-17, block 220,401,883).
  "nep245:v2_1.omni.hot.tg:56_11111111111111111111": { symbol: "BNB", decimals: 18 },
  "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g": { symbol: "USDT (BNB Chain)", decimals: 18 },
  "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r": { symbol: "USDC (BNB Chain)", decimals: 18 },
  "nep245:v2_1.omni.hot.tg:137_11111111111111111111": { symbol: "POL", decimals: 18 },
  "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr": { symbol: "USDT (Polygon)", decimals: 6 },
  "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L": { symbol: "USDC (Polygon)", decimals: 6 },
  "nep245:v2_1.omni.hot.tg:43114_11111111111111111111": { symbol: "AVAX", decimals: 18 },
  "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp": { symbol: "USDT (Avalanche)", decimals: 6 },
  "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o": { symbol: "USDC (Avalanche)", decimals: 6 },
  "nep245:v2_1.omni.hot.tg:143_11111111111111111111": { symbol: "MON", decimals: 18 },
  "nep245:v2_1.omni.hot.tg:10_11111111111111111111": { symbol: "ETH (Optimism)", decimals: 18 },
  "nep245:v2_1.omni.hot.tg:1117_": { symbol: "TON", decimals: 9 },
  "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR": { symbol: "USDT (TON)", decimals: 6 },
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz": { symbol: "XLM", decimals: 7 },
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu": { symbol: "USDC (Stellar)", decimals: 7 },
};

export function formatAmount(token: string, raw: string): string {
  const t = TOKENS[token];
  if (!t) return `${groupInt(raw)} ${token.replace(/^nep141:/, "")}`;
  const neg = raw.startsWith("-");
  const digits = raw.replace(/^-/, "").padStart(t.decimals + 1, "0");
  const int = digits.slice(0, digits.length - t.decimals);
  const frac = digits.slice(digits.length - t.decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${groupInt(int)}${frac ? `.${frac}` : ""} ${t.symbol}`;
}

function groupInt(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function link(url: string | null, text: string, cls = ""): string {
  const inner = `<code>${esc(text)}</code>`;
  return url ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>` : inner;
}

/** How an order found from the user's own transaction was reached: the PoA deposit naming it, or the Omni bridge's record. */
function foundVia(f: NonNullable<CheckResult["foundBy"]>): string {
  const near = (tx: string): string => link(explorerUrl("tx", "near", tx), tx);
  if (f.via === "omni") return `the Omni bridge's record of it, ${f.depositTx ? `credited on NEAR in ${near(f.depositTx)}` : "not credited on NEAR yet"}`;
  return f.depositTx ? `the NEAR deposit ${near(f.depositTx)} that names it` : "the Omni bridge's record of the deposit address it paid";
}

/** Solver accounts are context, not evidence: shorten them. Everything a reader might compare stays whole. */
const short = (s: string): string => (s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);

function hop(n: number, title: string, status: string, body: string, note = ""): string {
  return `<li class="hop ${status}"><span class="n">${n}</span><div><h3>${esc(title)} <span class="status ${status}">${esc(status)}</span></h3>${body}${note ? `<p class="note">${note}</p>` : ""}</div></li>`;
}

const VERDICT_TEXT: Record<CheckResult["verdict"], string> = {
  settled: "Settled",
  refunded: "Refunded",
  stuck: "Stuck",
  in_progress: "In progress",
  confidential: "Moved into Confidential Intents",
  not_found: "No order found",
};

export function renderHtml(r: CheckResult): string {
  const parts: string[] = [];
  parts.push(`<section class="report" data-verdict="${r.verdict}">`);
  parts.push(`<header class="verdict"><h2>${VERDICT_TEXT[r.verdict]}</h2><p>Order account ${link(explorerUrl("address", "near", r.account), r.account)} · ${r.txCount} NEAR transaction${r.txCount === 1 ? "" : "s"} read · 1Click would say <code>${r.oneClickStatus}</code>${r.verdict === "confidential" ? ", or <code>SUCCESS</code> once the private leg has delivered" : ""}</p>${r.foundBy ? `<p class="small">Found from your ${esc(chainName(r.foundBy.chain))} transaction ${link(explorerUrl("tx", r.foundBy.chain, r.foundBy.originTx), r.foundBy.originTx)}, through ${foundVia(r.foundBy)}.</p>` : ""}${r.historySource === "nearblocks" ? `<p class="small">History from NearBlocks, because FastNEAR was unavailable. <a href="${NEARBLOCKS_LINK}" target="_blank" rel="noopener">Powered by Nearblocks.io APIs</a>. NearBlocks lists only transactions that moved this order's tokens: a deposit not credited yet does not show here.</p>` : ""}</header>`);

  parts.push('<ol class="hops">');
  const o = r.origin;
  if (o.status === "proven") {
    const ref = "txHash" in o ? link(explorerUrl("tx", o.chain, o.txHash), o.txHash) : o.kind === "hot" ? `<code>HOT deposit nonce ${esc(o.originNonce)}</code>` : `<code>origin nonce ${esc(o.originNonce)}</code> from <code>${esc(o.sender)}</code>`;
    parts.push(hop(1, "Origin", "proven", `<p><b>${esc(o.chain)}</b> · ${ref}</p>`, esc(o.how)));
  } else if (o.status === "unverified") parts.push(hop(1, "Origin", "unverified", `<p>${esc(o.how)}</p>`));
  else parts.push(hop(1, "Origin", "missing", "<p>No deposit was credited to this account on NEAR.</p>"));

  if (r.deposits.length === 0) parts.push(hop(2, "Credit on NEAR", "missing", "<p>Nothing minted into intents.near for this account.</p>"));
  for (const d of r.deposits) {
    const source = creditSource(d);
    parts.push(hop(2, "Credit on NEAR", "proven", `<p><b>${esc(formatAmount(d.token, d.amount))}</b> · ${esc(whenUtc(d.timestampNs))} · ${link(explorerUrl("tx", "near", d.tx), d.tx)}</p>`, source ? esc(`${source[0]?.toUpperCase()}${source.slice(1)}.`) : ""));
  }

  if (r.swaps.length === 0) parts.push(hop(3, "Swap", "missing", "<p>No intent has been executed for this account since the credit.</p>"));
  for (const s of r.swaps) {
    const gave = Object.entries(s.gave).map(([t, a]) => esc(formatAmount(t, a))).join(" + ");
    const got = Object.entries(s.got).map(([t, a]) => esc(formatAmount(t, a))).join(" + ");
    const solvers = s.counterparties.length ? `<p class="small">Solvers: ${s.counterparties.map((c) => link(explorerUrl("address", "near", c), short(c))).join(", ")}</p>` : "";
    parts.push(hop(3, "Swap", "proven", `<p><b>${gave}</b> → <b>${got}</b> · ${esc(whenUtc(s.timestampNs))} · ${link(explorerUrl("tx", "near", s.tx), s.tx)}${s.referral ? ` · referral <code>${esc(s.referral)}</code>` : ""}</p>${solvers}`));
  }
  const paidBy = payoutTransfer(r)?.transfer;
  for (const t of r.transfers) parts.push(hop(3, "Transfer", "proven", `<p>${Object.entries(t.tokens).map(([k, a]) => esc(formatAmount(k, a))).join(" + ")} → ${link(explorerUrl("address", "near", t.to), t.to)}${t.toLabel ? ` <b>${esc(t.toLabel)}</b>` : ""} · ${esc(whenUtc(t.timestampNs))}</p>`, t === paidBy ? "The payout, inside NEAR Intents." : t.toLabel ? "" : "Usually the integrator's fee."));

  if (r.withdrawals.length === 0) parts.push(hop(4, "Withdrawal", "missing", "<p>Nothing has been withdrawn from this account.</p>"));
  for (const w of r.withdrawals) {
    const dest = w.destination ? link(w.chain ? explorerUrl("address", w.chain, w.destination) : null, w.destination) : "<code>?</code>";
    const bounce = w.bounced
      ? w.bounced.reason === "transfer_failed"
        ? `NEAR could not deliver it (${bounceCause(w.bounced)}) and returned it to intents.near, which does not credit it back to the order account.`
        : `${bounceCause(w.bounced)}; intents.near does not credit it back to the order account.`
      : null;
    const back = w.returned
      ? esc(`The transfer out failed and ${formatAmount(w.token, w.returned)} came back to the order account.`)
      : w.refused
        ? "The transfer to the bridge failed, and NEAR Intents does not credit a failed transfer back."
        : bounce
          ? esc(bounce)
          : w.excessRefund
            ? "The unused input, refunded to the refund address; not the payout."
            : "";
    parts.push(hop(4, "Withdrawal", "proven", `<p><b>${esc(formatAmount(w.token, w.amount))}</b> → <b>${esc(w.chain ?? "?")}</b> ${dest} · ${esc(whenUtc(w.timestampNs))} · ${link(explorerUrl("tx", "near", w.tx), w.tx)}</p>`, back));
  }

  parts.push(payoutHop(r));
  parts.push("</ol>");

  const balances = Object.entries(r.balances);
  parts.push(`<p class="balance">Still in the order account: ${balances.length ? `<b>${balances.map(([t, a]) => esc(formatAmount(t, a))).join(", ")}</b>` : "nothing"}</p>`);
  const bc = r.balanceCheck;
  if (bc?.status === "not_verified") parts.push(`<p class="small balance-check">Not checked against intents.near: ${esc(bc.reason)}.</p>`);
  else if (bc) {
    const holds = bc.status === "verified" ? "it holds the same for this account" : `it holds <b>${bc.differences.map((d) => esc(formatAmount(d.token, d.chain))).join(", ")}</b> for this account, not what the history adds up to (see the flag)`;
    parts.push(`<p class="small balance-check">Checked against intents.near at block ${groupDigits(bc.blockHeight)} (<code>${esc(bc.blockHash)}</code>): ${holds}.</p>`);
  }
  if (r.flags.length) {
    parts.push('<ul class="flags">');
    for (const f of r.flags) {
      if (f.kind === "stalled") parts.push(`<li class="flag stalled"><b>Stalled</b> ${esc(f.detail)} (${esc(describeDuration(f.waitedSec))})</li>`);
      else if (f.kind === "settled_late") parts.push(`<li class="flag settled_late"><b>Settled late</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "confidential") parts.push(`<li class="flag confidential"><b>Confidential</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "later_deposit") parts.push(`<li class="flag later_deposit"><b>Later deposit</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "dust") parts.push(`<li class="flag dust"><b>Dust</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "several_orders") parts.push(`<li class="flag several_orders"><b>Several orders</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "own_key") parts.push(`<li class="flag own_key"><b>Own key</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "incomplete_history") parts.push(`<li class="flag incomplete_history"><b>Incomplete history</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "payout_not_found") parts.push(`<li class="flag payout_not_found"><b>Payout not found</b> ${esc(f.detail)} (${esc(describeDuration(f.waitedSec))})</li>`);
      else if (f.kind === "withdrawal_returned") parts.push(`<li class="flag withdrawal_returned"><b>Withdrawal returned</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "withdrawal_refused") parts.push(`<li class="flag withdrawal_refused"><b>Withdrawal refused</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "payout_bounced") parts.push(`<li class="flag payout_bounced"><b>Payout bounced</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "executing") parts.push(`<li class="flag executing"><b>Still executing</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "destination_missing") parts.push(`<li class="flag destination_missing"><b>No such account</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "ledger_mismatch") parts.push(`<li class="flag ledger_mismatch"><b>Ledger mismatch</b> ${esc(f.detail)}</li>`);
      else if (f.kind === "locked") parts.push(`<li class="flag locked"><b>Locked</b> ${esc(f.detail)} (${esc(describeDuration(f.waitedSec))})</li>`);
      else parts.push(`<li class="flag refunded"><b>Refunded</b> ${esc(f.detail)}</li>`);
    }
    parts.push("</ul>");
  }
  const c = whoCanMove(r, formatAmount);
  parts.push(`<section class="custody" data-place="${c.place}"><h3>Where your money is</h3><dl><dt>Where it is</dt><dd>${esc(c.holds)}</dd><dt>Who can move it</dt><dd>${esc(c.canMove)}</dd><dt>What to do</dt><dd>${esc(c.next)}</dd></dl>`);
  if (c.needsHelp) {
    const message = supportMessage(r, c, { link: null, amount: formatAmount });
    parts.push(`<p class="small">Support message to send the app you swapped in:</p><textarea class="support" readonly rows="${message.split("\n").length + 1}">${esc(message)}</textarea>`);
  }
  parts.push("</section>");
  parts.push("</section>");
  return parts.join("");
}

const POA_NOTE = "The PoA bridge pays from a custodial wallet and writes nothing on chain that names this withdrawal, so its payout can only be matched by amount and time.";
const evidence = (p: CheckResult["payout"]): string => payoutEvidence(p).map((e) => ` ${esc(e)}`).join("");

function payoutHop(r: CheckResult): string {
  const p = r.payout;
  if (p.status === "missing") return hop(5, "Payout", "missing", r.withdrawals.length ? "<p>Nothing was paid out: the withdrawal did not reach its destination.</p>" : "<p>No withdrawal, so no payout to look for.</p>");
  const dest = p.destination ? link(p.chain ? explorerUrl("address", p.chain, p.destination) : null, p.destination) : "<code>?</code>";
  const txLink = (tx: string) => link(p.chain ? explorerUrl("tx", p.chain, tx) : null, tx);
  const to = `to <b>${esc(p.chain ?? "?")}</b> ${dest}`;
  const lastW = payingWithdrawal(r);
  switch (p.status) {
    case "arrived": {
      if (p.how === "recorded") return hop(5, "Payout", "recorded", `<p>${to} · recorded as paid by its Omni bridge contract (destination nonce ${p.destinationNonce})</p>`, evidence(p).trim());
      const paid = payoutTransfer(r);
      const token = paid?.token ?? lastW?.token;
      const amount = p.amount && token ? `<b>${esc(formatAmount(token, p.amount))}</b> ` : "";
      const when = paid ? "inside NEAR Intents" : p.delaySec === null ? "still unconfirmed on the destination chain" : `${esc(describeDuration(p.delaySec))} after the withdrawal`;
      return hop(5, "Payout", p.how, `<p>${amount}${to} · ${when} · ${txLink(p.tx)}</p>`, evidence(p).trim());
    }
    case "ambiguous":
      return hop(5, "Payout", "unverified", `<p>${to}</p><p class="small">${p.txs.length} transfers fit the amount and time: ${p.txs.map(txLink).join(", ")}</p>`, `More than one transfer fits, so none is named as the payout. The bridge operator can say which one it sent.${evidence(p)}`);
    case "waiting":
      return hop(5, "Payout", "unverified", `<p>${to}</p>`, `Not seen yet, ${esc(describeDuration(p.waitedSec))} after the withdrawal. Payouts usually land within minutes.${evidence(p)}`);
    case "not_found":
      return hop(5, "Payout", "missing", `<p>${to}</p>`, `No transfer of about the withdrawn amount reached this address in ${esc(describeDuration(p.waitedSec))}. Ask the bridge operator for the payout transaction, with this page as evidence.${evidence(p)}`);
    case "unverified":
      return hop(5, "Payout", "unverified", `<p>${to}</p>`, esc(p.reason ? `Not checked: ${p.reason}.` : p.bridge === "poa" ? `${POA_NOTE} Check the destination on its explorer.` : "Check the destination on its explorer.") + evidence(p));
  }
}
