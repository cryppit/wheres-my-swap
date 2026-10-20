// Reads transfers INTO a payout destination from keyless public APIs, for the payout matcher (core/payout.ts). Every
// source here answers browsers (CORS open) and needs no key: TronGrid, mempool.space, Blockscout's EVM explorers,
// Blockchair (Zcash) and the public Solana RPC, which refuses browser origins, so the site passes its own relay as
// `solanaRpc`. Each reads only as far back as the burn, a few pages at most; a payout the bridge names is read by its
// transaction instead (`payoutTx`), however busy the destination is: on EVM chains from a keyless public JSON-RPC,
// since Blockscout's Base and Arbitrum explorers answer every call with a Cloudflare challenge (2026-10).

import { dustThresholds, type TokenPrice } from "./core/dust.js";
import { chainName } from "./core/chains.js";
import { hex64, SEARCH_AFTER_SEC, tonRaw, treasuryOf, type Incoming, type IncomingPage, type PayoutTarget } from "./core/payout.js";
import type { BridgeReport } from "./core/trace.js";

export interface PayoutClient {
  incoming(target: PayoutTarget): Promise<IncomingPage>;
  /** The PoA bridge's own report on a withdrawal (by its NEAR tx hash), null when the bridge does not know it. */
  bridgeWithdrawal?(nearTx: string, token: string): Promise<BridgeReport | null>;
  /** The Omni bridge indexer's record of a withdrawal (by its NEAR tx hash), null when the indexer does not know it. */
  omniTransfer?(nearTx: string, token: string, amount: string): Promise<BridgeReport | null>;
  /**
   * Whether the destination's Omni bridge contract records this destination nonce as paid (it marks one only in a
   * finalisation that verified the bridge's signature and paid the signed recipient); null when it cannot say.
   */
  omniPaid?(chain: string, destinationNonce: number): Promise<boolean | null>;
  /** The HOT bridge indexer's record of a withdrawal (by its NEAR tx hash), null when it does not know it. */
  hotWithdrawal?(nearTx: string): Promise<BridgeReport | null>;
  /** One destination-chain transaction, read by its id: what it paid the target, null if it is not there or pays it nothing. */
  payoutTx?(target: PayoutTarget, tx: string): Promise<Incoming | null>;
  /** A Zcash transaction by its id, null if the chain does not know it. */
  zcashTx?(txid: string): Promise<ZcashTx | null>;
  /** Per token, the raw amount worth less than 5 US cents at 1Click's listed price: a leftover below it is dust. */
  dustBelow?(): Promise<Record<string, string>>;
}

/** A Zcash transaction as public data shows it: shielded outputs hide their recipient, only the pool totals show. */
export interface ZcashTx {
  /** Block time; null while it is unconfirmed. */
  confirmedAtSec: number | null;
  outputs: { address: string | null; valueZat: bigint }[];
  /** Value the transaction moved into each shielded pool (Sapling, Orchard, Ironwood). */
  shieldedIn: { pool: string; zat: bigint }[];
}

export interface PayoutClientOptions {
  /** A Solana JSON-RPC to use instead of the public one (the site's relay). */
  solanaRpc?: string;
}

/**
 * Blockscout's API per chain. Optimism's and Gnosis's moved: optimism.blockscout.com and gnosis.blockscout.com answer
 * with a 301 to these hosts and no CORS header on it, which browsers refuse (2026-10-18). Optimism's internal
 * transactions take 20–30 s to answer there.
 */
export const BLOCKSCOUT: Record<string, string> = {
  eth: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  arb: "https://arbitrum.blockscout.com",
  op: "https://explorer.optimism.io",
  gnosis: "https://gnosisscan.io",
};
/**
 * Keyless public JSON-RPC endpoints that read one transaction by its hash, answering browsers (CORS) and Cloudflare
 * Workers (checked 2026-10-17). The chains' own public endpoints wherever they publish one; Ethereum has none, so MEV
 * Blocker's free public RPC, and Polygon the public endpoint its docs list. No dRPC: its terms (§1.3) require an
 * account for any use.
 */
export const EVM_RPC: Record<string, string> = {
  eth: "https://rpc.mevblocker.io",
  base: "https://mainnet.base.org",
  arb: "https://arb1.arbitrum.io/rpc",
  op: "https://mainnet.optimism.io",
  gnosis: "https://rpc.gnosischain.com",
  bsc: "https://bsc-dataseed.bnbchain.org",
  pol: "https://rpc-mainnet.matic.quiknode.pro",
  avax: "https://api.avax.network/ext/bc/C/rpc",
  monad: "https://rpc.monad.xyz",
  xlayer: "https://rpc.xlayer.tech",
  plasma: "https://rpc.plasma.to",
  scroll: "https://rpc.scroll.io",
  adi: "https://rpc.adifoundation.ai",
  hood: "https://rpc.mainnet.chain.robinhood.com",
  bera: "https://rpc.berachain.com",
  abs: "https://api.mainnet.abs.xyz",
  // HyperEVM, Hyperliquid's own RPC (100 requests a minute per IP; no API terms found). A payout with Omni's "core"
  // message moves on to HyperCore in the same transaction: the mint to the destination is what is read.
  hlevm: "https://rpc.hyperliquid.xyz/evm",
  hypercore: "https://rpc.hyperliquid.xyz/evm",
};
/**
 * More public RPCs, asked in turn when one does not know a transaction (public nodes keep different amounts of history):
 * the chain's other official endpoints, then PublicNode (a free, revocable licence; no account).
 */
export const EVM_RPC_MORE: Record<string, readonly string[]> = {
  eth: ["https://ethereum-rpc.publicnode.com"],
  bsc: ["https://bsc-dataseed1.bnbchain.org", "https://bsc-dataseed2.bnbchain.org"],
  pol: ["https://polygon-bor-rpc.publicnode.com"],
  avax: ["https://avalanche-c-chain-rpc.publicnode.com"],
  monad: ["https://rpc1.monad.xyz"],
  xlayer: ["https://xlayerrpc.okx.com"],
  scroll: ["https://scroll-rpc.publicnode.com"],
  hood: ["https://robinhood-rpc.publicnode.com"],
  bera: ["https://berachain-rpc.publicnode.com"],
  hlevm: ["https://rpc.hypurrscan.io"],
  hypercore: ["https://rpc.hypurrscan.io"],
};
/**
 * HOT's bridge contract on every EVM chain it pays out on (MetaWallet, source verified on Sourcify; the same address on
 * BSC, Polygon, Avalanche, Monad and OP): `withdraw(uint128 nonce, address contract_id, address receiver_id, uint128
 * amount, bytes signature)` sends `amount` of `contract_id` (address(0): the chain's coin) to `receiver_id`, and
 * reverts if that fails. A native payout is an internal transfer that logs nothing, so the call itself is read.
 */
const HOT_BRIDGE = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";

