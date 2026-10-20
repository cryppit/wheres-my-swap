import { describe, expect, it } from "vitest";

import { checkAddress, keccak256 } from "./addresses.js";

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const only = (raw: string) => {
  const v = checkAddress(raw);
  expect(v, raw).toHaveLength(1);
  return v[0]!;
};

describe("keccak256", () => {
  it("matches the published digests of the empty string and of abc", () => {
    expect(hex(keccak256(new Uint8Array()))).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(hex(keccak256(new TextEncoder().encode("abc")))).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });
});

describe("checkAddress", () => {
  // EIP-55's own test vectors.
  it("accepts EIP-55 checksummed EVM addresses and rejects one with a letter's case flipped", () => {
    for (const a of ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"]) {
      expect(checkAddress(a).find((v) => v.chain === "evm")).toMatchObject({ valid: true, kind: "checksummed" });
    }
    expect(checkAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD").find((v) => v.chain === "evm")).toMatchObject({ valid: false });
  });

  it("accepts an all-lower-case EVM address but says no checksum protects it, and names the NEAR account of the same form", () => {
    const v = checkAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    expect(v.find((x) => x.chain === "evm")).toMatchObject({ valid: true, kind: "no checksum" });
    expect(v.find((x) => x.chain === "near")).toMatchObject({ valid: true, kind: "eth-like account" });
  });

  it("checks Bitcoin legacy, P2SH, SegWit v0 (bech32) and Taproot (bech32m) addresses", () => {
    expect(only("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toMatchObject({ chain: "bitcoin", valid: true, kind: "P2PKH" });
    expect(only("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toMatchObject({ chain: "bitcoin", valid: true, kind: "P2SH" });
    expect(only("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toMatchObject({ chain: "bitcoin", valid: true, kind: "SegWit v0" });
    expect(only("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toMatchObject({ chain: "bitcoin", valid: true });
    expect(only("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0")).toMatchObject({ chain: "bitcoin", valid: true, kind: "Taproot" });
    expect(only("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toMatchObject({ chain: "bitcoin", valid: false });
    expect(only("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toMatchObject({ chain: "bitcoin", valid: false });
  });

  it("checks TRON Base58Check addresses (version 0x41)", () => {
    expect(only("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toMatchObject({ chain: "tron", valid: true });
    expect(only("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toMatchObject({ chain: "tron", valid: false });
  });

  it("checks Dogecoin P2PKH (D…) and P2SH (A…) addresses", () => {
    expect(only("D86DwJpYsyV7nTP2ib5qdwGsb2Tj7LgzPP")).toMatchObject({ chain: "dogecoin", valid: true, kind: "P2PKH" });
    expect(only("A7HRQk3GFCW2QasvdZxXuYj8kkQK5QrYLs")).toMatchObject({ chain: "dogecoin", valid: true, kind: "P2SH" });
    expect(only("D86DwJpYsyV7nTP2ib5qdwGsb2Tj7LgzPQ")).toMatchObject({ chain: "dogecoin", valid: false });
  });

  it("checks XRP classic addresses in Ripple's own Base58 alphabet", () => {
    expect(only("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh")).toMatchObject({ chain: "xrp", valid: true });
    expect(only("rrrrrrrrrrrrrrrrrrrrrhoLvTp")).toMatchObject({ chain: "xrp", valid: true });
    expect(only("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi")).toMatchObject({ chain: "xrp", valid: false });
  });

  it("checks Stellar account IDs (version byte and CRC16)", () => {
    expect(only("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ")).toMatchObject({ chain: "stellar", valid: true });
    expect(only("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZABKVWLTJJFC7MGXUA74P7UJVSGZ")).toMatchObject({ chain: "stellar", valid: false });
  });

  it("checks TON user-friendly addresses (tag and CRC16) and accepts the raw form", () => {
    expect(only("EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N")).toMatchObject({ chain: "ton", valid: true, kind: "bounceable" });
    expect(only("EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2O")).toMatchObject({ chain: "ton", valid: false });
    expect(only(`0:${"ab".repeat(32)}`)).toMatchObject({ chain: "ton", valid: true, kind: "raw" });
  });

  it("accepts Solana addresses as 32-byte Base58 keys and says they carry no checksum", () => {
    const v = only("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(v).toMatchObject({ chain: "solana", valid: true });
    expect(v.note).toMatch(/no checksum/);
    expect(only("11111111111111111111111111111111")).toMatchObject({ chain: "solana", valid: true });
  });

  it("checks NEAR implicit and named accounts, and rejects upper case in a name", () => {
    expect(checkAddress("ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6").find((v) => v.chain === "near")).toMatchObject({ valid: true, kind: "implicit account" });
    expect(only("alice.near")).toMatchObject({ chain: "near", valid: true, kind: "named account" });
    expect(only("Alice.near")).toMatchObject({ chain: "near", valid: false });
  });

  it("checks Zcash addresses with the full Zcash classifier", () => {
    expect(only("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1")).toMatchObject({ chain: "zcash", valid: true });
    expect(only("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU2")).toMatchObject({ chain: "zcash", valid: false });
  });

  it("returns nothing for text that is no address on any supported chain", () => {
    expect(checkAddress("hello")).toEqual([]);
    expect(checkAddress("")).toEqual([]);
  });
});
