// The ZEC route page's pure part: which recent transactions of the NEAR Intents ZEC token are withdrawals to Zcash, and
// what their payouts add up to. The sample is five real transactions of zec.omft.near from 18 Oct 2026 (FastNEAR).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeFastnearTx, parseFastnearJson, type FastnearTransactionsResponse } from "./fastnear.js";
import type { PayoutHop, WithdrawHop } from "./trace.js";
import { accountKind, routeStatus, zecAddressKind, zecAmount, zecRouteSummary, zecWithdrawals, type ZecRouteRow } from "./zec-route.js";

const txs = parseFastnearJson<FastnearTransactionsResponse>(readFileSync(new URL("../fixtures/zec-route/zec-omft-sample.json", import.meta.url), "utf8")).transactions.map(decodeFastnearTx);
const NOW = 1_792_330_000_000_000_000n;

describe("zecWithdrawals", () => {
  it("finds the withdrawals to Zcash, newest first, leaving out ZEC sent to other chains and deposits", () => {
    const found = zecWithdrawals(txs, NOW).map(({ account, withdrawal: w }) => ({ account, tx: w.tx, amount: w.amount, destination: w.destination, timestampNs: w.timestampNs }));
    expect(found).toEqual([
      { account: "crux-solver.near", tx: "4sRsUgMYRPdpcUeksWPqbP7BXxc592eECpSrPgQAvVKm", amount: "7167087948", destination: "zcash:tex19q2cutrsq73dd7q8ff2qck9e97sr0dpqvt7fnm", timestampNs: 1792327712626785920n },
      { account: "9e206befaeb298fda86e1579dd558ae7e8f08030d77d39ff4a03b12484c57f36", tx: "7WzMgqHdumrPtdrKAPRGwgc7AHXLk5AAN6bKXgCVu64g", amount: "854884", destination: "zcash:u13f6dfx2vy2fs5g0uqxs3nat44n5y4jfxeu5nr3e4n8ugwgdwfzkssddx5xjzrtxxtkqcrfh49aq0wfyd9jxamc87qjz99ymhhq6y4lnk7umphf49kdukttndl5vyefq9ucr9vf4mu856quzelc48x0gcdzut8paljmwjcepjr7fxs22qmtlsdy6eagcw8nt4p2tw86xdacjpzlj8uqh", timestampNs: 1792327422431727367n },
      { account: "8216f873f7d085244ded08a0972c510ade83d83235d0ccf38dee71608105d7a7", tx: "6cBY53NcHDaXzKq9pvsVDPQzMbXEjmrHc1uUD1EjdR8X", amount: "561883801", destination: "zcash:t1QKmaVoPNq3Luqq9nwaTacTr7rj7V1cEFa", timestampNs: 1792327354489949517n },
    ]);
  });

  it("each one is the checker's own withdrawal hop: the Omni bridge, chain zec, the ZEC token", () => {
    for (const { withdrawal: w } of zecWithdrawals(txs, NOW)) {
      expect(w).toMatchObject({ kind: "ft_withdraw", token: "nep141:zec.omft.near", chain: "zec", bridge: "omni" });
    }
  });

  it("ignores an ft_withdraw that failed", () => {
    const failed = txs.map((t) => ({ ...t, events: t.events.map((e) => ({ ...e, failed: true as const })) }));
    expect(zecWithdrawals(failed, NOW)).toEqual([]);
  });
});

const base = { chain: "zec", bridge: "omni" as const, destination: "zcash:t1QKmaVoPNq3Luqq9nwaTacTr7rj7V1cEFa" };
const arrived = (delaySec: number): PayoutHop => ({ ...base, status: "arrived", how: "confirmed", tx: `Z${delaySec}`, amount: "1", delaySec, confirmed: true });
const row = (payout: PayoutHop): ZecRouteRow => ({ account: "a".repeat(64), withdrawal: { tx: "T" } as unknown as WithdrawHop, payout });

describe("zecRouteSummary", () => {
  it("counts each status and takes the median and the slowest delay of the payouts that arrived", () => {
    const rows = [arrived(1_200), arrived(300), arrived(900), { ...base, status: "waiting" as const, waitedSec: 60 }, { ...base, status: "not_found" as const, waitedSec: 7_200 }, { ...base, status: "unverified" as const, reason: "the source failed" }].map(row);
    expect(zecRouteSummary(rows)).toEqual({ checked: 6, arrived: 3, waiting: 1, notFound: 1, unverified: 1, medianDelaySec: 900, slowestDelaySec: 1_200 });
  });

  it("has no delays when nothing arrived", () => {
    expect(zecRouteSummary([row({ ...base, status: "waiting", waitedSec: 5 })])).toMatchObject({ checked: 1, arrived: 0, medianDelaySec: null, slowestDelaySec: null });
  });

  it("takes the mean of the middle two for an even count, rounded to a whole second", () => {
    expect(zecRouteSummary([arrived(100), arrived(300)].map(row)).medianDelaySec).toBe(200);
    expect(zecRouteSummary([arrived(74), arrived(75)].map(row)).medianDelaySec).toBe(75);
  });
});

describe("routeStatus", () => {
  it("maps a payout to arrived, waiting, not found or unverified (ambiguous and missing cannot be confirmed)", () => {
    expect(routeStatus(arrived(1))).toBe("arrived");
    expect(routeStatus({ ...base, status: "waiting", waitedSec: 1 })).toBe("waiting");
    expect(routeStatus({ ...base, status: "not_found", waitedSec: 1 })).toBe("not_found");
    expect(routeStatus({ ...base, status: "ambiguous", txs: ["a", "b"] })).toBe("unverified");
    expect(routeStatus({ status: "missing" })).toBe("unverified");
  });
});

describe("labels", () => {
  it("names the kind of Zcash address a payout goes to", () => {
    expect(zecAddressKind("zcash:t1QKmaVoPNq3Luqq9nwaTacTr7rj7V1cEFa")).toBe("transparent");
    expect(zecAddressKind("zcash:t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd")).toBe("transparent (P2SH)");
    expect(zecAddressKind("zcash:tex19q2cutrsq73dd7q8ff2qck9e97sr0dpqvt7fnm")).toBe("TEX");
    expect(zecAddressKind("zcash:u13f6dfx2vy2")).toBe("unified");
    expect(zecAddressKind("zcash:zs1z7rejlpsa98s2rrrfkwmaxu53e4ue")).toBe("Sapling");
    expect(zecAddressKind(null)).toBe("unknown");
  });

  it("writes a raw ZEC amount (8 decimals) without trailing zeros", () => {
    expect(zecAmount("561883801")).toBe("5.61883801");
    expect(zecAmount("854884")).toBe("0.00854884");
    expect(zecAmount("7167087948")).toBe("71.67087948");
    expect(zecAmount("100000000")).toBe("1");
    expect(zecAmount("x")).toBe("x");
  });

  it("tells a 1Click order account from a named account", () => {
    expect(accountKind("8216f873f7d085244ded08a0972c510ade83d83235d0ccf38dee71608105d7a7")).toBe("order account");
    expect(accountKind("0x2cff890f0378a11913b6129b2e97417a2c302680")).toBe("order account");
    expect(accountKind("crux-solver.near")).toBe("named account");
  });
});
