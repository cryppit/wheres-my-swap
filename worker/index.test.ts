import { describe, expect, it } from "vitest";

import { makeWorker, type Env } from "./index.js";

const SITE = "https://wms.example";

function assets(): { binding: Env["ASSETS"]; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    binding: {
      async fetch(request: Request): Promise<Response> {
        asked.push(new URL(request.url).pathname);
        return new Response("<!doctype html>page", { headers: { "content-type": "text/html" } });
      },
    },
  };
}

/** Network for the Worker under test: a Solana RPC, faked; anything else fails. */
function network(): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    if (url === "https://solana.example/rpc") return Response.json({ jsonrpc: "2.0", id: 1, result: null });
    throw new TypeError("offline");
  };
  return { fetch: f, asked };
}

describe("the Worker's routes", () => {
  it("serves the pages from the static assets", async () => {
    const w = makeWorker({ fetch: network().fetch });
    const a = assets();
    for (const p of ["/", "/refund", "/assets/main-abc.js", "/img/mark.png"]) {
      const res = await w.fetch(new Request(`${SITE}${p}`), { ASSETS: a.binding });
      expect(res.status).toBe(200);
    }
    expect(a.asked).toEqual(["/", "/refund", "/assets/main-abc.js", "/img/mark.png"]);
  });

  it("relays the page's Solana calls to the configured RPC, and says 503 while none is set", async () => {
    const net = network();
    const w = makeWorker({ fetch: net.fetch });
    const a = assets();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: ["5h6x"] });
    const none = await w.fetch(new Request(`${SITE}/api/solana`, { method: "POST", body }), { ASSETS: a.binding });
    expect(none.status).toBe(503);
    const res = await w.fetch(new Request(`${SITE}/api/solana`, { method: "POST", body }), { ASSETS: a.binding, SOLANA_RPC_URL: "https://solana.example/rpc" });
    expect(res.status).toBe(200);
    expect(net.asked).toEqual(["https://solana.example/rpc"]);
    expect(a.asked).toEqual([]);
  });

  it("names the deployed commit at /api/health", async () => {
    const res = await makeWorker().fetch(new Request(`${SITE}/api/health`), { ASSETS: assets().binding, SOURCE_COMMIT: "198c035" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, commit: "198c035" });
  });

  it("answers any other /api/ path with a 404, never the assets", async () => {
    const a = assets();
    const res = await makeWorker().fetch(new Request(`${SITE}/api/recorder/list`), { ASSETS: a.binding });
    expect(res.status).toBe(404);
    expect(a.asked).toEqual([]);
  });
});
