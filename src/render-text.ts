// Plain-text report, used by the CLI and the page's "copy report" button.

import type { CheckResult } from "./check.js";
import { chainName } from "./core/chains.js";
import { supportMessage, whoCanMove } from "./core/custody.js";
import { NEARBLOCKS_LINK } from "./core/nearblocks.js";
import { payoutEvidence } from "./core/payout.js";
import { bounceCause, creditSource, describeDuration, payoutTransfer } from "./core/trace.js";
import { groupDigits } from "./core/views.js";

export const whenUtc = (ns: bigint | null): string => (ns === null ? "?" : new Date(Number(ns / 1_000_000n)).toISOString().replace("T", " ").slice(0, 19) + " UTC");
const amt = (token: string, raw: string): string => `${raw} ${token.replace(/^nep141:/, "")}`;

export function renderText(r: CheckResult): string {
  const lines: string[] = [];
  lines.push(`Order account  ${r.account}`);
  if (r.foundBy) {
    const f = r.foundBy;
    const via =
      f.via === "omni"
        ? `the Omni bridge's record of it, ${f.depositTx ? `credited on NEAR in ${f.depositTx}` : "not credited on NEAR yet"}`
        : f.depositTx
          ? `the NEAR deposit ${f.depositTx} that names it`
          : "the Omni bridge's record of the deposit address it paid";
    lines.push(`Found from     your ${chainName(f.chain)} transaction ${f.originTx}, through ${via}`);
  }
  if (r.historySource === "nearblocks") {
    lines.push(`History from   NearBlocks, because FastNEAR was unavailable. Powered by Nearblocks.io APIs (${NEARBLOCKS_LINK})`);
    lines.push("               NearBlocks lists only transactions that moved this order's tokens: a deposit not credited yet does not show here.");
  }
  lines.push(`Verdict        ${r.verdict.toUpperCase()}   (${r.txCount} NEAR transactions read; 1Click would say ${r.oneClickStatus}${r.verdict === "confidential" ? ", or SUCCESS once the private leg has delivered" : ""})`);
  lines.push("");
  const o = r.origin;
  if (o.status === "proven") lines.push(`1 Origin       proven   ${o.chain}  ${"txHash" in o ? o.txHash : `nonce ${o.originNonce}`}  (${o.how})`);
  else if (o.status === "unverified") lines.push(`1 Origin       unverified  ${o.how}`);
  else lines.push("1 Origin       missing");
  for (const d of r.deposits) {
    const source = creditSource(d);
    lines.push(`2 Credit       proven   ${amt(d.token, d.amount)}  at ${whenUtc(d.timestampNs)}  tx ${d.tx}${source ? `  (${source})` : ""}`);
  }
  if (r.deposits.length === 0) lines.push("2 Credit       missing");
  for (const s of r.swaps) {
    const gave = Object.entries(s.gave).map(([t, a]) => amt(t, a)).join(" + ");
    const got = Object.entries(s.got).map(([t, a]) => amt(t, a)).join(" + ");
    lines.push(`3 Swap         proven   ${gave} -> ${got}  at ${whenUtc(s.timestampNs)}  tx ${s.tx}${s.referral ? `  referral ${s.referral}` : ""}`);
    if (s.counterparties.length) lines.push(`               solvers  ${s.counterparties.join(", ")}`);
  }
  if (r.swaps.length === 0) lines.push("3 Swap         missing");
  const paidBy = payoutTransfer(r)?.transfer;
  for (const t of r.transfers) lines.push(`  Transfer     proven   ${Object.entries(t.tokens).map(([k, a]) => amt(k, a)).join(" + ")} -> ${t.to}${t.toLabel ? ` (${t.toLabel})` : ""}  at ${whenUtc(t.timestampNs)}${t === paidBy ? "  (the payout)" : ""}`);
  for (const w of r.withdrawals) {
    const back = w.returned
      ? `  RETURNED: the transfer out failed and ${amt(w.token, w.returned)} came back`
      : w.refused
        ? "  REFUSED: the transfer to the bridge failed and was not credited back"
        : w.bounced
          ? `  BOUNCED: ${bounceCause(w.bounced)}${w.bounced.reason === "transfer_failed" ? "; NEAR returned it to intents.near" : ""}`
          : w.excessRefund
            ? "  (unused input refunded to the refund address)"
            : "";
    lines.push(`4 Withdrawal   proven   ${amt(w.token, w.amount)} -> ${w.chain ?? "?"} ${w.destination ?? "?"}  at ${whenUtc(w.timestampNs)}  tx ${w.tx}${back}`);
  }
  if (r.withdrawals.length === 0) lines.push("4 Withdrawal   missing");
  const p = r.payout;
  const at = p.status === "missing" ? "" : `${p.chain ?? "?"} ${p.destination ?? "?"}`;
  if (p.status === "arrived" && p.how === "recorded") lines.push(`5 Payout       recorded  ${at}  paid per its Omni bridge contract (destination nonce ${p.destinationNonce}); the indexer names no transaction yet`);
  else if (p.status === "arrived") lines.push(`5 Payout       ${p.how}  ${at}  tx ${p.tx}  ${p.via === "transfer" ? "inside NEAR Intents" : p.delaySec === null ? "unconfirmed" : `${describeDuration(p.delaySec)} after the withdrawal`}${p.how === "matched" ? " (amount and time)" : p.how === "confirmed" ? " (named by the bridge)" : p.how === "shielded" ? ` (named by the bridge, into the ${p.shieldedPool ?? "shielded"} pool)` : ""}`);
  else if (p.status === "ambiguous") lines.push(`5 Payout       ambiguous  ${at}  ${p.txs.length} transfers fit: ${p.txs.join(", ")}`);
  else if (p.status === "waiting") lines.push(`5 Payout       not seen yet  ${at}  ${describeDuration(p.waitedSec)} since the withdrawal`);
  else if (p.status === "not_found") lines.push(`5 Payout       NOT FOUND  ${at}  nothing arrived in ${describeDuration(p.waitedSec)}`);
  else if (p.status === "unverified") lines.push(`5 Payout       unverified  ${p.reason ?? (p.bridge === "poa" ? "PoA bridge pays from a custodial wallet; check the destination on its explorer" : "check the destination chain")}  (${at})`);
  else lines.push(`5 Payout       missing${r.withdrawals.length ? "  nothing was paid out: the withdrawal did not reach its destination" : ""}`);
  for (const e of payoutEvidence(p).slice(p.status === "arrived" ? 1 : 0)) lines.push(`               ${e}`);
  lines.push("");
  const balances = Object.entries(r.balances);
  lines.push(`Still in the order account: ${balances.length ? balances.map(([t, a]) => amt(t, a)).join(", ") : "nothing"}`);
  const bc = r.balanceCheck;
  if (bc?.status === "not_verified") lines.push(`Not checked against intents.near: ${bc.reason}.`);
  else if (bc) {
    const holds = bc.status === "verified" ? "it holds the same for this account" : `it holds ${bc.differences.map((d) => amt(d.token, d.chain)).join(", ")} for this account, not what the history adds up to (see the flag)`;
    lines.push(`Checked against intents.near at block ${groupDigits(bc.blockHeight)} (${bc.blockHash}): ${holds}.`);
  }
  for (const f of r.flags) {
    if (f.kind === "stalled") lines.push(`FLAG stalled       ${f.detail} (${describeDuration(f.waitedSec)})`);
    else if (f.kind === "settled_late") lines.push(`FLAG settled late  ${f.detail}`);
    else if (f.kind === "confidential") lines.push(`FLAG confidential   ${f.detail}`);
    else if (f.kind === "later_deposit") lines.push(`FLAG later deposit  ${f.detail}`);
    else if (f.kind === "dust") lines.push(`FLAG dust          ${f.detail}`);
    else if (f.kind === "several_orders") lines.push(`FLAG several orders  ${f.detail}`);
    else if (f.kind === "own_key") lines.push(`FLAG own key       ${f.detail}`);
    else if (f.kind === "incomplete_history") lines.push(`FLAG incomplete    ${f.detail}`);
    else if (f.kind === "payout_not_found") lines.push(`FLAG payout not found  ${f.detail} (${describeDuration(f.waitedSec)})`);
    else if (f.kind === "withdrawal_returned") lines.push(`FLAG withdrawal returned  ${f.detail}`);
    else if (f.kind === "withdrawal_refused") lines.push(`FLAG withdrawal refused  ${f.detail}`);
    else if (f.kind === "payout_bounced") lines.push(`FLAG payout bounced  ${f.detail}`);
    else if (f.kind === "executing") lines.push(`FLAG executing     ${f.detail}`);
    else if (f.kind === "destination_missing") lines.push(`FLAG no such account  ${f.detail}`);
    else if (f.kind === "ledger_mismatch") lines.push(`FLAG ledger mismatch  ${f.detail}`);
    else if (f.kind === "locked") lines.push(`FLAG locked        ${f.detail} (${describeDuration(f.waitedSec)})`);
    else lines.push(`FLAG refunded      ${f.detail}`);
  }
  const c = whoCanMove(r);
  lines.push("", `Where it is    ${c.holds}`, `Who can move   ${c.canMove}`, `What to do     ${c.next}`);
  if (c.needsHelp) lines.push("", "Support message (copy and send):", "", supportMessage(r, c, { link: null, amount: amt }));
  return lines.join("\n");
}
