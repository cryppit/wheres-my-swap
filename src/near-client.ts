// The NEAR data the checker needs, as a port: `fastnearClient` in check.ts is the real one, tests pass fakes.

import type { TxRecord } from "./core/decode.js";
import type { ChainBalances } from "./core/views.js";

export interface AccountTx {
  hash: string;
  height: number;
  timestampNs: bigint;
}

export interface NearClient {
  /** Every transaction that touched the account, any order. */
  accountTxs(account: string): Promise<AccountTx[]>;
  /** The decoded transactions for these hashes (at most 20 per call). */
  transactions(hashes: string[]): Promise<TxRecord[]>;
  /** The transaction a receipt belongs to, for users who paste a receipt id (same format as a tx hash). */
  receiptTx?(receiptId: string): Promise<TxRecord | null>;
  /** A block's time in seconds, null when unknown. For search by origin transaction. */
  blockTime?(height: number): Promise<number | null>;
  /** The account's newest transaction as a known (height, time) point. */
  latestTx?(account: string): Promise<{ height: number; timeSec: number } | null>;
  /** The account's transactions between two heights, oldest first, at most `limit`. */
  accountTxsBetween?(account: string, fromHeight: number, toHeight: number, limit: number): Promise<AccountTx[]>;
  /** The account's newest transactions, newest first, at most `limit` (one page: 200 at most). */
  recentTxs?(account: string, limit: number): Promise<AccountTx[]>;
  /** Whether a NEAR account exists at a final block; null when NEAR's RPCs could not tell. */
  accountExists?(account: string): Promise<boolean | null>;
  /** The account's balances inside intents.near at one final block (NEP-245 views); null when they could not be read. */
  intentsBalances?(account: string): Promise<ChainBalances | null>;
}
