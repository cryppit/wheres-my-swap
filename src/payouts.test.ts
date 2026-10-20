// The destination-chain readers against payloads recorded from the real keyless APIs for five G1 orders whose payouts
// are known (from a 50-order experiment).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { matchPayout, type PayoutTarget } from "./core/payout.js";
import { publicPayoutClient } from "./payouts.js";

const fx = (name: string): string => readFileSync(new URL(`./fixtures/payouts/${name}`, import.meta.url), "utf8");
const json = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

/** The Omni bridge indexer's transfer look-up by NEAR transaction (recorded 2026-10-14). */
const OMNI_TRANSFER = "https://mainnet.api.bridge.nearone.org/api/v4/transfers/transfer?transaction_hash=";
const ZEC = "https://api.blockchair.com/zcash/";
/** The Zcash payout the Omni indexer names for order 496c306d… (Blockchair, recorded 2026-10-14). */
const ZEC_PAID = "064ff3c012168e5a07d797395cc43b1770cc8167cc1ff4ab163871870ecfb6a4";

/** Serves the recorded payloads; any other request fails the test. */
function recordedFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.trongrid.io/v1/accounts/THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc/transactions/trc20")) return json(fx("tron.json"));
    if (url === "https://mempool.space/api/address/bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz/txs") return json(fx("btc.json"));
    if (url.startsWith("https://eth.blockscout.com/api/v2/addresses/0xDc3D508De3312Bfc650AE9F72Ccaa009D036Fadc/transactions")) return json(fx("eth-native.json"));
    if (url.startsWith("https://eth.blockscout.com/api/v2/addresses/0xDc3D508De3312Bfc650AE9F72Ccaa009D036Fadc/internal-transactions")) return json(fx("eth-internal.json"));
    if (url.startsWith("https://eth.blockscout.com/api/v2/addresses/0xc9C14cE1dDAf56d5504565524B88D4677c25C595/token-transfers")) return json(fx("eth-usdc.json"));
    if (url === `${OMNI_TRANSFER}DmNAX4juTqPhTU5XavQwGDxhuo7dngmYpFsdVr6f1QHf`) return json(fx("omni-transfer-zec.json"));
    if (url === `${OMNI_TRANSFER}ANNiXdHQYd72kZQxdCJ8ASEpCHghPco285yeVU7x2Mib`) return json(fx("omni-transfer-sol.json"));
    if (url === `${OMNI_TRANSFER}RbfTx`) return json(JSON.stringify({ transfers: [{ origin_chain: "Near", destination_chain: "Btc", token_id: "near:nbtc.bridge.near", amount: "5000", status: "Settled", finalised: { transaction_hash: "first-broadcast" }, utxo_winning_tx_hash: "replaced-by-fee" }] }));
    if (url.startsWith(OMNI_TRANSFER)) return new Response("Not found", { status: 404 });
    if (url === "https://bridge-indexer.chaindefuser.com/api/v1/withdrawals?near_trx=AbNKsSczVN3vsrWFFKuMxMZU9h6dszXku6fNT2b2D5ZY") return json(fx("hot-withdrawal-bsc.json"));
    if (url === "https://mempool.space/api/tx/519166fb0d3edde399ec6474bfbdbc8e88a1ab93b7bf16c2ab19bd8664b3348b") return json(JSON.stringify((JSON.parse(fx("btc.json")) as { txid: string }[]).find((t) => t.txid.startsWith("519166fb"))));
    if (url === `${ZEC}dashboards/transaction/${ZEC_PAID}`) return json(fx("zec-tx-064ff3c0-omni.json"));
    if (url === `${ZEC}raw/transaction/${ZEC_PAID}`) return json(fx("zec-raw-064ff3c0-omni.json"));
    if (url === "https://relay.example/api/solana") return json(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
    if (url === "https://bridge.chaindefuser.com/rpc") {
      const body = JSON.parse(String(init?.body)) as { params: [{ withdrawal_hash: string }] };
      if (body.params[0].withdrawal_hash === "52TdfB4K31TvNhivefeGdKvv8X8ziQjNwCqEBDT1Pmyg") return json(fx("bridge-tron.json"));
      return json(fx("bridge-notfound.json"));
    }
    if (url === "https://api.mainnet-beta.solana.com") {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === "getSignaturesForAddress") return json(fx("sol-sigs.json"));
      const sig = String(body.params[0]);
      if (sig.startsWith("mYLrwEbJ")) return json(fx("sol-tx-mYLrwEbJ.json"));
      if (sig.startsWith("8btsGSiq")) return json(fx("sol-tx-8btsGSiq.json"));
      if (sig.startsWith("3Pho1")) return json(fx("sol-tx-3Pho1-omni.json"));
    }
    return new Response("not recorded", { status: 404 });
  }) as typeof fetch;
}

const ONE_DAY_LATER = (burnSec: number) => burnSec + 86_400;
const base = (t: PayoutTarget) => ({ chain: t.chain, bridge: "poa" as const, destination: t.address });

async function find(t: PayoutTarget) {
  const page = await publicPayoutClient(recordedFetch()).incoming(t);
  return matchPayout(t, page, ONE_DAY_LATER(t.burnSec), base(t));
}

