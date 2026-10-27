import { describe, expect, it } from "vitest";

import type { Route } from "./core/route.js";
import { logoUrl, renderRoute } from "./render-route.js";

const base: Route = {
  stops: [
    { key: "origin", title: "Deposit", place: "Ethereum", state: "done", atNs: null, chain: "eth" },
    { key: "credit", title: "Credited", place: "NEAR Intents", state: "done", atNs: 1n, chain: "near" },
    { key: "swap", title: "Swapped", place: "NEAR Intents", state: "done", atNs: 2n, chain: "near" },
    { key: "withdrawal", title: "Withdrawn", place: "to Solana", state: "done", atNs: 3n, chain: "near" },
    { key: "payout", title: "Paid out", place: "Solana", state: "done", atNs: 4n, chain: "fogo" },
  ],
  from: "Ethereum",
  to: "Solana",
  refunded: false,
  stopIndex: null,
  segmentsSec: [null, 12, 8, 40],
  totalSec: 60,
};

describe("renderRoute", () => {
  it("draws a journey header, five stops and four segments, each with its state", () => {
    const html = renderRoute(base);
    expect(html).toContain('class="trace"');
    expect(html).toMatch(/<b>Ethereum<\/b>.*→.*<b>Solana<\/b>/s);
    expect(html).toContain("60 s total");
    expect(html.match(/class="tstop /g)).toHaveLength(5);
    expect(html.match(/class="tseg /g)).toHaveLength(4);
    expect(html).toContain('data-sec="12"');
    expect(html).toContain(">12 s<");
  });

  it("marks where a stuck order stopped, with its reason, and the stops after it as not reached", () => {
    const stops = base.stops.map((s, i) => (i === 2 ? { ...s, state: "stopped" as const, reason: "Locked 187 days" } : i > 2 ? { ...s, state: "not_reached" as const } : s));
    const html = renderRoute({ ...base, stops, stopIndex: 2, to: null, segmentsSec: [null, null, null, null], totalSec: null });
    expect(html).toContain('data-stop="2"');
    expect(html).toContain('class="tstop stopped has-logo"');
    expect(html).toContain("Locked 187 days");
    expect(html.match(/Not reached/g)).toHaveLength(2);
    expect(html).toContain('class="tseg broken"');
    expect(html.match(/class="tseg unreached"/g)).toHaveLength(2);
    expect(html).toContain("not paid out");
  });

  it("shows each chain's logo with the state as a badge, and the state icon alone where there is no logo", () => {
    const html = renderRoute(base);
    expect(html).toContain('<img class="tlogo" src="/logos/eth.svg"');
    expect(html).toContain('src="/logos/near.svg"');
    expect(html.match(/class="tstop done has-logo"/g)).toHaveLength(4);
    expect(html).toContain('class="tstop done" style="--i:4"');
  });

  it("draws the way back for a refund", () => {
    expect(renderRoute({ ...base, refunded: true })).toContain('class="treturn"');
    expect(renderRoute(base)).not.toContain('class="treturn"');
  });

  it("escapes what it shows and says the route in words for screen readers", () => {
    const html = renderRoute({ ...base, from: "<x>", stops: base.stops.map((s, i) => (i === 0 ? { ...s, place: "<x>" } : s)) });
    expect(html).not.toContain("<x>");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toMatch(/aria-label="Route: &lt;x&gt; to Solana\. Deposit: done; Credited: done;/);
  });
});

describe("logoUrl", () => {
  it("draws Hyperliquid's mark for HyperEVM and HyperCore stops, and Movement's for Movement", () => {
    expect(logoUrl("hlevm")).toBe("/logos/hyperliquid.svg");
    expect(logoUrl("hypercore")).toBe("/logos/hyperliquid.svg");
    expect(logoUrl("movement")).toBe("/logos/movement.svg");
    expect(logoUrl("aleo")).toBeNull();
  });
});