/**
 * Litecoin, Dogecoin, Bitcoin Cash and Dash: the payout the PoA bridge names, from Blockchair's dashboard API (keyless,
 * CORS open; its terms allow keyless use for personal and non-commercial projects only, up to 1440 requests a day: used
 * while Where's My Swap is free, a key before anything is charged), then BlockCypher (3 requests a second, 100 an hour)
 * or, for BCH, Haskoin (no published terms). All checked 2026-10-17 against real payouts back to 2024.
 */
const BLOCKCHAIR = "https://api.blockchair.com/";
const BLOCKCHAIR_CHAIN: Record<string, string> = { ltc: "litecoin", doge: "dogecoin", bch: "bitcoin-cash", dash: "dash" };
const BLOCKCYPHER_CHAIN: Record<string, string> = { ltc: "ltc", doge: "doge", dash: "dash" };
const HASKOIN_BCH = "https://api.haskoin.com/bch";
/**
 * XRP Ledger servers with full history: xrplcluster.com (XRPL Labs; free for non-commercial use, used while the checker
 * is free), then Ripple's Clio servers (not for business use; they answer Workers, not browsers). Every error, a rate
 * limit included, arrives as HTTP 200 with `result.error`.
 */
const XRPL_SERVERS = ["https://xrplcluster.com/", "https://s2.ripple.com:51234/", "https://s1.ripple.com:51234/"];
/** XRP Ledger time counts from 2000-01-01 UTC. */
const RIPPLE_EPOCH = 946_684_800;
const NAMED_TX_ONLY: ReadonlySet<string> = new Set(["ltc", "doge", "bch", "dash", "xrp", "sui", "ton", "stellar", "cardano", "aptos", "starknet"]);
/**
 * The other chains' keyless sources, each checked 2026-10-17 against real payouts (browser CORS, a Worker's requests,
 * history depth). Several limit use: Sui's GraphQL RPC is "for development and testing, not production"; toncenter
 * licenses internal business use (1 request a second), tonapi expects its key (1 per 4 s); SDF's Horizon keeps one year
 * and advises against production use; Koios and Aptos Labs bar unapproved commercial use; Koios and AdaStat answer
 * Workers only (no CORS), the Yoroi backend answers browsers too (undocumented). Used while the checker is free.
 */
const SUI_GRAPHQL = ["https://graphql.mainnet.sui.io/graphql", "https://api.zan.top/public/sui-mainnet/graphql"];
const SUI_QUERY = "query($d:String!){transaction(digest:$d){digest sender{address} effects{status timestamp balanceChanges(first:50){nodes{owner{address} coinType{repr} amount}}}}}";
const SUI_COIN = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const HORIZON = ["https://horizon.stellar.org", "https://horizon.stellar.lobstr.co"];
const APTOS_REST = ["https://archive.mainnet.aptoslabs.com/v1", "https://api.mainnet.aptoslabs.com/v1"];
const APT_FA = hex64("0xa");
const STARKNET_RPC = ["https://starknet-rpc.publicnode.com"];
/**
 * The Omni bridge's contracts by destination chain (Near-One/omni-bridge README; HyperEVM's and Starknet's read from
 * paid transfers' receipts, 2026-10-18), and the views that say whether a destination nonce was paid:
 * `completedTransfers(uint64)` on EVM chains, `is_transfer_finalised(u64)` on Starknet (selectors are keccak hashes).
 */
const OMNI_EVM_BRIDGE: Record<string, string> = {
  eth: "0xe00c629aFaCCb0510995A2B95560E446A24c85B9",
  arb: "0xd025b38762B4A4E36F0Cde483b86CB13ea00D989",
  base: "0xd025b38762B4A4E36F0Cde483b86CB13ea00D989",
  pol: "0xd025b38762B4A4E36F0Cde483b86CB13ea00D989",
  bsc: "0x073C8a225c8Cf9d3f9157F5C1a1DbE02407f5720",
  hlevm: "0xf353b40fc144d1c6c5bcdda712fa6de833016af9",
  hypercore: "0xf353b40fc144d1c6c5bcdda712fa6de833016af9",
};
const OMNI_STARKNET_BRIDGE = "0x5f9a4a841dfb7bb3cde33073b2450fe45dcd407fb6c0985a274b0e943ad8598";
const COMPLETED_TRANSFERS = "0x2f771a2a";
const IS_TRANSFER_FINALISED = "0x11667d5bee6cbca352c523fdb26683a9ddaed2d2e7d5830bd75b44542ace2b5";
const STRK = hex64("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d");
/** keccak of "Transfer" as Starknet writes event selectors. */
const STARKNET_TRANSFER = hex64("0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9");

/** A decimal string with up to `places` decimals ("5.5162390") in base units, or null. */
function decimalUnits(v: string | null, places: number): bigint | null {
  const m = v ? /^(\d+)(?:\.(\d+))?$/.exec(v) : null;
  if (!m || (m[2] ?? "").length > places) return null;
  return BigInt(m[1] ?? "0") * 10n ** BigInt(places) + BigInt((m[2] ?? "").padEnd(places, "0") || "0");
}

/** One source's answer for a transaction: not known there (ask the next), or what it paid the target. */
type Lookup = { found: false } | { found: true; paid: Incoming | null };