describe("publicPayoutClient finds the known payouts", () => {
  it("TRON USDT (TronGrid): 2.278887 burned, 1.409111 paid 12 s later", async () => {
    const t: PayoutTarget = { chain: "tron", address: "THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc", asset: { kind: "token", contract: "d28a265909efecdcee7c5028585214ea0b96f015" }, burned: 2_278_887n, burnSec: 1_791_009_957 };
    expect(await find(t)).toMatchObject({ status: "arrived", how: "matched", tx: "658fe927eeb55d668abef63cb71333413d2633166b08ed2fb0c0153da986193d", amount: "1409111", delaySec: 12 });
  });

  it("BTC (mempool.space): 13,870 sats burned, 12,414 paid", async () => {
    const t: PayoutTarget = { chain: "btc", address: "bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz", asset: { kind: "native" }, burned: 13_870n, burnSec: 1_791_009_941 };
    expect(await find(t)).toMatchObject({ status: "arrived", tx: "519166fb0d3edde399ec6474bfbdbc8e88a1ab93b7bf16c2ab19bd8664b3348b", amount: "12414", delaySec: 139 });
  });

  it("native ETH (Blockscout, plain and internal transactions)", async () => {
    const t: PayoutTarget = { chain: "eth", address: "0xDc3D508De3312Bfc650AE9F72Ccaa009D036Fadc", asset: { kind: "native" }, burned: 38_192_113_227_295_700n, burnSec: 1_791_010_018 };
    expect(await find(t)).toMatchObject({ status: "arrived", tx: "0xd185c1ecfb1ca4c40f6afb3059130fedc3970341eea17c633ad57981dfb2e992", amount: "38157113227295700", delaySec: 13 });
  });

  it("USDC on Ethereum (Blockscout token transfers, filtered to the token)", async () => {
    const calls: string[] = [];
    const t: PayoutTarget = { chain: "eth", address: "0xc9C14cE1dDAf56d5504565524B88D4677c25C595", asset: { kind: "token", contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }, burned: 352_566_113n, burnSec: 1_791_010_319 };
    const page = await publicPayoutClient(recordedFetch(calls)).incoming(t);
    expect(calls[0]).toContain("token=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(matchPayout(t, page, ONE_DAY_LATER(t.burnSec), base(t))).toMatchObject({ status: "arrived", tx: "0x7796d58994c96486b7ae34df180141d2ec85d8c05361645d61253209cf16ac0a", amount: "352266113" });
  });

  it("SOL (public RPC): reads the recipient's balance change, ignores its own outgoing transaction", async () => {
    const t: PayoutTarget = { chain: "sol", address: "DunkcEZjri9EzKpHJqYxwFHwbJhdKxNoSUPdkbKD8XeS", asset: { kind: "native" }, burned: 174_340_492n, burnSec: 1_791_010_003 };
    expect(await find(t)).toMatchObject({ status: "arrived", tx: "mYLrwEbJZMz2BMAWpTSV2AY5sRu9NvtFN5VHWyzPpuViqg3Ndu6Qc7d75AUjxLtZBgw3x6ubLzz4mC5bD1uvjf1", amount: "174340492", delaySec: 15 });
  });

  it("an HTTP error is thrown with the source named, for the caller to report", async () => {
    const t: PayoutTarget = { chain: "btc", address: "bc1qunknownaddressxxxxxxxxxxxxxxxxxxxxxx", asset: { kind: "native" }, burned: 1n, burnSec: 1 };
    await expect(publicPayoutClient(recordedFetch()).incoming(t)).rejects.toThrow(/mempool\.space.*HTTP 404/);
  });
});

describe("publicPayoutClient asks the destination's Omni bridge contract whether a transfer was paid", () => {
  // The contract marks a destination nonce only inside a finalisation that verified the bridge's signature and paid the
  // signed recipient, so its record answers when the indexer has not named the payout: on 2026-10-18, 10 of the 177
  // transfers the indexer still listed as unpaid were marked paid on chain (9 on Ethereum, 299.4 ZEC on Starknet).
  const rpc = (answer: () => unknown, calls: string[] = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      calls.push(`${String(input)} ${body.method} ${JSON.stringify(body.params)}`);
      return json(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer() }));
    }) as typeof fetch;

  it("EVM chains: completedTransfers(destination nonce) on the bridge contract, by eth_call", async () => {
    const calls: string[] = [];
    expect(await publicPayoutClient(rpc(() => `0x${"0".repeat(63)}1`, calls)).omniPaid("base", 816)).toBe(true);
    expect(calls).toEqual([`https://mainnet.base.org eth_call ${JSON.stringify([{ to: "0xd025b38762B4A4E36F0Cde483b86CB13ea00D989", data: `0x2f771a2a${(816).toString(16).padStart(64, "0")}` }, "latest"])}`]);
    expect(await publicPayoutClient(rpc(() => `0x${"0".repeat(64)}`)).omniPaid("eth", 8159)).toBe(false);
  });

  it("Starknet: is_transfer_finalised(destination nonce), by starknet_call", async () => {
    const calls: string[] = [];
    expect(await publicPayoutClient(rpc(() => ["0x1"], calls)).omniPaid("starknet", 193)).toBe(true);
    expect(calls).toEqual([`https://starknet-rpc.publicnode.com starknet_call ${JSON.stringify([{ contract_address: "0x5f9a4a841dfb7bb3cde33073b2450fe45dcd407fb6c0985a274b0e943ad8598", entry_point_selector: "0x11667d5bee6cbca352c523fdb26683a9ddaed2d2e7d5830bd75b44542ace2b5", calldata: ["0xc1"] }, "latest"])}`]);
    expect(await publicPayoutClient(rpc(() => ["0x0"])).omniPaid("starknet", 193)).toBe(false);
  });

  it("asks nobody on a chain whose contract it does not know, and gives no answer when the RPCs cannot", async () => {
    const calls: string[] = [];
    expect(await publicPayoutClient(rpc(() => "0x1", calls)).omniPaid("sol", 1)).toBeNull();
    expect(calls).toEqual([]);
    const down = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    expect(await publicPayoutClient(down).omniPaid("base", 816)).toBeNull();
  });
});

describe("publicPayoutClient asks the explorers where they answer browsers today", () => {
  // optimism.blockscout.com and gnosis.blockscout.com answer every call with a 301 to explorer.optimism.io and
  // gnosisscan.io, and the redirect carries no CORS header, so a browser refuses it; the new hosts serve the same
  // Blockscout API with CORS open (checked 2026-10-18).
  it("searches Optimism on explorer.optimism.io and Gnosis on gnosisscan.io, never the old names", async () => {
    for (const [chain, host] of [["op", "https://explorer.optimism.io/api/v2/addresses/"], ["gnosis", "https://gnosisscan.io/api/v2/addresses/"]] as const) {
      const calls: string[] = [];
      const empty = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return json(JSON.stringify({ items: [], next_page_params: null }));
      }) as typeof fetch;
      const t: PayoutTarget = { chain, address: "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd", asset: { kind: "native" }, burned: 1n, burnSec: 1_791_010_018 };
      await publicPayoutClient(empty).incoming(t);
      expect(calls.length).toBeGreaterThan(0);
      for (const url of calls) expect(url.startsWith(host)).toBe(true);
    }
  });
});

describe("publicPayoutClient reads the sender", () => {
  const T = "0x2CfF890f0378a11913B6129B2E97417a2c302680";
  it("TRON USDT and Ethereum payouts came from the published NEAR Intents treasury", async () => {
    const tron: PayoutTarget = { chain: "tron", address: "THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc", asset: { kind: "token", contract: "d28a265909efecdcee7c5028585214ea0b96f015" }, burned: 2_278_887n, burnSec: 1_791_009_957 };
    expect(await find(tron)).toMatchObject({ sender: { address: "TX5XiRXdyz7sdFwF5mnhT1QoGCpbkncpke", treasury: "NEAR Intents" } });
    const eth: PayoutTarget = { chain: "eth", address: "0xDc3D508De3312Bfc650AE9F72Ccaa009D036Fadc", asset: { kind: "native" }, burned: 38_192_113_227_295_700n, burnSec: 1_791_010_018 };
    expect(await find(eth)).toMatchObject({ sender: { address: T, treasury: "NEAR Intents" } });
    const usdc: PayoutTarget = { chain: "eth", address: "0xc9C14cE1dDAf56d5504565524B88D4677c25C595", asset: { kind: "token", contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }, burned: 352_566_113n, burnSec: 1_791_010_319 };
    expect(await find(usdc)).toMatchObject({ sender: { address: T, treasury: "NEAR Intents" } });
  });

  it("BTC and SOL payouts name their payer, which is not on the treasury list", async () => {
    const btc: PayoutTarget = { chain: "btc", address: "bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz", asset: { kind: "native" }, burned: 13_870n, burnSec: 1_791_009_941 };
    expect(await find(btc)).toMatchObject({ sender: { address: "bc1qtd8nuuve45ala350an45c8k2s9ehz42gcrv3py", treasury: null } });
    const sol: PayoutTarget = { chain: "sol", address: "DunkcEZjri9EzKpHJqYxwFHwbJhdKxNoSUPdkbKD8XeS", asset: { kind: "native" }, burned: 174_340_492n, burnSec: 1_791_010_003 };
    expect(await find(sol)).toMatchObject({ sender: { address: "DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn", treasury: null } });
  });
});

