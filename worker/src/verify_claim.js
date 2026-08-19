/**
 * verify_claim.js — server-side verification for .gunx domain claims.
 *
 * Runs on Cloudflare Workers (Web Crypto) and Node (same API), so the exact
 * same code path guards the Durable Object and the unit tests.
 *
 * A claim record (see sdk/tld/registry.js):
 *   { name, ownerPub, target, ts, nonce, diff, hash, sig }
 *
 * Verification is two-layered, matching the client SDK exactly:
 *   1. Proof-of-Work  — SHA-256(`${name}:${ownerPub}:${target}:${ts}:${nonce}`)
 *                      must start with `0`×diff; diff must match name length.
 *   2. SEA signature  — gun SEA v1: ECDSA P-256 / SHA-256 over the canonical
 *                      JSON of the claim body (sig excluded). The signature
 *                      envelope is `"SEA" + JSON.stringify({m, s})` where m is
 *                      the signed message string and s a base64 ECDSA sig.
 *                      The public key is JWK-style `x.y` (two base64url
 *                      coordinates, no padding).
 */

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Difficulty bracket — mirrors sdk/tld/pow.js. 1-3: 6, 4-7: 4, 8+: 2 */
export function getDifficulty(name) {
  const len = String(name).length;
  if (len <= 3) return 6;
  if (len <= 7) return 4;
  return 2;
}

/** Canonical hash input — must match sdk/tld/pow.js exactly. */
export function hashInput(name, ownerPub, target, ts, nonce) {
  return `${name}:${ownerPub}:${target}:${ts}:${nonce}`;
}

/** SHA-256 hex digest via Web Crypto (async, works everywhere). */
export async function sha256Hex(input) {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify a claim's proof-of-work.
 * @returns {{ok:boolean, error?:string}}
 */
export async function verifyPoW(claim) {
  if (!claim || typeof claim !== "object") return { ok: false, error: "claim required" };
  const name = String(claim.name || "").toLowerCase();
  if (!NAME_RE.test(name)) return { ok: false, error: "invalid name" };
  const expected = getDifficulty(name);
  const diff = typeof claim.diff === "number" ? claim.diff : expected;
  if (diff !== expected) return { ok: false, error: "difficulty mismatch" };
  const target = typeof claim.target === "string" ? claim.target : String(claim.target ?? "");
  const nonce = typeof claim.nonce === "number" ? claim.nonce : Number(claim.nonce);
  if (!Number.isFinite(nonce) || nonce < 0) return { ok: false, error: "invalid nonce" };
  const ts = typeof claim.ts === "number" ? claim.ts : Number(claim.ts);
  if (!Number.isFinite(ts)) return { ok: false, error: "invalid ts" };
  const hash = await sha256Hex(hashInput(name, claim.ownerPub, target, ts, nonce));
  const prefix = "0".repeat(diff);
  if (!hash.startsWith(prefix)) return { ok: false, error: "proof-of-work not satisfied" };
  if (claim.hash && claim.hash !== hash) return { ok: false, error: "hash mismatch" };
  return { ok: true, hash };
}

/** Build the canonical body a signature covers (sig excluded, insertion order). */
export function claimBody(claim) {
  const body = {};
  for (const k of Object.keys(claim)) {
    if (k === "sig") continue;
    body[k] = claim[k];
  }
  return body;
}

/** Canonical JSON for message comparison — key-sorted, order-agnostic. */
function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/** base64 / base64url → Uint8Array (padding-tolerant). */
function b64ToBytes(b64) {
  const s = String(b64).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let subtle = null;
if (typeof crypto !== "undefined" && crypto.subtle) subtle = crypto.subtle;

/**
 * Verify a gun SEA v1 signature (ECDSA P-256 / SHA-256) with the bare public
 * key — the same verification SEA.verify performs client-side.
 *
 * @param {object} body   canonical claim body (sig excluded)
 * @param {string} sig    SEA envelope: "SEA" + JSON.stringify({m, s})
 * @param {string} pub    SEA public key: base64url x . base64url y
 * @returns {Promise<boolean>}
 */
export async function verifySeaSig(body, sig, pub) {
  if (!subtle) throw new Error("verify_claim: Web Crypto unavailable");
  try {
    const raw = typeof sig === "string" && sig.slice(0, 4) === "SEA{" ? sig.slice(3) : sig;
    const env = JSON.parse(raw);
    if (!env || typeof env !== "object" || typeof env.s !== "string") {
      return false;
    }
    // The signed message: gun SEA keeps m as an object when signing objects;
    // the digest is computed over its canonical JSON, so we do the same.
    // Key order may differ between environments — compare canonically.
    const mStr = typeof env.m === "string" ? env.m : JSON.stringify(env.m);
    if (canonicalJson(env.m) !== canonicalJson(body)) return false;

    const [x, y] = String(pub).split(".");
    if (!x || !y) return false;
    const key = await subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x, y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const hash = await subtle.digest("SHA-256", new TextEncoder().encode(mStr));
    const sigBytes = b64ToBytes(env.s);
    return await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      sigBytes,
      hash,
    );
  } catch {
    return false;
  }
}

/** End-to-end claim verification: PoW + difficulty + SEA signature. */
export async function verifyClaim(claim) {
  const pw = await verifyPoW(claim);
  if (!pw.ok) return { ok: false, error: pw.error };
  const body = claimBody(claim);
  const verified = await verifySeaSig(body, claim.sig, claim.ownerPub);
  if (!verified) return { ok: false, error: "SEA signature invalid" };
  return { ok: true, claim };
}