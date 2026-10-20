import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkOrder, resolveInput, searchPayout, type NearClient } from "./check.js";
import { whoCanMove } from "./core/custody.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./core/fastnear.js";
import type { IncomingPage, PayoutTarget } from "./core/payout.js";
import type { BridgeReport, WithdrawHop } from "./core/trace.js";
import { publicPayoutClient, type PayoutClient } from "./payouts.js";
import { renderText } from "./render-text.js";

const ACCOUNT_358 = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
const SWAP_TX = "E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB";
const DEPOSIT_TX = "8a33DkKfZMWRKbK2pXuQAWVLXSy4AyZF6PfcENvCJgCb";
const NOW = 1791_000_000_000_000_000n;
const LATER = 1_792_000_000_000_000_000n; // 2026-10-14

const fixture = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-txs-358.json", import.meta.url), "utf8"));
const records = fixture.transactions.map(decodeFastnearTx);

/** A client that only knows the #358 order: its account history and its two transactions. */
function stubClient(log: string[] = []): NearClient {
  return {
    async accountTxs(account) {
      log.push(`account:${account}`);
      if (account !== ACCOUNT_358) return [];
      return records.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n }));
    },
    async transactions(hashes) {
      log.push(`txs:${hashes.join(",")}`);
      return records.filter((r) => hashes.includes(r.hash));
    },
  };
}

describe("resolveInput", () => {
  it("accepts a 64-hex order account, trimmed and lower-cased", () => {
    expect(resolveInput(`  ${ACCOUNT_358.toUpperCase()} `)).toEqual({ kind: "account", account: ACCOUNT_358 });
  });
  it("accepts a named NEAR account", () => {
    expect(resolveInput("alice.near")).toEqual({ kind: "account", account: "alice.near" });
  });
  it("accepts a NEAR transaction hash", () => {
    expect(resolveInput(SWAP_TX)).toEqual({ kind: "tx", hash: SWAP_TX });
  });
  it("tells an EVM transaction hash apart, since it cannot be looked up on NEAR yet", () => {
    expect(resolveInput("0x032c9cf59668a4ff2a2b8f7f9d05bb4dda950b3c0a8ed555d099652bd7be4f4f")).toEqual({ kind: "unsupported", reason: "origin-chain transaction hashes are not searchable yet; paste the NEAR transaction or the order account" });
  });
  it("rejects anything else", () => {
    expect(resolveInput("hello world")).toEqual({ kind: "unsupported", reason: "not a NEAR account or transaction hash" });
  });

  // docs.near.org /web3-apps/tutorials/account-validation; NEP-655 (universal accounts, protocol 88, 2026-11-03).
  it("accepts the account shapes NEAR Intents users have: 0x (EVM, TRON and passkey keys), 0s deterministic, 0u universal", () => {
    expect(resolveInput("0xB0198a21BEAD20023a36fb4ee71591074b89d8b4")).toEqual({ kind: "account", account: "0xb0198a21bead20023a36fb4ee71591074b89d8b4" });
    const det = `0s${"ab12".repeat(10)}`;
    expect(resolveInput(det)).toEqual({ kind: "account", account: det });
    const universal = `0u${"a7k9".repeat(12)}xyz0`;
    expect(universal).toHaveLength(54);
    expect(resolveInput(universal)).toEqual({ kind: "account", account: universal });
  });

  it("accepts any valid named account, not only .near and .tg (token.sweat, a top-level name)", () => {
    expect(resolveInput("token.sweat")).toEqual({ kind: "account", account: "token.sweat" });
    expect(resolveInput("Intents.Near")).toEqual({ kind: "account", account: "intents.near" });
    expect(resolveInput("a")).toEqual({ kind: "unsupported", reason: "not a NEAR account or transaction hash" });
    expect(resolveInput("bad..name.near")).toEqual({ kind: "unsupported", reason: "not a NEAR account or transaction hash" });
  });
});

describe("checkOrder on an account that is not one order", () => {
  it("an empty 0x account may be an EVM wallet or a deposit address: says what to paste instead", async () => {
    const empty: NearClient = { accountTxs: async () => [], transactions: async () => [] };
    await expect(checkOrder("0xb0198a21bead20023a36fb4ee71591074b89d8b4", empty, NOW)).rejects.toThrow(
      "0xb0198a21bead20023a36fb4ee71591074b89d8b4 has no NEAR Intents history. If it is your EVM wallet or a 1Click deposit address, paste your deposit transaction instead.",
    );
  });
});

describe("checkOrder", () => {
  it("traces an order from its account: history, then the transactions in batches", async () => {
    const log: string[] = [];
    const result = await checkOrder(ACCOUNT_358, stubClient(log), NOW);
    expect(result.account).toBe(ACCOUNT_358);
    expect(result.verdict).toBe("settled");
    expect(result.swaps[0]?.tx).toBe(SWAP_TX);
    expect(log).toEqual([`account:${ACCOUNT_358}`, `txs:${SWAP_TX},${DEPOSIT_TX}`]);
  });

  it("traces an order from its swap transaction by finding the order account in it", async () => {
    const result = await checkOrder(SWAP_TX, stubClient(), NOW);
    expect(result.account).toBe(ACCOUNT_358);
    expect(result.resolvedFrom).toEqual({ kind: "tx", hash: SWAP_TX });
    expect(result.verdict).toBe("settled");
  });

  it("traces an order from its deposit transaction", async () => {
    const result = await checkOrder(DEPOSIT_TX, stubClient(), NOW);
    expect(result.account).toBe(ACCOUNT_358);
    expect(result.deposits).toHaveLength(1);
  });

  it("reports not_found for an account with no history", async () => {
    const result = await checkOrder("nobody.near", stubClient(), NOW);
    expect(result.verdict).toBe("not_found");
  });

  it("fails clearly on a transaction that does not touch intents.near", async () => {
    const client: NearClient = {
      ...stubClient(),
      async transactions() {
        return [{ hash: "Other", signer: "a.near", receiver: "b.near", height: 1, timestampNs: 1n, actions: [], events: [], plainLogs: [], receiptActions: [] }];
      },
    };
    await expect(checkOrder("HV42hanyDVK3MYoW8c17Ufxw83htNEQGk93bzyQRocvS", client, NOW)).rejects.toThrow(/no NEAR Intents order/);
  });
});