describe("publicPayoutClient asks the PoA bridge (withdrawal_status, keyless, CORS open)", () => {
  it("returns the status and the transfer the bridge says it sent, for the withdrawal's token", async () => {
    const report = await publicPayoutClient(recordedFetch()).bridgeWithdrawal("52TdfB4K31TvNhivefeGdKvv8X8ziQjNwCqEBDT1Pmyg", "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near");
    expect(report).toEqual({ status: "COMPLETED", tx: "658fe927eeb55d668abef63cb71333413d2633166b08ed2fb0c0153da986193d" });
  });

  it("a withdrawal the bridge does not know is null, not an error", async () => {
    expect(await publicPayoutClient(recordedFetch()).bridgeWithdrawal("ExsTmjhxCqhvHLhhSHosSsSZRifqSK9mhP7Lx3tvEVYW", "nep141:sol.omft.near")).toBeNull();
  });
});

describe("publicPayoutClient asks the Omni bridge's indexer (keyless, CORS open)", () => {
  it("returns the transfer's status and the payout it names: a ZEC withdrawal paid to a unified address", async () => {
    const report = await publicPayoutClient(recordedFetch()).omniTransfer("DmNAX4juTqPhTU5XavQwGDxhuo7dngmYpFsdVr6f1QHf", "nep141:zec.omft.near", "55158859");
    expect(report).toEqual({ source: "omni", status: "Settled", tx: "064ff3c012168e5a07d797395cc43b1770cc8167cc1ff4ab163871870ecfb6a4", destinationNonce: 38442 });
  });

  it("and a SOL withdrawal, paid by a Solana transaction", async () => {
    const report = await publicPayoutClient(recordedFetch()).omniTransfer("ANNiXdHQYd72kZQxdCJ8ASEpCHghPco285yeVU7x2Mib", "nep141:sol.omft.near", "384642580");
    expect(report).toEqual({ source: "omni", status: "Settled", tx: "3Pho1AA4FCiM6ShMaPtqoMmJmDPvLpVFviuMnKHpgEn2cvpP4ty5DEumkhkmF1vsTiTrXPAanYjQJp585Pj9297X", destinationNonce: 20540 });
  });

  it("a NEAR transaction the indexer does not know is null, not an error", async () => {
    expect(await publicPayoutClient(recordedFetch()).omniTransfer("9ga3wWegusr56pFcCegc4Q6XUTkDFJSqBk2jDbG2dRuo", "nep141:sol.omft.near", "1")).toBeNull();
  });
});

describe("publicPayoutClient reads a payout the bridge names, by its transaction", () => {
  it("Solana: what the transaction paid the destination, read from the balances it changed (Omni SOL payout 3Pho1…)", async () => {
    const t: PayoutTarget = { chain: "sol", address: "Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5", asset: { kind: "native" }, burned: 384_642_580n, burnSec: 1_782_395_862 };
    expect(await publicPayoutClient(recordedFetch()).payoutTx(t, "3Pho1AA4FCiM6ShMaPtqoMmJmDPvLpVFviuMnKHpgEn2cvpP4ty5DEumkhkmF1vsTiTrXPAanYjQJp585Pj9297X")).toEqual({
      tx: "3Pho1AA4FCiM6ShMaPtqoMmJmDPvLpVFviuMnKHpgEn2cvpP4ty5DEumkhkmF1vsTiTrXPAanYjQJp585Pj9297X",
      amount: "384642580",
      timestampSec: 1_782_395_895,
      from: "DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn",
    });
  });

  it("Bitcoin: the outputs to the destination (mempool.space)", async () => {
    const t: PayoutTarget = { chain: "btc", address: "bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz", asset: { kind: "native" }, burned: 13_870n, burnSec: 1_791_009_941 };
    expect(await publicPayoutClient(recordedFetch()).payoutTx(t, "519166fb0d3edde399ec6474bfbdbc8e88a1ab93b7bf16c2ab19bd8664b3348b")).toMatchObject({ amount: "12414", timestampSec: 1_791_010_080 });
  });

  it("a Solana RPC given by the caller is used instead of the public one (the site relays it: the public RPC refuses browsers)", async () => {
    const calls: string[] = [];
    const t: PayoutTarget = { chain: "sol", address: "Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5", asset: { kind: "native" }, burned: 1n, burnSec: 1_782_395_862 };
    await publicPayoutClient(recordedFetch(calls), { solanaRpc: "https://relay.example/api/solana" }).incoming(t);
    expect(calls).toEqual(["https://relay.example/api/solana"]);
  });
});

describe("publicPayoutClient reads a Zcash transaction (Blockchair, keyless, CORS open)", () => {
  it("its block time, its transparent outputs and what it moved into each shielded pool", async () => {
    expect(await publicPayoutClient(recordedFetch()).zcashTx(ZEC_PAID)).toEqual({
      confirmedAtSec: Date.parse("2026-10-13T20:35:09Z") / 1000,
      outputs: [{ address: "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua", valueZat: 36_714_178n }],
      shieldedIn: [{ pool: "Ironwood", zat: 55_133_859n }],
    });
  });

  it("a transaction Blockchair does not know is null", async () => {
    expect(await publicPayoutClient(recordedFetch()).zcashTx("00".repeat(32))).toBeNull();
  });
});

describe("publicPayoutClient asks the HOT bridge's indexer (keyless, CORS open)", () => {
  it("returns the destination transaction it names for a HOT withdrawal", async () => {
    expect(await publicPayoutClient(recordedFetch()).hotWithdrawal("AbNKsSczVN3vsrWFFKuMxMZU9h6dszXku6fNT2b2D5ZY")).toEqual({
      source: "hot",
      status: "COMPLETED",
      tx: "0xffce5d2014fc5da706b5424c35bfe830b3a637b6c99b680ff68c1c33418e8a39",
    });
  });

  it("a withdrawal it does not know is null", async () => {
    expect(await publicPayoutClient(recordedFetch()).hotWithdrawal("9ga3wWegusr56pFcCegc4Q6XUTkDFJSqBk2jDbG2dRuo")).toBeNull();
  });
});

