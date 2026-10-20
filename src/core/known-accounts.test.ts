import { describe, expect, it } from "vitest";

import { CONFIDENTIAL_TREASURY, knownAccount } from "./known-accounts.js";

describe("knownAccount", () => {
  it("names the documented NEAR Intents fee collectors", () => {
    expect(knownAccount("7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05")).toEqual({
      label: "NEAR Intents protocol fee",
      kind: "fee",
      source: "https://docs.near-intents.org/resources/fees",
    });
    expect(knownAccount("fefundsadmin.sputnik-dao.near")?.kind).toBe("fee");
  });

  it("names the Confidential Intents treasury", () => {
    expect(knownAccount(CONFIDENTIAL_TREASURY)?.kind).toBe("confidential");
  });

  it("returns null for accounts it does not know, including undocumented ones we only suspect", () => {
    expect(knownAccount("5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd")).toBeNull();
    expect(knownAccount("alice.near")).toBeNull();
  });
});
