// The FastNEAR Transactions API (https://tx.main.fastnear.com, keyless, CORS open): `/v0/account` lists an account's
// transactions, `/v0/transactions` returns up to 20 raw transactions with every receipt's outcome and actions.
// This file is the pure part: parsing the JSON text safely and mapping a raw transaction to a TxRecord.

import { attachedDeposit, decodeActions, failureKind, transferDeposits, type ExecutionOutcome, type NativeTransfer, type TxAction, type TxRecord } from "./decode.js";

type FastnearReceipt = {
  execution_outcome: { id?: string; block_height: number; block_timestamp: number | string; outcome: ExecutionOutcome };
  receipt: {
    receipt_id?: string;
    predecessor_id: string;
    receiver_id: string;
    receipt: { Action?: { signer_id: string; actions: TxAction[] } } & Record<string, unknown>;
  };
};

export interface FastnearRawTx {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: TxAction[] };
  execution_outcome: { block_hash: string; block_height: number; block_timestamp: number | string; outcome: ExecutionOutcome };
  receipts: FastnearReceipt[];
}

export interface FastnearTransactionsResponse {
  transactions: FastnearRawTx[];
}

export interface FastnearAccountTx {
  account_id: string;
  transaction_hash: string;
  tx_block_height: number;
  tx_block_timestamp: string | number;
  is_success: boolean;
}

export interface FastnearAccountResponse {
  txs_count?: number;
  account_txs: FastnearAccountTx[];
  resume_token?: string;
}

/**
 * FastNEAR writes nanosecond block timestamps as bare JSON integers, which exceed 2^53 and would be rounded by
 * JSON.parse. Quote them before parsing so they survive as strings.
 */
export function parseFastnearJson<T>(text: string): T {
  const guarded = text.replace(/"((?:tx_)?block_timestamp)":\s*(\d{16,})/g, '"$1":"$2"');
  return JSON.parse(guarded) as T;
}

export function decodeFastnearTx(raw: FastnearRawTx): TxRecord {
  const nativeTransfers: NativeTransfer[] = [];
  const tx: TxRecord = {
    hash: raw.transaction.hash,
    signer: raw.transaction.signer_id,
    receiver: raw.transaction.receiver_id,
    height: raw.execution_outcome.block_height,
    timestampNs: BigInt(String(raw.execution_outcome.block_timestamp)),
    actions: decodeActions(raw.transaction.actions),
    receiptActions: [],
    nativeTransfers,
    events: [],
    plainLogs: [],
  };
  const byId = new Map<string, FastnearReceipt>();
  for (const r of raw.receipts) if (r.receipt.receipt_id) byId.set(r.receipt.receipt_id, r);
  const sorted = [...raw.receipts].sort((a, b) => a.execution_outcome.block_height - b.execution_outcome.block_height);
  for (const r of sorted) {
    const action = r.receipt.receipt.Action;
    const id = r.receipt.receipt_id;
    const status = r.execution_outcome.outcome.status;
    const failed = "Failure" in status;
    const named = id ? { receipt: id } : {};
    if (action) for (const a of decodeActions(action.actions)) tx.receiptActions.push({ ...a, executor: r.receipt.receiver_id, ...(failed ? { failed: true as const } : {}), ...named });
    if (action && r.receipt.predecessor_id !== "system") {
      const error = failed ? failureKind(status) : undefined;
      const refund = failed ? balanceRefund(r, action.actions, byId) : undefined;
      for (const deposit of transferDeposits(action.actions)) {
        nativeTransfers.push({ from: r.receipt.predecessor_id, to: r.receipt.receiver_id, deposit, failed, ...named, ...(error ? { error } : {}), ...(refund ? { refund } : {}) });
      }
    }
    decodeOutcomeLogs(r.execution_outcome.outcome, tx);
  }
  const pending = pendingReceipts(raw, sorted, byId);
  if (pending.length > 0) tx.pendingReceipts = pending;
  return tx;
}

/**
 * The receipts the transaction or any of its receipts spawned (`receipt_ids`: action receipts, refunds included) that
 * are not in the answer: they have not run yet. Only when the answer names its receipts.
 */
function pendingReceipts(raw: FastnearRawTx, sorted: FastnearReceipt[], byId: Map<string, FastnearReceipt>): string[] {
  if (raw.receipts.some((r) => !r.receipt.receipt_id)) return [];
  const pending: string[] = [];
  for (const outcome of [raw.execution_outcome.outcome, ...sorted.map((r) => r.execution_outcome.outcome)]) {
    for (const id of outcome.receipt_ids ?? []) if (!byId.has(id) && !pending.includes(id)) pending.push(id);
  }
  return pending;
}

/**
 * The receipt that refunded a failed receipt's deposit: NEAR returns everything the actions attached to the sender in
 * a `system` receipt of its own, apart from the gas refund (nearcore runtime `generate_refund_receipts`).
 */
function balanceRefund(failed: FastnearReceipt, actions: TxAction[], byId: Map<string, FastnearReceipt>): string | undefined {
  const attached = attachedDeposit(actions);
  if (attached === 0n) return undefined;
  for (const id of failed.execution_outcome.outcome.receipt_ids ?? []) {
    const r = byId.get(id);
    const refund = r?.receipt.receipt.Action;
    if (r && refund && r.receipt.predecessor_id === "system" && r.receipt.receiver_id === failed.receipt.predecessor_id && transferDeposits(refund.actions).some((d) => /^\d+$/.test(d) && BigInt(d) === attached)) return id;
  }
  return undefined;
}

const EVENT_PREFIX = "EVENT_JSON:";

function decodeOutcomeLogs(outcome: ExecutionOutcome, tx: TxRecord): void {
  const failed = "Failure" in outcome.status;
  const plain = (log: string) => tx.plainLogs.push({ executor: outcome.executor_id, log, ...(failed ? { failed: true as const } : {}) });
  for (const log of outcome.logs) {
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
    const data = Array.isArray(ev.data) ? ev.data : ev.data === undefined ? [] : [ev.data];
    tx.events.push({
      standard: ev.standard,
      version: typeof ev.version === "string" ? ev.version : "",
      event: ev.event,
      data: data.filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null),
      executor: outcome.executor_id,
      failed,
    });
  }
}
