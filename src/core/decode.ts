// Normalises what NEAR gives us about a transaction (archival RPC `EXPERIMENTAL_tx_status`, or a neardata block's
// receipt execution outcomes) into one shape: the signed actions, and every NEP-297 event with the receipt it came from.
// Pure: no I/O, no clock.

export interface TxStatusResult {
  transaction: {
    hash: string;
    signer_id: string;
    receiver_id: string;
    actions: TxAction[];
  };
  transaction_outcome: { block_hash: string; outcome: ExecutionOutcome };
  receipts_outcome: { id: string; block_hash: string; outcome: ExecutionOutcome }[];
}

export interface NeardataBlock {
  block: { header: { height: number; hash: string; timestamp_nanosec: string } };
  shards: {
    shard_id: number;
    receipt_execution_outcomes: {
      tx_hash: string;
      receipt: {
        predecessor_id: string;
        receiver_id: string;
        receipt: { Action?: { signer_id: string; actions: TxAction[] } } & Record<string, unknown>;
      };
      execution_outcome: { outcome: ExecutionOutcome };
    }[];
  }[];
}

export type TxAction =
  | { FunctionCall: { method_name: string; args: string; gas?: number; deposit?: string } }
  | Record<string, unknown>;

export interface ExecutionOutcome {
  executor_id: string;
  logs: string[];
  status: Record<string, unknown>;
  receipt_ids?: string[];
}

export interface DecodedAction {
  method: string;
  args: unknown;
}

export interface NepEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
  executor: string;
  failed: boolean;
}

export interface ReceiptAction extends DecodedAction {
  executor: string;
  /** Set when the receipt carrying this action failed. */
  failed?: true;
  /** The receipt carrying this action, when the source names receipts. */
  receipt?: string;
}