describe("publicPayoutClient: an Omni Fast Transfer (a relayer pays early from its own funds, the bridge repays it later)", () => {
  // DERIVED from the recorded SOL record (omni-transfer-sol.json): no recorded transfer has `fast_finalised` set. The
  // indexer's TransferV4 keeps `fast_finalised` and `finalised` apart (OpenAPI v0.1.0), each a transaction with its chain.
  const record = JSON.parse(fx("omni-transfer-sol.json")) as { transfers: Record<string, unknown>[] };
  const transfer = record.transfers[0] ?? {};
  const ref = (hash: string, chain: string) => ({ transaction_hash: hash, chain, timestamp_seconds: 1782395885, details: { type: "solana", slot: 1, instruction_index: 0 } });
  const answering = (fast: Record<string, unknown> | null, finalised: Record<string, unknown> | null): typeof fetch =>
    (async () => json(JSON.stringify({ transfers: [{ ...transfer, status: "Settled", fast_finalised: fast, finalised }] }))) as typeof fetch;
  const PAID = "3Pho1AA4FCiM6ShMaPtqoMmJmDPvLpVFviuMnKHpgEn2cvpP4ty5DEumkhkmF1vsTiTrXPAanYjQJp585Pj9297X";

  it("names the fast transaction on the destination chain beside the bridge's finalisation", async () => {
    const report = await publicPayoutClient(answering(ref(PAID, "Sol"), ref("RepaysTheRelayer", "Sol"))).omniTransfer("ANNiXdHQYd72kZQxdCJ8ASEpCHghPco285yeVU7x2Mib", "nep141:sol.omft.near", "384642580");
    expect(report).toEqual({ source: "omni", status: "Settled", tx: "RepaysTheRelayer", fastTx: PAID, destinationNonce: 20540 });
  });

  it("a fast finalisation on NEAR (a transfer into NEAR) is not a payout on the destination chain", async () => {
    const report = await publicPayoutClient(answering(ref("NearSide", "Near"), ref(PAID, "Sol"))).omniTransfer("ANNiXdHQYd72kZQxdCJ8ASEpCHghPco285yeVU7x2Mib", "nep141:sol.omft.near", "384642580");
    expect(report).toEqual({ source: "omni", status: "Settled", tx: PAID, destinationNonce: 20540 });
  });
});

describe("publicPayoutClient: a Bitcoin payout replaced by fee", () => {
  it("names the confirmed payout (utxo_winning_tx_hash), not the first broadcast", async () => {
    expect(await publicPayoutClient(recordedFetch()).omniTransfer("RbfTx", "nep141:nbtc.bridge.near", "5000")).toEqual({ source: "omni", status: "Settled", tx: "replaced-by-fee" });
  });
});

describe("dustBelow", () => {
  it("reads 1Click's public token list once and turns its prices into dust thresholds", async () => {
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return json(JSON.stringify([
        { assetId: "nep141:base.omft.near", decimals: 18, blockchain: "base", symbol: "ETH", price: 2501.41 },
        { assetId: "nep141:unpriced.near", decimals: 6, blockchain: "near", symbol: "X" },
      ]));
    }) as typeof fetch;
    const client = publicPayoutClient(fake);
    expect(await client.dustBelow()).toEqual({ "nep141:base.omft.near": "19988726358333" });
    await client.dustBelow();
    expect(calls).toEqual(["https://1click.chaindefuser.com/v0/tokens"]);
  });

  it("asks again after a failed read", async () => {
    let n = 0;
    const fake = (async () => (++n === 1 ? new Response("busy", { status: 503 }) : json("[]"))) as typeof fetch;
    const client = publicPayoutClient(fake);
    await expect(client.dustBelow()).rejects.toThrow("HTTP 503");
    expect(await client.dustBelow()).toEqual({});
  });
});

describe("payoutTx on EVM chains: the transaction the bridge names, read by JSON-RPC", () => {
  // Order e0de3c0a… (accuracy audit): base.blockscout.com answered every call with a Cloudflare challenge, so the
  // payout the PoA bridge names is read from mainnet.base.org (receipt and block recorded 2026-10-14; the block is
  // trimmed to the fields read).
  const PAID = "0x192a5193445af41a4528954c77c277e4b0c5f9f000c2d18f2db68fce0215795b";
  const target: PayoutTarget = { chain: "base", address: "0x3D03cc6Fc1b8e91e4569FDD2985160b9E7AA428A", asset: { kind: "token", contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, burned: 24_950_000n, burnSec: 0x6ab6f3ed - 20 };
  const rpcFetch = (answers: Record<string, string>, calls: string[] = []): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      calls.push(`${String(input)} ${body.method ?? ""}`);
      const answer = body.method ? answers[body.method] : undefined;
      return answer ? json(answer) : new Response("not recorded", { status: 404 });
    }) as typeof fetch;

  it("sums the token's Transfer logs into the destination, with the block time and the sender", async () => {
    const calls: string[] = [];
    const client = publicPayoutClient(rpcFetch({ eth_getTransactionReceipt: fx("base-usdc-receipt.json"), eth_getBlockByNumber: fx("base-usdc-block.json") }, calls));
    expect(await client.payoutTx(target, PAID)).toEqual({ tx: PAID, amount: "24947600", timestampSec: 0x6ab6f3ed, from: "0x2cff890f0378a11913b6129b2e97417a2c302680" });
    expect(calls).toEqual(["https://mainnet.base.org eth_getTransactionReceipt", "https://mainnet.base.org eth_getBlockByNumber"]);
  });

  it("a transaction that pays another address, or another token, is not the payout", async () => {
    const client = publicPayoutClient(rpcFetch({ eth_getTransactionReceipt: fx("base-usdc-receipt.json"), eth_getBlockByNumber: fx("base-usdc-block.json") }));
    expect(await client.payoutTx({ ...target, address: "0x0000000000000000000000000000000000000001" }, PAID)).toBeNull();
    expect(await client.payoutTx({ ...target, asset: { kind: "token", contract: "0xdac17f958d2ee523a2206206994597c13d831ec7" } }, PAID)).toBeNull();
  });

  it("a reverted transaction pays nothing", async () => {
    const reverted = fx("base-usdc-receipt.json").replace('"status":"0x1"', '"status":"0x0"');
    const client = publicPayoutClient(rpcFetch({ eth_getTransactionReceipt: reverted, eth_getBlockByNumber: fx("base-usdc-block.json") }));
    expect(await client.payoutTx(target, PAID)).toBeNull();
  });

  it("native coin: the transaction's own value to the destination", async () => {
    // Constructed from the recorded receipt: a plain ETH transfer has no logs; its value and recipient are the tx's.
    const receipt = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "0x1", blockNumber: "0x3164b85", logs: [] } });
    const tx = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hash: PAID, from: "0x2cff890f0378a11913b6129b2e97417a2c302680", to: "0x3d03cc6fc1b8e91e4569fdd2985160b9e7aa428a", value: "0x2386f26fc10000" } });
    const client = publicPayoutClient(rpcFetch({ eth_getTransactionReceipt: receipt, eth_getTransactionByHash: tx, eth_getBlockByNumber: fx("base-usdc-block.json") }));
    expect(await client.payoutTx({ ...target, asset: { kind: "native" }, burned: 10n ** 16n }, PAID)).toEqual({ tx: PAID, amount: "10000000000000000", timestampSec: 0x6ab6f3ed, from: "0x2cff890f0378a11913b6129b2e97417a2c302680" });
  });
});

