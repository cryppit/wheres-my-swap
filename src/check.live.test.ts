// Against the real FastNEAR Transactions API (keyless, read-only). On demand: npm run test:live
import { describe, expect, it } from "vitest";

import { checkOrder, fastnearClient } from "./check.js";

const ACCOUNT_358 = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
const ACCOUNT_6B = "26b9cc669c90eae37285e4c52c35e0fc814314b2a6566250329a8ad497acb5fb";
const now = () => BigInt(Date.now()) * 1_000_000n;

describe("live: near/intents #358", () => {
  it("is settled, 16 days late, from the account", async () => {
    const r = await checkOrder(ACCOUNT_358, fastnearClient(), now());
    expect(r.verdict).toBe("settled");
    expect(r.flags.map((f) => f.kind)).toEqual(["settled_late"]);
    expect(r.withdrawals[0]?.destination).toBe("0x632F5D32448DE43b8b9cfD063aCfcDac09108bad");
  });
  it("resolves the same order from its swap transaction", async () => {
    const r = await checkOrder("E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB", fastnearClient(), now());
    expect(r.account).toBe(ACCOUNT_358);
  });
});

describe("live: one-click-sdk #6 order 2", () => {
  it("is still stuck with 48.28 ETH in the account", async () => {
    const r = await checkOrder(ACCOUNT_6B, fastnearClient(), now());
    expect(r.verdict).toBe("stuck");
    expect(r.balances).toEqual({ "nep141:eth.omft.near": "48280000000000000000" });
  });
});

describe("live: payouts on the destination chain (G1 orders with known payouts)", () => {
  it("finds the USDC payout on Ethereum for G1 order c0a6…4705, confirmed by the PoA bridge, from the treasury", async () => {
    const { publicPayoutClient } = await import("./payouts.js");
    const r = await checkOrder("c0a6883bef5e458bcbfca908e7fa0f92bb44032ae2e7e91c7a6db1e90c4d4705", fastnearClient(), now(), undefined, publicPayoutClient());
    expect(r.payout).toMatchObject({ status: "arrived", how: "confirmed", tx: "0x7796d58994c96486b7ae34df180141d2ec85d8c05361645d61253209cf16ac0a", sender: { treasury: "NEAR Intents" } });
  });
  it("#358: the bridge names the 190,995 USDT payout our search found", async () => {
    const { publicPayoutClient } = await import("./payouts.js");
    const r = await checkOrder(ACCOUNT_358, fastnearClient(), now(), undefined, publicPayoutClient());
    expect(r.payout).toMatchObject({ status: "arrived", how: "confirmed", tx: "0x9be9c2f8ed78d32ecf222bca3595d50cc42aed979030e4ebf0f84a626e13421a", delaySec: 19, sender: { treasury: "NEAR Intents" } });
  });
  it("finds the native ETH payout for G1 order e065…8774", async () => {
    const { publicPayoutClient } = await import("./payouts.js");
    const r = await checkOrder("e0653f82c0aec9e5131b9c5fb7ed63c106abab1e021e364aae429310a6a38774", fastnearClient(), now(), undefined, publicPayoutClient());
    expect(r.payout).toMatchObject({ status: "arrived", tx: "0xd185c1ecfb1ca4c40f6afb3059130fedc3970341eea17c633ad57981dfb2e992" });
  });
  it("finds the TRON USDT payout for G1 order b9aa…b40c", async () => {
    const { publicPayoutClient } = await import("./payouts.js");
    const r = await checkOrder("b9aa827af88d69486978460e408be66b7a58475f98f53067f6a4d360c855b40c", fastnearClient(), now(), undefined, publicPayoutClient());
    expect(r.payout).toMatchObject({ status: "arrived", tx: "658fe927eeb55d668abef63cb71333413d2633166b08ed2fb0c0153da986193d" });
  });
  it("finds the BTC payout for G1 order da5d…b0e0", async () => {
    const { publicPayoutClient } = await import("./payouts.js");
    const r = await checkOrder("da5da6f146098ce7c525acc1bd48764d8b5924509d75c7767d78353d1ff7b0e0", fastnearClient(), now(), undefined, publicPayoutClient());
    expect(r.payout).toMatchObject({ status: "arrived", tx: "519166fb0d3edde399ec6474bfbdbc8e88a1ab93b7bf16c2ab19bd8664b3348b" });
  });
  it("finds the SOL payout for G1 order 9f9f…cdd2", async () => {
    const { publicPayoutClient } = await import("./payouts.js");
    const r = await checkOrder("9f9fe3b73115574b80a5e76e155cbc40aa44c61cef7aeeb71f86830f4ecadcd2", fastnearClient(), now(), undefined, publicPayoutClient());
    expect(r.payout).toMatchObject({ status: "arrived", tx: "mYLrwEbJZMz2BMAWpTSV2AY5sRu9NvtFN5VHWyzPpuViqg3Ndu6Qc7d75AUjxLtZBgw3x6ubLzz4mC5bD1uvjf1" });
  });
});

describe("live: search by the user's own transaction", () => {
  it("#358: the TRON deposit transaction finds the order", async () => {
    const { publicOriginClient } = await import("./origin.js");
    const r = await checkOrder("d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67", fastnearClient(), now(), undefined, undefined, publicOriginClient());
    expect(r.account).toBe(ACCOUNT_358);
    expect(r.resolvedVia).toBe("origin");
    expect(r.foundBy).toMatchObject({ chain: "tron", depositTx: "8a33DkKfZMWRKbK2pXuQAWVLXSy4AyZF6PfcENvCJgCb" });
  });
  it("G1 USDC order: the Ethereum deposit transaction finds it", async () => {
    const { publicOriginClient } = await import("./origin.js");
    const r = await checkOrder("0x5b523e971f8a79ce81330f46755b050df31156b11cc37afd6bc02719f73066b1", fastnearClient(), now(), undefined, undefined, publicOriginClient());
    expect(r.account).toBe("e8ef57575c3960010b99d766ac7dc0682e65d49bbf1dcf49c29a9244cedb3cc2");
    expect(r.foundBy).toMatchObject({ chain: "eth", depositTx: "33yRzuL5QqbYA9KzpJchFrX6DYD1dAA8F7oJERrh6E3o" });
  });
  it("G1 TRON USDT order: the TRON transaction finds it", async () => {
    const { publicOriginClient } = await import("./origin.js");
    const r = await checkOrder("d98b7b8a3c9a153c91a4f324d3c3d37206f1ecfff016bd691311876bfdc3e57d", fastnearClient(), now(), undefined, undefined, publicOriginClient());
    expect(r.account).toBe("1ce93ab5772865b6e1a9231450feccdc8fdc83a51d4933c6a446bb1d9e54d74b");
  });
});

