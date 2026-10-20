// Search by the user's own transaction (a TRON, Bitcoin or EVM hash): read it on its chain for its time and the assets it
// moved, then scan the NEAR bridge token that carries those assets for the deposit whose `BRIDGED_FROM` memo names it.
// No index of our own: FastNEAR's per-account history takes a block range, so a scan starts at the transaction's time.
// Sources are keyless and CORS-open: TronGrid, mempool.space, Blockscout (and each EVM chain's public JSON-RPC where
// Blockscout does not answer), the PoA bridge's token list, FastNEAR.
// A Bitcoin deposit through the Omni BTC bridge is found another way: the bridge indexer's record of the deposit address
// it paid names the order (checked against btc-connector.bridge.near; see btc-refund.ts).

import type { NearClient } from "./near-client.js";
import { heightGuess, nearTokensFor, originKind, sameTxHash, type BlockPoint, type BridgeToken } from "./core/origin.js";
import { findOrderAccount, originOf } from "./core/trace.js";
import { btcDepositFacts, publicUtxoRefundClients } from "./btc-refund.js";
import { isCredited, isNearAccountId, receiverOf, UTXO_CHAINS, type UtxoChain } from "./core/btc-refund.js";
import { chainName } from "./core/chains.js";
import { BLOCKSCOUT, EVM_RPC, OMNI_INDEXER, POA_BRIDGE_RPC, TRANSFER_TOPIC } from "./payouts.js";

export interface OriginTx {
  /** The bridge's chain key, e.g. `eth:1`, `tron:mainnet`. */
  chainKey: string;
  /** Short name for messages and links: eth, base, tron, btc, … */
  chain: string;
  timeSec: number;
  /** What it moved: `native` and/or token contracts (EVM as the source gives them: checksummed from Blockscout, lowercase
   * from JSON-RPC, matched case-insensitively; TRON base58). */
  assets: string[];
}

export interface OriginClient {
  lookup(hash: string): Promise<OriginTx | null>;
  /** The PoA bridge's tokens from one chain (`eth:1`, `tron:mainnet`, …), keyed `<chain>:<origin_chain_address>`. */
  bridgeTokens(chainKey: string): Promise<BridgeToken[]>;
  /** A Bitcoin or Zcash deposit through the Omni UTXO bridge: the order its deposit address was made for. Null: not one. */
  omniUtxo?(hash: string): Promise<{ account: string; credited: boolean; chain: UtxoChain } | null>;
  /** The transfer the Omni bridge's indexer records as started by this transaction (Solana, EVM chains). Null: none. */
  omniOrigin?(hash: string): Promise<OmniOrigin | null>;
}

/** An Omni transfer into NEAR as its indexer records it. */
export interface OmniOrigin {
  /** Our short name for the chain it came from (sol, eth, bsc, …). */
  chain: string;
  status: string;
  /** A deposit into NEAR Intents: the intents account it credits (the transfer's message names it). */
  account: string | null;
  /** A transfer to a NEAR account outside NEAR Intents: that account. */
  paidTo: string | null;
  /** The NEAR transaction that finalised it; null until it has. */
  nearTx: string | null;
}

/** The Omni indexer's chain names, as our short names (unlisted ones are lower-cased). */
const OMNI_CHAIN: Record<string, string> = { Eth: "eth", Sol: "sol", Arb: "arb", Base: "base", Bnb: "bsc", Pol: "pol", HyperEvm: "hlevm", Strk: "starknet", Btc: "btc", Zcash: "zec" };

/** `depositTx` is the NEAR deposit that names the transaction (PoA); an Omni BTC deposit is found by its deposit address. */
export type OriginFound = { account: string; depositTx?: string; chain: string; originTx: string; via?: "omni" } | { notFound: string };

/** Ends the not-found message of a Bitcoin or Zcash deposit the Omni bridge never credited, followed by its hash. */
const REFUND_HINT = "check whether it can be refunded with: btc-refund ";

