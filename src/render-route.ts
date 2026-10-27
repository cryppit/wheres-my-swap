// The route as HTML: a journey header, the five stops and the four segments between them. The page animates it in
// (web/route.ts); without script or with reduced motion it is already the finished picture. Pure string building.

import type { Route, RouteStop, StopState } from "./core/route.js";
import { describeDuration } from "./core/trace.js";
import { esc } from "./render-html.js";

const STATE_TEXT: Record<StopState, string> = {
  done: "Done",
  unverified: "Unverified",
  private: "Private",
  stopped: "Stopped here",
  waiting: "Waiting",
  not_reached: "Not reached",
};

const ICON: Record<StopState, string> = {
  done: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  unverified: '<path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.4-1.5 1.1-1.5 2.1v.4M12 18h.01"/>',
  private: '<rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  stopped: '<path d="M12 6.5v7M12 17.5h.01"/>',
  waiting: '<circle cx="12" cy="12" r="7"/><path d="M12 8.5V12l2.5 1.5"/>',
  not_reached: '<circle cx="12" cy="12" r="2.2"/>',
};

/** Chains with a logo under /logos (web3icons, MIT: web/public/logos/LICENSE). Others keep the state icon alone. */
export const LOGOS = new Set(["eth", "base", "arb", "op", "bsc", "bnb", "pol", "avax", "gnosis", "bera", "monad", "plasma", "scroll", "tron", "btc", "ltc", "doge", "bch", "dash", "zec", "zcash", "xrp", "sol", "ton", "sui", "stellar", "aptos", "cardano", "starknet", "near", "linea", "zksync", "movement", "hlevm", "hypercore"]);
const FILE: Record<string, string> = { bnb: "bsc", zcash: "zec", hlevm: "hyperliquid", hypercore: "hyperliquid" };
export const logoUrl = (chain: string | null): string | null => (chain && LOGOS.has(chain) ? `/logos/${FILE[chain] ?? chain}.svg` : null);

const icon = (s: StopState): string => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[s]}</svg>`;

/** A segment takes the look of the stop it leads to: drawn, broken where the route stopped or waits, ghost after. */
function segClass(to: RouteStop): string {
  if (to.state === "stopped") return "broken";
  if (to.state === "waiting") return "waiting";
  if (to.state === "not_reached") return "unreached";
  return "done";
}

function stopHtml(s: RouteStop, i: number): string {
  const state = s.state === "stopped" && s.reason ? s.reason : STATE_TEXT[s.state];
  const logo = logoUrl(s.chain);
  const node = logo ? `<img class="tlogo" src="${logo}" alt="" width="28" height="28" decoding="async"><span class="tbadge">${icon(s.state)}</span>` : icon(s.state);
  return `<li class="tstop ${s.state}${logo ? " has-logo" : ""}" style="--i:${i}"><span class="tnode" aria-hidden="true">${node}</span><span class="tlabel"><b>${esc(s.title)}</b><span class="tplace">${esc(s.place)}</span><span class="tstate">${esc(state)}</span></span></li>`;
}

export function renderRoute(route: Route): string {
  const { stops } = route;
  const words = stops.map((s) => `${s.title}: ${s.state === "stopped" && s.reason ? `stopped here, ${s.reason}` : STATE_TEXT[s.state].toLowerCase()}`).join("; ");
  const label = `Route: ${route.from ?? "an unknown chain"} to ${route.to ?? (route.stopIndex === null ? "the destination" : "nowhere yet")}. ${words}.`;
  const path = `<span class="trace-path"><b>${esc(route.from ?? "Origin")}</b> <span class="trace-arrow" aria-hidden="true">→</span> ${route.to ? `<b>${esc(route.to)}</b>` : `<span class="trace-none">${route.stopIndex === null ? "destination" : "not paid out"}</span>`}</span>`;
  const total = route.totalSec !== null ? `<span class="trace-total">${esc(describeDuration(route.totalSec))} total</span>` : "";
  const segs = stops
    .slice(1)
    .map((to, i) => {
      const sec = route.segmentsSec[i];
      const dur = sec != null && to.state !== "not_reached" ? `<span class="tdur">${esc(describeDuration(sec))}</span>` : "";
      return `<span class="tseg ${segClass(to)}" style="--i:${i}"${sec != null ? ` data-sec="${sec}"` : ""}><i class="tfill"></i><i class="tpacket"></i>${dur}</span>`;
    })
    .join("");
  const back = route.refunded ? '<svg class="treturn" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><path d="M90 2 C90 22 10 22 10 2" vector-effect="non-scaling-stroke"/></svg>' : "";
  return `<figure class="trace" data-stop="${route.stopIndex ?? "none"}"${route.refunded ? " data-refunded" : ""} aria-label="${esc(label)}"><figcaption class="trace-head">${path}${total}</figcaption><div class="trace-body"><div class="trace-segs" aria-hidden="true">${segs}</div>${back}<ol class="trace-stops">${stops.map(stopHtml).join("")}</ol></div></figure>`;
}
