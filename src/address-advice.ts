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
  /** The technical name, for those who want it ("TEX address", "SegWit v0", …). */
  what: string;
  headline: string;
  steps: string[];
  /** Zcash only: can a transparent-only wallet, and a shielded one, send to it. */
  zcash?: ZcashSendAdvice;
}

/** "an Ethereum", "an Aptos", "a Sui": the article for a chain name. */
const an = (name: string): string => `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name}`;

const MEMO = "If it belongs to an exchange, the exchange may also need a destination tag or memo, which is separate from the address. Ask them before you send.";

function forChain(v: AddressVerdict, all: AddressVerdict[]): Pick<PlainAddress, "headline" | "steps"> {
  switch (v.chain) {
    case "evm":
      return {
        headline: "A valid Ethereum-style address.",
        steps: [
          "The same address works on Ethereum, Base, Arbitrum, BNB Chain, Hyperliquid and the other EVM chains, as long as it belongs to a normal wallet.",
          "If it belongs to a smart wallet, such as an Abstract wallet or a Safe, it may exist on one chain only. Check it on Safe to Send before sending on a different chain.",
          ...(v.kind === "no checksum" ? ["It is written all in one case, so a mistyped character can't be caught. Compare it with the source."] : []),
          ...(all.some((x) => x.chain === "near") ? ["It is also a valid NEAR account of the 0x form."] : []),
        ],
      };
    case "bitcoin":
    case "dogecoin":
    case "tron":
      return {
        headline: `A valid ${SHORT[v.chain]} address.`,
        steps: [`Only send ${v.chain === "tron" ? "TRX or TRON tokens" : v.chain === "bitcoin" ? "bitcoin (BTC)" : "dogecoin (DOGE)"} to it, on the ${SHORT[v.chain]} network.`, "Its built-in check passed, so it has no typo."],
      };
    case "xrp":
    case "stellar":
    case "ton":
      return { headline: `A valid ${SHORT[v.chain]} address.`, steps: [`Only send on the ${SHORT[v.chain]} network.`, MEMO] };
    case "solana":
      return {
        headline: "A well-formed Solana address.",
        steps: ["Solana addresses have no built-in check, so a mistyped one still looks valid. Compare it with the source, character by character, before you send.", "Fogo uses the same address form: check which network the recipient uses."],
      };
    case "near":
      return {
        headline: "A valid NEAR account.",
        steps: [v.kind === "named account" ? "Whether this account exists is not checked here; a name nobody created can't receive funds." : "A NEAR account written as 64 characters (this is the form NEAR Intents uses for order accounts)."],
      };
    case "litecoin":
    case "dash":
    case "bitcoincash":
      return {
        headline: `A valid ${SHORT[v.chain]} address.`,
        steps: [
          `Only send ${v.chain === "litecoin" ? "litecoin (LTC)" : v.chain === "dash" ? "Dash (DASH)" : "Bitcoin Cash (BCH)"} to it, on the ${SHORT[v.chain]} network.`,
          v.chain === "bitcoincash" ? "Bitcoin Cash and Bitcoin are different chains: never send BTC to it, or BCH to a Bitcoin address." : "Its built-in check passed, so it has no typo.",
        ],
      };
    case "cardano":
      return { headline: "A valid Cardano address.", steps: ["Only send ADA or Cardano tokens to it, on the Cardano network.", "Its built-in check passed, so it has no typo."] };
    case "sui":
    case "aptos":
    case "movement":
    case "starknet": {
      const alike = all.filter((x) => ["sui", "aptos", "movement", "starknet"].includes(x.chain)).map((x) => SHORT[x.chain]);
      return {
        headline: alike.length > 1 ? `This could be ${alike.map(an).join(", ").replace(/, ([^,]*)$/, " or $1")} address.` : `A well-formed ${SHORT[v.chain]} address.`,
        steps: [
          "These chains use the same 0x form, so the address alone can't tell which one it belongs to. Ask the recipient which network it is for, and send only on that one.",
          "It has no built-in check, so a mistyped one still looks valid: compare it with the source, character by character.",
        ],
      };
    }
    case "fogo":
      return { headline: "A well-formed Fogo address.", steps: ["Fogo uses the same address form as Solana. Check which network the recipient uses, and send only on that one.", "It has no built-in check: compare it with the source, character by character."] };
    case "aleo":
      return { headline: "A valid Aleo address.", steps: ["Only send ALEO or Aleo tokens to it, on the Aleo network.", "Its built-in check passed, so it has no typo."] };
    case "quantus":
      return { headline: "A valid Quantus address.", steps: ["Only send QTC to it, on the Quantus network.", "Its built-in check passed, so it has no typo."] };
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
  const v = verdicts.find((x) => x.valid) ?? verdicts[0]!;
  const base = { address, chain: CHAIN_NAME[v.chain], valid: v.valid, what: `${v.kind}: ${v.note}` };

  if (hint !== null && !verdicts.some((x) => x.chain === hint)) {
    const looks = verdicts.map((x) => SHORT[x.chain]).join(" or ");
    return { ...base, headline: `Stop: this is not ${an(SHORT[hint])} address.`, steps: [`It looks like ${an(looks)} address. Sending ${SHORT[hint]} funds to it would likely lose them.`, `Ask the recipient for their ${SHORT[hint]} address.`] };
  }
  if (v.chain === "zcash") {
    const advice = zcashSendAdvice(classifyZcashAddress(address));
    return { ...base, headline: advice.next, steps: [], zcash: advice };
  }
  if (!v.valid && (v.kind === "testnet" || v.kind === "stake address")) {
    return { ...base, headline: `Don't send: ${v.note.charAt(0).toLowerCase()}${v.note.slice(1)}`, steps: [] };
  }
  if (!v.valid) {
    return { ...base, headline: "Don't send: this address has a mistake.", steps: ["A character is wrong or missing, so the address fails its built-in check.", "Copy it again from the source, ideally with a copy button rather than by hand."] };
  }
  return { ...base, ...forChain(v, verdicts) };
}
