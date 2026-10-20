# Where's My Swap

The free NEAR Intents order checker, by [Cryppit](https://github.com/cryppit) (`cryppit.near`). Live at https://wheres-my-swap.station-wheres-my-swap.workers.dev.
Read-only: it never asks for keys, signs nothing and moves no funds. MIT licensed.

Paste a NEAR Intents order account (the per-order 64-hex account inside `intents.near`) or any NEAR transaction of
the order, and see every hop of the swap from public chain data, each labelled by how it is known:

| Hop | Source | Label |
|---|---|---|
| 1 Origin | `BRIDGED_FROM` memo on the PoA bridge deposit (`*.omft.near`), `FinTransferEvent` nonce logged by the Omni bridge (`omni.bridge.near`) itself, the HOT bridge's signed `mt_deposit_call` (its chain and nonce), or the NEAR transaction itself (`ft_on_transfer` names the sender when a relayer such as `bridge-mng.near` or `sweat-relayer.near` sent it as a meta-transaction). Each is read only from the contract that makes the claim and from a receipt that succeeded | proven |
| 2 Credit | `nep245 mt_mint` into `intents.near` with memo `deposit` (memo `refund` is a failed withdrawal coming back), or a transfer inside NEAR Intents: a `dip4 transfer` (1Click INTENTS deposits, the Confidential Intents treasury unshielding) or a direct NEP-245 `mt_transfer` (the NEAR Mobile app) | proven |
| 3 Swap | `dip4 token_diff` by the order account (plus `transfer`s, usually the integrator fee) | proven |
| 4 Withdrawal | `dip4 ft_withdraw` / `mt_withdraw` / `native_withdraw`, destination from `WITHDRAW_TO:` or the bridge message; the bridge from the receiver (`omni.bridge.near` is Omni, a PoA token burning itself is PoA, `bridge-refuel.hot.tg` is HOT; ZEC, SOL and 15 other former PoA tokens now leave through Omni). A withdrawal to any other NEAR account is a payout on NEAR, whatever the token. HOT receivers are decoded to the chain's own form (EVM `0x…`, TON `UQ…`, Stellar `G…`), as HOT's indexer shows them; Omni to `hlevm` with the message "core" is Hyperliquid core | proven |
| 5 Payout | to a NEAR account: the token's `ft_transfer` inside the withdrawal tx (native NEAR: the `Transfer` receipt from `intents.near`); paid inside NEAR Intents: the transfer of what the swap produced. A token paid to a named account is checked with `view_account`: a token contract credits any valid name (NEP-141 `storage_deposit` cannot check that an account exists, and `intents.near` pays it for the receiver), so a name nobody has created is flagged | proven |
| | to TRON, BTC, Solana, Ethereum, Base, Arbitrum, Optimism, Gnosis: the only transfer into the destination that pays the burned amount less at most the bridge fee, after the burn (`src/core/payout.ts`). PoA pays from a custodial wallet with no on-chain link to the burn, so this is a match, not a proof. Among several fits, the one sent from a [published treasury wallet](https://docs.near-intents.org/security-compliance/treasury-addresses) wins (PoA only); every payout names its sender and whether it is on that list. Omni pays through its bridge (minting or unlocking) and relayers that deliver what NEAR's MPC network signed, never from those wallets, so an Omni payout the bridge's indexer names says its sender's role instead (the relayer that submitted it on Solana, a mint from the zero address, the bridge's own coin on Bitcoin) | matched |
| | PoA withdrawals: the bridge's own `withdrawal_status` names the payout transfer (`transfer_tx_hash`); Omni withdrawals: the Omni bridge indexer (`/api/v4/transfers/transfer?transaction_hash=`) names the destination transaction (`finalised`; for a Fast Transfer, where a relayer pays early from its own funds and the bridge repays it later, the relayer's payment `fast_finalised` first, whichever is on chain into the destination). HOT withdrawals: the HOT bridge's indexer (`/api/v1/withdrawals?near_trx=`) names the destination transaction. That transaction is read on its chain by its id (Solana `getTransaction`, mempool.space, and on EVM chains a keyless JSON-RPC: Blockscout's Base and Arbitrum explorers answer with a Cloudflare challenge) when the destination's history does not reach it, and it pays the destination. BNB Chain, Polygon, Avalanche, Monad, X Layer, Plasma, Scroll, ADI Chain, Robinhood Chain, Berachain and Abstract have no keyless history to search, so only that named transaction is read there, from public RPCs asked in turn (public nodes keep different amounts of history). HOT pays from its bridge contract (MetaWallet `0x233c5370…`, the same address on every EVM chain it serves, source verified on Sourcify): its `withdraw(nonce, contract_id, receiver_id, amount, signature)` sends `amount` and reverts if that fails, and a native payout is an internal transfer that logs nothing, so the call itself is decoded. A HOT token id `<chain id>_<base58>` is the token contract; twenty zero bytes are the chain's coin. The bridge's report checked against the chain, not an on-chain link; a named transfer we cannot see confirms nothing and is shown as a disagreement. When the Omni indexer names no payout yet, the destination's bridge contract is asked whether it marked the transfer's destination nonce as paid (`completedTransfers` on Ethereum, Arbitrum, Base, Polygon, BNB Chain and HyperEVM; `is_transfer_finalised` on Starknet): it sets that mark only in a finalisation that verified the bridge's signature and paid the signed recipient, so the payout reads **recorded**, with no transaction to link (on 2026-10-18 the contracts showed 10 of the 177 transfers the indexer still listed as unpaid as paid) | confirmed, recorded |
| | ZEC to a shielded address (unified `u1…`, Sapling `zs…`): the Zcash transaction the bridge names is on the Zcash chain (Blockchair) and moved the withdrawal, less at most 0.001 ZEC of fees, into a shielded pool (Orchard, Ironwood). The recipient is encrypted, so the destination itself cannot be checked | shielded |
| | ZEC to a TEX address (`tex1…`, ZIP-320): paid at the t1 address of the same key hash, which is where Zcash shows it; a ZEC payout the bridge has not named yet is waiting inside the usual 30 minutes, like any other chain's | confirmed / waiting |
| | two transfers fit / nothing yet inside the usual time (30 min, BTC 60) / nothing after it / a chain or token not searched, or the source failed | ambiguous / waiting / **not found** / unverified (with the reason) |

