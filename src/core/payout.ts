// The payout hop on the destination chain. Pure: `payoutTarget` says where and what to search for a withdrawal, and
// `matchPayout` turns the transfers found there into a verdict. The fetching is in ../payouts.ts.
//
// Matching (from the G1 experiment, ~/NEAR research/experiment-g1, 48 of 50 orders): a candidate is a transfer into
// the destination after the burn that pays at most what was burned and at least that minus the bridge's withdrawal
// fee. Exactly one candidate is the payout; two or more are reported as ambiguous, never picked.

import { chainName } from "./chains.js";
import { tokenRoute, type Bridge, type BridgeReport, type PayoutHop, type PayoutSender, type WithdrawHop } from "./trace.js";

/**
 * The EVM chains whose payouts are read: the five searched on Blockscout, and those NEAR Intents pays out on through the
 * HOT, PoA and Omni bridges, read by the transaction the bridge names (../payouts.ts has an RPC for each).
 */
export const EVM_CHAINS = ["eth", "base", "arb", "op", "gnosis", "bsc", "pol", "avax", "monad", "xlayer", "plasma", "scroll", "adi", "hood", "bera", "abs", "hlevm", "hypercore"] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];
/** UTXO chains the PoA bridge pays out on, read by the payout transaction it names. */
export const UTXO_PAYOUT_CHAINS = ["ltc", "doge", "bch", "dash"] as const;
/** Chains with their own transaction formats, each read by the payout transaction the bridge names. */
export const OTHER_PAYOUT_CHAINS = ["xrp", "sui", "ton", "stellar", "cardano", "aptos", "starknet"] as const;
export type PayoutChain = "tron" | "btc" | "sol" | EvmChain | (typeof UTXO_PAYOUT_CHAINS)[number] | (typeof OTHER_PAYOUT_CHAINS)[number];
const EVM: ReadonlySet<string> = new Set(EVM_CHAINS);
const SUPPORTED: ReadonlySet<string> = new Set([...EVM, ...UTXO_PAYOUT_CHAINS, ...OTHER_PAYOUT_CHAINS, "tron", "btc", "sol"]);

export type PayoutAsset = { kind: "native" } | { kind: "token"; contract: string } | { kind: "any" };

export interface PayoutTarget {
  chain: PayoutChain;
  address: string;
  asset: PayoutAsset;
  burned: bigint;
  burnSec: number;
  /** XRP's destination tag (from the withdrawal's `WITHDRAW_TO:<address>:<tag>` memo): an exchange credits by it. */
  tag?: string;
  /** The NEAR token's base units per destination base unit, when their decimals differ (wrap.near 24, ONEAR 18). */
  scale?: bigint;
}

export interface Incoming {
  tx: string;
  /** Base units, as a decimal string. */
  amount: string;
  /** null: seen but not yet in a block (BTC mempool). */
  timestampSec: number | null;
  /** The token's decimals, when the source says (ERC-20 transfers). */
  decimals?: number | null;
  /** The sender, when the source says (BTC: the first input that is a treasury wallet, else the first input). */
  from?: string | null;
}

/** Transfers into the destination; `complete` is false when the source could not page back to the burn. */
export interface IncomingPage {
  items: Incoming[];
  complete: boolean;
  /** Why the destination's history was not searched at all (a chain with no keyless history source). */
  unsearched?: string;
}

/**
 * Payouts usually land within seconds to ten minutes (BTC: a block or two); before this, "nothing yet" is waiting. Zcash
 * is read from the transaction the bridge names, not a history, so it is not a PayoutChain, but it waits the same.
 */
