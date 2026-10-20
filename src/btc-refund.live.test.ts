// Live: the BTC deposit check and the Omni BTC search against the real keyless sources (mempool.space, the Omni bridge
// indexer, btc-connector.bridge.near, FastNEAR). Run on demand: npm run test:live
import { describe, expect, it } from "vitest";

import { checkBtcDeposit, publicBtcRefundClient, publicUtxoRefundClients } from "./btc-refund.js";
import { checkOrder, fastnearClient } from "./check.js";
import { publicOriginClient } from "./origin.js";

const now = () => Math.floor(Date.now() / 1000);

describe("live: Bitcoin deposits through the Omni BTC bridge", () => {
  it("the deposit stuck since 2026-08-19: never credited, its refund requested for the sending wallet", async () => {
    const r = await checkBtcDeposit("9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39", publicBtcRefundClient(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.orderAccount).toBe("f3de655c605a4ca01e000e7961a969687678efaf3bd6c6dff13cea3cb50ab807");
    // Anyone may execute it, so it can move on from "ready".
    expect(["ready", "executed", "refunded"]).toContain(r.verdict.state);
    expect(r.facts.request?.refundAddress ?? r.facts.senders[0]).toBe("bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t");
  });

  it("a G1 deposit is credited, and the main checker follows its order from the Bitcoin hash", async () => {
    const hash = "82d074e17c7a697181a87e4b78ec0811743e7578011904ae5eb0eb2a05e9f4cb";
    const r = await checkBtcDeposit(hash, publicBtcRefundClient(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.verdict).toEqual({ state: "credited", orderAccount: "f78dc0414931c3868bbc236445c8831338394785b2459f379152e873723a6e21" });

    const order = await checkOrder(hash, fastnearClient(), BigInt(Date.now()) * 1_000_000n, undefined, undefined, publicOriginClient());
    expect(order.account).toBe("f78dc0414931c3868bbc236445c8831338394785b2459f379152e873723a6e21");
    expect(order.foundBy).toEqual({ chain: "btc", originTx: hash });
    expect(order.deposits.length).toBeGreaterThan(0);
  });

  it("the main checker sends a never-credited deposit to the refund check", async () => {
    const hash = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
    await expect(checkOrder(hash, fastnearClient(), BigInt(Date.now()) * 1_000_000n, undefined, undefined, publicOriginClient())).rejects.toThrow(
      `check whether it can be refunded with: btc-refund ${hash}`,
    );
  });

  it("a Zcash deposit from 2026-10-13 funded from the Ironwood pool: no transparent sender, a unified refund address", async () => {
    const r = await checkBtcDeposit("04dc643f8a1d19baf476178d01eac8fc553700e36f849df91e46924fa3f2cae6", publicUtxoRefundClients(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.facts).toMatchObject({ chain: "zcash", senders: [], funding: { kind: "shielded", pools: ["Ironwood"] } });
    expect(r.facts.msg?.refund_address).toMatch(/^u1/);
    expect(r.config.refundFeeSat).toBe(10_000);
    // Credited on 2026-10-13; the bridge may since have spent the coin in its own transaction (still credited).
    expect(r.verdict.state).toBe("credited");
  });

  it("a Zcash deposit from 2026-10-13: found on Zcash, credited, and the main checker follows its order", async () => {
    const hash = "6de202d64d2b7c04154ed73f892c7dd7f288d440bde80d39059d2341fd9abadc";
    const r = await checkBtcDeposit(hash, publicUtxoRefundClients(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.facts.chain).toBe("zcash");
    expect(r.orderAccount).toBe("957d6bdac944b4d9877892977a76a22f05af2ff01d414b7379553ac6d6cf0c3d");
    expect(r.verdict.state).toBe("credited");
    const order = await checkOrder(hash, fastnearClient(), BigInt(Date.now()) * 1_000_000n, undefined, undefined, publicOriginClient());
    expect(order.origin).toMatchObject({ status: "proven", kind: "omni-utxo", chain: "zcash:mainnet", txHash: hash });
  });
});
