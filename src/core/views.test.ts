// NEAR RPC view calls as request bodies and answer parsers. Answers recorded from rpc.intea.rs on 2026-10-14.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { accountExistsFrom, balanceCheck, balancesFrom, canCreate, claimableName, compareBalances, intentsView, tokenIdsFrom, viewAccount, viewResult } from "./views.js";

const answer = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/rpc/${name}`, import.meta.url), "utf8"));

describe("view_account", () => {
  it("asks for the account at a final block", () => {
    expect(viewAccount("hideon.near")).toEqual({ jsonrpc: "2.0", id: "wms", method: "query", params: { request_type: "view_account", finality: "final", account_id: "hideon.near" } });
  });

  it("an account the chain shows exists (hideon.near)", () => {
    expect(accountExistsFrom(answer("view-account-exists.json"))).toBe(true);
  });

  it("UNKNOWN_ACCOUNT means nobody has created it (nobody-made-this.near)", () => {
    expect(accountExistsFrom(answer("view-account-missing.json"))).toBe(false);
  });

  it("any other answer says neither", () => {
    expect(accountExistsFrom({ jsonrpc: "2.0", id: "wms", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } })).toBeNull();
    expect(accountExistsFrom("<html>")).toBeNull();
  });
});

describe("canCreate: who can create a named account (docs.near.org /protocol/accounts-contracts/account-id)", () => {
  it("anyone can create a .near name through near's create_account", () => {
    expect(canCreate("hideon.near")).toEqual({ anyone: true });
  });
  it("only the parent can create a sub-account, only the registrar a short top-level name", () => {
    expect(canCreate("pay.alice.near")).toEqual({ by: "alice.near" });
    expect(canCreate("kurilchanin.tg")).toEqual({ by: "tg" });
    expect(canCreate("sweat")).toEqual({ by: "registrar" });
  });
  it("a top-level name of 32 characters or more can be created by anyone (nearcore min_allowed_top_level_account_length)", () => {
    expect(canCreate("a-very-long-top-level-account-name")).toEqual({ anyone: true });
  });
});

describe("claimableName: names whoever creates them controls", () => {
  it("named accounts are; implicit, 0x, 0s and 0u accounts belong to their key or code, created or not", () => {
    expect(claimableName("hideon.near")).toBe(true);
    expect(claimableName("kurilchanin.tg")).toBe(true);
    expect(claimableName("74cb2f079f8da84087f715ae45592741028171f0997154a024508743d97e8ead")).toBe(false);
    expect(claimableName("0xb0198a21bead20023a36fb4ee71591074b89d8b4")).toBe(false);
    expect(claimableName(`0s${"ab12".repeat(10)}`)).toBe(false);
    expect(claimableName("Not An Account")).toBe(false);
  });
});

describe("intents.near's own balances (NEP-245 mt_tokens_for_owner, mt_batch_balance_of)", () => {
  const SOL_USDT = "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
  const BLOCK = "8LvS9PHrRdffJp2SosWPUDXLH7pcmgEw4EwkewG74xo2";

  it("a view on intents.near at a final block, or pinned to one block", () => {
    const fresh = intentsView("mt_tokens_for_owner", { account_id: "a", limit: 100 });
    expect(fresh).toMatchObject({ jsonrpc: "2.0", method: "query", params: { request_type: "call_function", finality: "final", account_id: "intents.near", method_name: "mt_tokens_for_owner" } });
    expect(JSON.parse(atob(fresh.params.args_base64))).toEqual({ account_id: "a", limit: 100 });
    const pinned = intentsView("mt_batch_balance_of", { account_id: "a", token_ids: [SOL_USDT] }, BLOCK);
    expect(pinned.params).toMatchObject({ block_id: BLOCK, method_name: "mt_batch_balance_of" });
    expect(pinned.params).not.toHaveProperty("finality");
  });

  it("reads the value and the block of recorded answers (order 38f7db08…, 2026-10-14)", () => {
    const tokens = viewResult(answer("mt-tokens-38f7db08.json"));
    expect(tokens).toEqual({ value: [{ token_id: SOL_USDT }], blockHeight: 219_921_623, blockHash: BLOCK });
    expect(tokenIdsFrom(tokens?.value)).toEqual([SOL_USDT]);
    expect(balancesFrom([SOL_USDT], viewResult(answer("mt-balances-38f7db08.json"))?.value)).toEqual({ [SOL_USDT]: "1300" });
    expect(tokenIdsFrom(viewResult(answer("mt-tokens-373dde4d.json"))?.value)).toEqual([]);
  });

  it("drops zero balances; anything malformed is null", () => {
    expect(balancesFrom(["a", "b"], ["0", "5"])).toEqual({ b: "5" });
    expect(balancesFrom(["a"], ["x"])).toBeNull();
    expect(balancesFrom(["a", "b"], ["1"])).toBeNull();
    expect(tokenIdsFrom([{ nope: 1 }])).toBeNull();
    expect(viewResult(answer("view-account-missing.json"))).toBeNull();
  });

  it("compares the ledger with the chain, token by token", () => {
    expect(compareBalances({ a: "1" }, { a: "1" })).toEqual([]);
    expect(compareBalances({ a: "1" }, { a: "2", b: "3" })).toEqual([
      { token: "a", ledger: "1", chain: "2" },
      { token: "b", ledger: "0", chain: "3" },
    ]);
    expect(compareBalances({ a: "1" }, {})).toEqual([{ token: "a", ledger: "1", chain: "0" }]);
  });

  it("the same: verified at that block; different: a flag with the chain's numbers; no answer: not verified", () => {
    const chain = (balances: Record<string, string>) => ({ blockHeight: 219_921_623, blockHash: BLOCK, balances });
    expect(balanceCheck({ [SOL_USDT]: "1300" }, chain({ [SOL_USDT]: "1300" }))).toEqual({ check: { status: "verified", blockHeight: 219_921_623, blockHash: BLOCK } });
    expect(balanceCheck({ [SOL_USDT]: "1300" }, chain({ [SOL_USDT]: "104724" }))).toEqual({
      check: { status: "differs", blockHeight: 219_921_623, blockHash: BLOCK, differences: [{ token: SOL_USDT, ledger: "1300", chain: "104724" }] },
      flag: {
        kind: "ledger_mismatch",
        detail: `intents.near holds 104724 ${SOL_USDT} for this account at block 219,921,623, where the history we read adds up to 1300 ${SOL_USDT}: part of the history may be missing, or the account moved after it was read`,
      },
    });
    expect(balanceCheck({}, null)).toEqual({ check: { status: "not_verified", reason: "intents.near's balances could not be read now" } });
  });
});
