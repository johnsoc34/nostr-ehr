/**
 * src/lib/nostr.ts
 * Phase 5: Added getSharedSecret() for NIP-44 ECDH encryption
 */

const P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

class Point {
  constructor(public x: bigint, public y: bigint) {}
  static ZERO = new Point(0n, 0n);
  static G    = new Point(Gx, Gy);
  isZero() { return this.x === 0n && this.y === 0n; }
  add(other: Point): Point {
    if (this.isZero()) return other;
    if (other.isZero()) return this;
    if (this.x === other.x) {
      if (this.y !== other.y) return Point.ZERO;
      const m = mod(3n*this.x*this.x*modpow(2n*this.y,P-2n,P),P);
      const x = mod(m*m-2n*this.x,P);
      return new Point(x,mod(m*(this.x-x)-this.y,P));
    }
    const m = mod((other.y-this.y)*modpow(other.x-this.x,P-2n,P),P);
    const x = mod(m*m-this.x-other.x,P);
    return new Point(x,mod(m*(this.x-x)-this.y,P));
  }
  mul(k: bigint): Point {
    let r=Point.ZERO, q=new Point(this.x,this.y);
    k=mod(k,N);
    while(k>0n){if(k&1n)r=r.add(q);q=q.add(q);k>>=1n;}
    return r;
  }
  hasEvenY() { return this.y%2n===0n; }
}

function mod(a: bigint,m: bigint){return((a%m)+m)%m;}
function modpow(base: bigint,exp: bigint,m: bigint){
  let r=1n;base=mod(base,m);
  while(exp>0n){if(exp&1n)r=r*base%m;base=base*base%m;exp>>=1n;}
  return r;
}
function liftX(x: bigint):Point|null{
  const y2=mod(modpow(x,3n,P)+7n,P);
  const y=modpow(y2,(P+1n)/4n,P);
  if(modpow(y,2n,P)!==y2)return null;
  return new Point(x,y%2n===0n?y:P-y);
}
async function sha256(b: Uint8Array):Promise<Uint8Array>{
  return new Uint8Array(await crypto.subtle.digest("SHA-256",b.buffer as ArrayBuffer));
}
export function toBytes(n: bigint,len=32):Uint8Array{
  const a=new Uint8Array(len);
  for(let i=len-1;i>=0;i--){a[i]=Number(n&0xffn);n>>=8n;}
  return a;
}
export function fromBytes(b: Uint8Array):bigint{
  return b.reduce((a,v)=>(a<<8n)|BigInt(v),0n);
}
export function toHex(b: Uint8Array):string{
  return Array.from(b).map(v=>v.toString(16).padStart(2,"0")).join("");
}
export function fromHex(h: string):Uint8Array{
  return Uint8Array.from(h.match(/.{2}/g)!.map(b=>parseInt(b,16)));
}
async function taggedHash(tag: string,...msgs: Uint8Array[]):Promise<Uint8Array>{
  const enc=new TextEncoder();
  const th=await sha256(enc.encode(tag));
  const all=new Uint8Array(th.length*2+msgs.reduce((s,m)=>s+m.length,0));
  let off=0;all.set(th,off);off+=th.length;all.set(th,off);off+=th.length;
  for(const m of msgs){all.set(m,off);off+=m.length;}
  return sha256(all);
}
async function schnorrSign(msg: Uint8Array,sk: Uint8Array):Promise<Uint8Array>{
  const d0=fromBytes(sk);
  const Pt=Point.G.mul(d0);
  const d=Pt.hasEvenY()?d0:N-d0;
  const rand=new Uint8Array(32);crypto.getRandomValues(rand);
  const a=await taggedHash("BIP0340/aux",rand);
  const t=toBytes(d^fromBytes(a));
  const k0=fromBytes(await taggedHash("BIP0340/nonce",t,toBytes(Pt.x),msg))%N;
  const R=Point.G.mul(k0);
  const k=R.hasEvenY()?k0:N-k0;
  const e=fromBytes(await taggedHash("BIP0340/challenge",toBytes(R.x),toBytes(Pt.x),msg))%N;
  const sig=new Uint8Array(64);
  sig.set(toBytes(R.x),0);sig.set(toBytes(mod(k+e*d,N)),32);
  return sig;
}
async function schnorrVerify(msg: Uint8Array,sig: Uint8Array,pk: Uint8Array):Promise<boolean>{
  try{
    const r=fromBytes(sig.slice(0,32)),s=fromBytes(sig.slice(32)),px=fromBytes(pk);
    if(r>=P||s>=N||px>=P)return false;
    const P2=liftX(px);if(!P2)return false;
    const e=fromBytes(await taggedHash("BIP0340/challenge",toBytes(r),pk,msg))%N;
    const R=Point.G.mul(s).add(P2.mul(N-e));
    if(R.isZero()||!R.hasEvenY()||R.x!==r)return false;
    return true;
  }catch{return false;}
}

