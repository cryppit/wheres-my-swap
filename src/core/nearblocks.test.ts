// NearBlocks API v3 answers recorded on 2026-10-14 (src/fixtures/nearblocks/, keyless, "Powered by Nearblocks.io APIs")
// for two real orders, compared with what the checker reads today: FastNEAR's answer for near/intents #358 and the
// archival RPC's for one-click-sdk #6. The mapping must give the trace the same records, field for field; where
// NearBlocks lacks something, the test names it and shows what the trace does without it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import tx6b from "../fixtures/tx-6b-deposit.json";
import { decodeTxStatus, failureKind, type TxStatusResult } from "./decode.js";
import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./fastnear.js";
import {
  NEARBLOCKS_ATTRIBUTION,
  NEARBLOCKS_LINK,
  decodeNearBlocksTx,
  mtTxnsHistory,
  nearBlocksStatus,
  parseNearBlocksJson,
  type NbBlock,
  type NbEnvelope,
  type NbMtTxn,
  type NbReceipt,
} from "./nearblocks.js";
import { traceOrder } from "./trace.js";

interface Recorded {
  account?: string;
  responses: Record<string, unknown>;
}

const recorded = (name: string): Recorded => parseNearBlocksJson<Recorded>(readFileSync(new URL(`../fixtures/nearblocks/${name}`, import.meta.url), "utf8"));
function answer<T>(r: Recorded, path: string): T {
  const body = r.responses[path] as NbEnvelope<T> | undefined;
  if (!body?.data) throw new Error(`not recorded: ${path}`);
  return body.data;
}
function flatten(r: NbReceipt): NbReceipt[] {
  return [r, ...(r.receipts ?? []).flatMap(flatten)];
}

const ACCOUNT_358 = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";
const ACCOUNT_6 = "26b9cc669c90eae37285e4c52c35e0fc814314b2a6566250329a8ad497acb5fb";
const SWAP_TX = "E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB";
const DEPOSIT_TX = "8a33DkKfZMWRKbK2pXuQAWVLXSy4AyZF6PfcENvCJgCb";
const DEPOSIT_6 = "GnrtJZW5r3twuYB3UQaK6Mo415x27kqWG9oa5LphQezh";
const NOW = 1_792_000_000_000_000_000n; // 2026-10-14

const nb358 = recorded("order-358.json");
const nb6 = recorded("order-6.json");
const failedFx = recorded("failed-receipt.json");
const mt358 = answer<NbMtTxn[]>(nb358, `/v3/accounts/${ACCOUNT_358}/mt-txns?limit=25`);
const mt6 = answer<NbMtTxn[]>(nb6, `/v3/accounts/${ACCOUNT_6}/mt-txns?limit=25`);
const tree = (r: Recorded, hash: string): NbReceipt => answer<NbReceipt>(r, `/v3/txns/${hash}/receipts`);
const blockOf = (items: NbMtTxn[], hash: string): NbBlock => {
  const item = items.find((i) => i.transaction_hash === hash);
  if (!item) throw new Error(`${hash} not in mt-txns`);
  return item.block;
};

const fastnear358 = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("../fixtures/fastnear-txs-358.json", import.meta.url), "utf8")).transactions;
const fastRaw = (hash: string) => {
  const raw = fastnear358.find((t) => t.transaction.hash === hash);
  if (!raw) throw new Error(`${hash} not in the FastNEAR fixture`);
  return raw;
};
const viaFastnear = [fastRaw(SWAP_TX), fastRaw(DEPOSIT_TX)].map(decodeFastnearTx);
const viaNearBlocks358 = [SWAP_TX, DEPOSIT_TX].map((h) => decodeNearBlocksTx(h, tree(nb358, h), blockOf(mt358, h)));

