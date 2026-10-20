// Checks one NEAR Intents order from public data: resolve what the user pasted to an order account, pull the account's
// transactions from FastNEAR, and trace them. The only I/O is through `NearClient`; `fastnearClient` is the real one.

import type { TxRecord } from "./core/decode.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearAccountResponse, type FastnearTransactionsResponse } from "./core/fastnear.js";
import { expectedWithinSec, matchPayout, payoutTarget, type IncomingPage } from "./core/payout.js";
import { destinationMissing, findOrderAccount, payingWithdrawal, traceOrder, type BridgeReport, type OrderReport, type PayoutHop, type TraceParams } from "./core/trace.js";
import { balanceCheck, claimableName, type BalanceCheck } from "./core/views.js";
import { texToTransparent } from "./core/zcash-address.js";
import { originKind } from "./core/origin.js";
import { nearViews, type NearViews } from "./near-views.js";
import { findOrderByOrigin, type OriginClient } from "./origin.js";
import type { AccountTx, NearClient } from "./near-client.js";
import type { PayoutClient } from "./payouts.js";

export type { AccountTx, NearClient } from "./near-client.js";

export type ResolvedInput = { kind: "account"; account: string } | { kind: "tx"; hash: string } | { kind: "unsupported"; reason: string };

// Account ids (docs.near.org /web3-apps/tutorials/account-validation; NEP-518, NEP-616, NEP-655): implicit 64 hex;
// Ethereum-like `0x` and deterministic `0s` with 40 lowercase hex (42 characters; NEAR Intents gives EVM, TRON and
// passkey users a `0x` account); universal `0u` with 52 Crockford base32 symbols, the last `0` or `g` (54 characters,
// from protocol 88, 2026-11-03); and named accounts of 2–64 characters under any top-level account.
const IMPLICIT = /^[0-9a-f]{64}$/;
const ETH_LIKE = /^0x[0-9a-f]{40}$/;
const DETERMINISTIC = /^0s[0-9a-f]{40}$/;
const UNIVERSAL = /^0u[0-9a-hjkmnp-tv-z]{51}[0g]$/;
const NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

export function resolveInput(raw: string): ResolvedInput {
  const s = raw.trim();
  const lower = s.toLowerCase();
  if (EVM_HASH.test(s)) return { kind: "unsupported", reason: "origin-chain transaction hashes are not searchable yet; paste the NEAR transaction or the order account" };
  if (ETH_LIKE.test(lower) || DETERMINISTIC.test(lower) || UNIVERSAL.test(lower) || IMPLICIT.test(lower)) return { kind: "account", account: lower };
  // Before named accounts: a mixed-case base58 hash lower-cased would also pass the named-account pattern.
  if (BASE58_HASH.test(s)) return { kind: "tx", hash: s };
  if (NAMED.test(lower)) return { kind: "account", account: lower };
  return { kind: "unsupported", reason: "not a NEAR account or transaction hash" };
}

export { findOrderAccount } from "./core/trace.js";

export interface CheckResult extends OrderReport {
  resolvedFrom: ResolvedInput;
  /** How a pasted hash was found: as a transaction, as a receipt whose parent transaction was traced, or as the user's
   * own transaction on its chain (`origin`), found through the bridge deposit that names it. */
  resolvedVia: "account" | "transaction" | "receipt" | "origin";
  /** For `origin`: the chain and the NEAR deposit that named the pasted transaction. */
  /** `depositTx`: the NEAR deposit that names the transaction; absent for an Omni BTC deposit, found by its deposit address. */
  /** `via: "omni"`: found in the Omni bridge's indexer, which records the transfer the user's transaction started. */
  foundBy?: { chain: string; originTx: string; depositTx?: string; via?: "omni" };
  txCount: number;
  /** The balance the history adds up to, checked against intents.near's own views; absent without that view. */
  balanceCheck?: BalanceCheck;
  /** Set when the history came from the backup source because FastNEAR was unavailable (checkOrderWithFallback). */
  historySource?: "nearblocks";
}

