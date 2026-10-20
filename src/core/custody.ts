// Where an order's money is now and who can move it, in plain words, from the traced hops alone. A 1Click order account
// is keyed by 1Click, so money resting there moves only when 1Click acts, unless intents.near's operators locked the
// account: then only they can; a withdrawal in flight is the bridge's to pay; money that arrived sits in the destination
// wallet. Plus the support message a user can send with the evidence.

import { bounceCause, payingWithdrawal, type OrderReport, type WithdrawHop } from "./trace.js";
import { canCreate } from "./views.js";

export type CustodyPlace = "not_on_near" | "order_account" | "with_bridge" | "intents_contract" | "arrived" | "returned" | "confidential" | "executing";

export interface Custody {
  place: CustodyPlace;
  /** Where the money is, in one sentence. */
  holds: string;
  /** Who can move it. */
  canMove: string;
  /** What the user should do. */
  next: string;
  /** The referral tag on the swap: the app the order came through. */
  app: string | null;
  /** The user should send the support message. */
  needsHelp: boolean;
}

const BRIDGE_NAME = { poa: "the PoA bridge", omni: "the Omni bridge", hot: "the HOT bridge", near: "NEAR itself", unknown: "a bridge we could not identify" } as const;
const BRIDGE_HOLDER = {
  poa: "The PoA bridge's operator, which pays withdrawals from its own wallets.",
  omni: "The Omni bridge: NEAR's MPC network signs the transfer, then a relayer delivers it on the destination chain.",
  hot: "The HOT bridge's operator, which pays withdrawals out on the destination chain.",
  near: "Nobody needs to: a NEAR payout is part of the withdrawal itself.",
  unknown: "The bridge that carried the withdrawal.",
} as const;

export type AmountFormat = (token: string, raw: string) => string;
const rawAmount: AmountFormat = (token, raw) => `${raw} ${token}`;

const INTENTS_ONLY = "only NEAR Intents, which runs intents.near, when 1Click asks it to";

/** Where a withdrawal that never arrived is: refused by the bridge's token transfer, or a NEAR payout that bounced. */
function lostHolds(w: WithdrawHop, amount: AmountFormat): string {
  const what = amount(w.token, w.amount);
  const b = w.bounced;
  if (!b) return `The withdrawal of ${what} failed on its way to ${BRIDGE_NAME[w.bridge]}: the token's transfer to it failed, and NEAR Intents does not credit a failed transfer back, so the tokens stay with intents.near, outside the order account.`;
  const dest = w.destination ?? "the destination";
  if (b.reason === "unwrap_failed") return `The withdrawal of ${what} to ${dest} failed inside intents.near (its ${b.step ?? "do_native_withdraw"} step), so nothing was sent, and intents.near does not credit a failed NEAR payout back: it stays there, outside the order account.`;
  return `NEAR could not deliver ${what} to ${dest} (${bounceCause(b)}), so it sent it back to intents.near, not to your order account. intents.near does not credit a failed NEAR payout back, so it stays there, outside the order account.`;
}

/** A sentence carried on after a colon: lower-case its first word unless it is a name. */
const continued = (s: string): string => (/^(NEAR|intents\.near)\b/.test(s) ? s : `${s.charAt(0).toLowerCase()}${s.slice(1)}`);

