// The payout hop: which destination to search, and how a list of incoming transfers there becomes a verdict.
import { describe, expect, it } from "vitest";

import { matchPayout, payoutTarget, treasuryOf, type IncomingPage, type PayoutTarget } from "./payout.js";
import type { PayoutHop, WithdrawHop } from "./trace.js";

const BURN_S = 1_791_010_018; // 2026-10-03 06:46:58 UTC
const NS = 1_000_000_000n;

function withdrawal(token: string, amount: string, destination: string | null, extra: Partial<WithdrawHop> = {}): WithdrawHop {
  return {
    status: "proven",
    tx: "W",
    timestampNs: BigInt(BURN_S) * NS,
    height: 1,
    intentHash: null,
    kind: "ft_withdraw",
    token,
    amount,
    chain: null,
    bridge: "poa",
    destination,
    externalId: null,
    ...extra,
  };
}

describe("payoutTarget", () => {
  it("native ETH, an ERC-20, TRON USDT, TRX, BTC over Omni and SOL become searchable targets", () => {
    expect(payoutTarget(withdrawal("nep141:eth.omft.near", "38192113227295700", "0xDc3D508De3312Bfc650AE9F72Ccaa009D036Fadc"))).toEqual({
      chain: "eth",
      address: "0xDc3D508De3312Bfc650AE9F72Ccaa009D036Fadc",
      asset: { kind: "native" },
      burned: 38192113227295700n,
      burnSec: BURN_S,
    });
    expect(payoutTarget(withdrawal("nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "1", "0xc9C14cE1dDAf56d5504565524B88D4677c25C595"))).toMatchObject({
      chain: "eth",
      asset: { kind: "token", contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    });
    expect(payoutTarget(withdrawal("nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", "1", "THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc"))).toMatchObject({ chain: "tron", asset: { kind: "token", contract: "d28a265909efecdcee7c5028585214ea0b96f015" } });
    expect(payoutTarget(withdrawal("nep141:tron.omft.near", "1", "THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc"))).toMatchObject({ chain: "tron", asset: { kind: "native" } });
    expect(payoutTarget(withdrawal("nep141:nbtc.bridge.near", "13870", "btc:bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz", { bridge: "omni" }))).toMatchObject({
      chain: "btc",
      address: "bc1qrqjc0gg6mn97x9d3m9gf9lwf3lmvctknqmflcz",
      asset: { kind: "native" },
    });
    expect(payoutTarget(withdrawal("nep141:sol.omft.near", "1", "sol:DunkcEZjri9EzKpHJqYxwFHwbJhdKxNoSUPdkbKD8XeS"))).toMatchObject({ chain: "sol", address: "DunkcEZjri9EzKpHJqYxwFHwbJhdKxNoSUPdkbKD8XeS", asset: { kind: "native" } });
  });

  it("names why a payout cannot be searched instead of guessing", () => {
    expect(payoutTarget(withdrawal("nep141:aleo.omft.near", "1", "aleo1dest"))).toEqual({ unsupported: "payouts on aleo are not searched yet" });
    expect(payoutTarget(withdrawal("nep141:eth.omft.near", "1", null))).toEqual({ unsupported: "the withdrawal names no destination" });
    expect(payoutTarget(withdrawal("nep141:eth.omft.near", "1", "TNotAnEvmAddress"))).toEqual({ unsupported: "the destination is not a valid Ethereum address" });
  });
});

describe("payoutTarget on the PoA bridge's Litecoin, Dogecoin, Bitcoin Cash, Dash and XRP (real destinations, 2024-2026)", () => {
  it("each chain's coin, at the address as the chain writes it", () => {
    expect(payoutTarget(withdrawal("nep141:ltc.omft.near", "20517656", "ltc1qwqy4xpyk0plpjs6qwh0883aklx0w3j26uey35g"))).toEqual({ chain: "ltc", address: "ltc1qwqy4xpyk0plpjs6qwh0883aklx0w3j26uey35g", asset: { kind: "native" }, burned: 20_517_656n, burnSec: BURN_S });
    expect(payoutTarget(withdrawal("nep141:ltc.omft.near", "7698", "LMo6G6famNBUCL3693jjtUiiw9rerMyTBX"))).toMatchObject({ chain: "ltc", address: "LMo6G6famNBUCL3693jjtUiiw9rerMyTBX" });
    expect(payoutTarget(withdrawal("nep141:doge.omft.near", "527381958", "D6qEXW9iszzzaPDi8hSTv9UFqLL4V2qCHn"))).toMatchObject({ chain: "doge", asset: { kind: "native" } });
    expect(payoutTarget(withdrawal("nep141:dash.omft.near", "102921875", "XxsmQTu8DThCSs7hCC2JigB8nf7aTPjWEj"))).toMatchObject({ chain: "dash", asset: { kind: "native" } });
  });

  it("a Bitcoin Cash or bech32 address is compared in lower case, without the bitcoincash: prefix", () => {
    expect(payoutTarget(withdrawal("nep141:bch.omft.near", "2644838", "bitcoincash:QZ8ZS4S480V82UDW6XDYHC8C6U2ZU4UUG5DT7TH92J"))).toMatchObject({ chain: "bch", address: "qz8zs4s480v82udw6xdyhc8c6u2zu4uug5dt7th92j" });
    expect(payoutTarget(withdrawal("nep141:ltc.omft.near", "1", "LTC1QWQY4XPYK0PLPJS6QWH0883AKLX0W3J26UEY35G"))).toMatchObject({ chain: "ltc", address: "ltc1qwqy4xpyk0plpjs6qwh0883aklx0w3j26uey35g" });
  });

  it("XRP: the address, and the destination tag the withdrawal memo carries", () => {
    expect(payoutTarget(withdrawal("nep141:xrp.omft.near", "1087372", "rs3GBtMc64SCz4XkgsEKx2a3a6CWFX3gga"))).toEqual({ chain: "xrp", address: "rs3GBtMc64SCz4XkgsEKx2a3a6CWFX3gga", asset: { kind: "native" }, burned: 1_087_372n, burnSec: BURN_S });
    expect(payoutTarget(withdrawal("nep141:xrp.omft.near", "100011", "rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV", { externalId: "419084126" }))).toMatchObject({ chain: "xrp", tag: "419084126" });
  });

  it("an address in another chain's format is not searched", () => {
    expect(payoutTarget(withdrawal("nep141:doge.omft.near", "1", "ltc1qwqy4xpyk0plpjs6qwh0883aklx0w3j26uey35g"))).toEqual({ unsupported: "the destination is not a valid Dogecoin address" });
    expect(payoutTarget(withdrawal("nep141:xrp.omft.near", "1", "XxsmQTu8DThCSs7hCC2JigB8nf7aTPjWEj"))).toEqual({ unsupported: "the destination is not a valid XRP Ledger address" });
  });
});

describe("payoutTarget on Sui, TON, Stellar, Cardano, Aptos, Starknet and HyperEVM (real destinations, 2025-2026)", () => {
  it("Sui, Aptos and Starknet addresses are 32-byte hex, compared padded and in lower case", () => {
    expect(payoutTarget(withdrawal("nep141:sui.omft.near", "50226791199", "0xE52497C434F1EA35B3E0D282691C927FB92D8B0785A7BD8000DA8AD9198E3BBA"))).toMatchObject({ chain: "sui", address: "0xe52497c434f1ea35b3e0d282691c927fb92d8b0785a7bd8000da8ad9198e3bba", asset: { kind: "native" } });
    expect(payoutTarget(withdrawal("nep141:aptos.omft.near", "6399381617", "aptos:0x7d1858e4915dcb7ec382edda0f40a47a2add06349a3feb3f68e50c4d53bea9c5", { bridge: "omni" }))).toMatchObject({ chain: "aptos", address: "0x7d1858e4915dcb7ec382edda0f40a47a2add06349a3feb3f68e50c4d53bea9c5" });
    expect(payoutTarget(withdrawal("nep141:starknet.omft.near", "1", "0x75d0acbffd6fb765047dbdc07f6ea0d39f3bfd123717c9f136d9e97682834af"))).toMatchObject({ chain: "starknet", address: "0x075d0acbffd6fb765047dbdc07f6ea0d39f3bfd123717c9f136d9e97682834af" });
  });

  it("HOT's native TON (an empty id) and its Stellar XLM and USDC; TON jettons are not read yet", () => {
    const hot = (id: string, chain: string, dest: string) => payoutTarget(withdrawal(`nep245:v2_1.omni.hot.tg:${id}`, "1", dest, { bridge: "hot", chain }));
    expect(hot("1117_", "ton", "UQBudjhhs3dPEQv75UcA1uGdt92-tuj-AP7x_YWH1ENDEACP")).toMatchObject({ chain: "ton", address: "UQBudjhhs3dPEQv75UcA1uGdt92-tuj-AP7x_YWH1ENDEACP", asset: { kind: "native" } });
    expect(hot("1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR", "ton", "UQBudjhhs3dPEQv75UcA1uGdt92-tuj-AP7x_YWH1ENDEACP")).toEqual({ unsupported: "the token v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR is not recognised on ton" });
    expect(hot("1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz", "stellar", "GBQWFPNY6ABL6IFPK43A4ORWNW76XTZLNDSJT54WNSVBNQFL6C7WBSMQ")).toMatchObject({ chain: "stellar", asset: { kind: "native" } });
    expect(hot("1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu", "stellar", "GC5VFZAIWBHRZZWCW6YEBBAZDIKLCOHTPB6AQ7YXDUAHENZ3V6FO7EYT")).toMatchObject({ asset: { kind: "token", contract: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" } });
  });

  it("Cardano: a Shelley address, ADA only", () => {
    expect(payoutTarget(withdrawal("nep141:cardano.omft.near", "525798251", "addr1qymx87s6vhh0tjmayfyv72u6pk9j8v2ywwx66nxj7fc9f7l2ey7emprdayl88rmeaxc6g8d7wmzxakyzlqppy4hk9r8qv2f6ra"))).toMatchObject({ chain: "cardano", asset: { kind: "native" } });
  });

  it("wrap.near through Omni to HyperEVM is the ONEAR token, 10^6 NEAR base units each", () => {
    expect(payoutTarget(withdrawal("nep141:wrap.near", "23649998223801065521990915086", "hlevm:0x8E3d5e109837c11DDd373d97c9B3E4D716F1423A", { bridge: "omni", chain: "hypercore" }))).toEqual({
      chain: "hypercore",
      address: "0x8E3d5e109837c11DDd373d97c9B3E4D716F1423A",
      asset: { kind: "token", contract: "0xc80d9eb120d6e40e31d5ae9040d5fc0753c52da7" },
      burned: 23_649_998_223_801_065_521_990_915_086n,
      burnSec: BURN_S,
      scale: 1_000_000n,
    });
  });

  it("tonRaw reads both forms of a TON address", async () => {
    const { tonRaw } = await import("./payout.js");
    expect(tonRaw("UQBudjhhs3dPEQv75UcA1uGdt92-tuj-AP7x_YWH1ENDEACP")).toBe("0:6E763861B3774F110BFBE54700D6E19DB7DDBEB6E8FE00FEF1FD8587D4434310");
    expect(tonRaw("0:6e763861b3774f110bfbe54700d6e19db7ddbeb6e8fe00fef1fd8587d4434310")).toBe("0:6E763861B3774F110BFBE54700D6E19DB7DDBEB6E8FE00FEF1FD8587D4434310");
    expect(tonRaw("not a ton address")).toBeNull();
  });
});

describe("payoutTarget on the HOT bridge and the other EVM chains NEAR Intents pays out on", () => {
  const DEST = "0x9c1ec8eea661d701e3f55d129968272582457f78";
  // A HOT token id is `<EVM chain id>_<the token contract in base58>`; 20 zero bytes ("1" x 20) is the chain's coin.
  it("a HOT token names its contract in base58: USDT on Polygon, USDC on BSC, USDT on Avalanche", () => {
    const hot = (id: string, chain: string) => payoutTarget(withdrawal(`nep245:v2_1.omni.hot.tg:${id}`, "2046950201", DEST, { bridge: "hot", chain }));
    expect(hot("137_3hpYoaLtt8MP1Z2GH1U473DMRKgr", "pol")).toEqual({ chain: "pol", address: DEST, asset: { kind: "token", contract: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" }, burned: 2046950201n, burnSec: BURN_S });
    expect(hot("56_2w93GqMcEmQFDru84j3HZZWt557r", "bsc")).toMatchObject({ chain: "bsc", asset: { kind: "token", contract: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" } });
    expect(hot("43114_372BeH7ENZieCaabwkbWkBiTTgXp", "avax")).toMatchObject({ chain: "avax", asset: { kind: "token", contract: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7" } });
  });

  it("a HOT id of twenty 1s is the chain's own coin: BNB, POL, MON", () => {
    for (const [id, chain] of [["56_11111111111111111111", "bsc"], ["137_11111111111111111111", "pol"], ["143_11111111111111111111", "monad"]] as const) {
      expect(payoutTarget(withdrawal(`nep245:v2_1.omni.hot.tg:${id}`, "1", DEST, { bridge: "hot", chain }))).toMatchObject({ chain, asset: { kind: "native" } });
    }
  });

  it("a HOT id that is not a 20-byte address is not guessed at", () => {
    expect(payoutTarget(withdrawal("nep245:v2_1.omni.hot.tg:137_3hpY", "1", DEST, { bridge: "hot", chain: "pol" }))).toEqual({ unsupported: "the token v2_1.omni.hot.tg:137_3hpY is not recognised on pol" });
  });

  it("PoA and Omni tokens on Robinhood Chain, Berachain, Plasma and Abstract", () => {
    expect(payoutTarget(withdrawal("nep141:hood.omft.near", "1", DEST))).toMatchObject({ chain: "hood", asset: { kind: "native" } });
    expect(payoutTarget(withdrawal("nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near", "1", DEST))).toMatchObject({ chain: "hood", asset: { kind: "token", contract: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } });
    expect(payoutTarget(withdrawal("nep141:bera.omft.near", "1", DEST))).toMatchObject({ chain: "bera", asset: { kind: "native" } });
    expect(payoutTarget(withdrawal("nep141:plasma.omft.near", "1", DEST))).toMatchObject({ chain: "plasma", asset: { kind: "native" } });
    expect(payoutTarget(withdrawal("nep141:abs.omdep.near", "1", DEST, { bridge: "omni" }))).toMatchObject({ chain: "abs", asset: { kind: "native" } });
  });

  it("a HOT Stellar token we do not know is not guessed at", () => {
    expect(payoutTarget(withdrawal("nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPA", "1", "GC5VFZAIWBHRZZWCW6YEBBAZDIKLCOHTPB6AQ7YXDUAHENZ3V6FO7EYT", { bridge: "hot", chain: "stellar" }))).toEqual({ unsupported: "the token v2_1.omni.hot.tg:1100_111bzQBB65GxAPA is not recognised on stellar" });
  });
});

const ETH: PayoutTarget = { chain: "eth", address: "0xDc3D508De3312Bfc650AE9F72Ccaa009D036Fadc", asset: { kind: "native" }, burned: 38192113227295700n, burnSec: BURN_S };
const base = { chain: "eth", bridge: "poa" as const, destination: ETH.address };
const page = (items: IncomingPage["items"], complete = true): IncomingPage => ({ items, complete });

describe("matchPayout", () => {
  it("one transfer inside the fee band after the burn is the payout, matched by amount and time", () => {
    const hop = matchPayout(ETH, page([{ tx: "0xd185", amount: "38157113227295700", timestampSec: BURN_S + 13 }]), BURN_S + 3_600, base);
    expect(hop).toEqual({ status: "arrived", how: "matched", ...base, tx: "0xd185", amount: "38157113227295700", delaySec: 13, confirmed: true, sender: null });
  });

  it("ignores dust and address-poisoning transfers, payments larger than the burn, and anything before it", () => {
    const hop = matchPayout(
      ETH,
      page([
        { tx: "dust", amount: "1", timestampSec: BURN_S + 5 },
        { tx: "bigger", amount: "38192113227295701", timestampSec: BURN_S + 5 },
        { tx: "before", amount: "38157113227295700", timestampSec: BURN_S - 600 },
      ]),
      BURN_S + 7_200,
      base,
    );
    expect(hop).toEqual({ status: "not_found", ...base, waitedSec: 7_200 });
  });

  it("two transfers that both fit are ambiguous, never a pick", () => {
    const hop = matchPayout(ETH, page([{ tx: "a", amount: "38157113227295700", timestampSec: BURN_S + 13 }, { tx: "b", amount: "38180000000000000", timestampSec: BURN_S + 40 }]), BURN_S + 3_600, base);
    expect(hop).toEqual({ status: "ambiguous", ...base, txs: ["a", "b"] });
  });

  it("nothing yet inside the usual payout time is waiting, not missing", () => {
    expect(matchPayout(ETH, page([]), BURN_S + 300, base)).toEqual({ status: "waiting", ...base, waitedSec: 300 });
  });

  it("nothing found in a history it could not read back to the burn is unverified, not missing", () => {
    expect(matchPayout(ETH, page([], false), BURN_S + 86_400, base)).toEqual({ status: "unverified", ...base, reason: "the destination has too many later transactions to search back to this withdrawal" });
  });

  it("a chain whose history is not searched at all says so, rather than blaming a busy destination", () => {
    const unsearched: IncomingPage = { items: [], complete: false, unsearched: "Polygon's history is not searched; only a payout transaction the bridge names is read" };
    expect(matchPayout(ETH, unsearched, BURN_S + 86_400, base)).toEqual({ status: "unverified", ...base, reason: "Polygon's history is not searched; only a payout transaction the bridge names is read" });
  });

  it("a payout still unconfirmed on the destination chain counts, marked unconfirmed", () => {
    const btc: PayoutTarget = { chain: "btc", address: "bc1q", asset: { kind: "native" }, burned: 13_870n, burnSec: BURN_S };
    const hop = matchPayout(btc, page([{ tx: "t", amount: "12414", timestampSec: null }]), BURN_S + 60, { chain: "btc", bridge: "omni", destination: "bc1q" });
    expect(hop).toMatchObject({ status: "arrived", tx: "t", delaySec: null, confirmed: false });
  });

  it("BTC allows the connector's bridge fee (400 sat) plus its gas cap (5,000 sat)", () => {
    const BTC: PayoutTarget = { chain: "btc", address: "bc1q", asset: { kind: "native" }, burned: 100_000n, burnSec: BURN_S };
    expect(matchPayout(BTC, page([{ tx: "p", amount: "94600", timestampSec: BURN_S + 600 }]), BURN_S + 3_600, base)).toMatchObject({ status: "arrived", tx: "p" });
    expect(matchPayout(BTC, page([{ tx: "p", amount: "94599", timestampSec: BURN_S + 600 }]), BURN_S + 7_200, base)).toMatchObject({ status: "not_found" });
  });

  it("uses each chain's fee band: TRON USDT up to 2.5 USDT, ERC-20 up to 10 tokens or 0.5 %", () => {
    const tron: PayoutTarget = { chain: "tron", address: "T", asset: { kind: "token", contract: "d28a" }, burned: 2_278_887n, burnSec: BURN_S };
    expect(matchPayout(tron, page([{ tx: "p", amount: "1409111", timestampSec: BURN_S + 12 }]), BURN_S + 60, { chain: "tron", bridge: "poa", destination: "T" })).toMatchObject({ status: "arrived", tx: "p" });
    const usdc: PayoutTarget = { chain: "eth", address: "0xc9", asset: { kind: "token", contract: "0xa0" }, burned: 352_566_113n, burnSec: BURN_S };
    expect(matchPayout(usdc, page([{ tx: "u", amount: "352266113", timestampSec: BURN_S + 300, decimals: 6 }]), BURN_S + 600, { chain: "eth", bridge: "poa", destination: "0xc9" })).toMatchObject({ status: "arrived", tx: "u" });
    expect(matchPayout(usdc, page([{ tx: "u", amount: "300000000", timestampSec: BURN_S + 300, decimals: 6 }]), BURN_S + 7_200, { chain: "eth", bridge: "poa", destination: "0xc9" })).toMatchObject({ status: "not_found" });
  });
});

describe("tokenRoute (regression)", () => {
  it("routes PoA tokens whose contract part has no 0x (TRON USDT, Solana SPL) to their chain, not to NEAR", async () => {
    const { tokenRoute } = await import("./trace.js");
    expect(tokenRoute("nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near")).toEqual({ chain: "tron", bridge: "poa" });
    // Solana sUSDC: still a PoA token (Solana USDT, used here before, moved to the Omni bridge in 2026-09).
    expect(tokenRoute("nep141:sol-2dc7b64e5dd3c717fc85abaf51cdcd4b18687f09.omft.near")).toEqual({ chain: "sol", bridge: "poa" });
  });
});

describe("payouts to NEAR accounts (proven from the withdrawal transaction)", () => {
  const ACCT = "b".repeat(64);
  const T0 = 1_790_000_000_000_000_000n;
  const ev = (executor: string, standard: string, event: string, data: Record<string, unknown>[], failed = false) => ({ standard, version: "1.0.0", event, data, executor, failed });
  const tx = (hash: string, height: number, events: ReturnType<typeof ev>[]) => ({
    hash, signer: "relayer.near", receiver: "intents.near", height, timestampNs: T0 + BigInt(height) * NS, actions: [], receiptActions: [], plainLogs: [], events,
  });
  const credit = tx("D", 1, [ev("intents.near", "nep245", "mt_mint", [{ owner_id: ACCT, token_ids: ["nep141:usdt.tether-token.near"], amounts: ["33018312"], memo: "deposit" }])]);
  const withdraw = (transferFailed: boolean) =>
    tx("W", 2, [
      ev("intents.near", "dip4", "ft_withdraw", [{ account_id: ACCT, token: "usdt.tether-token.near", receiver_id: "kurilchanin.tg", amount: "33018312" }]),
      ev("usdt.tether-token.near", "nep141", "ft_transfer", [{ old_owner_id: "intents.near", new_owner_id: "kurilchanin.tg", amount: "33018312" }], transferFailed),
    ]);

  it("an ft_transfer to the destination inside the withdrawal is the payout, proven", async () => {
    const { traceOrder } = await import("./trace.js");
    const r = traceOrder({ account: ACCT, txs: [credit, withdraw(false)], nowNs: T0 + 100n * NS });
    expect(r.payout).toEqual({ status: "arrived", how: "proven", chain: "near", bridge: "near", destination: "kurilchanin.tg", tx: "W", amount: "33018312", delaySec: 0, confirmed: true });
  });

  it("a failed transfer is not a payout", async () => {
    const { traceOrder } = await import("./trace.js");
    const r = traceOrder({ account: ACCT, txs: [credit, withdraw(true)], nowNs: T0 + 100n * NS });
    expect(r.payout).toMatchObject({ status: "unverified", reason: "no successful transfer to the destination in the withdrawal transaction" });
  });

  it("a wNEAR payout is proven by wrap.near's plain transfer log (wrap.near logs no NEP-297 event)", async () => {
    const { traceOrder } = await import("./trace.js");
    const wCredit = tx("D", 1, [ev("intents.near", "nep245", "mt_mint", [{ owner_id: ACCT, token_ids: ["nep141:wrap.near"], amounts: ["7"], memo: "deposit" }])]);
    const w = { ...tx("W", 2, [ev("intents.near", "dip4", "ft_withdraw", [{ account_id: ACCT, token: "wrap.near", receiver_id: "alice.near", amount: "7" }])]), plainLogs: [{ executor: "wrap.near", log: "Transfer 7 from intents.near to alice.near" }] };
    const r = traceOrder({ account: ACCT, txs: [wCredit, w], nowNs: T0 + 100n * NS });
    expect(r.payout).toEqual({ status: "arrived", how: "proven", chain: "near", bridge: "near", destination: "alice.near", tx: "W", amount: "7", delaySec: 0, confirmed: true });
  });

  it("wrap.near's transfer log from a receipt that failed is not a payout", async () => {
    const { traceOrder } = await import("./trace.js");
    const wCredit = tx("D", 1, [ev("intents.near", "nep245", "mt_mint", [{ owner_id: ACCT, token_ids: ["nep141:wrap.near"], amounts: ["7"], memo: "deposit" }])]);
    const w = { ...tx("W", 2, [ev("intents.near", "dip4", "ft_withdraw", [{ account_id: ACCT, token: "wrap.near", receiver_id: "alice.near", amount: "7" }])]), plainLogs: [{ executor: "wrap.near", log: "Transfer 7 from intents.near to alice.near", failed: true as const }] };
    const r = traceOrder({ account: ACCT, txs: [wCredit, w], nowNs: T0 + 100n * NS });
    expect(r.payout).toMatchObject({ status: "unverified", reason: "no successful transfer to the destination in the withdrawal transaction" });
  });

  it("native NEAR payouts are plain transfers with no event; says so instead of guessing", async () => {
    const { traceOrder } = await import("./trace.js");
    const nativeCredit = tx("D", 1, [ev("intents.near", "nep245", "mt_mint", [{ owner_id: ACCT, token_ids: ["nep141:wrap.near"], amounts: ["5"], memo: "deposit" }])]);
    const w = tx("W", 2, [ev("intents.near", "dip4", "native_withdraw", [{ account_id: ACCT, receiver_id: "alice.near", amount: "5" }])]);
    const r = traceOrder({ account: ACCT, txs: [nativeCredit, w], nowNs: T0 + 100n * NS });
    expect(r.payout).toMatchObject({ status: "unverified", reason: "native NEAR is paid by a plain transfer that logs no event; check the receiver on the explorer" });
  });
});

describe("treasuryOf on the PoA bridge's UTXO chains and XRP (the same page, read 2026-10-17)", () => {
  it("names the wallets every Litecoin, Dogecoin, Bitcoin Cash, Dash and XRP payout seen came from", () => {
    expect(treasuryOf("ltc", "LQjEMkuiA2pCwFeUPwsu6ktzUubBVLsahX")).toBe("NEAR Intents");
    expect(treasuryOf("doge", "DRmCnxzL9U11EJzLmWkm2ikaZikPFbLuQD")).toBe("NEAR Intents");
    expect(treasuryOf("bch", "qrdd5m5s72wzs4u373ux2fcpn02hw00u7v9wr8cex8")).toBe("NEAR Intents");
    expect(treasuryOf("dash", "XxA9DbXaFpF4GFY8KUNX7eAxhZPsWtcKhc")).toBe("NEAR Intents");
    expect(treasuryOf("xrp", "r9R8jciZBYGq32DxxQrBPi5ysZm67iQitH")).toBe("NEAR Intents");
    expect(treasuryOf("ltc", "LMo6G6famNBUCL3693jjtUiiw9rerMyTBX")).toBeNull();
  });
});

describe("treasuryOf (docs.near-intents.org/security-compliance/treasury-addresses, read 2026-10-11)", () => {
  it("names the published payout wallets on every EVM chain, TRON (both address forms), BTC and Solana", async () => {
    const { treasuryOf } = await import("./payout.js");
    expect(treasuryOf("eth", "0x2cff890f0378a11913b6129b2e97417a2c302680")).toBe("NEAR Intents");
    expect(treasuryOf("base", "0x2CfF890f0378a11913B6129B2E97417a2c302680")).toBe("NEAR Intents");
    expect(treasuryOf("arb", "0x233c5370CCfb3cD7409d9A3fb98ab94dE94Cb4Cd")).toBe("HOT Bridge");
    expect(treasuryOf("tron", "TX5XiRXdyz7sdFwF5mnhT1QoGCpbkncpke")).toBe("NEAR Intents");
    expect(treasuryOf("tron", "41e78cc21a0dfb6e840d52652224493b60d02ed628")).toBe("NEAR Intents");
    expect(treasuryOf("btc", "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra")).toBe("NEAR Intents");
    expect(treasuryOf("sol", "HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16")).toBe("NEAR Intents");
    expect(treasuryOf("eth", "0xbb2f33f73ccc2c74e3fb9bb8eb75241ac15337e0")).toBeNull(); // a refill wallet, not a payer
    expect(treasuryOf("tron", "0x2CfF890f0378a11913B6129B2E97417a2c302680")).toBeNull();
    expect(treasuryOf("eth", null)).toBeNull();
  });
});

describe("matchPayout: the sender", () => {
  const T = "0x2CfF890f0378a11913B6129B2E97417a2c302680";
  it("reports who sent the payout and whether it is a published treasury wallet", () => {
    const hop = matchPayout(ETH, page([{ tx: "0xd185", amount: "38157113227295700", timestampSec: BURN_S + 13, from: T }]), BURN_S + 3_600, base);
    expect(hop).toMatchObject({ status: "arrived", how: "matched", sender: { address: T, treasury: "NEAR Intents" } });
    const other = matchPayout(ETH, page([{ tx: "0xd185", amount: "38157113227295700", timestampSec: BURN_S + 13, from: "0xabc" }]), BURN_S + 3_600, base);
    expect(other).toMatchObject({ status: "arrived", sender: { address: "0xabc", treasury: null } });
  });

  it("on the PoA bridge, two transfers that fit are told apart by the treasury sender", () => {
    const hop = matchPayout(
      ETH,
      page([
        { tx: "a", amount: "38157113227295700", timestampSec: BURN_S + 13, from: "0xsomeone" },
        { tx: "b", amount: "38180000000000000", timestampSec: BURN_S + 40, from: T },
      ]),
      BURN_S + 3_600,
      base,
    );
    expect(hop).toMatchObject({ status: "arrived", tx: "b", sender: { treasury: "NEAR Intents" } });
  });

  it("other bridges keep both: their payers are not on the list", () => {
    const omni = { ...base, bridge: "omni" as const };
    const hop = matchPayout(ETH, page([{ tx: "a", amount: "38157113227295700", timestampSec: BURN_S + 13, from: "0xsomeone" }, { tx: "b", amount: "38180000000000000", timestampSec: BURN_S + 40, from: T }]), BURN_S + 3_600, omni);
    expect(hop).toMatchObject({ status: "ambiguous", txs: ["a", "b"] });
  });
});

describe("matchPayout: the PoA bridge's own withdrawal report", () => {
  const T = "0x2CfF890f0378a11913B6129B2E97417a2c302680";
  const paid = { tx: "0xd185", amount: "38157113227295700", timestampSec: BURN_S + 13, from: T };

  it("the bridge naming the transfer we found on chain makes it confirmed", () => {
    const hop = matchPayout(ETH, page([paid]), BURN_S + 3_600, base, { status: "COMPLETED", tx: "0xD185" });
    expect(hop).toMatchObject({ status: "arrived", how: "confirmed", tx: "0xd185", bridgeReport: { status: "COMPLETED", tx: "0xD185" } });
  });

  it("settles an ambiguous pair: the one the bridge names, if it is on chain into the destination", () => {
    const hop = matchPayout(ETH, page([{ ...paid, tx: "a", from: "0x1" }, { ...paid, tx: "b", from: "0x2" }]), BURN_S + 3_600, base, { status: "COMPLETED", tx: "b" });
    expect(hop).toMatchObject({ status: "arrived", how: "confirmed", tx: "b" });
  });

  it("a named transfer we cannot see on chain confirms nothing; the report is kept for the reader", () => {
    const hop = matchPayout(ETH, page([]), BURN_S + 7_200, base, { status: "COMPLETED", tx: "0xelsewhere" });
    expect(hop).toMatchObject({ status: "not_found", bridgeReport: { status: "COMPLETED", tx: "0xelsewhere" } });
  });

  it("a pending or failed report is carried as is", () => {
    expect(matchPayout(ETH, page([]), BURN_S + 300, base, { status: "PENDING", tx: null })).toMatchObject({ status: "waiting", bridgeReport: { status: "PENDING", tx: null } });
  });
});

describe("payoutEvidence: the sentences every renderer shows under the payout", () => {
  const T = "0x2CfF890f0378a11913B6129B2E97417a2c302680";
  const arrived = (how: "confirmed" | "matched", extra: object = {}) =>
    ({ status: "arrived", how, ...base, tx: "0xd185", amount: "1", delaySec: 13, confirmed: true, ...extra }) as const;

  it("confirmed: the bridge names this transfer; said as its word, not an on-chain link", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence(arrived("confirmed", { sender: { address: T, treasury: "NEAR Intents" }, bridgeReport: { status: "COMPLETED", tx: "0xd185" } }))).toEqual([
      "Confirmed by the bridge: the PoA bridge's status API names this transfer as the payout of this withdrawal, and it is on chain into the destination. That is the operator's report checked against the chain, not an on-chain link.",
      `Sent from ${T}, NEAR Intents' published treasury wallet.`,
    ]);
  });

  it("matched on the PoA bridge, with an unlisted sender", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence(arrived("matched", { sender: { address: "0xabc", treasury: null } }))).toEqual([
      "Matched, not proven: the only transfer into the destination that fits the withdrawn amount (less the bridge fee) and time. The PoA bridge pays from a custodial wallet and writes nothing on chain that names this withdrawal.",
      "Sent from 0xabc, which is not on NEAR Intents' published treasury list.",
    ]);
  });

  it("a bridge report that disagrees with the chain is shown, not hidden", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence({ status: "not_found", ...base, waitedSec: 7_200, bridgeReport: { status: "COMPLETED", tx: "0xelsewhere" } })).toEqual([
      "The PoA bridge's status API says it sent 0xelsewhere, which was not found among transfers into the destination.",
    ]);
    expect(payoutEvidence({ status: "waiting", ...base, waitedSec: 60, bridgeReport: { status: "PENDING", tx: null } })).toEqual(["The PoA bridge's status API reports this withdrawal as PENDING."]);
  });
});

describe("the Omni bridge's indexer as the bridge's word", () => {
  const ZEC_TX = "064ff3c012168e5a07d797395cc43b1770cc8167cc1ff4ab163871870ecfb6a4";
  const omni = { chain: "zec", bridge: "omni" as const, destination: "zcash:u1jfupn9" };

  it("names the payout on a chain we do not search: shown as the indexer's report, nothing more", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence({ status: "unverified", ...omni, reason: "payouts on zec are not searched yet", bridgeReport: { source: "omni", status: "Settled", tx: ZEC_TX } })).toEqual([
      `The Omni bridge's indexer reports this transfer as Settled, paid out in ${ZEC_TX}.`,
    ]);
  });

  it("the transfer it names, found on chain into the destination, is confirmed, and said to be the indexer's word", async () => {
    const { payoutEvidence } = await import("./payout.js");
    const sol = { ...omni, chain: "sol", destination: "sol:Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5" };
    const t: PayoutTarget = { chain: "sol", address: "Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5", asset: { kind: "native" }, burned: 384_642_580n, burnSec: BURN_S };
    const hop = matchPayout(t, page([{ tx: "3Pho1", amount: "384642580", timestampSec: BURN_S + 30 }]), BURN_S + 600, sol, { source: "omni", status: "Settled", tx: "3Pho1" });
    expect(hop).toMatchObject({ status: "arrived", how: "confirmed", tx: "3Pho1", bridgeReport: { source: "omni" } });
    expect(payoutEvidence(hop)[0]).toBe(
      "Confirmed by the bridge: the Omni bridge's indexer names this transfer as the payout of this withdrawal, and it is on chain into the destination. That is the indexer's report checked against the chain, not an on-chain link.",
    );
  });

  it("a payout it names that we did not find among the transfers we read is said so", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence({ status: "not_found", ...omni, waitedSec: 7_200, bridgeReport: { source: "omni", status: "Settled", tx: ZEC_TX } })).toEqual([
      `The Omni bridge's indexer reports this transfer as Settled, paid out in ${ZEC_TX}, which was not found among the transfers into the destination that we read.`,
    ]);
  });
});

describe("payoutEvidence: who paid an Omni payout (docs.near.org /chain-abstraction/omnibridge/implementation)", () => {
  // Omni pays through its bridge (the Bridge Token Factory mints, or the bridge unlocks) and permissionless relayers that
  // deliver what NEAR's MPC network signed; a Fast Transfer relayer pays early "from their own funds". Never from NEAR
  // Intents' treasury wallets, so "not on the treasury list" would read like a warning for nothing.
  const NO_TREASURY = "Omni pays through its bridge and relayers, never from NEAR Intents' treasury wallets";
  const omniPaid = (chain: string, from: string, how: "confirmed" | "matched" = "confirmed"): PayoutHop => ({
    status: "arrived",
    how,
    chain,
    bridge: "omni",
    destination: "d",
    tx: "T",
    amount: "1",
    delaySec: 30,
    confirmed: true,
    sender: { address: from, treasury: null },
    ...(how === "confirmed" ? { bridgeReport: { source: "omni" as const, status: "Settled", tx: "T" } } : {}),
  });

  it("Solana: the fee payer of the bridge program's transfer is the relayer that delivered it (order 4f2fd107…, 3Pho1…)", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence(omniPaid("sol", "DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn"))[1]).toBe(`Submitted by DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn, the relayer that delivered it. ${NO_TREASURY}.`);
  });

  it("EVM: a token the bridge minted comes from the zero address", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence(omniPaid("base", "0x0000000000000000000000000000000000000000"))[1]).toBe(`Minted by the Omni bridge's token contract (it comes from the zero address). ${NO_TREASURY}.`);
  });

  it("EVM: any other sender is the bridge unlocking it, or a relayer that paid early from its own funds", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence(omniPaid("arb", "0xd025b38762b4a4e36f0cde483b86cb13ea00d989"))[1]).toBe(
      `Sent from 0xd025b38762b4a4e36f0cde483b86cb13ea00d989: the Omni bridge unlocking it, or a relayer that paid you early from its own funds (a Fast Transfer). ${NO_TREASURY}.`,
    );
  });

  it("Bitcoin: an address the bridge spends from, in a transaction NEAR's MPC network signed", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence(omniPaid("btc", "bc1qexample"))[1]).toBe(`Sent from bc1qexample, an address the Omni bridge spends from, in a transaction NEAR's MPC network signed. ${NO_TREASURY}.`);
  });

  it("a payout only matched by amount and time gets the plain sentence: it may not be the bridge's at all", async () => {
    const { payoutEvidence } = await import("./payout.js");
    expect(payoutEvidence(omniPaid("sol", "DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn", "matched"))[1]).toBe(`Sent from DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn. ${NO_TREASURY}, so their list does not apply.`);
  });

  it("no Omni payout says it is missing from the treasury list", async () => {
    const { payoutEvidence } = await import("./payout.js");
    for (const chain of ["sol", "eth", "btc"]) for (const how of ["confirmed", "matched"] as const) expect(payoutEvidence(omniPaid(chain, "x", how)).join(" ")).not.toContain("not on NEAR Intents' published treasury list");
  });
});

