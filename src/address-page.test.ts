import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../web/address.html", import.meta.url), "utf8");

describe("the address page", () => {
  it("draws a logo, not a letter, on every chain button", () => {
    expect(html).not.toMatch(/<span class="cp-any" aria-hidden="true">[A-Z]<\/span>/);
  });

  it("lists a chain word for every chain the bot understands", () => {
    const note = /Chain words it knows:([^<]*)/.exec(html)?.[1] ?? "";
    for (const w of ["zcash", "bitcoin", "ethereum", "hyperliquid", "solana", "tron", "xrp", "stellar", "ton", "dogecoin", "near", "litecoin", "bch", "dash", "cardano", "sui", "aptos", "starknet", "fogo", "aleo", "movement", "quantus"]) expect(note).toContain(w);
  });

  it("every logo the page uses exists", () => {
    for (const [, f] of html.matchAll(/src="\/logos\/([a-z0-9-]+\.svg)"/g)) expect(() => readFileSync(new URL(`../web/public/logos/${f}`, import.meta.url))).not.toThrow();
  });
});
