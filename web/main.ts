// The home page: the checker (input → checkOrder, from the browser → the HTML report), and the live strip read from
// NEAR (the latest final block, and the refunds waiting on the Omni Bitcoin and Zcash bridges). Only this layer is on
// the wall clock; stale numbers are shown as stale.

import { checkRefundBoard, liveNearRpc, publicUtxoRefundClients } from "../src/btc-refund.js";
import { checkOrder, fastnearClient, type CheckResult } from "../src/check.js";
import { UTXO_CHAINS, type BoardRow } from "../src/core/btc-refund.js";
import { describeDuration } from "../src/core/trace.js";
import { publicOriginClient, refundHintTxid } from "../src/origin.js";
import { publicPayoutClient } from "../src/payouts.js";
import type { Route } from "../src/core/route.js";
import { boardSummary } from "../src/board-summary.js";
import { esc, renderHtml } from "../src/render-html.js";
import { renderRoute } from "../src/render-route.js";
import { renderText } from "../src/render-text.js";
import { playRoute } from "./route.js";
import { errorHtml, fromHash, goTo, nowSec, wireCopyButtons } from "./shared.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---- The checker -------------------------------------------------------------------------------------------------

const form = $<HTMLFormElement>("form");
const input = $<HTMLInputElement>("q");
const go = $<HTMLButtonElement>("go");
const out = $<HTMLDivElement>("out");
// One payout client for the page, so the token prices it reads (to tell dust from stuck money) are reused. Solana is
// read through the site's relay (worker/solana.ts): Solana's own public RPC refuses browsers.
const payouts = publicPayoutClient(undefined, { solanaRpc: new URL("/api/solana", location.href).href });

let running = 0;
let last: CheckResult | null = null;

async function run(query: string): Promise<void> {
  const q = query.trim();
  if (!q) return;
  const id = ++running;
  input.value = q;
  go.disabled = true;
  out.innerHTML = '<p class="status-line">Reading NEAR and the chains…</p>';
  try {
    const result = await checkOrder(q, fastnearClient(), BigInt(Date.now()) * 1_000_000n, undefined, payouts, publicOriginClient());
    if (id !== running) return;
    last = result;
    out.innerHTML = `${renderHtml(result)}<div class="actions"><button type="button" class="ghost" data-action="report">Copy report</button><button type="button" class="ghost" data-action="link">Copy link</button></div>`;
    playRoute(out);
  } catch (e) {
    if (id !== running) return;
    last = null;
    const message = e instanceof Error ? e.message : String(e);
    const txid = refundHintTxid(message);
    out.innerHTML = txid
      ? `<div class="error"><p>${esc(message.replace(/; check whether it can be refunded with: btc-refund [0-9a-fA-F]{64}$/, "."))}</p><p class="mt"><a class="ext" href="/refund#q=${txid}">See whether it can be refunded, and how →</a></p></div>`
      : errorHtml(e);
  } finally {
    if (id === running) go.disabled = false;
  }
}

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = input.value.trim();
  if (q) goTo(q, (x) => void run(x));
});

out.addEventListener("click", (ev) => {
  const button = ev.target instanceof Element ? ev.target.closest<HTMLButtonElement>("button") : null;
  if (!button) return;
  if (button.dataset["retry"] !== undefined) return void run(fromHash() || input.value);
  const action = button.dataset["action"];
  if (!action || !last) return;
  const text = action === "report" ? `${renderText(last)}\n\n${location.href}` : location.href;
  void navigator.clipboard.writeText(text).then(() => {
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = label), 1600);
  });
});
wireCopyButtons(out);

