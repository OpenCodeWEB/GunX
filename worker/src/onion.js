/**
 * onion.js — Tor v3 onion address support for the .onion TLD (Track tor-onion).
 *
 * SHA3-256 comes from @noble/hashes (audited, zero-dependency, pure JS) —
 * Cloudflare Workers Web Crypto has no SHA-3, and this library runs identically
 * on Workers and Node.
 *
 * Tor v3 address (RFC 7686 + Tor rend-spec-v3):
 *   payload  = pubkey(32B) || checksum(2B) || version(1B = 0x03)
 *   checksum = SHA3-256(".onion checksum" || pubkey || version)[0:2]
 *   address  = base32(payload) → 56 chars, alphabet a-z2-7, lowercase
 *
 * The v3 address IS a self-authenticating identity: it is derived from the
 * hidden service's ed25519 key, so a valid address proves control of the
 * service's private key — level C (identity) of the tor-onion track.
 */

import { sha3_256 as nobleSha3_256 } from "@noble/hashes/sha3.js";

const ONION_VERSION = 0x03;
const CHECKSUM_PREFIX = ".onion checksum";
const ONION_RE = /^[a-z2-7]{56}$/;

/** SHA3-256 wrapper — Uint8Array in, Uint8Array(32) out. */
export function sha3_256(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  return nobleSha3_256(bytes);
}

/* ── base32 (RFC 4648, lowercase, no padding) ──────────────────────────── */

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** bytes → lowercase base32 string (no padding). */
export function base32(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** lowercase base32 string → bytes (RFC 4648, no padding). */
export function base32Decode(str) {
  const s = String(str).toLowerCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const v = B32.indexOf(s[i]);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/* ── v3 onion address ──────────────────────────────────────────────────── */

/**
 * Build a v3 onion address from a 32-byte ed25519 public key (test helper +
 * anyone hosting a Tor service can derive their own address).
 * @param {Uint8Array} pubkey 32 bytes
 * @returns {string} 56-char lowercase v3 address (WITHOUT ".onion")
 */
export function makeV3Onion(pubkey) {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) {
    throw new Error("makeV3Onion: pubkey must be 32 bytes");
  }
  const preimage = new Uint8Array(CHECKSUM_PREFIX.length + 33);
  new TextEncoder().encodeInto(CHECKSUM_PREFIX, preimage);
  preimage.set(pubkey, CHECKSUM_PREFIX.length);
  preimage[CHECKSUM_PREFIX.length + 32] = ONION_VERSION;
  const digest = sha3_256(preimage);
  const payload = new Uint8Array(35);
  payload.set(pubkey, 0);
  payload[32] = digest[0];
  payload[33] = digest[1];
  payload[34] = ONION_VERSION;
  return base32(payload);
}

/**
 * Validate a Tor v3 onion address (format + length + alphabet + checksum).
 * @param {string} address — 56-char address, with or without ".onion" suffix
 * @returns {boolean}
 */
export function validateV3Onion(address) {
  if (typeof address !== "string" || !address) return false;
  let a = address.trim().toLowerCase();
  if (a.endsWith(".onion")) a = a.slice(0, -6);
  if (!ONION_RE.test(a)) return false;
  const payload = base32Decode(a);
  if (!payload || payload.length !== 35) return false;
  if (payload[34] !== ONION_VERSION) return false;
  const pubkey = payload.slice(0, 32);
  const preimage = new Uint8Array(CHECKSUM_PREFIX.length + 33);
  new TextEncoder().encodeInto(CHECKSUM_PREFIX, preimage);
  preimage.set(pubkey, CHECKSUM_PREFIX.length);
  preimage[CHECKSUM_PREFIX.length + 32] = ONION_VERSION;
  const digest = sha3_256(preimage);
  return payload[32] === digest[0] && payload[33] === digest[1];
}

/** Normalize: strip ".onion" suffix → 56-char address (or null). */
export function normalizeV3Onion(address) {
  if (!validateV3Onion(address)) return null;
  let a = String(address).trim().toLowerCase();
  if (a.endsWith(".onion")) a = a.slice(0, -6);
  return a;
}