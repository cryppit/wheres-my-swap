// NearBlocks API v3 (https://api.nearblocks.io): a second, independent source of an order account's history, run by
// another team on its own indexer, for when FastNEAR is down or rate-limits us. This file is the pure part: the
// response types, the JSON guard, and the mapping of NearBlocks' answers to the same records `decodeFastnearTx`
// (fastnear.ts) makes, so the trace cannot tell the two sources apart. src/nearblocks-client.ts does the I/O.
//
// Two endpoints carry everything: `/v3/accounts/{account}/mt-txns` lists the account's NEP-245 transfers inside
// intents.near (mints, transfers, burns; the plain `/txns` list is empty for an order account), and
// `/v3/txns/{hash}/receipts` gives one transaction's receipt tree: each receipt's actions with their arguments, its
// outcome (executor, logs, status) and its block. Checked field by field against FastNEAR on near/intents #358 and
// against the archival RPC on one-click-sdk #6 (nearblocks.test.ts). What NearBlocks gives differently or not at all,
// and what the mapping (and so the trace) does about it:
// - Raw call arguments: none (`args_base64` is null). `args_json` has every string escaped twice ({"a":"b"} inside a
//   string comes back as {\\\"a\\\":\\\"b\\\"}); each string is unescaped twice, which gives back exactly what FastNEAR
//   decodes (key order aside: NearBlocks sorts keys like Postgres jsonb). Should `args_base64` come (arguments that
//   are not JSON, presumably; not seen in the recorded answers), it is decoded as decode.ts decodes raw arguments.
// - The transaction's own block: not in the tree, whose root receipt can run a block or more after its transaction.
//   The caller passes it: mt-txns items carry it, and so does `/v3/txns/{hash}`.
// - Where a receipt sat in its chunk (shard, index): not given. Receipts that ran in the same block keep the tree's
//   depth-first order, where FastNEAR orders them by shard and chunk position; only two receipts of one transaction
//   that ran in the same block, both with calls, transfers or logs, can then come in another order, and the trace may
//   list that transaction's hops in another order, with the same amounts, balances and verdict.
// - The receipts each outcome spawned (`receipt_ids`): read from the tree's children. A child listed without an outcome
//   has not run yet and becomes `pendingReceipts` (the trace then says the order is still executing). A receipt
//   NearBlocks has not indexed yet is not in the tree at all, so a transaction still executing can look finished; at
//   NearBlocks' measured lag of 4 to 6 seconds that only matters for an order that is moving right now.
// - A failure's details: the RPC's ActionError with camelCase inner fields ({AccountDoesNotExist: {accountId}});
//   failureKind reads only the kind's name, so `error` is the same.
// - Coverage of the account's history: mt-txns lists only transactions that moved one of the account's NEP-245 tokens.
//   A deposit intents.near never credited (no mt_mint), an intent that failed or a key registration that moved nothing
//   is not listed, so the trace does not see it (FastNEAR finds those too, through the account named in the
//   arguments): an order whose deposit was never credited has an empty history here (verdict not_found) unless the
//   user pastes the deposit transaction, and the own_key flag can be missed. src/nearblocks-client.ts keeps a pasted
//   transaction that names the account.
// - Never read by the trace, so not mapped: the transaction's nonce, signature and priority fee, gas and fees.
// Pure: no I/O, no clock.

import { attachedDeposit, decodeActions, failureKind, transferDeposits, type DecodedAction, type NativeTransfer, type TxAction, type TxRecord } from "./decode.js";

/** The free tier needs this credit on anything but personal use ("Powered by Nearblocks.io APIs", or a link back). */
export const NEARBLOCKS_ATTRIBUTION = "Order history from NearBlocks: Powered by Nearblocks.io APIs (https://nearblocks.io)";
export const NEARBLOCKS_LINK = "https://nearblocks.io";

