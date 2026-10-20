// NEAR JSON-RPC view calls the checker makes besides FastNEAR's history, as request bodies and answer parsers, and what
// the answers mean: whether a payout destination exists, and whether intents.near holds what the history adds up to.
// Pure: the calls themselves are in ../near-views.ts.

import type { Flag } from "./trace.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `view_account` at a final block. */
export function viewAccount(account: string): { jsonrpc: "2.0"; id: "wms"; method: "query"; params: { request_type: "view_account"; finality: "final"; account_id: string } } {
  return { jsonrpc: "2.0", id: "wms", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } };
}

/** true: the account exists; false: NEAR says it does not (UNKNOWN_ACCOUNT); null: the answer says neither. */
export function accountExistsFrom(answer: unknown): boolean | null {
  if (!isObj(answer)) return null;
  const result = answer["result"];
  if (isObj(result)) {
    // Older nodes put a query's error inside `result`.
    const legacy = result["error"];
    if (legacy === undefined) return true;
    return typeof legacy === "string" && /does not exist while viewing/.test(legacy) ? false : null;
  }
  const err = answer["error"];
  return isObj(err) && isObj(err["cause"]) && err["cause"]["name"] === "UNKNOWN_ACCOUNT" ? false : null;
}

const NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** Implicit (64 hex), Ethereum-like (0x), deterministic (0s) and universal (0u) accounts. */
const KEYED = /^(?:[0-9a-f]{64}|0x[0-9a-f]{40}|0s[0-9a-f]{40}|0u[0-9a-hjkmnp-tv-z]{51}[0g])$/;

/**
 * A name that whoever creates it controls: a named account. Implicit, 0x, 0s and 0u accounts belong to their key or
 * their code whether they exist yet or not, so nobody else can claim what is paid to them.
 */
export const claimableName = (id: string): boolean => NAMED.test(id) && !KEYED.test(id);

/** nearcore's `min_allowed_top_level_account_length`: shorter top-level names are the registrar's to create. */
const MIN_FREE_TOP_LEVEL = 32;

/**
 * Who can create a named account (docs.near.org /protocol/accounts-contracts/account-id): a `.near` name, anyone,
 * through `near`'s create_account; another sub-account, only its parent account; a top-level name shorter than 32
 * characters, only the `registrar` account (longer ones, anyone).
 */
export function canCreate(name: string): { anyone: true } | { by: string } {
  const dot = name.indexOf(".");
  if (dot < 0) return name.length >= MIN_FREE_TOP_LEVEL ? { anyone: true } : { by: "registrar" };
  const parent = name.slice(dot + 1);
  return parent === "near" ? { anyone: true } : { by: parent };
}

/** JSON as the base64 `args_base64` of a `call_function` view (TextEncoder and btoa: the page runs this too). */
function base64Json(v: unknown): string {
  let s = "";
  for (const b of new TextEncoder().encode(JSON.stringify(v))) s += String.fromCharCode(b);
  return btoa(s);
}

/** A `call_function` view on intents.near, at a final block or at one block (`blockId`: its hash or height). */
export function intentsView(method: string, args: unknown, blockId?: string | number) {
  const at = blockId === undefined ? { finality: "final" as const } : { block_id: blockId };
  return { jsonrpc: "2.0" as const, id: "wms" as const, method: "query" as const, params: { request_type: "call_function" as const, ...at, account_id: "intents.near", method_name: method, args_base64: base64Json(args) } };
}

/** A `call_function` answer: the JSON its `result` bytes hold and the block it was read at; null for anything else. */
export function viewResult(answer: unknown): { value: unknown; blockHeight: number; blockHash: string } | null {
  if (!isObj(answer) || !isObj(answer["result"])) return null;
  const r = answer["result"];
  const bytes = r["result"];
  const height = r["block_height"];
  const hash = r["block_hash"];
  if (!Array.isArray(bytes) || typeof height !== "number" || typeof hash !== "string") return null;
  if (!bytes.every((b): b is number => typeof b === "number" && Number.isInteger(b) && b >= 0 && b < 256)) return null;
  try {
    return { value: JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as unknown, blockHeight: height, blockHash: hash };
  } catch {
    return null;
  }
}

/** The token ids `mt_tokens_for_owner` lists; null when the value is not that list. */
export function tokenIdsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((t) => (isObj(t) && typeof t["token_id"] === "string" ? t["token_id"] : null));
  return ids.every((id): id is string => id !== null) ? ids : null;
}

/** `mt_batch_balance_of`'s amounts by token id, zeros left out; null unless one U128 string per token id. */
export function balancesFrom(tokenIds: readonly string[], value: unknown): Record<string, string> | null {
  if (!Array.isArray(value) || value.length !== tokenIds.length) return null;
  const out: Record<string, string> = {};
  for (const [i, amount] of value.entries()) {
    const token = tokenIds[i];
    if (token === undefined || typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
    if (BigInt(amount) > 0n) out[token] = amount;
  }
  return out;
}

/** An order account's balances inside intents.near at one block (non-zero only). */
export interface ChainBalances {
  blockHeight: number;
  blockHash: string;
  balances: Record<string, string>;
}

export interface BalanceDifference {
  token: string;
  /** What the history adds up to ("0": nothing). */
  ledger: string;
  /** What intents.near holds at the block ("0": nothing). */
  chain: string;
}

/** Every token where the history's balance and intents.near's differ, in token order. */
export function compareBalances(ledger: Readonly<Record<string, string>>, chain: Readonly<Record<string, string>>): BalanceDifference[] {
  const tokens = [...new Set([...Object.keys(ledger), ...Object.keys(chain)])].sort();
  return tokens.flatMap((token) => {
    const l = ledger[token] ?? "0";
    const c = chain[token] ?? "0";
    return BigInt(l) === BigInt(c) ? [] : [{ token, ledger: l, chain: c }];
  });
}

/**
 * The order account's balance proven from chain state: the history's numbers checked against intents.near's own views
 * at one final block (docs.near.org /integrations/balance-changes: "For custody purposes, query finalized state").
 */
export type BalanceCheck =
  | { status: "verified"; blockHeight: number; blockHash: string }
  | { status: "differs"; blockHeight: number; blockHash: string; differences: BalanceDifference[] }
  | { status: "not_verified"; reason: string };

/** 219921623 → "219,921,623". */
export const groupDigits = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The history's balances against intents.near's (`chain`, null when they could not be read), and the flag a difference raises. */
export function balanceCheck(ledger: Readonly<Record<string, string>>, chain: ChainBalances | null): { check: BalanceCheck; flag?: Flag } {
  if (!chain) return { check: { status: "not_verified", reason: "intents.near's balances could not be read now" } };
  const at = { blockHeight: chain.blockHeight, blockHash: chain.blockHash };
  const differences = compareBalances(ledger, chain.balances);
  if (differences.length === 0) return { check: { status: "verified", ...at } };
  const list = (side: "chain" | "ledger"): string => differences.map((d) => `${d[side]} ${d.token}`).join(", ");
  return {
    check: { status: "differs", ...at, differences },
    flag: { kind: "ledger_mismatch", detail: `intents.near holds ${list("chain")} for this account at block ${groupDigits(chain.blockHeight)}, where the history we read adds up to ${list("ledger")}: part of the history may be missing, or the account moved after it was read` },
  };
}