Flags: **stalled** (credit, or a swap, with nothing after it for over an hour), **locked** (intents.near's operators
locked the account with `force_lock_account` and no unlock followed: it cannot move its own balances, so only they can
move the money; the order is stuck at once, with no stall window), **settled late** (first intent more
than an hour after the credit), **refunded** (the deposited token withdrawn with no swap, back to the chain it came
from; the same token sent on to another chain is a settled cross-chain move), **payout not found** (withdrawn, but no
transfer of about that amount reached the destination), **withdrawal returned** (the transfer out failed and
`intents.near` minted the tokens back), **withdrawal refused** (the token's transfer to the bridge failed and was not
credited back), **payout bounced** (native NEAR withdrawn to a named account nobody created: the Transfer fails, NEAR
refunds `intents.near`, and `intents.near` pays native NEAR without a callback, so the order account is not credited
back and the order is stuck; or `intents.near`'s own unwrapping step failed and sent nothing), **confidential** (a leg through Confidential Intents; a round trip that comes
back and pays out in public is settled), **dust** (what is left is worth under 5 US cents at the 1Click token list's
public prices), **later deposit**, **several orders** (the account received separate deposits, each finished before
the next: the report follows the one with the pasted transaction, else the latest), **own key** (the account signs its
own transactions, so it is not a 1Click order account), **no such account** (a token payout credited to a named account
nobody has created: the token contract holds it under the name and whoever creates the name first controls it; anyone
can create a `.near` name, only the parent account a sub-account), **still executing** (a transaction of the order has receipts
that have not run yet, i.e. an outcome names a spawned receipt the answer lacks: the order is in progress whatever ran
so far, no payout is searched, and the payout waits; receipts still missing 10 minutes after the transaction are a gap
in the data and are flagged as incomplete history instead). Verdicts: settled, refunded, confidential, stuck, in
progress, no order found.
The balance left in the order account is reconstructed from the intent events and the `mt_burn` of each withdrawal
(which includes fees paid in wNEAR, such as the Omni native fee); it reproduces three public incidents. It is then checked against `intents.near`'s own views at one final
block (`mt_tokens_for_owner`, then `mt_batch_balance_of` pinned to that block): the report names the block and its
hash when they agree (anyone can re-run the views there on an archival RPC), flags a **ledger mismatch** with the
chain's numbers when they do not, and says "not checked" when NEAR's RPCs are busy, a transaction is still executing,
or the account held several orders (the chain shows only what they left together).

