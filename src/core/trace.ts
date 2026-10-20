// Joins one NEAR Intents order account's transactions into hops (origin → credit → swap → withdrawal → payout), labels
// each hop by how it is known (proven from a key both sides record, matched by heuristic, unverified, missing), and
// flags stalled, late and refunded orders. Pure: the caller passes the transactions and the clock.
//
// Ledger: the account's balance inside intents.near is reconstructed from the dip4 intent events (token_diff,
// transfer), the nep245 mt_mint events (memo "deposit", and "refund" when a failed withdrawal comes back) and the
// nep245 mt_burn events, which carry everything a withdrawal takes out, including a bridge fee or storage deposit
// paid in wNEAR. A transaction with no mt_burn for the account falls back to the dip4 *_withdraw amounts. nep245
// mt_transfer is the ledger shadow of token_diff and transfer and is not counted again, except in a transaction where
// no dip4 event names the account: there it is a direct mt_transfer (the NEAR Mobile app funds orders so, and 1Click
// sweeps leftovers so) and the only record of the move, counted as a credit or a transfer out. Events from failed
// receipts are ignored.

import type { NepEvent, TxRecord } from "./decode.js";
import { knownAccount } from "./known-accounts.js";

export type OriginHop =
  | { status: "proven"; kind: "poa"; chain: string; txHash: string; how: string }
  | { status: "proven"; kind: "omni"; chain: string; originNonce: string; sender: string; how: string }
  /** A Bitcoin (or Zcash) deposit through the Omni UTXO bridge: the coin the connector added is `txHash@vout`. */
  | { status: "proven"; kind: "omni-utxo"; chain: string; txHash: string; vout: number; how: string }
  | { status: "proven"; kind: "near-native"; chain: "near:mainnet"; txHash: string; sender: string; how: string }
  /** A HOT bridge deposit: HOT signs the mt_deposit_call for the chain it saw the deposit on; the origin-chain transaction is not named on NEAR. */
  | { status: "proven"; kind: "hot"; chain: string; originNonce: string; how: string }
  | { status: "unverified"; kind: "unknown"; how: string }
  | { status: "missing" };

export interface CreditHop {
  status: "proven";
  tx: string;
  timestampNs: bigint | null;
  height: number | null;
  token: string;
  amount: string;
  /** `transfer`: funded inside NEAR Intents by a transfer from another account (`from`), not by a bridge deposit. */
  via?: "transfer";
  from?: string;
}

export interface SwapHop {
  status: "proven";
  tx: string;
  timestampNs: bigint | null;
  height: number | null;
  intentHash: string | null;
  gave: Record<string, string>;
  got: Record<string, string>;
  fees: Record<string, string>;
  referral: string | null;
  counterparties: string[];
}

export interface TransferOut {
  tx: string;
  timestampNs: bigint | null;
  height: number | null;
  to: string;
  /** Set only for accounts NEAR Intents documents (fee collectors, the confidential treasury). */
  toLabel: string | null;
  tokens: Record<string, string>;
}

export type Bridge = "poa" | "omni" | "hot" | "near" | "unknown";

export interface WithdrawHop {
  status: "proven";
  tx: string;
  timestampNs: bigint | null;
  height: number | null;
  intentHash: string | null;
  kind: string;
  token: string;
  amount: string;
  chain: string | null;
  bridge: Bridge;
  destination: string | null;
  externalId: string | null;
  /** How much came back to the order account because the transfer out failed (intents.near mints it back, memo "refund"). */
  returned?: string;
  /**
   * After a swap, a withdrawal of a deposited token the swap did not produce: 1Click returning the unused input to the
   * refund address (EXACT_OUTPUT, or the excess of EXACT_INPUT). Shown, but it is not the payout.
   */
  excessRefund?: boolean;
  /**
   * The token's ft_transfer_call (mt_transfer_call) to the bridge failed: intents.near does not credit a failed call
   * back (its ft_resolve_withdraw), so the tokens stay with intents.near, outside the order account.
   */
  refused?: boolean;
  /** Native NEAR (native_withdraw) that never reached the destination: see `Bounce`. */
  bounced?: Bounce;
}

/**
 * Why a native NEAR payout never arrived, from the withdrawal transaction's receipts. intents.near unwraps the wNEAR
 * (near_withdraw on wrap.near), then do_native_withdraw sends a bare Transfer with no callback (near/intents
 * nep141/native.rs). `transfer_failed`: that Transfer failed, so NEAR refunded it to intents.near (a transfer to a
 * named account nobody created fails, docs.near.org /integrations/create-transactions); `error` is the chain's reason,
 * `receipt` the failed Transfer, `refund` the system receipt that returned it. `unwrap_failed`: intents.near's own step
 * (`step`: near_withdraw or do_native_withdraw) failed and sent nothing. Either way the order account is not credited
 * back: the NEAR stays with intents.near.
 */
export interface Bounce {
  reason: "transfer_failed" | "unwrap_failed";
  error?: string;
  step?: string;
  receipt?: string;
  refund?: string;
}

/** What went wrong with a bounced NEAR payout, in a phrase every report shares ("that account does not exist"). */
export function bounceCause(b: Bounce): string {
  if (b.reason === "unwrap_failed") return `intents.near's own payout step (${b.step ?? "do_native_withdraw"}) failed and sent nothing`;
  return b.error === "AccountDoesNotExist" ? "that account does not exist" : `the transfer failed${b.error ? ` (${b.error})` : ""}`;
}

const KEPT_BY_INTENTS = "NEAR Intents does not credit a failed NEAR payout back: it stays with intents.near, outside the order account";

function bounceDetail(w: WithdrawHop, b: Bounce): string {
  const dest = w.destination ?? "the destination";
  if (b.reason === "unwrap_failed") return `intents.near's own payout step (${b.step ?? "do_native_withdraw"}) failed, so no NEAR was sent to ${dest}; ${KEPT_BY_INTENTS}`;
  return `NEAR could not deliver the payout to ${dest} (${bounceCause(b)}) and returned it to intents.near${b.refund ? ` (refund receipt ${b.refund})` : ""}; ${KEPT_BY_INTENTS}`;
}

/**
 * A native NEAR payout that never reached `dest`, from the withdrawal transaction's own receipts; null when it went
 * out, or when the receipts prove nothing either way (no receipts at all, or no transfer and no failed step).
 */
function nativeBounce(tx: TxRecord, dest: string | null, amount: string | null): Bounce | null {
  const transfers = tx.nativeTransfers;
  if (!transfers || !dest || !amount) return null;
  const toDest = transfers.filter((n) => n.from === "intents.near" && n.to === dest && n.deposit === amount);
  if (toDest.some((n) => !n.failed)) return null;
  const failed = toDest.find((n) => n.failed);
  if (failed) return { reason: "transfer_failed", ...(failed.error ? { error: failed.error } : {}), ...(failed.receipt ? { receipt: failed.receipt } : {}), ...(failed.refund ? { refund: failed.refund } : {}) };
  const unwrap = tx.receiptActions.find((a) => a.failed && a.executor === "wrap.near" && a.method === "near_withdraw" && str(record(a.args)["amount"]) === amount);
  const pay = tx.receiptActions.find((a) => {
    const w = record(record(a.args)["withdraw"]);
    return a.failed && a.executor === "intents.near" && a.method === "do_native_withdraw" && str(w["receiver_id"]) === dest && str(w["amount"]) === amount;
  });
  const step = unwrap ?? pay;
  return step ? { reason: "unwrap_failed", step: step.method, ...(step.receipt ? { receipt: step.receipt } : {}) } : null;
}

/**
 * What a bridge's operator says about a withdrawal: its word, not chain data. The PoA bridge's public
 * `withdrawal_status` (no `source`), the Omni bridge's indexer (`source: "omni"`) or the HOT bridge's
 * (`source: "hot"`); `tx` is the payout it names.
 */
export interface BridgeReport {
  status: string;
  tx: string | null;
  source?: "omni" | "hot";
  /**
   * An Omni Fast Transfer: the destination-chain transaction in which a relayer paid the user early from its own funds
   * (the indexer's `fast_finalised`); `tx` is then the bridge's finalisation, which repays the relayer.
   */
  fastTx?: string;
  /** The Omni transfer's nonce on the destination chain (the indexer's `destination_nonce`): what its bridge contract records. */
  destinationNonce?: number;
}