function fromLink(): void {
  const q = fromHash();
  if (!q) return;
  void run(q);
  document.getElementById("check")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
window.addEventListener("hashchange", fromLink);
fromLink();

// ---- The hero's illustration: the same route a real check draws, played when it comes into view -------------------

const DEMO: Route = {
  stops: [
    { key: "origin", title: "Deposit", place: "Bitcoin", state: "done", atNs: null, chain: "btc" },
    { key: "credit", title: "Credit", place: "NEAR Intents", state: "done", atNs: null, chain: "near" },
    { key: "swap", title: "Swap", place: "BTC → USDC", state: "done", atNs: null, chain: "near" },
    { key: "withdrawal", title: "Withdrawal", place: "to Solana", state: "done", atNs: null, chain: "near" },
    { key: "payout", title: "Payout", place: "Solana", state: "done", atNs: null, chain: "sol" },
  ],
  from: "Bitcoin",
  to: "Solana",
  refunded: false,
  stopIndex: null,
  segmentsSec: [null, 4, 2, 38],
  totalSec: 44,
};
const demo = $<HTMLDivElement>("demo-route");
demo.innerHTML = renderRoute(DEMO);
let demoPlayed = false;
new IntersectionObserver((entries, observer) => {
  if (!entries.some((e) => e.isIntersecting) || demoPlayed) return;
  demoPlayed = true;
  observer.disconnect();
  setTimeout(() => playRoute(demo), 500);
}, { threshold: 0.6 }).observe(demo);
demo.closest("figure")?.addEventListener("mouseenter", () => playRoute(demo));

// ---- The hero loop: plays only on wide screens where motion is welcome; phones and reduced motion keep the poster ---

const loop = document.getElementById("hero-loop") as HTMLVideoElement | null;
if (loop && window.matchMedia("(min-width: 961px) and (prefers-reduced-motion: no-preference)").matches) {
  loop.preload = "auto";
  loop.load();
  void loop.play().catch(() => undefined);
}

// ---- The asset marquee (twice, so it loops; the second copy is hidden from screen readers) ------------------------

const ASSETS = ["BTC", "ETH", "SOL", "DOGE", "ZEC", "NEAR", "USDC", "USDT", "XRP", "TRX", "LTC", "BCH", "ADA", "SUI", "TON", "AVAX", "BNB", "XLM", "APT", "DASH"];
/** The coin's logo file under /logos, by ticker; the rest keep their lettered disc. */
const COIN_LOGO: Record<string, string> = { BTC: "btc", ETH: "eth", SOL: "sol", DOGE: "doge", ZEC: "zec", NEAR: "near", USDC: "usdc", USDT: "usdt", XRP: "xrp", TRX: "tron", LTC: "ltc", BCH: "bch", ADA: "cardano", SUI: "sui", TON: "ton", AVAX: "avax", BNB: "bsc", XLM: "stellar", APT: "aptos", DASH: "dash" };
const chip = (a: string, hidden: boolean): string => {
  const logo = COIN_LOGO[a];
  const mark = logo ? `<img class="coin" src="/logos/${logo}.svg" alt="" width="20" height="20" loading="lazy" decoding="async">` : `<span class="disc c-${a.toLowerCase()}">${a[0]}</span>`;
  return `<li class="asset"${hidden ? ' aria-hidden="true"' : ""}>${mark}${a}</li>`;
};
$<HTMLUListElement>("assets").innerHTML = [...ASSETS.map((a) => chip(a, false)), ...ASSETS.map((a) => chip(a, true))].join("");

// ---- Live from chain data -----------------------------------------------------------------------------------------

const STALE_MS = 120_000;
const rpc = liveNearRpc();
let block: { height: number; atMs: number } | null = null;
let board: { rows: BoardRow[]; atMs: number } | null = null;
let boardBusy = false;

async function readBlock(): Promise<void> {
  try {
    const answer = (await rpc({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } })) as { result?: { header?: { height?: number; timestamp_nanosec?: string } } };
    const h = answer.result?.header;
    if (h?.height && h.timestamp_nanosec) block = { height: h.height, atMs: Number(BigInt(h.timestamp_nanosec) / 1_000_000n) };
  } catch {
    // Shown as stale below.
  }
  paint();
}

async function readBoard(): Promise<void> {
  try {
    board = { rows: await checkRefundBoard(publicUtxoRefundClients(), nowSec()), atMs: Date.now() };
    boardBusy = false;
  } catch {
    boardBusy = true;
  }
  paint();
  paintWaiting();
}

