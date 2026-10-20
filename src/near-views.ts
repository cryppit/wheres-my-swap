// The NEAR state the checker reads besides FastNEAR's history, through core/rpc.ts (retries, fallback providers):
// whether a payout destination exists, and an order account's balances inside intents.near at one final block. This
// file is on the wall clock; the request bodies and the parsing are pure, in core/views.ts. A view NEAR's RPCs are too
// busy to answer is null, never an error: the report then says it could not check.

import { nearRpc, NEAR_RPC_PROVIDERS, type NearRpcOptions } from "./core/rpc.js";
import { accountExistsFrom, balancesFrom, intentsView, tokenIdsFrom, viewAccount, viewResult } from "./core/views.js";
import type { NearClient } from "./near-client.js";

type Clock = Pick<NearRpcOptions, "now" | "sleep" | "random">;
const WALL_CLOCK: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random };

/** `mt_tokens_for_owner` answers at most this many tokens at once; an order account holds a few. */
const TOKENS_AT_ONCE = 100;

export type NearViews = Required<Pick<NearClient, "accountExists" | "intentsBalances">>;

export function nearViews(fetchImpl: typeof fetch = fetch, providers: readonly string[] = NEAR_RPC_PROVIDERS, clock: Clock = WALL_CLOCK): NearViews {
  const rpc = nearRpc({ providers, fetch: fetchImpl, ...clock });
  return {
    async accountExists(account) {
      try {
        return accountExistsFrom(await rpc(viewAccount(account)));
      } catch {
        return null;
      }
    },
    async intentsBalances(account) {
      try {
        const listed = viewResult(await rpc(intentsView("mt_tokens_for_owner", { account_id: account, limit: TOKENS_AT_ONCE })));
        const ids = listed ? tokenIdsFrom(listed.value) : null;
        // A full page may not be all of them: then the balances cannot be read whole.
        if (!listed || !ids || ids.length >= TOKENS_AT_ONCE) return null;
        const at = { blockHeight: listed.blockHeight, blockHash: listed.blockHash };
        if (ids.length === 0) return { ...at, balances: {} };
        // The amounts at the very block that listed the tokens, so both are one moment.
        const amounts = viewResult(await rpc(intentsView("mt_batch_balance_of", { account_id: account, token_ids: ids }, listed.blockHash)));
        const balances = amounts ? balancesFrom(ids, amounts.value) : null;
        return balances ? { ...at, balances } : null;
      } catch {
        return null;
      }
    },
  };
}