/**
 * Whether an error means FastNEAR could not serve the history at all: rate limited after fastnearClient's retries, a
 * server error, refused (401/403, should it start requiring its key), or unreachable (fetch's TypeError). Any other
 * error is an answer (an unknown hash, an empty history, a wallet-sized account) and stays one.
 */
export function fastnearUnavailable(e: unknown): boolean {
  if (e instanceof TypeError) return /fetch|network|load failed/i.test(e.message);
  if (!(e instanceof Error)) return false;
  const m = /^FastNEAR \S+: HTTP (\d{3})$/.exec(e.message);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

/** A second history source, asked only while FastNEAR is unavailable. `client` makes a fresh one per check. */
export interface HistoryFallback {
  source: "nearblocks";
  client: () => NearClient;
}

const SOURCE_NAME: Record<HistoryFallback["source"], string> = { nearblocks: "NearBlocks" };

/**
 * `checkOrder` on `client` (FastNEAR); if FastNEAR is unavailable and a fallback is given, the same check on the
 * fallback, marked with its source so the report credits it. NearBlocks' free tier is for personal use: the CLI passes
 * it, and the public site must not until NearBlocks agrees or a paid plan is in place (nearblocks-client.ts).
 */
export async function checkOrderWithFallback(input: string, client: NearClient, nowNs: bigint, params?: Partial<TraceParams>, payouts?: PayoutClient, origins?: OriginClient, fallback?: HistoryFallback): Promise<CheckResult> {
  try {
    return await checkOrder(input, client, nowNs, params, payouts, origins);
  } catch (e) {
    if (!fallback || !fastnearUnavailable(e)) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    try {
      return { ...(await checkOrder(input, fallback.client(), nowNs, params, payouts, origins)), historySource: fallback.source };
    } catch (e2) {
      throw new Error(`FastNEAR is unavailable (${reason}), and the backup source, ${SOURCE_NAME[fallback.source]}, could not answer either: ${e2 instanceof Error ? e2.message : String(e2)}`, { cause: e2 });
    }
  }
}

/** With `payouts`, a payout to another chain is searched for on that chain; without it the hop stays unverified. */
export async function checkOrder(input: string, client: NearClient, nowNs: bigint, params?: Partial<TraceParams>, payouts?: PayoutClient, origins?: OriginClient): Promise<CheckResult> {
  // Prices tell a leftover worth a few cents (dust) from stuck money; without them nothing is called dust.
  const dusting = !params?.dustBelow && payouts?.dustBelow ? payouts.dustBelow().catch(() => undefined) : Promise.resolve(undefined);
  const resolved = resolveInput(input);
  const kind = originKind(input);
  let account: string;
  let resolvedVia: CheckResult["resolvedVia"] = "account";
  let focus: string | undefined;
  let foundBy: CheckResult["foundBy"];
  const byOrigin = async (): Promise<string> => {
    if (!origins) throw new Error("origin-chain transaction hashes are not searchable here; paste the NEAR transaction or the order account");
    const r = await findOrderByOrigin(input, client, origins);
    if ("notFound" in r) throw new Error(r.notFound);
    resolvedVia = "origin";
    foundBy = { chain: r.chain, originTx: r.originTx, ...(r.depositTx ? { depositTx: r.depositTx } : {}), ...(r.via ? { via: r.via } : {}) };
    return r.account;
  };
  if (resolved.kind === "unsupported") {
    if (kind !== "evm" && kind !== "solana") throw new Error(resolved.reason);
    account = await byOrigin();
  } else if (resolved.kind === "tx") {
    let tx: TxRecord | undefined = (await client.transactions([resolved.hash]))[0];
    resolvedVia = "transaction";
    if (!tx && client.receiptTx) {
      tx = (await client.receiptTx(resolved.hash)) ?? undefined;
      resolvedVia = "receipt";
    }
    if (!tx) throw new Error(`${resolved.hash} is neither a transaction nor a receipt on NEAR`);
    focus = tx.hash;
    const found = findOrderAccount(tx);
    if (!found && tx.pendingReceipts) throw new Error(`transaction ${tx.hash} is still executing on NEAR: check again in a minute`);
    if (!found) throw new Error(`transaction ${tx.hash} carries no NEAR Intents order (no deposit, swap or withdrawal on intents.near)`);
    account = found;
  } else account = resolved.account;

  const seen = new Set<string>();
  let history = (await client.accountTxs(account)).filter((t) => !seen.has(t.hash) && seen.add(t.hash) !== undefined);
  // 64 hex characters is a NEAR implicit account, or a TRON or Bitcoin transaction: an empty account means try those.
  if (history.length === 0 && kind === "hex64" && origins && resolvedVia === "account") {
    account = await byOrigin();
    history = (await client.accountTxs(account)).filter((t) => !seen.has(t.hash) && seen.add(t.hash) !== undefined);
  }
  if (history.length === 0 && resolvedVia === "account" && ETH_LIKE.test(account)) {
    throw new Error(`${account} has no NEAR Intents history. If it is your EVM wallet or a 1Click deposit address, paste your deposit transaction instead.`);
  }
  const txs: TxRecord[] = [];
  for (let i = 0; i < history.length; i += 20) txs.push(...(await client.transactions(history.slice(i, i + 20).map((t) => t.hash))));
  const dustBelow = await dusting;
  // A pasted transaction (or the deposit that names a pasted origin transaction) picks the order when the account holds several.
  const focusTx = resolvedVia === "transaction" || resolvedVia === "receipt" ? focus : foundBy?.depositTx;
  const report = traceOrder({ account, txs, nowNs, params: dustBelow ? { ...params, dustBelow } : params, ...(focusTx ? { focusTx } : {}) });
  const lastWithdrawal = payingWithdrawal(report);
  // While a transaction is still executing nothing is final: the destination chain is searched once it has run.
  const executing = report.flags.some((f) => f.kind === "executing");
  // Where the money is, proven from chain state: intents.near's balances at a final block, read while the payout is
  // searched. Not while executing, nor for an account of several orders (the chain shows what they left together).
  const several = report.flags.some((f) => f.kind === "several_orders");
  const skipReason = executing ? "a transaction is still executing" : several ? "this account held several orders, and intents.near shows only what they left together" : null;
  const chainBalances = client.intentsBalances && skipReason === null ? client.intentsBalances(account).catch(() => null) : null;
  if (payouts && !executing && lastWithdrawal && report.payout.status === "unverified" && lastWithdrawal.bridge !== "near") {
    report.payout = await searchPayout(lastWithdrawal, payouts, nowNs);
    if (report.payout.status === "not_found") {
      report.flags.push({ kind: "payout_not_found", waitedSec: report.payout.waitedSec, detail: "no transfer of about the withdrawn amount reached the destination address" });
    }
  }
  // A token payout to a name nobody has created is credited all the same (see destinationMissing): ask NEAR whether the
  // name exists. Native NEAR needs no asking (a transfer to a missing name fails, see Bounce), nor do keyed accounts.
  const p = report.payout;
  if (client.accountExists && !executing && p.status === "arrived" && p.bridge === "near" && p.via !== "transfer" && lastWithdrawal?.kind !== "native_withdraw" && p.destination && claimableName(p.destination)) {
    if ((await client.accountExists(p.destination).catch(() => null)) === false) report.flags.push(destinationMissing(p.destination));
  }
  let checked: BalanceCheck | undefined;
  if (client.intentsBalances) {
    if (chainBalances === null) checked = { status: "not_verified", reason: skipReason ?? "intents.near's balances could not be read now" };
    else {
      const { check, flag } = balanceCheck(report.balances, await chainBalances);
      checked = check;
      if (flag) report.flags.push(flag);
    }
  }
  return { ...report, resolvedFrom: resolved, resolvedVia, ...(foundBy ? { foundBy } : {}), txCount: txs.length, ...(checked ? { balanceCheck: checked } : {}) };
}

/** A withdrawal's payout on its destination chain, the way the checker reads it (also used by the ZEC route page). */
export async function searchPayout(w: OrderReport["withdrawals"][number], payouts: PayoutClient, nowNs: bigint): Promise<PayoutHop> {
  const base = { chain: w.chain, bridge: w.bridge, destination: w.destination };
  // The bridge's own report (PoA status API, Omni indexer) is extra evidence: if it cannot be read, the on-chain search
  // stands alone.
  const ask = (): Promise<BridgeReport | null> | null => {
    if (!w.tx) return null;
    if (w.bridge === "poa" && payouts.bridgeWithdrawal) return payouts.bridgeWithdrawal(w.tx, w.token);
    if (w.bridge === "omni" && payouts.omniTransfer) return payouts.omniTransfer(w.tx, w.token, w.amount);
    if (w.bridge === "hot" && payouts.hotWithdrawal) return payouts.hotWithdrawal(w.tx);
    return null;
  };
  const asking = (ask() ?? Promise.resolve(null)).catch(() => null);
  // The indexer names no payout yet: the destination's Omni bridge contract keeps its own record, by destination nonce
  // (on 2026-10-18 it showed 10 of 177 transfers the indexer still listed as unpaid as paid). It needs no reader for
  // the token, so it answers too where the payout itself cannot be read.
  const recorded = async (report: BridgeReport | null): Promise<PayoutHop | null> => {
    const nonce = report?.destinationNonce;
    if (report?.source !== "omni" || report.tx || report.fastTx || nonce === undefined || !w.chain || !payouts.omniPaid) return null;
    if ((await payouts.omniPaid(w.chain, nonce).catch(() => null)) !== true) return null;
    return { status: "arrived", how: "recorded", ...base, tx: null, amount: null, delaySec: null, confirmed: true, destinationNonce: nonce, bridgeReport: report };
  };
  if (w.chain === "zec") return zcashPayout(w, await asking, payouts, base, nowNs);
  const target = payoutTarget(w);
  if ("unsupported" in target) {
    const report = await asking;
    return (await recorded(report)) ?? { status: "unverified", ...base, ...(report ? { bridgeReport: report } : {}), reason: target.unsupported };
  }
  const [read, report] = await Promise.all([payouts.incoming(target).then((page) => ({ page }), (error: unknown) => ({ error })), asking]);
  let page: IncomingPage = "page" in read ? read.page : { items: [], complete: false };
  // The bridge names its payout (a relayer's early payment first, for an Omni Fast Transfer): read that transaction itself
  // when the destination's history did not reach it, until one is found paying the destination.
  for (const named of [report?.fastTx, report?.tx]) {
    if (!named || !payouts.payoutTx) continue;
    if (page.items.some((x) => x.tx.toLowerCase() === named.toLowerCase())) break;
    const found = await payouts.payoutTx(target, named).catch(() => null);
    if (found) {
      page = { ...page, items: [...page.items, found] };
      break;
    }
  }
  if ("error" in read && page.items.length === 0) {
    const e = read.error;
    return (await recorded(report)) ?? { status: "unverified", ...base, ...(report ? { bridgeReport: report } : {}), reason: `could not read ${target.chain}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const matched = matchPayout(target, page, Number(nowNs / 1_000_000_000n), base, report);
  return matched.status === "arrived" || matched.status === "missing" ? matched : ((await recorded(report)) ?? matched);
}

/**
 * The most a Zcash payout falls short of its withdrawal: the connector's bridge fee (`withdraw_bridge_fee.fee_min`,
 * 10,000 zatoshis) plus its gas cap (`max_btc_gas_fee`, 1,000,000 zatoshis), as zcash-connector.bridge.near reports them.
 */
const ZEC_FEES_MAX = 1_010_000n;

/**
 * A Zcash payout, read from the transaction the bridge names (Zcash has no address history reader here). A
 * transparent recipient shows in the outputs (a TEX one at its t1 address, ZIP-320); a shielded one does not, so a payout
 * is taken as made when the named transaction moved this withdrawal, less fees, into a shielded pool. A payout the bridge
 * has not named yet is on its way within the usual time, like any other chain's.
 */
async function zcashPayout(w: OrderReport["withdrawals"][number], report: BridgeReport | null, payouts: PayoutClient, base: { chain: string | null; bridge: OrderReport["withdrawals"][number]["bridge"]; destination: string | null }, nowNs: bigint): Promise<PayoutHop> {
  const b = report ? { ...base, bridgeReport: report } : base;
  const waitedSec = w.timestampNs === null ? null : Number((nowNs - w.timestampNs) / 1_000_000_000n);
  if (report && !report.tx && waitedSec !== null && waitedSec < expectedWithinSec("zec")) return { status: "waiting", ...b, waitedSec };
  if (!report?.tx) return { status: "unverified", ...b, reason: report ? "the bridge does not name a Zcash transaction for it yet" : "payouts on zec are read from the transaction the bridge names, and the bridge does not know this withdrawal" };
  if (!payouts.zcashTx) return { status: "unverified", ...b, reason: "payouts on zec are not searched yet" };
  let z: Awaited<ReturnType<NonNullable<PayoutClient["zcashTx"]>>>;
  try {
    z = await payouts.zcashTx(report.tx);
  } catch (e) {
    return { status: "unverified", ...b, reason: `could not read zec: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!z) return { status: "unverified", ...b, reason: "the Zcash transaction the bridge names is not on the Zcash chain" };
  const burnSec = w.timestampNs === null ? null : Number(w.timestampNs / 1_000_000_000n);
  const delaySec = z.confirmedAtSec !== null && burnSec !== null ? z.confirmedAtSec - burnSec : null;
  const named = (w.destination ?? "").replace(/^zcash:/, "");
  const address = texToTransparent(named) ?? named;
  const paidOpenly = z.outputs.filter((o) => o.address === address).reduce((s, o) => s + o.valueZat, 0n);
  if (paidOpenly > 0n) return { status: "arrived", how: "confirmed", ...b, tx: report.tx, amount: paidOpenly.toString(), delaySec, confirmed: z.confirmedAtSec !== null };
  const shielded = z.shieldedIn.reduce((s, p) => s + p.zat, 0n);
  const withdrawn = BigInt(w.amount);
  if (shielded > 0n && !address.startsWith("t") && shielded <= withdrawn && shielded >= withdrawn - ZEC_FEES_MAX) {
    return { status: "arrived", how: "shielded", ...b, tx: report.tx, amount: shielded.toString(), delaySec, confirmed: z.confirmedAtSec !== null, shieldedPool: z.shieldedIn.map((p) => p.pool).join(" and ") };
  }
  return {
    status: "unverified",
    ...b,
    reason: shielded > 0n ? "the Zcash transaction the bridge names moved a different amount into the shielded pool than this withdrawal (it may pay several transfers)" : "the Zcash transaction the bridge names pays nothing visible to this address",
  };
}

export const FASTNEAR_TX_API = "https://tx.main.fastnear.com";
const MAX_HISTORY_PAGES = 3;

const RATE_LIMIT_WAITS_MS = [1_000, 2_000, 4_000];
/** The longest Retry-After we wait out before giving up. */
const MAX_RETRY_AFTER_MS = 10_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * History from FastNEAR's Transactions API, plus `views` (default: NEAR RPC through core/rpc.ts, see near-views.ts).
 * `wait` is injectable for tests; a 429 is retried after its Retry-After (up to 10 s), else 1, 2 and 4 s, before it is reported.
 */
export function fastnearClient(fetchImpl: typeof fetch = fetch, base = FASTNEAR_TX_API, wait: (ms: number) => Promise<void> = sleep, views: Partial<NearViews> = nearViews(fetchImpl)): NearClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const backoff = RATE_LIMIT_WAITS_MS[attempt];
      if (res.status === 429 && backoff !== undefined) {
        const after = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_AFTER_MS) : backoff);
        continue;
      }
      if (!res.ok) throw new Error(`FastNEAR ${path}: HTTP ${res.status}`);
      return parseFastnearJson<T>(await res.text());
    }
  }
  return {
    ...views,
    async accountTxs(account) {
      const out: AccountTx[] = [];
      let resumeToken: string | undefined;
      let total: number | undefined;
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        // Oldest first, asked for explicitly: the server's default is newest first (`desc.unwrap_or(true)`), though its
        // OpenAPI text says the opposite (docs.near.org data read, 2026-10-14).
        const r = await post<FastnearAccountResponse>("/v0/account", { account_id: account, limit: 200, desc: false, ...(resumeToken ? { resume_token: resumeToken } : {}) });
        for (const t of r.account_txs) out.push({ hash: t.transaction_hash, height: t.tx_block_height, timestampNs: BigInt(String(t.tx_block_timestamp)) });
        total = r.txs_count ?? total;
        resumeToken = r.resume_token;
        if (!resumeToken) return out;
      }
      // One order has a handful of transactions; a history this long (read oldest first) would be traced cut off.
      throw new Error(`${account} has ${total ?? `more than ${out.length}`} transactions: that is a wallet account, not one swap. Paste the swap's NEAR transaction or your deposit transaction instead.`);
    },
    async transactions(hashes) {
      if (hashes.length === 0) return [];
      const r = await post<FastnearTransactionsResponse>("/v0/transactions", { tx_hashes: hashes });
      return r.transactions.filter((t) => t && t.transaction).map(decodeFastnearTx);
    },
    async blockTime(height) {
      const r = await post<{ block?: { block_timestamp?: string | number } | null }>("/v0/block", { block_id: height });
      const ts = r.block?.block_timestamp;
      return ts === undefined ? null : Number(BigInt(String(ts)) / 1_000_000_000n);
    },
    async latestTx(account) {
      const r = await post<FastnearAccountResponse>("/v0/account", { account_id: account, limit: 1, desc: true });
      const t = r.account_txs[0];
      return t ? { height: t.tx_block_height, timeSec: Number(BigInt(String(t.tx_block_timestamp)) / 1_000_000_000n) } : null;
    },
    async recentTxs(account, limit) {
      const r = await post<FastnearAccountResponse>("/v0/account", { account_id: account, desc: true, limit: Math.min(200, limit) });
      return r.account_txs.map((t) => ({ hash: t.transaction_hash, height: t.tx_block_height, timestampNs: BigInt(String(t.tx_block_timestamp)) }));
    },
    async accountTxsBetween(account, fromHeight, toHeight, limit) {
      const out: AccountTx[] = [];
      let resumeToken: string | undefined;
      while (out.length < limit) {
        const r = await post<FastnearAccountResponse>("/v0/account", {
          account_id: account,
          desc: false,
          limit: Math.min(200, limit - out.length),
          from_tx_block_height: fromHeight,
          to_tx_block_height: toHeight,
          ...(resumeToken ? { resume_token: resumeToken } : {}),
        });
        for (const t of r.account_txs) out.push({ hash: t.transaction_hash, height: t.tx_block_height, timestampNs: BigInt(String(t.tx_block_timestamp)) });
        resumeToken = r.resume_token;
        if (!resumeToken || r.account_txs.length === 0) break;
      }
      return out;
    },
    async receiptTx(receiptId) {
      const r = await post<{ transaction?: FastnearTransactionsResponse["transactions"][number] | null }>("/v0/receipt", { receipt_id: receiptId });
      return r.transaction && r.transaction.transaction ? decodeFastnearTx(r.transaction) : null;
    },
  };
}
