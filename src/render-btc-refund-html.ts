// The refund page's report for a Bitcoin or Zcash deposit, as HTML: the verdict, the deposit's facts and the steps
// left, each command with a copy button (the page wires `data-copy`), and the board of open refund requests. Pure
// string building; everything that came from a chain, an API or the user is escaped.

import type { BtcDepositReport } from "./btc-refund.js";
import { REQUEST_WINDOW, unreachableLock, UTXO_CHAINS, type BoardRow, type UtxoChain } from "./core/btc-refund.js";
import { describeDuration } from "./core/trace.js";
import { feeLine, fromWhom, named, poolName, requestedOnUnreachableLockLine, requestLines, requestLockSec, unreachableLockLine, zcashRefundLines } from "./render-btc-refund.js";
import { esc, explorerUrl } from "./render-html.js";

type Report = Exclude<BtcDepositReport, { error: string }>;

const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);
const when = (sec: number): string => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const coins = (sat: number, chain: UtxoChain): string => `${(sat / 1e8).toFixed(8)} ${UTXO_CHAINS[chain].unit}`;
const count = (n: number): string => n.toLocaleString("en-US");
const one = (minor: string): string => minor.replace(/s$/, "");

const code = (s: string): string => `<code>${esc(s)}</code>`;
const p = (inner: string): string => `<p>${inner}</p>`;
const lines = (ls: string[]): string => ls.map((l) => p(esc(l))).join("");
const ext = (url: string | null, inner: string): string => (url ? `<a class="ext" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner);
const checker = (q: string, inner: string): string => `<a href="/#q=${esc(encodeURIComponent(q))}">${inner}</a>`;

function verdictHtml(r: Report, nowSec: number): string {
  const v = r.verdict;
  const f = r.facts;
  const { name, unit, minor } = UTXO_CHAINS[f.chain];
  switch (v.state) {
    case "unconfirmed":
      return `<h2>Not confirmed yet</h2>${p(`The bridge counts a deposit only after ${name} confirms it. Check again later.`)}`;
    case "not_a_deposit":
      return `<h2>Not an Omni ${unit} deposit</h2>${p(`No output of this transaction pays a deposit address the Omni bridge knows. A deposit through the PoA bridge is checked by the ${checker(f.txid, "main checker")}.`)}`;
    case "credited":
      return `<h2 class="hi">Credited</h2>${p(`The bridge took this deposit in. ${checker(v.orderAccount, "Follow the order")} to see where the money went next.`)}`;
    case "placeholder_refund":
      return `<h2>Not recoverable by its sender</h2>${p(`The deposit message pins the refund to ${code(v.refundTo)}, a public example address used in documentation, not the depositor’s wallet. The bridge can only refund there, so do not request it. Only the Omni bridge team can recover it.`)}`;
    case "too_old":
      return `<h2>Too old to request</h2>${p(`The bridge’s light client keeps ${esc(REQUEST_WINDOW[f.chain].span)} of ${name} blocks and no longer has this deposit’s (since about ${day(v.requestBySec)}), so ${code("request_refund")} fails. Only the Omni bridge team can recover it.`)}`;
    case "absorbed":
      return `<h2>Absorbed by the bridge</h2>${p(`The bridge verified this deposit, but it is below the ${count(v.minDepositSat)}-${one(minor)} minimum, so nothing was minted on NEAR. The contract keeps the coin and has no refund path for it: ${code("request_refund")} refuses a verified deposit, and no method releases it. Only the Omni bridge team can recover it, with a contract change.`)}`;
    case "refunded":
      return `<h2 class="hi">Refunded</h2>${p(`Sent back to ${code(v.refundTo)} in ${name} transaction ${ext(explorerUrl("tx", f.chain, v.refundTx), code(v.refundTx))}.`)}`;
    case "crediting":
      return `<h2>Crediting</h2>${p(`Not credited yet, which is normal in the first hours. If nothing changes by ${when(v.stuckAfterSec)}, check again for the refund steps.`)}`;
    case "requested": {
      const lock = requestLockSec(r, v.unlocksAtSec);
      return `<h2>Refund requested</h2>${p(`The lock ends on ${when(v.unlocksAtSec)}. After that anyone can execute it.`)}${unreachableLock(lock) ? p(esc(requestedOnUnreachableLockLine(lock))) : ""}${lines(requestLines(r, v.refundTo))}`;
    }
    case "ready":
      return `<h2 class="hi">Ready to refund</h2>${p(`The refund was requested on ${day(f.request?.createdAtSec ?? v.unlockedAtSec)} and its lock ended on ${day(v.unlockedAtSec)}, ${describeDuration(Math.max(0, nowSec - v.unlockedAtSec))} ago. Nobody has executed it yet.`)}${lines(requestLines(r, v.refundTo))}`;
    case "executed":
      return `<h2>Refund executed</h2>${p(`Waiting for the bridge to sign the ${name} refund to ${code(named(f.chain, v.refundTo))} and broadcast it.`)}`;
    case "refundable": {
      const out = [`<h2>Stuck</h2>`, p(`Confirmed ${day(f.confirmedAtSec ?? 0)} and never credited on NEAR.${unreachableLock(v.lockSec) ? "" : " The bridge’s own refund can send it back."}`)];
      if (v.belowMinimum) out.push(p(`It is below the bridge’s ${count(r.config.minDepositSat)}-${one(minor)} minimum deposit, which is likely why it was never credited.`));
      if (v.tooSmall) {
        out.push(p(`It is not larger than the refund fee (${count(v.feeSat)} ${minor}), so the contract would refuse a refund request.`));
        return out.join("");
      }
      if (unreachableLock(v.lockSec)) {
        out.push(p(esc(unreachableLockLine(r, v.lockSec))));
        return out.join("");
      }
      if (v.refundTo === null && v.noTransparentSender) {
        out.push(
          p(
            `This deposit came from ${esc(poolName(f))}, so it has no transparent sender, and it names no refund address. You name the address in the request: use one you control, ideally your own unified address (u1…) with an Orchard receiver so the refund stays shielded. A Sapling-only ${code("zs1")} address cannot be refunded by this contract. The contract cannot check that the address is yours, so this takes the ${Math.round(v.lockSec / 86_400)}-day lock, during which the bridge’s DAO or operator can reject a false claim.`,
          ),
        );
      } else if (v.refundTo === null && v.batchSender) {
        out.push(p("An exchange or service paid this deposit out in a batch, so its sender is that service’s wallet, not yours, and the deposit names no refund address. You name your own address in the request."));
      } else if (v.refundTo === null) {
        out.push(p("Several wallets funded this transaction, so we cannot tell which is yours. The depositor has to name the refund address themselves."));
      } else {
        out.push(p(`${v.refundToFromDeposit ? "The deposit names its refund address" : "The deposit names no refund address; the refund would go to the wallet that sent it"}: ${code(named(f.chain, v.refundTo))}.`));
        if (f.chain === "zcash") out.push(lines(zcashRefundLines(v.refundTo)));
      }
      out.push(p(esc(feeLine(r, f.amountSat, v.feeSat, false))));
      return out.join("");
    }
  }
}

function stepsHtml(r: Report): string {
  if (!r.steps.length) return "";
  const where = r.verdict.state === "refundable" && r.verdict.refundTo === null ? "the address named in the request" : "the address above";
  const items = r.steps
    .map((s, i) => {
      const command = s.command ? `<pre class="cmd">${esc(s.command)}</pre><button type="button" class="ghost" data-copy="${esc(s.command)}">Copy command</button>` : "";
      const note = s.note ? `<p class="hop-note">${esc(s.note)}</p>` : "";
      return `<li><span class="step-n">${i + 1}</span><div class="step-body"><h4>${esc(s.title)}</h4>${command}${note}</div></li>`;
    })
    .join("");
  return [
    `<div class="steps-block"><h3>What is left</h3>`,
    p(`Run each step from your own NEAR account with the official tools (${code("bridge-cli")} and ${code("near")}). Anyone can pay these fees; the coin can only go to ${where}. We never hold keys or sign anything.`),
    `<ol class="steps">${items}</ol>`,
    p(`If the ${code("near")} CLI shows an error or a timeout, look the transaction up on nearblocks.io before sending it again: it may have gone through.`),
    `</div>`,
  ].join("");
}

/** The whole report for one deposit; `nowSec` dates the "ready for" wait. */
export function renderBtcRefundHtml(r: Report, nowSec: number): string {
  const f = r.facts;
  const { name, connector } = UTXO_CHAINS[f.chain];
  const facts = [
    `<dt>${name} deposit</dt><dd>${ext(explorerUrl("tx", f.chain, f.txid), code(f.txid))} (output ${f.vout})</dd>`,
    `<dt>Amount</dt><dd><b>${coins(f.amountSat, f.chain)}</b></dd>`,
    `<dt>From</dt><dd>${code(fromWhom(f))}</dd>`,
    `<dt>To</dt><dd>${code(f.depositAddress)}${f.confirmedAtSec ? `, confirmed ${when(f.confirmedAtSec)}` : ""}</dd>`,
    r.orderAccount ? `<dt>For NEAR account</dt><dd>${checker(r.orderAccount, code(r.orderAccount))}</dd>` : "",
  ].join("");
  const explorer = f.chain === "btc" ? "mempool.space" : "Blockchair";
  return [
    `<section class="report" aria-label="Deposit report">`,
    `<div class="verdict-box">${verdictHtml(r, nowSec)}</div>`,
    `<dl class="facts">${facts}</dl>`,
    stepsHtml(r),
    `<p class="sources">Sources: ${explorer}; the Omni bridge indexer's deposit message, checked against ${connector}; that contract's refund request, timelocks and fees, read live. We never hold keys or sign anything.</p>`,
    `</section>`,
  ].join("");
}

/** Every open refund request on the Omni Bitcoin and Zcash bridges; each deposit links to its own check. */
export function renderRefundBoardHtml(rows: BoardRow[], nowSec: number): string {
  if (rows.length === 0) return '<p class="note">No refund requests are open.</p>';
  const body = rows
    .map((row) => {
      const lock = row.unlocksAtSec - row.requestedAtSec;
      const state =
        row.state === "ready"
          ? `Ready, ${describeDuration(row.readyForSec)}`
          : row.state === "locked"
            ? unreachableLock(lock)
              ? `Locked for ${Math.round(lock / 31_557_600)} years (until ${day(row.unlocksAtSec)})`
              : `Locked until ${day(row.unlocksAtSec)}`
            : "Executed";
      const short = `${row.txid.slice(0, 10)}…${row.txid.slice(-6)}`;
      return `<tr><td${row.state === "ready" ? ' class="hi"' : ""}>${state}</td><td><b>${coins(row.amountSat, row.chain)}</b></td><td>${code(row.refundTo)}</td><td><a href="#q=${esc(`${row.txid}:${row.vout}`)}">${code(short)}</a></td></tr>`;
    })
    .join("");
  const forever = rows.find((row) => row.state === "locked" && unreachableLock(row.unlocksAtSec - row.requestedAtSec));
  const note = forever
    ? `<p class="note">A ${Math.round((forever.unlocksAtSec - forever.requestedAtSec) / 31_557_600)}-year lock is the bridge's lock for a refund whose deposit named no refund address (its unsafe_refund_timelock, read live; 14 days until mid-October 2026): nobody can execute those refunds before then.</p>`
    : "";
  return `<div class="board-wrap"><table class="board"><caption class="sr-only">Open refund requests as of ${when(nowSec)}</caption><thead><tr><th>State</th><th>Amount</th><th>Refund goes to</th><th>Deposit</th></tr></thead><tbody>${body}</tbody></table></div>${note}`;
}