/** A block as v3 writes it: height and nanosecond time as decimal strings. */
export interface NbBlock {
  block_hash: string;
  block_height: string | number;
  block_timestamp: string | number;
}

/** Every v3 answer: `data`, `meta.next_page` on a list with more pages, `errors` on failure. */
export interface NbEnvelope<T> {
  data: T | null;
  meta?: { next_page?: string | null; prev_page?: string | null } | null;
  errors?: { message: string; path?: string }[] | null;
}

/** One NEP-245 transfer of the account (mt-txns), at the block of the transaction that made it. */
export interface NbMtTxn {
  transaction_hash: string;
  receipt_id: string;
  block: NbBlock;
  affected_account_id: string;
  involved_account_id: string | null;
  token_id: string;
  delta_amount: string;
  /** MINT, TRANSFER or BURN. */
  cause: string;
}

/** An action's details: for a call `method_name`, `args_json` or `args_base64`, `gas` and `deposit`; for a transfer `deposit`. */
export interface NbArgs {
  method_name?: string;
  args_json?: unknown;
  args_base64?: string | null;
  gas?: string | number;
  deposit?: string;
  [field: string]: unknown;
}

export interface NbAction {
  /** FUNCTION_CALL, TRANSFER, CREATE_ACCOUNT, DELEGATE… */
  action: string;
  method?: string | null;
  args?: NbArgs | null;
}

export interface NbOutcome {
  executor_account_id: string;
  logs: string[];
  status?: boolean | null;
  /** SUCCESS_VALUE, SUCCESS_RECEIPT_ID or FAILURE. */
  status_key?: string | null;
  /** The value (base64), the receipt id, or the failure ({ActionError: …}). */
  result?: unknown;
}

/** A receipt and, under `receipts`, the receipts it spawned; `outcome` is null for one that has not run. */
export interface NbReceipt {
  receipt_id: string;
  predecessor_account_id: string;
  receiver_account_id: string;
  actions?: NbAction[] | null;
  outcome?: NbOutcome | null;
  block: NbBlock;
  receipts?: NbReceipt[] | null;
}

/** `/v3/txns/{hash}`: the transaction, at its own block. */
export interface NbTxn {
  transaction_hash: string;
  signer_account_id: string;
  receiver_account_id: string;
  block: NbBlock;
}

/** `/v3/search/receipts?keyword=`: the transaction a receipt belongs to. */
export interface NbReceiptHit {
  receipt_id: string;
  transaction_hash: string;
}

/** A transaction of the account's history (the AccountTx shape, plus the block it came with). */
export interface NbHistoryTx {
  hash: string;
  height: number;
  timestampNs: bigint;
  block: NbBlock;
}

/**
 * v3 writes heights and nanosecond timestamps as strings. Should one ever come as a bare integer (beyond 2^53, which
 * JSON.parse would round), quote it before parsing, as parseFastnearJson does.
 */
export function parseNearBlocksJson<T>(text: string): T {
  return JSON.parse(text.replace(/"(block_timestamp)":\s*(\d{16,})/g, '"$1":"$2"')) as T;
}