describe("checkOrder with a receipt id", () => {
  it("falls back to the receipt's parent transaction when the hash is not a transaction", async () => {
    const RECEIPT = "G1cb38g2DPc5xw74YXVirrhmHyM642Pqs5pTZNY8aFCg";
    const deposit = records.find((r) => r.hash === DEPOSIT_TX);
    if (!deposit) throw new Error("fixture lacks the deposit");
    const client: NearClient = {
      ...stubClient(),
      async transactions(hashes) {
        return records.filter((r) => hashes.includes(r.hash));
      },
      async receiptTx(id) {
        return id === RECEIPT ? deposit : null;
      },
    };
    const result = await checkOrder(RECEIPT, client, NOW);
    expect(result.account).toBe(ACCOUNT_358);
    expect(result.resolvedVia).toBe("receipt");
    expect(result.verdict).toBe("settled");
  });
});

describe("checkOrder: the payout hop on the destination chain", () => {
  const page = (items: IncomingPage["items"], complete = true): IncomingPage => ({ items, complete });
  const client = (answer: (t: PayoutTarget) => Promise<IncomingPage>, seen: PayoutTarget[] = []): PayoutClient => ({
    async incoming(t) {
      seen.push(t);
      return answer(t);
    },
  });

  it("without a payout client the hop stays unverified (the old behaviour)", async () => {
    const r = await checkOrder(ACCOUNT_358, stubClient(), NOW);
    expect(r.payout.status).toBe("unverified");
  });

  it("searches the withdrawal's destination and reports the one transfer that fits as the payout", async () => {
    const plain = await checkOrder(ACCOUNT_358, stubClient(), NOW);
    const w = plain.withdrawals[0];
    if (!w || w.timestampNs === null) throw new Error("fixture lacks the withdrawal");
    const seen: PayoutTarget[] = [];
    const paidAt = Number(w.timestampNs / 1_000_000_000n) + 40;
    const r = await checkOrder(ACCOUNT_358, stubClient(), NOW, undefined, client(async () => page([{ tx: "0xpayout", amount: w.amount, timestampSec: paidAt }]), seen));
    expect(seen[0]).toMatchObject({ chain: "eth", address: "0x632F5D32448DE43b8b9cfD063aCfcDac09108bad", burned: BigInt(w.amount) });
    expect(r.payout).toMatchObject({ status: "arrived", how: "matched", tx: "0xpayout", delaySec: 40 });
    expect(r.flags.map((f) => f.kind)).not.toContain("payout_not_found");
  });

  it("flags a payout that never reached the destination", async () => {
    const r = await checkOrder(ACCOUNT_358, stubClient(), NOW, undefined, client(async () => page([])));
    expect(r.payout.status).toBe("not_found");
    expect(r.flags).toContainEqual(expect.objectContaining({ kind: "payout_not_found", detail: "no transfer of about the withdrawn amount reached the destination address" }));
  });

  it("asks the PoA bridge about the withdrawal; the transfer it names, found on chain, is confirmed", async () => {
    const plain = await checkOrder(ACCOUNT_358, stubClient(), NOW);
    const w = plain.withdrawals[0];
    if (!w || w.timestampNs === null || !w.tx) throw new Error("fixture lacks the withdrawal");
    const at = Number(w.timestampNs / 1_000_000_000n);
    const asked: string[][] = [];
    const payouts: PayoutClient = {
      incoming: async () => page([{ tx: "0xa", amount: w.amount, timestampSec: at + 10 }, { tx: "0xb", amount: w.amount, timestampSec: at + 20 }]),
      bridgeWithdrawal: async (nearTx, token) => {
        asked.push([nearTx, token]);
        return { status: "COMPLETED", tx: "0xb" };
      },
    };
    const r = await checkOrder(ACCOUNT_358, stubClient(), NOW, undefined, payouts);
    expect(asked).toEqual([[w.tx, w.token]]);
    expect(r.payout).toMatchObject({ status: "arrived", how: "confirmed", tx: "0xb", bridgeReport: { status: "COMPLETED", tx: "0xb" } });
  });

  it("a bridge API failure changes nothing: the on-chain match stands", async () => {
    const plain = await checkOrder(ACCOUNT_358, stubClient(), NOW);
    const w = plain.withdrawals[0];
    if (!w || w.timestampNs === null) throw new Error("fixture lacks the withdrawal");
    const at = Number(w.timestampNs / 1_000_000_000n);
    const payouts: PayoutClient = {
      incoming: async () => page([{ tx: "0xa", amount: w.amount, timestampSec: at + 10 }]),
      bridgeWithdrawal: async () => Promise.reject(new Error("HTTP 502")),
    };
    const r = await checkOrder(ACCOUNT_358, stubClient(), NOW, undefined, payouts);
    expect(r.payout).toMatchObject({ status: "arrived", how: "matched", tx: "0xa" });
    expect(r.payout).not.toHaveProperty("bridgeReport");
  });

  it("a destination API failure leaves the hop unverified with the reason, never a false alarm", async () => {
    const r = await checkOrder(ACCOUNT_358, stubClient(), NOW, undefined, client(async () => Promise.reject(new Error("eth.blockscout.com /api/v2/x: HTTP 503"))));
    expect(r.payout).toMatchObject({ status: "unverified", reason: "could not read eth: eth.blockscout.com /api/v2/x: HTTP 503" });
    expect(r.flags.map((f) => f.kind)).not.toContain("payout_not_found");
  });
});