describe("payoutTx on the HOT bridge: its withdraw call, read by JSON-RPC", () => {
  // HOT pays from its bridge contract, MetaWallet 0x233c5370… (the same address on BSC, Polygon, Avalanche, Monad and
  // OP; source verified on Sourcify): withdraw(nonce, contract_id, receiver_id, amount, signature) sends `amount` of
  // `contract_id` (address(0): the chain's coin) to `receiver_id` and reverts if that fails. A native payout is an
  // internal transfer that logs nothing, so the call itself is read. Two orders of the accuracy audit, recorded
  // 2026-10-17 from bsc-dataseed.bnbchain.org and polygon.drpc.org (trimmed to the fields read; the same answer from
  // any node that has the transaction).
  const HOT = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";
  const BSC_TX = "0x59572de0acf2f87f8a86e7b9c1314170c3f388ba8c438c7dc2bbb8d72ff9fe74";
  const POL_TX = "0x5a9bad4adaab1019d38da5637c1f20023bb910a66f847047b33099f550754989";
  const bnb: PayoutTarget = { chain: "bsc", address: "0x7d98583e96d333445e403e4ad72f7514d2a55a67", asset: { kind: "native" }, burned: 99_750_000_000_000n, burnSec: 1_791_752_259 };
  const usdt: PayoutTarget = { chain: "pol", address: "0x9c1ec8eea661d701e3f55d129968272582457f78", asset: { kind: "token", contract: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" }, burned: 2_046_950_201n, burnSec: 1_791_917_030 };
  /** Answers by URL and method; `"null"` answers like a node that does not know the transaction. */
  const rpcAt = (answers: Record<string, string>, calls: string[] = []): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      const key = `${String(input)} ${body.method ?? ""}`;
      calls.push(key);
      const answer = answers[key];
      if (answer === "null") return json(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      return answer ? json(answer) : new Response("not recorded", { status: 404 });
    }) as typeof fetch;
  const bsc = (url: string) => ({
    [`${url} eth_getTransactionReceipt`]: fx("hot-bsc-native-receipt.json"),
    [`${url} eth_getTransactionByHash`]: fx("hot-bsc-native-tx.json"),
    [`${url} eth_getBlockByNumber`]: fx("hot-bsc-native-block.json"),
  });

  it("native BNB: the call names the receiver and the amount, here what HOT paid after keeping its fee", async () => {
    const client = publicPayoutClient(rpcAt(bsc("https://bsc-dataseed.bnbchain.org")));
    expect(await client.payoutTx(bnb, BSC_TX)).toEqual({ tx: BSC_TX, amount: "86750000000000", timestampSec: 1_791_752_612, from: HOT });
  });

  it("USDT on Polygon: the token's Transfer log into the destination, sent by HOT's contract", async () => {
    const url = "https://rpc-mainnet.matic.quiknode.pro";
    const client = publicPayoutClient(rpcAt({ [`${url} eth_getTransactionReceipt`]: fx("hot-pol-usdt-receipt.json"), [`${url} eth_getTransactionByHash`]: fx("hot-pol-usdt-tx.json"), [`${url} eth_getBlockByNumber`]: fx("hot-pol-usdt-block.json") }));
    expect(await client.payoutTx(usdt, POL_TX)).toEqual({ tx: POL_TX, amount: "2046950201", timestampSec: 1_791_917_049, from: HOT });
  });

  it("a call that pays someone else, or another token, or that reverted, is not the payout", async () => {
    const client = publicPayoutClient(rpcAt(bsc("https://bsc-dataseed.bnbchain.org")));
    expect(await client.payoutTx({ ...bnb, address: "0x0000000000000000000000000000000000000001" }, BSC_TX)).toBeNull();
    expect(await client.payoutTx({ ...bnb, asset: { kind: "token", contract: "0x55d398326f99059ff775485246999027b3197955" } }, BSC_TX)).toBeNull();
    const reverted = publicPayoutClient(rpcAt({ ...bsc("https://bsc-dataseed.bnbchain.org"), "https://bsc-dataseed.bnbchain.org eth_getTransactionReceipt": fx("hot-bsc-native-receipt.json").replace('"status":"0x1"', '"status":"0x0"') }));
    expect(await reverted.payoutTx(bnb, BSC_TX)).toBeNull();
  });

  it("asks the next public RPC when one does not know the transaction (public nodes keep different amounts of history)", async () => {
    const calls: string[] = [];
    const client = publicPayoutClient(rpcAt({ "https://bsc-dataseed.bnbchain.org eth_getTransactionReceipt": "null", ...bsc("https://bsc-dataseed1.bnbchain.org") }, calls));
    expect(await client.payoutTx(bnb, BSC_TX)).toMatchObject({ amount: "86750000000000" });
    expect(calls[0]).toBe("https://bsc-dataseed.bnbchain.org eth_getTransactionReceipt");
    expect(calls).toContain("https://bsc-dataseed1.bnbchain.org eth_getTransactionReceipt");
  });

  it("a chain with no keyless history (BNB Chain) is not searched, and says so", async () => {
    expect(await publicPayoutClient(rpcAt({})).incoming(bnb)).toEqual({ items: [], complete: false, unsearched: "BNB Chain's history is not searched here: only the payout transaction the bridge names is read" });
  });

  it("every EVM chain a payout can go to has a public RPC", async () => {
    const { EVM_CHAINS } = await import("./core/payout.js");
    const { EVM_RPC } = await import("./payouts.js");
    for (const chain of EVM_CHAINS) expect(EVM_RPC[chain], chain).toMatch(/^https:\/\//);
  });
});

describe("payoutTx on Litecoin, Dogecoin, Bitcoin Cash and Dash: the transaction the PoA bridge names", () => {
  // Real PoA payouts (2025-11 to 2026-10), recorded 2026-10-17 from Blockchair's dashboard API (keyless: its terms allow
  // personal and non-commercial projects, used while the checker is free), BlockCypher and Haskoin.
  const BLOCKCHAIR = "https://api.blockchair.com/";
  const serve = (routes: Record<string, string | number>, calls: string[] = []): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const r = routes[url];
      if (typeof r === "number") return new Response("limited", { status: r });
      return r ? json(r) : new Response("not recorded", { status: 404 });
    }) as typeof fetch;
  const target = (chain: PayoutTarget["chain"], address: string, burned: bigint): PayoutTarget => ({ chain, address, asset: { kind: "native" }, burned, burnSec: 1_791_000_000 });
  const LTC = "2ae8e3f327dcde08bd42e898d889e2f795b4ab5ff3d3d10c53e7f4e7ad7cecba";
  const LTC_MEMPOOL = "e6eae4e52fce7e391c1cc933364040c16d0d13e136b720c97970ba3ef1a5dd0d";
  const LTC_DEEP = "c0f4602dc7bc781146d952e0c8649559e5cbc0ae18dbd2d4db78ee371d593e21";
  const DOGE = "1c7b1bec11cfab565c028e34fc7d39973b2621b55e40fd4becd606d1b4d98198";
  const BCH = "9947330a1793b6cb964267e6e33ecb3530170e8433caf81a56e8ab2d01ca37a3";
  const DASH = "58feeae2e6d693827c01141323d3bc79b99ef98e1361c3c332cb4208edfbc7df";

  it("sums the outputs to the destination, with the block time and the bridge's hot wallet as the sender", async () => {
    const c = publicPayoutClient(serve({ [`${BLOCKCHAIR}litecoin/dashboards/transaction/${LTC}`]: fx("ltc-blockchair-2ae8.json") }));
    expect(await c.payoutTx(target("ltc", "ltc1qwqy4xpyk0plpjs6qwh0883aklx0w3j26uey35g", 20_517_656n), LTC)).toEqual({
      tx: LTC,
      amount: "20517156",
      timestampSec: Date.parse("2026-10-12T20:53:29Z") / 1000,
      from: "LQjEMkuiA2pCwFeUPwsu6ktzUubBVLsahX",
    });
  });

  it("a payout still in the mempool counts, with no block time yet", async () => {
    const c = publicPayoutClient(serve({ [`${BLOCKCHAIR}litecoin/dashboards/transaction/${LTC_MEMPOOL}`]: fx("ltc-blockchair-e6ea-mempool.json") }));
    expect(await c.payoutTx(target("ltc", "ltc1qughrlvugzzh4yk7gmf7ez4ucxkttg0qelqrq63", 217_449_924n), LTC_MEMPOOL)).toMatchObject({ amount: "217449424", timestampSec: null });
  });

  it("Dogecoin, Bitcoin Cash (CashAddr without its prefix) and Dash read the same way", async () => {
    const c = publicPayoutClient(
      serve({
        [`${BLOCKCHAIR}dogecoin/dashboards/transaction/${DOGE}`]: fx("doge-blockchair-1c7b.json"),
        [`${BLOCKCHAIR}bitcoin-cash/dashboards/transaction/${BCH}`]: fx("bch-blockchair-9947.json"),
        [`${BLOCKCHAIR}dash/dashboards/transaction/${DASH}`]: fx("dash-blockchair-58fe.json"),
      }),
    );
    expect(await c.payoutTx(target("doge", "D6qEXW9iszzzaPDi8hSTv9UFqLL4V2qCHn", 527_381_958n), DOGE)).toMatchObject({ amount: "482381958", from: "DRmCnxzL9U11EJzLmWkm2ikaZikPFbLuQD" });
    expect(await c.payoutTx(target("bch", "qz8zs4s480v82udw6xdyhc8c6u2zu4uug5dt7th92j", 2_644_838n), BCH)).toMatchObject({ amount: "2644338", timestampSec: Date.parse("2026-09-22T21:09:31Z") / 1000 });
    expect(await c.payoutTx(target("dash", "XxsmQTu8DThCSs7hCC2JigB8nf7aTPjWEj", 102_921_875n), DASH)).toMatchObject({ amount: "102821875", from: "XxA9DbXaFpF4GFY8KUNX7eAxhZPsWtcKhc" });
  });

  it("a transaction that pays another address is not the payout", async () => {
    const c = publicPayoutClient(serve({ [`${BLOCKCHAIR}litecoin/dashboards/transaction/${LTC}`]: fx("ltc-blockchair-2ae8.json") }));
    expect(await c.payoutTx(target("ltc", "ltc1qughrlvugzzh4yk7gmf7ez4ucxkttg0qelqrq63", 1n), LTC)).toBeNull();
  });

  it("asks BlockCypher (LTC, DOGE, DASH) or Haskoin (BCH) when Blockchair does not know it or refuses", async () => {
    const calls: string[] = [];
    const c = publicPayoutClient(
      serve(
        {
          [`${BLOCKCHAIR}litecoin/dashboards/transaction/${LTC_DEEP}`]: fx("blockchair-not-found.json"),
          [`https://api.blockcypher.com/v1/ltc/main/txs/${LTC_DEEP}`]: fx("ltc-blockcypher-c0f4.json"),
          [`${BLOCKCHAIR}bitcoin-cash/dashboards/transaction/${BCH}`]: 430,
          [`https://api.haskoin.com/bch/transaction/${BCH}`]: fx("bch-haskoin-9947.json"),
        },
        calls,
      ),
    );
    expect(await c.payoutTx(target("ltc", "LMo6G6famNBUCL3693jjtUiiw9rerMyTBX", 7_698n), LTC_DEEP)).toEqual({ tx: LTC_DEEP, amount: "7198", timestampSec: Date.parse("2025-11-11T12:14:02Z") / 1000, from: "LQjEMkuiA2pCwFeUPwsu6ktzUubBVLsahX" });
    expect(await c.payoutTx(target("bch", "qz8zs4s480v82udw6xdyhc8c6u2zu4uug5dt7th92j", 2_644_838n), BCH)).toMatchObject({ amount: "2644338", from: "qrdd5m5s72wzs4u373ux2fcpn02hw00u7v9wr8cex8" });
    expect(calls).toContain(`https://api.haskoin.com/bch/transaction/${BCH}`);
  });

  it("their histories are not searched: only the payout transaction the bridge names is read", async () => {
    expect(await publicPayoutClient(serve({})).incoming(target("ltc", "ltc1qwqy4xpyk0plpjs6qwh0883aklx0w3j26uey35g", 1n))).toEqual({ items: [], complete: false, unsearched: "Litecoin's history is not searched here: only the payout transaction the bridge names is read" });
  });
});