/** `amount` formats a raw token amount for display (default: the raw amount and token id). */
export function whoCanMove(r: OrderReport, amount: AmountFormat = rawAmount): Custody {
  const app = r.swaps.find((s) => s.referral)?.referral ?? null;
  const stalled = r.flags.some((f) => f.kind === "stalled");
  const base = { app };

  const executing = r.flags.find((f) => f.kind === "executing");
  if (executing?.kind === "executing") {
    return {
      ...base,
      place: "executing",
      holds: `NEAR is still executing this order's transaction ${executing.tx}, so where the money ends up is not final yet.`,
      canMove: "Nobody needs to: NEAR finishes a transaction within seconds.",
      next: "Check again in a minute.",
      needsHelp: false,
    };
  }
  if (r.verdict === "not_found") {
    return {
      ...base,
      place: "not_on_near",
      holds: "No deposit for this order reached NEAR Intents.",
      canMove: "Whoever received your deposit on your own chain: the deposit address belongs to the bridge or 1Click, not to NEAR Intents yet.",
      next: "If you sent Bitcoin or Zcash, check your own transaction hash here: the bridge may let you refund it. Otherwise send your deposit transaction to the app you swapped in.",
      needsHelp: true,
    };
  }
  const held = Object.entries(r.balances)
    .map(([token, raw]) => amount(token, raw))
    .join(", ");
  const failedOut = r.withdrawals.find((w) => w.refused || w.bounced);
  if (failedOut && r.verdict === "stuck") {
    return {
      ...base,
      place: "intents_contract",
      holds: lostHolds(failedOut, amount),
      canMove: "Only NEAR Intents, which runs intents.near, when 1Click asks it to: not you, not the app you swapped in, and not us.",
      next: `Send the support message below to the app you swapped in and ask them to escalate to 1Click and NEAR Intents to return it.${failedOut.bounced?.error === "AccountDoesNotExist" ? " NEAR pays only accounts that exist, so check the account name you gave." : ""}`,
      needsHelp: true,
    };
  }
  if (r.verdict === "confidential") {
    return {
      ...base,
      place: "confidential",
      holds: "It moved to NEAR Intents' confidential treasury, which keeps the rest of the route private by design.",
      canMove: "NEAR Intents' confidential flow, on your instructions through the app you used.",
      next: "This is normal for a confidential swap. If the app shows it as failed, ask the app.",
      needsHelp: false,
    };
  }
  const last = payingWithdrawal(r);
  const returned = r.verdict === "refunded";
  const dust = r.flags.some((f) => f.kind === "dust") && held ? ` Dust worth less than 5 US cents stayed in the order account: ${held}.` : "";
  if ((r.verdict === "settled" || r.verdict === "refunded") && !last && r.payout.status === "arrived") {
    // No withdrawal: a transfer inside NEAR Intents paid it, so it sits in the recipient's balance on intents.near.
    const p = r.payout;
    return {
      ...base,
      place: returned ? "returned" : "arrived",
      holds: `It ${returned ? "went back" : "was transferred"} inside NEAR Intents to ${p.destination ?? "another account"} in transaction ${p.tx}: it is in that account's NEAR Intents balance (intents.near), not in a wallet yet.${dust}`,
      canMove: `Whoever holds the key of ${p.destination ?? "that account"}, from its NEAR Intents balance.`,
      next: "Nothing to chase. It shows in the NEAR Intents balance of that account (in the app you swapped in, or near-intents.org), not in a wallet's token list.",
      needsHelp: false,
    };
  }
  if ((r.verdict === "settled" || r.verdict === "refunded") && last) {
    const p = r.payout;
    // Another withdrawal of the order that never arrived (a refund of unused input that bounced) is with intents.near.
    const lost = r.withdrawals.find((w) => w !== last && (w.refused || w.bounced));
    const lostLine = lost ? ` ${lost.excessRefund ? "The refund of your unused input" : "Another withdrawal"} did not arrive: ${continued(lostHolds(lost, amount))}` : "";
    const lostMove = lost ? ` For the part that did not arrive: ${INTENTS_ONLY}.` : "";
    const lostNext = "Send the support message below to the app you swapped in and ask them to escalate to 1Click and NEAR Intents to return the part that did not arrive.";
    const missing = r.flags.find((f) => f.kind === "destination_missing");
    if (p.status === "arrived" && missing?.kind === "destination_missing") {
      // Credited to a name nobody has created: in nobody's wallet until someone creates the name.
      const dest = missing.account;
      const who = canCreate(dest);
      const anyone = "anyone" in who;
      return {
        ...base,
        place: returned ? "returned" : "arrived",
        holds: `It was paid to ${dest} on near in transaction ${p.tx}, but no NEAR account has that name yet: the token contract holds it under the name, in nobody's wallet.${dust}${lostLine}`,
        canMove: `Whoever creates the account ${dest} first: ${anyone ? `anyone can create ${dest.endsWith(".near") ? "a .near name" : "that name"}` : `only ${who.by} can create it`}.${lostMove}`,
        next: anyone ? `Create ${dest} now,${dest.endsWith(".near") ? " with any NEAR wallet," : ""} before anyone else does: the tokens are then yours.` : `Ask whoever controls ${who.by} to create ${dest} for you, or send the support message below to the app you swapped in.`,
        needsHelp: !anyone || lost !== undefined,
      };
    }
    if (p.status === "arrived" && p.how === "recorded") {
      return {
        ...base,
        place: "arrived",
        holds: `It was paid out to ${p.destination ?? "the destination"} on ${p.chain ?? "the destination chain"}: the Omni bridge contract there records this transfer (destination nonce ${p.destinationNonce}) as paid. The bridge's indexer has not named the transaction yet, so there is none to link.${dust}${lostLine}`,
        canMove: lost ? `The owner of that wallet.${lostMove}` : "The owner of that wallet. Nothing is held for you anywhere else.",
        next: lost ? lostNext : "Nothing to chase. If your wallet does not show it, check that it is set to the right network and token.",
        needsHelp: lost !== undefined,
      };
    }
    if (p.status === "arrived") {
      const holds =
        p.how === "shielded"
          ? `It was paid into Zcash's ${p.shieldedPool ?? "shielded"} shielded pool for ${p.destination ?? "your address"} in transaction ${p.tx}. A shielded payment hides its recipient on the chain, so your wallet is where it shows.`
          : `It ${returned ? "came back" : "arrived"} at ${p.destination ?? "the destination"} on ${p.chain ?? "the destination chain"} in transaction ${p.tx}.`;
      return {
        ...base,
        place: returned ? "returned" : "arrived",
        holds: `${holds}${dust}${lostLine}`,
        canMove: lost ? `The owner of that wallet.${lostMove}` : "The owner of that wallet. Nothing is held for you anywhere else.",
        next: lost ? lostNext : "Nothing to chase. If your wallet does not show it, check that it is set to the right network and token.",
        needsHelp: lost !== undefined,
      };
    }
    const report = "bridgeReport" in p ? p.bridgeReport : undefined;
    const paidIn = report?.fastTx ?? report?.tx;
    const said = !report ? "" : report.source === "omni" || report.source === "hot" ? ` Its indexer reports the transfer as ${report.status}${paidIn ? `, paid out in ${paidIn}` : ""}.` : ` Its status API says: ${report.status}.`;
    const seen =
      p.status === "waiting"
        ? "is on its way: payouts usually land within 30 minutes (Bitcoin 60)"
        : p.status === "ambiguous"
          ? "two transfers on the destination chain could be it"
          : p.status === "not_found"
            ? "has not been seen arriving"
            : "we could not check whether it arrived";
    return {
      ...base,
      place: "with_bridge",
      holds: `It left NEAR Intents toward ${last.destination ?? "your address"} on ${last.chain ?? "the destination chain"}, through ${BRIDGE_NAME[last.bridge]}, and ${seen}.${lostLine}`,
      canMove: `${BRIDGE_HOLDER[last.bridge]}${said}${lostMove}`,
      next: p.status === "not_found" ? "Send the support message below to the app you swapped in and ask them to chase the bridge." : lost ? lostNext : "Check your destination wallet; if nothing arrives, check again here.",
      needsHelp: p.status === "not_found" || lost !== undefined,
    };
  }
  // 1Click order accounts are implicit (64 hex) and keyed by 1Click; any other shape, or one that signs its own
  // transactions, is an account its owner uses directly.
  const ownKey = r.flags.some((f) => f.kind === "own_key");
  const oneClickAccount = /^[0-9a-f]{64}$/.test(r.account) && !ownKey;
  // An account intents.near's operators locked cannot move its own balances, whoever holds its key.
  const locked = r.flags.find((f) => f.kind === "locked");
  if (locked?.kind === "locked") {
    const where = oneClickAccount ? `the order account ${r.account} on NEAR Intents (intents.near)` : `the NEAR Intents account ${r.account} (intents.near)`;
    return {
      ...base,
      place: "order_account",
      holds: `It is in ${where}${held ? `: ${held}` : ""}. intents.near locked that account in transaction ${locked.tx}, so it cannot move its own balances.`,
      canMove: `Only the NEAR Intents operators, who run intents.near: a locked account cannot move its own balances, so not even ${oneClickAccount ? "1Click, which holds its key," : "whoever holds its key"} can move it until they unlock it or move the funds. Not you, not the app you swapped in, and not us.`,
      next: "Send the support message below to the app you swapped in and ask them to escalate to NEAR Intents: only its team can say why the account is locked, and release or return the money. Never pay anyone who offers to unlock it.",
      needsHelp: true,
    };
  }
  if (!oneClickAccount) {
    return {
      ...base,
      place: "order_account",
      holds: `It is in the NEAR Intents account ${r.account} (intents.near)${held ? `: ${held}` : ""}.`,
      canMove: ownKey ? "Whoever holds this account's key: it signs its own transactions, so it is not a 1Click order account." : "Whoever holds this account's wallet key: it is a NEAR Intents user account, not a 1Click order account.",
      next: "Withdraw it with the wallet or app that holds this account's key.",
      needsHelp: false,
    };
  }
  return {
    ...base,
    place: "order_account",
    holds: `It is in the order account ${r.account} on NEAR Intents (intents.near)${held ? `: ${held}` : ""}.`,
    canMove: "Only 1Click. It holds this order account's key: not you, not the app you swapped in, and not us.",
    next: stalled
      ? "Send the support message below to the app you swapped in and ask them to escalate to 1Click for the swap or a refund to your refund address."
      : "This usually moves on within minutes. If it has not after an hour, check again: we will flag it as stalled.",
    needsHelp: stalled || r.verdict === "stuck",
  };
}