describe("checkOrder: a ZEC payout through the Omni bridge", () => {
  // Order 496c306d… (FastNEAR tx API, recorded 2026-10-14): LTC swapped to ZEC in the ZODL wallet, sent to omni.bridge.near.
  const ZEC_ACCOUNT = "496c306d31e6cf622c6ebba95a2ce795bfc11c076abb5f1ac0170104b1743f2c";
  const zec = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-omni-zec-order.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const near: NearClient = {
    async accountTxs(account) {
      return account === ZEC_ACCOUNT ? zec.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n })) : [];
    },
    async transactions(hashes) {
      return zec.filter((r) => hashes.includes(r.hash));
    },
  };
  const PAID = "064ff3c012168e5a07d797395cc43b1770cc8167cc1ff4ab163871870ecfb6a4";

  it("asks the Omni bridge's indexer, not the PoA bridge, and keeps the Zcash payout it names", async () => {
    const asked: string[] = [];
    const payouts: PayoutClient = {
      incoming: async () => Promise.reject(new Error("no Zcash reader")),
      bridgeWithdrawal: async () => {
        asked.push("poa");
        return null;
      },
      omniTransfer: async (nearTx, token, amount) => {
        asked.push(`omni ${nearTx} ${token} ${amount}`);
        return { source: "omni", status: "Settled", tx: PAID };
      },
    };
    const r = await checkOrder(ZEC_ACCOUNT, near, 1_792_000_000_000_000_000n, undefined, payouts);
    expect(asked).toEqual(["omni DmNAX4juTqPhTU5XavQwGDxhuo7dngmYpFsdVr6f1QHf nep141:zec.omft.near 55158859"]);
    expect(r.verdict).toBe("settled");
    expect(r.payout).toMatchObject({ status: "unverified", bridge: "omni", chain: "zec", reason: "payouts on zec are not searched yet", bridgeReport: { source: "omni", status: "Settled", tx: PAID } });
  });
});

describe("checkOrder: a payout the bridge names is read by its transaction", () => {
  // Order 4f2fd107… (recorded 2026-10-14): SOL through the Omni bridge to an address with a long history.
  const SOL_ACCOUNT = "4f2fd1070a623656669739d0c8d95f742469bba6c1c9fbf1ad760db9eb0b774b";
  const sol = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-omni-sol-order.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const near: NearClient = {
    async accountTxs(account) {
      return account === SOL_ACCOUNT ? sol.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n })) : [];
    },
    async transactions(hashes) {
      return sol.filter((r) => hashes.includes(r.hash));
    },
  };
  const PAID = "3Pho1AA4FCiM6ShMaPtqoMmJmDPvLpVFviuMnKHpgEn2cvpP4ty5DEumkhkmF1vsTiTrXPAanYjQJp585Pj9297X";
  const read: string[] = [];
  const payouts = (incoming: PayoutClient["incoming"]): PayoutClient => ({
    incoming,
    omniTransfer: async () => ({ source: "omni", status: "Settled", tx: PAID }),
    payoutTx: async (t, tx) => {
      read.push(`${t.chain} ${tx}`);
      return tx === PAID ? { tx, amount: "384642580", timestampSec: 1_782_395_895, from: "DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn" } : null;
    },
  });

  it("when the destination's history does not reach back to it, the named transaction is read and confirmed", async () => {
    const r = await checkOrder(SOL_ACCOUNT, near, LATER, undefined, payouts(async () => ({ items: [], complete: false })));
    expect(read).toContain(`sol ${PAID}`);
    expect(r.payout).toMatchObject({ status: "arrived", how: "confirmed", tx: PAID, amount: "384642580", bridgeReport: { source: "omni", tx: PAID } });
  });

  it("an Omni Fast Transfer: the relayer's early payment is read by its id and is the payout", async () => {
    const asked: string[] = [];
    const fast: PayoutClient = {
      incoming: async () => ({ items: [], complete: false }),
      omniTransfer: async () => ({ source: "omni", status: "Settled", tx: "RepaysTheRelayer", fastTx: PAID }),
      payoutTx: async (t, tx) => {
        asked.push(tx);
        return tx === PAID ? { tx, amount: "384642580", timestampSec: 1_782_395_895, from: "DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn" } : null;
      },
    };
    const r = await checkOrder(SOL_ACCOUNT, near, LATER, undefined, fast);
    expect(asked).toEqual([PAID]);
    expect(r.payout).toMatchObject({ status: "arrived", how: "confirmed", tx: PAID });
  });

  it("when the destination's history cannot be read at all, the named transaction still settles it", async () => {
    const r = await checkOrder(SOL_ACCOUNT, near, LATER, undefined, payouts(async () => Promise.reject(new Error("api.mainnet-beta.solana.com /: HTTP 403"))));
    expect(r.payout).toMatchObject({ status: "arrived", how: "confirmed", tx: PAID });
  });

  it("no payout named yet, but the destination's Omni bridge contract records the transfer as paid: recorded, not missing", async () => {
    const asked: string[] = [];
    const client: PayoutClient = {
      incoming: async () => ({ items: [], complete: true }),
      omniTransfer: async () => ({ source: "omni", status: "Signed", tx: null, destinationNonce: 20540 }),
      omniPaid: async (chain, nonce) => {
        asked.push(`${chain} ${nonce}`);
        return true;
      },
    };
    const r = await checkOrder(SOL_ACCOUNT, near, LATER, undefined, client);
    expect(asked).toEqual(["sol 20540"]);
    expect(r.payout).toMatchObject({ status: "arrived", how: "recorded", tx: null, amount: null, destinationNonce: 20540, bridgeReport: { source: "omni", status: "Signed" } });
    expect(r.flags.map((f) => f.kind)).not.toContain("payout_not_found");
    const c = whoCanMove(r);
    expect(c.place).toBe("arrived");
    expect(c.holds).toContain("the Omni bridge contract there records this transfer (destination nonce 20540) as paid");
    expect(c.needsHelp).toBe(false);
    expect(renderText(r)).toContain("5 Payout       recorded");
    expect(renderText(r)).not.toContain("null");
  });

  it("when the contract has no record of it either, the payout is still unseen", async () => {
    const client: PayoutClient = {
      incoming: async () => ({ items: [], complete: true }),
      omniTransfer: async () => ({ source: "omni", status: "Signed", tx: null, destinationNonce: 20540 }),
      omniPaid: async () => false,
    };
    const r = await checkOrder(SOL_ACCOUNT, near, LATER, undefined, client);
    expect(r.payout.status).not.toBe("arrived");
  });
});

