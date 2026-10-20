// The ZEC route page: the newest NEAR Intents ZEC withdrawals to Zcash (zecRoute), each checked for its payout from the
// browser with the checker's own search, then one summary sentence and a table (renderZecRouteHtml).

import { fastnearClient, searchPayout } from "../src/check.js";
import { publicPayoutClient } from "../src/payouts.js";
import { renderZecRouteHtml } from "../src/render-zec.js";
import { fastnearZecSource, zecRoute } from "../src/zec-route.js";
import { errorHtml } from "./shared.js";

const out = document.getElementById("route") as HTMLDivElement;
const payouts = publicPayoutClient(undefined, { solanaRpc: new URL("/api/solana", location.href).href });

let running = 0;

async function run(): Promise<void> {
  const id = ++running;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  out.innerHTML = '<p class="status-line">Reading the newest ZEC withdrawals…</p>';
  try {
    const r = await zecRoute(fastnearZecSource(fastnearClient()), (w) => searchPayout(w, payouts, nowNs), nowNs, {
      onRow: (rows, total) => {
        if (id === running) out.innerHTML = `<p class="status-line">Checked ${rows.length} of ${total} payouts on the Zcash chain…</p>`;
      },
    });
    if (id === running) out.innerHTML = renderZecRouteHtml(r);
  } catch (e) {
    if (id === running) out.innerHTML = errorHtml(e);
  }
}

out.addEventListener("click", (ev) => {
  const retry = ev.target instanceof Element ? ev.target.closest("button[data-retry]") : null;
  if (retry) void run();
});

void run();
