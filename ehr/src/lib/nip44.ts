// @ts-nocheck
/**
 * src/lib/nip44.ts
 * NIP-44 v2 encryption for NostrEHR
 *
 * Encrypts FHIR event content so only the keyholder can read it.
 * Algorithm: secp256k1 ECDH → HKDF-SHA256 → ChaCha20-Poly1305
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/44.md
 */

const VERSION = 2;

// ─── HMAC-SHA256 via Web Crypto ───────────────────────────────────────────────
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// ─── HKDF-SHA256 ─────────────────────────────────────────────────────────────
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const n   = Math.ceil(len / 32);
  const okm = new Uint8Array(n * 32);
  let prev  = new Uint8Array(0);
  for (let i = 0; i < n; i++) {
    const input = new Uint8Array(prev.length + info.length + 1);
    input.set(prev); input.set(info, prev.length); input[input.length - 1] = i + 1;
    prev = await hmacSha256(prk, input);
    okm.set(prev, i * 32);
  }
  return okm.slice(0, len);
}

// ─── ChaCha20 ─────────────────────────────────────────────────────────────────
function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  function rotl(a: number, b: number) { return (a << b) | (a >>> (32 - b)); }
  function qr(s: Uint32Array, a: number, b: number, c: number, d: number) {
    s[a]=(s[a]+s[b])|0; s[d]=rotl(s[d]^s[a],16);
    s[c]=(s[c]+s[d])|0; s[b]=rotl(s[b]^s[c],12);
    s[a]=(s[a]+s[b])|0; s[d]=rotl(s[d]^s[a], 8);
    s[c]=(s[c]+s[d])|0; s[b]=rotl(s[b]^s[c], 7);
  }
  const kv = new DataView(key.buffer,   key.byteOffset);
  const nv = new DataView(nonce.buffer, nonce.byteOffset);
  const s  = new Uint32Array([
    0x61707865,0x3320646e,0x79622d32,0x6b206574,
    kv.getUint32(0,true),kv.getUint32(4,true),kv.getUint32(8,true),kv.getUint32(12,true),
    kv.getUint32(16,true),kv.getUint32(20,true),kv.getUint32(24,true),kv.getUint32(28,true),
    counter,
    nv.getUint32(0,true),nv.getUint32(4,true),nv.getUint32(8,true),
  ]);
  const w = new Uint32Array(s);
  for (let i=0;i<10;i++){
    qr(w,0,4,8,12);qr(w,1,5,9,13);qr(w,2,6,10,14);qr(w,3,7,11,15);
    qr(w,0,5,10,15);qr(w,1,6,11,12);qr(w,2,7,8,13);qr(w,3,4,9,14);
  }
  const out = new Uint8Array(64);
  const ov  = new DataView(out.buffer);
  for (let i=0;i<16;i++) ov.setUint32(i*4,(w[i]+s[i])|0,true);
  return out;
}

function chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, initialCounter=0): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i=0;i<data.length;i+=64){
    const block = chacha20Block(key, initialCounter + Math.floor(i/64), nonce);
    for (let j=0;j<Math.min(64,data.length-i);j++) out[i+j]=data[i+j]^block[j];
  }
  return out;
}

// ─── Poly1305 ─────────────────────────────────────────────────────────────────
function poly1305Mac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const P = (1n<<130n)-5n;
  function load16le(b: Uint8Array, o: number): bigint {
    let v=0n; for(let i=0;i<16&&o+i<b.length;i++) v|=BigInt(b[o+i])<<BigInt(8*i); return v;
  }
  let r = load16le(key,0) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = load16le(key,16);
  let acc = 0n;
  for (let i=0;i<msg.length;i+=16){
    const chunk=msg.slice(i,i+16);
    let n=load16le(chunk,0);
    n |= 1n<<BigInt(8*chunk.length);
    acc=(acc+n)*r%P;
  }
  acc=(acc+s)&((1n<<128n)-1n);
  const tag=new Uint8Array(16);
  for(let i=0;i<16;i++){tag[i]=Number(acc&0xffn);acc>>=8n;}
  return tag;
}

