// The ZEC route page's HTML: a one-sentence summary and a table of the newest ZEC withdrawals from NEAR Intents to
// Zcash, each with its payout's state and a link to its full trace.
import { describe, expect, it } from "vitest";

import type { PayoutHop, WithdrawHop } from "./core/trace.js";
import type { ZecRouteRow } from "./core/zec-route.js";
import { renderZecRouteHtml } from "./render-zec.js";
import type { ZecRouteResult } from "./zec-route.js";

const AT = 1_792_327_354_489_949_517n; // 2026-10-18 12:42:34 UTC
const withdrawal = (tx: string, amount: string, destination: string): WithdrawHop => ({ status: "proven", tx, timestampNs: AT, height: 1, intentHash: null, kind: "ft_withdraw", token: "nep141:zec.omft.near", amount, chain: "zec", bridge: "omni", destination, externalId: null });
const base = (w: WithdrawHop) => ({ chain: w.chain, bridge: w.bridge, destination: w.destination });
const row = (account: string, w: WithdrawHop, payout: PayoutHop): ZecRouteRow => ({ account, withdrawal: w, payout });

const t1 = withdrawal("6cBY53NcHDaXzKq9pvsVDPQzMbXEjmrHc1uUD1EjdR8X", "561883801", "zcash:t1QKmaVoPNq3Luqq9nwaTacTr7rj7V1cEFa");
const u1 = withdrawal("7WzMgqHdumrPtdrKAPRGwgc7AHXLk5AAN6bKXgCVu64g", "854884", "zcash:u13f6dfx2vy2fs5g0uqxs3nat44n5y4jfxeu5nr3e4n8ugwgdwfzkssddx5xjzrtxxtkqc");
const tex = withdrawal("4sRsUgMYRPdpcUeksWPqbP7BXxc592eECpSrPgQAvVKm", "7167087948", "zcash:tex19q2cutrsq73dd7q8ff2qck9e97sr0dpqvt7fnm");
const lost = withdrawal("LOST", "100000000", "zcash:t1Lost");

const result = (rows: ZecRouteRow[], summary: ZecRouteResult["summary"]): ZecRouteResult => ({ rows, summary, scanned: 120, checkedAtNs: AT + 600_000_000_000n });

describe("renderZecRouteHtml", () => {
  const r = result(
    [
      row("8216f873f7d085244ded08a0972c510ade83d83235d0ccf38dee71608105d7a7", t1, { ...base(t1), status: "arrived", how: "confirmed", tx: "zt1", amount: "561883801", delaySec: 420, confirmed: true }),
      row("9e206befaeb298fda86e1579dd558ae7e8f08030d77d39ff4a03b12484c57f36", u1, { ...base(u1), status: "arrived", how: "shielded", tx: "zu1", amount: null, delaySec: 1_260, confirmed: true, shieldedPool: "Orchard" }),
      row("crux-solver.near", tex, { ...base(tex), status: "waiting", waitedSec: 60 }),
      row("0x2cff890f0378a11913b6129b2e97417a2c302680", lost, { ...base(lost), status: "not_found", waitedSec: 7_200 }),
    ],
    { checked: 4, arrived: 2, waiting: 1, notFound: 1, unverified: 0, medianDelaySec: 840, slowestDelaySec: 1_260 },
  );
  const html = renderZecRouteHtml(r);

  it("opens with one sentence: how many arrived, how fast, and what is still open", () => {
    expect(html).toContain('<p class="route-summary">Of the last <b>4</b> ZEC withdrawals from NEAR Intents to Zcash, <b>2 arrived</b> (median 14 min from the withdrawal on NEAR to the payout on Zcash; the slowest 21 min). 1 is on its way. <b>1 not found</b> yet.</p>');
  });

  it("lists each withdrawal: when, how much, where to, the payout and its trace", () => {
    expect(html).toContain("<td>18 Oct, 12:42 UTC</td>");
    expect(html).toContain("<b>5.61883801 ZEC</b>");
    expect(html).toContain("transparent <code>t1QKmaVo…V1cEFa</code>");
    expect(html).toContain("unified <code>u13f6dfx…xxtkqc</code>");
    expect(html).toContain('<td class="hi">Arrived in 7 min</td>');
    expect(html).toContain('<td class="hi">Arrived in 21 min, shielded (Orchard)</td>');
    expect(html).toContain("<td>On its way, 60 s so far</td>");
    expect(html).toContain('<td class="warn">Not found after 2 h</td>');
    expect(html).toContain('<a href="/#q=6cBY53NcHDaXzKq9pvsVDPQzMbXEjmrHc1uUD1EjdR8X">Trace</a>');
  });

  it("names who sent it: a 1Click order account, or the named account", () => {
    expect(html).toContain("1Click order");
    expect(html).toContain("crux-solver.near");
  });

  it("says where the data comes from and when it was read", () => {
    expect(html).toContain("Read live at 18 Oct, 12:52 UTC from public data: NEAR (FastNEAR), the Omni bridge's indexer and contracts, and the Zcash chain (Blockchair). The newest 120 transactions of the ZEC token (zec.omft.near) were read; nothing is stored.");
  });

  it("escapes what the chain says", () => {
    const evil = withdrawal("T<x>", "1", "zcash:t1<script>");
    const out = renderZecRouteHtml(result([row("a<b>.near", evil, { ...base(evil), status: "unverified", reason: "<img src=x>" })], { checked: 1, arrived: 0, waiting: 0, notFound: 0, unverified: 1, medianDelaySec: null, slowestDelaySec: null }));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("Could not check: &lt;img src=x&gt;");
    expect(out).toContain("a&lt;b&gt;.near");
  });

  it("says plainly when the Zcash data source has hit its free limit", () => {
    const busy = renderZecRouteHtml(result([row("a".repeat(64), t1, { ...base(t1), status: "unverified", reason: "could not read zec: api.blockchair.com /zcash/dashboards/transaction/d658: HTTP 402" })], { checked: 1, arrived: 0, waiting: 0, notFound: 0, unverified: 1, medianDelaySec: null, slowestDelaySec: null }));
    expect(busy).toContain("<td>Could not check: the Zcash data source (Blockchair) has hit its free limit, try again in a few minutes</td>");
    expect(busy).not.toContain("api.blockchair.com");
  });

  it("says so when the newest transactions hold no withdrawal to Zcash", () => {
    expect(renderZecRouteHtml(result([], { checked: 0, arrived: 0, waiting: 0, notFound: 0, unverified: 0, medianDelaySec: null, slowestDelaySec: null }))).toContain(
      "No withdrawal to Zcash among the newest 120 transactions of the ZEC token. Check again in a few minutes.",
    );
  });
});
