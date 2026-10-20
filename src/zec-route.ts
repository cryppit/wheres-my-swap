// The ZEC route page's data: the newest NEAR Intents ZEC withdrawals to Zcash, each checked for its payout the way the
// checker checks one order (searchPayout in check.ts: the Omni indexer, the bridge contract, then the Zcash chain), a
// few at a time so the public sources are not flooded. Read live; nothing is kept.

import type { TxRecord } from "./core/decode.js";
import type { PayoutHop, WithdrawHop } from "./core/trace.js";
import { ZEC_TOKEN, zecRouteSummary, zecWithdrawals, type ZecRouteRow, type ZecRouteSummary } from "./core/zec-route.js";
import type { NearClient } from "./near-client.js";

export interface ZecRouteSource {
  /** The account's newest transaction hashes, newest first. */
  recentTxs(account: string, limit: number): Promise<string[]>;
  /** The decoded transactions for these hashes (at most 20 per call). */
  transactions(hashes: string[]): Promise<TxRecord[]>;
}

export interface ZecRouteOptions {
  /** How many of the ZEC token's newest transactions to read (one FastNEAR page: 200 at most). */
  scan?: number;
  /** How many withdrawals to check, the newest. */
  withdrawals?: number;
  /** How many payout checks run at once. */
  concurrency?: number;
  /** Called with the rows found so far, newest first, and how many will be checked, each time one finishes. */
  onRow?: (rows: readonly ZecRouteRow[], total: number) => void;
}

export interface ZecRouteResult {
  rows: ZecRouteRow[];
  summary: ZecRouteSummary;
  /** How many of the token's transactions were read. */
  scanned: number;
  checkedAtNs: bigint;
}

// Each payout check reads the Zcash transaction from Blockchair's keyless tier (about two calls), which limits calls per
// minute: ten rows, two at a time, stay well inside it.
export const ZEC_ROUTE_DEFAULTS = { scan: 120, withdrawals: 10, concurrency: 2 } as const;

export async function zecRoute(source: ZecRouteSource, payout: (w: WithdrawHop) => Promise<PayoutHop>, nowNs: bigint, o: ZecRouteOptions = {}): Promise<ZecRouteResult> {
  const hashes = await source.recentTxs(ZEC_TOKEN, o.scan ?? ZEC_ROUTE_DEFAULTS.scan);
  const txs: TxRecord[] = [];
  for (let i = 0; i < hashes.length; i += 20) txs.push(...(await source.transactions(hashes.slice(i, i + 20))));
  const found = zecWithdrawals(txs, nowNs).slice(0, o.withdrawals ?? ZEC_ROUTE_DEFAULTS.withdrawals);

  const rows: (ZecRouteRow | undefined)[] = found.map(() => undefined);
  const done = (): ZecRouteRow[] => rows.filter((r): r is ZecRouteRow => r !== undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < found.length; i = next++) {
      const f = found[i];
      if (!f) continue;
      let p: PayoutHop;
      try {
        p = await payout(f.withdrawal);
      } catch (e) {
        const why = e instanceof Error && e.message ? `: ${e.message}` : "";
        p = { chain: f.withdrawal.chain, bridge: f.withdrawal.bridge, destination: f.withdrawal.destination, status: "unverified", reason: `the payout check failed${why}` };
      }
      rows[i] = { ...f, payout: p };
      o.onRow?.(done(), found.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? ZEC_ROUTE_DEFAULTS.concurrency, found.length) }, worker));

  const result = done();
  return { rows: result, summary: zecRouteSummary(result), scanned: hashes.length, checkedAtNs: nowNs };
}

/** The page's source: a NEAR client that can list an account's newest transactions (FastNEAR's). */
export function fastnearZecSource(client: NearClient): ZecRouteSource {
  return {
    async recentTxs(account, limit) {
      if (!client.recentTxs) throw new Error("this NEAR client cannot list an account's newest transactions");
      return (await client.recentTxs(account, limit)).map((t) => t.hash);
    },
    transactions: (hashes) => client.transactions(hashes),
  };
}
