// Search by the user's own transaction: reading it on its chain (recorded TronGrid / Blockscout payloads) and finding
// the PoA deposit on NEAR that names it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AccountTx, NearClient } from "./check.js";
import type { TxRecord } from "./core/decode.js";
import { findOrderByOrigin, publicOriginClient, refundHintTxid, type OriginClient } from "./origin.js";
import { EVM_RPC } from "./payouts.js";

const fx = (name: string): string => readFileSync(new URL(`./fixtures/origin/${name}`, import.meta.url), "utf8");
const json = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "application/json" } });

// A Base USDC deposit sent through an ERC-4337 smart account (NEAR deposit JCJPh8Dg…, block 220,187,710, names it in its
// BRIDGED_FROM memo). Its transaction,
// receipt and block were recorded from mainnet.base.org on 2026-10-16, when base.blockscout.com and
// arbitrum.blockscout.com answered every lookup with a bot check (403).
const BASE_TX = "0x2e71cfe71704305636c1279f4f0e31fc449b0bd8aeee698a03f6214c72f16608";

/** The chains' public JSON-RPC: mainnet.base.org has the Base deposit; every other answer is "no such transaction". */
function rpcAnswer(url: string, body: { method?: string; params?: unknown[] }): Response | null {
  if (!Object.values(EVM_RPC).includes(url)) return null;
  const onBase = url === EVM_RPC["base"];
  if (onBase && body.method === "eth_getTransactionByHash" && body.params?.[0] === BASE_TX) return json(fx("base-usdc-4337-tx.json"));
  if (onBase && body.method === "eth_getTransactionReceipt" && body.params?.[0] === BASE_TX) return json(fx("base-usdc-4337-receipt.json"));
  if (onBase && body.method === "eth_getBlockByNumber" && body.params?.[0] === "0x323b499") return json(fx("base-usdc-4337-block.json"));
  return json('{"jsonrpc":"2.0","id":1,"result":null}');
}

function recordedFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { value?: string; method?: string; params?: unknown[] }) : {};
    if (url === "https://api.trongrid.io/wallet/gettransactionbyid") {
      if (body.value === "d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67") return json(fx("tron-trx-tx.json"));
      if (body.value === "d98b7b8a3c9a153c91a4f324d3c3d37206f1ecfff016bd691311876bfdc3e57d") return json(fx("tron-usdt-tx.json"));
      return json("{}");
    }
    if (url === "https://api.trongrid.io/wallet/gettransactioninfobyid") {
      if (body.value === "d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67") return json(fx("tron-trx-info.json"));
      if (body.value === "d98b7b8a3c9a153c91a4f324d3c3d37206f1ecfff016bd691311876bfdc3e57d") return json(fx("tron-usdt-info.json"));
      return json("{}");
    }
    if (url === "https://eth.blockscout.com/api/v2/transactions/0x5b523e971f8a79ce81330f46755b050df31156b11cc37afd6bc02719f73066b1") return json(fx("eth-usdc-tx.json"));
    if (url.startsWith("https://base.blockscout.com/") || url.startsWith("https://arbitrum.blockscout.com/")) return new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403 });
    if (url.includes(".blockscout.com/api/v2/transactions/")) return json('{"message":"Not found"}', 404);
    const rpc = rpcAnswer(url, body);
    if (rpc) return rpc;
    if (url.startsWith("https://mempool.space/api/tx/")) return new Response("Transaction not found", { status: 404 });
    if (url === "https://bridge.chaindefuser.com/rpc") {
      // supported_tokens filtered by chain (recorded 2026-10-14); the full list is the older recording.
      const chains = (body as { params?: { chains?: string[] }[] }).params?.[0]?.chains;
      return json(fx(chains?.[0] === "tron:mainnet" ? "supported-tokens-tron.json" : "supported-tokens.json"));
    }
    return new Response("not recorded", { status: 500 });
  }) as typeof fetch;
}

