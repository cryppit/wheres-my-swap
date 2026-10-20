// The ZEC route page's HTML: one sentence on whether the newest ZEC withdrawals from NEAR Intents reached Zcash, then
// a table of them, each linked to its full trace. Everything the chain says is escaped.

import { describeDuration, type PayoutHop } from "./core/trace.js";
import { accountKind, routeStatus, zecAddressKind, zecAmount, type ZecRouteRow, type ZecRouteSummary } from "./core/zec-route.js";
import { esc } from "./render-html.js";
import type { ZecRouteResult } from "./zec-route.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "18 Oct, 12:42 UTC". */
function utc(ns: bigint | null): string {
  if (ns === null) return "unknown time";
  const d = new Date(Number(ns / 1_000_000n));
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}, ${hh}:${mm} UTC`;
}

/** The first 8 and last 6 characters of an address, without the `zcash:` prefix. */
function short(destination: string | null): string {
  const a = destination?.replace(/^zcash:/, "") ?? "";
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

function summaryHtml(s: ZecRouteSummary, scanned: number): string {
  if (s.checked === 0) return `<p class="route-summary">No withdrawal to Zcash among the newest ${scanned} transactions of the ZEC token. Check again in a few minutes.</p>`;
  const speed =
    s.medianDelaySec === null
      ? ""
      : ` (median ${describeDuration(s.medianDelaySec)} from the withdrawal on NEAR to the payout on Zcash${s.slowestDelaySec !== null && s.slowestDelaySec !== s.medianDelaySec ? `; the slowest ${describeDuration(s.slowestDelaySec)}` : ""})`;
  const open = [
    s.waiting ? `${s.waiting} ${s.waiting === 1 ? "is" : "are"} on ${s.waiting === 1 ? "its" : "their"} way.` : "",
    s.notFound ? `<b>${s.notFound} not found</b> yet.` : "",
    s.unverified ? `${s.unverified} could not be checked.` : "",
  ].filter(Boolean);
  return `<p class="route-summary">Of the last <b>${s.checked}</b> ZEC withdrawals from NEAR Intents to Zcash, <b>${s.arrived} arrived</b>${speed}.${open.length ? ` ${open.join(" ")}` : ""}</p>`;
}

function payoutCell(p: PayoutHop): string {
  const status = routeStatus(p);
  if (p.status === "arrived") {
    const after = p.delaySec === null ? "" : ` in ${describeDuration(p.delaySec)}`;
    const pool = p.how === "shielded" ? `, shielded${p.shieldedPool ? ` (${esc(p.shieldedPool)})` : ""}` : "";
    return `<td class="hi">Arrived${after}${pool}</td>`;
  }
  if (p.status === "waiting") return `<td>On its way, ${describeDuration(p.waitedSec)} so far</td>`;
  if (p.status === "not_found") return `<td class="warn">Not found after ${describeDuration(p.waitedSec)}</td>`;
  const busy = p.status === "unverified" && /blockchair/i.test(p.reason ?? "") && /HTTP (402|429)/.test(p.reason ?? "");
  const why = busy ? "the Zcash data source (Blockchair) has hit its free limit, try again in a few minutes" : p.status === "unverified" ? p.reason : undefined;
  const reason = why ? `: ${esc(why)}` : "";
  return status === "unverified" ? `<td>Could not check${reason}</td>` : "<td></td>";
}

function rowHtml(r: ZecRouteRow): string {
  const w = r.withdrawal;
  const from = accountKind(r.account) === "order account" ? "1Click order" : esc(r.account);
  return `<tr><td>${utc(w.timestampNs)}</td><td><b>${esc(zecAmount(w.amount))} ZEC</b><br /><span class="small">from ${from}</span></td><td>${esc(zecAddressKind(w.destination))} <code>${esc(short(w.destination))}</code></td>${payoutCell(r.payout)}<td><a href="/#q=${esc(w.tx)}">Trace</a></td></tr>`;
}

export function renderZecRouteHtml(r: ZecRouteResult): string {
  const source = `<p class="note">Read live at ${utc(r.checkedAtNs)} from public data: NEAR (FastNEAR), the Omni bridge's indexer and contracts, and the Zcash chain (Blockchair). The newest ${r.scanned} transactions of the ZEC token (zec.omft.near) were read; nothing is stored.</p>`;
  if (r.rows.length === 0) return `${summaryHtml(r.summary, r.scanned)}${source}`;
  const table = `<div class="board-wrap"><table class="board"><caption class="sr-only">The newest ZEC withdrawals from NEAR Intents to Zcash, read ${utc(r.checkedAtNs)}</caption><thead><tr><th>Withdrawn</th><th>Amount</th><th>To</th><th>Payout on Zcash</th><th>Trace</th></tr></thead><tbody>${r.rows.map(rowHtml).join("")}</tbody></table></div>`;
  return `${summaryHtml(r.summary, r.scanned)}${table}${source}`;
}