describe("NEARBLOCKS_ATTRIBUTION", () => {
  it("says the history came from NearBlocks in the words NearBlocks asks for, with the link", () => {
    // api.nearblocks.io/openapi.json: "attribution is required ... a link back to Nearblocks.io, or Mentioning that your
    // app is 'Powered by Nearblocks.io APIs.'" A text report cannot link, so the line carries both.
    expect(NEARBLOCKS_ATTRIBUTION).toContain("Powered by Nearblocks.io APIs");
    expect(NEARBLOCKS_ATTRIBUTION).toContain(NEARBLOCKS_LINK);
    expect(NEARBLOCKS_LINK).toBe("https://nearblocks.io");
  });
});

describe("parseNearBlocksJson", () => {
  it("keeps nanosecond timestamps exact: v3 quotes them, and a bare one is quoted before parsing", () => {
    expect(mt358[0]?.block.block_timestamp).toBe("1790507776780473251");
    const bare = parseNearBlocksJson<{ data: { block: NbBlock } }>('{"data":{"block":{"block_hash":"x","block_height":1,"block_timestamp":1790507776780473251}}}');
    expect(bare.data.block.block_timestamp).toBe("1790507776780473251");
  });
});

describe("mtTxnsHistory", () => {
  it("lists each transaction of #358 once, oldest first, at its own block (6 transfers, 2 transactions)", () => {
    expect(mt358).toHaveLength(6);
    expect(mtTxnsHistory(mt358)).toEqual([
      { hash: DEPOSIT_TX, height: 215243812, timestampNs: 1789144024048223792n, block: { block_hash: "2fftEov2eKWbSzM88ZrXSKysf5UHRSygcSuMD7s6hJRi", block_height: "215243812", block_timestamp: "1789144024048223792" } },
      { hash: SWAP_TX, height: 217478802, timestampNs: 1790507776780473251n, block: { block_hash: "ENLA1HhXzrxqYASXG2hyJYxNRkGcRPvundu8VQs9HN4V", block_height: "217478802", block_timestamp: "1790507776780473251" } },
    ]);
  });

  it("dates a transfer by its transaction's block, not by the receipt that moved it (what the mapping relies on)", () => {
    // #358's mint ran in receipt 9sEgpLCv… at 215243816, four blocks after its transaction (FastNEAR): mt-txns says 215243812.
    const mintReceipt = fastRaw(DEPOSIT_TX).receipts.find((r) => r.receipt.receipt_id === "9sEgpLCva7GVAiEJci9PcfVfkVRKkhhwrwvCpLVsqYVu");
    expect(mintReceipt?.execution_outcome.block_height).toBe(215243816);
    expect(mt358.find((i) => i.cause === "MINT")?.block.block_height).toBe("215243812");
    for (const t of mtTxnsHistory(mt358)) {
      const fast = fastRaw(t.hash).execution_outcome;
      expect([t.height, t.timestampNs, t.block.block_hash]).toEqual([fast.block_height, BigInt(String(fast.block_timestamp)), fast.block_hash]);
    }
    // #6: the block hash mt-txns gives is the one the archival RPC names for the transaction itself.
    expect(mt6.map((i) => [i.transaction_hash, i.cause, i.block.block_hash])).toEqual([[DEPOSIT_6, "MINT", tx6b.result.transaction_outcome.block_hash]]);
  });
});

describe("nearBlocksStatus", () => {
  it("gives every receipt of #358 the RPC status FastNEAR gives it", () => {
    for (const hash of [SWAP_TX, DEPOSIT_TX]) {
      const byId = new Map(flatten(tree(nb358, hash)).map((r) => [r.receipt_id, r]));
      const fast = fastRaw(hash).receipts;
      expect(fast).toHaveLength(byId.size);
      for (const r of fast) expect(nearBlocksStatus(byId.get(r.receipt.receipt_id ?? "")?.outcome)).toEqual(r.execution_outcome.outcome.status);
    }
  });

  it("reads a real failure as the RPC's Failure, so the failure kind is the same (inner fields are camelCase)", () => {
    const failed = flatten(tree(failedFx, "8bQxUKGCYZZLMYkntSa3vfa1W69DXhH5YkwuJUU92vcR")).find((r) => r.outcome?.status_key === "FAILURE");
    const status = nearBlocksStatus(failed?.outcome);
    expect(status).toEqual({ Failure: { ActionError: { kind: { AccountDoesNotExist: { accountId: "omni.n-bridge.testnet" } }, index: 0 } } });
    expect(failureKind(status)).toBe("AccountDoesNotExist");
  });
});

