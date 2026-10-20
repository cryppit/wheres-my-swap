// Finding an order from the transaction the user sent on its own chain (what most users have). Pure: which NEAR bridge
// tokens could carry the assets that transaction moved, and where in NEAR's history to look. The fetching is in
// ../origin.ts.
//
// Only the PoA bridge (`*.omft.near`) writes the origin transaction hash on NEAR: its deposit carries a
// `BRIDGED_FROM:{…"txHash"…}` memo. Omni deposits (BTC via nbtc, SOL) record a nonce or a UTXO instead, so they are not
// searchable by transaction hash here.

/** One row of the PoA bridge's `supported_tokens`: `defuse_asset_identifier` → `near_token_id`. */
export interface BridgeToken {
  /** `<chain>:<chain id>:<contract or "native">`, e.g. `eth:1:native`, `tron:mainnet:TR7NH…`. */
  assetId: string;
  nearToken: string;
}

export type OriginKind = "evm" | "hex64" | "solana";

/** What kind of origin-chain hash this could be; null when it is not one (a NEAR hash or account, or nonsense). */
export function originKind(raw: string): OriginKind | null {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return "evm";
  if (/^[0-9a-fA-F]{64}$/.test(s)) return "hex64"; // a TRON or BTC transaction, or a NEAR implicit account
  if (/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s)) return "solana";
  return null;
}

export function sameTxHash(a: string, b: string): boolean {
  const norm = (h: string) => h.trim().toLowerCase().replace(/^0x/, "");
  return norm(a) === norm(b);
}

/** The PoA tokens that carry these assets (`native` or a contract address) from `chainKey` (`eth:1`) onto NEAR. */
export function nearTokensFor(tokens: BridgeToken[], chainKey: string, assets: string[]): string[] {
  const out: string[] = [];
  for (const asset of assets) {
    const evm = /^0x[0-9a-fA-F]{40}$/.test(asset);
    const wanted = `${chainKey}:${evm ? asset.toLowerCase() : asset}`;
    for (const t of tokens) {
      const id = evm ? t.assetId.toLowerCase() : t.assetId;
      if (id === wanted && t.nearToken.endsWith(".omft.near") && !out.includes(t.nearToken)) out.push(t.nearToken);
    }
  }
  return out;
}

export interface BlockPoint {
  height: number;
  timeSec: number;
}

/** The height at `timeSec`, by a straight line through two known blocks (NEAR makes ~1.6 blocks a second). */
export function heightGuess(timeSec: number, a: BlockPoint, b: BlockPoint): number {
  const perSec = (b.height - a.height) / (b.timeSec - a.timeSec || 1);
  return Math.max(1, Math.round(a.height + (timeSec - a.timeSec) * perSec));
}
