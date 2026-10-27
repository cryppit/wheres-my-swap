// Plain words for every address the checker reads: what it means for the person about to send, not only its name.
import { describe, expect, it } from "vitest";

import { plainAddress } from "./address-advice.js";

const TEX = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";
const UA_NO_T = "u1r9ffm4hq7q2xcv4mwfhd0mpe0aw22klu9zxzsyr7shkx5rh77s0u3vpuc0vjchh7hvczldd8mwxgcydzyluhtd4h0zejlc5p5qzn5wn0";
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BTC = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const JARGON = /\bL1\b|\bL2\b|base58check|bech32|eip-55|typecode|witness program|crc16|strkey/i;
const all = (p: { headline: string; steps: string[] }): string => [p.headline, ...p.steps].join("\n");

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
    expect(p.headline).toBe("This unified address has only an Orchard receiver, so send from a wallet that supports Orchard.");
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

  it("no jargon in the plain words, for any of them", () => {
    for (const a of [TEX, UA_NO_T, EVM, BTC, SOL, XRP, "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1", "alice.near"]) expect(all(plainAddress(a))).not.toMatch(JARGON);
  });

  it("covers the eight newer payout chains in plain words", () => {
    expect(plainAddress("LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ")).toMatchObject({ chain: "Litecoin", valid: true, headline: "A valid Litecoin address." });
    expect(plainAddress("bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a").steps.join(" ")).toMatch(/never send BTC/);
    expect(plainAddress("XmN7PQYWKn5MJFna5fRYgP6mxT2F7xpekE")).toMatchObject({ chain: "Dash", valid: true });
    expect(plainAddress("addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x")).toMatchObject({ chain: "Cardano", valid: true });
    expect(plainAddress("stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw").headline).toMatch(/^Don't send: a Cardano stake/);
    const sui = plainAddress(`0x00${"ab".repeat(31)}`);
    expect(sui.headline).toBe("This could be a Sui, an Aptos, a Movement or a Starknet address.");
    expect(sui.steps[0]).toMatch(/Ask the recipient which network/);
    expect(plainAddress(`0x00${"ab".repeat(31)}`, "evm").headline).toBe("Stop: this is not an Ethereum address.");
    expect(plainAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "fogo")).toMatchObject({ chain: "Solana", valid: true });
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