export function expectedWithinSec(chain: PayoutChain | "zec"): number {
  return chain === "btc" ? 3_600 : 1_800;
}
/** How far after the burn a transfer can still be its payout. */
export const SEARCH_AFTER_SEC = 86_400;
/** Clock skew between NEAR and the destination's block times. */
const SKEW_SEC = 60;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BTC_ADDRESS = /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** As each chain writes its addresses (bech32 and CashAddr in lower case; checked against real PoA payouts, 2024-2026). */
const ADDRESS: Partial<Record<PayoutChain, RegExp>> = {
  ltc: /^(ltc1q[02-9ac-hj-np-z]{38}|ltc1[qp][02-9ac-hj-np-z]{58}|[LM3][1-9A-HJ-NP-Za-km-z]{33})$/,
  doge: /^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/,
  bch: /^[qp][02-9ac-hj-np-z]{41}$/,
  dash: /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  sui: /^0x[0-9a-f]{64}$/,
  aptos: /^0x[0-9a-f]{64}$/,
  starknet: /^0x[0-9a-f]{64}$/,
  ton: /^(?:[EU]Q[A-Za-z0-9_-]{46}|0:[0-9A-F]{64})$/,
  stellar: /^G[A-D][A-Z2-7]{54}$/,
  cardano: /^addr1(?:[02-9ac-hj-np-z]{53}|[02-9ac-hj-np-z]{98})$/,
};

function addressOk(chain: PayoutChain, a: string): boolean {
  if (EVM.has(chain)) return EVM_ADDRESS.test(a);
  if (chain === "tron") return TRON_ADDRESS.test(a);
  if (chain === "btc") return BTC_ADDRESS.test(a);
  const re = ADDRESS[chain];
  return re ? re.test(a) : SOL_ADDRESS.test(a);
}

/** The address as the chain's explorers write it: bech32 and CashAddr in lower case, CashAddr without its prefix. */
function normalized(chain: PayoutChain, a: string): string {
  if (chain === "bch") return a.toLowerCase().replace(/^bitcoincash:/, "");
  if (chain === "ltc" && /^ltc1/i.test(a)) return a.toLowerCase();
  // Sui, Aptos and Starknet addresses are 32-byte values written in hex, often without leading zeros.
  if ((chain === "sui" || chain === "aptos" || chain === "starknet") && /^0x[0-9a-fA-F]{1,64}$/.test(a)) return hex64(a);
  if (chain === "ton" && /^0:[0-9a-fA-F]{64}$/.test(a)) return a.toUpperCase();
  return a;
}

