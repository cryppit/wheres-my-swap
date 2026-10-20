// Accounts NEAR Intents documents publicly, so the report can name them instead of showing a bare hash. Only
// documented accounts belong here; an account we merely suspect (e.g. an integrator's fee wallet) stays unlabelled.

export interface KnownAccount {
  label: string;
  kind: "fee" | "confidential";
  source: string;
}

/** Shielding into Confidential Intents is a transfer to this treasury; the later legs settle on the private intents.far. */
export const CONFIDENTIAL_TREASURY = "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";

const KNOWN: Record<string, KnownAccount> = {
  "7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05": {
    label: "NEAR Intents protocol fee",
    kind: "fee",
    source: "https://docs.near-intents.org/resources/fees",
  },
  "fefundsadmin.sputnik-dao.near": {
    label: "near-intents.org app fee",
    kind: "fee",
    source: "https://docs.near-intents.org/resources/fees",
  },
  [CONFIDENTIAL_TREASURY]: {
    label: "Confidential Intents treasury",
    kind: "confidential",
    source: "https://docs.near-intents.org/integration/market-makers/confidential-intents",
  },
};

export function knownAccount(id: string): KnownAccount | null {
  return KNOWN[id] ?? null;
}
