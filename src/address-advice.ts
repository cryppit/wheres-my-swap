// What an address means for the person about to send to it, in plain words: a headline and a few steps, plus, for
// Zcash, whether a transparent-only or a shielded wallet can pay it (core/zcash-address.ts). Built on checkAddress.

import { checkAddress, type AddressChain, type AddressVerdict } from "./core/addresses.js";
import { classifyZcashAddress, zcashSendAdvice, type ZcashSendAdvice } from "./core/zcash-address.js";

export const CHAIN_NAME: Record<AddressChain, string> = {
  evm: "Ethereum (EVM)",
  bitcoin: "Bitcoin",
  tron: "TRON",
  dogecoin: "Dogecoin",
  xrp: "XRP",
  stellar: "Stellar",
  ton: "TON",
  solana: "Solana",
  near: "NEAR",
  zcash: "Zcash",
  litecoin: "Litecoin",
  bitcoincash: "Bitcoin Cash",
  dash: "Dash",
  cardano: "Cardano",
  sui: "Sui",
  aptos: "Aptos",
  starknet: "Starknet",
  fogo: "Fogo",
  aleo: "Aleo",
  movement: "Movement",
  quantus: "Quantus",
};
const SHORT: Record<AddressChain, string> = { ...CHAIN_NAME, evm: "Ethereum" };

export interface PlainAddress {
  address: string;
  /** The chain it belongs to, or null when it is no address on any chain we check. */
  chain: string | null;
  valid: boolean;
  /** What kind of address it is, in one plain line (shown small under the answer). */
  what: string;
  headline: string;
  steps: string[];
  /** Zcash only: can a transparent-only wallet, and a shielded one, send to it. */
  zcash?: ZcashSendAdvice;
}

/** "an Ethereum", "an Aptos", "a Sui": the article for a chain name. */
const an = (name: string): string => `${/^([AEIOU]|XRP)/.test(name) ? "an" : "a"} ${name}`;
/** The same, starting a sentence. */
const An = (name: string): string => an(name).replace(/^a/, "A");

const MEMO = "If it belongs to an exchange, the exchange may also need a destination tag or memo, which is separate from the address. Ask them before you send.";
const PASSED = "Its built-in typo check passed.";
const NO_CHECK = "It has no built-in typo check, so a mistyped one still looks valid: compare it with the source, character by character.";
const ALIKE: AddressChain[] = ["sui", "aptos", "movement", "starknet"];
/** "a Sui, Aptos, Movement or Starknet": a list of chain names, with the article of the first. */
const anyOf = (names: string[]): string => an(names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0] ?? "");

/** What each kind of address looks like, for the small line under the answer (the steps say what to do). */
const LOOKS: Partial<Record<AddressChain, string>> = {
  tron: "starts with T",
  dogecoin: "starts with D, A or 9",
  xrp: "starts with r",
  stellar: "starts with G",
  litecoin: "starts with L, M or ltc1",
  bitcoincash: "starts with q or p (or with bitcoincash:)",
  dash: "starts with X or 7",
  cardano: "starts with addr1",
  solana: "32 to 44 letters and numbers",
  fogo: "32 to 44 letters and numbers, like Solana's",
  sui: "0x followed by 64 letters and numbers",
  aptos: "0x followed by up to 64 letters and numbers",
  movement: "0x followed by up to 64 letters and numbers, like Aptos's",
  starknet: "0x followed by up to 64 letters and numbers",
  aleo: "starts with aleo1",
  quantus: "starts with qz",
};

