// Plain words for every address the checker reads: what it means for the person about to send, not only its name.
import { describe, expect, it } from "vitest";

import { plainAddress } from "./address-advice.js";

const TEX = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";
const UA_NO_T = "u1r9ffm4hq7q2xcv4mwfhd0mpe0aw22klu9zxzsyr7shkx5rh77s0u3vpuc0vjchh7hvczldd8mwxgcydzyluhtd4h0zejlc5p5qzn5wn0";
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BTC = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const JARGON = /\bL1\b|\bL2\b|base58|bech32|eip-55|typecode|witness|crc16|strkey|ss58|cip-19|sep-23|p2pkh|p2sh|segwit|checksum|version byte|workchain|bounceable|implicit|hex\b|zip-|\bEVM chains\b/i;
const all = (p: { headline: string; steps: string[]; what?: string }): string => [p.headline, ...p.steps, p.what ?? ""].join("\n");
// One address of every kind the check knows, valid and broken.
const EVERY = [
  TEX, UA_NO_T, EVM, BTC, SOL, XRP, "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1", "alice.near", "Alice.near", "fe".repeat(32),
  "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9",
  "D86DwJpYsyV7nTP2ib5qdwGsb2Tj7LgzPP", "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ", "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
  "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8", "LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ", "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
  "XmN7PQYWKn5MJFna5fRYgP6mxT2F7xpekE", "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
  "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw", "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae",
  `0x00${"ab".repeat(31)}`, `0x${"1".repeat(60)}`, "aleo10kgvf58ruwt3gqsa0994jhdh6ywgf9uqtxcmv476zf3klengsg8qcwdmhu", "aleo10kgvf58ruwt3gqsa0994jhdh6ywgf9uqtxcmv476zf3klengsg8qcwdmhv",
  "qzmTAz3UUw1WGUuVh8nbFmPwcftomduwy6twq6NDR6y9qqtEs", "qzmTAz3UUw1WGUuVh8nbFmPwcftomduwy6twq6NDR6y9qqtEt",
];

