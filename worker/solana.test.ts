import { describe, expect, it } from "vitest";

import { solanaRelay } from "./solana.js";

const SITE = "https://wms.example";
const UPSTREAM = "https://rpc.example/?api-key=0123456789abcdef0123";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/api/solana`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

type Sent = { url: string; init: RequestInit | undefined };

function upstream(answer: () => Response): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const f: typeof fetch = async (input, init) => {
    sent.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
    return answer();
  };
  return { fetch: f, sent };
}

const call = (method: string, params: unknown[] = []): string => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

describe("the Solana relay", () => {
  it("passes the two read calls the payout search makes to the configured RPC, unchanged", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: [{ signature: "abc" }] }));
    const body = call("getSignaturesForAddress", ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", { limit: 25 }]);
    const res = await solanaRelay(post(body), UPSTREAM, up.fetch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: [{ signature: "abc" }] });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(up.sent).toHaveLength(1);
    expect(up.sent[0]?.url).toBe(UPSTREAM);
    expect(up.sent[0]?.init?.method).toBe("POST");
    expect(up.sent[0]?.init?.body).toBe(body);

    const tx = await solanaRelay(post(call("getTransaction", ["5h6x", { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }])), UPSTREAM, up.fetch);
    expect(tx.status).toBe(200);
    expect(up.sent).toHaveLength(2);
  });

  it("keeps the RPC's own status, such as a rate limit", async () => {
    const up = upstream(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests" } }), { status: 429 }));
    const res = await solanaRelay(post(call("getTransaction", ["5h6x"])), UPSTREAM, up.fetch);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 429 } });
  });

  it("never shows the RPC's URL or key, even when the RPC repeats it", async () => {
    const up = upstream(() => new Response(`{"error":"bad key 0123456789abcdef0123 for ${UPSTREAM}"}`, { status: 401 }));
    const res = await solanaRelay(post(call("getTransaction", ["5h6x"])), UPSTREAM, up.fetch);
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(text).not.toContain("0123456789abcdef0123");
    expect(text).not.toContain("rpc.example");
  });

  it("answers 503 without asking anyone while no Solana RPC is set, so the page marks Solana payouts unverified", async () => {
    const up = upstream(() => Response.json({ result: "should not be asked" }));
    for (const none of [undefined, "", "  "]) {
      const res = await solanaRelay(post(call("getTransaction", ["5h6x"])), none, up.fetch);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
    }
    expect(up.sent).toHaveLength(0);
  });

  it("relays nothing else: other methods, batches, bad JSON, big bodies and other verbs are refused here", async () => {
    const up = upstream(() => Response.json({ result: "should not be asked" }));
    const refused = async (req: Request): Promise<{ status: number; code: unknown }> => {
      const res = await solanaRelay(req, UPSTREAM, up.fetch);
      const body = (await res.json()) as { error?: { code?: unknown } };
      return { status: res.status, code: body.error?.code };
    };
    expect(await refused(post(call("sendTransaction", ["AQAB"])))).toEqual({ status: 400, code: -32601 });
    expect(await refused(post(call("getBalance", ["9xQe"])))).toEqual({ status: 400, code: -32601 });
    expect(await refused(post(JSON.stringify([JSON.parse(call("getTransaction", ["5h6x"]))])))).toEqual({ status: 400, code: -32601 });
    expect(await refused(post("{not json"))).toEqual({ status: 400, code: -32700 });
    expect(await refused(post(call("getTransaction", ["x".repeat(5_000)])))).toEqual({ status: 413, code: -32600 });
    expect(await refused(new Request(`${SITE}/api/solana`))).toEqual({ status: 405, code: -32600 });
    expect(up.sent).toHaveLength(0);
  });

  it("answers only its own pages: a browser on another site gets 403, a request with no Origin is relayed", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: null }));
    const other = await solanaRelay(post(call("getTransaction", ["5h6x"]), { origin: "https://elsewhere.example" }), UPSTREAM, up.fetch);
    expect(other.status).toBe(403);
    expect(up.sent).toHaveLength(0);
    expect((await solanaRelay(post(call("getTransaction", ["5h6x"]), { origin: SITE }), UPSTREAM, up.fetch)).status).toBe(200);
    expect((await solanaRelay(post(call("getTransaction", ["5h6x"])), UPSTREAM, up.fetch)).status).toBe(200);
  });

  it("a secret that is not a full https address says so, without showing it, and asks no one", async () => {
    const up = upstream(() => Response.json({ result: "should not be asked" }));
    for (const bad of ["00000000-1111-4222-8333-444444444444", "mainnet.helius-rpc.com/?api-key=0123456789abcdef", "http://rpc.example/?api-key=0123456789abcdef0123", "! pbpaste | wrangler secret put SOLANA_RPC_URL"]) {
      const res = await solanaRelay(post(call("getTransaction", ["5h6x"])), bad, up.fetch);
      const text = await res.text();
      expect(res.status).toBe(503);
      expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "SOLANA_RPC_URL is set, but not to a full https:// address: copy the provider's whole RPC URL and set it again" } });
      expect(text).not.toContain("0123456789abcdef");
      expect(text).not.toContain("1111-4222");
    }
    expect(up.sent).toHaveLength(0);
  });

  it("says so when the RPC cannot be reached", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError(`network error for ${UPSTREAM}`);
    };
    const res = await solanaRelay(post(call("getTransaction", ["5h6x"])), UPSTREAM, down);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 } });
    expect(text).not.toContain("rpc.example");
  });
});