describe("payoutTx on the XRP Ledger: the Payment the PoA bridge names", () => {
  // Real PoA payouts recorded 2026-10-17 from xrplcluster.com (keyless; free for non-commercial use, used while the checker
  // is free) and Ripple's s2 Clio server (not for business use; it answers Workers, not browsers).
  const CLUSTER = "https://xrplcluster.com/";
  const S2 = "https://s2.ripple.com:51234/";
  const RS3G = "9382C01697F6E0E7A98648797874750F71EFF575A152E5175D8A81A15EA0862A";
  const TAGGED = "0157C902C5791B8E7D900F32A786637F8C2C31C2F24119C03FA9C665E72202BE";
  const RLIH = "9894178F11E56AB2C391CD2BD181389F254375A17FFB808D35F1AD668388F0E8";
  const xrpl = (answers: Record<string, Record<string, string>>, calls: string[] = []): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const hash = (JSON.parse(String(init?.body ?? "{}")) as { params?: { transaction?: string }[] }).params?.[0]?.transaction ?? "";
      calls.push(`${url} ${hash.slice(0, 4)}`);
      const a = answers[url]?.[hash];
      return a ? json(a) : json(fx("xrp-tx-not-found.json"));
    }) as typeof fetch;
  const xrp = (address: string, burned: bigint, tag?: string): PayoutTarget => ({ chain: "xrp", address, asset: { kind: "native" }, burned, burnSec: 845_240_000 + 946_684_800, ...(tag ? { tag } : {}) });

  it("reads delivered_amount (never Amount), the ledger close time and the bridge's wallet as the sender", async () => {
    const c = publicPayoutClient(xrpl({ [CLUSTER]: { [RS3G]: fx("xrp-tx-rs3G.json") } }));
    expect(await c.payoutTx(xrp("rs3GBtMc64SCz4XkgsEKx2a3a6CWFX3gga", 1_087_372n), RS3G)).toEqual({ tx: RS3G, amount: "1087362", timestampSec: 845_240_871 + 946_684_800, from: "r9R8jciZBYGq32DxxQrBPi5ysZm67iQitH" });
  });

  it("a payment with a destination tag pays the withdrawal only when the tag is the memo's", async () => {
    const c = publicPayoutClient(xrpl({ [CLUSTER]: { [TAGGED]: fx("xrp-tx-tagged.json") } }));
    expect(await c.payoutTx(xrp("rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV", 100_011n, "419084126"), TAGGED)).toMatchObject({ amount: "100001" });
    expect(await c.payoutTx(xrp("rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV", 100_011n, "7"), TAGGED)).toBeNull();
    expect(await c.payoutTx(xrp("rs3GBtMc64SCz4XkgsEKx2a3a6CWFX3gga", 100_011n), TAGGED)).toBeNull();
  });

  it("a busy or unknowing server passes the question to the next one", async () => {
    const calls: string[] = [];
    const c = publicPayoutClient(xrpl({ [CLUSTER]: { [RLIH]: fx("xrp-too-busy.json") }, [S2]: { [RLIH]: fx("xrp-s2-rLih.json") } }, calls));
    expect(await c.payoutTx(xrp("rLihvJhyoq22so4RGfVYU3U15E5ugBwTq5", 107_437_452n), RLIH)).toMatchObject({ amount: "107437442" });
    expect(calls).toEqual([`${CLUSTER} 9894`, `${S2} 9894`]);
  });
});

