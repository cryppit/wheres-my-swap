// POST /api/solana: the page's payout search reads Solana through here, from a full-history Solana RPC set as the
// SOLANA_RPC_URL secret. Solana's own public RPC refuses browsers (any Origin header) and Cloudflare's network (the
// CF-Worker header on every Worker request), and the keyless RPCs that do answer browsers keep too little history,
// so a payout older than a few hours would look missing (checked 2026-10-17). Without the secret this answers 503
// and the page marks Solana payouts unverified. Only the two read calls the search makes are relayed, one per request,
// for our own pages; the RPC's URL (it may hold a key) never leaves the Worker. Nothing is logged or kept.

const RELAYED = new Set(["getSignaturesForAddress", "getTransaction"]);
const MAX_BODY = 4_096;

const NO_STORE = { "cache-control": "no-store" };

function rpcError(code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers: NO_STORE });
}

function methodOf(call: unknown): unknown {
  return typeof call === "object" && call !== null && !Array.isArray(call) ? (call as { method?: unknown }).method : undefined;
}

/** The parts of the RPC's URL that could be a key: the whole URL, its host, query values and long path segments. */
function secretsOf(upstream: string): string[] {
  try {
    const u = new URL(upstream);
    return [upstream, u.host, ...u.searchParams.values(), ...u.pathname.split("/")].filter((s) => s.length >= 8);
  } catch {
    return [upstream];
  }
}

export async function solanaRelay(request: Request, upstream: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "POST") return rpcError(-32600, "POST a JSON-RPC call", 405);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return rpcError(-32600, "this relay serves Where's My Swap only", 403);
  const text = await request.text();
  if (text.length > MAX_BODY) return rpcError(-32600, "request too large", 413);
  let call: unknown;
  try {
    call = JSON.parse(text);
  } catch {
    return rpcError(-32700, "not JSON", 400);
  }
  const method = methodOf(call);
  if (typeof method !== "string" || !RELAYED.has(method)) return rpcError(-32601, "only getSignaturesForAddress and getTransaction are relayed", 400);
  const rpc = upstream?.trim();
  if (!rpc) return rpcError(-32000, "this site has no full-history Solana RPC yet, so Solana payouts are not searched", 503);
  // A pasted key alone, or the wrong clipboard, is not an address: say which setting to fix, never what it holds.
  let https: boolean;
  try {
    https = new URL(rpc).protocol === "https:";
  } catch {
    https = false;
  }
  if (!https) return rpcError(-32000, "SOLANA_RPC_URL is set, but not to a full https:// address: copy the provider's whole RPC URL and set it again", 503);
  let res: Response;
  try {
    res = await fetchImpl(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: text });
  } catch {
    return rpcError(-32603, "the Solana RPC did not answer", 502);
  }
  let answer = await res.text();
  for (const s of secretsOf(rpc)) answer = answer.split(s).join("[hidden]");
  return new Response(answer, { status: res.status, headers: { "content-type": "application/json", ...NO_STORE } });
}