/** Native NEAR moved by a Transfer action in a receipt; `failed` when that receipt's outcome failed. */
export interface NativeTransfer {
  from: string;
  to: string;
  deposit: string;
  failed: boolean;
  /** The receipt that carried it, when the source names receipts. */
  receipt?: string;
  /** Why it failed, as the chain names it (`failureKind`): AccountDoesNotExist for a named account nobody created. */
  error?: string;
  /** For a failed one: the `system` receipt that refunded its deposit to the sender. */
  refund?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Why an outcome failed, as the chain names it: an ActionError's kind (AccountDoesNotExist, FunctionCallError…),
 * else the failure's own name (InvalidTxError); undefined for a success.
 */
export function failureKind(status: Record<string, unknown>): string | undefined {
  const failure = status["Failure"];
  if (!isRecord(failure)) return undefined;
  const action = failure["ActionError"];
  const kind = isRecord(action) ? action["kind"] : undefined;
  if (typeof kind === "string") return kind;
  if (isRecord(kind)) return Object.keys(kind)[0];
  return Object.keys(failure)[0];
}

/** Everything a receipt's actions attach (Transfer and FunctionCall deposits): what NEAR refunds when it fails. */
export function attachedDeposit(actions: TxAction[]): bigint {
  let total = 0n;
  for (const a of actions) {
    const x = a as { Transfer?: { deposit?: unknown }; FunctionCall?: { deposit?: unknown } };
    const d = x.Transfer?.deposit ?? x.FunctionCall?.deposit;
    if (typeof d === "string" && /^\d+$/.test(d)) total += BigInt(d);
  }
  return total;
}

export interface TxRecord {
  hash: string;
  signer: string;
  receiver: string;
  height: number | null;
  timestampNs: bigint | null;
  /** The signed transaction's function calls. */
  actions: DecodedAction[];
  /** Function calls carried by the receipts (callbacks, cross-contract calls); empty when the source has no receipts. */
  receiptActions: ReceiptAction[];
  /** Native NEAR moved by the receipts' Transfer actions, without the gas refunds `system` sends; absent when the source has no receipts. */
  nativeTransfers?: NativeTransfer[];
  /**
   * Receipts the transaction spawned that the source's answer does not have yet: it is still executing ("A missing
   * outcome is pending", docs.near.org /integrations/fungible-tokens). Absent when every one is there, or when the
   * source names no receipts.
   */
  pendingReceipts?: string[];
  events: NepEvent[];
  /** Logs that are not NEP-297 events, with the account that printed them; `failed` when that receipt failed. */
  plainLogs: { executor: string; log: string; failed?: true }[];
}

export interface BlockPosition {
  height: number | null;
  timestampNs: bigint | null;
}

const EVENT_PREFIX = "EVENT_JSON:";

// atob + TextDecoder rather than Buffer: the page runs this in the browser.
function decodeArgs(b64: string): unknown {
  let text: string;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return b64;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function decodeActions(actions: TxAction[]): DecodedAction[] {
  const out: DecodedAction[] = [];
  for (const a of actions) {
    const fc = (a as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
    if (fc) out.push({ method: fc.method_name, args: decodeArgs(fc.args) });
  }
  return out;
}

/** The deposits of the Transfer actions among a receipt's actions. */
export function transferDeposits(actions: TxAction[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    const t = (a as { Transfer?: { deposit?: unknown } }).Transfer;
    if (t && typeof t.deposit === "string") out.push(t.deposit);
  }
  return out;
}

function isFailed(status: Record<string, unknown>): boolean {
  return "Failure" in status;
}

function decodeLogs(outcome: ExecutionOutcome, events: NepEvent[], plainLogs: TxRecord["plainLogs"]): void {
  const failed = isFailed(outcome.status);
  const plain = (log: string) => plainLogs.push({ executor: outcome.executor_id, log, ...(failed ? { failed: true as const } : {}) });
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
    // NEP-297 leaves `data` optional and untyped: most dip4/nep245 events carry an array, some an object.
    const data = Array.isArray(ev.data) ? ev.data : ev.data === undefined ? [] : [ev.data];
    events.push({
      standard: ev.standard,
      version: typeof ev.version === "string" ? ev.version : "",
      event: ev.event,
      data: data.filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null),
      executor: outcome.executor_id,
      failed,
    });
  }
}

export function decodeTxStatus(result: TxStatusResult, at: BlockPosition): TxRecord {
  const events: NepEvent[] = [];
  const plainLogs: TxRecord["plainLogs"] = [];
  for (const r of result.receipts_outcome) decodeLogs(r.outcome, events, plainLogs);
  return {
    hash: result.transaction.hash,
    signer: result.transaction.signer_id,
    receiver: result.transaction.receiver_id,
    height: at.height,
    timestampNs: at.timestampNs,
    actions: decodeActions(result.transaction.actions),
    receiptActions: [],
    events,
    plainLogs,
  };
}

export function decodeBlockOutcomes(block: NeardataBlock): TxRecord[] {
  const at: BlockPosition = { height: block.block.header.height, timestampNs: BigInt(block.block.header.timestamp_nanosec) };
  const byTx = new Map<string, TxRecord>();
  for (const shard of block.shards) {
    for (const o of shard.receipt_execution_outcomes) {
      let tx = byTx.get(o.tx_hash);
      if (!tx) {
        const action = o.receipt.receipt.Action;
        tx = {
          hash: o.tx_hash,
          signer: action?.signer_id ?? o.receipt.predecessor_id,
          receiver: o.receipt.receiver_id,
          height: at.height,
          timestampNs: at.timestampNs,
          actions: action ? decodeActions(action.actions) : [],
          receiptActions: [],
          nativeTransfers: [],
          events: [],
          plainLogs: [],
        };
        byTx.set(o.tx_hash, tx);
      }
      const receiptAction = o.receipt.receipt.Action;
      const failedReceipt = isFailed(o.execution_outcome.outcome.status);
      if (receiptAction) for (const a of decodeActions(receiptAction.actions)) tx.receiptActions.push({ ...a, executor: o.receipt.receiver_id, ...(failedReceipt ? { failed: true as const } : {}) });
      if (receiptAction && o.receipt.predecessor_id !== "system") {
        for (const deposit of transferDeposits(receiptAction.actions)) tx.nativeTransfers?.push({ from: o.receipt.predecessor_id, to: o.receipt.receiver_id, deposit, failed: isFailed(o.execution_outcome.outcome.status) });
      }
      decodeLogs(o.execution_outcome.outcome, tx.events, tx.plainLogs);
    }
  }
  return [...byTx.values()];
}
