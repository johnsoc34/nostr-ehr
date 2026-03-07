/**
 * lib/crypto.js
 * Server-side Nostr crypto: secp256k1 ECDH + NIP-44 v2 decrypt
 * Ported directly from the EHR's nostr.ts and nip44.ts
 */

// ─── secp256k1 constants ────────────────────────────────────────────────────
const P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a, m) { return ((a % m) + m) % m; }
function modpow(base, exp, m) {
  let r = 1n; base = mod(base, m);
  while (exp > 0n) { if (exp & 1n) r = r * base % m; base = base * base % m; exp >>= 1n; }
  return r;
}

class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  isZero() { return this.x === 0n && this.y === 0n; }
  add(other) {
    if (this.isZero()) return other;
    if (other.isZero()) return this;
    if (this.x === other.x) {
      if (this.y !== other.y) return new Point(0n, 0n);
      const m = mod(3n * this.x * this.x * modpow(2n * this.y, P - 2n, P), P);
      const x = mod(m * m - 2n * this.x, P);
      return new Point(x, mod(m * (this.x - x) - this.y, P));
    }
    const m = mod((other.y - this.y) * modpow(other.x - this.x, P - 2n, P), P);
    const x = mod(m * m - this.x - other.x, P);
    return new Point(x, mod(m * (this.x - x) - this.y, P));
  }
  mul(k) {
    let r = new Point(0n, 0n), q = new Point(this.x, this.y);
    k = mod(k, N);
    while (k > 0n) { if (k & 1n) r = r.add(q); q = q.add(q); k >>= 1n; }
    return r;
  }
  hasEvenY() { return this.y % 2n === 0n; }
}

const G = new Point(Gx, Gy);

function liftX(x) {
  const y2 = mod(modpow(x, 3n, P) + 7n, P);
  const y = modpow(y2, (P + 1n) / 4n, P);
  if (modpow(y, 2n, P) !== y2) return null;
  return new Point(x, y % 2n === 0n ? y : P - y);
}

function toBytes(n, len = 32) {
  const a = new Uint8Array(len);
  for (let i = len - 1; i >= 0 && n > 0n; i--) { a[i] = Number(n & 0xffn); n >>= 8n; }
  return a;
}

function fromBytes(b) {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

function fromHex(h) {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  return bytes;
}

function toHex(b) {
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

// ─── ECDH shared secret (x-only, for NIP-44) ───────────────────────────────
function getSharedSecret(sk, otherPkHex) {
  const skBig = fromBytes(sk instanceof Uint8Array ? sk : fromHex(sk));
  const otherPk = liftX(fromBytes(fromHex(otherPkHex)));
  if (!otherPk) throw new Error("Invalid public key");
  const shared = otherPk.mul(skBig);
  return toBytes(shared.x);
}

// ─── HMAC-SHA256 (for HKDF only) ───────────────────────────────────────────
const nodeCrypto = require("crypto");

function hmacSha256(key, data) {
  const hmac = nodeCrypto.createHmac("sha256", Buffer.from(key));
  hmac.update(Buffer.from(data));
  return new Uint8Array(hmac.digest());
}

// ─── HKDF-SHA256 ───────────────────────────────────────────────────────────
function hkdf(ikm, salt, info, len) {
  const prk = hmacSha256(salt, ikm);
  const n = Math.ceil(len / 32);
  const okm = new Uint8Array(n * 32);
  let prev = new Uint8Array(0);
  for (let i = 0; i < n; i++) {
    const input = new Uint8Array(prev.length + info.length + 1);
    input.set(prev); input.set(info, prev.length); input[input.length - 1] = i + 1;
    prev = hmacSha256(prk, input);
    okm.set(prev, i * 32);
  }
  return okm.slice(0, len);
}

// ─── ChaCha20 (ported directly from nip44.ts) ──────────────────────────────
function chacha20Block(key, counter, nonce) {
  function rotl(a, b) { return (a << b) | (a >>> (32 - b)); }
  function qr(s, a, b, c, d) {
    s[a] = (s[a] + s[b]) | 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) | 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) | 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) | 0; s[b] = rotl(s[b] ^ s[c], 7);
  }
  const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const s = new Uint32Array([
    0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
    kv.getUint32(0, true), kv.getUint32(4, true), kv.getUint32(8, true), kv.getUint32(12, true),
    kv.getUint32(16, true), kv.getUint32(20, true), kv.getUint32(24, true), kv.getUint32(28, true),
    counter,
    nv.getUint32(0, true), nv.getUint32(4, true), nv.getUint32(8, true),
  ]);
  const w = new Uint32Array(s);
  for (let i = 0; i < 10; i++) {
    qr(w, 0, 4, 8, 12); qr(w, 1, 5, 9, 13); qr(w, 2, 6, 10, 14); qr(w, 3, 7, 11, 15);
    qr(w, 0, 5, 10, 15); qr(w, 1, 6, 11, 12); qr(w, 2, 7, 8, 13); qr(w, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) ov.setUint32(i * 4, (w[i] + s[i]) | 0, true);
  return out;
}