// ─── ChaCha20-Poly1305 ────────────────────────────────────────────────────────
function encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const polyKey  = chacha20(key, nonce, new Uint8Array(64), 0).slice(0,32);
  const cipher   = chacha20(key, nonce, plaintext, 1);
  const mac      = poly1305Mac(polyKey, cipher);
  const out      = new Uint8Array(cipher.length+16);
  out.set(cipher); out.set(mac, cipher.length);
  return out;
}

function decrypt(key: Uint8Array, nonce: Uint8Array, cipherWithMac: Uint8Array): Uint8Array|null {
  const cipher   = cipherWithMac.slice(0,-16);
  const mac      = cipherWithMac.slice(-16);
  const polyKey  = chacha20(key, nonce, new Uint8Array(64), 0).slice(0,32);
  const expected = poly1305Mac(polyKey, cipher);
  let diff=0; for(let i=0;i<16;i++) diff|=mac[i]^expected[i];
  if(diff!==0) return null;
  return chacha20(key, nonce, cipher, 1);
}

// ─── Padding (NIP-44 spec) ────────────────────────────────────────────────────
function pad(text: string): Uint8Array {
  const enc  = new TextEncoder();
  const utf8 = enc.encode(text);
  const len  = utf8.length;
  const padLen = len<=32?32:Math.pow(2,Math.ceil(Math.log2(len)));
  const out  = new Uint8Array(2+padLen);
  new DataView(out.buffer).setUint16(0,len,false);
  out.set(utf8,2);
  return out;
}

function unpad(padded: Uint8Array): string {
  const len = new DataView(padded.buffer).getUint16(0,false);
  return new TextDecoder().decode(padded.slice(2,2+len));
}

// ─── Conversation key ─────────────────────────────────────────────────────────
async function conversationKey(sharedX: Uint8Array): Promise<Uint8Array> {
  const salt = new TextEncoder().encode("nip44-v2");
  return hkdf(sharedX, salt, new Uint8Array(0), 76);
}

async function messageKeys(convKey: Uint8Array, nonce: Uint8Array) {
  const info = new TextEncoder().encode("nip44-v2");
  const keys = await hkdf(convKey, nonce, info, 76);
  return { chachaKey: keys.slice(0,32), chacha20Nonce: keys.slice(32,44) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using NIP-44 v2.
 * sharedX = ECDH shared point x-coordinate (32 bytes)
 * Returns base64-encoded payload ready for Nostr event content.
 */
export async function nip44Encrypt(plaintext: string, sharedX: Uint8Array): Promise<string> {
  const convKey = await conversationKey(sharedX);
  const nonce   = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const { chachaKey, chacha20Nonce } = await messageKeys(convKey, nonce);
  const cipher  = encrypt(chachaKey, chacha20Nonce, pad(plaintext));
  const payload = new Uint8Array(1+32+cipher.length);
  payload[0]=VERSION; payload.set(nonce,1); payload.set(cipher,33);
  return btoa(String.fromCharCode(...payload));
}

/**
 * Decrypt a NIP-44 v2 payload.
 * Returns the original plaintext string, or throws on failure.
 */
export async function nip44Decrypt(payload: string, sharedX: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(atob(payload), c=>c.charCodeAt(0));
  if (bytes[0]!==VERSION) throw new Error(`Unsupported NIP-44 version: ${bytes[0]}`);
  const nonce  = bytes.slice(1,33);
  const cipher = bytes.slice(33);
  const convKey = await conversationKey(sharedX);
  const { chachaKey, chacha20Nonce } = await messageKeys(convKey, nonce);
  const plain  = decrypt(chachaKey, chacha20Nonce, cipher);
  if (!plain) throw new Error("Decryption failed — MAC mismatch. Data may be corrupted or tampered.");
  return unpad(plain);
}