describe("decodeNearBlocksTx on near/intents #358", () => {
  it("gives the swap-and-withdraw transaction the record FastNEAR gives it, field for field", () => {
    expect(viaNearBlocks358[0]).toEqual(viaFastnear[0]);
  });

  it("gives the bridge deposit the record FastNEAR gives it, field for field", () => {
    expect(viaNearBlocks358[1]).toEqual(viaFastnear[1]);
  });

  it("restores call arguments: NearBlocks has no raw args (args_base64 is null) and escapes every string in args_json twice", () => {
    const escapedTwice = (s: string) => JSON.stringify(JSON.stringify(s).slice(1, -1)).slice(1, -1);
    const msg = `{"receiver_id":"${ACCOUNT_358}"}`;
    const onTransfer = flatten(tree(nb358, DEPOSIT_TX)).find((r) => r.actions?.[0]?.method === "ft_on_transfer")?.actions?.[0]?.args;
    expect(onTransfer?.args_base64).toBeNull();
    expect((onTransfer?.args_json as { msg?: string }).msg).toBe(escapedTwice(msg));
    const decoded = viaNearBlocks358[1]?.receiptActions.find((a) => a.method === "ft_on_transfer");
    expect(decoded?.args).toEqual({ sender_id: "omft.near", amount: "575830000000", msg });
  });

  it("needs the transaction's own block: the receipt tree has only its receipts' blocks, which can be later", () => {
    // The deposit's first receipt ran one block after its transaction; the swap's ran in the same block (signer and
    // receiver are both intents.near). The mapping takes the block from mt-txns (or /v3/txns/{hash}).
    const root = tree(nb358, DEPOSIT_TX);
    expect(root.block.block_height).toBe("215243813");
    expect(decodeNearBlocksTx(DEPOSIT_TX, root, root.block).height).toBe(215243813);
    expect(viaNearBlocks358[1]?.height).toBe(viaFastnear[1]?.height);
    expect(viaFastnear[1]?.height).toBe(215243812);
  });

  it("keeps receipts of one block in the tree's order (NearBlocks gives no chunk position); on #358 that changes nothing", () => {
    // FastNEAR lists block 215243814 as CpMF… (a gas refund) then G1cb…; the tree walks G1cb… first. Records only
    // differ when two receipts of one transaction that ran in the same block both carry calls, transfers or logs: then
    // the trace may list that transaction's hops in another order, with the same amounts, balances and verdict.
    const fastOrder = fastRaw(DEPOSIT_TX).receipts.filter((r) => r.execution_outcome.block_height === 215243814).map((r) => r.receipt.receipt_id?.slice(0, 4));
    const treeOrder = flatten(tree(nb358, DEPOSIT_TX)).filter((r) => r.block.block_height === "215243814").map((r) => r.receipt_id.slice(0, 4));
    expect(fastOrder).toEqual(["CpMF", "G1cb"]);
    expect(treeOrder).toEqual(["G1cb", "CpMF"]);
    expect(viaNearBlocks358[1]).toEqual(viaFastnear[1]);
  });
});