/** A 32-byte hex value as `0x` and 64 lower-case digits. */
export const hex64 = (a: string): string => `0x${a.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;

/** A TON address in its raw form, `<workchain>:<64 upper-case hex>`, from the raw or the user-friendly (`UQ…`/`EQ…`) form. */
export function tonRaw(a: string): string | null {
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(a);
  if (raw) return `${Number(raw[1])}:${(raw[2] ?? "").toUpperCase()}`;
  if (!/^[A-Za-z0-9_-]{48}$/.test(a)) return null;
  let bin: string;
  try {
    bin = atob(a.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (bin.length !== 36) return null;
  const wc = bin.charCodeAt(1) > 127 ? bin.charCodeAt(1) - 256 : bin.charCodeAt(1);
  let hex = "";
  for (let i = 2; i < 34; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return `${wc}:${hex.toUpperCase()}`;
}

/**
 * HOT's Stellar tokens: the id after `1100_` is base58 of the asset's Stellar Asset Contract (as an XDR ScVal). Both
 * seen paid out, XLM and Circle's USDC, each checked against Horizon's `contract_id` for the asset (2026-10-17).
 */
const HOT_STELLAR: Record<string, PayoutAsset> = {
  "v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz": { kind: "native" },
  "v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu": { kind: "token", contract: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
};
/** Omni's NEP-141 tokens as ERC-20s on HyperEVM, and how many NEAR base units one of theirs is. */
const HYPEREVM_TOKENS: Record<string, { contract: string; scale: bigint }> = {
  "wrap.near": { contract: "0xc80d9eb120d6e40e31d5ae9040d5fc0753c52da7", scale: 10n ** 6n }, // ONEAR, 18 decimals
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin's alphabet) to bytes; null for any other character. */
function base58Bytes(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = (hex.length % 2 ? "0" : "") + hex;
  const zeros = s.length - s.replace(/^1+/, "").length;
  const out = new Uint8Array(zeros + body.length / 2);
  for (let i = 0; i < body.length / 2; i++) out[zeros + i] = parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * A HOT token on an EVM chain: its id is `<chain id>_<the token contract in base58>`, and twenty zero bytes are the
 * chain's own coin (`56_11111111111111111111` is BNB; `137_3hpYoaLtt8MP1Z2GH1U473DMRKgr` is USDT on Polygon,
 * 0xc2132d05…8e8f).
 */
function hotAsset(id: string): PayoutAsset | null {
  const m = /^v2_1\.omni\.hot\.tg:\d+_([1-9A-HJ-NP-Za-km-z]*)$/.exec(id);
  const bytes = m?.[1] ? base58Bytes(m[1]) : null;
  if (!bytes || bytes.length !== 20) return null;
  if (bytes.every((b) => b === 0)) return { kind: "native" };
  return { kind: "token", contract: `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` };
}

function assetOf(chain: PayoutChain, contract: string): PayoutAsset | null {
  if (contract === "nbtc.bridge.near" || new RegExp(`^${chain}\\.(omft|omdep)\\.near$`).test(contract)) return { kind: "native" };
  if (contract.startsWith("v2_1.omni.hot.tg:")) {
    if (EVM.has(chain)) return hotAsset(contract);
    if (chain === "ton") return /^v2_1\.omni\.hot\.tg:\d+_$/.test(contract) ? { kind: "native" } : null; // jettons: not yet
    if (chain === "stellar") return HOT_STELLAR[contract] ?? null;
    return null;
  }
  const hyper = chain === "hlevm" || chain === "hypercore" ? HYPEREVM_TOKENS[contract] : undefined;
  if (hyper) return { kind: "token", contract: hyper.contract };
  const erc20 = /^[a-z]+-(0x[0-9a-fA-F]{40})\.omft\.near$/.exec(contract);
  if (erc20?.[1] && EVM.has(chain)) return { kind: "token", contract: erc20[1].toLowerCase() };
  const trc20 = /^tron-([0-9a-f]{40})\.omft\.near$/.exec(contract);
  if (trc20?.[1]) return { kind: "token", contract: trc20[1] };
  // Solana tokens: the NEAR contract does not name the mint, so any incoming transfer of the right size counts.
  if (chain === "sol") return { kind: "any" };
  return null;
}

/** Where and what to search for a withdrawal's payout, or why it cannot be searched. */
export function payoutTarget(w: WithdrawHop): PayoutTarget | { unsupported: string } {
  const routed = w.chain ?? tokenRoute(w.token).chain;
  if (!routed || !SUPPORTED.has(routed)) return { unsupported: `payouts on ${routed ?? "this chain"} are not searched yet` };
  const chain = routed as PayoutChain;
  if (!w.destination) return { unsupported: "the withdrawal names no destination" };
  const address = normalized(chain, w.destination.replace(/^[a-z]+:/i, ""));
  if (!addressOk(chain, address)) return { unsupported: `the destination is not a valid ${chainName(chain)} address` };
  const bare = w.token.replace(/^nep(141|245):/, "");
  const asset = assetOf(chain, bare);
  if (!asset) return { unsupported: `the token ${bare} is not recognised on ${chain}` };
  if (w.timestampNs === null) return { unsupported: "the withdrawal has no block time" };
  const target: PayoutTarget = { chain, address, asset, burned: BigInt(w.amount), burnSec: Number(w.timestampNs / 1_000_000_000n) };
  const hyper = chain === "hlevm" || chain === "hypercore" ? HYPEREVM_TOKENS[bare] : undefined;
  if (hyper) return { ...target, scale: hyper.scale };
  return chain === "xrp" && w.externalId ? { ...target, tag: w.externalId } : target;
}

// The treasury wallets NEAR Intents publishes "for transparency and AML compliance"
// (https://docs.near-intents.org/security-compliance/treasury-addresses, read 2026-10-11). Payouts leave from them:
// every PoA payout in G1 on Ethereum and TRON came from the NEAR Intents one. Refill wallets are left out: they top the
// treasury up and pay no one. TRON is listed in both forms, base58 and the hex TronGrid uses for native transfers.
const EVM_TREASURY: Record<string, string> = {
  "0x2cff890f0378a11913b6129b2e97417a2c302680": "NEAR Intents",
  "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd": "HOT Bridge",
};
const TREASURY: Record<string, Record<string, string>> = {
  tron: { TX5XiRXdyz7sdFwF5mnhT1QoGCpbkncpke: "NEAR Intents", "41e78cc21a0dfb6e840d52652224493b60d02ed628": "NEAR Intents" },
  btc: { "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra": "NEAR Intents" },
  sol: { HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16: "NEAR Intents", "8sXzdKW2jFj7V5heRwPMcygzNH3JZnmie5ZRuNoTuKQC": "HOT Bridge" },
  // Read 2026-10-17; every PoA payout seen on these chains (2024-2026) came from these wallets. BCH is listed in legacy
  // form (1LxByj…), the same key as the CashAddr its payouts show.
  ltc: { LQjEMkuiA2pCwFeUPwsu6ktzUubBVLsahX: "NEAR Intents" },
  doge: { DRmCnxzL9U11EJzLmWkm2ikaZikPFbLuQD: "NEAR Intents" },
  bch: { qrdd5m5s72wzs4u373ux2fcpn02hw00u7v9wr8cex8: "NEAR Intents", "1LxByjYMdnogW9Nc73srT4NCbS8oPVaXvZ": "NEAR Intents" },
  dash: { XxA9DbXaFpF4GFY8KUNX7eAxhZPsWtcKhc: "NEAR Intents" },
  xrp: { r9R8jciZBYGq32DxxQrBPi5ysZm67iQitH: "NEAR Intents" },
  sui: { "0x00ea18889868519abd2f238966cab9875750bb2859ed3a34debec37781520138": "NEAR Intents" },
  aptos: { "0xd1a1c1804e91ba85a569c7f018bb7502d2f13d4742d2611953c9c14681af6446": "NEAR Intents" },
  starknet: { "0x03b79b882cd0310822ebf3fe2be44a828f8939e699f8fd55a69cd70473f69090": "NEAR Intents" },
  cardano: { addr1v8wfpcg4qfhmnzprzysj6j9c53u5j56j8rvhyjp08s53s6g07rfjm: "NEAR Intents" },
  // TON in raw form (the list writes UQAfoBd…_trZ and EQANEViM…CNVJ).
  ton: { "0:1FA0177F7F4A48BCDA543C090E82E52B156A46595F53581799B3FE535C4F79FE": "NEAR Intents", "0:0D11588CDC0290CE2E808F7B047B2A85BBCA57AA1CBD43DC46A0877FD2AA7708": "HOT Bridge" },
  stellar: { GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK: "NEAR Intents", CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG: "HOT Bridge" },
};

/** Which published treasury an address is on a chain, or null. */
export function treasuryOf(chain: string, address: string | null | undefined): string | null {
  if (!address) return null;
  if (EVM.has(chain)) return EVM_TREASURY[address.toLowerCase()] ?? null;
  return TREASURY[chain]?.[address] ?? null;
}

/** The most a bridge keeps as its withdrawal fee (seen in G1: TRON USDT 0.29–1.64, BTC 1,456–1,497 sats, Omni SOL 0). */
function maxFee(t: PayoutTarget, decimals: number | null | undefined): bigint {
  const half = t.burned / 200n; // 0.5 %
  if (t.chain === "btc") return 5_400n; // the connector's fee_min (400 sat) plus its max_btc_gas_fee (5,000 sat)
  if (t.chain === "tron") return t.asset.kind === "native" ? 5_000_000n : 2_500_000n;
  if (t.chain === "sol") return half;
  if (t.asset.kind === "native") return 10n ** 16n; // 0.01 ETH
  const tenTokens = 10n * 10n ** BigInt(decimals ?? 6);
  return tenTokens > half ? tenTokens : half;
}

type Base = { chain: string | null; bridge: Bridge; destination: string | null };

/**
 * The verdict for a payout. With the bridge's own report (`report`: the PoA bridge's status API, or the Omni bridge's
 * indexer), a transfer it names that is on chain into the destination is the payout, `confirmed`; a named transfer we
 * cannot see confirms nothing, and the report rides along.
 */
export function matchPayout(t: PayoutTarget, page: IncomingPage, nowSec: number, base: Base, report?: BridgeReport | null): PayoutHop {
  const b = report ? { ...base, bridgeReport: report } : base;
  const fits = (x: Incoming): boolean => {
    if (!/^\d+$/.test(x.amount)) return false;
    if (x.timestampSec !== null && (x.timestampSec < t.burnSec - SKEW_SEC || x.timestampSec > t.burnSec + SEARCH_AFTER_SEC)) return false;
    const amount = BigInt(x.amount);
    return amount > 0n && amount <= t.burned && amount >= t.burned - maxFee(t, x.decimals);
  };
  const arrived = (x: Incoming, how: "confirmed" | "matched"): PayoutHop => ({
    status: "arrived",
    how,
    ...b,
    tx: x.tx,
    amount: x.amount,
    delaySec: x.timestampSec === null ? null : x.timestampSec - t.burnSec,
    confirmed: x.timestampSec !== null,
    sender: x.from ? { address: x.from, treasury: treasuryOf(t.chain, x.from) } : null,
  });

  // The transfer the bridge names; for an Omni Fast Transfer, the relayer's early payment comes before the bridge's repayment.
  const find = (tx: string | null | undefined): Incoming | undefined => (tx ? page.items.find((x) => x.tx.toLowerCase() === tx.toLowerCase() && /^\d+$/.test(x.amount)) : undefined);
  const named = find(report?.fastTx) ?? find(report?.tx);
  if (named) return arrived(named, "confirmed");

  let cands = page.items.filter(fits);
  // PoA pays from the published treasury: when that tells candidates apart, keep the treasury's.
  if (base.bridge === "poa" && cands.length > 1) {
    const fromTreasury = cands.filter((x) => treasuryOf(t.chain, x.from) !== null);
    if (fromTreasury.length > 0) cands = fromTreasury;
  }
  const waitedSec = Math.max(0, nowSec - t.burnSec);
  const only = cands[0];
  if (cands.length === 1 && only) return arrived(only, "matched");
  if (cands.length > 1) return { status: "ambiguous", ...b, txs: cands.map((c) => c.tx) };
  if (waitedSec < expectedWithinSec(t.chain)) return { status: "waiting", ...b, waitedSec };
  if (!page.complete) return { status: "unverified", ...b, reason: page.unsearched ?? "the destination has too many later transactions to search back to this withdrawal" };
  return { status: "not_found", ...b, waitedSec };
}

const POA_NOTE = "The PoA bridge pays from a custodial wallet and writes nothing on chain that names this withdrawal.";

const OMNI_PAYS = "Omni pays through its bridge and relayers, never from NEAR Intents' treasury wallets";
const ZERO_ADDRESS = /^0x0{40}$/i;

/**
 * Who sent a payout. PoA and HOT pay from published treasury wallets, so a sender off that list is worth saying. Omni
 * pays through its bridge (the Bridge Token Factory mints, or the bridge unlocks) and permissionless relayers that
 * deliver what NEAR's MPC network signed; a Fast Transfer relayer pays early "from their own funds"
 * (docs.near.org /chain-abstraction/omnibridge/implementation). Its sender is named by that role only when the bridge's
 * indexer names the transfer: one matched by amount and time may be anyone's.
 */
function senderLine(p: Extract<PayoutHop, { status: "arrived" }>, sender: PayoutSender): string {
  const a = sender.address;
  if (sender.treasury) return `Sent from ${a}, ${sender.treasury}${sender.treasury.endsWith("s") ? "'" : "'s"} published treasury wallet.`;
  if (p.bridge !== "omni") return `Sent from ${a}, which is not on NEAR Intents' published treasury list.`;
  if (p.how !== "confirmed") return `Sent from ${a}. ${OMNI_PAYS}, so their list does not apply.`;
  // The Solana sender is the transaction's fee payer: whoever submitted the bridge program's transfer.
  if (p.chain === "sol") return `Submitted by ${a}, the relayer that delivered it. ${OMNI_PAYS}.`;
  if (p.chain === "btc") return `Sent from ${a}, an address the Omni bridge spends from, in a transaction NEAR's MPC network signed. ${OMNI_PAYS}.`;
  if (p.chain !== null && EVM.has(p.chain)) {
    return ZERO_ADDRESS.test(a)
      ? `Minted by the Omni bridge's token contract (it comes from the zero address). ${OMNI_PAYS}.`
      : `Sent from ${a}: the Omni bridge unlocking it, or a relayer that paid you early from its own funds (a Fast Transfer). ${OMNI_PAYS}.`;
  }
  return `Sent from ${a}. ${OMNI_PAYS}.`;
}