describe("payoutTx on Sui, TON, Stellar, Cardano, Aptos, Starknet and HyperEVM: the transaction the bridge names", () => {
  // Real payouts recorded 2026-10-17 (keyless sources, some with terms for non-commercial or non-production use, used
  // while the checker is free): Sui GraphQL, toncenter v3 and tonapi, SDF Horizon, the Yoroi backend, Koios and AdaStat,
  // Aptos Labs' archive, PublicNode for Starknet, and Hyperliquid's own HyperEVM RPC.
  const at = (routes: Record<string, string | ((body: string) => string | null)>, calls: string[] = []): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const r = routes[url];
      const body = typeof r === "function" ? r(String(init?.body ?? "")) : r;
      return body ? json(body) : new Response('{"error":"not recorded"}', { status: 404 });
    }) as typeof fetch;
  const target = (chain: PayoutTarget["chain"], address: string, asset: PayoutTarget["asset"] = { kind: "native" }, extra: Partial<PayoutTarget> = {}): PayoutTarget => ({ chain, address, asset, burned: 1n, burnSec: 1_791_000_000, ...extra });

  it("Sui: the destination's SUI balance change in the transaction, from the GraphQL RPC", async () => {
    const tx = "4pikGmBuhBsiPUVv2C4DuQv7sBmNvte3oSY2vq17WqKV";
    const c = publicPayoutClient(at({ "https://graphql.mainnet.sui.io/graphql": (b) => (b.includes(tx) ? fx("sui-gql-4pik.json") : fx("sui-gql-unknown.json")) }));
    expect(await c.payoutTx(target("sui", "0xe52497c434f1ea35b3e0d282691c927fb92d8b0785a7bd8000da8ad9198e3bba"), tx)).toEqual({ tx, amount: "50221791199", timestampSec: 1_791_923_349, from: "0x00ea18889868519abd2f238966cab9875750bb2859ed3a34debec37781520138" });
    expect(await c.payoutTx(target("sui", "0x1f6cd55584e6d0c19ae34bfc48b1bd9b1b8a166987e34052cfea7f3c795c6d76"), tx)).toBeNull();
  });

  it("TON: the value credited to the destination wallet, even one never deployed (aborted, yet credited)", async () => {
    const ED8E = "ed8e8e601815e1545391b8b21dd6aba7071735a30b73a4d699ed1418e3c1f920";
    const D905 = "d9051a70497fd8b329fd1c4ccec2fb7f2b9733e8185c5f726c4d2279d6d621e8";
    const c = publicPayoutClient(at({ [`https://toncenter.com/api/v3/transactions?hash=${ED8E}`]: fx("ton-v3-ed8e.json"), [`https://toncenter.com/api/v3/transactions?hash=${D905}`]: fx("ton-v3-d905-uninit.json") }));
    expect(await c.payoutTx(target("ton", "UQBudjhhs3dPEQv75UcA1uGdt92-tuj-AP7x_YWH1ENDEACP"), ED8E)).toEqual({ tx: ED8E, amount: "486395366", timestampSec: 1_790_375_225, from: "0:0D11588CDC0290CE2E808F7B047B2A85BBCA57AA1CBD43DC46A0877FD2AA7708" });
    expect(await c.payoutTx(target("ton", "0:D0262DB1533A4948237552A0617BDB8C9D2FDB759261DD3A84E4EF3F75B40612"), D905)).toMatchObject({ amount: "53196189869" });
  });

  it("TON: tonapi when toncenter does not know the hash or refuses", async () => {
    const H = "657bc6285b3ffa3fa045166813dca24baddc2d2101b07b1576e517a31b8e3409";
    const c = publicPayoutClient(at({ [`https://toncenter.com/api/v3/transactions?hash=${H}`]: fx("ton-v3-not-found.json"), [`https://tonapi.io/v2/blockchain/transactions/${H}`]: fx("ton-tonapi-657b.json") }));
    expect(await c.payoutTx(target("ton", "0:35E07BD742D68EA279119C55B412D53D949AAC1803B3B28F09CF330D4F3FEC64"), H)).toEqual({ tx: H, amount: "678060479", timestampSec: 1_791_881_320, from: "0:0D11588CDC0290CE2E808F7B047B2A85BBCA57AA1CBD43DC46A0877FD2AA7708" });
  });

  it("Stellar: HOT's Soroban transfer to the destination, XLM or USDC, in stroops", async () => {
    const XLM = "8cabc84eca";
    const USDC = "fb2a6d5919";
    const ops = (h: string) => `https://horizon.stellar.org/transactions/${h}/operations?limit=200&join=transactions`;
    const xlmTx = (JSON.parse(fx("stellar-ops-xlm.json")) as { _embedded: { records: { transaction_hash: string }[] } })._embedded.records[0]!.transaction_hash;
    const usdcTx = (JSON.parse(fx("stellar-ops-usdc.json")) as { _embedded: { records: { transaction_hash: string }[] } })._embedded.records[0]!.transaction_hash;
    expect(xlmTx.startsWith(XLM) && usdcTx.startsWith(USDC)).toBe(true);
    const c = publicPayoutClient(at({ [ops(xlmTx)]: fx("stellar-ops-xlm.json"), [ops(usdcTx)]: fx("stellar-ops-usdc.json") }));
    expect(await c.payoutTx(target("stellar", "GBQWFPNY6ABL6IFPK43A4ORWNW76XTZLNDSJT54WNSVBNQFL6C7WBSMQ"), xlmTx)).toEqual({ tx: xlmTx, amount: "55162390", timestampSec: Date.parse("2026-09-29T22:09:42Z") / 1000, from: "CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG" });
    const usdc = { kind: "token" as const, contract: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" };
    expect(await c.payoutTx(target("stellar", "GC5VFZAIWBHRZZWCW6YEBBAZDIKLCOHTPB6AQ7YXDUAHENZ3V6FO7EYT", usdc), usdcTx)).toMatchObject({ amount: "16608561" });
    expect(await c.payoutTx(target("stellar", "GC5VFZAIWBHRZZWCW6YEBBAZDIKLCOHTPB6AQ7YXDUAHENZ3V6FO7EYT"), usdcTx)).toBeNull();
  });

  it("Cardano: the lovelace to the destination, from the Yoroi backend, else Koios or AdaStat (Worker-only)", async () => {
    const H = "d3582eccd3160f7b5ae63b5f6949718c60c117bbe16a6675b0a225ccb51a8792";
    const DEST = "addr1qymx87s6vhh0tjmayfyv72u6pk9j8v2ywwx66nxj7fc9f7l2ey7emprdayl88rmeaxc6g8d7wmzxakyzlqppy4hk9r8qv2f6ra";
    const want = { tx: H, amount: "525598251", timestampSec: 1_791_859_741, from: "addr1v8wfpcg4qfhmnzprzysj6j9c53u5j56j8rvhyjp08s53s6g07rfjm" };
    expect(await publicPayoutClient(at({ "https://api.yoroiwallet.com/api/v2/txs/get": fx("cardano-yoroi-d358.json") })).payoutTx(target("cardano", DEST), H)).toEqual(want);
    expect(await publicPayoutClient(at({ "https://api.yoroiwallet.com/api/v2/txs/get": "{}", "https://api.koios.rest/api/v1/tx_info": fx("cardano-koios-d358.json") })).payoutTx(target("cardano", DEST), H)).toEqual(want);
    expect(await publicPayoutClient(at({ "https://api.yoroiwallet.com/api/v2/txs/get": "{}", "https://api.koios.rest/api/v1/tx_info": "[]", [`https://api.adastat.net/rest/v1/transactions/${H}.json`]: fx("cardano-adastat-d358.json") })).payoutTx(target("cardano", DEST), H)).toEqual(want);
  });

  it("Aptos: the APT the destination's store received (Omni, fungible asset), or a legacy coin deposit (PoA, 2025)", async () => {
    const FA = "0xb4b44dc4e6d7979702bfcaff2d17c378ac5bfab901985fc5860c456bf6827caf";
    const LEGACY = "0xc06facd30fcbea76cd28ea4a2d0b3e27b6140addcc80d46f0c9be318b8c75044";
    const archive = (h: string) => `https://archive.mainnet.aptoslabs.com/v1/transactions/by_hash/${h}`;
    const c = publicPayoutClient(at({ [archive(FA)]: fx("aptos-archive-b4b4.json"), [archive(LEGACY)]: fx("aptos-archive-c06f-legacy.json") }));
    expect(await c.payoutTx(target("aptos", "0x7d1858e4915dcb7ec382edda0f40a47a2add06349a3feb3f68e50c4d53bea9c5"), FA)).toEqual({ tx: FA, amount: "6399381617", timestampSec: 1_791_881_216, from: "0xd8ccdb46922efc8b7fb8aa1eaffa02f0ec6d4d6efcd58b5097b4dc67655e9b49" });
    expect(await c.payoutTx(target("aptos", "0x4ba0566130ebbc479129a04ed655fc3f8a0f788ec5fadd9bd59fee32ca88cd61"), LEGACY)).toMatchObject({ amount: "1500000", from: "0xd1a1c1804e91ba85a569c7f018bb7502d2f13d4742d2611953c9c14681af6446" });
    expect(await c.payoutTx(target("aptos", "0x152a0b4cea" + "0".repeat(54)), FA)).toBeNull();
  });

  it("Starknet: the STRK Transfer events to the destination, with the block's time", async () => {
    const H = "0x13d7594bc9397277f9c90a2c9fde3c5432051ce2cd69f188dc403baa826f204";
    const c = publicPayoutClient(at({ "https://starknet-rpc.publicnode.com": (b) => (b.includes("starknet_getTransactionReceipt") ? fx("starknet-receipt-13d7.json") : b.includes("starknet_getBlockWithTxHashes") ? fx("starknet-block-13232841.json") : null) }));
    expect(await c.payoutTx(target("starknet", "0x075d0acbffd6fb765047dbdc07f6ea0d39f3bfd123717c9f136d9e97682834af"), H)).toEqual({ tx: H, amount: "894015761678920005797409", timestampSec: 1_786_630_877, from: "0x03b79b882cd0310822ebf3fe2be44a828f8939e699f8fd55a69cd70473f69090" });
  });

  it("HyperEVM: Omni's ONEAR mint to the destination, in NEAR base units (10^6 each), before it moves to HyperCore", async () => {
    const H = "0x95b923290c82f8d5f05f7d0060873210c54e4c6d7941f3c496a73fc430f7afad";
    const c = publicPayoutClient(at({ "https://rpc.hyperliquid.xyz/evm": (b) => (b.includes("eth_getTransactionReceipt") ? fx("hyper-receipt-95b9.json") : b.includes("eth_getBlockByNumber") ? fx("hyper-block-2e0ce21.json") : null) }));
    const t = target("hypercore", "0x8E3d5e109837c11DDd373d97c9B3E4D716F1423A", { kind: "token", contract: "0xc80d9eb120d6e40e31d5ae9040d5fc0753c52da7" }, { scale: 1_000_000n });
    expect(await c.payoutTx(t, H)).toEqual({ tx: H, amount: "23649998223801065521990000000", timestampSec: 1_791_752_343, from: "0x0000000000000000000000000000000000000000" });
  });
});
