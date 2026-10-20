// Which chain an address belongs to and whether it is well-formed there: the checksum or structure each chain defines,
// checked offline. EVM (EIP-55), Bitcoin (Base58Check, BIP-173 bech32, BIP-350 bech32m), TRON, Dogecoin, XRP (Ripple's
// alphabet), Stellar (SEP-23 StrKey), TON (user-friendly form with CRC16, or raw), Solana (32-byte key, no checksum),
// NEAR (account rules) and Zcash (classifyZcashAddress). A valid form says nothing about who controls the address.

import { classifyZcashAddress, describeZcashAddress, sha256 } from "./zcash-address.js";

export type AddressChain = "evm" | "bitcoin" | "tron" | "dogecoin" | "xrp" | "stellar" | "ton" | "solana" | "near" | "zcash";

export interface AddressVerdict {
  chain: AddressChain;
  valid: boolean;
  kind: string;
  note: string;
}

// --- Keccak-256 (the pre-NIST padding Ethereum uses), on 64-bit lanes as bigints ---------------------------------------
const MASK = (1n << 64n) - 1n;
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n,
  0x80000001n, 0x8000000080008008n,
];
const rotl = (v: bigint, n: number): bigint => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(s: bigint[]): void {
  for (const rc of RC) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) s[x + y] = s[x + y]! ^ d;
    }
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y]!, ROT[x + 5 * y]!);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK & b[((x + 2) % 5) + y]!);
    s[0] = s[0]! ^ rc;
  }
}