describe("checkOrder: an Omni payout whose token has no reader on its chain, but whose bridge contract records it", () => {
  // Order 4669209b… (recorded 2026-10-18): 299.4 ZEC withdrawn to Starknet through the Omni bridge on 3 Sep. The indexer
  // still lists the transfer as Signed; Starknet's bridge contract marks its destination nonce, 193, as paid.
  const ACCOUNT = "4669209b283cba2c2f01ac82ef7be3494e66cc101a984d5c7691816e05ac9954";
  const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-omni-zec-starknet-order.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const near: NearClient = {
    async accountTxs(account) {
      return account === ACCOUNT ? txs.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n })) : [];
    },
    async transactions(hashes) {
      return txs.filter((r) => hashes.includes(r.hash));
    },
  };
  const client = (paid: boolean | null): PayoutClient => ({
    incoming: async () => Promise.reject(new Error("no reader for ZEC on Starknet")),
    omniTransfer: async () => ({ source: "omni", status: "Signed", tx: null, destinationNonce: 193 }),
    omniPaid: async (chain, nonce) => (chain === "starknet" && nonce === 193 ? paid : null),
  });

  it("reads recorded, though no reader knows ZEC on Starknet", async () => {
    const r = await checkOrder(ACCOUNT, near, LATER, undefined, client(true));
    expect(r.payout).toMatchObject({ status: "arrived", how: "recorded", chain: "starknet", destinationNonce: 193, bridgeReport: { status: "Signed" } });
  });

  it("and stays unverified, with its reason, when the contract has no record of it", async () => {
    const r = await checkOrder(ACCOUNT, near, LATER, undefined, client(false));
    expect(r.payout).toMatchObject({ status: "unverified", reason: "the token zec.omft.near is not recognised on starknet" });
  });
});

describe("checkOrder: a ZEC payout into a shielded pool", () => {
  const ZEC_ACCOUNT = "496c306d31e6cf622c6ebba95a2ce795bfc11c076abb5f1ac0170104b1743f2c";
  const zec = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/fastnear-omni-zec-order.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const near: NearClient = {
    async accountTxs(account) {
      return account === ZEC_ACCOUNT ? zec.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n })) : [];
    },
    async transactions(hashes) {
      return zec.filter((r) => hashes.includes(r.hash));
    },
  };
  const PAID = "064ff3c012168e5a07d797395cc43b1770cc8167cc1ff4ab163871870ecfb6a4";
  const AT = Date.parse("2026-10-13T20:35:09Z") / 1000;
  const client = (shieldedZat: bigint): PayoutClient => ({
    incoming: async () => Promise.reject(new Error("no Zcash history reader")),
    omniTransfer: async () => ({ source: "omni", status: "Settled", tx: PAID }),
    zcashTx: async (txid) => (txid === PAID ? { confirmedAtSec: AT, outputs: [{ address: "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua", valueZat: 36_714_178n }], shieldedIn: [{ pool: "Ironwood", zat: shieldedZat }] } : null),
  });

  it("the named Zcash transaction is confirmed and moved the withdrawal, less fees, into the Ironwood pool: paid, shielded", async () => {
    const r = await checkOrder(ZEC_ACCOUNT, near, LATER, undefined, client(55_133_859n));
    const burnSec = Number((r.withdrawals[0]?.timestampNs ?? 0n) / 1_000_000_000n);
    expect(r.payout).toMatchObject({ status: "arrived", how: "shielded", tx: PAID, amount: "55133859", shieldedPool: "Ironwood", confirmed: true, delaySec: AT - burnSec, bridgeReport: { source: "omni" } });
  });

  it("an amount that does not fit this withdrawal is not claimed as its payout", async () => {
    const r = await checkOrder(ZEC_ACCOUNT, near, LATER, undefined, client(90_000_000n));
    expect(r.payout).toMatchObject({ status: "unverified", reason: "the Zcash transaction the bridge names moved a different amount into the shielded pool than this withdrawal (it may pay several transfers)" });
  });
});