describe("decodeNearBlocksTx on one-click-sdk #6", () => {
  const nb = decodeNearBlocksTx(DEPOSIT_6, tree(nb6, DEPOSIT_6), blockOf(mt6, DEPOSIT_6));
  const at = blockOf(mt6, DEPOSIT_6);
  // The archival RPC answer has no block height; the test gives it the one NearBlocks reports for the transaction.
  const rpc = decodeTxStatus(tx6b.result as unknown as TxStatusResult, { height: Number(at.block_height), timestampNs: BigInt(at.block_timestamp) });

  it("yields the same identity, actions and events as the archival RPC for the deposit", () => {
    expect([nb.hash, nb.signer, nb.receiver, nb.height, nb.timestampNs]).toEqual([rpc.hash, rpc.signer, rpc.receiver, 194962521, 1776771805670060289n]);
    expect(nb.actions).toEqual(rpc.actions);
    expect(nb.events).toEqual(rpc.events);
    expect(nb.plainLogs).toEqual(rpc.plainLogs);
  });

  it("also carries the receipts' calls and transfers, which that RPC answer does not", () => {
    expect(rpc.receiptActions).toEqual([]);
    expect(nb.receiptActions.map((a) => `${a.executor}.${a.method}`)).toEqual(["omft.near.ft_deposit", "eth.omft.near.ft_deposit", "eth.omft.near.ft_transfer_call", "intents.near.ft_on_transfer", "eth.omft.near.ft_resolve_transfer"]);
    expect(nb.nativeTransfers).toEqual([{ from: "eth.omft.near", to: "omft.near", deposit: "1250000000000000000000", failed: false, receipt: "CgwamYnSjDRpPqmcuXC8juZWSdJibDECxfJMBFc5iu4d" }]);
  });
});

describe("decodeNearBlocksTx on failures and receipts still to run", () => {
  it("marks a failed call as failed, under its own receipt (a real failed ft_on_transfer)", () => {
    const t = tree(failedFx, "8bQxUKGCYZZLMYkntSa3vfa1W69DXhH5YkwuJUU92vcR");
    const record = decodeNearBlocksTx("8bQxUKGCYZZLMYkntSa3vfa1W69DXhH5YkwuJUU92vcR", t, t.block);
    expect(record.receiptActions.filter((a) => a.failed)).toEqual([
      { method: "ft_on_transfer", args: expect.any(Object), executor: "omni.n-bridge.testnet", failed: true, receipt: "5EMYTQ1rufwykS6r4p6mMpC7baGxebg1WqVyGDBuBsWJ" },
    ]);
    expect(record.pendingReceipts).toBeUndefined();
  });

  // Built in the shape NearBlocks gives (the failure is the one recorded above): a native NEAR payout to a name nobody
  // created fails, and NEAR returns the deposit to intents.near in a `system` receipt.
  const bounce: NbReceipt = {
    receipt_id: "Root",
    predecessor_account_id: "solver.near",
    receiver_account_id: "intents.near",
    actions: [{ action: "FUNCTION_CALL", method: "execute_intents", args: { method_name: "execute_intents", args_json: { signed: [] }, args_base64: null, gas: "300000000000000", deposit: "0" } }],
    outcome: { executor_account_id: "intents.near", logs: [], status: true, status_key: "SUCCESS_VALUE", result: "" },
    block: { block_hash: "b1", block_height: "100", block_timestamp: "1000" },
    receipts: [
      {
        receipt_id: "Pay",
        predecessor_account_id: "intents.near",
        receiver_account_id: "nobody-made-this.near",
        actions: [{ action: "TRANSFER", method: null, args: { deposit: "5000" } }],
        outcome: { executor_account_id: "nobody-made-this.near", logs: [], status: false, status_key: "FAILURE", result: { ActionError: { kind: { AccountDoesNotExist: { accountId: "nobody-made-this.near" } }, index: 0 } } },
        block: { block_hash: "b2", block_height: "101", block_timestamp: "2000" },
        receipts: [
          {
            receipt_id: "Back",
            predecessor_account_id: "system",
            receiver_account_id: "intents.near",
            actions: [{ action: "TRANSFER", method: null, args: { deposit: "5000" } }],
            outcome: { executor_account_id: "intents.near", logs: [], status: true, status_key: "SUCCESS_VALUE", result: "" },
            block: { block_hash: "b3", block_height: "102", block_timestamp: "3000" },
            receipts: [],
          },
        ],
      },
    ],
  };

  it("names a failed transfer's reason and the system receipt that refunded it, as FastNEAR does", () => {
    expect(decodeNearBlocksTx("Tx", bounce, bounce.block).nativeTransfers).toEqual([
      { from: "intents.near", to: "nobody-made-this.near", deposit: "5000", failed: true, receipt: "Pay", error: "AccountDoesNotExist", refund: "Back" },
    ]);
  });

  it("counts a receipt listed without an outcome as not run yet; a receipt NearBlocks does not list at all stays invisible", () => {
    // NearBlocks gives no separate list of the receipts each outcome spawned (RPC `receipt_ids`): the mapping reads it
    // from the tree's children. A child without an outcome is pending, so the trace says the order is still executing;
    // a child NearBlocks has not indexed yet is missing from the tree, and the transaction then looks finished.
    const running: NbReceipt = { ...bounce, receipts: [{ ...(bounce.receipts?.[0] as NbReceipt), outcome: null, receipts: [] }] };
    const record = decodeNearBlocksTx("Tx", running, running.block);
    expect(record.pendingReceipts).toEqual(["Pay"]);
    expect(record.nativeTransfers).toEqual([]);
    expect(decodeNearBlocksTx("Tx", { ...bounce, receipts: [] }, bounce.block).pendingReceipts).toBeUndefined();
  });
});