describe("plainAddress", () => {
  it("a TEX address: the plain next step, and both wallet answers", () => {
    const p = plainAddress(TEX);
    expect(p.chain).toBe("Zcash");
    expect(p.headline).toBe("This is a TEX address, so send from a transparent balance.");
    expect(p.zcash?.transparent.can).toBe("if-supported");
    expect(p.zcash?.shielded.can).toBe("no");
  });

  it("a unified address with no transparent receiver: a transparent-only wallet cannot pay it", () => {
    const p = plainAddress(UA_NO_T);
    expect(p.headline).toBe("This unified address only has an Orchard part, so send from a wallet that supports Orchard.");
    expect(p.zcash?.transparent.can).toBe("no");
  });

  it("a mistyped address says not to send and to copy it again", () => {
    const p = plainAddress("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU2");
    expect(p.valid).toBe(false);
    expect(p.headline).toMatch(/^Don't send/);
    expect(all(p)).toMatch(/copy it again/i);
  });

  it("the chain you named comes first when the address belongs to another", () => {
    const p = plainAddress(BTC, "zcash");
    expect(p.headline).toBe("Stop: this is not a Zcash address.");
    expect(all(p)).toMatch(/Bitcoin/);
  });

  it("an EVM address points smart-wallet users to Safe to Send", () => {
    expect(all(plainAddress(EVM))).toMatch(/Safe to Send/);
  });

  it("Solana has no built-in check, so compare it by hand", () => {
    expect(all(plainAddress(SOL))).toMatch(/no built-in check/);
  });

  it("XRP, Stellar and TON: an exchange may also need a tag or memo", () => {
    expect(all(plainAddress(XRP))).toMatch(/tag or memo/);
  });

  it("something that is no address says so", () => {
    expect(plainAddress("hello there").headline).toMatch(/isn't an address/);
  });

  it("no jargon in the plain words or the detail line, for any kind of address", () => {
    for (const a of EVERY) expect(all(plainAddress(a)), a).not.toMatch(JARGON);
  });

  it("a NEAR name with a capital letter says what NEAR names allow, not that a character was mistyped", () => {
    const p = plainAddress("Alice.near");
    expect(p.headline).toMatch(/^Don't send/);
    expect(all(p)).toMatch(/small letters/);
    expect(all(p)).not.toMatch(/mistyped|built-in check/);
  });

  it("Cardano stake and test-network addresses get their own plain headline", () => {
    expect(plainAddress("stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw").headline).toBe("Don't send: this is a Cardano reward (stake) address, not a payment address.");
    expect(plainAddress("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae").headline).toBe("Don't send: this is a Cardano test-network address.");
  });

  it("the tag says why an address can't be paid, and only a failed typo check reads 'has a mistake'", () => {
    expect(plainAddress("stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw").status).toBe("can't receive");
    expect(plainAddress("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae").status).toBe("test network");
    expect(plainAddress("Alice.near").status).toBe("not a valid name");
    expect(plainAddress(BTC.slice(0, -1) + (BTC.endsWith("q") ? "p" : "q")).status).toBe("has a mistake");
    expect(plainAddress(BTC).status).toBe("valid");
    expect(plainAddress("hello").status).toBe("not recognised");
  });

  it("the chain the sender picked is the one answered for, when the address fits it", () => {
    expect(plainAddress(SOL, "fogo")).toMatchObject({ chain: "Fogo", headline: "A well-formed Fogo address." });
    expect(plainAddress(`0x00${"ab".repeat(31)}`, "movement").chain).toBe("Movement");
  });

  it("a wrong-chain stop lists the look-alikes the way people say them", () => {
    expect(plainAddress(`0x00${"ab".repeat(31)}`, "evm").steps[0]).toMatch(/^It looks like a Sui, Aptos, Movement or Starknet address\./);
  });

  it("covers the eight newer payout chains in plain words", () => {
    expect(plainAddress("LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ")).toMatchObject({ chain: "Litecoin", valid: true, headline: "A valid Litecoin address." });
    expect(plainAddress("bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a").steps.join(" ")).toMatch(/never send BTC/);
    expect(plainAddress("XmN7PQYWKn5MJFna5fRYgP6mxT2F7xpekE")).toMatchObject({ chain: "Dash", valid: true });
    expect(plainAddress("addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x")).toMatchObject({ chain: "Cardano", valid: true });
    expect(plainAddress("stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw").headline).toMatch(/^Don't send: this is a Cardano reward/);
    const sui = plainAddress(`0x00${"ab".repeat(31)}`);
    expect(sui.headline).toBe("This could be a Sui, an Aptos, a Movement or a Starknet address.");
    expect(sui.steps[0]).toMatch(/Ask the recipient, and send only on that one/);
    expect(plainAddress(`0x00${"ab".repeat(31)}`, "evm").headline).toBe("Stop: this is not an Ethereum address.");
    expect(plainAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "fogo")).toMatchObject({ chain: "Fogo", valid: true });
  });

  it("covers the chains NEAR Intents added in 2026: Aleo, Movement, Quantus and HyperCore", () => {
    expect(plainAddress("aleo10kgvf58ruwt3gqsa0994jhdh6ywgf9uqtxcmv476zf3klengsg8qcwdmhu")).toMatchObject({ chain: "Aleo", valid: true, headline: "A valid Aleo address." });
    expect(plainAddress("qzmTAz3UUw1WGUuVh8nbFmPwcftomduwy6twq6NDR6y9qqtEs")).toMatchObject({ chain: "Quantus", valid: true, headline: "A valid Quantus address." });
    expect(plainAddress(`0x00${"ab".repeat(31)}`, "movement")).toMatchObject({ valid: true });
    expect(plainAddress("qzmTAz3UUw1WGUuVh8nbFmPwcftomduwy6twq6NDR6y9qqtEs", "evm").headline).toBe("Stop: this is not an Ethereum address.");
    // HyperCore pays out to Ethereum-style addresses.
    expect(plainAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").steps.join(" ")).toMatch(/Hyperliquid/);
  });
});