describe("fastnearClient: account history", () => {
  it("refuses an account with more history than one order has, instead of tracing a cut-off history", async () => {
    const { fastnearClient } = await import("./check.js");
    const page = (n: number) => JSON.stringify({ account_txs: Array.from({ length: 200 }, (_, i) => ({ transaction_hash: `t${n}-${i}`, tx_block_height: n * 1000 + i, tx_block_timestamp: "1" })), resume_token: `r${n}`, txs_count: 9038 });
    let n = 0;
    const fetchImpl = (async () => new Response(page(n++), { status: 200 })) as typeof fetch;
    await expect(fastnearClient(fetchImpl, undefined, async () => undefined).accountTxs("0xb0198a21bead20023a36fb4ee71591074b89d8b4")).rejects.toThrow(
      "0xb0198a21bead20023a36fb4ee71591074b89d8b4 has 9038 transactions: that is a wallet account, not one swap. Paste the swap's NEAR transaction or your deposit transaction instead.",
    );
  });
});

describe("fastnearClient: rate limits", () => {
  it("waits and retries a 429 before giving up", async () => {
    const { fastnearClient } = await import("./check.js");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < 3 ? new Response("slow down", { status: 429 }) : new Response('{"transactions":[]}', { status: 200 });
    }) as typeof fetch;
    const waits: number[] = [];
    expect(await fastnearClient(fetchImpl, undefined, async (ms) => void waits.push(ms)).transactions(["x"])).toEqual([]);
    expect(calls).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("honours Retry-After, and tries a third time", async () => {
    const { fastnearClient } = await import("./check.js");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "3" } }) : calls < 4 ? new Response("slow down", { status: 429 }) : new Response('{"transactions":[]}', { status: 200 });
    }) as typeof fetch;
    const waits: number[] = [];
    expect(await fastnearClient(fetchImpl, undefined, async (ms) => void waits.push(ms)).transactions(["x"])).toEqual([]);
    expect(waits).toEqual([3_000, 2_000, 4_000]);
  });

  it("still names the endpoint and status when the limit does not clear", async () => {
    const { fastnearClient } = await import("./check.js");
    const fetchImpl = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
    await expect(fastnearClient(fetchImpl, undefined, async () => undefined).transactions(["x"])).rejects.toThrow("FastNEAR /v0/transactions: HTTP 429");
  });
});

describe("checkOrder: a leftover worth less than 5 US cents", () => {
  // Order 1dc2887e… (accuracy audit, 2026-10-14): a SWEAT-app micro order that left 1.3e-8 ETH behind after its payout.
  const ACCOUNT = "1dc2887e846e7c24952efb0ded767aa8a851198f0a89a35db4d860e7efb376a5";
  const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/1dc2887e.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const client: NearClient = {
    async accountTxs() {
      return txs.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n }));
    },
    async transactions(hashes) {
      return txs.filter((r) => hashes.includes(r.hash));
    },
  };
  const incoming = async (): Promise<IncomingPage> => ({ items: [], complete: true });

  it("is dust when the payout client knows the token's price", async () => {
    const r = await checkOrder(ACCOUNT, client, LATER, undefined, { incoming, dustBelow: async () => ({ "nep141:base.omft.near": "19988726358333" }) });
    expect(r.verdict).toBe("settled");
    expect(r.flags.map((f) => f.kind)).toEqual(["dust"]);
  });

  it("without prices (the token list cannot be read) the order is traced as before", async () => {
    const r = await checkOrder(ACCOUNT, client, LATER, undefined, {
      incoming,
      dustBelow: async () => {
        throw new Error("HTTP 503");
      },
    });
    expect(r.verdict).toBe("stuck");
  });
});

describe("checkOrder: a Base payout while Blockscout answers with a Cloudflare challenge", () => {
  // Order e0de3c0a… (accuracy audit, 2026-10-14): base.blockscout.com returned 403 to every call, so its payout was
  // never verified. The PoA bridge names the payout; the checker now reads that transaction from mainnet.base.org.
  const ACCOUNT = "e0de3c0ab277181582af5c0e4c5b4c9163c12be96d4809202d9e0733834adee8";
  const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/e0de3c0a.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const client: NearClient = {
    async accountTxs() {
      return txs.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n }));
    },
    async transactions(hashes) {
      return txs.filter((r) => hashes.includes(r.hash));
    },
  };
  const payload = (name: string): string => readFileSync(new URL(`./fixtures/payouts/${name}`, import.meta.url), "utf8");
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
    if (url.startsWith("https://base.blockscout.com/")) return new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403 });
    if (url === "https://bridge.chaindefuser.com/rpc") return new Response(payload("poa-status-base-usdc.json"), { status: 201 });
    if (url === "https://mainnet.base.org" && method === "eth_getTransactionReceipt") return new Response(payload("base-usdc-receipt.json"));
    if (url === "https://mainnet.base.org" && method === "eth_getBlockByNumber") return new Response(payload("base-usdc-block.json"));
    return new Response("not recorded", { status: 404 });
  }) as typeof fetch;

  it("confirms the payout the bridge names, from the NEAR Intents treasury", async () => {
    const r = await checkOrder(ACCOUNT, client, LATER, undefined, publicPayoutClient(fake));
    expect(r.payout).toMatchObject({
      status: "arrived",
      how: "confirmed",
      chain: "base",
      tx: "0x192a5193445af41a4528954c77c277e4b0c5f9f000c2d18f2db68fce0215795b",
      amount: "24947600",
      sender: { address: "0x2cff890f0378a11913b6129b2e97417a2c302680", treasury: "NEAR Intents" },
    });
  });
});