export interface SupportMessageOptions {
  /** A link to this report. */
  link: string | null;
  amount?: AmountFormat;
}

/** A message the user can paste to the app's support: facts only, with the evidence link. */
export function supportMessage(r: OrderReport, c: Custody, o: SupportMessageOptions): string {
  const amount = o.amount ?? rawAmount;
  const lines = ["Hello, my swap through NEAR Intents needs help.", "", `Order account: ${r.account}`];
  for (const d of r.deposits) lines.push(`Deposited: ${amount(d.token, d.amount)} (NEAR transaction ${d.tx})`);
  if (c.app) lines.push(`Swapped through: ${c.app}`);
  const w = payingWithdrawal(r);
  if (w) lines.push(`Withdrawn: ${amount(w.token, w.amount)} to ${w.destination ?? "?"} on ${w.chain ?? "?"} (NEAR transaction ${w.tx})`);
  for (const f of r.withdrawals) if (f !== w && (f.refused || f.bounced)) lines.push(`Withdrawn: ${amount(f.token, f.amount)} to ${f.destination ?? "?"} on ${f.chain ?? "?"} (NEAR transaction ${f.tx}), which did not arrive`);
  lines.push(`Where it is now: ${c.holds}`, `Who can move it: ${c.canMove}`);
  if (o.link) lines.push(`Evidence: ${o.link}`);
  lines.push("");
  const asks: string[] = [];
  const bounced = r.withdrawals.find((f) => f.bounced);
  if (bounced?.bounced) {
    const dest = bounced.destination ?? "the destination";
    asks.push(
      bounced.bounced.reason === "unwrap_failed"
        ? `Could you please escalate this to 1Click and NEAR Intents? intents.near's own payout step (${bounced.bounced.step ?? "do_native_withdraw"}) failed, so the withdrawal to ${dest} was never sent and was not credited back to the order account.`
        : `Could you please escalate this to 1Click and NEAR Intents? NEAR could not deliver the withdrawal to ${dest} (${bounceCause(bounced.bounced)}) and returned it to intents.near, which did not credit it back to the order account.`,
    );
  }
  if (r.withdrawals.some((f) => f.refused)) asks.push("Could you please escalate this to 1Click and NEAR Intents? The withdrawal's transfer to the bridge failed and the tokens were not credited back to the order account.");
  const missing = r.flags.find((f) => f.kind === "destination_missing");
  if (missing?.kind === "destination_missing") asks.push(`Could you please help me claim it? The payout went to ${missing.account}, a name no NEAR account has yet, so the token contract holds it under that name until someone creates the account.`);
  const locked = r.flags.find((f) => f.kind === "locked");
  if (locked?.kind === "locked") asks.push(`Could you please escalate this to NEAR Intents? intents.near locked the order account in transaction ${locked.tx}, so it cannot move its own balances, and only NEAR Intents can release or return the money.`);
  if (c.place === "with_bridge" && (asks.length === 0 || r.payout.status === "not_found")) asks.push("Could you please ask the bridge to complete this withdrawal, or tell me its status?");
  if (asks.length === 0) asks.push("Could you please escalate this to 1Click to complete the swap or refund it to my refund address?");
  lines.push(asks.join(" "));
  return lines.join("\n");
}