export function keccak256(msg: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / rate) * rate);
  padded.set(msg);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  const s = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]!);
      s[i] = s[i]! ^ lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((s[i >> 3]! >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

// --- encodings ----------------------------------------------------------------------------------------------------
const B58_BTC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_XRP = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

function base58Decode(s: string, alphabet: string): Uint8Array | null {
  if (s === "") return null;
  let n = 0n;
  for (const ch of s) {
    const i = alphabet.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (s[zeros] === alphabet[0]) zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/** The version byte of a 25-byte Base58Check payload (version + 20-byte hash + 4-byte checksum), or why it fails. */
function base58Check25(s: string, alphabet: string): { version: number } | { error: string } | null {
  const d = base58Decode(s, alphabet);
  if (d === null || d.length !== 25) return null;
  const sum = sha256(sha256(d.subarray(0, 21)));
  for (let i = 0; i < 4; i++) if (sum[i] !== d[21 + i]) return { error: "the checksum does not match (a mistyped character)" };
  return { version: d[0]! };
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]!;
  }
  return chk >>> 0;
}

/** BIP-173/350 SegWit decoding: witness version and program, with the variant each version must use. */
function segwitDecode(addr: string, hrp: string): { version: number; program: number } | { error: string } {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return { error: "mixed case is not allowed" };
  const s = addr.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (s.slice(0, sep) !== hrp || s.length > 90) return { error: "not a mainnet SegWit address" };
  const data = [...s.slice(sep + 1)].map((c) => BECH32.indexOf(c));
  if (data.length < 7 || data.some((v) => v < 0)) return { error: "characters outside the bech32 alphabet" };
  const chk = bech32Polymod([...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]);
  const version = data[0]!;
  const want = version === 0 ? 1 : 0x2bc830a3;
  if (chk !== want) return { error: chk === 1 || chk === 0x2bc830a3 ? "wrong checksum variant for its witness version" : "the checksum does not match (a mistyped character)" };
  const bits = data.slice(1, -6).length * 5;
  const program = Math.floor(bits / 8);
  if (version > 16 || program < 2 || program > 40 || (version === 0 && program !== 20 && program !== 32)) return { error: "invalid witness program length" };
  return { version, program };
}

function base32Decode(s: string): Uint8Array | null {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const i = A.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** CRC16-XModem (poly 0x1021, init 0): Stellar StrKey and TON user-friendly addresses. */
function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base64UrlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(s)) return null;
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

// --- chains -------------------------------------------------------------------------------------------------------
function evm(a: string): AddressVerdict {
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return { chain: "evm", valid: true, kind: "no checksum", note: "Well-formed, but written in one case, so it carries no EIP-55 checksum: a mistyped character would not be caught." };
  }
  const hash = keccak256(new TextEncoder().encode(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    const ch = body[i]!;
    if (/[a-f]/i.test(ch) && (nibble >= 8) !== (ch === ch.toUpperCase())) {
      return { chain: "evm", valid: false, kind: "checksum mismatch", note: "The mixed-case EIP-55 checksum does not match: at least one character is wrong." };
    }
  }
  return { chain: "evm", valid: true, kind: "checksummed", note: "EIP-55 checksum matches (Ethereum, Base, Arbitrum, BNB Chain and every EVM chain use this form)." };
}

const NEAR_NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const BASE58_CHAINS: { chain: AddressChain; test: RegExp; alphabet: string; versions: Record<number, string> }[] = [
  { chain: "bitcoin", test: /^[13]/, alphabet: B58_BTC, versions: { 0x00: "P2PKH", 0x05: "P2SH" } },
  { chain: "tron", test: /^T/, alphabet: B58_BTC, versions: { 0x41: "account" } },
  { chain: "dogecoin", test: /^[DA9]/, alphabet: B58_BTC, versions: { 0x1e: "P2PKH", 0x16: "P2SH" } },
  { chain: "xrp", test: /^r/, alphabet: B58_XRP, versions: { 0x00: "classic address" } },
];

export function checkAddress(raw: string): AddressVerdict[] {
  const a = raw.trim();
  if (a === "") return [];
  const out: AddressVerdict[] = [];

  if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
    out.push(evm(a));
    if (a === a.toLowerCase()) out.push({ chain: "near", valid: true, kind: "eth-like account", note: "Also a valid NEAR account id of the 0x form (NEAR Intents gives EVM and TRON users one)." });
    return out;
  }
  if (/^[0-9a-f]{64}$/.test(a)) {
    return [{ chain: "near", valid: true, kind: "implicit account", note: "A NEAR implicit account (64 hex characters, the public key itself); NEAR Intents order accounts have this form." }];
  }
  if (/^(bc1|BC1)/.test(a)) {
    const d = segwitDecode(a, "bc");
    if ("error" in d) return [{ chain: "bitcoin", valid: false, kind: "SegWit", note: d.error }];
    const kind = d.version === 0 ? "SegWit v0" : d.version === 1 && d.program === 32 ? "Taproot" : `SegWit v${d.version}`;
    return [{ chain: "bitcoin", valid: true, kind, note: `Checksum and witness program verify (${d.version === 0 ? "bech32, BIP-173" : "bech32m, BIP-350"}).` }];
  }
  if (/^(t1|t3|tex1|u1|zs1)/i.test(a)) {
    const z = classifyZcashAddress(a);
    if (z.kind !== "unknown") return [{ chain: "zcash", valid: z.valid, kind: z.kind, note: describeZcashAddress(z) }];
  }
  if (/^G[A-Z2-7]{55}$/.test(a)) {
    const d = base32Decode(a);
    const ok = d !== null && d.length === 35 && d[0] === 6 << 3 && crc16(d.subarray(0, 33)) === (d[33]! | (d[34]! << 8));
    return [{ chain: "stellar", valid: ok, kind: "account", note: ok ? "StrKey version byte and CRC16 verify (SEP-23)." : "The StrKey checksum or version byte does not verify (a mistyped character)." }];
  }
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) {
    const wc = Number(a.split(":")[0]);
    const ok = wc === 0 || wc === -1;
    return [{ chain: "ton", valid: ok, kind: "raw", note: ok ? "Raw TON form (workchain:hash). It carries no checksum and no bounce flag." : "Unknown TON workchain." }];
  }
  const ton = base64UrlDecode(a);
  if (ton !== null && ton.length === 36) {
    const tag = ton[0]! & 0x7f;
    const ok = (tag === 0x11 || tag === 0x51) && crc16(ton.subarray(0, 34)) === ((ton[34]! << 8) | ton[35]!);
    const testnet = (ton[0]! & 0x80) !== 0;
    return [{ chain: "ton", valid: ok && !testnet, kind: tag === 0x11 ? "bounceable" : "non-bounceable", note: !ok ? "The TON address checksum does not verify (a mistyped character)." : testnet ? "A TON testnet address." : "TON user-friendly address; tag and CRC16 verify." }];
  }

  const shaped: AddressChain[] = [];
  for (const c of BASE58_CHAINS) {
    if (!c.test.test(a)) continue;
    shaped.push(c.chain);
    const r = base58Check25(a, c.alphabet);
    if (r === null) continue;
    if ("error" in r) out.push({ chain: c.chain, valid: false, kind: "Base58Check", note: r.error });
    else if (c.versions[r.version] !== undefined) out.push({ chain: c.chain, valid: true, kind: c.versions[r.version]!, note: "Base58Check checksum and version byte verify." });
  }
  if (out.length > 0) return out;
  const sol = base58Decode(a, B58_BTC);
  if (sol !== null && sol.length === 32 && a.length >= 32 && a.length <= 44) {
    return [{ chain: "solana", valid: true, kind: "account", note: "A well-formed 32-byte Solana key. Solana addresses have no checksum, so a mistyped one can still look valid: compare it character by character." }];
  }
  if (/[.]/.test(a) && /^[A-Za-z0-9._-]{2,64}$/.test(a) && !/^\d+(\.\d+)*$/.test(a)) {
    const ok = NEAR_NAMED.test(a);
    return [{ chain: "near", valid: ok, kind: "named account", note: ok ? "A well-formed NEAR account name (whether it exists on chain is not checked here)." : "Not a valid NEAR account name: names are lower case letters, digits and - _ separators." }];
  }
  for (const chain of shaped) out.push({ chain, valid: false, kind: "Base58Check", note: "Wrong length or characters for this chain's address." });
  return out;
}
