// The address page: addresses typed or pasted → plainAddress (src/address-advice.ts), offline, in the browser → one card
// per address with what it means in plain words and, for Zcash, whether a transparent-only or shielded wallet can pay it.

import { plainAddress, type PlainAddress } from "../src/address-advice.js";
import type { AddressChain } from "../src/core/addresses.js";
import type { SendAnswer } from "../src/core/zcash-address.js";
import { esc } from "../src/render-html.js";
import { fromHash, goTo } from "./shared.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const input = $<HTMLTextAreaElement>("q");
const hint = $<HTMLSelectElement>("hint");
const out = $<HTMLDivElement>("out");

const MAX = 20;

function answer(label: string, a: SendAnswer): string {
  const yes = a.can !== "no";
  return `<div class="addr-answer ${yes ? "yes" : "no"}"><span class="addr-mark" aria-hidden="true">${yes ? "✓" : "✕"}</span><div><b>${esc(label)}</b><p>${esc(a.why)}</p></div></div>`;
}

function card(p: PlainAddress): string {
  const status = p.chain === null ? "not recognised" : p.valid ? "valid" : "has a mistake";
  const zcash = p.zcash ? `<div class="addr-answers">${answer("From a transparent-only wallet", p.zcash.transparent)}${answer("From a shielded wallet", p.zcash.shielded)}</div>` : "";
  const steps = p.steps.length ? `<ol class="addr-steps">${p.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : "";
  return [
    `<article class="addr-card" data-valid="${p.valid}">`,
    `<p class="addr-top"><code>${esc(p.address)}</code><span class="addr-chip">${esc(p.chain ?? "Unknown")} · ${esc(status)}</span></p>`,
    `<div class="addr-plain"><p class="eyebrow">What this means for you</p><h3>${esc(p.headline)}</h3>${zcash}${steps}</div>`,
    p.chain ? `<p class="addr-what">${esc(p.what)}</p>` : "",
    `</article>`,
  ].join("");
}

function run(text: string): void {
  const lines = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const unique = [...new Set(lines)].slice(0, MAX);
  input.value = unique.join("\n");
  if (unique.length === 0) {
    out.innerHTML = "";
    return;
  }
  const h = (hint.value || null) as AddressChain | null;
  out.innerHTML = unique.map((a) => card(plainAddress(a, h))).join("") + (lines.length > MAX ? `<p class="note">Only the first ${MAX} addresses were checked.</p>` : "");
}

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  goTo(input.value.trim(), run);
});
window.addEventListener("hashchange", () => run(fromHash()));
if (fromHash()) run(fromHash());