describe("checkOrder: an account that held two separate orders (62f55aaa…, accuracy audit)", () => {
  const ACCOUNT = "62f55aaa5b8879f8fe78e209270b62eaf179500b19c6e59017fc37007d5cf1a3";
  const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/62f55aaa.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const client: NearClient = {
    async accountTxs(account) {
      return account === ACCOUNT ? txs.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n })) : [];
    },
    async transactions(hashes) {
      return txs.filter((r) => hashes.includes(r.hash));
    },
  };
  const payouts: PayoutClient = { incoming: async () => ({ items: [], complete: true }), dustBelow: async () => ({ "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": "50000" }) };

  it("a pasted transaction of the first order (its deposit) follows that order, not the latest", async () => {
    const r = await checkOrder("HrHkph6YoTSQ29VP4W8JUhGyL43ZJb6pgaxnAjDGKLLK", client, LATER, undefined, payouts);
    expect(r.account).toBe(ACCOUNT);
    expect(r.payout).toMatchObject({ destination: "ccbcc365b7cd1f563c612957e81c1ba437bb4a0a41464f0900cb18337f264abc" });
    expect(r.flags[0]).toMatchObject({ kind: "several_orders", count: 2, shown: 1 });
  });

  it("the pasted account follows the latest order", async () => {
    const r = await checkOrder(ACCOUNT, client, LATER, undefined, payouts);
    expect(r.payout).toMatchObject({ destination: "f46d044760548bad7ae11fd42d9a4f86e5a308c6dd024a6a88675c01bb953672" });
  });
});

describe("checkOrder while a transaction is still executing", () => {
  // The #358 order read mid-flight: its swap-and-withdraw transaction cut after block 217,478,802, when the intents had
  // run but the token's transfer to the PoA bridge had not.
  const cut = (height: number) => fixture.transactions.map((t) => decodeFastnearTx(t.transaction.hash === SWAP_TX ? { ...t, receipts: t.receipts.filter((r) => r.execution_outcome.block_height <= height) } : t));
  const midFlight = cut(217_478_802);
  const client = (txs: typeof midFlight): NearClient => ({
    async accountTxs() {
      return txs.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n }));
    },
    async transactions(hashes) {
      return txs.filter((r) => hashes.includes(r.hash));
    },
  });
  const swapAt = midFlight.find((t) => t.hash === SWAP_TX)?.timestampNs ?? 0n;

  it("is in progress, and the destination chain is not searched until the withdrawal has run", async () => {
    const asked: string[] = [];
    const payouts: PayoutClient = {
      incoming: async () => {
        asked.push("incoming");
        return { items: [], complete: true };
      },
      bridgeWithdrawal: async () => {
        asked.push("bridge");
        return null;
      },
    };
    const r = await checkOrder(ACCOUNT_358, client(midFlight), swapAt + 3n * 1_000_000_000n, undefined, payouts);
    expect(r.verdict).toBe("in_progress");
    expect(r.flags[0]).toMatchObject({ kind: "executing", tx: SWAP_TX });
    expect(r.payout).toMatchObject({ status: "waiting", waitedSec: 3 });
    expect(asked).toEqual([]);
  });

  it("a pasted transaction that has not run anything yet says so", async () => {
    await expect(checkOrder(SWAP_TX, client(cut(0)), swapAt)).rejects.toThrow(`transaction ${SWAP_TX} is still executing on NEAR: check again in a minute`);
  });
});

describe("checkOrder: a token payout to a named account nobody has created", () => {
  // A token contract registers any valid name: NEP-141 storage_deposit has no existence check (near-sdk-rs
  // near-contract-standards storage_impl.rs; a contract cannot ask whether an account exists), and intents.near's
  // ft_withdraw pays that storage_deposit for the receiver before ft_transfer (near/intents nep141/withdraw.rs,
  // do_ft_withdraw). So a token withdrawal to a name nobody created is credited under that name, and whoever creates
  // the name first controls it. Order 38e7e63b… (accuracy audit): ZEC on NEAR withdrawn to hideon.near, which exists
  // (view_account, 2026-10-14); here the client says it does not.
  const ACCOUNT = "38e7e63b1f1209582f96662754713c446e187d27c6eaae66ba139be8a94fd0a6";
  const named = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/38e7e63b.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const client = (txs: typeof named, exists: boolean | null, asked: string[] = []): NearClient => ({
    async accountTxs() {
      return txs.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n }));
    },
    async transactions(hashes) {
      return txs.filter((r) => hashes.includes(r.hash));
    },
    async accountExists(account) {
      asked.push(account);
      return exists;
    },
  });

  it("flags it: the token contract holds the payout under a name nobody holds yet", async () => {
    const asked: string[] = [];
    const r = await checkOrder(ACCOUNT, client(named, false, asked), LATER);
    expect(asked).toEqual(["hideon.near"]);
    expect(r.payout).toMatchObject({ status: "arrived", destination: "hideon.near" });
    expect(r.verdict).toBe("settled");
    expect(r.flags).toContainEqual({
      kind: "destination_missing",
      account: "hideon.near",
      detail: "no NEAR account is named hideon.near yet: the token contract holds the payout under that name, and whoever creates hideon.near first controls it",
    });
  });

  it("an account that exists, or an RPC that cannot tell, changes nothing", async () => {
    for (const exists of [true, null]) expect((await checkOrder(ACCOUNT, client(named, exists), LATER)).flags.map((f) => f.kind)).not.toContain("destination_missing");
  });

  it("an implicit (64-hex) destination is never asked about: its key alone controls it, created or not (order 0969f61f…)", async () => {
    const implicit = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("./fixtures/audit/0969f61f.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
    const asked: string[] = [];
    const r = await checkOrder("0969f61f8c6f40283c515b28112494811ba99a06c55fb68f15dd8ceeccd42e3e", client(implicit, false, asked), LATER);
    expect(r.payout).toMatchObject({ status: "arrived", bridge: "near" });
    expect(asked).toEqual([]);
  });
});

