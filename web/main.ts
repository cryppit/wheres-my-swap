// The home page: the checker (input → checkOrder, from the browser → the HTML report), and the live strip read from
// NEAR (the latest final block, and the refunds waiting on the Omni Bitcoin and Zcash bridges). Only this layer is on
// the wall clock; stale numbers are shown as stale.

import { checkRefundBoard, liveNearRpc, publicUtxoRefundClients } from "../src/btc-refund.js";
import { checkOrder, fastnearClient, type CheckResult } from "../src/check.js";
import { UTXO_CHAINS, type BoardRow } from "../src/core/btc-refund.js";
import { describeDuration } from "../src/core/trace.js";
import { publicOriginClient, refundHintTxid } from "../src/origin.js";
import { publicPayoutClient } from "../src/payouts.js";
import { esc, renderHtml } from "../src/render-html.js";
import { renderText } from "../src/render-text.js";
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

// ---- The asset marquee (twice, so it loops; the second copy is hidden from screen readers) ------------------------

const ASSETS = ["BTC", "ETH", "SOL", "DOGE", "ZEC", "NEAR", "USDC", "USDT", "XRP", "TRX", "LTC", "BCH", "ADA", "SUI", "TON", "AVAX", "BNB", "XLM", "APT", "DASH"];
const chip = (a: string, hidden: boolean): string => `<li class="asset"${hidden ? ' aria-hidden="true"' : ""}><span class="disc c-${a.toLowerCase()}">${a[0]}</span>${a}</li>`;
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

/** The band's card: the refund that has waited longest for someone to execute it. */
function paintWaiting(): void {
  const card = $("waiting");
  if (!board) {
    if (boardBusy) card.innerHTML = '<p class="eyebrow">Right now, on chain</p><p class="say">NEAR’s public servers are busy, so the bridge contracts could not be read just now. The refund page reads them again.</p>';
    return;
  }
  const first = board.rows.find((r) => r.state === "ready");
  card.innerHTML = first
    ? `<p class="eyebrow">Right now, on chain</p><p class="big">${(first.amountSat / 1e8).toFixed(4)} ${UTXO_CHAINS[first.chain].unit}</p><p class="say">ready to go home for <b>${describeDuration(first.readyForSec)}</b>. The refund was requested, the lock passed, and nobody has pressed the button.</p><p class="addr">refund address ${esc(first.refundTo)}</p>`
    : '<p class="eyebrow">Right now, on chain</p><p class="say">No refund is waiting to be executed right now.</p>';
}

void readBlock();
void readBoard();
setInterval(() => void readBlock(), 8_000);
setInterval(() => void readBoard(), 60_000);
setInterval(paint, 1_000);