/** The small line under the answer: what kind of address it is, in plain words. */
function plainWhat(v: AddressVerdict): string {
  const name = SHORT[v.chain];
  if (v.chain === "zcash") return v.valid ? (ZCASH_WHAT[v.kind] ?? "A Zcash address.") : "Looks like a Zcash address, but its built-in typo check failed.";
  if (v.chain === "near") {
    if (v.kind === "named account") return v.valid ? "A NEAR account name (ends with .near or another NEAR name)." : "Not a valid NEAR name: NEAR names use only small letters, numbers, dots, - and _.";
    if (v.kind === "eth-like account") return "Also a NEAR account (NEAR accepts Ethereum-style addresses written in small letters).";
    return "A NEAR account written as 64 letters and numbers.";
  }
  if (v.chain === "cardano" && v.kind === "stake address") return "A Cardano reward (stake) address: it starts with stake1.";
  if (v.chain === "cardano" && v.kind === "testnet") return "A Cardano test-network address: it starts with addr_test1.";
  if (!v.valid) return `Looks like ${an(name)} address, but its built-in typo check failed.`;
  switch (v.chain) {
    case "evm":
      return v.kind === "checksummed"
        ? "An Ethereum-style address (0x followed by 40 letters and numbers). Its mix of capital and small letters works as a typo check."
        : "An Ethereum-style address (0x followed by 40 letters and numbers), written all in one case.";
    case "bitcoin":
      return v.kind === "Taproot" ? "A Bitcoin Taproot address: it starts with bc1p."
        : v.kind.startsWith("SegWit") ? "A modern Bitcoin address: it starts with bc1q."
        : v.kind === "P2SH" ? "A Bitcoin address that starts with 3 (often a shared or wrapped wallet)."
        : "A Bitcoin address of the original kind: it starts with 1.";
    case "ton":
      return v.kind === "raw" ? "A TON address in its raw form: 0: followed by 64 letters and numbers." : "A TON address in its usual form (48 letters and numbers).";
    default:
      return LOOKS[v.chain] ? `${An(name)} address: it ${/^\d|^0x/.test(LOOKS[v.chain]!) ? "is" : ""}${/^\d|^0x/.test(LOOKS[v.chain]!) ? " " : ""}${LOOKS[v.chain]}.` : `${An(name)} address.`;
  }
}

const ZCASH_WHAT: Record<string, string> = {
  p2pkh: "A transparent Zcash address (starts with t1). Its payments are public, like Bitcoin's.",
  p2sh: "A transparent Zcash address (starts with t3). Its payments are public, like Bitcoin's.",
  tex: "A TEX address (starts with tex1). It only accepts ZEC sent from a transparent balance.",
  unified: "A unified address (starts with u1): one address that can include several kinds of Zcash receiver.",
  sapling: "A shielded Zcash address (starts with zs1). Its payments are private.",
  sprout: "An old shielded Zcash address (starts with zc). Most wallets no longer send to it.",
};

function forChain(v: AddressVerdict, all: AddressVerdict[]): Pick<PlainAddress, "headline" | "steps"> {
  switch (v.chain) {
    case "evm":
      return {
        headline: "A valid Ethereum-style address.",
        steps: [
          "The same address works on Ethereum, Base, Arbitrum, BNB Chain, Hyperliquid and other Ethereum-style networks, as long as it belongs to a normal wallet.",
          "If it belongs to a smart wallet, such as an Abstract wallet or a Safe, it may exist on one chain only. Check it on Safe to Send before sending on a different chain.",
          ...(v.kind === "no checksum" ? ["It is written all in small (or all in capital) letters, so a typo can't be caught automatically. Compare it with the source."] : []),
          ...(all.some((x) => x.chain === "near") ? ["NEAR also accepts it as an account name."] : []),
        ],
      };
    case "bitcoin":
    case "dogecoin":
    case "tron":
      return {
        headline: `A valid ${SHORT[v.chain]} address.`,
        steps: [`Only send ${v.chain === "tron" ? "TRX or TRON tokens" : v.chain === "bitcoin" ? "bitcoin (BTC)" : "dogecoin (DOGE)"} to it, on the ${SHORT[v.chain]} network.`, PASSED],
      };
    case "xrp":
    case "stellar":
    case "ton":
      return { headline: `A valid ${SHORT[v.chain]} address.`, steps: [`Only send on the ${SHORT[v.chain]} network.`, MEMO] };
    case "solana":
      return {
        headline: "A well-formed Solana address.",
        steps: ["Solana addresses have no built-in check, so a mistyped one still looks valid. Compare it with the source, character by character, before you send.", "Fogo addresses look exactly the same: check which network the recipient uses."],
      };
    case "near":
      return {
        headline: "A valid NEAR account.",
        steps: [v.kind === "named account" ? "Whether this account exists isn't checked here; a name nobody created can't receive funds." : "A NEAR account written as 64 letters and numbers. NEAR Intents uses this kind for swap deposit accounts."],
      };
    case "litecoin":
    case "dash":
    case "bitcoincash":
      return {
        headline: `A valid ${SHORT[v.chain]} address.`,
        steps: [
          `Only send ${v.chain === "litecoin" ? "litecoin (LTC)" : v.chain === "dash" ? "Dash (DASH)" : "Bitcoin Cash (BCH)"} to it, on the ${SHORT[v.chain]} network.`,
          v.chain === "bitcoincash" ? "Bitcoin Cash and Bitcoin are different chains: never send BTC to it, or BCH to a Bitcoin address." : PASSED,
        ],
      };
    case "cardano":
      return { headline: "A valid Cardano address.", steps: ["Only send ADA or Cardano tokens to it, on the Cardano network.", PASSED] };
    case "sui":
    case "aptos":
    case "movement":
    case "starknet": {
      const alike = all.filter((x) => ALIKE.includes(x.chain)).map((x) => SHORT[x.chain]);
      return {
        headline: alike.length > 1 ? `This could be ${alike.map(an).join(", ").replace(/, ([^,]*)$/, " or $1")} address.` : `A well-formed ${SHORT[v.chain]} address.`,
        steps: [
          `${alike.join(", ").replace(/, ([^,]*)$/, " and $1")} addresses all look like this, so the address alone can't tell which network it is for. Ask the recipient, and send only on that one.`,
          NO_CHECK,
        ],
      };
    }
    case "fogo":
      return { headline: "A well-formed Fogo address.", steps: ["Fogo addresses look exactly like Solana's. Check which network the recipient uses, and send only on that one.", NO_CHECK] };
    case "aleo":
      return { headline: "A valid Aleo address.", steps: ["Only send ALEO or Aleo tokens to it, on the Aleo network.", PASSED] };
    case "quantus":
      return { headline: "A valid Quantus address.", steps: ["Only send QTC to it, on the Quantus network.", PASSED] };
    case "zcash":
      return { headline: "", steps: [] };
  }
}