/** Who sent a payout, and which published treasury wallet that is (null: not on the list). */
export interface PayoutSender {
  address: string;
  treasury: string | null;
}

interface PayoutBase {
  chain: string | null;
  bridge: Bridge;
  destination: string | null;
  bridgeReport?: BridgeReport;
}

/**
 * The last hop, on the destination chain. `proven`: a key both sides record (NEAR payouts sit in the withdrawal tx).
 * `confirmed`: the PoA bridge's operator names the transfer and it is on the destination chain, into the destination.
 * `matched`: the only transfer into the destination that fits the burn's amount (less the bridge fee) and time; PoA
 * pays from a custodial wallet and writes nothing that names the burn, so on chain this is the best public data allows.
 * `shielded`: a Zcash payout the bridge names, on the Zcash chain, moving the withdrawal (less fees) into a shielded
 * pool (`shieldedPool`); its recipient is encrypted, so the destination itself cannot be checked.
 */
export type PayoutHop =
  | (PayoutBase & { status: "arrived"; how: "proven" | "confirmed" | "matched" | "shielded"; tx: string; amount: string | null; delaySec: number | null; confirmed: boolean; sender?: PayoutSender | null; shieldedPool?: string; via?: "transfer" })
  /**
   * Paid by the destination's Omni bridge contract's own record: it marks a destination nonce only in a finalisation
   * that verified the bridge's signature and paid the signed recipient. The indexer has not named the transaction, so
   * there is none to link, and no amount or time beyond the withdrawal's.
   */
  | (PayoutBase & { status: "arrived"; how: "recorded"; tx: null; amount: null; delaySec: null; confirmed: true; destinationNonce: number; sender?: null; shieldedPool?: never; via?: never })
  | (PayoutBase & { status: "ambiguous"; txs: string[] })
  | (PayoutBase & { status: "waiting"; waitedSec: number })
  | (PayoutBase & { status: "not_found"; waitedSec: number })
  | (PayoutBase & { status: "unverified"; reason?: string })
  | { status: "missing" };

export type Flag =
  | { kind: "stalled"; waitedSec: number; detail: string }
  | { kind: "settled_late"; delaySec: number; detail: string }
  | { kind: "refunded"; detail: string }
  | { kind: "withdrawal_returned"; detail: string }
  | { kind: "withdrawal_refused"; detail: string }
  | { kind: "payout_bounced"; detail: string }
  | { kind: "confidential"; detail: string }
  | { kind: "later_deposit"; detail: string }
  | { kind: "dust"; detail: string }
  | { kind: "several_orders"; count: number; shown: number; detail: string }
  | { kind: "own_key"; detail: string }
  | { kind: "incomplete_history"; detail: string }
  | { kind: "payout_not_found"; waitedSec: number; detail: string }
  /** `tx` has steps (receipts) that have not run yet: nothing about the order is final. */
  | { kind: "executing"; tx: string; detail: string }
  /** The payout was credited to `account`, a name no NEAR account has yet: see `destinationMissing`. */
  | { kind: "destination_missing"; account: string; detail: string }
  /** intents.near's own balances for the account differ from what its history adds up to (core/views.ts balanceCheck). */
  | { kind: "ledger_mismatch"; detail: string }
  /**
   * intents.near's operators locked the account (force_lock_account, dip4 `account_locked`) in `tx`, `waitedSec` ago,
   * and no `account_unlocked` followed. A locked account cannot move its own balances, so no swap or withdrawal can run
   * from it until the operators unlock it or move the funds (near/intents contracts/defuse/src/accounts.rs).
   */
  | { kind: "locked"; tx: string; waitedSec: number; detail: string };

const LOCKED_DETAIL = "intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it";

/**
 * A token payout credited to a name nobody has created: the token contract holds it under that name, and whoever
 * creates the name first controls it. A contract cannot ask whether an account exists, and NEP-141 storage_deposit
 * registers any valid name (near-sdk-rs near-contract-standards storage_impl.rs), which intents.near's ft_withdraw pays
 * for the receiver before its ft_transfer (near/intents nep141/withdraw.rs, do_ft_withdraw).
 */
export function destinationMissing(account: string): Flag {
  return { kind: "destination_missing", account, detail: `no NEAR account is named ${account} yet: the token contract holds the payout under that name, and whoever creates ${account} first controls it` };
}

export type Verdict = "settled" | "refunded" | "confidential" | "stuck" | "in_progress" | "not_found";

/** The 1Click status word closest to our verdict, for users who saw one in their app. Not 1Click's own answer. */
export type OneClickStatus = "SUCCESS" | "REFUNDED" | "PROCESSING" | "PENDING_DEPOSIT";

const ONE_CLICK: Record<Verdict, OneClickStatus> = {
  settled: "SUCCESS",
  refunded: "REFUNDED",
  confidential: "PROCESSING",
  stuck: "PROCESSING",
  in_progress: "PROCESSING",
  not_found: "PENDING_DEPOSIT",
};

export interface OrderReport {
  account: string;
  verdict: Verdict;
  oneClickStatus: OneClickStatus;
  origin: OriginHop;
  deposits: CreditHop[];
  swaps: SwapHop[];
  transfers: TransferOut[];
  withdrawals: WithdrawHop[];
  payout: PayoutHop;
  balances: Record<string, string>;
  flags: Flag[];
}

export interface TraceParams {
  /** A credit (or a swap) with nothing after it for this long is stalled. */
  stallAfterSec: number;
  /** A first intent this long after the credit is a late settlement. */
  lateAfterSec: number;
  /** Per token, the raw amount under which a leftover after the payout is dust (`dustThresholds`); none without prices. */
  dustBelow?: Readonly<Record<string, string>>;
}

export const DEFAULT_PARAMS: TraceParams = { stallAfterSec: 3_600, lateAfterSec: 3_600 };

export interface TraceInput {
  account: string;
  txs: TxRecord[];
  nowNs: bigint;
  params?: Partial<TraceParams>;
  /** When the account turns out to hold several separate orders, follow the one with this transaction (else the latest). */
  focusTx?: string;
  /** Trace the transactions as one order, without splitting the history (each part, once split). */
  oneOrder?: boolean;
}

const NS = 1_000_000_000n;
/**
 * How long a transaction can still be executing: NEAR runs a transaction's receipts within seconds (~0.6 s blocks, a
 * few blocks per cross-contract step; a yielded promise waits at most 200 blocks, about 2 minutes). Receipts still
 * missing after this are a gap in the data we read, not execution.
 */
const EXECUTING_AT_MOST_NS = 600n * NS;
/** U128 amounts are base-10 integer strings (NEP-141/245); anything else is skipped, never thrown on. */
const INT = /^-?\d+$/;
const isInt = (v: string): boolean => INT.test(v);
const secondsBetween = (a: bigint, b: bigint): number => Number((b - a) / NS);

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(record(v))) if (typeof x === "string") out[k] = x;
  return out;
}

function sortTxs(txs: TxRecord[]): TxRecord[] {
  return [...txs].sort((a, b) => {
    const ha = a.height ?? Number.MAX_SAFE_INTEGER;
    const hb = b.height ?? Number.MAX_SAFE_INTEGER;
    if (ha !== hb) return ha - hb;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });
}

const OMFT = /^([a-z]+)(?:-(?:0x)?[0-9a-zA-Z]+)?\.omft\.near$/;
/** Tokens the Omni bridge deploys on NEAR: `<chain>.omdep.near` (native) and `<chain>-0x<address>.omdep.near`. */
const OMDEP = /^([a-z]+)(?:-[^.]+)?\.omdep\.near$/;
export const OMNI_BRIDGE = "omni.bridge.near";

/**
 * PoA tokens the NEAR Intents SDK withdraws through the Omni bridge since 2026-08-14 and 2026-09-01
 * (defuse-protocol/sdk-monorepo, packages/intents-sdk/src/constants/poa-tokens-migrated-to-omni-bridge.ts, read
 * 2026-10-14). On chain the withdrawal's receiver says it; this list is the default when nothing else does.
 */
