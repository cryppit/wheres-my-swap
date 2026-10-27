// What every page shares: the `#q=` hash a check is linked by, copy buttons, and the busy-NEAR message. Pages are on
// the wall clock; the checks they run are the package's pure code.

import { fastnearUnavailable } from "../src/check.js";
import { NearRpcUnavailable } from "../src/core/rpc.js";
import { esc } from "../src/render-html.js";

export function fromHash(): string {
  const m = /^#q=(.+)$/.exec(location.hash);
  if (!m?.[1]) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return "";
  }
}

/** Sets the hash for a query (which runs it through `hashchange`), or runs it again when the hash is already that. */
export function goTo(query: string, run: (q: string) => void): void {
  const next = `#q=${encodeURIComponent(query)}`;
  if (location.hash === next) run(query);
  else location.hash = next;
}

/** Every `[data-copy]` button under `root` copies its text, and says so for a moment. */
export function wireCopyButtons(root: HTMLElement): void {
  root.addEventListener("click", (ev) => {
    const button = ev.target instanceof Element ? ev.target.closest<HTMLButtonElement>("button[data-copy]") : null;
    if (!button) return;
    const label = button.textContent ?? "";
    void navigator.clipboard.writeText(button.dataset["copy"] ?? "").then(
      () => {
        button.textContent = "Copied";
        button.dataset["done"] = "";
        setTimeout(() => {
          button.textContent = label;
          delete button.dataset["done"];
        }, 1600);
      },
      () => undefined,
    );
  });
}

export const busy = (e: unknown): boolean => fastnearUnavailable(e) || e instanceof NearRpcUnavailable;

/** An error box; when the sources were only busy, with a button to try again. */
export function errorHtml(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return busy(e)
    ? `<div class="error"><p>NEAR’s public data services are busy right now, so this check could not finish. Nothing is wrong with your query.</p><button type="button" class="ghost" data-retry>Try again</button></div>`
    : `<div class="error">${esc(message)}</div>`;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** What shows while a check reads public data: a glowing card that says what is being read, so nobody thinks it froze. */
export const loadingHtml = (title: string, detail: string): string =>
  `<div class="loading" role="status"><span class="ld-orb" aria-hidden="true"></span><div class="ld-text"><b>${esc(title)}</b><span>${esc(detail)}</span></div><span class="ld-bar" aria-hidden="true"></span></div>`;
