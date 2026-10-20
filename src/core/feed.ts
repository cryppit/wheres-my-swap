// The live order feed's pure part: what transactions did to accounts inside NEAR Intents, read from intents.near's own
// events (NEP-297 logs), and which orders belong to an integrator that is watched by its fee account or referral tag.
// Transfers come from dip4 `transfer` only: the nep245 `mt_transfer` beside it moves the same tokens. Withdrawals come
// from dip4 `*_withdraw`, not the `mt_burn` that accompanies them.

import type { NepEvent, TxRecord } from "./decode.js";

export const INTENTS = "intents.near";

export type ActivityKind = "deposit" | "refund" | "swap" | "transfer_in" | "transfer_out" | "withdraw";

export interface OrderActivity {
  /** The account inside intents.near the activity is for: an order account, a solver, a user, a fee collector. */
  account: string;
  kind: ActivityKind;
  tx: string;
  height: number | null;
  timestampNs: bigint | null;
  /** Token id → amount in base units; a swap's are signed (what the account gave is negative). */
  tokens: Record<string, string>;
  /** transfer_out: the receiver; transfer_in: the sender; withdraw: the contract the tokens go through. */
  counterparty?: string;
  /** withdraw: the recipient the withdrawal's message names on another chain (`sol:8NHd…`), when it names one. */
  destination?: string;
  /** swap: the referral tag on the account's token diff. */
  referral?: string;
}

/** Integrators to follow: by the fee accounts they registered, or by their referral tags. */
export interface Watch {
  feeAccounts?: readonly string[];
  referrals?: readonly string[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function amounts(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [token, amount] of Object.entries(v)) if (typeof amount === "string") out[token] = amount;
  return out;
}

function zipped(ids: unknown, values: unknown): Record<string, string> {
  if (!Array.isArray(ids) || !Array.isArray(values)) return {};
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    const amount = values[i];
    if (typeof id === "string" && typeof amount === "string") out[id] = amount;
  });
  return out;
}

/** The `recipient` a bridge withdrawal's message names (Omni and PoA put it in `msg` as JSON), if it is one. */
function recipientIn(msg: unknown): string | null {
  const text = str(msg);
  if (!text?.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? str((parsed as Record<string, unknown>)["recipient"]) : null;
  } catch {
    return null;
  }
}

function fromEvent(e: NepEvent, at: Pick<OrderActivity, "tx" | "height" | "timestampNs">): OrderActivity[] {
  const out: OrderActivity[] = [];
  for (const d of e.data) {
    if (e.standard === "nep245" && e.event === "mt_mint") {
      const owner = str(d["owner_id"]);
      if (owner) out.push({ account: owner, kind: d["memo"] === "refund" ? "refund" : "deposit", ...at, tokens: zipped(d["token_ids"], d["amounts"]) });
      continue;
    }
    if (e.standard !== "dip4") continue;
    const account = str(d["account_id"]);
    if (!account) continue;
    if (e.event === "token_diff") {
      const referral = str(d["referral"]);
      out.push({ account, kind: "swap", ...at, tokens: amounts(d["diff"]), ...(referral ? { referral } : {}) });
    } else if (e.event === "transfer") {
      const receiver = str(d["receiver_id"]);
      if (!receiver) continue;
      const tokens = amounts(d["tokens"]);
      out.push({ account, kind: "transfer_out", ...at, tokens, counterparty: receiver });
      out.push({ account: receiver, kind: "transfer_in", ...at, tokens, counterparty: account });
    } else if (e.event === "ft_withdraw" || e.event === "native_withdraw" || e.event === "mt_withdraw") {
      const receiver = str(d["receiver_id"]);
      const tokens =
        e.event === "ft_withdraw"
          ? { [`nep141:${str(d["token"]) ?? "?"}`]: str(d["amount"]) ?? "0" }
          : e.event === "native_withdraw"
            ? { "nep141:wrap.near": str(d["amount"]) ?? "0" }
            : Object.fromEntries(Object.entries(zipped(d["token_ids"], d["amounts"])).map(([id, a]) => [`nep245:${str(d["token"]) ?? "?"}:${id}`, a]));
      const destination = recipientIn(d["msg"]);
      out.push({ account, kind: "withdraw", ...at, tokens, ...(receiver ? { counterparty: receiver } : {}), ...(destination ? { destination } : {}) });
    }
  }
  return out;
}

/** Every activity in these transactions, in the order intents.near logged it; failed receipts did nothing. */
export function orderActivity(txs: readonly TxRecord[]): OrderActivity[] {
  const out: OrderActivity[] = [];
  for (const tx of txs) {
    const at = { tx: tx.hash, height: tx.height, timestampNs: tx.timestampNs };
    for (const e of tx.events) if (e.executor === INTENTS && !e.failed) out.push(...fromEvent(e, at));
  }
  return out;
}

/** The accounts that, in the same transaction, paid a watched fee account or swapped under a watched referral. */
export function watchedOrders(acts: readonly OrderActivity[], watch: Watch): string[] {
  const fees = new Set(watch.feeAccounts ?? []);
  const refs = new Set(watch.referrals ?? []);
  const found = new Set<string>();
  for (const a of acts) {
    if (a.kind === "transfer_out" && a.counterparty !== undefined && fees.has(a.counterparty)) found.add(a.account);
    if (a.kind === "swap" && a.referral !== undefined && refs.has(a.referral)) found.add(a.account);
  }
  return [...found];
}