const POA_ON_OMNI: ReadonlySet<string> = new Set([
  "sol-57d087fd8c460f612f8701f5499ad8b2eec5ab68.omft.near",
  "sol-c58e6539c2f2e097c251f8edf11f9c03e581f8d4.omft.near",
  "sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near",
  "sol-bb27241c87aa401cc963c360c175dd7ca7035873.omft.near",
  "sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
  "sol-91914f13d3b54f8126a2824d71632d4b078d7403.omft.near",
  "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  "sol-df27d7abcc1c656d4ac3b1399bbfbba1994e6d8c.omft.near",
  "sol-1f00bb36e75cfc8e1274c1507cc3054f5b3f3ce1.omft.near",
  "sol-c634d063ceff771aff0c972ec396fd915a6bbd0e.omft.near",
  "sol-d600e625449a4d9380eaf5e3265e54c90d34e260.omft.near",
  "sol.omft.near",
  "aptos.omft.near",
  "aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near",
  "aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near",
  "starknet.omft.near",
  "zec.omft.near",
]);

/**
 * HOT bridge tokens are `nep245:v2_1.omni.hot.tg:<chain id>_<base58 address>` (docs.hotdao.ai; chain ids from the live
 * 1Click tokens and HOT's omni-sdk, read 2026-10-14; HOT's docs give 1111 for TON, the live tokens use 1117).
 */
const HOT_TOKEN = /^nep245:v2_1\.omni\.hot\.tg:(\d+)_([1-9A-HJ-NP-Za-km-z]*)$/;
const HOT_CHAINS: Record<string, string> = {
  "10": "op",
  "56": "bsc",
  "137": "pol",
  "143": "monad",
  "196": "xlayer",
  "1100": "stellar",
  "1111": "ton",
  "1117": "ton",
  "9745": "plasma",
  "36900": "adi",
  "43114": "avax",
  "534352": "scroll",
};
const HOT_CONTRACT = "v2_1.omni.hot.tg";
const HOT_EVM: ReadonlySet<string> = new Set(["op", "bsc", "pol", "monad", "xlayer", "plasma", "adi", "avax", "scroll"]);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (the Bitcoin alphabet) to bytes; null when it is not base58. */
export function base58Bytes(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** CRC-16/XMODEM: the checksum of TON's user-friendly addresses (big-endian) and of Stellar's StrKeys (little-endian). */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value & 0xff) << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + B32[(value << (5 - bits)) & 31] : out;
}

/** A Stellar StrKey: G… for an account (version 6 << 3), C… for a contract (2 << 3). */
function strKey(version: number, key: Uint8Array): string {
  const body = Uint8Array.from([version, ...key]);
  const crc = crc16(body);
  return base32(Uint8Array.from([...body, crc & 0xff, crc >> 8]));
}

/**
 * HOT names a TON receiver as its addr_std cell bits (tag 100, int8 workchain, 256-bit hash; 34 bytes) and a Stellar
 * receiver as the XDR of a Soroban ScVal address (00000012, then 0 + ed25519 key for an account, 1 + hash for a
 * contract). Both are shown in the form their wallets and HOT's own indexer use: TON non-bounceable (UQ…), StrKey.
 */