Data: the keyless, CORS-open [FastNEAR Transactions API](https://tx.main.fastnear.com) (`/v0/account`, then
`/v0/transactions` in batches of 20), read directly by the browser; for payouts (`src/payouts.ts`), TronGrid,
mempool.space, Blockscout, Blockchair (Zcash), the PoA bridge's JSON-RPC (`bridge.chaindefuser.com/rpc`,
`withdrawal_status`; its terms not yet reviewed), the Omni and HOT bridge indexers, public EVM JSON-RPCs and the 1Click
token list (prices, for dust only), NEAR RPC view calls through `src/core/rpc.ts`'s providers (`view_account` on a
named payout destination, `intents.near`'s balances for the order account; a busy RPC only skips those checks), all
keyless and CORS-open. Solana goes through the site's relay, `/api/solana` (`worker/solana.ts`), which passes the
search's two read calls to a full-history Solana RPC set as the `SOLANA_RPC_URL` Worker secret: Solana's own public
RPC refuses any browser origin and anything from Cloudflare's network (the `CF-Worker` header every Worker request
carries), and the keyless RPCs that do answer browsers (PublicNode, Pocket, Solana Tracker) keep only hours of history,
so a day-old payout would wrongly read as missing (all checked 2026-10-17). Without the secret the relay answers 503
and Solana payouts are unverified, with that reason. No key in the page, nothing stored. The one 1Click call is its public token list, for prices that tell dust from stuck money: read at most
every 10 minutes and kept only in memory (1Click's terms allow no API data kept past 24 hours, and we keep none).
1Click's order status is never asked, so the evidence is from NEAR and the bridges alone.

When FastNEAR is unavailable (HTTP 429 after its retries, 401/403, 5xx, or unreachable), the CLI reruns the check on
**NearBlocks API v3** (`src/nearblocks-client.ts`, `src/core/nearblocks.ts`): another team's indexer, keyless, 6 calls a
minute. Its `/v3/accounts/{a}/mt-txns` lists the transactions that moved an order account's NEP-245 tokens (its plain
transaction list is empty for order accounts) and `/v3/txns/{h}/receipts` gives each receipt tree with its logs; on two
recorded orders the trace equals FastNEAR's. It cannot see a deposit that was never credited, so the report says so,
and it cannot search by an origin-chain hash. The report credits it ("Powered by Nearblocks.io APIs"). Its free tier is
for personal use and its terms ask third-party apps for written consent, so the public site does not use it until
NearBlocks agrees or a paid plan ($67.15 a month) is in place. `--no-nearblocks` turns the backup off for runs that
are not personal use. Neardata and Stream NEAR serve FastNEAR's own data, so they are no backup.

Input: the order account, a NEAR transaction or receipt, or **the user's own deposit transaction** on TRON, Bitcoin
(PoA) or an EVM chain (`src/origin.ts`): read it on its chain for its time and assets (on EVM chains from Blockscout, or
from the chain's public JSON-RPC where Blockscout does not answer: its Base and Arbitrum explorers answer with a bot
check; Optimism's and Gnosis's moved to explorer.optimism.io and gnosisscan.io, since the old names redirect without
CORS), map the assets to PoA bridge
tokens with the bridge's `supported_tokens`, then scan that token's NEAR history from the transaction's time (FastNEAR
`/v0/account` takes a block range; `/v0/block` gives block times) for the deposit whose `BRIDGED_FROM` memo names it.
A **Solana** signature or an EVM hash is first looked up in the Omni bridge's indexer
(`/api/v4/transfers/transfer?transaction_hash=`), which records each transfer by the transaction that started it on its
own chain: a deposit into `intents.near` names the account it credits in its message, and the NEAR transaction that
finalised it; a transfer to any other NEAR account is said to be one, not a NEAR Intents deposit.
No index of our own; at most 400 NEAR transactions read per token, 2 hours after the deposit. A Bitcoin or Zcash deposit
through the **Omni bridge** is found by the address it paid instead: the Omni bridge indexer's deposit message for
that address (`/api/v3/utxo/get_deposit_message`, what bridge-cli asks; its terms not yet reviewed) names the order, and
`btc-connector.bridge.near` must derive the same address from it before we use it.

