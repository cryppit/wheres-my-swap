// The checker's NEAR RPC views, through core/rpc.ts's retries and fallback providers, on recorded answers.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { nearViews } from "./near-views.js";

const recorded = (name: string): string => readFileSync(new URL(`./fixtures/rpc/${name}`, import.meta.url), "utf8");
const instant = { now: () => 0, sleep: async () => undefined, random: () => 0 };

describe("nearViews: accountExists", () => {
  it("true for an account the chain shows, false for UNKNOWN_ACCOUNT", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as { params: { account_id: string } }).params.account_id;
      return new Response(recorded(id === "hideon.near" ? "view-account-exists.json" : "view-account-missing.json"));
    }) as typeof fetch;
    const views = nearViews(fetchImpl, ["https://rpc.example"], instant);
    expect(await views.accountExists("hideon.near")).toBe(true);
    expect(await views.accountExists("nobody-made-this.near")).toBe(false);
  });

  it("null, not an error, when every provider is busy", async () => {
    const fetchImpl = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
    expect(await nearViews(fetchImpl, ["https://a.example", "https://b.example"], instant).accountExists("hideon.near")).toBeNull();
  });
});

describe("nearViews: intentsBalances (mt_tokens_for_owner, then mt_batch_balance_of at that same block)", () => {
  const SOL_USDT = "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
  const BLOCK = "8LvS9PHrRdffJp2SosWPUDXLH7pcmgEw4EwkewG74xo2";
  type Body = { params: { method_name: string; block_id?: string; finality?: string } };

  it("reads every token the order account holds, all at one final block (order 38f7db08…)", async () => {
    const bodies: Body[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return new Response(recorded(body.params.method_name === "mt_tokens_for_owner" ? "mt-tokens-38f7db08.json" : "mt-balances-38f7db08.json"));
    }) as typeof fetch;
    const got = await nearViews(fetchImpl, ["https://rpc.example"], instant).intentsBalances("38f7db08ab47b93f5a81c67f1409197051dc3a54cc73aa4c64977e8826ca265e");
    expect(got).toEqual({ blockHeight: 219_921_623, blockHash: BLOCK, balances: { [SOL_USDT]: "1300" } });
    expect(bodies.map((b) => [b.params.method_name, b.params.finality ?? null, b.params.block_id ?? null])).toEqual([
      ["mt_tokens_for_owner", "final", null],
      ["mt_batch_balance_of", null, BLOCK],
    ]);
  });

  it("an account that holds nothing takes one call (order 373dde4d…)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(recorded("mt-tokens-373dde4d.json"));
    }) as typeof fetch;
    expect(await nearViews(fetchImpl, ["https://rpc.example"], instant).intentsBalances("373dde4de823895a57e957954abbe1579394f35b43fd4a40b0153db8970a49a4")).toEqual({
      blockHeight: 219_921_642,
      blockHash: "E4zNqzQzDK4jDLuioPVobQSvKLmk413wt8uF7CZHng54",
      balances: {},
    });
    expect(calls).toBe(1);
  });

  it("null, not an error, when every provider is busy", async () => {
    const fetchImpl = (async () => new Response("slow down", { status: 503 })) as typeof fetch;
    expect(await nearViews(fetchImpl, ["https://a.example"], instant).intentsBalances("a")).toBeNull();
  });
});