describe("matchPayout: an Omni Fast Transfer", () => {
  // A relayer pays the user early "from their own funds"; the bridge later repays the relayer
  // (docs.near.org /chain-abstraction/omnibridge/implementation). The transfer on chain into the destination decides.
  const sol = { chain: "sol", bridge: "omni" as const, destination: "sol:Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5" };
  const t: PayoutTarget = { chain: "sol", address: "Eoxmf8M5nXCU9hDvz5qkjKasjqeSgUx16kv9VQko1Fs5", asset: { kind: "native" }, burned: 384_642_580n, burnSec: BURN_S };
  const report = { source: "omni" as const, status: "Settled", tx: "Repays", fastTx: "Fast" };

  it("the fast transaction, on chain into the destination, is the payout, and the evidence says a relayer paid early", async () => {
    const { payoutEvidence } = await import("./payout.js");
    const hop = matchPayout(t, page([{ tx: "Fast", amount: "384642580", timestampSec: BURN_S + 9 }]), BURN_S + 600, sol, report);
    expect(hop).toMatchObject({ status: "arrived", how: "confirmed", tx: "Fast" });
    expect(payoutEvidence(hop)).toContain("A relayer paid you early from its own funds (an Omni Fast Transfer); the bridge repays the relayer later, in Repays.");
  });

  it("when only the bridge's finalisation pays the destination, that one is the payout, as before", () => {
    const hop = matchPayout(t, page([{ tx: "Repays", amount: "384642580", timestampSec: BURN_S + 30 }]), BURN_S + 600, sol, report);
    expect(hop).toMatchObject({ status: "arrived", how: "confirmed", tx: "Repays" });
  });
});

describe("payoutEvidence: a payout into a Zcash shielded pool", () => {
  it("says what the chain shows and what the shielded output hides", async () => {
    const { payoutEvidence } = await import("./payout.js");
    const hop = { status: "arrived", how: "shielded", chain: "zec", bridge: "omni", destination: "zcash:u1jfupn9", tx: "064ff3c0", amount: "55133859", delaySec: 93, confirmed: true, shieldedPool: "Ironwood", bridgeReport: { source: "omni", status: "Settled", tx: "064ff3c0" } } as const;
    expect(payoutEvidence(hop)).toEqual([
      "Paid into Zcash's Ironwood shielded pool: the transaction the bridge names is confirmed on the Zcash chain and moved the withdrawal, less the bridge's and the network's fees, into that pool. A shielded output hides its recipient by design, so the destination address cannot be read from the chain.",
      "The Omni bridge's indexer reports this transfer as Settled, paid out in 064ff3c0.",
    ]);
  });
});