/** The deposit such a message names, so the site and the bot can run its refund check; null for any other message. */
export function refundHintTxid(message: string): string | null {
  const at = message.lastIndexOf(REFUND_HINT);
  const hash = at === -1 ? "" : message.slice(at + REFUND_HINT.length);
  return /^[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null;
}

const CHAIN_ID: Record<string, string> = { eth: "1", base: "8453", arb: "42161", op: "10", gnosis: "100" };
const TRONGRID = "https://api.trongrid.io";
const MEMPOOL = "https://mempool.space/api";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** TRON's hex address (`41…`) in the base58check form the bridge lists. */
export async function tronBase58(hex: string): Promise<string> {
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
  const once = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const twice = new Uint8Array(await crypto.subtle.digest("SHA-256", once));
  const full = new Uint8Array([...bytes, ...twice.slice(0, 4)]);
  let n = full.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let out = "";
  while (n > 0n) {
    out = (B58[Number(n % 58n)] ?? "") + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function publicOriginClient(fetchImpl: typeof fetch = fetch): OriginClient {
  async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
    const res = await fetchImpl(url, init);
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  }
  const post = (url: string, body: unknown) => getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function tron(hash: string): Promise<OriginTx | null> {
    const tx = await post(`${TRONGRID}/wallet/gettransactionbyid`, { value: hash });
    const contract = isObj(tx) && isObj(tx["raw_data"]) ? arr(tx["raw_data"]["contract"])[0] : null;
    if (!isObj(contract)) return null;
    const info = await post(`${TRONGRID}/wallet/gettransactioninfobyid`, { value: hash });
    const ms = isObj(info) && typeof info["blockTimeStamp"] === "number" ? info["blockTimeStamp"] : null;
    if (ms === null) return null; // not in a block yet
    const value = isObj(contract["parameter"]) && isObj(contract["parameter"]["value"]) ? contract["parameter"]["value"] : {};
    const token = contract["type"] === "TriggerSmartContract" ? str(value["contract_address"]) : null;
    return { chainKey: "tron:mainnet", chain: "tron", timeSec: Math.floor(ms / 1000), assets: [token ? await tronBase58(token) : "native"] };
  }

  async function btc(hash: string): Promise<OriginTx | null> {
    const tx = await getJson(`${MEMPOOL}/tx/${hash}`);
    const status = isObj(tx) && isObj(tx["status"]) ? tx["status"] : null;
    const t = status && typeof status["block_time"] === "number" ? status["block_time"] : null;
    return t === null ? null : { chainKey: "btc:mainnet", chain: "btc", timeSec: t, assets: ["native"] };
  }

  async function evmOn(chain: string, hash: string): Promise<OriginTx | null> {
    const root = BLOCKSCOUT[chain];
    const id = CHAIN_ID[chain];
    if (!root || !id) return null;
    const tx = await getJson(`${root}/api/v2/transactions/${hash}`);
    if (!isObj(tx)) return null;
    const ms = Date.parse(str(tx["timestamp"]) ?? "");
    if (!Number.isFinite(ms)) return null;
    const assets: string[] = [];
    for (const t of arr(tx["token_transfers"])) {
      const tok = isObj(t) && isObj(t["token"]) ? (str(t["token"]["address_hash"]) ?? str(t["token"]["address"])) : null;
      if (tok && !assets.includes(tok)) assets.push(tok);
    }
    if (str(tx["value"]) && str(tx["value"]) !== "0") assets.push("native");
    return { chainKey: `eth:${id}`, chain, timeSec: Math.floor(ms / 1000), assets };
  }

  async function evmRpc(chain: string, method: string, params: unknown[]): Promise<unknown> {
    const url = EVM_RPC[chain];
    if (!url) return null;
    const r = await post(url, { jsonrpc: "2.0", id: 1, method, params });
    if (isObj(r) && r["error"] !== undefined) throw new Error(`${new URL(url).host} ${method}: ${JSON.stringify(r["error"]).slice(0, 120)}`);
    return isObj(r) ? r["result"] : null;
  }

  /** The same facts from the chain's public JSON-RPC: the transaction, its receipt's Transfer logs, its block's time. */
  async function evmRpcOn(chain: string, hash: string): Promise<OriginTx | null> {
    const id = CHAIN_ID[chain];
    const tx = id ? await evmRpc(chain, "eth_getTransactionByHash", [hash]) : null;
    if (!id || !isObj(tx)) return null; // not on this chain
    const height = str(tx["blockNumber"]);
    if (!height) return null; // not in a block yet
    const receipt = await evmRpc(chain, "eth_getTransactionReceipt", [hash]);
    const block = await evmRpc(chain, "eth_getBlockByNumber", [height, false]);
    const time = isObj(block) ? str(block["timestamp"]) : null;
    if (!time || !/^0x[0-9a-fA-F]+$/.test(time)) return null;
    const assets: string[] = [];
    for (const log of arr(isObj(receipt) ? receipt["logs"] : null).filter(isObj)) {
      const token = str(log["address"]);
      if (token && arr(log["topics"])[0] === TRANSFER_TOPIC && !assets.includes(token)) assets.push(token);
    }
    const value = str(tx["value"]);
    if (value && /^0x[0-9a-fA-F]+$/.test(value) && BigInt(value) !== 0n) assets.push("native");
    return { chainKey: `eth:${id}`, chain, timeSec: Number(BigInt(time)), assets };
  }

  async function evm(hash: string): Promise<OriginTx | null> {
    // One hash lives on one chain. Blockscout answers in one call; where it does not (base and arbitrum.blockscout.com
    // answer with a bot check, any of them with a rate limit), the chain's public JSON-RPC is asked instead.
    const found = await Promise.all(
      Object.keys(CHAIN_ID).map(async (c) => (await evmOn(c, hash).catch(() => null)) ?? (await evmRpcOn(c, hash).catch(() => null))),
    );
    return found.find((f) => f !== null) ?? null;
  }

  const utxoBridges = publicUtxoRefundClients(fetchImpl);

  async function omniOrigin(hash: string): Promise<OmniOrigin | null> {
    const r = await getJson(`${OMNI_INDEXER}/api/v4/transfers/transfer?transaction_hash=${encodeURIComponent(hash)}`);
    const transfers = arr(isObj(r) ? r["transfers"] : null).filter(isObj);
    const t = transfers.find((x) => x["destination_chain"] === "Near" && x["origin_chain"] !== "Near" && isObj(x["initialised"]) && sameTxHash(str(x["initialised"]["transaction_hash"]) ?? "", hash));
    if (!t) return null;
    const recipient = (str(t["recipient"]) ?? "").replace(/^near:/, "");
    // A deposit into NEAR Intents names the account it credits in its message: plain, or as a receiver_id in JSON.
    let named: unknown = str(t["msg"]);
    if (typeof named === "string" && named.startsWith("{")) {
      try {
        const m: unknown = JSON.parse(named);
        named = isObj(m) ? m["receiver_id"] : null;
      } catch {
        named = null;
      }
    }
    const account = recipient === "intents.near" && typeof named === "string" && isNearAccountId(named.toLowerCase()) ? named.toLowerCase() : null;
    const origin = str(t["origin_chain"]) ?? "?";
    return {
      chain: OMNI_CHAIN[origin] ?? origin.toLowerCase(),
      status: str(t["status"]) ?? "UNKNOWN",
      account,
      paidTo: recipient && recipient !== "intents.near" ? recipient : null,
      nearTx: isObj(t["finalised"]) ? str(t["finalised"]["transaction_hash"]) : null,
    };
  }

  return {
    omniOrigin,
    async omniUtxo(hash) {
      const r = await btcDepositFacts(hash, utxoBridges);
      if ("error" in r || !r.facts.msg) return null;
      return { account: receiverOf(r.facts.msg), credited: isCredited(r.facts), chain: r.facts.chain };
    },
    async lookup(hash) {
      const kind = originKind(hash);
      const h = hash.trim();
      if (kind === "evm") return evm(h);
      if (kind === "hex64") return (await tron(h.toLowerCase()).catch(() => null)) ?? (await btc(h.toLowerCase()).catch(() => null));
      return null;
    },
    async bridgeTokens(chainKey) {
      // The SDK marks `defuse_asset_identifier` "for internal use only": ask for one chain and key each token by its
      // documented `origin_chain_address` ("native" for the chain's coin).
      const r = await post(POA_BRIDGE_RPC, { jsonrpc: "2.0", id: 1, method: "supported_tokens", params: [{ chains: [chainKey] }] });
      const tokens = isObj(r) && isObj(r["result"]) ? arr(r["result"]["tokens"]) : [];
      return tokens.flatMap((t) => {
        const address = isObj(t) ? str(t["origin_chain_address"]) : null;
        const nearToken = isObj(t) ? str(t["near_token_id"]) : null;
        return address && nearToken ? [{ assetId: `${chainKey}:${address}`, nearToken }] : [];
      });
    },
  };
}

/** What an Omni transfer into NEAR says about the order: its account, or why it is none. */
function fromOmni(o: OmniOrigin, hash: string): OriginFound {
  const name = chainName(o.chain);
  if (o.account) return { account: o.account, chain: o.chain, originTx: hash, ...(o.nearTx ? { depositTx: o.nearTx } : {}), via: "omni" };
  if (o.paidTo) return { notFound: `this ${name} transaction is an Omni bridge transfer to the NEAR account ${o.paidTo}, not a deposit into NEAR Intents` };
  if (!o.nearTx) return { notFound: `this ${name} deposit reached the Omni bridge (${o.status}) and is not on NEAR yet: check again in a few minutes` };
  return { notFound: `the Omni bridge finalised this ${name} deposit in NEAR transaction ${o.nearTx}, but its record names no NEAR Intents account: paste that transaction` };
}

/** Deposits usually reach NEAR within minutes; look this long after the transaction. */
const SEARCH_SEC = 2 * 3_600;
const START_EARLY_SEC = 120;
/** At most this many NEAR transactions read per bridge token (20 per request). */
const MAX_READS = 400;

/** The block height at `timeSec`, found from the token's latest transaction by a few straight-line steps. */
async function heightAt(near: Required<Pick<NearClient, "blockTime" | "latestTx">>, account: string, timeSec: number): Promise<number> {
  const latest = await near.latestTx(account);
  if (!latest) throw new Error(`no NEAR history for ${account}`);
  let a: BlockPoint = latest;
  let b: BlockPoint = { height: Math.max(1, Math.round(latest.height - (latest.timeSec - timeSec) * 1.6)), timeSec: 0 };
  for (let i = 0; i < 5; i++) {
    const t = await near.blockTime(b.height);
    if (t === null) break;
    b = { height: b.height, timeSec: t };
    if (Math.abs(t - timeSec) <= 30) break;
    const next = heightGuess(timeSec, a, b);
    a = b;
    b = { height: next, timeSec: 0 };
  }
  return b.height;
}

const SOURCES = "TRON, Bitcoin, Zcash (Omni bridge), Ethereum, Base, Arbitrum, Optimism or Gnosis";

/** The order a user's own origin-chain transaction funded, or why it was not found. */
export async function findOrderByOrigin(raw: string, near: NearClient, origin: OriginClient): Promise<OriginFound> {
  const hash = raw.trim();
  const kind = originKind(hash);
  if (!kind) return { notFound: "not an origin-chain transaction hash" };
  // A deposit through the Omni bridge, from Solana or an EVM chain, is on its indexer under the transaction that started it.
  if ((kind === "solana" || kind === "evm") && origin.omniOrigin) {
    const omni = await origin.omniOrigin(hash).catch(() => null);
    if (omni) return fromOmni(omni, hash);
  }
  if (kind === "solana") return { notFound: "the Omni bridge has no transfer started by this Solana transaction, and Solana deposits through the PoA bridge are not searchable yet: paste the NEAR order account or a NEAR transaction" };
  if (!near.blockTime || !near.latestTx || !near.accountTxsBetween) return { notFound: "this NEAR client cannot search by block range" };
  const nearRange = { blockTime: near.blockTime, latestTx: near.latestTx };

  // Bitcoin and Zcash deposits through the Omni bridge are named by the deposit address they paid.
  if (kind === "hex64" && origin.omniUtxo) {
    const omni = await origin.omniUtxo(hash).catch(() => null);
    if (omni?.credited) return { account: omni.account, chain: omni.chain, originTx: hash };
    if (omni) {
      const { name, unit } = UTXO_CHAINS[omni.chain];
      return { notFound: `this ${name} deposit reached the Omni ${unit} bridge but was never credited on NEAR (order ${omni.account}); ${REFUND_HINT}${hash}` };
    }
  }
  const tx = await origin.lookup(hash);
  if (!tx) return { notFound: `no transaction with this hash on ${SOURCES}` };
  const tokens = nearTokensFor(await origin.bridgeTokens(tx.chainKey), tx.chainKey, tx.assets);
  if (tokens.length === 0) {
    return { notFound: tx.chain === "btc" ? "this Bitcoin deposit did not go through the PoA bridge (Omni BTC deposits are not searchable by transaction yet)" : `the PoA bridge carries none of the assets this ${tx.chain} transaction moved` };
  }

  for (const token of tokens) {
    const from = await heightAt(nearRange, token, tx.timeSec - START_EARLY_SEC);
    const to = from + Math.round(SEARCH_SEC * 1.7);
    const candidates = (await near.accountTxsBetween(token, from, to, MAX_READS)).slice(0, MAX_READS);
    for (let i = 0; i < candidates.length; i += 20) {
      for (const t of await near.transactions(candidates.slice(i, i + 20).map((c) => c.hash))) {
        const o = originOf(t);
        if (o.status !== "proven" || o.kind !== "poa" || !sameTxHash(o.txHash, hash)) continue;
        const account = findOrderAccount(t);
        if (account) return { account, depositTx: t.hash, chain: tx.chain, originTx: hash };
      }
    }
  }
  return { notFound: `no NEAR Intents deposit names this ${tx.chain} transaction in the 2 hours after it (searched ${tokens.join(", ")})` };
}