function chacha20(key, nonce, data, initialCounter = 0) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 64) {
    const block = chacha20Block(key, initialCounter + Math.floor(i / 64), nonce);
    for (let j = 0; j < Math.min(64, data.length - i); j++) out[i + j] = data[i + j] ^ block[j];
  }
  return out;
}

// ─── Poly1305 (ported directly from nip44.ts) ──────────────────────────────
function poly1305Mac(key, msg) {
  const POLY_P = (1n << 130n) - 5n;
  function load16le(b, o) {
    let v = 0n;
    for (let i = 0; i < 16 && o + i < b.length; i++) v |= BigInt(b[o + i]) << BigInt(8 * i);
    return v;
  }
  let r = load16le(key, 0) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = load16le(key, 16);
  let acc = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.slice(i, i + 16);
    let n = load16le(chunk, 0);
    n |= 1n << BigInt(8 * chunk.length);
    acc = (acc + n) * r % POLY_P;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { tag[i] = Number(acc & 0xffn); acc >>= 8n; }
  return tag;
}

// ─── ChaCha20-Poly1305 decrypt ──────────────────────────────────────────────
function chachaDecrypt(key, nonce, cipherWithMac) {
  const cipher = cipherWithMac.slice(0, -16);
  const mac = cipherWithMac.slice(-16);
  const polyKey = chacha20(key, nonce, new Uint8Array(64), 0).slice(0, 32);
  const expected = poly1305Mac(polyKey, cipher);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= mac[i] ^ expected[i];
  if (diff !== 0) return null;
  return chacha20(key, nonce, cipher, 1);
}

// ─── NIP-44 v2 conversationKey + messageKeys ────────────────────────────────
function conversationKey(sharedX) {
  const salt = new Uint8Array(Buffer.from("nip44-v2", "utf8"));
  return hkdf(sharedX, salt, new Uint8Array(0), 76);
}

function messageKeys(convKey, nonce) {
  const info = new Uint8Array(Buffer.from("nip44-v2", "utf8"));
  const keys = hkdf(convKey, nonce, info, 76);
  return {
    chachaKey: keys.slice(0, 32),
    chacha20Nonce: keys.slice(32, 44),
  };
}

// ─── Unpad (NIP-44 spec) ────────────────────────────────────────────────────
function unpad(padded) {
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const len = dv.getUint16(0, false); // big-endian
  return Buffer.from(padded.slice(2, 2 + len)).toString("utf8");
}

// ─── NIP-44 v2 Decrypt ─────────────────────────────────────────────────────
async function nip44Decrypt(payload, sharedX) {
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  if (bytes[0] !== 2) throw new Error(`Unsupported NIP-44 version: ${bytes[0]}`);

  const nonce = bytes.slice(1, 33);
  const cipher = bytes.slice(33);

  const convKey = conversationKey(sharedX);
  const { chachaKey, chacha20Nonce } = messageKeys(convKey, nonce);

  const plain = chachaDecrypt(chachaKey, chacha20Nonce, cipher);
  if (!plain) throw new Error("Decryption failed — MAC mismatch");

  return unpad(plain);
}

// ─── Get public key from secret key ─────────────────────────────────────────
function getPublicKey(sk) {
  const skBytes = sk instanceof Uint8Array ? sk : fromHex(sk);
  const skBig = fromBytes(skBytes);
  const pub = G.mul(skBig);
  return toHex(toBytes(pub.x));
}

module.exports = {
  getSharedSecret,
  nip44Decrypt,
  getPublicKey,
  fromHex,
  toHex,
};
