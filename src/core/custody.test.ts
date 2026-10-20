// Where an order's money is now, who can move it, and what the user should do: one plain answer per order, plus the
// support message they can send.
import { describe, expect, it } from "vitest";

import { supportMessage, whoCanMove } from "./custody.js";
import type { OrderReport, PayoutHop, WithdrawHop } from "./trace.js";

const ACCOUNT = "26b9cc669c90eae37285e4c52c35e0fc814314b2a6566250329a8ad497acb5fb";
const T = 1_790_000_000_000_000_000n;
const credit = { status: "proven" as const, tx: "DEP", timestampNs: T, height: 1, token: "nep141:eth.omft.near", amount: "48280000000000000000" };
const swap = { status: "proven" as const, tx: "SWP", timestampNs: T, height: 2, intentHash: null, gave: {}, got: {}, fees: {}, referral: "1click-rango", counterparties: [] };
const withdrawal: WithdrawHop = { status: "proven", tx: "WDR", timestampNs: T, height: 3, intentHash: null, kind: "ft_withdraw", token: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", amount: "190995590000", chain: "tron", bridge: "poa", destination: "THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc", externalId: null };

const report = (over: Partial<OrderReport>): OrderReport => ({
  account: ACCOUNT,
  verdict: "in_progress",
  oneClickStatus: "PROCESSING",
  origin: { status: "missing" },
  deposits: [credit],
  swaps: [],
  transfers: [],
  withdrawals: [],
  payout: { status: "missing" },
  balances: {},
  flags: [],
  ...over,
});
const arrived: PayoutHop = { status: "arrived", how: "confirmed", tx: "0x9be9", amount: "190995590000", delaySec: 19, confirmed: true, chain: "tron", bridge: "poa", destination: "THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc" };

describe("whoCanMove", () => {
  it("stuck in the order account: only 1Click, which holds its key, can move it", () => {
    const c = whoCanMove(report({ verdict: "stuck", balances: { "nep141:eth.omft.near": "48280000000000000000" }, flags: [{ kind: "stalled", waitedSec: 173 * 86_400, detail: "credited, nothing since" }] }));
    expect(c.place).toBe("order_account");
    expect(c.holds).toBe(`It is in the order account ${ACCOUNT} on NEAR Intents (intents.near): 48280000000000000000 nep141:eth.omft.near.`);
    expect(c.canMove).toBe("Only 1Click. It holds this order account's key: not you, not the app you swapped in, and not us.");
    expect(c.needsHelp).toBe(true);
  });

  it("in progress with money in the order account: normal for a few minutes", () => {
    const c = whoCanMove(report({ verdict: "in_progress", balances: { "nep141:eth.omft.near": "1" } }));
    expect(c.place).toBe("order_account");
    expect(c.needsHelp).toBe(false);
    expect(c.next).toContain("usually moves on within minutes");
  });

  it("withdrawn but not seen on the destination: the bridge holds it until it pays", () => {
    const c = whoCanMove(report({ verdict: "settled", swaps: [swap], withdrawals: [withdrawal], payout: { status: "not_found", waitedSec: 7_200, chain: "tron", bridge: "poa", destination: "THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc", bridgeReport: { status: "PENDING", tx: null } } }));
    expect(c.place).toBe("with_bridge");
    expect(c.holds).toBe("It left NEAR Intents toward THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc on tron, through the PoA bridge, and has not been seen arriving.");
    expect(c.canMove).toBe("The PoA bridge's operator, which pays withdrawals from its own wallets. Its status API says: PENDING.");
    expect(c.app).toBe("1click-rango");
    expect(c.needsHelp).toBe(true);
  });

  it("arrived, or refunded back to the user: nothing to chase", () => {
    expect(whoCanMove(report({ verdict: "settled", swaps: [swap], withdrawals: [withdrawal], payout: arrived }))).toMatchObject({ place: "arrived", needsHelp: false });
    expect(whoCanMove(report({ verdict: "refunded", withdrawals: [withdrawal], payout: arrived }))).toMatchObject({ place: "returned", needsHelp: false });
  });

  it("never reached NEAR: it is with whoever received the deposit on the user's own chain", () => {
    const c = whoCanMove(report({ verdict: "not_found", deposits: [] }));
    expect(c.place).toBe("not_on_near");
    expect(c.next).toContain("Bitcoin or Zcash");
  });

  it("confidential: moved to NEAR Intents' confidential treasury, private by design", () => {
    expect(whoCanMove(report({ verdict: "confidential", withdrawals: [] }))).toMatchObject({ place: "confidential", needsHelp: false });
  });
});

describe("whoCanMove: the Omni bridge's indexer", () => {
  it("a ZEC payout the indexer names: its word is passed on, with the Zcash transaction", () => {
    const zec: WithdrawHop = { ...withdrawal, token: "nep141:zec.omft.near", amount: "55158859", chain: "zec", bridge: "omni", destination: "zcash:u1jfupn9" };
    const c = whoCanMove(
      report({
        verdict: "settled",
        withdrawals: [zec],
        payout: { status: "unverified", chain: "zec", bridge: "omni", destination: "zcash:u1jfupn9", reason: "payouts on zec are not searched yet", bridgeReport: { source: "omni", status: "Settled", tx: "064ff3c0" } },
      }),
    );
    expect(c.place).toBe("with_bridge");
    expect(c.canMove).toBe("The Omni bridge: NEAR's MPC network signs the transfer, then a relayer delivers it on the destination chain. Its indexer reports the transfer as Settled, paid out in 064ff3c0.");
  });

  it("a withdrawal that came back is not where the money went: it is still in the order account", () => {
    const c = whoCanMove(report({ verdict: "stuck", withdrawals: [{ ...withdrawal, returned: withdrawal.amount }], balances: { [withdrawal.token]: withdrawal.amount }, flags: [{ kind: "stalled", waitedSec: 7_200, detail: "funds still in the order account after the last intent" }] }));
    expect(c.place).toBe("order_account");
  });
});

describe("whoCanMove: a ZEC payout into a shielded pool", () => {
  it("arrived, and says the recipient is hidden by design", () => {
    const zec: WithdrawHop = { ...withdrawal, token: "nep141:zec.omft.near", amount: "55158859", chain: "zec", bridge: "omni", destination: "zcash:u1jfupn9" };
    const c = whoCanMove(report({ verdict: "settled", withdrawals: [zec], payout: { status: "arrived", how: "shielded", chain: "zec", bridge: "omni", destination: "zcash:u1jfupn9", tx: "064ff3c0", amount: "55133859", delaySec: 93, confirmed: true, shieldedPool: "Ironwood" } }));
    expect(c.place).toBe("arrived");
    expect(c.holds).toBe("It was paid into Zcash's Ironwood shielded pool for zcash:u1jfupn9 in transaction 064ff3c0. A shielded payment hides its recipient on the chain, so your wallet is where it shows.");
    expect(c.needsHelp).toBe(false);
  });
});

describe("whoCanMove: a user's own NEAR Intents account", () => {
  it("money resting in a 0x account is the wallet owner's to move, not 1Click's", () => {
    const c = whoCanMove({ ...report({ verdict: "stuck", balances: { "nep141:eth.omft.near": "1" } }), account: "0xb0198a21bead20023a36fb4ee71591074b89d8b4" });
    expect(c.canMove).toBe("Whoever holds this account's wallet key: it is a NEAR Intents user account, not a 1Click order account.");
  });
});

describe("supportMessage", () => {
  it("states the order, the deposit, where the money is, who can move it, and the evidence link", () => {
    const r = report({ verdict: "stuck", swaps: [swap], balances: { "nep141:eth.omft.near": "48280000000000000000" }, flags: [{ kind: "stalled", waitedSec: 173 * 86_400, detail: "credited, nothing since" }] });
    const text = supportMessage(r, whoCanMove(r), { link: "https://wheres-my-swap.higgsfield.app/?q=26b9", amount: (t, a) => `${a} ${t.replace("nep141:", "")}` });
    expect(text).toContain(`Order account: ${ACCOUNT}`);
    expect(text).toContain("Deposited: 48280000000000000000 eth.omft.near (NEAR transaction DEP)");
    expect(text).toContain("Swapped through: 1click-rango");
    expect(text).toContain("Only 1Click.");
    expect(text).toContain("Evidence: https://wheres-my-swap.higgsfield.app/?q=26b9");
    expect(text).toContain("please escalate this to 1Click");
  });
});

describe("whoCanMove and supportMessage: an order account intents.near has locked", () => {
  const LOCKED = { kind: "locked" as const, tx: "LCK", waitedSec: 180 * 86_400, detail: "intents.near locked this order account (force_lock_account): a locked account cannot move its own balances, so no swap or withdrawal can run from it" };
  const r = report({ verdict: "stuck", balances: { "nep141:eth.omft.near": "48280000000000000000" }, flags: [LOCKED] });

  it("only the NEAR Intents operators can move it: not even 1Click, which holds its key", () => {
    const c = whoCanMove(r);
    expect(c.place).toBe("order_account");
    expect(c.holds).toBe(`It is in the order account ${ACCOUNT} on NEAR Intents (intents.near): 48280000000000000000 nep141:eth.omft.near. intents.near locked that account in transaction LCK, so it cannot move its own balances.`);
    expect(c.canMove).toBe("Only the NEAR Intents operators, who run intents.near: a locked account cannot move its own balances, so not even 1Click, which holds its key, can move it until they unlock it or move the funds. Not you, not the app you swapped in, and not us.");
    expect(c.next).toBe("Send the support message below to the app you swapped in and ask them to escalate to NEAR Intents: only its team can say why the account is locked, and release or return the money. Never pay anyone who offers to unlock it.");
    expect(c.needsHelp).toBe(true);
  });

  it("a locked account its owner uses directly: not even the key holder can move it", () => {
    const own = whoCanMove({ ...r, account: "alice.near" });
    expect(own.canMove).toBe("Only the NEAR Intents operators, who run intents.near: a locked account cannot move its own balances, so not even whoever holds its key can move it until they unlock it or move the funds. Not you, not the app you swapped in, and not us.");
    expect(own.needsHelp).toBe(true);
  });

  it("the support message asks NEAR Intents about the lock, not 1Click to finish the swap", () => {
    const text = supportMessage(r, whoCanMove(r), { link: null });
    expect(text).toContain("Could you please escalate this to NEAR Intents? intents.near locked the order account in transaction LCK, so it cannot move its own balances, and only NEAR Intents can release or return the money.");
    expect(text).not.toContain("escalate this to 1Click to complete the swap");
  });
});

describe("whoCanMove: a NEAR payout that bounced", () => {
  // A native NEAR withdrawal to a named account nobody created: the Transfer fails and NEAR refunds intents.near, which
  // has no callback to credit the order account back (near/intents nep141/native.rs).
  const bounced: WithdrawHop = {
    status: "proven",
    tx: "WDR",
    timestampNs: T,
    height: 3,
    intentHash: null,
    kind: "native_withdraw",
    token: "nep141:wrap.near",
    amount: "90000000000000000000000",
    chain: "near",
    bridge: "near",
    destination: "nobody-made-this.near",
    externalId: null,
    bounced: { reason: "transfer_failed", error: "AccountDoesNotExist", receipt: "7MvL", refund: "DRef" },
  };
  const r = report({ verdict: "stuck", swaps: [swap], withdrawals: [bounced], flags: [{ kind: "payout_bounced", detail: "…" }] });

  it("intents.near holds it, outside the order account, and only NEAR Intents can return it", () => {
    const c = whoCanMove(r);
    expect(c).toMatchObject({ place: "intents_contract", needsHelp: true });
    expect(c.holds).toBe(
      "NEAR could not deliver 90000000000000000000000 nep141:wrap.near to nobody-made-this.near (that account does not exist), so it sent it back to intents.near, not to your order account. intents.near does not credit a failed NEAR payout back, so it stays there, outside the order account.",
    );
    expect(c.canMove).toBe("Only NEAR Intents, which runs intents.near, when 1Click asks it to: not you, not the app you swapped in, and not us.");
    expect(c.next).toBe("Send the support message below to the app you swapped in and ask them to escalate to 1Click and NEAR Intents to return it. NEAR pays only accounts that exist, so check the account name you gave.");
  });

  it("intents.near's own payout step failed: nothing was sent", () => {
    const c = whoCanMove(report({ verdict: "stuck", withdrawals: [{ ...bounced, bounced: { reason: "unwrap_failed", step: "near_withdraw", receipt: "U" } }] }));
    expect(c.place).toBe("intents_contract");
    expect(c.holds).toBe(
      "The withdrawal of 90000000000000000000000 nep141:wrap.near to nobody-made-this.near failed inside intents.near (its near_withdraw step), so nothing was sent, and intents.near does not credit a failed NEAR payout back: it stays there, outside the order account.",
    );
    expect(c.next).toBe("Send the support message below to the app you swapped in and ask them to escalate to 1Click and NEAR Intents to return it.");
  });

  it("the support message names the withdrawal and asks NEAR Intents to return it", () => {
    const text = supportMessage(r, whoCanMove(r), { link: null });
    expect(text).toContain("Withdrawn: 90000000000000000000000 nep141:wrap.near to nobody-made-this.near on near (NEAR transaction WDR), which did not arrive");
    expect(text).toContain(
      "Could you please escalate this to 1Click and NEAR Intents? NEAR could not deliver the withdrawal to nobody-made-this.near (that account does not exist) and returned it to intents.near, which did not credit it back to the order account.",
    );
  });

  it("a payout that arrived while the refund of unused input bounced: names the part that did not arrive and asks for help", () => {
    const paid = report({ verdict: "settled", swaps: [swap], withdrawals: [withdrawal, { ...bounced, excessRefund: true }], payout: arrived, flags: [{ kind: "payout_bounced", detail: "…" }] });
    const c = whoCanMove(paid);
    expect(c).toMatchObject({ place: "arrived", needsHelp: true });
    expect(c.holds).toBe(
      "It arrived at THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc on tron in transaction 0x9be9. The refund of your unused input did not arrive: NEAR could not deliver 90000000000000000000000 nep141:wrap.near to nobody-made-this.near (that account does not exist), so it sent it back to intents.near, not to your order account. intents.near does not credit a failed NEAR payout back, so it stays there, outside the order account.",
    );
    expect(c.canMove).toBe("The owner of that wallet. For the part that did not arrive: only NEAR Intents, which runs intents.near, when 1Click asks it to.");
    expect(c.next).toBe("Send the support message below to the app you swapped in and ask them to escalate to 1Click and NEAR Intents to return the part that did not arrive.");
    const text = supportMessage(paid, c, { link: null });
    expect(text).toContain("Withdrawn: 190995590000 nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near to THWr3wFNE5ECjPYeWkBjLPyknUDvxFJ4Tc on tron (NEAR transaction WDR)");
    expect(text).toContain("Withdrawn: 90000000000000000000000 nep141:wrap.near to nobody-made-this.near on near (NEAR transaction WDR), which did not arrive");
    expect(text).toContain("Could you please escalate this to 1Click and NEAR Intents? NEAR could not deliver the withdrawal to nobody-made-this.near");
  });
});

describe("whoCanMove: a token payout to a named account nobody has created", () => {
  const paid: PayoutHop = { status: "arrived", how: "proven", chain: "near", bridge: "near", destination: "hideon.near", tx: "PAY", amount: "12928058", delaySec: 0, confirmed: true };
  const toNamed = (destination: string) => {
    const w: WithdrawHop = { ...withdrawal, token: "nep141:zec.omft.near", amount: "12928058", chain: "near", bridge: "near", destination };
    return report({ verdict: "settled", swaps: [swap], withdrawals: [w], payout: { ...paid, destination }, flags: [{ kind: "destination_missing", account: destination, detail: "…" }] });
  };

  it("a .near name: it is in nobody's wallet, and the user can create the name before anyone else does", () => {
    expect(whoCanMove(toNamed("hideon.near"))).toEqual({
      app: "1click-rango",
      place: "arrived",
      holds: "It was paid to hideon.near on near in transaction PAY, but no NEAR account has that name yet: the token contract holds it under the name, in nobody's wallet.",
      canMove: "Whoever creates the account hideon.near first: anyone can create a .near name.",
      next: "Create hideon.near now, with any NEAR wallet, before anyone else does: the tokens are then yours.",
      needsHelp: false,
    });
  });

  it("a sub-account only its parent can create: ask for help", () => {
    const c = whoCanMove(toNamed("kurilchanin.tg"));
    expect(c.canMove).toBe("Whoever creates the account kurilchanin.tg first: only tg can create it.");
    expect(c.next).toBe("Ask whoever controls tg to create kurilchanin.tg for you, or send the support message below to the app you swapped in.");
    expect(c.needsHelp).toBe(true);
  });
});

describe("whoCanMove: a transaction still executing", () => {
  it("nothing is final yet and nobody needs to act", () => {
    const c = whoCanMove(report({ verdict: "in_progress", swaps: [swap], withdrawals: [withdrawal], flags: [{ kind: "executing", tx: "WDR", detail: "…" }] }));
    expect(c).toEqual({
      app: "1click-rango",
      place: "executing",
      holds: "NEAR is still executing this order's transaction WDR, so where the money ends up is not final yet.",
      canMove: "Nobody needs to: NEAR finishes a transaction within seconds.",
      next: "Check again in a minute.",
      needsHelp: false,
    });
  });
});

describe("whoCanMove: paid out inside NEAR Intents, and dust", () => {
  const transferPaid: PayoutHop = { status: "arrived", how: "proven", chain: "near", bridge: "near", destination: "akb5911.near", tx: "PAY", amount: "2380462381", delaySec: 0, confirmed: true };
  const transfer = { tx: "PAY", timestampNs: T, height: 3, to: "akb5911.near", toLabel: null, tokens: { "nep141:usdt.tether-token.near": "2380462381" } };

  it("a transfer inside NEAR Intents paid it: it is in that account's NEAR Intents balance", () => {
    const c = whoCanMove(report({ verdict: "settled", swaps: [swap], transfers: [transfer], payout: transferPaid }));
    expect(c).toMatchObject({ place: "arrived", needsHelp: false });
    expect(c.holds).toBe("It was transferred inside NEAR Intents to akb5911.near in transaction PAY: it is in that account's NEAR Intents balance (intents.near), not in a wallet yet.");
    expect(c.canMove).toBe("Whoever holds the key of akb5911.near, from its NEAR Intents balance.");
  });

  it("a refund by transfer says it went back", () => {
    const c = whoCanMove(report({ verdict: "refunded", transfers: [transfer], payout: transferPaid }));
    expect(c.place).toBe("returned");
    expect(c.holds).toMatch(/^It went back inside NEAR Intents to akb5911\.near/);
  });

  it("dust left in the order account is named, with nothing to chase", () => {
    const c = whoCanMove(report({ verdict: "settled", swaps: [swap], withdrawals: [withdrawal], payout: arrived, balances: { "nep141:base.omft.near": "13294652443" }, flags: [{ kind: "dust", detail: "…" }] }));
    expect(c).toMatchObject({ place: "arrived", needsHelp: false });
    expect(c.holds).toMatch(/ Dust worth less than 5 US cents stayed in the order account: 13294652443 nep141:base\.omft\.near\.$/);
  });
});
