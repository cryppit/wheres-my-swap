// How each chain a NEAR Intents order can touch is named to a reader, keyed by the short names the bridges and our
// routes use (`bsc`, `pol`, `hood`; Omni's `zcash:`/`sol:` prefixes too).

const NAMES: Record<string, string> = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  bsc: "BNB Chain",
  bnb: "BNB Chain",
  pol: "Polygon",
  avax: "Avalanche",
  gnosis: "Gnosis",
  bera: "Berachain",
  monad: "Monad",
  xlayer: "X Layer",
  plasma: "Plasma",
  scroll: "Scroll",
  adi: "ADI Chain",
  hood: "Robinhood Chain",
  abs: "Abstract",
  tron: "TRON",
  btc: "Bitcoin",
  ltc: "Litecoin",
  doge: "Dogecoin",
  bch: "Bitcoin Cash",
  dash: "Dash",
  zec: "Zcash",
  zcash: "Zcash",
  xrp: "XRP Ledger",
  sol: "Solana",
  ton: "TON",
  sui: "Sui",
  stellar: "Stellar",
  aptos: "Aptos",
  cardano: "Cardano",
  starknet: "Starknet",
  hlevm: "HyperEVM",
  fogo: "Fogo",
  near: "NEAR",
};

/** The chain's name, or the key itself when it is not one we name ("?" for none). */
export function chainName(chain: string | null | undefined): string {
  if (!chain) return "?";
  const key = chain.split(":")[0] ?? chain;
  return NAMES[key] ?? chain;
}
