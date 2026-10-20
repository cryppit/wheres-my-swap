import { describe, expect, it } from "vitest";

import block358 from "../fixtures/block-358-swap.json";
import tx358 from "../fixtures/tx-358-deposit.json";
import { decodeBlockOutcomes, decodeTxStatus, type TxStatusResult, type NeardataBlock } from "./decode.js";

const DEPOSIT_ACCOUNT = "ee2f4930664176ee020763c9e81457b9c3050ce1c3ff9f2e4c72e9f3f525cbe6";

describe("decodeTxStatus", () => {
  const tx = decodeTxStatus(tx358.result as unknown as TxStatusResult, {
    height: 215243812,
    timestampNs: 1789144024048223792n,
  });

  it("keeps the transaction identity and block position", () => {
    expect(tx.hash).toBe("8a33DkKfZMWRKbK2pXuQAWVLXSy4AyZF6PfcENvCJgCb");
    expect(tx.signer).toBe("bridge-mng.near");
    expect(tx.receiver).toBe("omft.near");
    expect(tx.height).toBe(215243812);
    expect(tx.timestampNs).toBe(1789144024048223792n);
  });

  it("decodes the function-call arguments from base64 JSON", () => {
    expect(tx.actions).toHaveLength(1);
    const [action] = tx.actions;
    expect(action?.method).toBe("ft_deposit");
    const args = action?.args as { token: string; amount: string; memo: string };
    expect(args.token).toBe("tron");
    expect(args.amount).toBe("575830000000");
    expect(args.memo.startsWith("BRIDGED_FROM:")).toBe(true);
  });

  it("collects every NEP-297 event with its executor and normalises data to an array", () => {
    const mint = tx.events.find((e) => e.standard === "nep245" && e.event === "mt_mint");
    expect(mint?.executor).toBe("intents.near");
    expect(mint?.failed).toBe(false);
    expect(mint?.data).toEqual([
      {
        owner_id: DEPOSIT_ACCOUNT,
        token_ids: ["nep141:tron.omft.near"],
        amounts: ["575830000000"],
        memo: "deposit",
      },
    ]);
    const transfer = tx.events.find((e) => e.standard === "nep141" && e.event === "ft_transfer");
    expect(transfer?.executor).toBe("tron.omft.near");
  });

  it("works without Node's Buffer, since the page runs it in the browser", () => {
    const g = globalThis as { Buffer?: unknown };
    const saved = g.Buffer;
    delete g.Buffer;
    try {
      const decoded = decodeTxStatus(tx358.result as unknown as TxStatusResult, { height: 1, timestampNs: 1n });
      expect((decoded.actions[0]?.args as { token: string }).token).toBe("tron");
    } finally {
      g.Buffer = saved;
    }
  });

  it("marks events of a failed receipt as failed", () => {
    const broken = structuredClone(tx358.result) as unknown as TxStatusResult;
    const intentsReceipt = broken.receipts_outcome.find((r) => r.outcome.executor_id === "intents.near");
    if (!intentsReceipt) throw new Error("fixture has no intents.near receipt");
    intentsReceipt.outcome.status = { Failure: { ActionError: {} } };
    const decoded = decodeTxStatus(broken, { height: 1, timestampNs: 1n });
    const mint = decoded.events.find((e) => e.event === "mt_mint");
    expect(mint?.failed).toBe(true);
  });
});

describe("decodeBlockOutcomes", () => {
  it("groups a neardata block's receipt outcomes by transaction with the block's position", () => {
    const txs = decodeBlockOutcomes(block358 as unknown as NeardataBlock);
    expect(txs).toHaveLength(1);
    const [tx] = txs;
    expect(tx?.hash).toBe("E887Y77MhajfbvNg7x1HbPAHPo7vzNs8JnFC5Ed15nmB");
    expect(tx?.height).toBe(217478802);
    expect(tx?.timestampNs).toBe(1790507776780473251n);
    const kinds = tx?.events.map((e) => `${e.standard}/${e.event}`);
    expect(kinds).toContain("dip4/token_diff");
    expect(kinds).toContain("dip4/transfer");
    expect(kinds).toContain("dip4/ft_withdraw");
    expect(kinds).toContain("dip4/intents_executed");
    expect(tx?.events.filter((e) => e.event === "token_diff")).toHaveLength(3);
  });
});