**Stuck Bitcoin and Zcash deposits** (`src/btc-refund.ts`, `src/core/btc-refund.ts`; Zcash read from Blockchair,
whose terms are not yet reviewed, and `zcash-connector.bridge.near`, the same contract): an Omni BTC or ZEC deposit the bridge never
credited can be refunded through the bridge's own flow (`request_refund` → a timelock → `execute_refund` → MPC
signing). The timelock is 2 days when the deposit message named its refund address (`refund_timelock_sec`). When it
named none, `unsafe_refund_timelock_sec` applies, and since 2026-10-16 that is **100 years** (3,153,600,000 s on
`btc-connector.bridge.near` from block 220,227,834, and on `zcash-connector.bridge.near` by 2026-10-17; it was 14
days). The contract reads the lock from its current config when the refund is executed and lets nobody skip the unsafe
one, the DAO included (`resolve_execute_refund_timelock` in Near-One/btc-bridge `contracts/satoshi-bridge/src/refund.rs`),
so requests made before the change are caught too. A lock of 10 years or more (`unreachableLock`) gets no steps: the
check says why and that a request would cost its 2 NEAR for nothing, and the board marks such requests. From the user's Bitcoin hash the check says whether
the bridge credited it (it holds the coin, or spent it itself), refunded it, or still holds a request, and prints the
official `bridge-cli` / `near` commands still to run with the live fees (2 NEAR to request, 1 NEAR to execute, read
from the contract, neither returned; attach exactly that: the contract keeps any extra). Each step says how much NEAR
the signing account needs, deposit plus the gas reserved upfront: a little over 2.3 to request, 1.25 to execute, 0.25
to sign. `request_refund` needs `bridge-cli` (it builds the inclusion proof, and a bad proof still costs the 2 NEAR);
executing a Bitcoin or transparent Zcash refund and the signing step are plain `near` calls, after one
`near account import-account`. A request is only possible while the bridge's light client still holds the deposit's
block: about 366 days for Bitcoin (52,704 blocks) and **90 days for Zcash** (103,680 blocks at 75 seconds), after which
the check says "too old to request". `src/core/refund-calls.ts` gives the exact calls (receiver, method, arguments, 250
Tgas, deposit) that the near commands and a wallet button both use. Anyone may pay for those calls; the contract only
ever pays the refund address. We suggest no address but the deposit's own refund address or, when it has none, its
single sending wallet; we never sign.
The **board** lists every refund request the two connectors hold (`get_refund_requests_paged`), ready ones first. It
cannot list a stuck deposit nobody has asked to refund: nothing on chain ties an uncredited coin to the bridge until then.

**Where the money is** (`src/core/custody.ts`): every report ends with where the money sits now (the order account,
which only 1Click can move; a withdrawal the bridge has yet to pay; arrived or returned; confidential; never reached
NEAR), who can move it, what to do, and for orders that need chasing a facts-only support message.

```bash
npm install
npm run check -- <deposit tx | account | NEAR tx hash> [--json] [--stall-hours N] [--no-nearblocks]
npm run btc-refund -- <Bitcoin or Zcash tx hash> [--vout N] [--json]   # stuck deposit + refund steps
npm run btc-refund -- --board [--json]   # every open refund request on both connectors
npm test                # fixtures recorded from mainnet (src/fixtures)
npm run test:live       # the incidents and five payouts against the real APIs, on demand
npm run build           # the site: dist/ (home, refund, zec and 404 pages)
npm run dev             # the pages with hot reload (no Worker: no Solana relay)
```

Layout: `src/core/` is pure (decode NEAR transactions → `TxRecord`; `traceOrder` → hops, flags, verdict; the FastNEAR
JSON guard, since it writes nanosecond timestamps as bare integers beyond 2^53). `src/check.ts` resolves the input
and talks to FastNEAR through `NearClient` (`checkOrderWithFallback` adds the NearBlocks backup). `src/render-text.ts`
and `src/render-html.ts` are the two reports.
`web/` is the page; `src/cli.ts` the terminal.

