// The live order feed's pure part: what one block did to NEAR Intents orders, read from intents.near's own events, and
// which orders belong to a watched integrator. Blocks recorded from Neardata (intents.near's shard plus the headers).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeBlockOutcomes, type NeardataBlock } from "./decode.js";
import { orderActivity, watchedOrders } from "./feed.js";

function block(name: string): NeardataBlock {
  const f = JSON.parse(readFileSync(new URL(`../fixtures/feed/${name}`, import.meta.url), "utf8")) as { shard: NeardataBlock["shards"][number]; headers: { header: NeardataBlock["block"]["header"] } };
  return { block: { header: f.headers.header }, shards: [f.shard] };
}

// The Base USDC → Solana SOL order traced in the walkthrough (16 Oct 2026).
const ORDER = "b2742348a01afe9fa523d186b362008fceab464038f753cd56b25cf6e001f201";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL = "nep141:sol.omft.near";
const SWAP_TX = "6XHLEjtnuKCJSh1CHd9igoarvnXagQzynoGjcneFRDRy";
const FEE_A = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
const FEE_B = "609214950ce11a0c38e0d562c8575285fc29770a86cd16259831ab009b1392c6";

describe("orderActivity: what a block did to NEAR Intents orders, from intents.near's own events", () => {
  it("a bridge deposit (mt_mint, memo deposit) credits the order account", () => {
    expect(orderActivity(decodeBlockOutcomes(block("block-220187714-deposit.json")))).toEqual([
      { account: ORDER, kind: "deposit", tx: "JCJPh8DgV7oNbyonEUjaAj7iNxtQ1mKgwB4pFmrTQrgw", height: 220_187_714, timestampNs: 1_792_132_642_767_325_864n, tokens: { [USDC_BASE]: "5830000" } },
    ]);
  });

  it("a swap: the order's own token diff and referral, its fee transfers, and the withdrawal with its destination", () => {
    const at = { tx: SWAP_TX, height: 220_187_721, timestampNs: 1_792_132_646_983_732_586n };
    const mine = orderActivity(decodeBlockOutcomes(block("block-220187721-swap.json"))).filter((a) => a.account === ORDER);
    expect(mine).toEqual([
      { account: ORDER, kind: "transfer_in", ...at, tokens: { "nep141:wrap.near": "1919385796556591970720" }, counterparty: "824ffeb7b8a5c11a96845503894731aa87bad638c186f91e8f730a0552e7d4c4" },
      { account: ORDER, kind: "swap", ...at, tokens: { [USDC_BASE]: "-5808357", [SOL]: "54730351" }, referral: "1click-unknown" },
      { account: ORDER, kind: "transfer_out", ...at, tokens: { [SOL]: "3761" }, counterparty: "143f2bb439575c286f4f585163f0e5fb4e464f8ce57ec06ae80741407d3cfb31" },
      { account: ORDER, kind: "transfer_out", ...at, tokens: { [USDC_BASE]: "11660" }, counterparty: FEE_A },
      { account: ORDER, kind: "transfer_out", ...at, tokens: { [USDC_BASE]: "9983" }, counterparty: FEE_B },
      { account: ORDER, kind: "withdraw", ...at, tokens: { [SOL]: "54726590" }, counterparty: "omni.bridge.near", destination: "sol:8NHdvTcHvpz2ihQ74A69sHyafxkqp168htpSy2Y3h7sg" },
    ]);
  });

  it("the solver's side and the fee accounts' side are activity too, each under its own account", () => {
    const all = orderActivity(decodeBlockOutcomes(block("block-220187721-swap.json")));
    expect(all.find((a) => a.account === "blockzen-1-main.near")).toMatchObject({ kind: "swap", tokens: { [USDC_BASE]: "5808351", [SOL]: "-54730406" } });
    expect(all.find((a) => a.account === FEE_B)).toMatchObject({ kind: "transfer_in", counterparty: ORDER, tokens: { [USDC_BASE]: "9983" } });
  });

  it("ignores everything outside intents.near and every failed receipt", () => {
    const b = block("block-220187721-swap.json");
    const failed = structuredClone(b);
    for (const o of failed.shards[0]?.receipt_execution_outcomes ?? []) o.execution_outcome.outcome.status = { Failure: { ActionError: {} } };
    expect(orderActivity(decodeBlockOutcomes(failed))).toEqual([]);
  });
});

describe("watchedOrders: an integrator's orders, without anyone pasting them", () => {
  const acts = orderActivity(decodeBlockOutcomes(block("block-220187721-swap.json")));

  it("by the fee account it registered: the orders that pay it in the same transaction", () => {
    expect(watchedOrders(acts, { feeAccounts: [FEE_B] })).toEqual([ORDER]);
    expect(watchedOrders(acts, { feeAccounts: [FEE_A] })).toEqual([ORDER]);
  });

  it("or by its referral tag", () => {
    expect(watchedOrders(acts, { referrals: ["1click-unknown"] })).toEqual([ORDER]);
  });

  it("nothing for an integrator that is not in the block", () => {
    expect(watchedOrders(acts, { feeAccounts: ["someone-else.near"], referrals: ["another-app"] })).toEqual([]);
  });
});
