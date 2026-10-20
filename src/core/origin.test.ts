// Finding an order from the transaction the user sent on its own chain: which NEAR bridge tokens to search, where in
// NEAR's history to start, and which deposit names the user's transaction.
import { describe, expect, it } from "vitest";

import { heightGuess, nearTokensFor, originKind, sameTxHash, type BridgeToken } from "./origin.js";

const TOKENS: BridgeToken[] = [
  { assetId: "tron:mainnet:native", nearToken: "tron.omft.near" },
  { assetId: "tron:mainnet:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", nearToken: "tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near" },
  { assetId: "eth:1:native", nearToken: "eth.omft.near" },
  { assetId: "eth:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", nearToken: "eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near" },
  { assetId: "btc:mainnet:native", nearToken: "nbtc.bridge.near" },
  { assetId: "btc:mainnet:native", nearToken: "btc.omft.near" },
];

describe("originKind", () => {
  it("tells an EVM transaction hash, a 64-hex hash (TRON, BTC or a NEAR account) and the rest apart", () => {
    expect(originKind("0x5b523e971f8a79ce81330f46755b050df31156b11cc37afd6bc02719f73066b1")).toBe("evm");
    expect(originKind(" d9b9c4c3c88f99d78e9484871eaa8b1ee938bd67aad2093341817a600b8cfd67 ")).toBe("hex64");
    expect(originKind("5LdUfX2cwfgyYVPz8QJjVjwVfceKeu3xGECu9kYGG8VB")).toBeNull();
    expect(originKind("2xu8DRon9ZP5vofTcpTPFcMindmxMrPPh5NP4YKp8zfSLdUfX2cwfgyYVPz8QJjVjwVfceKeu3xGECu9kYGG8VB4")).toBe("solana");
  });
});

describe("sameTxHash", () => {
  it("ignores case and a 0x prefix", () => {
    expect(sameTxHash("0xABcd", "abcd")).toBe(true);
    expect(sameTxHash("abcd", "abce")).toBe(false);
  });
});

describe("nearTokensFor", () => {
  it("maps the assets a transaction moved to the PoA bridge tokens that would carry them onto NEAR", () => {
    expect(nearTokensFor(TOKENS, "tron:mainnet", ["native"])).toEqual(["tron.omft.near"]);
    expect(nearTokensFor(TOKENS, "tron:mainnet", ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"])).toEqual(["tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near"]);
    expect(nearTokensFor(TOKENS, "eth:1", ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "native"])).toEqual([
      "eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      "eth.omft.near",
    ]);
  });

  it("keeps only PoA tokens: their deposits name the origin transaction; Omni's do not", () => {
    expect(nearTokensFor(TOKENS, "btc:mainnet", ["native"])).toEqual(["btc.omft.near"]);
  });
});

describe("heightGuess", () => {
  it("interpolates a block height for a time between two known blocks", () => {
    expect(heightGuess(1_000, { height: 100, timeSec: 900 }, { height: 300, timeSec: 1_100 })).toBe(200);
  });
  it("extrapolates past the known blocks, never below 1", () => {
    expect(heightGuess(1_200, { height: 100, timeSec: 900 }, { height: 300, timeSec: 1_100 })).toBe(400);
    expect(heightGuess(0, { height: 100, timeSec: 900 }, { height: 300, timeSec: 1_100 })).toBe(1);
  });
});