function tonAddress(bytes: Uint8Array): string | null {
  if (bytes.length !== 34) return null;
  const n = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  if (n >> 269n !== 4n) return null;
  const workchain = Number((n >> 261n) & 0xffn);
  const hash = (n >> 5n) & ((1n << 256n) - 1n);
  const raw = Uint8Array.from([0x51, workchain, ...Array.from({ length: 32 }, (_, i) => Number((hash >> BigInt(8 * (31 - i))) & 0xffn))]);
  const crc = crc16(raw);
  return btoa(String.fromCharCode(...raw, crc >> 8, crc & 0xff)).replace(/\+/g, "-").replace(/\//g, "_");
}

function stellarAddress(bytes: Uint8Array): string | null {
  const word = (i: number): number => ((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
  if (word(0) !== 18) return null;
  if (bytes.length === 44 && word(4) === 0 && word(8) === 0) return strKey(6 << 3, bytes.slice(12));
  if (bytes.length === 40 && word(4) === 1) return strKey(2 << 3, bytes.slice(8));
  return null;
}

/** A HOT withdrawal names its receiver base58-encoded: on an EVM chain the 20 bytes of a 0x address, on TON and Stellar their own encodings. */
function hotReceiver(receiver: string, chain: string | null): string {
  const bytes = chain === null ? null : base58Bytes(receiver);
  if (!bytes) return receiver;
  if (chain === "ton") return tonAddress(bytes) ?? receiver;
  if (chain === "stellar") return stellarAddress(bytes) ?? receiver;
  if (!HOT_EVM.has(chain ?? "")) return receiver;
  return bytes.length === 20 ? `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` : receiver;
}

/** Omni recipients start with the chain's short name (`zcash:u1…`); ours follow the PoA token names where they differ. */
const OMNI_CHAIN: Record<string, string> = { zcash: "zec", strk: "starknet" };
/** The same chain under another bridge's name, for comparing chains across bridges (Omni `bnb`, HOT and PoA `bsc`). */
const CHAIN_ALIAS: Record<string, string> = { bnb: "bsc", zcash: "zec", strk: "starknet" };
const sameChain = (a: string, b: string): boolean => (CHAIN_ALIAS[a] ?? a) === (CHAIN_ALIAS[b] ?? b);
/** PoA's BRIDGED_FROM memo names EVM chains `eth:<chain id>`; ours are the token-name prefixes. */
const POA_EVM_CHAIN: Record<string, string> = { "1": "eth", "8453": "base", "42161": "arb", "100": "gnosis", "9745": "plasma", "80094": "bera" };

/** The chain an origin is on, in the names withdrawals use; null when it is not known. */
export function originChain(o: OriginHop): string | null {
  if (o.status !== "proven") return null;
  if (o.kind === "near-native") return "near";
  if (o.kind === "hot") return o.chain;
  if (o.kind === "omni") return OMNI_CHAIN[o.chain] ?? o.chain;
  const [network, id] = o.chain.split(":");
  if (!network) return null;
  if (o.kind === "omni-utxo") return OMNI_CHAIN[network] ?? network;
  if (network === "eth") return id ? (POA_EVM_CHAIN[id] ?? null) : null;
  return network;
}

/** Where a token lives outside NEAR, and the bridge that usually carries it, from its NEAR contract. */
export function tokenRoute(tokenId: string): { chain: string | null; bridge: Bridge } {
  const hot = HOT_TOKEN.exec(tokenId);
  if (hot?.[1]) return { chain: HOT_CHAINS[hot[1]] ?? null, bridge: "hot" };
  const contract = tokenId.replace(/^nep141:/, "");
  const poa = OMFT.exec(contract);
  if (poa?.[1]) return { chain: poa[1], bridge: POA_ON_OMNI.has(contract) ? "omni" : "poa" };
  if (contract === "nbtc.bridge.near") return { chain: "btc", bridge: "omni" };
  const omni = OMDEP.exec(contract);
  if (omni?.[1]) return { chain: omni[1], bridge: "omni" };
  // Any other NEP-141 contract is a token on NEAR (USDC is the implicit account 17208628…, SWEAT is token.sweat).
  if (!tokenId.startsWith("nep245:") && NEAR_ACCOUNT.test(contract)) return { chain: "near", bridge: "near" };
  return { chain: null, bridge: "unknown" };
}

/** NEAR account ids (named, implicit, 0x/0s/0u): 2–64 characters of lower-case letters, digits and `-_.` separators. */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Accounts that carry a withdrawal off NEAR: the Omni bridge and its connectors (`*.bridge.near`) and HOT (`*.hot.tg`). */
const isBridgeAccount = (id: string): boolean => id === OMNI_BRIDGE || /(^|\.)bridge\.near$/.test(id) || /(^|\.)hot\.tg$/.test(id);

/** The `msg` inside an Omni withdrawal's JSON message, as text ("" when there is none). */
function innerMsg(d: Record<string, unknown>): string {
  try {
    return str(record(JSON.parse(str(d["msg"]) ?? ""))["msg"]) ?? "";
  } catch {
    return "";
  }
}

/** The bridge a withdrawal went through, from where it was sent: omni.bridge.near, or a PoA token burning itself. */
function withdrawRoute(d: Record<string, unknown>, token: string): { chain: string | null; bridge: Bridge } {
  const route = tokenRoute(token);
  const receiver = str(d["receiver_id"]);
  if (receiver === OMNI_BRIDGE) {
    let recipient: string | null = null;
    try {
      recipient = str(record(JSON.parse(str(d["msg"]) ?? ""))["recipient"]);
    } catch {
      /* no JSON message */
    }
    const short = recipient?.includes(":") ? recipient.split(":")[0] : undefined;
    // HyperEVM with the message "core" (hex 636F7265) delivers to Hyperliquid core, not to HyperEVM itself.
    if (short === "hlevm" && /"DestHexMsg"\s*:\s*"636f7265"/i.test(innerMsg(d))) return { chain: "hypercore", bridge: "omni" };
    return { chain: short ? (OMNI_CHAIN[short] ?? short) : route.chain, bridge: "omni" };
  }
  const contract = token.replace(/^nep141:/, "");
  if (receiver !== null && receiver === contract && OMFT.test(receiver)) return { chain: route.chain, bridge: "poa" };
  // Paid to a NEAR account (not a bridge, not the token burning itself, no PoA WITHDRAW_TO memo): a payout on NEAR,
  // whatever chain the token comes from (zec.omft.near withdrawn to hideon.near stays on NEAR).
  if (receiver !== null && receiver !== contract && NEAR_ACCOUNT.test(receiver) && !isBridgeAccount(receiver) && !str(d["memo"])?.startsWith("WITHDRAW_TO:")) return { chain: "near", bridge: "near" };
  return route;
}

function destinationOf(d: Record<string, unknown>, route: { chain: string | null; bridge: Bridge }): { destination: string | null; externalId: string | null } {
  if (route.bridge === "near") return { destination: str(d["receiver_id"]), externalId: null };
  const memo = str(d["memo"]);
  // PoA: WITHDRAW_TO:<address>[:<memo or destination tag>] (Intents SDK; XRP and Stellar carry a tag).
  const poa = memo ? /^WITHDRAW_TO:([^:]+)(?::(.+))?$/.exec(memo) : null;
  if (poa?.[1]) return { destination: poa[1], externalId: poa[2] ?? null };
  const msg = str(d["msg"]);
  if (msg) {
    try {
      const m = record(JSON.parse(msg));
      const recipient = str(m["recipient"]);
      if (recipient) return { destination: recipient, externalId: str(m["external_id"]) }; // Omni bridge
      const receiver = str(m["receiver_id"]);
      if (receiver) return { destination: route.bridge === "hot" ? hotReceiver(receiver, route.chain) : receiver, externalId: null }; // HOT bridge
    } catch {
      /* not JSON */
    }
  }
  return { destination: null, externalId: null };
}

/**
 * Where the order's first deposit came from. Each claim is read only from the contract that makes it, and only from a
 * step that succeeded: "another contract can print the same log" (docs.near.org /integrations/fungible-tokens).
 */
export function originOf(depositTx: TxRecord): OriginHop {
  for (const e of depositTx.events) {
    if (e.failed || e.standard !== "nep141" || e.event !== "ft_transfer" || !e.executor.endsWith(".omft.near")) continue;
    for (const d of e.data) {
      const memo = str(d["memo"]);
      if (!memo?.startsWith("BRIDGED_FROM:")) continue;
      try {
        const m = record(JSON.parse(memo.slice("BRIDGED_FROM:".length)));
        const txHash = str(m["txHash"]);
        if (txHash) return { status: "proven", kind: "poa", chain: `${str(m["networkType"]) ?? "?"}:${str(m["chainId"]) ?? "?"}`, txHash, how: "BRIDGED_FROM memo on the bridge deposit" };
      } catch {
        /* malformed memo */
      }
    }
  }
  // Omni UTXO bridges (btc-connector.bridge.near, zcash-connector.bridge.near): verifying a deposit adds its coin.
  if (depositTx.actions.some((a) => /^(safe_)?verify_deposit/.test(a.method ?? ""))) {
    for (const e of depositTx.events) {
      const connector = /^([a-z]+)-connector\.bridge\.near$/.exec(e.executor);
      if (!connector || e.failed || e.standard !== "bridge" || e.event !== "utxo_added") continue;
      const key = e.data.flatMap((d) => (Array.isArray(d["utxo_storage_keys"]) ? d["utxo_storage_keys"] : []))[0];
      const m = typeof key === "string" ? /^([0-9a-f]{64})@(\d+)$/.exec(key) : null;
      if (m?.[1] && m[2]) return { status: "proven", kind: "omni-utxo", chain: `${connector[1]}:mainnet`, txHash: m[1], vout: Number(m[2]), how: `utxo_added event of ${e.executor} on the deposit` };
    }
  }
  // The Omni bridge logs FinTransferEvent as plain JSON from its own contract when it finalises an inbound transfer.
  for (const { log, executor, failed } of depositTx.plainLogs) {
    if (failed || executor !== OMNI_BRIDGE || !log.startsWith("{")) continue;
    try {
      const t = record(record(record(JSON.parse(log))["FinTransferEvent"])["transfer_message"]);
      const sender = str(t["sender"]);
      const nonce = t["origin_nonce"];
      if (sender && nonce !== undefined) return { status: "proven", kind: "omni", chain: sender.split(":")[0] ?? "?", originNonce: String(nonce), sender, how: "FinTransferEvent origin nonce on the Omni bridge" };
    } catch {
      /* not JSON */
    }
  }
  if (depositTx.actions.some((a) => a.method === "ft_transfer_call" && str(record(a.args)["receiver_id"]) === "intents.near")) {
    return { status: "proven", kind: "near-native", chain: "near:mainnet", txHash: depositTx.hash, sender: depositTx.signer, how: "the NEAR transaction itself" };
  }
  // HOT: mt_deposit_call on its token contract, signed by HOT, names the chain the deposit was seen on and HOT's nonce.
  // With receipts, only one that succeeded counts; a source without them has only the signed call.
  const hot =
    depositTx.receiptActions.length > 0
      ? depositTx.receiptActions.find((a) => !a.failed && a.executor === HOT_CONTRACT && a.method === "mt_deposit_call")
      : depositTx.receiver === HOT_CONTRACT
        ? depositTx.actions.find((a) => a.method === "mt_deposit_call")
        : undefined;
  if (hot) {
    const args = record(hot.args);
    const chainId = typeof args["chain_id"] === "number" ? String(args["chain_id"]) : str(args["chain_id"]);
    const nonce = typeof args["nonce"] === "number" ? String(args["nonce"]) : str(args["nonce"]);
    if (chainId && nonce) return { status: "proven", kind: "hot", chain: HOT_CHAINS[chainId] ?? chainId, originNonce: nonce, how: `mt_deposit_call on the HOT bridge, signed by HOT for chain ${chainId}` };
  }
  // A NEAR token sent with ft_transfer_call in a meta-transaction (relayed by bridge-mng.near, sweat-relayer.near):
  // intents.near's ft_on_transfer names the account that sent it.
  const onTransfer = depositTx.receiptActions.find((a) => !a.failed && a.executor === "intents.near" && a.method === "ft_on_transfer");
  const sender = onTransfer ? str(record(onTransfer.args)["sender_id"]) : null;
  if (sender && NEAR_ACCOUNT.test(sender) && !isBridgeAccount(sender) && !sender.endsWith(".omft.near")) {
    return { status: "proven", kind: "near-native", chain: "near:mainnet", txHash: depositTx.hash, sender, how: sender === depositTx.signer ? "the NEAR transaction itself" : `ft_transfer_call to intents.near, relayed by ${depositTx.signer}` };
  }
  return { status: "unverified", kind: "unknown", how: "no origin reference recognised in the deposit transaction" };
}

function addTo(balances: Map<string, bigint>, token: string, amount: bigint): void {
  balances.set(token, (balances.get(token) ?? 0n) + amount);
}

function intentsEvents(tx: TxRecord): NepEvent[] {
  return tx.events.filter((e) => e.executor === "intents.near" && !e.failed);
}

/** The token ids and amounts of one nep245 mt_mint / mt_burn entry, skipping anything that is not a U128. */
function mtPairs(d: Record<string, unknown>): [string, bigint][] {
  const tokens = Array.isArray(d["token_ids"]) ? (d["token_ids"] as unknown[]) : [];
  const amounts = Array.isArray(d["amounts"]) ? (d["amounts"] as unknown[]) : [];
  const out: [string, bigint][] = [];
  tokens.forEach((t, i) => {
    const token = str(t);
    const amount = str(amounts[i]);
    if (token && amount && isInt(amount)) out.push([token, BigInt(amount)]);
  });
  return out;
}

/** The nep245 mt_transfer events to and from the account in one transaction, netted per counterparty and token. */
function mtTransferNet(events: NepEvent[], account: string): Map<string, Map<string, bigint>> {
  const net = new Map<string, Map<string, bigint>>();
  for (const e of events) {
    if (e.standard !== "nep245" || e.event !== "mt_transfer") continue;
    for (const d of e.data) {
      const from = str(d["old_owner_id"]);
      const to = str(d["new_owner_id"]);
      if (!from || !to || from === to || (from !== account && to !== account)) continue;
      const other = from === account ? to : from;
      const sign = to === account ? 1n : -1n;
      const tokens = net.get(other) ?? new Map<string, bigint>();
      for (const [token, amount] of mtPairs(d)) tokens.set(token, (tokens.get(token) ?? 0n) + sign * amount);
      net.set(other, tokens);
    }
  }
  return net;
}

const fullyReturned = (w: WithdrawHop): boolean => w.returned !== undefined && BigInt(w.returned) >= BigInt(w.amount);

/** A withdrawal that left the order account and never reached the destination: refused by the bridge, or bounced. */
const lostOnTheWay = (w: WithdrawHop): boolean => w.refused === true || w.bounced !== undefined;

/** The last withdrawal that did not come back, fail or bounce, and is not a refund of unused input: the one whose payout to look for. */
export function payingWithdrawal(r: { withdrawals: WithdrawHop[] }): WithdrawHop | undefined {
  const live = r.withdrawals.filter((w) => !fullyReturned(w) && !lostOnTheWay(w));
  return live.filter((w) => !w.excessRefund).at(-1) ?? live.at(-1);
}

export function traceOrder(input: TraceInput): OrderReport {
  const params = { ...DEFAULT_PARAMS, ...input.params };
  const { account, nowNs } = input;
  const txs = sortTxs(input.txs);
  // A leftover worth less than a few cents is dust, not stuck money (only with prices: `dustBelow`).
  const isDust = (token: string, amount: string): boolean => {
    const below = params.dustBelow?.[token];
    return below !== undefined && isInt(below) && isInt(amount) && BigInt(amount) < BigInt(below);
  };
  /** After each transaction: is the account empty again (nothing, or only dust)? */
  const emptyAfter = new Map<string, boolean>();
  const balances = new Map<string, bigint>();
  const deposits: CreditHop[] = [];
  const swaps: SwapHop[] = [];
  const transfers: TransferOut[] = [];
  const withdrawals: WithdrawHop[] = [];
  const comebacks: { tx: string; token: string; amount: bigint }[] = [];
  let depositTx: TxRecord | null = null;
  /** The order's first credit: a bridge deposit (its transaction) or a transfer inside NEAR Intents (its sender). */
  let firstCredit: { tx: TxRecord } | { from: string } | null = null;
  /** The latest lock of the account by intents.near's operators that no unlock has lifted (transactions run in order). */
  let lock: { tx: string; timestampNs: bigint | null } | null = null;

  for (const tx of txs) {
    const events = intentsEvents(tx);
    const diffAccounts = new Set<string>();
    for (const e of events) if (e.standard === "dip4" && e.event === "token_diff") for (const d of e.data) if (str(d["account_id"])) diffAccounts.add(str(d["account_id"]) as string);
    // What intents.near burned for this account in this transaction: every withdrawal, with its fees.
    const burns = events.filter((e) => e.standard === "nep245" && e.event === "mt_burn").flatMap((e) => e.data.filter((d) => str(d["owner_id"]) === account).flatMap(mtPairs));
    for (const [token, amount] of burns) addTo(balances, token, -amount);
    const namedByDip4 = events.some((e) => e.standard === "dip4" && e.data.some((d) => str(d["account_id"]) === account || str(d["receiver_id"]) === account));
    if (!namedByDip4) {
      for (const [other, tokens] of mtTransferNet(events, account)) {
        const out: Record<string, string> = {};
        for (const [token, v] of tokens) {
          if (v === 0n) continue;
          addTo(balances, token, v);
          if (v < 0n) {
            out[token] = (-v).toString();
            continue;
          }
          deposits.push({ status: "proven", tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, token, amount: v.toString(), via: "transfer", from: other });
          firstCredit ??= { from: other };
        }
        if (Object.keys(out).length > 0) transfers.push({ tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, to: other, toLabel: knownAccount(other)?.label ?? null, tokens: out });
      }
    }

    for (const e of events) {
      if (e.standard === "nep245" && e.event === "mt_mint") {
        for (const d of e.data) {
          const memo = str(d["memo"]);
          if (str(d["owner_id"]) !== account || (memo !== "deposit" && memo !== "refund")) continue;
          for (const [token, amount] of mtPairs(d)) {
            addTo(balances, token, amount);
            if (memo === "refund") {
              comebacks.push({ tx: tx.hash, token, amount });
              continue;
            }
            deposits.push({ status: "proven", tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, token, amount: amount.toString() });
            depositTx ??= tx;
            firstCredit ??= { tx };
          }
        }
        continue;
      }
      if (e.standard !== "dip4") continue;
      for (const d of e.data) {
        if (e.event === "transfer" && str(d["receiver_id"]) === account && str(d["account_id"]) !== account) {
          // An incoming transfer funds the order inside NEAR Intents: a 1Click INTENTS deposit, or the Confidential
          // Intents treasury unshielding the public leg of a confidential swap.
          const from = str(d["account_id"]) ?? "?";
          for (const [token, amt] of Object.entries(stringMap(d["tokens"]))) {
            if (!isInt(amt)) continue;
            addTo(balances, token, BigInt(amt));
            deposits.push({ status: "proven", tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, token, amount: amt, via: "transfer", from });
            firstCredit ??= { from };
          }
          continue;
        }
        if (str(d["account_id"]) !== account) continue;
        if (e.event === "account_locked" || e.event === "account_unlocked") {
          lock = e.event === "account_locked" ? { tx: tx.hash, timestampNs: tx.timestampNs } : null;
          continue;
        }
        if (e.event === "token_diff") {
          const diff = stringMap(d["diff"]);
          const gave: Record<string, string> = {};
          const got: Record<string, string> = {};
          for (const [token, amt] of Object.entries(diff)) {
            if (!isInt(amt)) continue;
            const v = BigInt(amt);
            addTo(balances, token, v);
            if (v < 0n) gave[token] = (-v).toString();
            else if (v > 0n) got[token] = v.toString();
          }
          swaps.push({
            status: "proven",
            tx: tx.hash,
            timestampNs: tx.timestampNs,
            height: tx.height,
            intentHash: str(d["intent_hash"]),
            gave,
            got,
            fees: stringMap(d["fees_collected"]),
            referral: str(d["referral"]),
            counterparties: [...diffAccounts].filter((a) => a !== account),
          });
        } else if (e.event === "transfer") {
          const tokens = Object.fromEntries(Object.entries(stringMap(d["tokens"])).filter(([, a]) => isInt(a)));
          for (const [token, amt] of Object.entries(tokens)) addTo(balances, token, -BigInt(amt));
          const to = str(d["receiver_id"]) ?? "?";
          transfers.push({ tx: tx.hash, timestampNs: tx.timestampNs, height: tx.height, to, toLabel: knownAccount(to)?.label ?? null, tokens });
        } else if (e.event === "ft_withdraw" || e.event === "mt_withdraw" || e.event === "native_withdraw") {
          const pairs: [string, string][] = [];
          if (e.event === "mt_withdraw") {
            // intents.near keys a NEP-245 balance as nep245:<contract>:<token id>; the event names the two apart.
            const contract = str(d["token"]);
            const ids = Array.isArray(d["token_ids"]) ? (d["token_ids"] as unknown[]) : [];
            const amts = Array.isArray(d["amounts"]) ? (d["amounts"] as unknown[]) : [];
            ids.forEach((t, i) => {
              const id = str(t);
              const amount = str(amts[i]);
              if (contract && id && amount && isInt(amount)) pairs.push([`nep245:${contract}:${id}`, amount]);
            });
          } else {
            const contract = e.event === "native_withdraw" ? "wrap.near" : str(d["token"]);
            const amount = str(d["amount"]);
            if (contract && amount && isInt(amount)) pairs.push([contract.startsWith("nep141:") ? contract : `nep141:${contract}`, amount]);
          }
          if (burns.length === 0) {
            // No mt_burn to count from: debit the withdrawal itself, and the storage deposit it pays in wNEAR.
            for (const [token, amount] of pairs) addTo(balances, token, -BigInt(amount));
            const storage = str(d["storage_deposit"]);
            if (storage && isInt(storage)) addTo(balances, "nep141:wrap.near", -BigInt(storage));
          }
          // HOT's gasless withdrawal adds the destination's native coin as a fee leg (a later token id on the same chain,
          // amount msg.amount_native): it is burned with the rest but it is not a withdrawal of its own.
          let feeLeg: string | null = null;
          try {
            feeLeg = str(record(JSON.parse(str(d["msg"]) ?? ""))["amount_native"]);
          } catch {
            /* no JSON message */
          }
          const hotChain = (t: string): string | undefined => HOT_TOKEN.exec(t)?.[1];
          const firstChain = pairs[0] ? hotChain(pairs[0][0]) : undefined;
          const hops = pairs.length > 1 && feeLeg && firstChain ? pairs.filter(([t, a], i) => !(i > 0 && a === feeLeg && hotChain(t) === firstChain)) : pairs;
          // With a message the token goes out by ft_transfer_call (mt_transfer_call for NEP-245); a failed call is not
          // credited back unless intents.near mints it back (memo "refund"), which is checked once comebacks are known.
          const tokenContract = e.event === "native_withdraw" ? null : str(d["token"])?.replace(/^nep141:/, "");
          const callFailed = tokenContract !== null && tokenContract !== undefined && tx.receiptActions.some((a) => a.failed === true && a.executor === tokenContract && /_transfer_call$/.test(a.method));
          const bounce = e.event === "native_withdraw" ? nativeBounce(tx, str(d["receiver_id"]), str(d["amount"])) : null;
          for (const [token, amount] of hops) {
            const route = withdrawRoute(d, token);
            const dest = destinationOf(d, route);
            withdrawals.push({
              status: "proven",
              tx: tx.hash,
              timestampNs: tx.timestampNs,
              height: tx.height,
              intentHash: str(d["intent_hash"]),
              kind: e.event,
              token,
              amount,
              chain: route.chain,
              bridge: route.bridge,
              destination: dest.destination,
              externalId: dest.externalId,
              ...(callFailed ? { refused: true } : {}),
              ...(bounce ? { bounced: bounce } : {}),
            });
          }
        }
      }
    }
    emptyAfter.set(tx.hash, [...balances].every(([t, v]) => v <= 0n || isDust(t, v.toString())));
  }

  const ownKey = input.txs.some((t) => t.signer === account);
  const OWN_KEY: Flag = { kind: "own_key", detail: "this account signs its own transactions, so its owner holds its key: it is not a 1Click order account" };
  if (!input.oneOrder) {
    const worthSomething = (token: string, amount: string): boolean => params.dustBelow?.[token] !== undefined && !isDust(token, amount);
    const parts = splitOrders(txs, emptyAfter, deposits, transfers, withdrawals, worthSomething);
    if (parts.length > 1) {
      const focused = input.focusTx ? parts.findIndex((p) => p.some((t) => t.hash === input.focusTx)) : -1;
      const index = focused >= 0 ? focused : parts.length - 1;
      const report = traceOrder({ ...input, txs: parts[index] ?? [], oneOrder: true });
      report.flags.unshift({
        kind: "several_orders",
        count: parts.length,
        shown: index + 1,
        detail: `this account received ${parts.length} separate deposits, each finished before the next arrived; this report follows ${focused >= 0 ? "the one with the transaction you gave" : "the latest"} (${index + 1} of ${parts.length}). Paste another one's NEAR transaction to see it.`,
      });
      if (ownKey && !report.flags.some((f) => f.kind === "own_key")) report.flags.push(OWN_KEY);
      return report;
    }
  }

  const remaining: Record<string, string> = {};
  let sawNegative = false;
  for (const [token, v] of [...balances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v < 0n) sawNegative = true;
    else if (v > 0n) remaining[token] = v.toString();
  }

  // A failed withdrawal's tokens come back in the same transaction: mark the withdrawals they belong to.
  for (const c of comebacks) {
    let left = c.amount;
    for (const w of withdrawals) {
      if (left === 0n || w.tx !== c.tx || w.token !== c.token) continue;
      const already = BigInt(w.returned ?? "0");
      const take = left < BigInt(w.amount) - already ? left : BigInt(w.amount) - already;
      if (take <= 0n) continue;
      w.returned = (already + take).toString();
      left -= take;
    }
  }
  // A refused call whose tokens came back after all is a returned withdrawal.
  for (const w of withdrawals) if (w.refused && w.returned !== undefined) delete w.refused;
  // After a swap, withdrawing a deposited token the swap did not produce returns the unused input, when another
  // withdrawal pays out what the swap produced. Alone it is the payout itself (the swap only bought a bridge fee).
  if (swaps.length > 0) {
    const got = new Set(swaps.flatMap((s) => Object.keys(s.got)));
    const minted = new Set(deposits.filter((d) => d.via !== "transfer").map((d) => d.token));
    if (withdrawals.some((w) => got.has(w.token))) for (const w of withdrawals) if (!got.has(w.token) && minted.has(w.token)) w.excessRefund = true;
  }
  const paying = withdrawals.filter((w) => !fullyReturned(w) && !lostOnTheWay(w));
  // Money that left the order account and sits with intents.near: nothing moves it on by itself.
  const lost = withdrawals.some(lostOnTheWay);

  const flags: Flag[] = [];
  // A transaction whose spawned receipts have not all run is still executing ("A missing outcome is pending",
  // docs.near.org /integrations/fungible-tokens): the order is in progress whatever has run so far.
  let executing: TxRecord | undefined;
  for (const t of txs) {
    const n = t.pendingReceipts?.length ?? 0;
    if (n === 0) continue;
    if (t.timestampNs === null || nowNs - t.timestampNs < EXECUTING_AT_MOST_NS) {
      executing ??= t;
      if (executing === t) flags.push({ kind: "executing", tx: t.hash, detail: `NEAR is still executing transaction ${t.hash} (${n} of its steps ${n === 1 ? "has" : "have"} not run yet): this is not final, check again in a minute` });
    } else flags.push({ kind: "incomplete_history", detail: `transaction ${t.hash} is missing ${n} of its steps in the data we read, long after it ran: part of it is not traced` });
  }
  const firstDeposit = deposits[0];
  const firstSwap = swaps[0];
  const lastWithdrawal = payingWithdrawal({ withdrawals: paying });
  const intents = [...swaps, ...transfers, ...withdrawals];
  // Unshielded from Confidential Intents: the swap happened on the private side, so withdrawing that token is the payout.
  const unshielded = deposits.some((d) => d.via === "transfer" && d.from !== undefined && knownAccount(d.from)?.kind === "confidential");
  const depositTokens = new Set(deposits.filter((d) => !(d.via === "transfer" && d.from !== undefined && knownAccount(d.from)?.kind === "confidential")).map((d) => d.token));
  const origin: OriginHop =
    firstCredit !== null && "from" in firstCredit
      ? {
          status: "unverified",
          kind: "unknown",
          how: knownAccount(firstCredit.from)?.kind === "confidential" ? "unshielded from the Confidential Intents treasury: the private leg before it is not public" : `funded by a transfer inside NEAR Intents from ${firstCredit.from}`,
        }
      : depositTx
        ? originOf(depositTx)
        : { status: "missing" };
  // A refund returns the deposited token to the chain it came from; the same token sent on to another chain is a
  // cross-chain move (ZEC on Solana to a shielded Zcash address, wNEAR to Hyperliquid). Unknown origins count as refunds.
  const fromChain = originChain(origin);
  const backToOrigin = (w: WithdrawHop): boolean => fromChain === null || w.chain === null || sameChain(w.chain, fromChain);
  const isRefund = swaps.length === 0 && paying.some((w) => depositTokens.has(w.token) && backToOrigin(w));

  if (firstDeposit && firstSwap && firstDeposit.timestampNs !== null && firstSwap.timestampNs !== null) {
    const delaySec = secondsBetween(firstDeposit.timestampNs, firstSwap.timestampNs);
    if (delaySec > params.lateAfterSec) flags.push({ kind: "settled_late", delaySec, detail: `${describeDuration(delaySec)} from credit to the first intent` });
  }
  if (isRefund) flags.push({ kind: "refunded", detail: "the deposited token was withdrawn without a swap" });
  if (withdrawals.some((w) => w.returned !== undefined)) flags.push({ kind: "withdrawal_returned", detail: "a withdrawal failed and its tokens came back to the order account" });
  if (withdrawals.some((w) => w.refused)) flags.push({ kind: "withdrawal_refused", detail: "the transfer to the bridge failed, and NEAR Intents does not credit a failed ft_transfer_call back: the tokens stay with intents.near, outside the order account" });
  const bounced = withdrawals.find((w) => w.bounced);
  if (bounced?.bounced) flags.push({ kind: "payout_bounced", detail: bounceDetail(bounced, bounced.bounced) });
  const shieldHeights = [
    ...transfers.filter((t) => knownAccount(t.to)?.kind === "confidential").map((t) => t.height ?? -1),
    ...withdrawals.filter((w) => w.destination !== null && knownAccount(w.destination)?.kind === "confidential").map((w) => w.height ?? -1),
  ];
  const toConfidential = shieldHeights.length > 0;
  // Shielded, then back from the treasury and withdrawn in public after it: a round trip that finished in the open.
  const roundTrip = toConfidential && lastWithdrawal !== undefined && (lastWithdrawal.height ?? -1) > Math.max(...shieldHeights);
  if (roundTrip) flags.push({ kind: "confidential", detail: "part of the order went through Confidential Intents and came back; the withdrawal after it is public" });
  else if (toConfidential) flags.push({ kind: "confidential", detail: "funds moved into Confidential Intents; later legs are not visible on public NEAR" });
  else if (unshielded) flags.push({ kind: "confidential", detail: "funded from Confidential Intents; the legs before it are not visible on public NEAR" });
  // Deposits that arrive after the order's last outflow (a refund or payout) are separate: if they explain the whole
  // leftover, the order itself finished and the leftover is named instead of calling the order stuck.
  const outflowHeights = [...swaps, ...transfers, ...withdrawals].map((h) => h.height ?? -1);
  const lastOutflow = outflowHeights.length ? Math.max(...outflowHeights) : null;
  const later = new Map<string, bigint>();
  if (lastOutflow !== null) for (const d of deposits) if ((d.height ?? -1) > lastOutflow) later.set(d.token, (later.get(d.token) ?? 0n) + BigInt(d.amount));
  // A later deposit worth more than dust is an order of its own (splitOrders); one we cannot price, or dust, is named here.
  const leftover = Object.entries(remaining);
  const dustLeft = leftover.filter(([t, a]) => isDust(t, a));
  const laterLeft = leftover.filter(([t, a]) => later.get(t) === BigInt(a) && !isDust(t, a));
  const leftoverExplained = lastOutflow !== null && leftover.length > 0 && laterLeft.length + dustLeft.length === leftover.length;
  if (leftoverExplained && laterLeft.length > 0) flags.push({ kind: "later_deposit", detail: "the amount still in the account arrived after the order finished; it is a separate deposit, not part of this order" });
  if (leftoverExplained && dustLeft.length > 0) flags.push({ kind: "dust", detail: "what is left in the order account is worth less than 5 US cents at current prices: dust, not stuck money" });
  if (sawNegative) flags.push({ kind: "incomplete_history", detail: "more left the account than we saw arrive; part of its history is missing" });
  const emptied = leftover.length === 0 || leftoverExplained;
  // No withdrawal, everything moved on by transfers inside NEAR Intents (a 1Click INTENTS recipient or refund type):
  // the payout is the largest transfer of what the order got (or, with no swap, of what it was credited) to an account
  // that is not a documented fee collector or treasury. Not when a withdrawal was lost on the way: that was the payout.
  const intentsPayout = paying.length === 0 && emptied && !lost ? transferPayout(swaps, deposits, transfers) : null;

  let verdict: Verdict;
  if (executing) verdict = "in_progress";
  else if (deposits.length === 0) verdict = "not_found";
  else if (emptied && toConfidential && !roundTrip) verdict = "confidential";
  else if (emptied && paying.length > 0) verdict = isRefund ? "refunded" : "settled";
  else if (intentsPayout) verdict = swaps.length === 0 ? "refunded" : "settled";
  // Nothing will move a refused or bounced withdrawal by itself: it needs NEAR Intents, now rather than after the stall window.
  else if (lost && emptied) verdict = "stuck";
  // Nor money in an account intents.near has locked: not a stall that 1Click can end, so no stall window either.
  else if (lock) verdict = "stuck";
  else {
    const lastTs = [...deposits, ...intents].reduce<bigint | null>((m, h) => (h.timestampNs !== null && (m === null || h.timestampNs > m) ? h.timestampNs : m), null);
    const waitedSec = lastTs === null ? 0 : secondsBetween(lastTs, nowNs);
    if (waitedSec > params.stallAfterSec) {
      flags.push({ kind: "stalled", waitedSec, detail: intents.length === 0 ? "credited, no intent since" : "funds still in the order account after the last intent" });
      verdict = "stuck";
    } else verdict = "in_progress";
  }

  let payout: PayoutHop = lastWithdrawal ? nearPayout(lastWithdrawal, txs) : (intentsPayout ?? { status: "missing" });
  // A withdrawal whose transaction is still executing has not paid out yet, unless the payout is already proven.
  if (lastWithdrawal && executing?.hash === lastWithdrawal.tx && payout.status !== "arrived") {
    payout = { status: "waiting", chain: lastWithdrawal.chain, bridge: lastWithdrawal.bridge, destination: lastWithdrawal.destination, waitedSec: lastWithdrawal.timestampNs === null ? 0 : secondsBetween(lastWithdrawal.timestampNs, nowNs) };
  }
  if (lock) flags.push({ kind: "locked", tx: lock.tx, waitedSec: lock.timestampNs === null ? 0 : secondsBetween(lock.timestampNs, nowNs), detail: LOCKED_DETAIL });
  if (ownKey) flags.push(OWN_KEY);

  return {
    account,
    verdict,
    oneClickStatus: ONE_CLICK[verdict],
    origin,
    deposits,
    swaps,
    transfers,
    withdrawals,
    payout,
    balances: remaining,
    flags,
  };
}

/**
 * An account's history as separate orders. One ends when money has left and the account is empty again (or holds only
 * dust); a later credit worth more than dust starts the next. A credit from an account this order sent money to is its
 * return leg (a confidential round trip, a trade done by transfers) and continues it; a credit we cannot price stays
 * with the order before it (it may be a few drops sent after the order). One part means the history is one order.
 */
function splitOrders(txs: TxRecord[], emptyAfter: Map<string, boolean>, deposits: CreditHop[], transfers: TransferOut[], withdrawals: WithdrawHop[], worthSomething: (token: string, amount: string) => boolean): TxRecord[][] {
  interface Part {
    txs: TxRecord[];
    sentTo: Set<string>;
    credited: boolean;
    paidOut: boolean;
  }
  const parts: Part[] = [];
  let open: Part | null = null;
  for (const tx of txs) {
    const credits = deposits.filter((d) => d.tx === tx.hash);
    if (open === null) {
      const last = parts.at(-1);
      const returnLeg = last !== undefined && credits.length > 0 && credits.every((d) => d.from !== undefined && last.sentTo.has(d.from));
      const worthAnOrder = credits.some((d) => worthSomething(d.token, d.amount));
      if (last && (!worthAnOrder || returnLeg)) open = parts.pop() ?? null;
      open ??= { txs: [], sentTo: new Set(), credited: false, paidOut: false };
    }
    open.txs.push(tx);
    if (credits.length > 0) open.credited = true;
    for (const t of transfers) if (t.tx === tx.hash) open.sentTo.add(t.to);
    if (transfers.some((t) => t.tx === tx.hash) || withdrawals.some((w) => w.tx === tx.hash)) open.paidOut = true;
    if (open.credited && open.paidOut && emptyAfter.get(tx.hash) === true) {
      parts.push(open);
      open = null;
    }
  }
  if (open) parts.push(open);
  return parts.filter((p) => p.credited).length > 1 ? parts.map((p) => p.txs) : [txs];
}

/** The transfer inside NEAR Intents that paid the order out, when no withdrawal did: its token and amount. */
export function payoutTransfer(r: Pick<OrderReport, "payout" | "transfers">): { transfer: TransferOut; token: string } | null {
  const p = r.payout;
  if (p.status !== "arrived" || p.via !== "transfer") return null;
  const transfer = r.transfers.find((t) => t.tx === p.tx && t.to === p.destination);
  const token = transfer ? Object.entries(transfer.tokens).find(([, a]) => a === p.amount)?.[0] : undefined;
  return transfer && token ? { transfer, token } : null;
}

/** Where a credit came from, in words, when it was not a bridge deposit; null for a deposit. */
export function creditSource(d: CreditHop): string | null {
  if (d.via !== "transfer") return null;
  const label = d.from === undefined ? null : (knownAccount(d.from)?.label ?? null);
  return label ? `transferred in from the ${label}` : `transferred in from ${d.from ?? "another NEAR Intents account"}`;
}

/** The transfer inside NEAR Intents that paid the order out, when no withdrawal did; null if none fits. */
function transferPayout(swaps: SwapHop[], deposits: CreditHop[], transfers: TransferOut[]): PayoutHop | null {
  const wanted = new Set(swaps.length ? swaps.flatMap((s) => Object.keys(s.got)) : deposits.map((d) => d.token));
  let best: { t: TransferOut; token: string; amount: bigint } | null = null;
  for (const t of transfers) {
    if (t.toLabel !== null) continue;
    for (const [token, amt] of Object.entries(t.tokens)) {
      if (!wanted.has(token)) continue;
      const amount = BigInt(amt);
      if (!best || amount > best.amount) best = { t, token, amount };
    }
  }
  if (!best) return null;
  return { status: "arrived", how: "proven", chain: "near", bridge: "near", destination: best.t.to, tx: best.t.tx, amount: best.amount.toString(), delaySec: 0, confirmed: true, via: "transfer" };
}

/**
 * A payout to a NEAR account happens inside the withdrawal transaction: the token contract's nep141 ft_transfer to the
 * destination. Payouts to other chains start as unverified; the checker searches the destination chain for them.
 */
function nearPayout(w: WithdrawHop, txs: TxRecord[]): PayoutHop {
  const base = { chain: w.chain, bridge: w.bridge, destination: w.destination };
  if (w.bridge !== "near" || !w.destination) return { status: "unverified", ...base };
  const tx = txs.find((t) => t.hash === w.tx);
  if (w.kind === "native_withdraw") {
    // Native NEAR is paid by a Transfer action from intents.near, which logs no event: the receipt itself is the proof.
    const sent = tx?.nativeTransfers?.some((n) => !n.failed && n.from === "intents.near" && n.to === w.destination && n.deposit === w.amount);
    if (sent) return { status: "arrived", how: "proven", ...base, tx: w.tx, amount: w.amount, delaySec: 0, confirmed: true };
    return { status: "unverified", ...base, reason: tx?.nativeTransfers ? "no successful transfer of the withdrawn NEAR to the destination in the withdrawal transaction" : "native NEAR is paid by a plain transfer that logs no event; check the receiver on the explorer" };
  }
  const contract = w.token.replace(/^nep141:/, "");
  const paid = tx?.events.find(
    (e) => !e.failed && e.standard === "nep141" && e.event === "ft_transfer" && e.executor === contract && e.data.some((d) => str(d["new_owner_id"]) === w.destination && str(d["amount"]) === w.amount),
  );
  // wrap.near logs a plain "Transfer <amount> from intents.near to <receiver>" rather than a NEP-297 event.
  const wrapped = contract === "wrap.near" && tx?.plainLogs.some((l) => !l.failed && l.executor === "wrap.near" && l.log === `Transfer ${w.amount} from intents.near to ${w.destination}`);
  if (!paid && !wrapped) return { status: "unverified", ...base, reason: "no successful transfer to the destination in the withdrawal transaction" };
  return { status: "arrived", how: "proven", ...base, tx: w.tx, amount: w.amount, delaySec: 0, confirmed: true };
}

export function describeDuration(sec: number): string {
  if (sec < 90) return `${sec} s`;
  if (sec < 5_400) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3_600)} h`;
  return `${Math.round(sec / 86_400)} days`;
}

/** The ids 1Click order accounts take: implicit (64 hex), and the `0x`/`0s`/`0u` shapes. */
const ORDER_ID = /^(?:[0-9a-f]{64}|0x[0-9a-f]{40}|0s[0-9a-f]{40}|0u[0-9a-hjkmnp-tv-z]{51}[0g])$/;

/** Whether an account id has the shape of a 1Click order account. */
export const isOrderId = (account: string): boolean => ORDER_ID.test(account);

/**
 * The order account a transaction belongs to: the user leg of a 1Click swap (it carries the referral), else the
 * credited account, else the withdrawer, else a swapping account; in a transaction that only moves tokens between
 * accounts, the account being funded (or, when it pays a documented account such as the confidential treasury, the
 * account paying).
 */
export function findOrderAccount(tx: TxRecord): string | null {
  // What succeeded first; a transaction that failed (a swap that did not go through) still names its account.
  const all = tx.events.filter((e) => e.executor === "intents.near");
  return orderAccountIn(all.filter((e) => !e.failed)) ?? orderAccountIn(all);
}

function orderAccountIn(intents: NepEvent[]): string | null {
  const diffs = intents.filter((e) => e.standard === "dip4" && e.event === "token_diff").flatMap((e) => e.data);
  // Before the deposit rule: a solver's round trip through Ref mints to the solver (memo "deposit") in the same batch.
  const withReferral = diffs.find((d) => str(d["referral"]) && str(d["account_id"]));
  if (withReferral) return str(withReferral["account_id"]);
  for (const e of intents) if (e.standard === "nep245" && e.event === "mt_mint") for (const d of e.data) if (str(d["memo"]) === "deposit" && str(d["owner_id"])) return str(d["owner_id"]);
  for (const e of intents) if (e.standard === "dip4" && /_withdraw$/.test(e.event)) for (const d of e.data) if (str(d["account_id"])) return str(d["account_id"]);
  const implicit = diffs.map((d) => str(d["account_id"])).find((a) => a && ORDER_ID.test(a));
  if (implicit) return implicit;
  if (diffs[0]) return str(diffs[0]["account_id"]);
  const funded: string[] = [];
  for (const e of intents) {
    for (const d of e.data) {
      const move = e.standard === "dip4" && e.event === "transfer" ? [str(d["account_id"]), str(d["receiver_id"])] : e.standard === "nep245" && e.event === "mt_transfer" ? [str(d["old_owner_id"]), str(d["new_owner_id"])] : null;
      const [from, to] = move ?? [];
      if (from && to) funded.push(knownAccount(to) ? from : to);
    }
  }
  return funded.find((a) => ORDER_ID.test(a)) ?? funded[0] ?? null;
}