export function generateSecretKey():Uint8Array{
  const sk=new Uint8Array(32);
  do{crypto.getRandomValues(sk);}while(fromBytes(sk)===0n||fromBytes(sk)>=N);
  return sk;
}
export function getPublicKey(sk: Uint8Array):Uint8Array{
  return toBytes(Point.G.mul(fromBytes(sk)).x);
}

/**
 * NEW in Phase 5: ECDH shared secret for NIP-44 encryption.
 * For solo practice: encrypt to self (sk + own pubkey = consistent shared secret).
 * For patient sharing: encrypt to patient pubkey.
 * Returns the x-coordinate of the shared EC point (32 bytes).
 */
export function getSharedSecret(sk: Uint8Array, theirPubkeyHex: string): Uint8Array {
  const theirX  = fromHex(theirPubkeyHex);
  const theirPt = liftX(fromBytes(theirX));
  if (!theirPt) throw new Error("Invalid public key for ECDH");
  const shared  = theirPt.mul(fromBytes(sk));
  return toBytes(shared.x); // x-coordinate only (32 bytes)
}

export const FHIR_KINDS = {
  Patient:            2110,  // demographics (was 1000)
  Encounter:          2111,  // visit notes, addendums, nurse notes (was 1001)
  MedicationRequest:  2112,  // meds + Rx (was 1002)
  Observation:        2113,  // vitals (was 1003)
  Condition:          2114,  // problem list (was 1004)
  AllergyIntolerance: 2115,  // allergies (was 1005)
  Immunization:       2116,  // immunizations (was 1006)
  Message:            2117,  // bidirectional messaging (was 1007)
  ServiceRequest:     2118,  // lab + imaging orders (was 1008)
  DiagnosticReport:   2119,  // results, links via ["e", orderId, "", "result"] (was 1009)
  RxOrder:            2120,  // reserved (was 1010)
  DocumentReference:  2121,  // encrypted file attachments, NIP-B7 Blossom (was 1011)
} as const;

export interface NostrEvent {
  id:         string;
  pubkey:     string;
  created_at: number;
  kind:       number;
  tags:       string[][];
  content:    string;
  sig:        string;
  verified?:  boolean;
}

export async function buildAndSignEvent(
  kind:      number,
  content:   string,   // Phase 5: pass already-encrypted string
  tags:      string[][],
  sk:        Uint8Array,
): Promise<NostrEvent> {
  const pkBytes    = getPublicKey(sk);
  const pubkey     = toHex(pkBytes);
  const created_at = Math.floor(Date.now()/1000);
  const serial     = JSON.stringify([0,pubkey,created_at,kind,tags,content]);
  const idBytes    = await sha256(new TextEncoder().encode(serial));
  const id         = toHex(idBytes);
  const sigBytes   = await schnorrSign(idBytes,sk);
  const sig        = toHex(sigBytes);
  const verified   = await schnorrVerify(idBytes,sigBytes,pkBytes);
  return {id,pubkey,created_at,kind,tags,content,sig,verified};
}