describe("checkOrder: where the money is, checked against intents.near's own balances at a final block", () => {
  // docs.near.org /integrations/balance-changes: "For custody purposes, query finalized state." Order 38f7db08… (accuracy
  // audit): its history adds up to 1300 Solana USDT left; intents.near said 1300 at block 219,921,623 (2026-10-14).
  const ACCOUNT = "38f7db08ab47b93f5a81c67f1409197051dc3a54cc73aa4c64977e8826ca265e";
  const SOL_USDT = "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
  const BLOCK = "8LvS9PHrRdffJp2SosWPUDXLH7pcmgEw4EwkewG74xo2";
  const txsOf = (prefix: string) => parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL(`./fixtures/audit/${prefix}.json`, import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
  const client = (txs: ReturnType<typeof txsOf>, chain: Record<string, string> | null, asked: string[] = []): NearClient => ({
    async accountTxs() {
      return txs.map((r) => ({ hash: r.hash, height: r.height ?? 0, timestampNs: r.timestampNs ?? 0n }));
    },
    async transactions(hashes) {
      return txs.filter((r) => hashes.includes(r.hash));
    },
    async intentsBalances(account) {
      asked.push(account);
      return chain === null ? null : { blockHeight: 219_921_623, blockHash: BLOCK, balances: chain };
    },
  });

  it("the same: verified, with the block anyone can re-read", async () => {
    const r = await checkOrder(ACCOUNT, client(txsOf("38f7db08"), { [SOL_USDT]: "1300" }), LATER);
    expect(r.balances).toEqual({ [SOL_USDT]: "1300" });
    expect(r.balanceCheck).toEqual({ status: "verified", blockHeight: 219_921_623, blockHash: BLOCK });
    expect(r.flags.map((f) => f.kind)).not.toContain("ledger_mismatch");
  });

  it("different numbers are flagged with the chain's, never hidden", async () => {
    const r = await checkOrder(ACCOUNT, client(txsOf("38f7db08"), { [SOL_USDT]: "104724" }), LATER);
    expect(r.balanceCheck).toMatchObject({ status: "differs", differences: [{ token: SOL_USDT, ledger: "1300", chain: "104724" }] });
    expect(r.flags).toContainEqual(expect.objectContaining({ kind: "ledger_mismatch" }));
  });

  it("NEAR's RPCs busy: not verified, and nothing else changes", async () => {
    const plain = await checkOrder(ACCOUNT, client(txsOf("38f7db08"), { [SOL_USDT]: "1300" }), LATER);
    const r = await checkOrder(ACCOUNT, client(txsOf("38f7db08"), null), LATER);
    expect(r.balanceCheck).toEqual({ status: "not_verified", reason: "intents.near's balances could not be read now" });
    expect({ ...r, balanceCheck: undefined }).toEqual({ ...plain, balanceCheck: undefined });
  });

  it("an account that held several orders is not compared: intents.near shows only their sum", async () => {
    const asked: string[] = [];
    const r = await checkOrder("62f55aaa5b8879f8fe78e209270b62eaf179500b19c6e59017fc37007d5cf1a3", client(txsOf("62f55aaa"), {}, asked), LATER, { dustBelow: { "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": "50000" } });
    expect(r.flags[0]).toMatchObject({ kind: "several_orders" });
    expect(r.balanceCheck).toEqual({ status: "not_verified", reason: "this account held several orders, and intents.near shows only what they left together" });
    expect(asked).toEqual([]);
  });

  it("a client without the view (tests, older sites) adds nothing", async () => {
    expect(await checkOrder(ACCOUNT_358, stubClient(), NOW)).not.toHaveProperty("balanceCheck");
  });
});

describe("FastNEAR outage: the second history source", () => {
  it("counts only FastNEAR being unavailable, never an answer, as a reason to switch", async () => {
    const { fastnearUnavailable } = await import("./check.js");
    for (const status of [429, 500, 502, 503, 504, 401, 403]) expect(fastnearUnavailable(new Error(`FastNEAR /v0/account: HTTP ${status}`))).toBe(true);
    for (const status of [400, 404, 422]) expect(fastnearUnavailable(new Error(`FastNEAR /v0/account: HTTP ${status}`))).toBe(false);
    expect(fastnearUnavailable(new TypeError("fetch failed"))).toBe(true); // Node: unreachable
    expect(fastnearUnavailable(new TypeError("Failed to fetch"))).toBe(true); // browsers
    expect(fastnearUnavailable(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false); // a bug, not an outage
    expect(fastnearUnavailable(new Error("0xb0198a21bead20023a36fb4ee71591074b89d8b4 has no NEAR Intents history."))).toBe(false);
    expect(fastnearUnavailable("FastNEAR /v0/account: HTTP 429")).toBe(false);
  });

  const down = (status: number): NearClient => ({
    accountTxs: async () => Promise.reject(new Error(`FastNEAR /v0/account: HTTP ${status}`)),
    transactions: async () => Promise.reject(new Error(`FastNEAR /v0/transactions: HTTP ${status}`)),
  });

  it("re-runs the check on the backup source when FastNEAR is unavailable, and says where the history came from", async () => {
    const { checkOrderWithFallback } = await import("./check.js");
    const direct = await checkOrder(ACCOUNT_358, stubClient(), NOW);
    const viaBackup = await checkOrderWithFallback(ACCOUNT_358, down(429), NOW, undefined, undefined, undefined, { source: "nearblocks", client: () => stubClient() });
    const { historySource, ...rest } = viaBackup;
    expect(historySource).toBe("nearblocks");
    expect(rest).toEqual(direct);
  });

  it("never asks the backup while FastNEAR answers, nor for an answer that is not an outage", async () => {
    const { checkOrderWithFallback } = await import("./check.js");
    let asked = 0;
    const backup = { source: "nearblocks" as const, client: () => (asked++, stubClient()) };
    const r = await checkOrderWithFallback(ACCOUNT_358, stubClient(), NOW, undefined, undefined, undefined, backup);
    expect(r.historySource).toBeUndefined();
    await expect(checkOrderWithFallback("hello world", stubClient(), NOW, undefined, undefined, undefined, backup)).rejects.toThrow("not a NEAR account or transaction hash");
    expect(asked).toBe(0);
  });

  it("without a backup the outage is reported as before; when the backup fails too, both reasons are given", async () => {
    const { checkOrderWithFallback } = await import("./check.js");
    await expect(checkOrderWithFallback(ACCOUNT_358, down(503), NOW)).rejects.toThrow("FastNEAR /v0/account: HTTP 503");
    const alsoDown: NearClient = { accountTxs: async () => Promise.reject(new Error("NearBlocks /v3/account: HTTP 429")), transactions: async () => [] };
    await expect(checkOrderWithFallback(ACCOUNT_358, down(503), NOW, undefined, undefined, undefined, { source: "nearblocks", client: () => alsoDown })).rejects.toThrow(
      "FastNEAR is unavailable (FastNEAR /v0/account: HTTP 503), and the backup source, NearBlocks, could not answer either: NearBlocks /v3/account: HTTP 429",
    );
  });
});

describe("fastnearClient: account history order", () => {
  it("asks for the oldest transactions first, explicitly: the server's default is newest first, whatever its spec says", async () => {
    const { fastnearClient } = await import("./check.js");
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ account_txs: [] }), { status: 200 });
    }) as typeof fetch;
    await fastnearClient(fetchImpl, undefined, async () => undefined, {}).accountTxs(ACCOUNT_358);
    expect(bodies[0]).toMatchObject({ account_id: ACCOUNT_358, desc: false });
  });
});