const ago = (ms: number): string => describeDuration(Math.max(0, Math.round(ms / 1000)));

function paint(): void {
  const now = Date.now();
  const blockValue = $("block");
  const blockSub = $("block-sub");
  if (block) {
    const stale = now - block.atMs > STALE_MS;
    blockValue.textContent = `#${block.height.toLocaleString("en-US")}`;
    blockValue.classList.toggle("stale", stale);
    blockSub.textContent = `${stale ? "stale: " : ""}final block, ${ago(now - block.atMs)} ago`;
  }
  const ready = board?.rows.filter((r) => r.state === "ready") ?? [];
  const readyValue = $("ready");
  const readySub = $("ready-sub");
  if (board) {
    readyValue.textContent = String(ready.length);
    const stale = boardBusy && now - board.atMs > STALE_MS;
    const first = ready[0];
    readySub.textContent = stale
      ? `stale: read ${ago(now - board.atMs)} ago, NEAR is busy →`
      : first
        ? `${(first.amountSat / 1e8).toFixed(4)} ${UTXO_CHAINS[first.chain].unit} waiting ${describeDuration(first.readyForSec)} →`
        : "on the Omni BTC and ZEC bridges →";
  } else if (boardBusy) {
    readyValue.textContent = "retrying…";
    readySub.textContent = "NEAR is busy, retrying every minute →";
  }
}

/** The band's card: the open refund requests on both bridges, live, and the one that has waited longest to be executed. */
const COIN_FILE: Record<string, string> = { btc: "btc", zcash: "zec" };
function paintWaiting(): void {
  const card = $("waiting");
  const head = '<p class="eyebrow wait-head"><span class="live-dot" aria-hidden="true"></span> Right now, on chain</p>';
  if (!board) {
    if (boardBusy) card.innerHTML = `${head}<p class="say">NEAR’s public servers are busy, so the bridge contracts could not be read just now. The refund page reads them again.</p>`;
    return;
  }
  const s = boardSummary(board.rows, nowSec());
  const coins = (["btc", "zcash"] as const)
    .map((c) => `<span class="wait-coin"><img src="/logos/${COIN_FILE[c]}.svg" alt="" width="22" height="22" /><b>${s.byChain[c]}</b> ${UTXO_CHAINS[c].unit}</span>`)
    .join("");
  const chips = `<p class="wait-chips"><span class="wc ready"><b>${s.ready}</b> ready</span><span class="wc locked"><b>${s.locked}</b> locked</span><span class="wc done"><b>${s.executed}</b> executed</span></p>`;
  const first = s.firstReady;
  const lead = first
    ? `<p class="big">${(first.amountSat / 1e8).toFixed(4)} ${UTXO_CHAINS[first.chain].unit}</p><p class="say">ready to go home for <b>${describeDuration(first.readyForSec)}</b>. The refund was requested, the lock passed, and nobody has pressed the button.</p><p class="addr">refund address ${esc(first.refundTo)}</p>`
    : `<p class="big">${s.open}</p><p class="say">open refund request${s.open === 1 ? "" : "s"} on the Omni Bitcoin and Zcash bridges. None is ready to execute right now${s.nextUnlockInSec !== null ? `; the next lock opens in <b>${describeDuration(s.nextUnlockInSec)}</b>` : ""}.</p>`;
  const long = s.longLocked ? `<p class="wait-note">${s.longLocked === 1 ? "One of them waits" : `${s.longLocked} of them wait`} out the bridge’s 100-year lock for deposits that named no refund address.</p>` : "";
  card.innerHTML = `${head}${lead}<div class="wait-row">${coins}</div>${chips}${long}<a class="wait-go" href="/refund">See every open refund →</a>`;
}

void readBlock();
void readBoard();
setInterval(() => void readBlock(), 8_000);
setInterval(() => void readBoard(), 60_000);
setInterval(paint, 1_000);