Omni BTC and ZEC deposits show their Bitcoin or Zcash transaction as a proven origin (the connector's `utxo_added` event names `txid@vout`).

Payouts on the chains with their own formats are read by the transaction the bridge names (`src/payouts.ts`; every
source checked 2026-10-17 against real payouts for browser CORS, a Worker's requests and history depth):
Litecoin, Dogecoin, Bitcoin Cash and Dash (Blockchair, then BlockCypher or Haskoin: the outputs to the destination),
XRP (xrplcluster.com, then Ripple's Clio servers: `delivered_amount`, and the memo's destination tag when there is one),
Sui (the GraphQL RPC: the destination's SUI balance change), TON (toncenter v3, then tonapi: what the receiving wallet
was credited; a never-deployed wallet shows `aborted` yet is credited), Stellar (SDF Horizon, one year of history:
HOT's Soroban transfers, XLM and USDC), Cardano (the Yoroi backend, then Koios and AdaStat, which answer Workers
only: lovelace to the destination), Aptos (Aptos Labs' archive: fungible-asset deposits resolved to their owner, and
legacy coin deposits), Starknet (PublicNode: STRK `Transfer` events) and HyperEVM (Hyperliquid's RPC: Omni's ONEAR
mint, 10^6 NEAR base units each, which then moves to HyperCore). Several of these keyless sources limit commercial or
production use; they are used while the checker is free and noted where each is defined.

Not yet: Solana deposits through the PoA bridge as input (Omni ones are found, above); an on-chain Omni payout *proof*
for Bitcoin (`btc_pending_id`) and Solana (its used-nonce accounts), whose payouts the indexer names and we check on
the chain (EVM chains and Starknet are asked through the bridge contract, above);
TON jettons (native TON only), Movement, Aleo, Quantus and Fogo payouts (they show what the bridge reports); searching
Base and Arbitrum histories when no bridge names the payout.

**Accuracy** (audit of 2026-10-14, 337 real orders with their RPC balances and destination chains as the truth,
replayed through each version): the right verdict for 239 at e1c0dc7, 311 at fc8b52e and 336 now, with no support
message on an order with nothing wrong (86, then 16 before) and no missed one; every balance equals the RPC balance;
250 payouts verified on their chain and none wrong. The one verdict that differs from the audit's truth is deliberate:
an account that later received a second, stuck deposit now reports that deposit. A bounced NEAR payout was not among
the 337 (it used to read SETTLED, "nobody needs to" act); it is tested on a fixture derived from a real order
(`src/fixtures/derived/`, its `_derived` note says what was changed), not on a recording.

## Hosted extras (not in this repository)

The hosted site also runs a few services that are not part of this repository: **Flight Recorder** (watchlists and
change-only alerts for wallets and apps that route through 1Click, https://wheres-my-swap.station-wheres-my-swap.workers.dev/recorder), the **Telegram bot**, and the
**NEAR Agent Market** agents ([Where's My Swap](https://market.near.ai/a/wheres-my-swap) and
[Address Checker](https://market.near.ai/a/address-checker)). They all build on the checker in this repository.

## ZEC route page (`/zec`)

Are ZEC payouts from NEAR Intents reaching Zcash? The page reads the newest 120 transactions of the ZEC token
(`zec.omft.near`, carried by the Omni Zcash bridge since 2026), takes the newest 10 withdrawals to a `zcash:` recipient
(`src/core/zec-route.ts`, with the checker's own trace), and checks each payout with the checker's own `searchPayout`, two
at a time (`src/zec-route.ts`). It shows one summary sentence (arrived, median and slowest delay, on their way, not found)
and a table with a trace link per withdrawal (`src/render-zec.ts`). Everything runs in the visitor's browser from public
data: FastNEAR, the Omni bridge's indexer and contracts, and Blockchair for Zcash. Nothing is stored, and the 1Click API
is not called. Each payout costs about two calls to Blockchair's keyless tier, which limits calls per minute, so a row
can read "Could not check" when that tier is busy.

## The site (Cloudflare Workers)

`wrangler.jsonc` deploys one Worker, `wheres-my-swap`, at `src/site.ts`'s `SITE`:

- **Pages:** `dist/` as static assets, served before the Worker runs: `/` (the checker), `/refund`, `/zec` and a 404
  page. `web/public/_headers` sets the CSP (scripts, styles and fonts from the site and Google Fonts only; `connect-src`
  any https, since the checks read public APIs from the browser), framing off, and a year's cache for the hashed
  `/assets/` and the fonts.
- **Worker** (`worker/index.ts`, `run_worker_first` for `/api/*`): `/api/solana` (the relay above) and `/api/health`
  (`{"ok":true,"commit":…}`: the deploy script names the commit).
- **Secret**, optional: `SOLANA_RPC_URL` (Solana payouts; any full-history RPC, its URL may hold a key: it never leaves
  the Worker). Copy the value, then `pbpaste | scripts/wrangler.sh secret put SOLANA_RPC_URL`, so it is never typed out.

```bash
scripts/wrangler.sh login                 # once, in the browser
scripts/deploy.sh --dry-run               # build and bundle, nothing uploaded
scripts/deploy.sh                         # build, deploy, then wait for /api/health to name this commit
scripts/wrangler.sh dev --port 8788       # the Worker and the pages locally (Solana's RPC refuses it too)
```

`scripts/wrangler.sh` runs wrangler 4.147.0 exactly, from npx's cache when it is there.

## License

MIT. Independent: not affiliated with NEAR, NEAR Intents, 1Click or any bridge.