describe("searchPayout: a Zcash payout to a TEX address, and one the bridge has not named yet", () => {
  // The 71.67087948 ZEC withdrawal 4sRsUgMY… (18 Oct 2026) to tex19q2c…: Zcash transaction aeaebfed… paid 71.67062948 ZEC
  // to t1MXYrhf…, the same key hash's t1 address (ZIP-320), which is how Zcash shows a payout to a TEX address.
  const BURN_NS = 1_792_327_712_626_785_920n;
  const w: WithdrawHop = { status: "proven", tx: "4sRsUgMYRPdpcUeksWPqbP7BXxc592eECpSrPgQAvVKm", timestampNs: BURN_NS, height: null, intentHash: null, kind: "ft_withdraw", token: "nep141:zec.omft.near", amount: "7167087948", chain: "zec", bridge: "omni", destination: "zcash:tex19q2cutrsq73dd7q8ff2qck9e97sr0dpqvt7fnm", externalId: null };
  const PAID = "aeaebfed1f5974c87c5042ff1e309c20ca6187e9f1a42628b1a34c4d42960a87";
  const zec = (report: BridgeReport): PayoutClient => ({
    incoming: async () => Promise.reject(new Error("no history reader")),
    omniTransfer: async () => report,
    zcashTx: async (txid) =>
      txid === PAID
        ? { confirmedAtSec: 1_792_327_794, outputs: [{ address: "t1MXYrhfH8ioaysET6zzjFhsDg81eTzDH6P", valueZat: 7_167_062_948n }, { address: "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua", valueZat: 6_631_066n }], shieldedIn: [] }
        : null,
  });
  const after = (sec: number): bigint => BURN_NS + BigInt(sec) * 1_000_000_000n;

  it("a TEX recipient is paid at its t1 address", async () => {
    expect(await searchPayout(w, zec({ source: "omni", status: "Settled", tx: PAID }), after(600))).toMatchObject({ status: "arrived", how: "confirmed", tx: PAID, amount: "7167062948", delaySec: 82 });
  });

  it("a payout the bridge has not named yet is on its way inside the usual time", async () => {
    expect(await searchPayout(w, zec({ source: "omni", status: "Signed", tx: null }), after(120))).toMatchObject({ status: "waiting", waitedSec: 120 });
  });

  it("and unverified after it", async () => {
    expect(await searchPayout(w, zec({ source: "omni", status: "Signed", tx: null }), after(7_200))).toMatchObject({ status: "unverified", reason: "the bridge does not name a Zcash transaction for it yet" });
  });
});
