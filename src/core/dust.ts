// What counts as dust: a leftover worth less than a few cents is what an order leaves behind, not stuck money. Prices
// come from the caller (check.ts reads the 1Click token list); this file is pure.

export interface TokenPrice {
  assetId: string;
  decimals: number;
  price: number;
}

/** A leftover worth less than this many US dollars is dust. */
export const DUST_USD = 0.05;

/** For each priced token, the raw amount worth DUST_USD at its listed price: a leftover below it is dust. */
export function dustThresholds(tokens: readonly TokenPrice[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokens) {
    if (!(t.price > 0) || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 40) continue;
    const raw = Math.floor((DUST_USD / t.price) * 10 ** t.decimals);
    if (Number.isFinite(raw) && raw > 0) out[t.assetId] = BigInt(raw).toString();
  }
  return out;
}