/** The transactions an mt-txns listing names, once each, at their own block, oldest first. */
export function mtTxnsHistory(items: readonly NbMtTxn[]): NbHistoryTx[] {
  const byHash = new Map<string, NbHistoryTx>();
  for (const item of items) {
    const height = Number(item.block.block_height);
    const seen = byHash.get(item.transaction_hash);
    if (seen && seen.height <= height) continue;
    byHash.set(item.transaction_hash, { hash: item.transaction_hash, height, timestampNs: BigInt(String(item.block.block_timestamp)), block: item.block });
  }
  return [...byHash.values()].sort((a, b) => a.height - b.height || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function failureDetail(result: unknown): Record<string, unknown> {
  if (isRecord(result)) return result;
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      if (isRecord(parsed)) return parsed;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/** A receipt's outcome as the RPC (and FastNEAR) write it: {SuccessValue}, {SuccessReceiptId}, {Failure} or {Unknown}. */
export function nearBlocksStatus(outcome: NbOutcome | null | undefined): Record<string, unknown> {
  if (!outcome) return { Unknown: null };
  switch (outcome.status_key) {
    case "SUCCESS_VALUE":
      return { SuccessValue: typeof outcome.result === "string" ? outcome.result : "" };
    case "SUCCESS_RECEIPT_ID":
      return { SuccessReceiptId: outcome.result };
    case "FAILURE":
      return { Failure: failureDetail(outcome.result) };
    default:
      return outcome.status === false ? { Failure: failureDetail(outcome.result) } : { Unknown: outcome.result ?? null };
  }
}

/** Undoes NearBlocks' double escaping of one string; leaves it as it is when it is not escaped that way. */
function unescapeTwice(s: string): string {
  if (!s.includes("\\")) return s;
  let out = s;
  for (let i = 0; i < 2; i++) {
    try {
      const v: unknown = JSON.parse(`"${out}"`);
      if (typeof v !== "string") return s;
      out = v;
    } catch {
      return s;
    }
  }
  return out;
}

function restoreArgs(v: unknown): unknown {
  if (typeof v === "string") return unescapeTwice(v);
  if (Array.isArray(v)) return v.map(restoreArgs);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [unescapeTwice(k), restoreArgs(x)]));
  return v;
}

/**
 * The function calls among the actions, with their arguments as decodeActions gives them from the raw base64: from
 * `args_base64` when NearBlocks sends it, else from `args_json` with its strings unescaped.
 */
function decodeCalls(actions: readonly NbAction[]): DecodedAction[] {
  const out: DecodedAction[] = [];
  for (const a of actions) {
    if (a.action !== "FUNCTION_CALL") continue;
    const args = a.args ?? {};
    const method = typeof args.method_name === "string" ? args.method_name : (a.method ?? "");
    const raw = typeof args.args_base64 === "string" ? args.args_base64 : "";
    if (raw === "" && args.args_json !== undefined && args.args_json !== null) {
      out.push({ method, args: restoreArgs(args.args_json) });
      continue;
    }
    const [decoded] = decodeActions([{ FunctionCall: { method_name: method, args: raw } }]);
    out.push({ method, args: decoded?.args ?? raw });
  }
  return out;
}

/** The actions as the RPC writes them, for decode.ts's deposit helpers (only Transfer and FunctionCall deposits matter). */
function rpcActions(actions: readonly NbAction[]): TxAction[] {
  return actions.map((a): TxAction => {
    const args = a.args ?? {};
    if (a.action === "TRANSFER") return { Transfer: { deposit: args.deposit } };
    if (a.action === "FUNCTION_CALL") return { FunctionCall: { method_name: typeof args.method_name === "string" ? args.method_name : (a.method ?? ""), args: "", ...(typeof args.deposit === "string" ? { deposit: args.deposit } : {}) } };
    return { [a.action]: args };
  });
}

function flatten(r: NbReceipt): NbReceipt[] {
  return [r, ...(r.receipts ?? []).flatMap(flatten)];
}

/** A receipt that has run: it has an outcome. */
type Ran = NbReceipt & { outcome: NbOutcome };
const ran = (r: NbReceipt): r is Ran => r.outcome !== null && r.outcome !== undefined;

/** The `system` receipt that returned a failed receipt's attached deposit to its sender (as fastnear.ts finds it). */
function balanceRefund(failed: NbReceipt, actions: TxAction[], byId: Map<string, Ran>): string | undefined {
  const attached = attachedDeposit(actions);
  if (attached === 0n) return undefined;
  for (const child of failed.receipts ?? []) {
    const r = byId.get(child.receipt_id);
    if (r && r.predecessor_account_id === "system" && r.receiver_account_id === failed.predecessor_account_id && transferDeposits(rpcActions(r.actions ?? [])).some((d) => /^\d+$/.test(d) && BigInt(d) === attached)) return r.receipt_id;
  }
  return undefined;
}

const EVENT_PREFIX = "EVENT_JSON:";

/** NEP-297 events and plain logs, read as fastnear.ts reads them. */
function decodeLogs(outcome: NbOutcome, failed: boolean, tx: TxRecord): void {
  const executor = outcome.executor_account_id;
  const plain = (log: string) => tx.plainLogs.push({ executor, log, ...(failed ? { failed: true as const } : {}) });
  for (const log of outcome.logs ?? []) {
    if (!log.startsWith(EVENT_PREFIX)) {
      plain(log);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(log.slice(EVENT_PREFIX.length));
    } catch {
      plain(log);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const ev = parsed as { standard?: unknown; version?: unknown; event?: unknown; data?: unknown };
    if (typeof ev.standard !== "string" || typeof ev.event !== "string") continue;
    // NEP-297 leaves `data` optional and untyped: most dip4/nep245 events carry an array, some an object.
    const data = Array.isArray(ev.data) ? ev.data : ev.data === undefined ? [] : [ev.data];
    tx.events.push({
      standard: ev.standard,
      version: typeof ev.version === "string" ? ev.version : "",
      event: ev.event,
      data: data.filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null),
      executor,
      failed,
    });
  }
}

/**
 * One transaction from its NearBlocks receipt tree, as the record decodeFastnearTx makes from FastNEAR's answer: the
 * signed calls (the root receipt's), every receipt's calls, native transfers (with the failure's kind and the receipt
 * that refunded it), NEP-297 events and plain logs in block order, and the spawned receipts that have not run.
 * `at` is the transaction's own block (an mt-txns item's, or `/v3/txns/{hash}`'s): the tree does not have it.
 */
export function decodeNearBlocksTx(hash: string, tree: NbReceipt, at: NbBlock): TxRecord {
  const nativeTransfers: NativeTransfer[] = [];
  const tx: TxRecord = {
    hash,
    signer: tree.predecessor_account_id,
    receiver: tree.receiver_account_id,
    height: Number(at.block_height),
    timestampNs: BigInt(String(at.block_timestamp)),
    actions: decodeCalls(tree.actions ?? []),
    receiptActions: [],
    nativeTransfers,
    events: [],
    plainLogs: [],
  };
  const done = flatten(tree).filter(ran);
  const byId = new Map(done.map((r) => [r.receipt_id, r]));
  const sorted = [...done].sort((a, b) => Number(a.block.block_height) - Number(b.block.block_height));
  for (const r of sorted) {
    const outcome = r.outcome;
    const status = nearBlocksStatus(outcome);
    const failed = "Failure" in status;
    const actions = r.actions ?? [];
    const named = { receipt: r.receipt_id };
    for (const a of decodeCalls(actions)) tx.receiptActions.push({ ...a, executor: r.receiver_account_id, ...(failed ? { failed: true as const } : {}), ...named });
    if (r.predecessor_account_id !== "system") {
      const rpc = rpcActions(actions);
      const error = failed ? failureKind(status) : undefined;
      const refund = failed ? balanceRefund(r, rpc, byId) : undefined;
      for (const deposit of transferDeposits(rpc)) {
        nativeTransfers.push({ from: r.predecessor_account_id, to: r.receiver_account_id, deposit, failed, ...named, ...(error ? { error } : {}), ...(refund ? { refund } : {}) });
      }
    }
    decodeLogs(outcome, failed, tx);
  }
  // As fastnear.ts: what the transaction and each receipt that ran spawned, and is not there yet.
  const pending: string[] = [];
  for (const ids of [[tree.receipt_id], ...sorted.map((r) => (r.receipts ?? []).map((c) => c.receipt_id))]) {
    for (const id of ids) if (!byId.has(id) && !pending.includes(id)) pending.push(id);
  }
  if (pending.length > 0) tx.pendingReceipts = pending;
  return tx;
}