/** How the payout is known, who sent it and what the bridge reports, in plain sentences shared by every renderer. */
export function payoutEvidence(p: PayoutHop): string[] {
  if (p.status === "missing") return [];
  const out: string[] = [];
  const report = p.bridgeReport;
  if (p.status === "arrived") {
    if (p.how === "proven") out.push(p.via === "transfer" ? "Proven: the transfer to the destination inside NEAR Intents is in this transaction; it credits that account's NEAR Intents balance." : "Proven: the transfer to the destination is inside the withdrawal transaction.");
    else if (p.how === "shielded") {
      out.push(
        `Paid into Zcash's ${p.shieldedPool ?? "shielded"} shielded pool: the transaction the bridge names is ${p.confirmed ? "confirmed" : "waiting to be confirmed"} on the Zcash chain and moved the withdrawal, less the bridge's and the network's fees, into that pool. A shielded output hides its recipient by design, so the destination address cannot be read from the chain.`,
      );
    }
    else if (p.how === "confirmed") {
      const indexer = report?.source === "omni" ? "the Omni bridge's indexer" : report?.source === "hot" ? "the HOT bridge's indexer" : null;
      out.push(
        indexer
          ? `Confirmed by the bridge: ${indexer} names this transfer as the payout of this withdrawal, and it is on chain into the destination. That is the indexer's report checked against the chain, not an on-chain link.`
          : "Confirmed by the bridge: the PoA bridge's status API names this transfer as the payout of this withdrawal, and it is on chain into the destination. That is the operator's report checked against the chain, not an on-chain link.",
      );
      if (report?.fastTx && p.tx.toLowerCase() === report.fastTx.toLowerCase()) {
        out.push(`A relayer paid you early from its own funds (an Omni Fast Transfer); the bridge repays the relayer later${report.tx ? `, in ${report.tx}` : ""}.`);
      }
    } else if (p.how === "recorded") {
      out.push(
        `Recorded by the bridge contract: the Omni bridge contract on ${chainName(p.chain)} marks this transfer (destination nonce ${p.destinationNonce}) as paid, a mark it sets only in a payout that checked the bridge's signature and paid the signed recipient. The bridge's indexer has not named the transaction yet.`,
      );
    } else {
      out.push(`Matched, not proven: the only transfer into the destination that fits the withdrawn amount (less the bridge fee) and time.${p.bridge === "poa" ? ` ${POA_NOTE}` : ""}`);
    }
    if (p.sender) out.push(senderLine(p, p.sender));
  }
  if (report && !(p.status === "arrived" && p.how === "confirmed")) {
    // (A shielded payout keeps the report: it is what names the Zcash transaction.)
    if (report.source === "omni" || report.source === "hot") {
      // Only a search that ran and did not find the named transfer missed it (a chain we do not search was not looked at).
      // For a Fast Transfer the payout is the relayer's early payment.
      const paidIn = report.fastTx ?? report.tx;
      const searchedPast = p.status === "not_found" || p.status === "waiting" || p.status === "ambiguous" || (p.status === "arrived" && p.tx !== null && p.tx.toLowerCase() !== paidIn?.toLowerCase());
      const missed = paidIn && searchedPast ? ", which was not found among the transfers into the destination that we read" : "";
      out.push(`The ${report.source === "omni" ? "Omni" : "HOT"} bridge's indexer reports this transfer as ${report.status}${paidIn ? `, paid out in ${paidIn}${report.fastTx ? " by a relayer, early (a Fast Transfer)" : ""}` : ""}${missed}.`);
    } else if (report.status === "COMPLETED" && report.tx) out.push(`The PoA bridge's status API says it sent ${report.tx}, which was not found among transfers into the destination.`);
    else out.push(`The PoA bridge's status API reports this withdrawal as ${report.status}.`);
  }
  return out;
}