/** Plain words for one address; `hint` is the chain the sender means to use, if they named one. */
export function plainAddress(raw: string, hint: AddressChain | null = null): PlainAddress {
  const address = raw.trim();
  const verdicts = checkAddress(address);
  if (verdicts.length === 0) {
    return { address, chain: null, valid: false, what: "not recognised", headline: "This isn't an address on any chain we check.", steps: ["Check that you copied the whole address, with nothing extra before or after it."] };
  }
  // The chain the sender picked, when the address fits it; otherwise the first valid reading.
  const v = verdicts.find((x) => x.valid && x.chain === hint) ?? verdicts.find((x) => x.valid) ?? verdicts[0]!;
  const base = { address, chain: CHAIN_NAME[v.chain], valid: v.valid, what: plainWhat(v) };

  if (hint !== null && !verdicts.some((x) => x.chain === hint)) {
    const looks = anyOf([...new Set(verdicts.map((x) => SHORT[x.chain]))]);
    return { ...base, headline: `Stop: this is not ${an(SHORT[hint])} address.`, steps: [`It looks like ${looks} address. Sending ${SHORT[hint]} funds to it would likely lose them.`, `Ask the recipient for their ${SHORT[hint]} address.`] };
  }
  if (v.chain === "zcash") {
    const advice = zcashSendAdvice(classifyZcashAddress(address));
    return { ...base, headline: advice.next, steps: [], zcash: advice };
  }
  if (!v.valid && v.kind === "stake address") {
    return { ...base, headline: "Don't send: this is a Cardano reward (stake) address, not a payment address.", steps: ["Payments can't be sent to it.", "Ask the recipient for their Cardano address that starts with addr1."] };
  }
  if (!v.valid && v.kind === "testnet") {
    return { ...base, headline: "Don't send: this is a Cardano test-network address.", steps: ["Real ADA sent to it would be lost.", "Ask the recipient for their main Cardano address (it starts with addr1)."] };
  }
  if (!v.valid && v.chain === "near" && v.kind === "named account") {
    return { ...base, headline: "Don't send: this isn't a valid NEAR account name.", steps: ["NEAR names use only small letters, numbers, dots, - and _ (no capital letters or spaces).", "Ask the recipient to copy their account name again."] };
  }
  if (!v.valid) {
    return { ...base, headline: "Don't send: this address has a mistake.", steps: ["A character is wrong or missing, so the address fails its built-in typo check.", "Copy it again from the source, ideally with a copy button rather than by hand."] };
  }
  return { ...base, ...forChain(v, verdicts) };
}