const BECH32="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Encode(hrp: string,data: Uint8Array):string{
  function pm(v: number[]){let c=1;for(const d of v){const c0=c>>>25;c=((c&0x1ffffff)<<5)^d;if(c0&1)c^=0x3b6a57b2;if(c0&2)c^=0x26508e6d;if(c0&4)c^=0x1ea119fa;if(c0&8)c^=0x3d4233dd;if(c0&16)c^=0x2a1462b3;}return c;}
  function he(h: string){const r:number[]=[];for(const c of h)r.push(c.charCodeAt(0)>>5);r.push(0);for(const c of h)r.push(c.charCodeAt(0)&31);return r;}
  function cb(d: number[],f: number,t: number){let a=0,b=0;const r:number[]=[];for(const v of d){a=(a<<f)|v;b+=f;while(b>=t){b-=t;r.push((a>>b)&((1<<t)-1));}}if(b>0)r.push((a<<(t-b))&((1<<t)-1));return r;}
  const d5=cb(Array.from(data),8,5);
  const ck=pm([...he(hrp),...d5,0,0,0,0,0,0])^1;
  return hrp+"1"+[...d5,...[0,1,2,3,4,5].map(i=>(ck>>(5*(5-i)))&31)].map(i=>BECH32[i]).join("");
}
export function npubEncode(b: Uint8Array):string{return bech32Encode("npub",b);}
export function nsecEncode(b: Uint8Array):string{return bech32Encode("nsec",b);}
export function nsecToBytes(nsec: string): Uint8Array {
  if (!nsec.startsWith('nsec1')) throw new Error('Invalid nsec');
  const data = nsec.slice(5);
  let buffer = 0, bits = 0;
  const result: number[] = [];
  for (const char of data.slice(0, -6)) {
    const value = BECH32.indexOf(char);
    if (value === -1) throw new Error('Invalid bech32 character');
    buffer = (buffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(result);
}

export function npubToHex(npub: string): string {
  if (!npub.startsWith('npub1')) throw new Error('Invalid npub');
  const data = npub.slice(5);
  let buffer = 0, bits = 0;
  const result: number[] = [];
  for (const char of data.slice(0, -6)) {
    const value = BECH32.indexOf(char);
    if (value === -1) throw new Error('Invalid bech32 character');
    buffer = (buffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((buffer >> bits) & 0xff);
    }
  }
  return result.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Verify a Nostr event's signature. Recomputes the event ID from the
 *  serialized fields and checks the Schnorr signature against the pubkey.
 *  Returns { valid, computedId, idMatch } */
export async function verifyEvent(event: {
  id: string; pubkey: string; created_at: number;
  kind: number; tags: string[][]; content: string; sig: string;
}): Promise<{ valid: boolean; computedId: string; idMatch: boolean }> {
  const serial = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const idBytes = await sha256(new TextEncoder().encode(serial));
  const computedId = toHex(idBytes);
  const idMatch = computedId === event.id;
  if (!idMatch) return { valid: false, computedId, idMatch };
  try {
    const sigBytes = fromHex(event.sig);
    const pkBytes = fromHex(event.pubkey);
    const valid = await schnorrVerify(idBytes, sigBytes, pkBytes);
    return { valid, computedId, idMatch };
  } catch {
    return { valid: false, computedId, idMatch };
  }
}

// ─── Multi-User / Staff Access (Phase 18) ─────────────────────────────────────

/** Event kinds for staff management — separate from clinical FHIR kinds */
export const STAFF_KINDS = {
  PatientKeyGrant:   2100,   // per-staff per-patient shared secret — practice-signed (was 1012)
  PracticeKeyGrant:  2101,   // per-staff practice shared secret (X₁) — practice-signed (was 1013)
  StaffRoster:       2102,   // regular event — latest by created_at wins (was 1014)
} as const;

/** Staff roles with increasing privilege levels */
export type StaffRole = "frontdesk" | "ma" | "nurse" | "doctor";

/** Permission tokens controlling UI and action access */
export type StaffPermission =
  | "read"           // view patient charts and clinical data
  | "write"          // create encounters, document in charts
  | "vitals"         // record observations (kind 2113)
  | "messages"       // send/receive secure messages (kind 2117)
  | "immunizations"  // record immunizations (kind 2116)
  | "allergies"      // record allergies (kind 2115)
  | "order"          // create ServiceRequests for labs/imaging (kind 2118)
  | "prescribe"      // create MedicationRequests (kind 2112)
  | "sign"           // sign/finalize encounters (kind 2111)
  | "admin"          // manage staff roster, key grants
  | "settings"       // access EHR settings panel
  | "schedule";      // view/manage calendar

/** Default permissions for each role */
export const ROLE_PERMISSIONS: Record<StaffRole, StaffPermission[]> = {
  doctor:    ["read", "write", "vitals", "messages", "immunizations", "allergies",
              "order", "prescribe", "sign", "admin", "settings", "schedule"],
  nurse:     ["read", "write", "vitals", "messages", "immunizations", "allergies", "schedule"],
  ma:        ["read", "write", "vitals", "messages", "immunizations", "schedule"],
  frontdesk: ["messages", "schedule"],
};

/** A staff member in the roster */
export interface StaffMember {
  pkHex: string;           // staff member's public key (hex)
  name: string;            // display name
  role: StaffRole;         // role determines default permissions
  permissions: StaffPermission[];  // actual granted permissions (may differ from defaults)
  addedAt: number;         // unix timestamp when authorized
  revokedAt?: number;      // unix timestamp if soft-revoked (still in roster for history)
}

/** Encrypted content of a kind 2102 StaffRoster event */
export interface StaffRosterPayload {
  staff: StaffMember[];
}

/** Encrypted content of a kind 2101 PracticeKeyGrant event */
export interface PracticeKeyGrantPayload {
  practiceSharedSecret: string;  // hex-encoded X₁ = getSharedSecret(practiceSk, practicePkHex)
  practicePkHex: string;         // practice public key for reference
}

/** Encrypted content of a kind 2100 PatientKeyGrant event */
export interface PatientKeyGrantPayload {
  patientId: string;             // patient UUID
  patientPkHex: string;          // patient public key (hex)
  patientSharedSecret: string;   // hex-encoded X₂ = getSharedSecret(practiceSk, patientPkHex)
}

/** Session state for a logged-in staff member (held in React state, never persisted) */
export interface StaffSession {
  staffSk: Uint8Array;                          // staff's own secret key (for signing events)
  staffPkHex: string;                           // staff's public key
  staffName: string;                            // display name from roster
  role: StaffRole;                              // role from roster
  permissions: StaffPermission[];               // granted permissions
  practiceSharedSecret: Uint8Array;             // X₁ — decrypts all practice-copy content
  patientSecrets: Map<string, Uint8Array>;      // patientId → X₂ (patient-copy shared secrets)
  practicePkHex: string;                        // practice pubkey (for tags, portal compatibility)
}

/** Check if a staff session has a specific permission */
export function hasPermission(session: StaffSession, perm: StaffPermission): boolean {
  return session.permissions.includes(perm);
}

/** Get the list of authorized pubkeys (practice + all active staff) from a roster */
export function getAuthorizedPubkeys(practicePkHex: string, roster: StaffMember[]): string[] {
  const active = roster.filter(s => !s.revokedAt).map(s => s.pkHex);
  return [practicePkHex, ...active];
}

/** Validate that a roster event is signed by the practice key */
export function isValidRosterEvent(event: NostrEvent, practicePkHex: string): boolean {
  return event.kind === STAFF_KINDS.StaffRoster && event.pubkey === practicePkHex;
}

/** Validate that a key grant event is signed by the practice key */
export function isValidGrantEvent(event: NostrEvent, practicePkHex: string): boolean {
  return (event.kind === STAFF_KINDS.PracticeKeyGrant || event.kind === STAFF_KINDS.PatientKeyGrant)
    && event.pubkey === practicePkHex;
}
