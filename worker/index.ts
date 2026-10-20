// The Cloudflare Worker that serves Where's My Swap: the built pages (dist/, as static assets, served before the
// Worker runs), the page's Solana relay and a health route. The checker itself runs in the reader's browser.

import { solanaRelay } from "./solana.js";

export interface Env {
  /** The static assets binding (wrangler.jsonc `assets.binding`). */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** A full-history Solana RPC URL, set as a secret (`wrangler secret put SOLANA_RPC_URL`); optional. */
  SOLANA_RPC_URL?: string;
  /** The commit deployed, set by the deploy script (`--var SOURCE_COMMIT:…`). */
  SOURCE_COMMIT?: string;
}

export interface WorkerOptions {
  fetch?: typeof fetch;
}

const NO_STORE = { "cache-control": "no-store" };

export function makeWorker(o: WorkerOptions = {}) {
  const net: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (pathname === "/api/solana") return solanaRelay(request, env.SOLANA_RPC_URL, net);
      if (pathname === "/api/health") return Response.json({ ok: true, commit: env.SOURCE_COMMIT ?? null }, { headers: NO_STORE });
      return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
    },
  };
}

export default makeWorker();
