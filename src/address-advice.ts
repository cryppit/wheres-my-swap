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

const MEMO = "If it belongs to an exchange, the exchange may also need a destination tag or memo, which is separate from the address. Ask them before you send.";

function forChain(v: AddressVerdict, all: AddressVerdict[]): Pick<PlainAddress, "headline" | "steps"> {
  switch (v.chain) {
    case "evm":
      return {
        headline: "A valid Ethereum-style address.",
        steps: [
          "The same address works on Ethereum, Base, Arbitrum, BNB Chain and the other EVM chains, as long as it belongs to a normal wallet.",
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
        steps: ["Solana addresses have no built-in check, so a mistyped one still looks valid. Compare it with the source, character by character, before you send."],
      };
    case "near":
      return {
        headline: "A valid NEAR account.",
        steps: [v.kind === "named account" ? "Whether this account exists is not checked here; a name nobody created can't receive funds." : "A NEAR account written as 64 characters (this is the form NEAR Intents uses for order accounts)."],
      };
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
    return { ...base, headline: `Stop: this is not a ${SHORT[hint]} address.`, steps: [`It looks like a ${looks} address. Sending ${SHORT[hint]} funds to it would likely lose them.`, `Ask the recipient for their ${SHORT[hint]} address.`] };
  }
  if (v.chain === "zcash") {
    const advice = zcashSendAdvice(classifyZcashAddress(address));
    return { ...base, headline: advice.next, steps: [], zcash: advice };
  }
  if (!v.valid) {
    return { ...base, headline: "Don't send: this address has a mistake.", steps: ["A character is wrong or missing, so the address fails its built-in check.", "Copy it again from the source, ideally with a copy button rather than by hand."] };
  }
  return { ...base, ...forChain(v, verdicts) };
}