describe("publicOriginClient reads the user's transaction on its chain", () => {
  const client = publicOriginClient(recordedFetch());

  it("TRON TRX (#358's deposit): native, with its block time", async () => {
    expect(await client.lookup("d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67")).toEqual({ chainKey: "tron:mainnet", chain: "tron", timeSec: 1_789_143_957, assets: ["native"] });
  });

  it("TRON USDT: the TRC-20 contract in base58, as the bridge lists it", async () => {
    expect(await client.lookup("d98b7b8a3c9a153c91a4f324d3c3d37206f1ecfff016bd691311876bfdc3e57d")).toMatchObject({ chainKey: "tron:mainnet", assets: ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"] });
  });

  it("Ethereum USDC: found on whichever EVM explorer knows the hash", async () => {
    expect(await client.lookup("0x5b523e971f8a79ce81330f46755b050df31156b11cc37afd6bc02719f73066b1")).toEqual({
      chainKey: "eth:1",
      chain: "eth",
      timeSec: 1_791_009_875,
      assets: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    });
  });

  it("Base USDC through a smart account: base.blockscout.com refuses, so the transaction is read from mainnet.base.org", async () => {
    expect(await client.lookup(BASE_TX)).toEqual({ chainKey: "eth:8453", chain: "base", timeSec: 1_792_132_629, assets: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"] });
  });

  it("a hash no chain knows is null", async () => {
    expect(await client.lookup("1111111111111111111111111111111111111111111111111111111111111111")).toBeNull();
  });

  it("reads the bridge's tokens for one chain, keyed by their documented origin_chain_address", async () => {
    const tokens = await client.bridgeTokens("tron:mainnet");
    expect(tokens).toContainEqual({ assetId: "tron:mainnet:native", nearToken: "tron.omft.near" });
    expect(tokens).toContainEqual({ assetId: "tron:mainnet:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", nearToken: "tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near" });
    expect(tokens.every((t) => t.assetId.startsWith("tron:mainnet:"))).toBe(true);
  });
});

// A tiny NEAR: blocks one second apart from height 1000 (time 1_789_000_000), and the deposits we put in it.
const T0 = 1_789_000_000;
const NS = 1_000_000_000n;
function deposit(hash: string, height: number, originTx: string, owner: string): TxRecord {
  const ev = (executor: string, standard: string, event: string, data: Record<string, unknown>[]) => ({ standard, version: "1.0.0", event, data, executor, failed: false });
  return {
    hash,
    signer: "poa-relayer.near",
    receiver: "tron.omft.near",
    height,
    timestampNs: BigInt(T0 + height - 1000) * NS,
    actions: [],
    receiptActions: [],
    plainLogs: [],
    events: [
      ev("tron.omft.near", "nep141", "ft_transfer", [{ old_owner_id: "tron.omft.near", new_owner_id: "intents.near", amount: "1", memo: `BRIDGED_FROM:{"networkType":"tron","chainId":"mainnet","txHash":"${originTx}"}` }]),
      ev("intents.near", "nep245", "mt_mint", [{ owner_id: owner, token_ids: ["nep141:tron.omft.near"], amounts: ["1"], memo: "deposit" }]),
    ],
  };
}

function tinyNear(txs: TxRecord[], reads: string[] = []): NearClient {
  const byHash = new Map(txs.map((t) => [t.hash, t]));
  return {
    accountTxs: async () => [],
    transactions: async (hashes) => {
      reads.push(...hashes);
      return hashes.flatMap((h) => (byHash.has(h) ? [byHash.get(h) as TxRecord] : []));
    },
    blockTime: async (height) => T0 + height - 1000,
    latestTx: async () => ({ height: 100_000, timeSec: T0 + 99_000 }),
    accountTxsBetween: async (_account, from, to) =>
      txs.filter((t) => (t.height ?? 0) >= from && (t.height ?? 0) <= to).map((t): AccountTx => ({ hash: t.hash, height: t.height ?? 0, timestampNs: t.timestampNs ?? 0n })),
  };
}

const ORIGIN = "d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67";
const fakeOrigin = (timeSec: number | null = T0 + 500): OriginClient => ({
  lookup: async () => (timeSec === null ? null : { chainKey: "tron:mainnet", chain: "tron", timeSec, assets: ["native"] }),
  bridgeTokens: async () => [{ assetId: "tron:mainnet:native", nearToken: "tron.omft.near" }],
});

describe("findOrderByOrigin", () => {
  it("finds the deposit whose bridge memo names the user's transaction, and its order account", async () => {
    const near = tinyNear([deposit("other", 1_550, "ffff", "b".repeat(64)), deposit("mine", 1_567, ORIGIN, "a".repeat(64))]);
    expect(await findOrderByOrigin(ORIGIN, near, fakeOrigin())).toEqual({ account: "a".repeat(64), depositTx: "mine", chain: "tron", originTx: ORIGIN });
  });

  it("says what it searched when no deposit names the transaction", async () => {
    const r = await findOrderByOrigin(ORIGIN, tinyNear([deposit("other", 1_550, "ffff", "b".repeat(64))]), fakeOrigin());
    expect(r).toEqual({ notFound: "no NEAR Intents deposit names this tron transaction in the 2 hours after it (searched tron.omft.near)" });
  });

  it("a transaction no supported chain knows", async () => {
    expect(await findOrderByOrigin(ORIGIN, tinyNear([]), fakeOrigin(null))).toEqual({ notFound: "no transaction with this hash on TRON, Bitcoin, Zcash (Omni bridge), Ethereum, Base, Arbitrum, Optimism or Gnosis" });
  });

  const BTC = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
  const btcOrigin = (omni: { account: string; credited: boolean; chain: "btc" | "zcash" } | null, onChain = true): OriginClient => ({
    lookup: async () => (onChain ? { chainKey: "btc:mainnet", chain: "btc", timeSec: T0 + 500, assets: ["native"] } : null),
    bridgeTokens: async () => [{ assetId: "btc:mainnet:native", nearToken: "btc.omft.near" }],
    omniUtxo: async () => omni,
  });

  it("a Bitcoin deposit through the Omni bridge: the bridge's record of the address it paid names the order", async () => {
    expect(await findOrderByOrigin(BTC, tinyNear([]), btcOrigin({ account: "c".repeat(64), credited: true, chain: "btc" }))).toEqual({ account: "c".repeat(64), chain: "btc", originTx: BTC });
  });

  it("an Omni BTC deposit never credited on NEAR points to its refund check", async () => {
    expect(await findOrderByOrigin(BTC, tinyNear([]), btcOrigin({ account: "c".repeat(64), credited: false, chain: "btc" }))).toEqual({
      notFound: `this Bitcoin deposit reached the Omni BTC bridge but was never credited on NEAR (order ${"c".repeat(64)}); check whether it can be refunded with: btc-refund ${BTC}`,
    });
  });

  it("names the deposit whose refund check to run, so the bot and the site can run it", async () => {
    const r = await findOrderByOrigin(BTC, tinyNear([]), btcOrigin({ account: "c".repeat(64), credited: false, chain: "btc" }));
    expect("notFound" in r ? refundHintTxid(r.notFound) : null).toBe(BTC);
    expect(refundHintTxid(`… check whether it can be refunded with: btc-refund ${BTC.toUpperCase()}`)).toBe(BTC);
    expect(refundHintTxid("no transaction with this hash on TronGrid")).toBeNull();
  });

  it("a Zcash deposit, which no other chain knows, is found the same way", async () => {
    expect(await findOrderByOrigin(BTC, tinyNear([]), btcOrigin({ account: "d".repeat(64), credited: true, chain: "zcash" }, false))).toEqual({ account: "d".repeat(64), chain: "zcash", originTx: BTC });
    expect(await findOrderByOrigin(BTC, tinyNear([]), btcOrigin({ account: "d".repeat(64), credited: false, chain: "zcash" }, false))).toEqual({
      notFound: `this Zcash deposit reached the Omni ZEC bridge but was never credited on NEAR (order ${"d".repeat(64)}); check whether it can be refunded with: btc-refund ${BTC}`,
    });
  });

  it("a Bitcoin transaction the Omni bridge does not know falls back to the PoA search", async () => {
    expect(await findOrderByOrigin(BTC, tinyNear([]), btcOrigin(null))).toEqual({ notFound: "no NEAR Intents deposit names this btc transaction in the 2 hours after it (searched btc.omft.near)" });
  });

});

describe("findOrderByOrigin through the Omni bridge's indexer (a transfer recorded by the transaction that started it)", () => {
  // Recorded 2026-10-17 from mainnet.api.bridge.nearone.org/api/v4/transfers/transfer?transaction_hash=…: a Solana
  // deposit of 0.09836 SOL into intents.near (its message is the order account), a BNB Chain deposit into intents.near
  // crediting a solver, and an Ethereum transfer to a plain NEAR account.
  const SOL_SIG = "4UXuDeh2WEPNMZ3wF1Gr2qFiNLF5YY228p55nTPnQMNFDYDXUxB9wv9yaC2CsjY3F8HkDa18Du7cYCRsaB9xxUAb";
  const BNB_TX = "0xb4932914eabef6119f8d97c31972b7c5899fb27f51a03d0dc1f8859a5bb421fa";
  const ETH_TX = "0x6fc9c9e35562f609686bb44ecc1c0da067c35925f2c6e2374a2ef87ee4efdce8";
  const ORDER = "5b3ceeb65eb966459ffec6c7e5bd84fb404e99db7021bd4659d6ec1821ae1159";
  const INDEXED: Record<string, string> = { [SOL_SIG]: "omni-origin-sol.json", [BNB_TX]: "omni-origin-bnb.json", [ETH_TX]: "omni-origin-eth-account.json" };
  const omniFetch = (edit: (body: string) => string = (b) => b): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.host === "mainnet.api.bridge.nearone.org" && url.pathname === "/api/v4/transfers/transfer") {
        const name = INDEXED[url.searchParams.get("transaction_hash") ?? ""];
        return json(name ? edit(fx(name)) : '{"transfers":[]}');
      }
      return new Response("not recorded", { status: 500 });
    }) as typeof fetch;

  it("a Solana deposit: the record names the order and the NEAR transaction that credited it", async () => {
    expect(await findOrderByOrigin(SOL_SIG, tinyNear([]), publicOriginClient(omniFetch()))).toEqual({ account: ORDER, chain: "sol", originTx: SOL_SIG, depositTx: "4x2doim2J1e15jx7UyeQpuiGr2iN6dsxfNAK463Hm6Mc", via: "omni" });
  });

  it("an EVM deposit through Omni is found the same way, before any PoA search", async () => {
    expect(await findOrderByOrigin(BNB_TX, tinyNear([]), publicOriginClient(omniFetch()))).toEqual({ account: "solver-rwa.near", chain: "bsc", originTx: BNB_TX, depositTx: "AtgnvPGumy1oTKLUuiTph3aCohnXxebrri5sFZVKdKhp", via: "omni" });
  });

  it("an Omni transfer to a plain NEAR account is not a NEAR Intents deposit, and says where it went", async () => {
    expect(await findOrderByOrigin(ETH_TX, tinyNear([]), publicOriginClient(omniFetch()))).toEqual({ notFound: "this Ethereum transaction is an Omni bridge transfer to the NEAR account strawberry1212.near, not a deposit into NEAR Intents" });
  });

  it("a deposit not yet finalised on NEAR still names its order (synthetic: the finalisation removed)", async () => {
    const pending = (b: string) => JSON.stringify({ transfers: (JSON.parse(b) as { transfers: Record<string, unknown>[] }).transfers.map(({ finalised: _f, ...t }) => ({ ...t, status: "Initialised" })) });
    expect(await findOrderByOrigin(SOL_SIG, tinyNear([]), publicOriginClient(omniFetch(pending)))).toEqual({ account: ORDER, chain: "sol", originTx: SOL_SIG, via: "omni" });
  });

  it("a Solana transaction the Omni bridge does not know: says what can be searched instead", async () => {
    const sig = "2xu8DRon9ZP5vofTcpTPFcMindmxMrPPh5NP4YKp8zfSLdUfX2cwfgyYVPz8QJjVjwVfceKeu3xGECu9kYGG8VB4";
    expect(await findOrderByOrigin(sig, tinyNear([]), publicOriginClient(omniFetch()))).toEqual({
      notFound: "the Omni bridge has no transfer started by this Solana transaction, and Solana deposits through the PoA bridge are not searchable yet: paste the NEAR order account or a NEAR transaction",
    });
  });

  it("an EVM transaction the Omni bridge does not know falls back to the PoA search", async () => {
    const evmHash = `0x${"ab".repeat(32)}`;
    const asked: string[] = [];
    const origin: OriginClient = { ...fakeOrigin(), omniOrigin: async (h) => (asked.push(h), null) };
    expect(await findOrderByOrigin(evmHash, tinyNear([deposit("mine", 1_567, evmHash, "a".repeat(64))]), origin)).toEqual({ account: "a".repeat(64), depositTx: "mine", chain: "tron", originTx: evmHash });
    expect(asked).toEqual([evmHash]);
  });
});
