// The refund page: a Bitcoin or Zcash deposit's hash → checkBtcDeposit (from the browser) → whether the bridge
// credited it and, if not, the bridge's own refund steps; below, every refund request the Omni bridges hold, read live.

import { checkBtcDeposit, checkRefundBoard, publicUtxoRefundClients } from "../src/btc-refund.js";
import { renderBtcRefundHtml, renderRefundBoardHtml } from "../src/render-btc-refund-html.js";
import { esc } from "../src/render-html.js";
import { errorHtml, fromHash, goTo, nowSec, wireCopyButtons } from "./shared.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const input = $<HTMLInputElement>("q");
const go = $<HTMLButtonElement>("go");
const out = $<HTMLDivElement>("out");
const board = $<HTMLDivElement>("board");
const clients = publicUtxoRefundClients();

/** A hash, or `hash:vout` for one output (the board and the bot link deposits that way). */
function parse(q: string): { txid: string; vout?: number } {
  const m = /^([0-9a-fA-F]{64})(?::(\d{1,5}))?$/.exec(q.trim());
  if (!m?.[1]) return { txid: q.trim() };
  return { txid: m[1].toLowerCase(), ...(m[2] ? { vout: Number(m[2]) } : {}) };
}

let running = 0;

async function run(query: string): Promise<void> {
  const q = query.trim();
  if (!q) return;
  const id = ++running;
  input.value = q;
  go.disabled = true;
  out.innerHTML = '<p class="status-line">Reading the chain and the bridge…</p>';
  try {
    const { txid, vout } = parse(q);
    const r = await checkBtcDeposit(txid, clients, nowSec(), vout);
    if (id !== running) return;
    out.innerHTML = "error" in r ? `<div class="error">${esc(r.error)}</div>` : renderBtcRefundHtml(r, nowSec());
  } catch (e) {
    if (id !== running) return;
    out.innerHTML = errorHtml(e);
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
  const retry = ev.target instanceof Element ? ev.target.closest("button[data-retry]") : null;
  if (retry) void run(fromHash() || input.value);
});
wireCopyButtons(out);

function fromLink(): void {
  const q = fromHash();
  if (!q) return;
  void run(q);
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}
window.addEventListener("hashchange", fromLink);
fromLink();

async function readBoard(): Promise<void> {
  try {
    board.innerHTML = renderRefundBoardHtml(await checkRefundBoard(clients, nowSec()), nowSec());
  } catch (e) {
    board.innerHTML = errorHtml(e);
  }
}
board.addEventListener("click", (ev) => {
  const retry = ev.target instanceof Element ? ev.target.closest("button[data-retry]") : null;
  if (retry) {
    board.innerHTML = '<p class="status-line">Reading the bridge contracts…</p>';
    void readBoard();
  }
});
void readBoard();