/** UTXO addresses as the explorers print them: bech32 and CashAddr lower case, CashAddr without its prefix. */
const utxoAddress = (a: string | null): string => (a ?? "").replace(/^bitcoincash:/i, "").replace(/^(ltc1|[qp][02-9ac-hj-np-z]{41}$)/i, (m) => m.toLowerCase());
const sameUtxo = (a: string | null, b: string): boolean => {
  const x = utxoAddress(a);
  const y = utxoAddress(b);
  return /^(ltc1|[qp])/i.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const HOT_WITHDRAW = "0xd9e7c316";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** keccak256("Transfer(address,address,uint256)"), the ERC-20 Transfer event's first topic. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRONGRID = "https://api.trongrid.io";
const MEMPOOL = "https://mempool.space/api";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const BLOCKCHAIR_ZEC = "https://api.blockchair.com/zcash/";
/** The PoA bridge's public JSON-RPC (the one its deposit and withdrawal flows use); keyless, CORS open. */
export const POA_BRIDGE_RPC = "https://bridge.chaindefuser.com/rpc";
/** The Omni bridge's indexer (Near-One, public OpenAPI spec); keyless, CORS open. */
export const OMNI_INDEXER = "https://mainnet.api.bridge.nearone.org";
/** The bridge indexer that records HOT withdrawals (`/api/v1/withdrawals?near_trx=`); keyless, CORS open. */
export const HOT_INDEXER = "https://bridge-indexer.chaindefuser.com";
/** 1Click's public token list (decimals and USD prices); keyless, CORS open. */
export const ONE_CLICK_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
/** How long one read of the token list's prices is used. */
const PRICES_FOR_MS = 10 * 60_000;

const MAX_PAGES = 3;
const SOL_SIGNATURES = 50;
const SOL_MAX_TX_READS = 8;
const SKEW_SEC = 60;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isoSec = (v: unknown): number | null => {
  const s = str(v);
  const ms = s ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const sameAddress = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** HOT's withdraw call, decoded from a transaction to its bridge contract: the token, the receiver and the amount. */
function hotWithdrawCall(sent: Record<string, unknown>): { token: string; receiver: string; amount: bigint } | null {
  const input = str(sent["input"]);
  if (!sameAddress(sent["to"], HOT_BRIDGE) || !input || !input.startsWith(HOT_WITHDRAW) || !/^0x[0-9a-fA-F]+$/.test(input) || input.length < 10 + 64 * 4) return null;
  const word = (k: number): string => input.slice(10 + 64 * k, 10 + 64 * (k + 1));
  return { token: `0x${word(1).slice(-40)}`.toLowerCase(), receiver: `0x${word(2).slice(-40)}`.toLowerCase(), amount: BigInt(`0x${word(3)}`) };
}

export type PublicPayoutClient = PayoutClient & Required<Pick<PayoutClient, "bridgeWithdrawal" | "omniTransfer" | "omniPaid" | "hotWithdrawal" | "payoutTx" | "zcashTx" | "dustBelow">>;

export function publicPayoutClient(fetchImpl: typeof fetch = fetch, opts: PayoutClientOptions = {}): PublicPayoutClient {
  const solanaRpc = opts.solanaRpc ?? SOLANA_RPC;
  /** `notFound: "null"` answers a 404 with null instead of throwing. */
  async function getJson(url: string, init?: RequestInit, notFound?: "null"): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, init);
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
        continue;
      }
      if (res.status === 404 && notFound === "null") return null;
      if (!res.ok) throw new Error(`${new URL(url).host} ${new URL(url).pathname}: HTTP ${res.status}`);
      return res.json() as Promise<unknown>;
    }
  }
  const unsearched = (t: PayoutTarget): IncomingPage => ({ items: [], complete: false, unsearched: `${chainName(t.chain)}'s history is not searched here: only the payout transaction the bridge names is read` });
  const from = (t: PayoutTarget) => t.burnSec - SKEW_SEC;
  const to = (t: PayoutTarget) => t.burnSec + SEARCH_AFTER_SEC;

  async function tron(t: PayoutTarget): Promise<IncomingPage> {
    const native = t.asset.kind === "native";
    const q = `only_to=true&limit=50&min_timestamp=${from(t) * 1000}&max_timestamp=${to(t) * 1000}`;
    const r = await getJson(`${TRONGRID}/v1/accounts/${t.address}/transactions${native ? "" : "/trc20"}?${q}`);
    const data = arr(isObj(r) ? r["data"] : null).filter(isObj);
    const items: Incoming[] = [];
    for (const x of data) {
      if (native) {
        const c = arr(isObj(x["raw_data"]) ? x["raw_data"]["contract"] : null)[0];
        const ok = str(isObj(arr(x["ret"])[0]) ? (arr(x["ret"])[0] as Record<string, unknown>)["contractRet"] : null) === "SUCCESS";
        if (!isObj(c) || c["type"] !== "TransferContract" || !ok) continue;
        const v = isObj(c["parameter"]) && isObj(c["parameter"]["value"]) ? c["parameter"]["value"] : {};
        const amount = str(v["amount"]);
        const ts = num(x["block_timestamp"]);
        if (amount && ts !== null && str(x["txID"])) items.push({ tx: str(x["txID"]) as string, amount, timestampSec: Math.floor(ts / 1000), from: str(v["owner_address"]) });
      } else {
        const amount = str(x["value"]);
        const ts = num(x["block_timestamp"]);
        const tx = str(x["transaction_id"]);
        if (amount && ts !== null && tx && x["to"] === t.address) items.push({ tx, amount, timestampSec: Math.floor(ts / 1000), from: str(x["from"]) });
      }
    }
    return { items, complete: data.length < 50 };
  }

  /** What one Bitcoin transaction (mempool.space shape) paid the target; a transaction the target funds is its own spend. */
  function btcIncoming(x: Record<string, unknown>, t: PayoutTarget): Incoming | null {
    const txid = str(x["txid"]);
    if (!txid) return null;
    if (arr(x["vin"]).some((v) => isObj(v) && isObj(v["prevout"]) && v["prevout"]["scriptpubkey_address"] === t.address)) return null;
    const paid = arr(x["vout"]).reduce<bigint>((s, v) => (isObj(v) && v["scriptpubkey_address"] === t.address && typeof v["value"] === "number" ? s + BigInt(v["value"]) : s), 0n);
    const status = isObj(x["status"]) ? x["status"] : {};
    const inputs = arr(x["vin"]).map((v) => (isObj(v) && isObj(v["prevout"]) ? str(v["prevout"]["scriptpubkey_address"]) : null)).filter((a): a is string => a !== null);
    const sender = inputs.find((a) => treasuryOf("btc", a) !== null) ?? inputs[0] ?? null;
    return paid > 0n ? { tx: txid, amount: paid.toString(), timestampSec: status["confirmed"] === true ? num(status["block_time"]) : null, from: sender } : null;
  }

  async function btc(t: PayoutTarget): Promise<IncomingPage> {
    const items: Incoming[] = [];
    let url = `${MEMPOOL}/address/${t.address}/txs`;
    for (let page = 0; page < MAX_PAGES; page++) {
      const txs = arr(await getJson(url)).filter(isObj);
      let confirmed = 0;
      let reachedBurn = false;
      let lastConfirmed: string | null = null;
      for (const x of txs) {
        const status = isObj(x["status"]) ? x["status"] : {};
        const isConfirmed = status["confirmed"] === true;
        const blockTime = num(status["block_time"]);
        const txid = str(x["txid"]);
        if (!txid) continue;
        if (isConfirmed) {
          confirmed++;
          lastConfirmed = txid;
          if (blockTime !== null && blockTime < from(t)) reachedBurn = true;
        }
        const paid = btcIncoming(x, t);
        if (paid) items.push(paid);
      }
      if (reachedBurn || confirmed < 25 || !lastConfirmed) return { items, complete: true };
      url = `${MEMPOOL}/address/${t.address}/txs/chain/${lastConfirmed}`;
    }
    return { items, complete: false };
  }

  async function solRpc(method: string, params: unknown[]): Promise<unknown> {
    const r = await getJson(solanaRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (isObj(r) && r["error"]) throw new Error(`${method}: ${JSON.stringify(r["error"]).slice(0, 120)}`);
    return isObj(r) ? r["result"] : null;
  }

  /** What one Solana transaction (`getTransaction`, jsonParsed) paid the target, from the balances it changed. */
  function solIncoming(tx: unknown, signature: string, blockTime: number | null, t: PayoutTarget): Incoming | null {
    if (!isObj(tx) || !isObj(tx["meta"]) || !isObj(tx["transaction"])) return null;
    if (tx["meta"]["err"]) return null;
    const meta = tx["meta"];
    const message = isObj(tx["transaction"]["message"]) ? tx["transaction"]["message"] : {};
    const keys = arr(message["accountKeys"]).map((k) => (isObj(k) ? str(k["pubkey"]) : str(k)));
    const signers = arr(message["accountKeys"]).flatMap((k) => (isObj(k) && k["signer"] === true && typeof k["pubkey"] === "string" ? [k["pubkey"]] : []));
    const sender = signers.find((a) => treasuryOf("sol", a) !== null) ?? keys[0] ?? null;
    const i = keys.indexOf(t.address);
    let amount = 0n;
    if (i >= 0) {
      const pre = num(arr(meta["preBalances"])[i]);
      const post = num(arr(meta["postBalances"])[i]);
      if (pre !== null && post !== null) amount = BigInt(post) - BigInt(pre);
    }
    if (t.asset.kind !== "native") {
      for (const tb of arr(meta["postTokenBalances"]).filter(isObj)) {
        if (tb["owner"] !== t.address) continue;
        const pre = arr(meta["preTokenBalances"]).filter(isObj).find((p) => p["accountIndex"] === tb["accountIndex"]);
        const amt = (b: unknown) => BigInt(str(isObj(b) && isObj(b["uiTokenAmount"]) ? b["uiTokenAmount"]["amount"] : null) ?? "0");
        const d = amt(tb) - amt(pre);
        if (d > 0n) amount = d;
      }
    }
    return amount > 0n ? { tx: signature, amount: amount.toString(), timestampSec: blockTime ?? num(tx["blockTime"]), from: sender } : null;
  }

  async function sol(t: PayoutTarget): Promise<IncomingPage> {
    const rpc = solRpc;
    const sigs = arr(await rpc("getSignaturesForAddress", [t.address, { limit: SOL_SIGNATURES }])).filter(isObj);
    const oldest = sigs.length ? num(sigs[sigs.length - 1]?.["blockTime"]) : null;
    let complete = sigs.length < SOL_SIGNATURES || (oldest !== null && oldest < from(t));
    const inWindow = sigs
      .filter((s) => !s["err"] && typeof s["signature"] === "string" && (num(s["blockTime"]) ?? 0) >= from(t) && (num(s["blockTime"]) ?? 0) <= to(t))
      .reverse(); // oldest first: payouts come minutes after the burn
    if (inWindow.length > SOL_MAX_TX_READS) complete = false;
    const items: Incoming[] = [];
    for (const s of inWindow.slice(0, SOL_MAX_TX_READS)) {
      const tx = await rpc("getTransaction", [s["signature"], { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
      const paid = solIncoming(tx, s["signature"] as string, num(s["blockTime"]), t);
      if (paid) items.push(paid);
    }
    return { items, complete };
  }

  async function blockscoutList(t: PayoutTarget, path: string, read: (x: Record<string, unknown>) => Incoming | null): Promise<IncomingPage> {
    const root = BLOCKSCOUT[t.chain];
    if (!root) throw new Error(`no Blockscout explorer for ${t.chain}`);
    const items: Incoming[] = [];
    let next: Record<string, unknown> | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const extra = next ? "&" + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString() : "";
      const r = await getJson(`${root}/api/v2/addresses/${t.address}/${path}${extra}`);
      const rows = arr(isObj(r) ? r["items"] : null).filter(isObj);
      let reachedBurn = false;
      for (const x of rows) {
        const ts = isoSec(x["timestamp"]);
        if (ts !== null && ts < from(t)) reachedBurn = true;
        const inc = read(x);
        if (inc) items.push(inc);
      }
      next = isObj(r) && isObj(r["next_page_params"]) ? r["next_page_params"] : null;
      if (!next || reachedBurn) return { items, complete: true };
    }
    return { items, complete: false };
  }

  async function evm(t: PayoutTarget): Promise<IncomingPage> {
    if (!BLOCKSCOUT[t.chain]) return unsearched(t);
    if (t.asset.kind === "token") {
      return blockscoutList(t, `token-transfers?type=ERC-20&filter=to&token=${t.asset.contract}`, (x) => {
        const total = isObj(x["total"]) ? x["total"] : {};
        const tx = str(x["transaction_hash"]);
        const amount = str(total["value"]);
        const toHash = isObj(x["to"]) ? x["to"]["hash"] : null;
        if (!tx || !amount || !sameAddress(toHash, t.address)) return null;
        const decimals = Number(str(total["decimals"]) ?? NaN);
        const sender = isObj(x["from"]) ? str(x["from"]["hash"]) : null;
        return { tx, amount, timestampSec: isoSec(x["timestamp"]), decimals: Number.isFinite(decimals) ? decimals : null, from: sender };
      });
    }
    const read = (hashKey: string, ok: (x: Record<string, unknown>) => boolean) => (x: Record<string, unknown>) => {
      const tx = str(x[hashKey]);
      const amount = str(x["value"]);
      const toHash = isObj(x["to"]) ? x["to"]["hash"] : null;
      const sender = isObj(x["from"]) ? str(x["from"]["hash"]) : null;
      return tx && amount && ok(x) && sameAddress(toHash, t.address) ? { tx, amount, timestampSec: isoSec(x["timestamp"]), from: sender } : null;
    };
    const plain = await blockscoutList(t, "transactions?filter=to", read("hash", (x) => x["result"] === "success"));
    const internal = await blockscoutList(t, "internal-transactions?filter=to", read("transaction_hash", (x) => x["success"] === true));
    return { items: [...plain.items, ...internal.items], complete: plain.complete && internal.complete };
  }

  async function bridgeWithdrawal(nearTx: string, token: string): Promise<BridgeReport | null> {
    const r = await getJson(POA_BRIDGE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "withdrawal_status", params: [{ withdrawal_hash: nearTx }] }),
    });
    if (!isObj(r)) return null;
    if (r["error"]) {
      if (/not found/i.test(String(r["error"]))) return null;
      throw new Error(`withdrawal_status: ${String(r["error"]).slice(0, 120)}`);
    }
    const result = isObj(r["result"]) ? r["result"] : {};
    const contract = token.replace(/^nep141:/, "");
    const entries = arr(result["withdrawals"]).filter(isObj);
    const mine = entries.find((w) => isObj(w["data"]) && w["data"]["near_token_id"] === contract) ?? (entries.length === 1 ? entries[0] : undefined);
    if (!mine) return null;
    const data = isObj(mine["data"]) ? mine["data"] : {};
    return { status: str(mine["status"]) ?? "UNKNOWN", tx: str(data["transfer_tx_hash"]) };
  }

  /**
   * The Omni transfer this NEAR transaction started, for this token (and amount, when one transaction starts several):
   * its status, and the destination-chain transaction the indexer says finalised it.
   */
  async function omniTransfer(nearTx: string, token: string, amount: string): Promise<BridgeReport | null> {
    const r = await getJson(`${OMNI_INDEXER}/api/v4/transfers/transfer?transaction_hash=${encodeURIComponent(nearTx)}`, undefined, "null");
    const transfers = arr(isObj(r) ? r["transfers"] : null).filter(isObj);
    const id = `near:${token.replace(/^nep141:/, "")}`;
    const forToken = transfers.filter((t) => t["origin_chain"] === "Near" && t["token_id"] === id);
    const mine = forToken.find((t) => str(t["amount"]) === amount) ?? forToken[0];
    if (!mine) return null;
    const finalised = isObj(mine["finalised"]) ? mine["finalised"] : {};
    // A Fast Transfer: a relayer paid the user early on the destination chain (a fast finalisation on NEAR is a transfer
    // into NEAR, not a payout), and the bridge's finalisation repays it later.
    const fast = isObj(mine["fast_finalised"]) && mine["fast_finalised"]["chain"] !== "Near" ? str(mine["fast_finalised"]["transaction_hash"]) : null;
    // A Bitcoin or Zcash payout can be replaced by fee: the confirmed one is utxo_winning_tx_hash (the indexer's spec).
    const destinationNonce = num(mine["destination_nonce"]);
    return {
      source: "omni",
      status: str(mine["status"]) ?? "UNKNOWN",
      tx: str(mine["utxo_winning_tx_hash"]) ?? str(finalised["transaction_hash"]),
      ...(fast ? { fastTx: fast } : {}),
      ...(destinationNonce !== null ? { destinationNonce } : {}),
    };
  }

  async function hotWithdrawal(nearTx: string): Promise<BridgeReport | null> {
    const r = await getJson(`${HOT_INDEXER}/api/v1/withdrawals?near_trx=${encodeURIComponent(nearTx)}`, undefined, "null");
    const w = arr(isObj(r) ? r["withdrawals"] : null)
      .filter(isObj)
      .find((x) => x["bridge"] === "HOT");
    if (!w) return null;
    return { source: "hot", status: str(w["destination_chain_time"]) ? "COMPLETED" : "PENDING", tx: str(w["hash"]) };
  }

  async function rpcAt(url: string, method: string, params: unknown[]): Promise<unknown> {
    const r = await getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (isObj(r) && r["error"] !== undefined) throw new Error(`${new URL(url).host} ${method}: ${JSON.stringify(r["error"]).slice(0, 120)}`);
    return isObj(r) ? r["result"] : null;
  }

  /** The destination's Omni bridge contract's own record of a destination nonce, from the first public RPC that answers. */
  async function omniPaid(chain: string, destinationNonce: number): Promise<boolean | null> {
    const nonce = BigInt(destinationNonce);
    if (chain === "starknet") {
      for (const url of STARKNET_RPC) {
        const r = await rpcAt(url, "starknet_call", [{ contract_address: OMNI_STARKNET_BRIDGE, entry_point_selector: IS_TRANSFER_FINALISED, calldata: [`0x${nonce.toString(16)}`] }, "latest"]).catch(() => undefined);
        const v = arr(r)[0];
        if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v)) return BigInt(v) !== 0n;
      }
      return null;
    }
    const contract = OMNI_EVM_BRIDGE[chain];
    if (!contract) return null;
    for (const url of [EVM_RPC[chain], ...(EVM_RPC_MORE[chain] ?? [])]) {
      if (!url) continue;
      const r = await rpcAt(url, "eth_call", [{ to: contract, data: `${COMPLETED_TRANSFERS}${nonce.toString(16).padStart(64, "0")}` }, "latest"]).catch(() => undefined);
      if (typeof r === "string" && /^0x[0-9a-f]+$/i.test(r)) return BigInt(r) !== 0n;
    }
    return null;
  }

  /**
   * What one EVM transaction paid the target, from the first public RPC that knows it: the token's Transfer logs into
   * it, the native value sent to it, or what HOT's withdraw call sent it.
   */
  async function evmPayoutTx(t: PayoutTarget, tx: string): Promise<Incoming | null> {
    for (const url of [EVM_RPC[t.chain], ...(EVM_RPC_MORE[t.chain] ?? [])]) {
      if (!url) continue;
      const receipt = await rpcAt(url, "eth_getTransactionReceipt", [tx]).catch(() => null);
      if (isObj(receipt)) return evmPaid(url, t, tx, receipt);
    }
    return null;
  }

  async function evmPaid(url: string, t: PayoutTarget, tx: string, receipt: Record<string, unknown>): Promise<Incoming | null> {
    if (receipt["status"] !== "0x1") return null;
    let amount = 0n;
    let from: string | null = null;
    if (t.asset.kind === "token") {
      const contract = t.asset.contract;
      for (const log of arr(receipt["logs"]).filter(isObj)) {
        const topics = arr(log["topics"]).map((x) => str(x) ?? "");
        const data = str(log["data"]);
        if (!sameAddress(log["address"], contract) || topics[0] !== TRANSFER_TOPIC || !topics[2] || !data || !/^0x[0-9a-fA-F]+$/.test(data)) continue;
        if (!sameAddress(`0x${topics[2].slice(-40)}`, t.address)) continue;
        amount += BigInt(data);
        from ??= topics[1] ? `0x${topics[1].slice(-40)}` : null;
      }
    }
    if (t.asset.kind === "native") {
      // A token payout always logs its Transfer; a native one is the transaction's own value, or HOT's withdraw call.
      const sent = await rpcAt(url, "eth_getTransactionByHash", [tx]);
      if (!isObj(sent)) return null;
      const hot = hotWithdrawCall(sent);
      const value = str(sent["value"]);
      if (hot) {
        if (hot.receiver !== t.address.toLowerCase() || hot.token !== ZERO_ADDRESS) return null;
        amount = hot.amount;
        from = HOT_BRIDGE;
      } else if (sameAddress(sent["to"], t.address) && value && /^0x[0-9a-fA-F]+$/.test(value)) {
        amount = BigInt(value);
        from = str(sent["from"]);
      }
    }
    if (amount === 0n) return null;
    if (t.scale) amount *= t.scale;
    const block = await rpcAt(url, "eth_getBlockByNumber", [receipt["blockNumber"], false]);
    const time = isObj(block) ? str(block["timestamp"]) : null;
    return { tx, amount: amount.toString(), timestampSec: time && /^0x[0-9a-fA-F]+$/.test(time) ? Number(BigInt(time)) : null, from };
  }

  /** Asks each source in turn until one knows the transaction; a source that fails or does not know it is skipped. */
  async function firstKnown(sources: (() => Promise<Lookup>)[]): Promise<Incoming | null> {
    for (const ask of sources) {
      const r = await ask().catch((): Lookup => ({ found: false }));
      if (r.found) return r.paid;
    }
    return null;
  }

  const paidUtxo = (t: PayoutTarget, tx: string, outputs: { to: string | null; value: unknown }[], mined: boolean, timeSec: number | null, from: string | null): Lookup => {
    let amount = 0n;
    for (const o of outputs) if (sameUtxo(o.to, t.address) && /^\d+$/.test(str(o.value) ?? "")) amount += BigInt(str(o.value) ?? "0");
    return { found: true, paid: amount > 0n ? { tx, amount: amount.toString(), timestampSec: mined ? timeSec : null, from: from ? utxoAddress(from) : null } : null };
  };

  async function blockchairUtxo(t: PayoutTarget, tx: string): Promise<Lookup> {
    const body = await getJson(`${BLOCKCHAIR}${BLOCKCHAIR_CHAIN[t.chain] ?? t.chain}/dashboards/transaction/${tx}`);
    const data = isObj(body) ? body["data"] : null;
    const d = isObj(data) ? (data[tx] ?? data[tx.toLowerCase()]) : null;
    if (!isObj(d) || !isObj(d["transaction"])) return { found: false };
    const time = str(d["transaction"]["time"]);
    const outputs = arr(d["outputs"]).filter(isObj).map((o) => ({ to: str(o["recipient"]), value: o["value"] }));
    const first = arr(d["inputs"]).filter(isObj)[0];
    return paidUtxo(t, tx, outputs, (num(d["transaction"]["block_id"]) ?? -1) > 0, time ? Date.parse(`${time.replace(" ", "T")}Z`) / 1000 : null, first ? str(first["recipient"]) : null);
  }

  async function blockcypherUtxo(t: PayoutTarget, tx: string): Promise<Lookup> {
    const chain = BLOCKCYPHER_CHAIN[t.chain];
    if (!chain) return { found: false };
    const d = await getJson(`https://api.blockcypher.com/v1/${chain}/main/txs/${tx}`, undefined, "null");
    if (!isObj(d) || !Array.isArray(d["outputs"])) return { found: false };
    const outputs = arr(d["outputs"]).filter(isObj).map((o) => ({ to: str(arr(o["addresses"])[0]), value: o["value"] }));
    const first = arr(d["inputs"]).filter(isObj)[0];
    return paidUtxo(t, tx, outputs, (num(d["block_height"]) ?? -1) > 0, isoSec(d["confirmed"]), first ? str(arr(first["addresses"])[0]) : null);
  }

  async function haskoinBch(t: PayoutTarget, tx: string): Promise<Lookup> {
    if (t.chain !== "bch") return { found: false };
    const d = await getJson(`${HASKOIN_BCH}/transaction/${tx}`, undefined, "null");
    if (!isObj(d) || !Array.isArray(d["outputs"])) return { found: false };
    const outputs = arr(d["outputs"]).filter(isObj).map((o) => ({ to: str(o["address"]), value: o["value"] }));
    const first = arr(d["inputs"]).filter(isObj)[0];
    // Haskoin's `time` is when it first saw the transaction; close enough to say when the payout was sent.
    return paidUtxo(t, tx, outputs, isObj(d["block"]) && num(d["block"]["height"]) !== null, num(d["time"]), first ? str(first["address"]) : null);
  }

  async function xrpLookup(url: string, t: PayoutTarget, tx: string): Promise<Lookup> {
    const r = await getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "tx", params: [{ transaction: tx, binary: false }] }) });
    const res = isObj(r) && isObj(r["result"]) ? r["result"] : null;
    if (!res || res["error"] !== undefined) return { found: false }; // txnNotFound, tooBusy: ask the next server
    const meta = isObj(res["meta"]) ? res["meta"] : {};
    // delivered_amount is what arrived (a partial payment delivers less than Amount); a string is XRP in drops.
    const delivered = meta["delivered_amount"];
    const tagOk = t.tag === undefined || String(res["DestinationTag"] ?? "") === t.tag;
    const pays = res["TransactionType"] === "Payment" && meta["TransactionResult"] === "tesSUCCESS" && res["Destination"] === t.address && tagOk && t.asset.kind === "native" && typeof delivered === "string" && /^\d+$/.test(delivered);
    const date = num(res["date"]);
    return { found: true, paid: pays ? { tx, amount: String(delivered), timestampSec: res["validated"] === true && date !== null ? date + RIPPLE_EPOCH : null, from: str(res["Account"]) } : null };
  }

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => getJson(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const paid = (tx: string, amount: bigint, timestampSec: number | null, from: string | null): Lookup => ({ found: true, paid: amount > 0n ? { tx, amount: amount.toString(), timestampSec, from } : null });

  async function suiLookup(url: string, t: PayoutTarget, tx: string): Promise<Lookup> {
    const r = await post(url, { query: SUI_QUERY, variables: { d: tx } });
    const data = isObj(r) && isObj(r["data"]) ? r["data"] : null;
    const txn = data && isObj(data["transaction"]) ? data["transaction"] : null;
    if (!txn) return { found: false };
    const eff = isObj(txn["effects"]) ? txn["effects"] : {};
    if (eff["status"] !== "SUCCESS" || t.asset.kind !== "native") return { found: true, paid: null };
    let amount = 0n;
    for (const n of arr(isObj(eff["balanceChanges"]) ? eff["balanceChanges"]["nodes"] : null).filter(isObj)) {
      const owner = isObj(n["owner"]) ? str(n["owner"]["address"]) : null;
      const coin = isObj(n["coinType"]) ? str(n["coinType"]["repr"]) : null;
      const amt = str(n["amount"]);
      if (owner && hex64(owner) === t.address && coin === SUI_COIN && amt && /^-?\d+$/.test(amt)) amount += BigInt(amt);
    }
    return paid(tx, amount, isoSec(eff["timestamp"]), isObj(txn["sender"]) ? str(txn["sender"]["address"]) : null);
  }

  /** TON: HOT names the transaction on the receiving wallet; what it was credited is the payout (`aborted` is not a failure). */
  async function tonLookup(source: "toncenter" | "tonapi", t: PayoutTarget, tx: string): Promise<Lookup> {
    const dest = tonRaw(t.address);
    if (!dest || t.asset.kind !== "native") return { found: false };
    if (source === "toncenter") {
      const r = await getJson(`https://toncenter.com/api/v3/transactions?hash=${encodeURIComponent(tx)}`, undefined, "null");
      const x = isObj(r) ? arr(r["transactions"]).filter(isObj)[0] : undefined;
      if (!x) return { found: false };
      const m = isObj(x["in_msg"]) ? x["in_msg"] : {};
      const credit = isObj(x["description"]) && isObj(x["description"]["credit_ph"]) ? str(x["description"]["credit_ph"]["credit"]) : null;
      const ok = tonRaw(str(x["account"]) ?? "") === dest && m["bounce"] === false && m["opcode"] === null && credit !== null && x["emulated"] !== true;
      const value = str(m["value"]);
      return paid(tx, ok && value && /^\d+$/.test(value) ? BigInt(value) : 0n, x["finality"] === "finalized" ? num(x["now"]) : null, tonRaw(str(m["source"]) ?? ""));
    }
    const x = await getJson(`https://tonapi.io/v2/blockchain/transactions/${encodeURIComponent(tx)}`, undefined, "null");
    if (!isObj(x) || !isObj(x["in_msg"])) return { found: false };
    const m = x["in_msg"];
    const account = isObj(x["account"]) ? str(x["account"]["address"]) : null;
    const credit = isObj(x["credit_phase"]) ? str(x["credit_phase"]["credit"]) : null;
    const ok = tonRaw(account ?? "") === dest && m["bounce"] === false && m["op_code"] == null && credit !== null;
    const value = str(m["value"]);
    return paid(tx, ok && value && /^\d+$/.test(value) ? BigInt(value) : 0n, num(x["utime"]), isObj(m["source"]) ? tonRaw(str(m["source"]["address"]) ?? "") : null);
  }

  /** Stellar: HOT pays with Soroban, so a transfer shows in asset_balance_changes; classic payments and create_account too. */
  async function stellarLookup(root: string, t: PayoutTarget, tx: string): Promise<Lookup> {
    const r = await getJson(`${root}/transactions/${encodeURIComponent(tx)}/operations?limit=200&join=transactions`, { headers: { "user-agent": "WheresMySwap/1" } }, "null");
    const records = isObj(r) && isObj(r["_embedded"]) ? arr(r["_embedded"]["records"]).filter(isObj) : [];
    if (records.length === 0) return { found: false };
    const first = records[0] ?? {};
    const txn = isObj(first["transaction"]) ? first["transaction"] : {};
    if (first["transaction_successful"] !== true) return { found: true, paid: null };
    const assetOk = (type: unknown, code: unknown, issuer: unknown): boolean =>
      t.asset.kind === "native" ? type === "native" : t.asset.kind === "token" && `${String(code)}:${String(issuer)}` === t.asset.contract;
    let amount = 0n;
    let from: string | null = null;
    for (const op of records) {
      for (const c of arr(op["asset_balance_changes"]).filter(isObj)) {
        if (c["type"] !== "transfer" || c["to"] !== t.address || !assetOk(c["asset_type"], c["asset_code"], c["asset_issuer"])) continue;
        amount += decimalUnits(str(c["amount"]), 7) ?? 0n;
        from ??= str(c["from"]);
      }
      if ((op["type"] === "payment" || op["type"] === "path_payment_strict_send" || op["type"] === "path_payment_strict_receive") && op["to"] === t.address && assetOk(op["asset_type"], op["asset_code"], op["asset_issuer"])) {
        amount += decimalUnits(str(op["amount"]), 7) ?? 0n;
        from ??= str(op["from"]);
      }
      if (op["type"] === "create_account" && op["account"] === t.address && t.asset.kind === "native") {
        amount += decimalUnits(str(op["starting_balance"]), 7) ?? 0n;
        from ??= str(op["funder"]);
      }
    }
    return paid(tx, amount, isoSec(txn["created_at"]), from);
  }

  /** Cardano: the lovelace in the outputs to the destination (ADA only; a token output's lovelace is not a payout). */
  async function cardanoLookup(source: "yoroi" | "koios" | "adastat", t: PayoutTarget, tx: string): Promise<Lookup> {
    if (t.asset.kind !== "native") return { found: false };
    type Out = { address: string | null; value: string | null; tokens: number };
    let outs: Out[];
    let time: number | null;
    let from: string | null;
    if (source === "yoroi") {
      const r = await post("https://api.yoroiwallet.com/api/v2/txs/get", { txHashes: [tx] });
      const d = isObj(r) && isObj(r[tx]) ? r[tx] : null;
      if (!d) return { found: false };
      if (d["tx_state"] !== "Successful") return { found: true, paid: null };
      outs = arr(d["outputs"]).filter(isObj).map((o) => ({ address: str(o["address"]), value: str(o["amount"]), tokens: arr(o["assets"]).length }));
      time = isoSec(d["time"]);
      from = str(arr(d["inputs"]).filter(isObj)[0]?.["address"]);
    } else if (source === "koios") {
      const r = await post("https://api.koios.rest/api/v1/tx_info", { _tx_hashes: [tx], _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
      const d = arr(r).filter(isObj).find((x) => x["tx_hash"] === tx);
      if (!d) return { found: false };
      const addr = (o: Record<string, unknown>): string | null => (isObj(o["payment_addr"]) ? str(o["payment_addr"]["bech32"]) : null);
      outs = arr(d["outputs"]).filter(isObj).map((o) => ({ address: addr(o), value: str(o["value"]), tokens: arr(o["asset_list"]).length }));
      time = num(d["tx_timestamp"]);
      const input = arr(d["inputs"]).filter(isObj)[0];
      from = input ? addr(input) : null;
    } else {
      const r = await getJson(`https://api.adastat.net/rest/v1/transactions/${encodeURIComponent(tx)}.json`, undefined, "null");
      const d = isObj(r) && isObj(r["data"]) ? r["data"] : null;
      if (!d) return { found: false };
      const rows = (k: string): Record<string, unknown>[] => (isObj(d[k]) ? arr(d[k]["rows"]).filter(isObj) : []);
      outs = rows("outputs").map((o) => ({ address: str(o["address"]), value: str(o["amount"]), tokens: arr(o["tokens"]).length }));
      time = num(d["time"]);
      from = str(rows("inputs")[0]?.["address"]);
    }
    let amount = 0n;
    for (const o of outs) if (o.address === t.address && o.tokens === 0 && o.value && /^\d+$/.test(o.value)) amount += BigInt(o.value);
    return paid(tx, amount, time, from);
  }

  /** Aptos: APT the destination received, as a fungible-asset Deposit (resolved to its owner) or a legacy coin deposit. */
  async function aptosLookup(root: string, t: PayoutTarget, tx: string): Promise<Lookup> {
    const r = await getJson(`${root}/transactions/by_hash/${encodeURIComponent(tx)}`, undefined, "null");
    if (!isObj(r) || r["type"] !== "user_transaction") return { found: false };
    if (r["success"] !== true || t.asset.kind !== "native") return { found: true, paid: null };
    const changes = arr(r["changes"]).filter(isObj).filter((c) => c["type"] === "write_resource" && isObj(c["data"]));
    const resource = (address: string, type: string): Record<string, unknown> | null => {
      const c = changes.find((x) => hex64(str(x["address"]) ?? "") === address && isObj(x["data"]) && x["data"]["type"] === type);
      return c && isObj(c["data"]) && isObj(c["data"]["data"]) ? c["data"]["data"] : null;
    };
    let amount = 0n;
    for (const e of arr(r["events"]).filter(isObj)) {
      const data = isObj(e["data"]) ? e["data"] : {};
      const value = str(data["amount"]);
      if (!value || !/^\d+$/.test(value)) continue;
      if (e["type"] === "0x1::fungible_asset::Deposit") {
        const store = hex64(str(data["store"]) ?? "");
        const owner = str(resource(store, "0x1::object::ObjectCore")?.["owner"]);
        const meta = resource(store, "0x1::fungible_asset::FungibleStore")?.["metadata"];
        if (owner && hex64(owner) === t.address && isObj(meta) && hex64(str(meta["inner"]) ?? "") === APT_FA) amount += BigInt(value);
      } else if (e["type"] === "0x1::coin::DepositEvent") {
        const account = isObj(e["guid"]) ? hex64(str(e["guid"]["account_address"]) ?? "") : "";
        if (account === t.address && resource(account, "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>")) amount += BigInt(value);
      }
    }
    const micros = str(r["timestamp"]);
    return paid(tx, amount, micros && /^\d+$/.test(micros) ? Number(BigInt(micros) / 1_000_000n) : null, str(r["sender"]) ? hex64(str(r["sender"]) ?? "") : null);
  }

  /** Starknet: STRK Transfer events to the destination (old layout: data [from, to, low, high]; new: keys [sel, from, to]). */
  async function starknetLookup(url: string, t: PayoutTarget, tx: string): Promise<Lookup> {
    const r = await post(url, { jsonrpc: "2.0", id: 1, method: "starknet_getTransactionReceipt", params: [tx] });
    const res = isObj(r) && isObj(r["result"]) ? r["result"] : null;
    if (!res) return { found: false };
    if (res["execution_status"] !== "SUCCEEDED" || t.asset.kind !== "native") return { found: true, paid: null };
    let amount = 0n;
    let from: string | null = null;
    for (const e of arr(res["events"]).filter(isObj)) {
      const keys = arr(e["keys"]).map((k) => hex64(str(k) ?? "0"));
      const data = arr(e["data"]).map((k) => str(k) ?? "0x0");
      if (hex64(str(e["from_address"]) ?? "") !== STRK || keys[0] !== STARKNET_TRANSFER) continue;
      const [sender, to, low, high] = keys.length >= 3 ? [keys[1], keys[2], data[0], data[1]] : [hex64(data[0] ?? "0"), hex64(data[1] ?? "0"), data[2], data[3]];
      if (to !== t.address) continue;
      amount += BigInt(low ?? "0x0") + (BigInt(high ?? "0x0") << 128n);
      from ??= sender ?? null;
    }
    let time: number | null = null;
    if (amount > 0n && num(res["block_number"]) !== null) {
      const b = await post(url, { jsonrpc: "2.0", id: 1, method: "starknet_getBlockWithTxHashes", params: [{ block_number: num(res["block_number"]) }] }).catch(() => null);
      time = isObj(b) && isObj(b["result"]) ? num(b["result"]["timestamp"]) : null;
    }
    return paid(tx, amount, time, from);
  }

  async function payoutTx(t: PayoutTarget, tx: string): Promise<Incoming | null> {
    if (t.chain === "sui") return firstKnown(SUI_GRAPHQL.map((url) => () => suiLookup(url, t, tx)));
    if (t.chain === "ton") return firstKnown([() => tonLookup("toncenter", t, tx), () => tonLookup("tonapi", t, tx)]);
    if (t.chain === "stellar") return firstKnown(HORIZON.map((root) => () => stellarLookup(root, t, tx)));
    if (t.chain === "cardano") return firstKnown([() => cardanoLookup("yoroi", t, tx), () => cardanoLookup("koios", t, tx), () => cardanoLookup("adastat", t, tx)]);
    if (t.chain === "aptos") return firstKnown(APTOS_REST.map((root) => () => aptosLookup(root, t, tx)));
    if (t.chain === "starknet") return firstKnown(STARKNET_RPC.map((url) => () => starknetLookup(url, t, tx)));
    if (BLOCKCHAIR_CHAIN[t.chain]) return firstKnown([() => blockchairUtxo(t, tx), () => blockcypherUtxo(t, tx), () => haskoinBch(t, tx)]);
    if (t.chain === "xrp") return firstKnown(XRPL_SERVERS.map((url) => () => xrpLookup(url, t, tx)));
    if (t.chain === "sol") return solIncoming(await solRpc("getTransaction", [tx, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]), tx, null, t);
    if (t.chain === "btc") {
      const x = await getJson(`${MEMPOOL}/tx/${tx}`, undefined, "null");
      return isObj(x) ? btcIncoming(x, t) : null;
    }
    if (EVM_RPC[t.chain]) return evmPayoutTx(t, tx);
    return null; // TRON: the destination's history is searched instead
  }

  async function zcashTx(txid: string): Promise<ZcashTx | null> {
    const body = await getJson(`${BLOCKCHAIR_ZEC}dashboards/transaction/${txid}`, undefined, "null");
    const data = isObj(body) ? body["data"] : null;
    const d = isObj(data) ? data[txid] : null;
    if (!isObj(d) || !isObj(d["transaction"])) return null;
    const t = d["transaction"];
    const time = str(t["time"]);
    const outputs = arr(d["outputs"])
      .filter(isObj)
      .sort((a, b) => (num(a["index"]) ?? 0) - (num(b["index"]) ?? 0))
      .map((o) => ({ address: str(o["recipient"]), valueZat: BigInt(str(o["value"]) ?? "0") }));
    // The node's decoded transaction has each pool's value balance; negative means value went into that pool.
    const raw = await getJson(`${BLOCKCHAIR_ZEC}raw/transaction/${txid}`, undefined, "null").catch(() => null);
    const rawData = isObj(raw) && isObj(raw["data"]) ? raw["data"][txid] : null;
    const decoded = isObj(rawData) && isObj(rawData["decoded_raw_transaction"]) ? rawData["decoded_raw_transaction"] : {};
    const shieldedIn: ZcashTx["shieldedIn"] = [];
    const into = (pool: string, balance: unknown) => {
      const v = num(balance);
      if (v !== null && v < 0) shieldedIn.push({ pool, zat: BigInt(-v) });
    };
    into("Sapling", decoded["valueBalanceZat"]);
    for (const [key, pool] of [["orchard", "Orchard"], ["ironwood", "Ironwood"]] as const) {
      const b = decoded[key];
      if (isObj(b)) into(pool, b["valueBalanceZat"]);
    }
    return { confirmedAtSec: (num(t["block_id"]) ?? -1) > 0 && time ? Date.parse(`${time.replace(" ", "T")}Z`) / 1000 : null, outputs, shieldedIn };
  }

  let prices: { at: number; thresholds: Promise<Record<string, string>> } | null = null;
  function dustBelow(): Promise<Record<string, string>> {
    if (prices && Date.now() - prices.at < PRICES_FOR_MS) return prices.thresholds;
    const thresholds = getJson(ONE_CLICK_TOKENS).then((r) =>
      dustThresholds(
        arr(r)
          .filter(isObj)
          .flatMap((t): TokenPrice[] => {
            const assetId = str(t["assetId"]);
            const decimals = num(t["decimals"]);
            const price = num(t["price"]);
            return assetId && decimals !== null && price !== null ? [{ assetId, decimals, price }] : [];
          }),
      ),
    );
    prices = { at: Date.now(), thresholds };
    thresholds.catch(() => {
      prices = null;
    });
    return thresholds;
  }

  return {
    bridgeWithdrawal,
    omniTransfer,
    omniPaid,
    hotWithdrawal,
    payoutTx,
    zcashTx,
    dustBelow,
    incoming(t) {
      if (NAMED_TX_ONLY.has(t.chain)) return Promise.resolve(unsearched(t));
      if (t.chain === "tron") return tron(t);
      if (t.chain === "btc") return btc(t);
      if (t.chain === "sol") return sol(t);
      return evm(t);
    },
  };
}