describe("the trace from NearBlocks equals the trace from the checker's current source", () => {
  it("#358: settled 16 days late, with the same ledger, deposit, swap, fee transfer, withdrawal and payout hop as FastNEAR", () => {
    const fromFastnear = traceOrder({ account: ACCOUNT_358, txs: viaFastnear, nowNs: NOW });
    const fromNearBlocks = traceOrder({ account: ACCOUNT_358, txs: viaNearBlocks358, nowNs: NOW });
    expect(fromNearBlocks).toEqual(fromFastnear);
    expect(fromNearBlocks.verdict).toBe("settled");
    expect(fromNearBlocks.flags.map((f) => f.kind)).toEqual(["settled_late"]);
    expect(fromNearBlocks.balances).toEqual({});
    expect(fromNearBlocks.deposits).toMatchObject([{ tx: DEPOSIT_TX, token: "nep141:tron.omft.near", amount: "575830000000", height: 215243812 }]);
    expect(fromNearBlocks.swaps).toMatchObject([{ tx: SWAP_TX, gave: { "nep141:tron.omft.near": "574678340000" }, got: { "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near": "190995593894" } }]);
    expect(fromNearBlocks.withdrawals).toMatchObject([{ tx: SWAP_TX, amount: "190995593894", bridge: "poa", destination: "0x632F5D32448DE43b8b9cfD063aCfcDac09108bad" }]);
    expect(fromNearBlocks.payout).toMatchObject({ status: "unverified", destination: "0x632F5D32448DE43b8b9cfD063aCfcDac09108bad" });
  });

  it("#6: stuck with 48.28 ETH in the account, the same report as from the archival RPC (given the block it lacks)", () => {
    const at = blockOf(mt6, DEPOSIT_6);
    const rpc = decodeTxStatus(tx6b.result as unknown as TxStatusResult, { height: Number(at.block_height), timestampNs: BigInt(at.block_timestamp) });
    const fromRpc = traceOrder({ account: ACCOUNT_6, txs: [rpc], nowNs: NOW });
    const fromNearBlocks = traceOrder({ account: ACCOUNT_6, txs: [decodeNearBlocksTx(DEPOSIT_6, tree(nb6, DEPOSIT_6), at)], nowNs: NOW });
    expect(fromNearBlocks).toEqual(fromRpc);
    expect(fromNearBlocks.verdict).toBe("stuck");
    expect(fromNearBlocks.balances).toEqual({ "nep141:eth.omft.near": "48280000000000000000" });
    expect(fromNearBlocks.origin).toMatchObject({ status: "proven", kind: "poa", chain: "eth:1", txHash: "0x032c9cf59668a4ff2a2b8f7f9d05bb4dda950b3c0a8ed555d099652bd7be4f4f" });
    expect(fromNearBlocks.flags.map((f) => f.kind)).toEqual(["stalled"]);
  });
});
