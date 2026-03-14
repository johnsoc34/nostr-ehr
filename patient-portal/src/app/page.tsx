"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  nsecToBytes, getPublicKey, getSharedSecret, toHex, fromHex,
  npubToHex, npubEncode, FHIR_KINDS, STAFF_KINDS, type NostrEvent, buildAndSignEvent
} from "../lib/nostr";
import { nip44Decrypt, nip44Encrypt } from "../lib/nip44";
import VideoRoom from "../lib/VideoRoom";

// ─── PIN Crypto Storage ───────────────────────────────────────────────────────
// Stores encrypted nsec in IndexedDB. PIN → PBKDF2 → AES-GCM key → encrypt sk.
// Replaces plaintext portal_patient_sk in localStorage entirely.

const PIN_DB_NAME = "immutable_portal_auth";
const PIN_DB_VERSION = 1;
const PIN_STORE = "credentials";

function openPinDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(PIN_DB_NAME, PIN_DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(PIN_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

interface StoredCredential {
  id: string;           // `${pkHex}_${practiceId}`
  encryptedSk: string;  // hex of AES-GCM ciphertext
  iv: string;           // hex of IV
  salt: string;         // hex of PBKDF2 salt
  pkHex: string;
  npub?: string;
  name?: string;
  practiceId: string;
  createdAt: number;
  hasPin: boolean;
  // WebAuthn PRF passkey/YubiKey fields
  webauthnCredentialId?: string;  // base64url of credential rawId
  webauthnPrfSalt?: string;       // hex of PRF salt (stored, not secret)
  hasPrf?: boolean;               // true if PRF registration succeeded
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: 200000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptSk(sk: Uint8Array, pin: string): Promise<{ encryptedSk: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, sk.buffer as ArrayBuffer);
  return {
    encryptedSk: toHex(new Uint8Array(encrypted)),
    iv: toHex(iv),
    salt: toHex(salt),
  };
}

async function decryptSk(encryptedSk: string, iv: string, salt: string, pin: string): Promise<Uint8Array> {
  const key = await deriveKey(pin, fromHex(salt));
  const ivBytes = fromHex(iv);
  const cipherBytes = fromHex(encryptedSk);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.buffer as ArrayBuffer },
    key,
    cipherBytes.buffer as ArrayBuffer
  );
  return new Uint8Array(decrypted);
}

async function saveCredential(cred: StoredCredential): Promise<void> {
  const db = await openPinDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(PIN_STORE, "readwrite");
    tx.objectStore(PIN_STORE).put(cred);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function loadCredential(id: string): Promise<StoredCredential | null> {
  const db = await openPinDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(PIN_STORE, "readonly");
    const req = tx.objectStore(PIN_STORE).get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}

async function listCredentials(): Promise<StoredCredential[]> {
  const db = await openPinDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(PIN_STORE, "readonly");
    const req = tx.objectStore(PIN_STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

function credentialId(pkHex: string, practiceId: string) {
  return `${pkHex}_${practiceId}`;
}

// ─── WebAuthn PRF Helpers ───────────────────────────────────────────────────
// Passkey/YubiKey authentication via WebAuthn PRF extension.
// PRF gives us a deterministic 32-byte secret from the authenticator,
// which we use as an AES-GCM key to encrypt/decrypt the stored nsec.
// Same pattern as PIN — just a different key derivation source.

function toBase64Url(buf: Uint8Array): string {
  let s = ""; for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

async function prfKeyFromBytes(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", prfOutput, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
  );
}

async function encryptSkWithPrf(sk: Uint8Array, prfOutput: ArrayBuffer): Promise<{ encryptedSk: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await prfKeyFromBytes(prfOutput);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, sk.buffer as ArrayBuffer
  );
  return { encryptedSk: toHex(new Uint8Array(encrypted)), iv: toHex(iv) };
}

async function decryptSkWithPrf(encryptedSk: string, iv: string, prfOutput: ArrayBuffer): Promise<Uint8Array> {
  const key = await prfKeyFromBytes(prfOutput);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(iv).buffer as ArrayBuffer }, key, fromHex(encryptedSk).buffer as ArrayBuffer
  );
  return new Uint8Array(decrypted);
}

/** Check if WebAuthn PRF extension is likely supported */
function isPrfLikelySupported(): boolean {
  return !!window.PublicKeyCredential && typeof navigator.credentials?.create === "function";
}

/** Register a passkey with PRF. Returns the credential + PRF result, or null if PRF unsupported. */
async function registerPasskey(
  pkHex: string, npub: string, displayName: string
): Promise<{ credentialId: string; prfSalt: string; prfOutput: ArrayBuffer } | null> {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: process.env.NEXT_PUBLIC_DEFAULT_PRACTICE_NAME || "Patient Portal", id: window.location.hostname },
      user: {
        id: fromHex(pkHex).buffer as ArrayBuffer,
        name: npub || pkHex.slice(0, 16),
        displayName: displayName || "Patient",
      },
      pubKeyCredParams: [
        { type: "public-key" as const, alg: -7 },   // ES256
        { type: "public-key" as const, alg: -257 },  // RS256
      ],
      authenticatorSelection: { userVerification: "required" },
      extensions: { prf: { eval: { first: prfSalt.buffer as ArrayBuffer } } } as any,
    },
  }) as PublicKeyCredential | null;

  if (!credential) return null;

  const extResults = (credential as any).getClientExtensionResults?.();
  const prfResult = extResults?.prf?.results?.first;
  if (!prfResult) return null; // PRF not supported by this authenticator

  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    prfSalt: toHex(prfSalt),
    prfOutput: prfResult,
  };
}

/** Authenticate with a stored passkey + PRF. Returns the decrypted sk or null. */
async function authenticatePasskey(
  cred: StoredCredential
): Promise<{ sk: Uint8Array; prfOutput: ArrayBuffer } | null> {
  if (!cred.hasPrf || !cred.webauthnCredentialId || !cred.webauthnPrfSalt) return null;

  const prfSalt = fromHex(cred.webauthnPrfSalt);
  const credIdBytes = fromBase64Url(cred.webauthnCredentialId);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: window.location.hostname,
      userVerification: "required",
      allowCredentials: [{ type: "public-key" as const, id: credIdBytes.buffer as ArrayBuffer }],
      extensions: { prf: { eval: { first: prfSalt.buffer as ArrayBuffer } } } as any,
    },
  }) as PublicKeyCredential | null;

  if (!assertion) return null;

  const extResults = (assertion as any).getClientExtensionResults?.();
  const prfResult = extResults?.prf?.results?.first;
  if (!prfResult) return null;

  const sk = await decryptSkWithPrf(cred.encryptedSk, cred.iv, prfResult);
  return { sk, prfOutput: prfResult };
}

// ─── Practice Connection ─────────────────────────────────────────────────────
interface PracticeConnection {
  id: string;           // unique ID (generated)
  name: string;         // practice display name
  relay: string;        // wss:// relay URL
  practicePk: string;   // hex pubkey of the practice
  billingApi?: string;  // optional billing API base URL
  calendarApi?: string; // optional calendar API base URL
  addedAt: number;      // timestamp
}

const DEFAULT_CONNECTION: PracticeConnection = {
  id: "default",
  name: process.env.NEXT_PUBLIC_DEFAULT_PRACTICE_NAME || "My Practice",
  relay: process.env.NEXT_PUBLIC_DEFAULT_RELAY || "wss://relay.example.com",
  practicePk: process.env.NEXT_PUBLIC_DEFAULT_PRACTICE_PK || "",
  billingApi: process.env.NEXT_PUBLIC_DEFAULT_BILLING_API || "",
  calendarApi: process.env.NEXT_PUBLIC_DEFAULT_CALENDAR_API || "",
  addedAt: 0,
};

function loadConnections(): PracticeConnection[] {
  try {
    const raw = localStorage.getItem("portal_connections");
    if (raw) {
      const parsed = JSON.parse(raw) as PracticeConnection[];
      if (parsed.length > 0) return parsed;
    }
  } catch {}
  return [DEFAULT_CONNECTION];
}

function saveConnections(conns: PracticeConnection[]) {
  localStorage.setItem("portal_connections", JSON.stringify(conns));
}

function parseConnectionString(input: string): Partial<PracticeConnection> | null {
  const s = input.trim();
  // Try JSON first
  try {
    const obj = JSON.parse(s);
    if (obj.relay && obj.practice_pk) {
      return {
        name: obj.practice_name || obj.name || "Unknown Practice",
        relay: obj.relay.startsWith("wss://") ? obj.relay : `wss://${obj.relay}`,
        practicePk: obj.practice_pk || obj.practicePk,
        billingApi: obj.billing_api || obj.billingApi,
        calendarApi: obj.calendar_api || obj.calendarApi,
      };
    }
  } catch {}
  // Try nostr+ehr:// URI
  if (s.startsWith("nostr+ehr://")) {
    try {
      const url = new URL(s.replace("nostr+ehr://", "https://"));
      const pk = url.searchParams.get("pk");
      if (pk) {
        return {
          name: url.searchParams.get("name") || url.hostname,
          relay: `wss://${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname !== "/" ? url.pathname : ""}`,
          practicePk: pk,
          billingApi: url.searchParams.get("billing") || undefined,
          calendarApi: url.searchParams.get("calendar") || undefined,
        };
      }
    } catch {}
  }
  return null;
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface PatientKeys {
  sk: Uint8Array;        // empty Uint8Array if nip07 mode
  pkHex: string;
  name?: string;
  npub?: string;
  nip07?: boolean;       // true = window.nostr holds the key
  overrideSharedSecret?: Uint8Array;  // pre-computed X₂ for guardian viewing child's records
}

interface GuardianChild {
  childPatientId: string;
  childPkHex: string;
  childSharedSecret: Uint8Array;  // X₂ — pre-computed, from decrypted guardian grant
  childName: string;
}

// ─── Portal Crypto Abstraction ────────────────────────────────────────────────
// All decrypt/encrypt goes through here — routes to NIP-07 or local nip44.
// Components never call nip44Decrypt/getSharedSecret directly.

async function portalDecrypt(
  ciphertext: string,
  keys: PatientKeys,
  otherPkHex: string
): Promise<string> {
  if (keys.nip07) {
    // @ts-ignore
    const w = window.nostr;
    if (!w?.nip44?.decrypt) throw new Error("NIP-07 extension does not support NIP-44");
    return await w.nip44.decrypt(otherPkHex, ciphertext);
  }
  // Guardian viewing child: use pre-computed X₂ from grant instead of ECDH
  const sharedX = keys.overrideSharedSecret || getSharedSecret(keys.sk, otherPkHex);
  return nip44Decrypt(ciphertext, sharedX);
}

async function portalEncrypt(
  plaintext: string,
  keys: PatientKeys,
  otherPkHex: string
): Promise<string> {
  if (keys.nip07) {
    // @ts-ignore
    const w = window.nostr;
    if (!w?.nip44?.encrypt) throw new Error("NIP-07 extension does not support NIP-44");
    return await w.nip44.encrypt(otherPkHex, plaintext);
  }
  const sharedX = getSharedSecret(keys.sk, otherPkHex);
  return nip44Encrypt(plaintext, sharedX);
}
type Tab = "records" | "vitals" | "meds" | "immunizations" | "messages" | "appointments" | "mydata";

// ─── Design System ────────────────────────────────────────────────────────────
const DARK = {
  bg: "#0a0d12", surface: "#111620", surfaceHi: "#1a2233", border: "#1e2d44",
  text: "#e8edf5", textMuted: "#6b7fa3", accent: "#f7931a", accentLt: "#fbb040",
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};
const LIGHT = {
  bg: "#f4f6fb", surface: "#ffffff", surfaceHi: "#eef2fa", border: "#d4dae8",
  text: "#0f172a", textMuted: "#64748b", accent: "#f7931a", accentLt: "#ea7c0a",
  blue: "#2563eb", green: "#16a34a", red: "#dc2626", amber: "#d97706",
};
type Theme = typeof DARK;

function card(T: Theme, extra?: React.CSSProperties): React.CSSProperties {
  return { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 24px", marginBottom: 14, ...extra };
}
function input(T: Theme): React.CSSProperties {
  return { width: "100%", background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px", color: T.text, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box", outline: "none" };
}
function lbl(T: Theme): React.CSSProperties {
  return { color: T.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, display: "block", fontWeight: 600 };
}

// ─── Btn ──────────────────────────────────────────────────────────────────────
function Btn({ children, onClick, col, solid = false, disabled = false, small = false, T = DARK, fullWidth = false }: {
  children: React.ReactNode; onClick?: () => void; col?: string; solid?: boolean;
  disabled?: boolean; small?: boolean; T?: Theme; fullWidth?: boolean;
}) {
  const c = col || T.accent;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: solid ? c : T.surfaceHi,
      border: `1px solid ${solid ? c : T.border}`,
      color: solid ? "#fff" : T.text,
      borderRadius: 8,
      padding: small ? "6px 12px" : "9px 18px",
      fontSize: small ? 12 : 13,
      fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      fontFamily: "inherit",
      transition: "all 0.15s",
      boxShadow: solid ? `0 2px 12px ${c}30` : "none",
      width: fullWidth ? "100%" : "auto",
    }}>{children}</button>
  );
}

// ─── useRelay (now accepts dynamic URL) ──────────────────────────────────────
function useRelay(relayUrl: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef<Record<string, (ok: boolean) => void>>({});
  const subs = useRef<Record<string, (ev: NostrEvent) => void>>({});
  const eoseCbs = useRef<Record<string, () => void>>({});
  const [status, setStatus] = useState("disconnected");
  const retryDelay = useRef(2000);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);
  const urlRef = useRef(relayUrl);

  const connect = useCallback(() => {
    if (unmounted.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setStatus("connecting");
    const ws = new WebSocket(urlRef.current); wsRef.current = ws;
    ws.onopen = () => {
      setStatus("connected");
      retryDelay.current = 2000;
    };
    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      setStatus("disconnected");
      if (unmounted.current) return;
      retryTimer.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, 30000);
        connect();
      }, retryDelay.current);
    };
    ws.onmessage = (e) => {
      try {
        const [type, ...rest] = JSON.parse(e.data);
        if (type === "OK") {
          const [id, ok] = rest as [string, boolean];
          pending.current[id]?.(ok); delete pending.current[id];
        } else if (type === "EVENT") {
          const [subId, ev] = rest as [string, NostrEvent];
          subs.current[subId]?.(ev);
        } else if (type === "EOSE") {
          const [subId] = rest as [string];
          eoseCbs.current[subId]?.();
        }
      } catch {}
    };
  }, []);

  // Reconnect when relay URL changes
  useEffect(() => {
    if (urlRef.current !== relayUrl) {
      urlRef.current = relayUrl;
      // Close existing connection and reconnect
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      retryDelay.current = 2000;
      connect();
    }
  }, [relayUrl, connect]);

  useEffect(() => {
    unmounted.current = false;
    connect();
    return () => {
      unmounted.current = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const publish = useCallback((event: NostrEvent): Promise<boolean> => {
    return new Promise(resolve => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) { resolve(false); return; }
      pending.current[event.id] = resolve;
      wsRef.current.send(JSON.stringify(["EVENT", event]));
      setTimeout(() => { if (pending.current[event.id]) { delete pending.current[event.id]; resolve(false); } }, 6000);
    });
  }, []);

  const subscribe = useCallback((
    filters: object,
    onEvent: (ev: NostrEvent) => void,
    onEose?: () => void
  ): string => {
    const subId = "sub-" + Date.now();
    subs.current[subId] = onEvent;
    if (onEose) eoseCbs.current[subId] = onEose;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(["REQ", subId, filters]));
    }
    return subId;
  }, []);

  const unsubscribe = useCallback((subId: string) => {
    delete subs.current[subId];
    delete eoseCbs.current[subId];
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(["CLOSE", subId]));
    }
  }, []);

  return { status, connect, publish, subscribe, unsubscribe };
}

// ─── No Patient-Content Warning ──────────────────────────────────────────────
function NoPatientAccessCard({ T, practiceName }: { T: Theme; practiceName: string }) {
  return (
    <div style={{ ...card(T, { textAlign: "center", padding: 40 }), borderLeft: `3px solid ${T.amber}` }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔐</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 8 }}>
        Patient Access Not Enabled
      </div>
      <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.7, maxWidth: 400, margin: "0 auto" }}>
        {practiceName} has not enabled patient-accessible records.
        Contact your provider to request access to your health data through the patient portal.
      </div>
    </div>
  );
}

// ─── Practice Picker ─────────────────────────────────────────────────────────
function PracticePicker({ connections, onSelect, onAdd, onRemove, dark, toggleTheme }: {
  connections: PracticeConnection[];
  onSelect: (conn: PracticeConnection) => void;
  onAdd: (conn: PracticeConnection) => void;
  onRemove: (id: string) => void;
  dark: boolean;
  toggleTheme: () => void;
}) {
  const T = dark ? DARK : LIGHT;
  const [adding, setAdding] = useState(false);
  const [connStr, setConnStr] = useState("");
  const [parseError, setParseError] = useState("");
  const [parsed, setParsed] = useState<Partial<PracticeConnection> | null>(null);
  const [editName, setEditName] = useState("");

  const handleParse = (val: string) => {
    setConnStr(val);
    setParseError("");
    if (!val.trim()) { setParsed(null); return; }
    const result = parseConnectionString(val);
    if (result) {
      setParsed(result);
      setEditName(result.name || "");
    } else {
      setParsed(null);
      if (val.trim().length > 10) setParseError("Could not parse connection string. Expected JSON or nostr+ehr:// URI.");
    }
  };

  const handleAdd = () => {
    if (!parsed?.relay || !parsed?.practicePk) return;
    const conn: PracticeConnection = {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: editName || parsed.name || "Unknown Practice",
      relay: parsed.relay,
      practicePk: parsed.practicePk,
      billingApi: parsed.billingApi,
      calendarApi: parsed.calendarApi,
      addedAt: Date.now(),
    };
    onAdd(conn);
    setAdding(false);
    setConnStr("");
    setParsed(null);
    setEditName("");
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'DM Sans','IBM Plex Sans',system-ui,sans-serif", transition: "background 0.3s" }}>
      {/* Theme toggle */}
      <div style={{ position: "fixed", top: 16, right: 16 }}>
        <button onClick={toggleTheme} style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", cursor: "pointer", color: T.textMuted, fontSize: 15, lineHeight: 1 }}>
          {dark ? "☀️" : "🌙"}
        </button>
      </div>

      {/* Background grid */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, backgroundImage: `linear-gradient(${T.border} 1px, transparent 1px), linear-gradient(90deg, ${T.border} 1px, transparent 1px)`, backgroundSize: "48px 48px", opacity: 0.3, maskImage: "radial-gradient(ellipse 80% 60% at 50% 40%, black 40%, transparent 100%)", pointerEvents: "none" }} />

      <div style={{ width: "100%", maxWidth: 480, position: "relative", zIndex: 1 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ width: 52, height: 52, borderRadius: 12, background: `linear-gradient(135deg, ${T.accent}, ${T.accentLt})`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", fontSize: 22, fontWeight: 800, color: "#fff", boxShadow: `0 4px 20px ${T.accent}40`, fontFamily: "inherit" }}>
            Ⅰ
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: 4 }}>{process.env.NEXT_PUBLIC_DEFAULT_PRACTICE_NAME || "Patient Portal"}</div>
          <div style={{ fontSize: 13, color: T.textMuted }}>Patient Portal</div>
        </div>

        {/* Practice list */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "24px 28px", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>Select Your Practice</div>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 20 }}>Choose a provider to access your health records</div>

          {connections.map(conn => (
            <div key={conn.id}
              onClick={() => onSelect(conn)}
              style={{
                display: "flex", alignItems: "center", gap: 14,
                padding: "14px 16px", marginBottom: 8,
                background: T.surfaceHi, border: `1px solid ${T.border}`,
                borderRadius: 10, cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = T.accent; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = T.border; }}
            >
              {/* Practice icon */}
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: `${T.accent}15`, border: `1px solid ${T.accent}30`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, fontWeight: 800, color: T.accent, flexShrink: 0,
              }}>
                {conn.name[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 2 }}>{conn.name}</div>
                <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {conn.relay.replace("wss://", "")}
                </div>
              </div>
              <div style={{ color: T.textMuted, fontSize: 16, flexShrink: 0 }}>→</div>
              {/* Remove button (not for default) */}
              {conn.id !== "default" && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(conn.id); }}
                  style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: 0.5 }}
                  title="Remove practice"
                >✕</button>
              )}
            </div>
          ))}
        </div>

        {/* Add practice */}
        {!adding ? (
          <button onClick={() => setAdding(true)} style={{
            width: "100%", padding: "14px",
            background: T.surface, border: `1px dashed ${T.border}`,
            borderRadius: 12, cursor: "pointer",
            color: T.textMuted, fontSize: 13, fontWeight: 600,
            fontFamily: "inherit", transition: "all 0.15s",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
            Add Another Practice
          </button>
        ) : (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "24px 28px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>Add Practice</div>
              <button onClick={() => { setAdding(false); setConnStr(""); setParsed(null); setParseError(""); }}
                style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 18 }}>✕</button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={lbl(T)}>Connection String</label>
              <textarea
                value={connStr}
                onChange={e => handleParse(e.target.value)}
                placeholder={'Paste JSON or nostr+ehr:// URI from your provider\n\nExample:\n{"relay":"wss://relay.example.com","practice_pk":"abc...","practice_name":"My Practice"}'}
                rows={5}
                style={{ ...input(T), resize: "vertical", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}
              />
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                Your provider will give you a connection string — ask them for it
              </div>
            </div>

            {parseError && (
              <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: "10px 14px", color: T.red, fontSize: 12, marginBottom: 14 }}>
                {parseError}
              </div>
            )}

            {parsed && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ background: `${T.green}10`, border: `1px solid ${T.green}30`, borderRadius: 8, padding: "12px 14px", marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: T.green, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Connection Found</div>
                  <div style={{ fontSize: 12, color: T.text, marginBottom: 4 }}>
                    <strong>Relay:</strong> <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>{parsed.relay}</span>
                  </div>
                  <div style={{ fontSize: 12, color: T.text, marginBottom: 4 }}>
                    <strong>Practice Key:</strong> <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>{parsed.practicePk?.slice(0, 16)}...{parsed.practicePk?.slice(-8)}</span>
                  </div>
                  {parsed.billingApi && <div style={{ fontSize: 11, color: T.textMuted }}>Billing: {parsed.billingApi}</div>}
                  {parsed.calendarApi && <div style={{ fontSize: 11, color: T.textMuted }}>Calendar: {parsed.calendarApi}</div>}
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={lbl(T)}>Practice Name</label>
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="e.g. My Pediatrician"
                    style={input(T)}
                  />
                </div>
                <Btn solid T={T} onClick={handleAdd} fullWidth disabled={!parsed.relay || !parsed.practicePk}>
                  Add Practice →
                </Btn>
              </div>
            )}
          </div>
        )}

        {/* Privacy note */}
        <div style={{ marginTop: 20, padding: "14px 16px", background: `${T.accent}10`, border: `1px solid ${T.accent}25`, borderRadius: 8, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: T.accent }}>🔑 Your Key, Your Data</div>
          One access code works across all your providers. Your records are end-to-end encrypted — each practice encrypts your data to your personal key.
        </div>
      </div>
    </div>
  );
}

// ─── PIN Setup Modal (shown after first nsec login) ───────────────────────────
function PinSetupModal({ T, onSetPin, onSkip }: {
  T: Theme;
  onSetPin: (pin: string) => Promise<void>;
  onSkip: () => void;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSet = async () => {
    if (pin.length < 4) { setError("PIN must be at least 4 digits."); return; }
    if (pin !== confirm) { setError("PINs don't match."); return; }
    setSaving(true);
    try {
      await onSetPin(pin);
    } catch {
      setError("Failed to save PIN. You can set one later in settings.");
      setSaving(false);
    }
  };

  const pinInput = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <input
      type="password"
      inputMode="numeric"
      pattern="[0-9]*"
      value={value}
      onChange={e => { onChange(e.target.value.replace(/\D/g, "").slice(0, 8)); setError(""); }}
      onKeyDown={e => { if (e.key === "Enter") handleSet(); }}
      placeholder={placeholder}
      style={{ ...input(T), letterSpacing: "0.3em", fontSize: 20, textAlign: "center" as const, fontFamily: "'IBM Plex Mono', monospace" }}
    />
  );

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center",
      justifyContent: "center", background: "rgba(0,0,0,0.7)", padding: 24,
    }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: "32px 36px", width: "100%", maxWidth: 380 }}>
        <div style={{ fontSize: 32, textAlign: "center" as const, marginBottom: 12 }}>🔐</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, textAlign: "center" as const, marginBottom: 8 }}>Set a PIN</div>
        <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center" as const, marginBottom: 24, lineHeight: 1.5 }}>
          Create a PIN so you don't have to enter your long access code next time. Your records stay encrypted — only your PIN unlocks them on this device.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ ...lbl(T), marginBottom: 6 }}>Choose a PIN (4–8 digits)</label>
          {pinInput(pin, setPin, "••••")}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ ...lbl(T), marginBottom: 6 }}>Confirm PIN</label>
          {pinInput(confirm, setConfirm, "••••")}
        </div>

        {error && (
          <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: "8px 12px", color: T.red, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <Btn solid T={T} onClick={handleSet} disabled={!pin || !confirm || saving} fullWidth>
          {saving ? "Saving..." : "Set PIN & Continue →"}
        </Btn>
        <button onClick={onSkip} style={{
          width: "100%", marginTop: 10, background: "none", border: "none",
          color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: 6,
        }}>
          Skip for now
        </button>
        <div style={{ marginTop: 16, fontSize: 11, color: T.textMuted, textAlign: "center" as const, lineHeight: 1.5 }}>
          PIN is stored only on this device. If you clear your browser data, you'll need your original access code again.
        </div>
      </div>
    </div>
  );
}

// ─── Passkey Setup Modal (shown after nsec login if PRF is supported) ────────
function PasskeySetupModal({ T, onRegister, onSkipToPin, onSkipAll }: {
  T: Theme;
  onRegister: () => Promise<boolean>;
  onSkipToPin: () => void;
  onSkipAll: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "registering" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleRegister = async () => {
    setStatus("registering");
    setErrorMsg("");
    try {
      const ok = await onRegister();
      if (ok) {
        setStatus("success");
        // Auto-dismiss after brief success display
        setTimeout(onSkipAll, 800);
      } else {
        setStatus("error");
        setErrorMsg("Your browser or device doesn't support this feature. You can use a PIN instead.");
      }
    } catch (e: any) {
      setStatus("error");
      const msg = e?.message || "";
      if (msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("not allowed")) {
        setErrorMsg("Registration was cancelled. You can try again or use a PIN instead.");
      } else {
        setErrorMsg("Passkey registration failed. You can use a PIN instead.");
      }
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center",
      justifyContent: "center", background: "rgba(0,0,0,0.7)", padding: 24,
    }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: "32px 36px", width: "100%", maxWidth: 380 }}>
        {status === "success" ? (
          <>
            <div style={{ fontSize: 40, textAlign: "center" as const, marginBottom: 12 }}>✓</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.green, textAlign: "center" as const }}>Passkey saved!</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 32, textAlign: "center" as const, marginBottom: 12 }}>🔑</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text, textAlign: "center" as const, marginBottom: 8 }}>
              Secure Quick Access
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center" as const, marginBottom: 24, lineHeight: 1.5 }}>
              Use Face ID, fingerprint, Windows Hello, or a security key (YubiKey) to quickly unlock your records on this device — no access code needed.
            </div>

            {errorMsg && (
              <div style={{ background: `${T.amber}12`, border: `1px solid ${T.amber}40`, borderRadius: 8, padding: "10px 14px", color: T.amber, fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
                {errorMsg}
              </div>
            )}

            <Btn solid T={T} onClick={handleRegister} disabled={status === "registering"} fullWidth>
              {status === "registering" ? "Waiting for device..." : "Set up Passkey →"}
            </Btn>

            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0" }}>
              <div style={{ flex: 1, height: 1, background: T.border }} />
              <span style={{ fontSize: 11, color: T.textMuted }}>or</span>
              <div style={{ flex: 1, height: 1, background: T.border }} />
            </div>

            <button onClick={onSkipToPin} style={{
              width: "100%", padding: "9px 16px", borderRadius: 10,
              border: `1px solid ${T.border}`, background: T.surfaceHi,
              color: T.text, fontSize: 13, fontWeight: 600, fontFamily: "inherit",
              cursor: "pointer", marginBottom: 8,
            }}>
              Use a PIN instead
            </button>

            <button onClick={onSkipAll} style={{
              width: "100%", marginTop: 4, background: "none", border: "none",
              color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: 6,
            }}>
              Skip for now
            </button>

            <div style={{ marginTop: 16, fontSize: 11, color: T.textMuted, textAlign: "center" as const, lineHeight: 1.5 }}>
              Your records stay encrypted on this device. The passkey only works on this browser.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Unified Login Screen ────────────────────────────────────────────────────
// Single screen that shows all available auth methods based on stored credentials.
// Priority: passkey auto-trigger → passkey button + NIP-07 button + PIN field → nsec fallback.
// No more bouncing between separate screens.

function UnifiedLoginScreen({ connection, onLogin, onBack, dark, toggleTheme, storedCredential }: {
  connection: PracticeConnection;
  onLogin: (keys: PatientKeys) => void;
  onBack: () => void;
  dark: boolean;
  toggleTheme: () => void;
  storedCredential: StoredCredential | null; // credential from IndexedDB (may have hasPin, hasPrf, or both)
}) {
  const T = dark ? DARK : LIGHT;

  // --- State ---
  const [error, setError] = useState("");
  const [nsec, setNsec] = useState("");
  const [nsecLoading, setNsecLoading] = useState(false);
  const [pin, setPin] = useState("");
  const [pinLoading, setPinLoading] = useState(false);
  const [pinAttempts, setPinAttempts] = useState(0);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyAutoTriggered, setPasskeyAutoTriggered] = useState(false);
  const [nip07Available, setNip07Available] = useState(false);
  const [nip07Loading, setNip07Loading] = useState(false);
  const [nip07Cancelled, setNip07Cancelled] = useState(false);
  const [showNsec, setShowNsec] = useState(false); // access code section collapsed by default when other methods exist

  const pinRef = useRef<HTMLInputElement>(null);

  // Derived: what methods are available?
  const hasPin = !!storedCredential?.hasPin;
  const hasPrf = !!storedCredential?.hasPrf;
  const hasQuickAuth = hasPin || hasPrf; // if any saved credential, collapse nsec by default
  const patientName = storedCredential?.name || null;
  const firstName = patientName && patientName !== "Patient"
    ? (() => { const n = patientName.trim(); if (n.includes(",")) return n.split(",")[1].trim().split(" ")[0]; return n.split(" ")[0]; })()
    : null;

  // --- NIP-07 detection ---
  useEffect(() => {
    const check = () => {
      // @ts-ignore
      if (window.nostr) { setNip07Available(true); return true; }
      return false;
    };
    if (!check()) {
      const t = setTimeout(check, 500);
      return () => clearTimeout(t);
    }
  }, []);

  // --- Auto-trigger passkey on mount ---
  useEffect(() => {
    if (hasPrf && storedCredential && !passkeyAutoTriggered) {
      setPasskeyAutoTriggered(true);
      handlePasskeyAuth();
    }
  }, [hasPrf, storedCredential]);

  // --- Focus PIN input if it's the primary method ---
  useEffect(() => {
    if (hasPin && !hasPrf && pinRef.current) {
      pinRef.current.focus();
    }
  }, [hasPin, hasPrf]);

  // --- Helper: fetch patient name from billing ---
  const fetchPatientName = async (npub: string): Promise<string> => {
    let name = storedCredential?.name || localStorage.getItem(`portal_name_${connection.id}_${npub}`) || "Patient";
    if (connection.billingApi && npub) {
      try {
        const nr = await fetch(`${connection.billingApi}/api/patients/${encodeURIComponent(npub)}`);
        if (nr.ok) {
          const d = await nr.json();
          if (d?.name) { name = d.name; localStorage.setItem(`portal_name_${connection.id}_${npub}`, d.name); }
        }
      } catch {}
    }
    return name;
  };

  // --- Passkey auth ---
  const handlePasskeyAuth = async () => {
    if (!storedCredential?.hasPrf) return;
    setError(""); setPasskeyLoading(true);
    try {
      const result = await authenticatePasskey(storedCredential);
      if (!result) { setError("Passkey authentication failed. Try another method below."); return; }
      const pk = getPublicKey(result.sk);
      if (toHex(pk) !== storedCredential.pkHex) { setError("Key verification failed."); return; }
      const npub = storedCredential.npub || "";
      const name = await fetchPatientName(npub);
      onLogin({ sk: result.sk, pkHex: toHex(pk), name, npub });
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("not allowed")) {
        setError("Passkey cancelled. Try again or use another method below.");
      } else {
        setError("Passkey failed. Try another method below.");
      }
    } finally {
      setPasskeyLoading(false);
    }
  };

  // --- PIN unlock ---
  const handlePinUnlock = async () => {
    if (!pin || !storedCredential?.hasPin) return;
    setError(""); setPinLoading(true);
    try {
      const sk = await decryptSk(storedCredential.encryptedSk, storedCredential.iv, storedCredential.salt, pin);
      const pk = getPublicKey(sk);
      if (toHex(pk) !== storedCredential.pkHex) throw new Error("Wrong PIN");
      const npub = storedCredential.npub || "";
      const name = await fetchPatientName(npub);
      onLogin({ sk, pkHex: toHex(pk), name, npub });
    } catch {
      const next = pinAttempts + 1;
      setPinAttempts(next);
      setError(`Incorrect PIN.${next >= 3 ? " Try your access code instead." : ""}`);
      setPin("");
    } finally {
      setPinLoading(false);
    }
  };

  // --- NIP-07 login ---
  const handleNip07Login = async () => {
    setError(""); setNip07Loading(true);
    try {
      // @ts-ignore
      const w = window.nostr;
      if (!w) throw new Error("No NIP-07 extension found.");
      if (!w.nip44?.decrypt) throw new Error("Your Nostr extension does not support NIP-44. Please update Alby or use a compatible extension.");
      const pkHex = await w.getPublicKey();
      if (!pkHex) throw new Error("Extension did not return a public key.");

      // Derive npub from pkHex
      const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
      const pkBytes = fromHex(pkHex);
      const converted: number[] = []; let acc = 0, bits = 0;
      for (const v of pkBytes) { acc = (acc << 8) | v; bits += 8; while (bits >= 5) { bits -= 5; converted.push((acc >> bits) & 31); } }
      if (bits > 0) converted.push((acc << (5 - bits)) & 31);
      const prefix = "npub";
      const payload = [...prefix.split("").map(c => c.charCodeAt(0) >> 5), 0, ...prefix.split("").map(c => 31 & c.charCodeAt(0)), ...converted, 0, 0, 0, 0, 0, 0];
      let chk = 1;
      for (const v of payload) { const top = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; if (top & 1) chk ^= 0x3b6a57b2; if (top & 2) chk ^= 0x26508e6d; if (top & 4) chk ^= 0x1ea119fa; if (top & 8) chk ^= 0x3d4233dd; if (top & 16) chk ^= 0x2a1462b3; }
      const checksum = 1 ^ chk;
      const checks = [...Array(6)].map((_, i) => (checksum >> (5 * (5 - i))) & 31);
      const npub = prefix + "1" + [...converted, ...checks].map(v => CHARSET[v]).join("");
      localStorage.setItem("portal_patient_npub", npub);

      const name = await fetchPatientName(npub);
      onLogin({ sk: new Uint8Array(0), pkHex, name, npub, nip07: true });
    } catch (e: any) {
      const msg: string = e.message || "";
      if (msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("user rejected")) {
        setNip07Cancelled(true);
        setError("");
      } else {
        setError(msg || "NIP-07 login failed.");
      }
    } finally {
      setNip07Loading(false);
    }
  };

  // --- nsec login ---
  const handleNsecLogin = async () => {
    setError(""); setNsecLoading(true);
    try {
      const sk = nsecToBytes(nsec.trim());
      const pk = getPublicKey(sk);
      const npub = (()=>{
        const CHARSET="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        const data=Array.from(pk);
        const converted:number[]=[];let acc=0,bits=0;
        for(const v of data){acc=(acc<<8)|v;bits+=8;while(bits>=5){bits-=5;converted.push((acc>>bits)&31);}}
        if(bits>0)converted.push((acc<<(5-bits))&31);
        const prefix="npub";
        const payload=[...prefix.split("").map(c=>c.charCodeAt(0)>>5),0,...prefix.split("").map(c=>31&c.charCodeAt(0)),...converted,0,0,0,0,0,0];
        let chk=1;
        for(const v of payload){const top=chk>>25;chk=((chk&0x1ffffff)<<5)^v;if(top&1)chk^=0x3b6a57b2;if(top&2)chk^=0x26508e6d;if(top&4)chk^=0x1ea119fa;if(top&8)chk^=0x3d4233dd;if(top&16)chk^=0x2a1462b3;}
        const checksum=1^chk;
        const checks=[...Array(6)].map((_,i)=>(checksum>>(5*(5-i)))&31);
        return prefix+"1"+[...converted,...checks].map(v=>CHARSET[v]).join("");
      })();

      const name = await fetchPatientName(npub);
      onLogin({ sk, pkHex: toHex(pk), name, npub });
    } catch {
      setError("Invalid access code. Please check and try again.");
    } finally {
      setNsecLoading(false);
    }
  };

  // --- Divider helper ---
  const divider = (text: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
      <div style={{ flex: 1, height: 1, background: T.border }} />
      <span style={{ fontSize: 11, color: T.textMuted }}>{text}</span>
      <div style={{ flex: 1, height: 1, background: T.border }} />
    </div>
  );

  // --- Quick auth button style helper ---
  const quickBtn = (color: string) => ({
    width: "100%", padding: "11px 16px", borderRadius: 10,
    border: `1px solid ${color}50`, background: `${color}12`,
    color: T.text, fontSize: 14, fontWeight: 600 as const, fontFamily: "inherit",
    display: "flex" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 10,
    transition: "all 0.15s", cursor: "pointer",
  });

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'DM Sans','IBM Plex Sans',system-ui,sans-serif", transition: "background 0.3s" }}>
      {/* Theme toggle */}
      <div style={{ position: "fixed", top: 16, right: 16 }}>
        <button onClick={toggleTheme} style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", cursor: "pointer", color: T.textMuted, fontSize: 15, lineHeight: 1 }}>
          {dark ? "☀️" : "🌙"}
        </button>
      </div>

      {/* Background grid */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, backgroundImage: `linear-gradient(${T.border} 1px, transparent 1px), linear-gradient(90deg, ${T.border} 1px, transparent 1px)`, backgroundSize: "48px 48px", opacity: 0.3, maskImage: "radial-gradient(ellipse 80% 60% at 50% 40%, black 40%, transparent 100%)", pointerEvents: "none" }} />

      <div style={{ width: "100%", maxWidth: 420, position: "relative", zIndex: 1 }}>
        {/* Back to practice list */}
        <button onClick={onBack} style={{
          background: "none", border: "none", color: T.textMuted, cursor: "pointer",
          fontSize: 13, fontFamily: "inherit", marginBottom: 20, padding: 0,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          ← Back to practices
        </button>

        {/* Practice badge + welcome */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: `${T.accent}15`, border: `1px solid ${T.accent}30`,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 12px", fontSize: 20, fontWeight: 800, color: T.accent,
          }}>
            {connection.name[0].toUpperCase()}
          </div>
          {hasQuickAuth && firstName ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: 4 }}>Welcome back, {firstName}</div>
              <div style={{ fontSize: 12, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>{connection.name}</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: 4 }}>{connection.name}</div>
              <div style={{ fontSize: 12, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>
                {connection.relay.replace("wss://", "")}
              </div>
            </>
          )}
        </div>

        {/* Login card */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "28px 32px" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: T.text, letterSpacing: "-0.01em", marginBottom: 6 }}>Sign In</div>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 24 }}>
            {hasQuickAuth ? "Choose a method to access your records" : `Enter your access code to view your records at ${connection.name}`}
          </div>

          {/* Global error */}
          {error && (
            <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: "10px 14px", color: T.red, fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}

          {/* ── Section 1: Quick auth buttons (passkey, NIP-07) ── */}

          {/* Passkey button */}
          {hasPrf && (
            <div style={{ marginBottom: 10 }}>
              <button onClick={handlePasskeyAuth} disabled={passkeyLoading} style={{
                ...quickBtn(T.blue),
                cursor: passkeyLoading ? "wait" : "pointer",
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = `${T.blue}22`; (e.currentTarget as HTMLElement).style.borderColor = `${T.blue}80`; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = `${T.blue}12`; (e.currentTarget as HTMLElement).style.borderColor = `${T.blue}50`; }}
              >
                <span style={{ fontSize: 16 }}>🔑</span>
                {passkeyLoading ? "Waiting for device..." : "Sign in with Passkey"}
              </button>
            </div>
          )}

          {/* NIP-07 button */}
          {nip07Available && (
            <div style={{ marginBottom: 10 }}>
              {nip07Cancelled ? (
                <div style={{ background: `${T.amber}12`, border: `1px solid ${T.amber}40`, borderRadius: 10, padding: "12px 16px", textAlign: "center" as const }}>
                  <div style={{ fontSize: 13, color: T.amber, fontWeight: 600, marginBottom: 6 }}>Extension request was cancelled</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
                    Your Nostr extension blocked further requests. Click below to reload and try again.
                  </div>
                  <button onClick={() => window.location.reload()} style={{
                    background: `${T.amber}20`, border: `1px solid ${T.amber}50`, borderRadius: 8,
                    padding: "7px 18px", color: T.amber, fontSize: 13, fontWeight: 600,
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                    ↺ Reload & Try Again
                  </button>
                </div>
              ) : (
                <button onClick={handleNip07Login} disabled={nip07Loading} style={{
                  ...quickBtn(T.accent),
                  cursor: nip07Loading ? "wait" : "pointer",
                }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = `${T.accent}22`; (e.currentTarget as HTMLElement).style.borderColor = `${T.accent}80`; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = `${T.accent}12`; (e.currentTarget as HTMLElement).style.borderColor = `${T.accent}50`; }}
                >
                  <span style={{ fontSize: 18 }}>⚡</span>
                  {nip07Loading ? "Connecting to extension..." : "Sign in with Nostr Extension"}
                </button>
              )}
            </div>
          )}

          {/* ── Section 2: Inline PIN (if stored) ── */}
          {hasPin && (
            <>
              {(hasPrf || nip07Available) && divider("or enter your PIN")}
              {!hasPrf && !nip07Available && (
                <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12 }}>Enter your PIN to unlock</div>
              )}
              <div style={{ marginBottom: 12 }}>
                <input
                  ref={pinRef}
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pin}
                  onChange={e => { setPin(e.target.value.replace(/\D/g, "").slice(0, 8)); if (error) setError(""); }}
                  onKeyDown={e => { if (e.key === "Enter") handlePinUnlock(); }}
                  placeholder="Enter PIN"
                  style={{ ...input(T), letterSpacing: "0.4em", fontSize: 24, textAlign: "center" as const, fontFamily: "'IBM Plex Mono', monospace" }}
                />
              </div>
              <Btn solid T={T} onClick={handlePinUnlock} disabled={!pin || pinLoading} fullWidth>
                {pinLoading ? "Unlocking..." : "Unlock →"}
              </Btn>
            </>
          )}

          {/* ── Section 3: Access code (nsec) — collapsible when other methods exist ── */}
          {hasQuickAuth && !showNsec && (
            <>
              {divider("or")}
              <button onClick={() => setShowNsec(true)} style={{
                width: "100%", background: "none", border: "none",
                color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: 6,
                textDecoration: "underline",
              }}>
                Use access code instead
              </button>
            </>
          )}

          {(!hasQuickAuth || showNsec) && (
            <>
              {hasQuickAuth && divider("access code")}
              <div style={{ marginBottom: 18 }}>
                <label style={lbl(T)}>Your Access Code</label>
                <textarea
                  value={nsec}
                  onChange={e => setNsec(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleNsecLogin(); } }}
                  placeholder="nsec1..."
                  rows={3}
                  style={{ ...input(T), resize: "none", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
                />
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                  Your access code starts with "nsec1" — given to you by your provider
                </div>
              </div>

              <Btn solid T={T} onClick={handleNsecLogin} disabled={!nsec.trim() || nsecLoading} fullWidth>
                {nsecLoading ? "Verifying..." : "Access My Records →"}
              </Btn>
            </>
          )}

          {/* Privacy notice */}
          <div style={{ marginTop: 20, padding: "14px 16px", background: `${T.accent}10`, border: `1px solid ${T.accent}25`, borderRadius: 8, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: T.accent }}>🔒 Your Privacy</div>
            Your records are end-to-end encrypted. Your access code never leaves your device and our servers never see your data in plain text.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helper Components ────────────────────────────────────────────────────────
function LoadingCard({ label, T }: { label: string; T: Theme }) {
  return (
    <div style={{ ...card(T), textAlign: "center", padding: 40 }}>
      <div style={{ width: 32, height: 32, border: `3px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", margin: "0 auto 14px", animation: "spin 0.8s linear infinite" }} />
      <div style={{ fontSize: 13, color: T.textMuted }}>{label}</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function EmptyCard({ label, T }: { label: string; T: Theme }) {
  return (
    <div style={{ ...card(T), textAlign: "center", padding: 36 }}>
      <div style={{ fontSize: 28, marginBottom: 10 }}>📭</div>
      <div style={{ fontSize: 13, color: T.textMuted }}>{label}</div>
    </div>
  );
}

function SectionHeader({ title, icon, count, label, T }: { title: string; icon: string; count?: number; label?: string; T: Theme }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>{icon} {title}</div>
      {count !== undefined && (
        <span style={{ background: `${T.accent}18`, color: T.accent, borderRadius: 99, padding: "3px 10px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {count} {label}
        </span>
      )}
    </div>
  );
}

// ─── Visit History ────────────────────────────────────────────────────────────
function VisitHistory({ keys, relay, practicePk, practiceName, T }: { keys: PatientKeys; relay: ReturnType<typeof useRelay>; practicePk: string; practiceName: string; T: Theme }) {
  const [encounters, setEncounters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [noAccess, setNoAccess] = useState(false);

  useEffect(() => {
    if (relay.status !== "connected") return;
    setLoading(true);
    setNoAccess(false);
    const found: NostrEvent[] = [];
    const subId = relay.subscribe(
      { kinds: [FHIR_KINDS.Encounter], "#p": [keys.pkHex], limit: 100 },
      (ev) => { if (!found.find(e => e.id === ev.id)) found.push(ev); }
    );
    setTimeout(async () => {
      relay.unsubscribe(subId);
      
      const decrypted: any[] = [];
      let hasPatientContent = false;
      for (const ev of found) {
        try {
          const patientContent = ev.tags.find(t => t[0] === "patient-content")?.[1];
          if (!patientContent) continue;
          hasPatientContent = true;
          const plain = await portalDecrypt(patientContent, keys, practicePk);
          const fhir = JSON.parse(plain);
          const note = fhir.note?.[0]?.text || "";
          const chief = fhir.reasonCode?.[0]?.text || "Visit";
          decrypted.push({ event: ev, fhir, note, chief });
        } catch {}
      }
      // If we found events but none had patient-content, this practice hasn't enabled patient access
      if (found.length > 0 && !hasPatientContent) {
        setNoAccess(true);
      }
      decrypted.sort((a, b) => b.event.created_at - a.event.created_at);
      setEncounters(decrypted);
      setLoading(false);
    }, 2000);
  }, [keys, relay.status, practicePk]);

  if (loading) return <LoadingCard label="Loading visit history..." T={T} />;
  if (noAccess) return <NoPatientAccessCard T={T} practiceName={practiceName} />;

  return (
    <div>
      <SectionHeader title="Visit History" icon="📋" T={T} />
      {encounters.length === 0 && <EmptyCard label="No visit records found" T={T} />}
      {encounters.map((enc) => (
        <div key={enc.event.id}
          style={{ ...card(T), borderLeft: `3px solid ${T.accent}`, cursor: "pointer", transition: "all 0.15s" }}
          onClick={() => setOpen(o => o === enc.event.id ? null : enc.event.id)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, color: T.text }}>{enc.chief}</div>
              <div style={{ color: T.textMuted, fontSize: 12 }}>
                {new Date(enc.event.created_at * 1000).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
              </div>
            </div>
            <span style={{ color: T.textMuted, fontSize: 14 }}>{open === enc.event.id ? "▲" : "▼"}</span>
          </div>
          {open === enc.event.id && enc.note && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
              <div style={{ background: T.surfaceHi, borderRadius: 8, padding: "12px 14px", fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", color: T.text }}>
                {enc.note}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Vitals ───────────────────────────────────────────────────────────────────
function VitalsView({ keys, relay, practicePk, T }: { keys: PatientKeys; relay: ReturnType<typeof useRelay>; practicePk: string; T: Theme }) {
  const [vitals, setVitals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (relay.status !== "connected") return;
    setLoading(true);
    const found: NostrEvent[] = [];
    const subId = relay.subscribe(
      { kinds: [FHIR_KINDS.Observation], "#p": [keys.pkHex], limit: 200 },
      (ev) => { if (!found.find(e => e.id === ev.id)) found.push(ev); }
    );
    setTimeout(async () => {
      relay.unsubscribe(subId);
      
      const decrypted: any[] = [];
      for (const ev of found) {
        try {
          const patientContent = ev.tags.find(t => t[0] === "patient-content")?.[1];
          if (!patientContent) continue;
          const plain = await portalDecrypt(patientContent, keys, practicePk);
          const fhir = JSON.parse(plain);
          decrypted.push({ event: ev, fhir });
        } catch {}
      }
      decrypted.sort((a, b) => b.event.created_at - a.event.created_at);
      setVitals(decrypted);
      setLoading(false);
    }, 2000);
  }, [keys, relay.status, practicePk]);

  if (loading) return <LoadingCard label="Loading vitals..." T={T} />;

  const weights = vitals.filter(v => v.fhir.code?.coding?.[0]?.code === "29463-7");
  const heights = vitals.filter(v => v.fhir.code?.coding?.[0]?.code === "8302-2");

  return (
    <div>
      <SectionHeader title="Growth Chart" icon="📈" T={T} />
      {vitals.length === 0 && <EmptyCard label="No measurements recorded yet" T={T} />}

      {weights.length > 0 && (
        <div style={card(T)}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14, color: T.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>⚖️ Weight History</div>
          {weights.map(v => (
            <div key={v.event.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ color: T.textMuted, fontSize: 13 }}>{new Date(v.fhir.effectiveDateTime).toLocaleDateString()}</span>
              <span style={{ fontWeight: 700, color: T.text, fontSize: 14, fontFamily: "'IBM Plex Mono', monospace" }}>
                {v.fhir.valueQuantity?.value} {v.fhir.valueQuantity?.unit}
                <span style={{ color: T.textMuted, fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                  ({(v.fhir.valueQuantity?.value * 2.20462).toFixed(1)} lb)
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {heights.length > 0 && (
        <div style={card(T)}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14, color: T.blue, textTransform: "uppercase", letterSpacing: "0.06em" }}>📏 Height History</div>
          {heights.map(v => (
            <div key={v.event.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ color: T.textMuted, fontSize: 13 }}>{new Date(v.fhir.effectiveDateTime).toLocaleDateString()}</span>
              <span style={{ fontWeight: 700, color: T.text, fontSize: 14, fontFamily: "'IBM Plex Mono', monospace" }}>
                {v.fhir.valueQuantity?.value} {v.fhir.valueQuantity?.unit}
                <span style={{ color: T.textMuted, fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                  ({(v.fhir.valueQuantity?.value / 2.54).toFixed(1)} in)
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Medications ──────────────────────────────────────────────────────────────
function MedicationsView({ keys, relay, practicePk, T }: { keys: PatientKeys; relay: ReturnType<typeof useRelay>; practicePk: string; T: Theme }) {
  const [meds, setMeds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (relay.status !== "connected") return;
    setLoading(true);
    const found: NostrEvent[] = [];
    const subId = relay.subscribe(
      { kinds: [FHIR_KINDS.MedicationRequest], "#p": [keys.pkHex], limit: 100 },
      (ev) => { if (!found.find(e => e.id === ev.id)) found.push(ev); }
    );
    setTimeout(async () => {
      relay.unsubscribe(subId);
      
      const decrypted: any[] = [];
      const deletedIds = new Set<string>();
      for (const ev of found) {
        const dTag = ev.tags.find(t => t[0] === "e" && t[3] === "deletion");
        if (dTag) deletedIds.add(dTag[1]);
      }
      for (const ev of found) {
        try {
          const patientContent = ev.tags.find(t => t[0] === "patient-content")?.[1];
          if (!patientContent) continue;
          const plain = await portalDecrypt(patientContent, keys, practicePk);
          const fhir = JSON.parse(plain);
          const isDeletion = ev.tags.find(t => t[0] === "e" && t[3] === "deletion");
          if (!isDeletion && !deletedIds.has(ev.id)) decrypted.push({ event: ev, fhir });
        } catch {}
      }
      setMeds(decrypted.sort((a, b) => b.event.created_at - a.event.created_at));
      setLoading(false);
    }, 2000);
  }, [keys, relay.status, practicePk]);

  if (loading) return <LoadingCard label="Loading medications..." T={T} />;

  return (
    <div>
      <SectionHeader title="Medications" icon="💊" count={meds.length} label="active" T={T} />
      {meds.length === 0 && <EmptyCard label="No active medications" T={T} />}
      {meds.map(m => (
        <div key={m.event.id} style={{ ...card(T), borderLeft: `3px solid #8b5cf6` }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6, color: T.text }}>{m.fhir.medicationCodeableConcept?.text}</div>
          <div style={{ color: T.textMuted, fontSize: 13, marginBottom: 6 }}>{m.fhir.dosageInstruction?.[0]?.text}</div>
          <div style={{ color: T.textMuted, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}>
            Started: {new Date(m.fhir.authoredOn).toLocaleDateString()}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Immunizations ────────────────────────────────────────────────────────────
function ImmunizationsView({ keys, relay, practicePk, practiceName, T }: { keys: PatientKeys; relay: ReturnType<typeof useRelay>; practicePk: string; practiceName: string; T: Theme }) {
  const [immunizations, setImmunizations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (relay.status !== "connected") return;
    setLoading(true);
    const found: NostrEvent[] = [];
    const subId = relay.subscribe(
      { kinds: [FHIR_KINDS.Immunization], "#p": [keys.pkHex], limit: 100 },
      (ev) => { if (!found.find(e => e.id === ev.id)) found.push(ev); }
    );
    setTimeout(async () => {
      relay.unsubscribe(subId);
      
      const decrypted: any[] = [];
      for (const ev of found) {
        try {
          const patientContent = ev.tags.find(t => t[0] === "patient-content")?.[1];
          if (!patientContent) continue;
          const plain = await portalDecrypt(patientContent, keys, practicePk);
          const fhir = JSON.parse(plain);
          decrypted.push({ event: ev, fhir });
        } catch {}
      }
      decrypted.sort((a, b) => new Date(b.fhir.occurrenceDateTime).getTime() - new Date(a.fhir.occurrenceDateTime).getTime());
      setImmunizations(decrypted);
      setLoading(false);
    }, 2000);
  }, [keys, relay.status, practicePk]);

  const handlePrint = () => {
    const grouped = immunizations.reduce((acc, i) => {
      const name = i.fhir.vaccineCode?.text || "Unknown";
      if (!acc[name]) acc[name] = [];
      acc[name].push(i);
      return acc;
    }, {} as Record<string, any[]>);

    const rows = Object.entries(grouped).map(([vaccine, doses]) => {
      const sortedDoses = (doses as any[]).sort((a, b) =>
        new Date(a.fhir.occurrenceDateTime).getTime() - new Date(b.fhir.occurrenceDateTime).getTime()
      );
      const dates = sortedDoses.map((d: any) =>
        new Date(d.fhir.occurrenceDateTime).toLocaleDateString()
      ).join(", ");
      return `<tr><td>${vaccine}</td><td>${dates}</td></tr>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html><head><title>Immunization Record</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #000; margin: 32px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { font-size: 12px; color: #555; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f0f0f0; text-align: left; padding: 8px 10px; border: 1px solid #ccc; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 7px 10px; border: 1px solid #ddd; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  .footer { margin-top: 24px; font-size: 10px; color: #888; }
</style>
</head><body>
<h1>💉 Immunization Record</h1>
<div class="sub">${practiceName} &nbsp;·&nbsp; Printed ${new Date().toLocaleDateString()}</div>
<table>
  <thead><tr><th>Vaccine</th><th>Date(s) Administered</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="footer">This record was generated from ${practiceName}. Verify with your provider for official documentation.</div>
</body></html>`;

    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  if (loading) return <LoadingCard label="Loading immunizations..." T={T} />;

  const grouped = immunizations.reduce((acc, i) => {
    const name = i.fhir.vaccineCode?.text || "Unknown";
    if (!acc[name]) acc[name] = [];
    acc[name].push(i);
    return acc;
  }, {} as Record<string, any[]>);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>💉 Immunizations</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {immunizations.length > 0 && (
            <span style={{ background: `${T.accent}18`, color: T.accent, borderRadius: 99, padding: "3px 10px", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
              {immunizations.length} doses
            </span>
          )}
          {immunizations.length > 0 && (
            <button onClick={handlePrint} style={{
              background: "none", border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "5px 12px", fontSize: 12, color: T.textMuted, cursor: "pointer",
              fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6,
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = T.text; (e.currentTarget as HTMLElement).style.borderColor = T.accent; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = T.textMuted; (e.currentTarget as HTMLElement).style.borderColor = T.border; }}
            >
              🖨 Print
            </button>
          )}
        </div>
      </div>
      {immunizations.length === 0 && <EmptyCard label="No immunizations recorded" T={T} />}
      {Object.entries(grouped).map(([vaccine, doses]) => (
        <div key={vaccine} style={{ ...card(T), borderLeft: `3px solid ${T.green}` }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: T.text }}>{vaccine}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(doses as any[]).sort((a: any, b: any) =>
              new Date(a.fhir.occurrenceDateTime).getTime() - new Date(b.fhir.occurrenceDateTime).getTime()
            ).map((d: any) => (
              <div key={d.event.id} style={{ background: `${T.green}15`, border: `1px solid ${T.green}35`, borderRadius: 8, padding: "6px 12px", textAlign: "center" as const }}>
                <div style={{ color: T.green, fontSize: 12, fontWeight: 700 }}>
                  {d.fhir.doseQuantity ? `Dose #${d.fhir.doseQuantity.value}` : "Dose"}
                </div>
                <div style={{ color: T.textMuted, fontSize: 11, marginTop: 2, fontFamily: "'IBM Plex Mono', monospace" }}>
                  {new Date(d.fhir.occurrenceDateTime).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function MessagingView({ keys, relay, practicePk, practiceName, T, guardianPkHex }: { keys: PatientKeys; relay: ReturnType<typeof useRelay>; practicePk: string; practiceName: string; T: Theme; guardianPkHex?: string }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string|null>(null);
  const [leftWidth, setLeftWidth] = useState(38); // percent
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("portal_archived_threads") || "[]")); } catch { return new Set(); }
  });

  const archiveThread = (rootId: string) => {
    setArchivedIds(s => { const n = new Set(s); n.add(rootId); localStorage.setItem("portal_archived_threads", JSON.stringify([...n])); return n; });
    setSelectedThreadId(null);
  };
  const unarchiveThread = (rootId: string) => {
    setArchivedIds(s => { const n = new Set(s); n.delete(rootId); localStorage.setItem("portal_archived_threads", JSON.stringify([...n])); return n; });
  };

  useEffect(() => {
    if (relay.status !== "connected") return;
    setLoading(true);
    
    const seenIds = new Set<string>();
    let loadingDone = false;
    const finishLoading = () => { if (!loadingDone) { loadingDone = true; setLoading(false); } };

    const processEvent = async (ev: NostrEvent) => {
      if (seenIds.has(ev.id)) return;
      seenIds.add(ev.id);
      try {
        const guardianOfTag = ev.tags.find((t: string[]) => t[0] === "guardian-of")?.[1];
        const fromPatient = ev.pubkey === keys.pkHex || (!!guardianPkHex && ev.pubkey === guardianPkHex && guardianOfTag === keys.pkHex);
        let plain: string | null = null;
        if (fromPatient) {
          try { plain = await portalDecrypt(ev.content, keys, practicePk); } catch {}
        } else {
          const patientContent = ev.tags.find((t: string[]) => t[0] === "patient-content")?.[1];
          if (patientContent) { try { plain = await portalDecrypt(patientContent, keys, practicePk); } catch {} }
          if (!plain) { try { plain = await portalDecrypt(ev.content, keys, practicePk); } catch {} }
        }
        if (plain) {
          const subject = ev.tags?.find((t: string[]) => t[0] === "subject")?.[1] || "(no subject)";
          const eTag = ev.tags?.find((t: string[]) => t[0] === "e")?.[1];
          const rootId = eTag || ev.id;
          const noReply = ev.tags?.some((t: string[]) => t[0] === "no-reply" && t[1] === "true") || false;
          setMessages(prev => {
            if (prev.find((m: any) => m.event.id === ev.id)) return prev;
            return [...prev, { event: ev, text: plain, fromPatient, subject, rootId, noReply }]
              .sort((a: any, b: any) => a.event.created_at - b.event.created_at);
          });
        }
      } catch {}
    };

    const subId = relay.subscribe(
      { kinds: [FHIR_KINDS.Message], "#p": [keys.pkHex, practicePk], limit: 100 },
      processEvent,
      () => finishLoading()
    );
    const fallback = setTimeout(() => finishLoading(), 3000);
    return () => { clearTimeout(fallback); relay.unsubscribe(subId); loadingDone = false; };
  }, [keys, relay.status, practicePk]);

  const sendReply = async () => {
    if (!replyBody.trim() || sending || !selectedThreadId) return;
    setSending(true);
    try {
      
      const encrypted = await portalEncrypt(replyBody.trim(), keys, practicePk);
      const rootMsg = messages.find((m: any) => m.event.id === selectedThreadId);
      const baseSubject = rootMsg?.subject || "message";
      const replySubject = baseSubject.startsWith("Re:") ? baseSubject : `Re: ${baseSubject}`;
      const tags: string[][] = [["p", practicePk], ["p", keys.pkHex], ["subject", replySubject], ["e", selectedThreadId]];
      if (guardianPkHex) tags.push(["guardian-of", keys.pkHex]);
      const event = await buildAndSignEvent(FHIR_KINDS.Message, encrypted, tags, keys.sk);
      if (await relay.publish(event)) {
        setMessages(m => [...m, {
          event: { ...event, created_at: Math.floor(Date.now() / 1000) },
          text: replyBody.trim(), fromPatient: true, subject: replySubject, rootId: selectedThreadId
        }]);
        setReplyBody("");
      } else {
        alert("Reply failed to send. Please check your connection and try again.");
      }
    } catch (e) { console.error(e); alert("Error sending reply. Please try again."); }
    finally { setSending(false); }
  };

  const sendMessage = async () => {
    if (!newMessage.trim() || sending) return;
    setSending(true);
    try {
      const subject = newSubject.trim() || "Message from patient";
      
      const encrypted = await portalEncrypt(newMessage.trim(), keys, practicePk);
      const tags: string[][] = [["p", practicePk], ["p", keys.pkHex], ["subject", subject]];
      if (guardianPkHex) tags.push(["guardian-of", keys.pkHex]);
      const event = await buildAndSignEvent(FHIR_KINDS.Message, encrypted, tags, keys.sk);
      if (await relay.publish(event)) {
        const rootId = event.id;
        setMessages(m => [...m, {
          event: { ...event, created_at: Math.floor(Date.now() / 1000) },
          text: newMessage.trim(), fromPatient: true, subject, rootId
        }]);
        setSelectedThreadId(rootId);
        setNewMessage(""); setNewSubject(""); setComposing(false);
      } else {
        alert("Message failed to send.");
      }
    } catch (e) { console.error(e); alert("Error: " + e); }
    finally { setSending(false); }
  };

  // Build threads — computed directly, no inner component
  const threadMap: Record<string, any[]> = {};
  messages.forEach((m: any) => {
    if (!m.rootId) return;
    if (!threadMap[m.rootId]) threadMap[m.rootId] = [];
    threadMap[m.rootId].push(m);
  });
  const buildThreads = (filterArchived: boolean) =>
    Object.entries(threadMap)
      .map(([rootId, msgs]) => {
        const sorted = [...msgs].sort((a, b) => a.event.created_at - b.event.created_at);
        return { rootId, msgs: sorted, latest: sorted[sorted.length - 1] };
      })
      .filter(t => filterArchived ? archivedIds.has(t.rootId) : !archivedIds.has(t.rootId))
      .sort((a, b) => b.latest.event.created_at - a.latest.event.created_at);

  const threads = buildThreads(false);
  const archivedThreads = buildThreads(true);
  const selectedThread = threads.concat(archivedThreads).find(t => t.rootId === selectedThreadId) || null;

  const fmtTs = (ts: number) => new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtTsShort = (ts: number) => {
    const now = new Date(); const d = new Date(ts * 1000);
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const container = containerRef.current;
    if (!container) return;
    const onMove = (me: MouseEvent) => {
      if (!dragging.current) return;
      const rect = container.getBoundingClientRect();
      const pct = ((me.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.min(65, Math.max(15, pct)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (loading) return <LoadingCard label="Loading messages..." T={T} />;

  return (
    <div>
      <SectionHeader title="Secure Messages" icon="💬" T={T} />

      <div style={{ background: `${T.accent}10`, border: `1px solid ${T.accent}25`, borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: T.textMuted }}>
        🔒 <strong style={{ color: T.accent }}>End-to-end encrypted</strong> — only you and {practiceName} can read these.
      </div>

      {/* Two-pane layout */}
      <div ref={containerRef} style={{ display: "flex", gap: 0, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", minHeight: 480, userSelect: dragging.current ? "none" : "auto" as any }}>

        {/* Left: thread list */}
        <div style={{ width: `${leftWidth}%`, flexShrink: 0, display: "flex", flexDirection: "column", background: T.surfaceHi, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Inbox</div>
            <button onClick={() => { setComposing(true); setSelectedThreadId(null); }} style={{
              background: T.accent, border: "none", color: "#fff", borderRadius: 6,
              padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit"
            }}>✏ New</button>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {threads.length === 0 && !composing && (
              <div style={{ padding: 24, textAlign: "center", color: T.textMuted, fontSize: 12 }}>No messages yet</div>
            )}
            {threads.map(({ rootId, msgs, latest }) => {
              const isSel = selectedThreadId === rootId;
              const hasUnread = msgs.some((m: any) => !m.fromPatient);
              const lastFromProvider = !latest.fromPatient;
              return (
                <div key={rootId} onClick={() => { setSelectedThreadId(rootId); setComposing(false); }}
                  style={{
                    padding: "12px 14px", borderBottom: `1px solid ${T.border}`, cursor: "pointer",
                    background: isSel ? `${T.accent}18` : lastFromProvider ? `${T.blue}08` : "transparent",
                    borderLeft: `3px solid ${isSel ? T.accent : lastFromProvider ? T.blue : "transparent"}`,
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <div style={{ fontSize: 12, fontWeight: lastFromProvider ? 700 : 500, color: lastFromProvider ? T.text : T.textMuted,
                      overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", maxWidth: "70%" }}>
                      {msgs[0].subject}
                    </div>
                    <div style={{ fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{fmtTsShort(latest.event.created_at)}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: latest.fromPatient ? T.accent : T.blue,
                      flexShrink: 0 }}>
                      {latest.fromPatient ? "You" : "Practice"}:
                    </span>
                    <span style={{ fontSize: 11, color: T.textMuted, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                      {latest.text.slice(0, 40)}{latest.text.length > 40 ? "…" : ""}
                    </span>
                  </div>
                  {msgs.length > 1 && (
                    <div style={{ fontSize: 10, color: T.textMuted, marginTop: 3 }}>{msgs.length} messages</div>
                  )}
                </div>
              );
            })}

            {archivedThreads.length > 0 && (
              <div>
                <button
                  onClick={() => setShowArchived(v => !v)}
                  style={{
                    width: "100%", padding: "8px 14px", background: T.bg,
                    border: "none", borderTop: `1px solid ${T.border}`,
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.5px" }}>
                    Archived ({archivedThreads.length})
                  </span>
                  <span style={{ fontSize: 11, color: T.textMuted }}>{showArchived ? "▲" : "▼"}</span>
                </button>
                {showArchived && archivedThreads.map(({ rootId, msgs, latest }) => {
                  const isSel = selectedThreadId === rootId;
                  return (
                    <div key={rootId} onClick={() => { setSelectedThreadId(rootId); setComposing(false); }}
                      style={{
                        padding: "10px 14px", borderBottom: `1px solid ${T.border}`, cursor: "pointer", opacity: 0.55,
                        background: isSel ? `${T.accent}18` : "transparent",
                        borderLeft: `3px solid ${isSel ? T.accent : "transparent"}`,
                      }}>
                      <div style={{ fontSize: 12, color: T.text, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{msgs[0].subject}</div>
                      <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{fmtTsShort(latest.event.created_at)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Draggable divider */}
        <div onMouseDown={onDividerMouseDown} style={{
          width: 10, flexShrink: 0, cursor: "col-resize", background: T.surfaceHi,
          borderLeft: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          position: "relative", zIndex: 1,
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, pointerEvents: "none" }}>
            <div style={{ width: 3, height: 3, borderRadius: "50%", background: T.textMuted, opacity: 0.5 }} />
            <div style={{ width: 3, height: 3, borderRadius: "50%", background: T.textMuted, opacity: 0.5 }} />
            <div style={{ width: 3, height: 3, borderRadius: "50%", background: T.textMuted, opacity: 0.5 }} />
          </div>
        </div>

        {/* Right: thread detail or compose */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.bg }}>

          {/* Empty state */}
          {!selectedThread && !composing && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: T.textMuted, gap: 10 }}>
              <div style={{ fontSize: 28 }}>💬</div>
              <div style={{ fontSize: 13 }}>Select a conversation or start a new one</div>
            </div>
          )}

          {/* Compose new message */}
          {composing && (
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>New Message</div>
                <button onClick={() => setComposing(false)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 18 }}>✕</button>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>To</label>
                <div style={{ padding: "8px 10px", background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, color: T.textMuted }}>{practiceName}</div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>Subject</label>
                <input value={newSubject} onChange={e => setNewSubject(e.target.value)}
                  placeholder="What is this about?"
                  style={{ ...input(T), display: "block", width: "100%", boxSizing: "border-box" as const }} />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>Message</label>
                <textarea value={newMessage} onChange={e => setNewMessage(e.target.value)}
                  placeholder="Write your message..."
                  rows={8}
                  style={{ ...input(T), resize: "vertical" as const, display: "block", width: "100%", boxSizing: "border-box" as const }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn solid T={T} onClick={sendMessage} disabled={!newMessage.trim() || sending}>
                  {sending ? "Sending..." : "Send →"}
                </Btn>
                <Btn T={T} onClick={() => { setComposing(false); setNewSubject(""); setNewMessage(""); }}>Discard</Btn>
              </div>
            </div>
          )}

          {/* Thread detail */}
          {selectedThread && !composing && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {/* Thread header */}
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>{selectedThread.msgs[0].subject}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 11, color: T.textMuted }}>{selectedThread.msgs.length} message{selectedThread.msgs.length !== 1 ? "s" : ""}</div>
                  {!archivedIds.has(selectedThread.rootId) ? (
                    <button onClick={() => archiveThread(selectedThread.rootId)} style={{
                      background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
                      color: T.textMuted, fontSize: 11, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit"
                    }}>Archive</button>
                  ) : (
                    <button onClick={() => unarchiveThread(selectedThread.rootId)} style={{
                      background: "none", border: `1px solid ${T.accent}`, borderRadius: 6,
                      color: T.accent, fontSize: 11, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit"
                    }}>Restore</button>
                  )}
                </div>
              </div>

              {/* Message list — chat bubbles */}
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
                {selectedThread.msgs.map((msg: any) => {
                  const fromMe = msg.fromPatient;
                  return (
                    <div key={msg.event.id} style={{ display: "flex", flexDirection: "column", alignItems: fromMe ? "flex-end" : "flex-start" }}>
                      {/* Sender label + timestamp */}
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4,
                        flexDirection: fromMe ? "row-reverse" : "row" }}>
                        <span style={{ fontSize: 11, fontWeight: 600,
                          color: fromMe ? T.accent : T.blue }}>
                          {fromMe ? (keys.name && keys.name !== "Patient" ? keys.name : "You") : practiceName}
                        </span>
                        <span style={{ fontSize: 10, color: T.textMuted }}>{fmtTs(msg.event.created_at)}</span>
                      </div>
                      {/* Bubble */}
                      <div style={{
                        maxWidth: "80%",
                        padding: "10px 14px",
                        borderRadius: fromMe ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                        background: fromMe ? `${T.accent}18` : T.surfaceHi,
                        border: `1px solid ${fromMe ? T.accent+"40" : T.border}`,
                        fontSize: 13,
                        lineHeight: 1.7,
                        color: T.text,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word" as const,
                      }}>
                        {msg.text}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Reply box or locked notice */}
              {!archivedIds.has(selectedThread.rootId) && (
                selectedThread.msgs.some((m: any) => m.noReply)
                ? (
                  <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.border}`, flexShrink: 0,
                    display: "flex", alignItems: "center", gap: 10, background: T.bg }}>
                    <span style={{ fontSize: 13 }}>🔒</span>
                    <span style={{ fontSize: 12, color: T.textMuted }}>The practice has disabled replies on this thread.</span>
                  </div>
                ) : (
                  <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
                    <textarea
                      value={replyBody}
                      onChange={e => setReplyBody(e.target.value)}
                      placeholder={`Reply to ${practiceName}...`}
                      rows={3}
                      style={{ ...input(T), resize: "none" as const, marginBottom: 8, display: "block", width: "100%", boxSizing: "border-box" as const }}
                    />
                    <Btn solid T={T} onClick={sendReply} disabled={!replyBody.trim() || sending}>
                      {sending ? "Sending..." : "↩ Reply"}
                    </Btn>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Appointments ─────────────────────────────────────────────────────────────
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

function fmtTime(t: string) {
  const [h,m] = t.split(":").map(Number);
  return `${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`;
}
function fmtDate(ds: string) {
  const d = new Date(ds+"T00:00:00");
  return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
}
function dateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

interface Appt {
  id: number; patient_npub: string; patient_name: string;
  date: string; start_time: string; end_time: string;
  appt_type: string; status: string; notes?: string; video_url?: string;
}
interface Slot { start_time: string; end_time: string; }

function AppointmentsView({ keys, calendarApi, T, onJoinVideo }: { keys: PatientKeys | null; calendarApi?: string; T: Theme; onJoinVideo?: (appointmentId: number) => void }) {
  const [apptTab, setApptTab] = useState<"upcoming"|"book"|"history">("upcoming");
  const [upcoming, setUpcoming] = useState<Appt[]>([]);
  const [history, setHistory] = useState<Appt[]>([]);
  const [loading, setLoading] = useState(true);

  // Booking rules (per-visit vs monthly restrictions)
  const [bookingRules, setBookingRules] = useState<{
    billingModel: string; allowedTypes: string[]; maxActiveAppointments: number|null;
    activeAppointmentCount: number; canBook: boolean; message: string|null;
  }|null>(null);

  // Booking state
  const [bookMonth, setBookMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; });
  const [bookDate, setBookDate] = useState<string|null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selSlot, setSelSlot] = useState<{start:string;end:string;isOpen:boolean}|null>(null);
  const [bookType, setBookType] = useState("video");
  const [bookPhone, setBookPhone] = useState("");
  const [bookNotes, setBookNotes] = useState("");
  const [bookStep, setBookStep] = useState(1);
  const [bookResult, setBookResult] = useState<{confirmed:boolean;msg:string}|null>(null);
  const [availCache, setAvailCache] = useState<Record<string,Slot[]>>({});

  const npub = keys?.npub;
  const name = keys?.name || "Patient";
  const isPerVisit = bookingRules?.billingModel === "per-visit";

  useEffect(() => {
    if (!npub || !calendarApi) return;
    setLoading(true);
    // Load appointments + booking rules in parallel
    Promise.all([
      fetch(`${calendarApi}/api/appointments/patient/${encodeURIComponent(npub)}`).then(r => r.ok ? r.json() : []),
      fetch(`${calendarApi}/api/patients/${encodeURIComponent(npub)}/booking-rules`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([data, rules]) => {
      if (Array.isArray(data)) {
        setUpcoming(data.filter((a: Appt) => ["confirmed","pending"].includes(a.status) && a.date >= dateStr(new Date())));
        setHistory(data.filter((a: Appt) => ["cancelled","declined"].includes(a.status) || a.date < dateStr(new Date())));
      }
      if (rules) {
        setBookingRules(rules);
        // Default to first allowed type
        if (rules.allowedTypes?.length > 0) setBookType(rules.allowedTypes[0]);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [npub, calendarApi]);

  // If no calendar API, show informational message
  if (!calendarApi) {
    return (
      <div>
        <SectionHeader title="Appointments" icon="📅" T={T} />
        <div style={{ ...card(T, { textAlign: "center", padding: 36 }) }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>📅</div>
          <div style={{ fontSize: 13, color: T.textMuted }}>This practice does not have online scheduling enabled. Contact your provider to schedule appointments.</div>
        </div>
      </div>
    );
  }

  const cancelAppt = async (id: number) => {
    if (!confirm("Cancel this appointment?")) return;
    await fetch(`${calendarApi}/api/appointments/${id}/status`, {
      method: "PATCH", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({status:"cancelled"})
    });
    if (!npub) return;
    const data = await fetch(`${calendarApi}/api/appointments/patient/${encodeURIComponent(npub)}`).then(r=>r.json());
    setUpcoming(data.filter((a: Appt) => ["confirmed","pending"].includes(a.status) && a.date >= dateStr(new Date())));
    setHistory(data.filter((a: Appt) => ["cancelled","declined"].includes(a.status) || a.date < dateStr(new Date())));
  };

  const selectDate = async (ds: string) => {
    setBookDate(ds); setSelSlot(null); setBookStep(2);
    if (availCache[ds]) { setSlots(availCache[ds]); return; }
    const data = await fetch(`${calendarApi}/api/availability/${ds}`).then(r=>r.json()).catch(()=>[]);
    setAvailCache(c => ({...c, [ds]: data}));
    setSlots(data);
  };

  const confirmBooking = async () => {
    if (!npub || !bookDate || !selSlot) return;
    try {
      const res = await fetch(`${calendarApi}/api/appointments`, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          patient_npub: npub, patient_name: name,
          patient_phone: bookPhone || null, date: bookDate,
          start_time: selSlot.start, end_time: selSlot.end,
          appt_type: isPerVisit ? "video" : bookType, notes: bookNotes || null,
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert("Booking failed: " + (err.error || res.status));
        return;
      }
      const data = await res.json();
      const confirmed = data.status === "confirmed";
      setBookResult({
        confirmed,
        msg: confirmed
          ? `Your appointment on ${fmtDate(bookDate)} at ${fmtTime(selSlot.start)} is confirmed.`
          : `Your request for ${fmtDate(bookDate)} at ${fmtTime(selSlot.start)} has been sent for approval.`
      });
      setBookStep(4);
      const updated = await fetch(`${calendarApi}/api/appointments/patient/${encodeURIComponent(npub)}`).then(r=>r.ok?r.json():[]);
      if (Array.isArray(updated)) {
        setUpcoming(updated.filter((a: Appt) => ["confirmed","pending"].includes(a.status) && a.date >= dateStr(new Date())));
      }
    } catch(err) {
      alert("Booking error — please try again.");
      console.error("confirmBooking error:", err);
    }
  };

  const renderCal = () => {
    const y = bookMonth.getFullYear(), m = bookMonth.getMonth();
    const firstDow = (new Date(y,m,1).getDay()+6)%7;
    const daysInMonth = new Date(y,m+1,0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);
    const cells = [];
    DAYS_SHORT.forEach(d => cells.push(
      <div key={"h"+d} style={{textAlign:"center",fontSize:10,color:T.textMuted,fontWeight:600,padding:"3px 0",textTransform:"uppercase"}}>{d[0]}</div>
    ));
    for (let i=0;i<firstDow;i++) cells.push(<div key={"e"+i}/>);
    for (let d=1;d<=daysInMonth;d++) {
      const date = new Date(y,m,d);
      const ds = dateStr(date);
      const dow = (date.getDay()+6)%7;
      const isPast = date < today;
      const isWeekend = dow >= 5;
      const isSel = bookDate === ds;
      const disabled = isPast || isWeekend;
      cells.push(
        <div key={d} onClick={() => !disabled && selectDate(ds)} style={{
          textAlign:"center", padding:"6px 2px", borderRadius:7, fontSize:13,
          cursor: disabled ? "default" : "pointer",
          background: isSel ? T.accent : "transparent",
          color: isSel ? "#fff" : disabled ? T.border : T.text,
          fontWeight: isSel ? 700 : 400,
        }}>{d}</div>
      );
    }
    return cells;
  };

  const typeLabel = (t: string) => ({in_person:"In Person",phone:"Phone",video:"Video"}[t]||t);

  const apptCard = (a: Appt, showCancel: boolean) => (
    <div key={a.id} style={card(T)}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
        <div>
          <div style={{fontWeight:700,fontSize:15}}>{fmtDate(a.date)}</div>
          <div style={{color:T.textMuted,fontSize:12,marginTop:2}}>{fmtTime(a.start_time)} – {fmtTime(a.end_time)}</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <span style={{fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:99,background:`${T.blue}20`,color:T.blue,textTransform:"uppercase"}}>{typeLabel(a.appt_type)}</span>
          <span style={{fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:99,
            background: a.status==="confirmed"?`${T.green}20`:a.status==="pending"?`${T.amber}20`:`${T.textMuted}20`,
            color: a.status==="confirmed"?T.green:a.status==="pending"?T.amber:T.textMuted,
            textTransform:"uppercase"}}>{a.status}</span>
        </div>
      </div>
      {a.notes && <div style={{color:T.textMuted,fontSize:13,marginBottom:8}}>{a.notes}</div>}
      {a.appt_type === "video" && a.status === "confirmed" && onJoinVideo && (
        <button onClick={() => onJoinVideo(a.id)} style={{
          width:"100%",padding:"10px",borderRadius:8,border:"none",
          background:`${T.green}20`,color:T.green,fontSize:13,fontWeight:700,
          cursor:"pointer",fontFamily:"inherit",marginBottom:8,
          display:"flex",alignItems:"center",justifyContent:"center",gap:8,
        }}>
          📹 Join Video Visit
        </button>
      )}
      {showCancel && ["confirmed","pending"].includes(a.status) && (
        <div style={{textAlign:"right",marginTop:4}}>
          <span onClick={() => cancelAppt(a.id)} style={{
            fontSize:12,color:T.textMuted,cursor:"pointer",
            textDecoration:"underline",textUnderlineOffset:"3px",
          }}
            onMouseEnter={e=>(e.currentTarget as HTMLElement).style.color=T.red}
            onMouseLeave={e=>(e.currentTarget as HTMLElement).style.color=T.textMuted}
          >
            Cancel appointment
          </span>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <SectionHeader title="Appointments" icon="📅" T={T} />

      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:20,background:T.surface,borderRadius:10,padding:4,border:`1px solid ${T.border}`}}>
        {(["upcoming","book","history"] as const).map(t => (
          <button key={t} onClick={() => { setApptTab(t); if(t==="book"){setBookStep(1);setBookResult(null);setBookDate(null);setSelSlot(null);} }}
            style={{flex:1,padding:"8px",borderRadius:7,border:"none",
              background:apptTab===t?T.surfaceHi:"transparent",
              color:apptTab===t?T.text:T.textMuted,
              fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            {t==="upcoming"?"Upcoming":t==="book"?"Book a Visit":"Past Visits"}
          </button>
        ))}
      </div>

      {apptTab==="upcoming" && (
        loading ? <div style={{color:T.textMuted,textAlign:"center",padding:40}}>Loading...</div> :
        upcoming.length === 0
          ? <div style={{textAlign:"center",padding:48,color:T.textMuted}}>
              <div style={{fontSize:36,marginBottom:12}}>📅</div>
              <div style={{marginBottom:16}}>No upcoming appointments</div>
              <Btn T={T} solid onClick={() => setApptTab("book")}>Book a Visit</Btn>
            </div>
          : upcoming.map(a => apptCard(a, true))
      )}

      {apptTab==="book" && (
        <div>

          {/* Per-visit restriction banner */}
          {isPerVisit && (
            <div style={{background:`${T.accent}10`,border:`1px solid ${T.accent}30`,borderRadius:10,padding:"12px 14px",marginBottom:16,fontSize:13,color:T.textMuted,lineHeight:1.6}}>
              <strong style={{color:T.accent}}>Virtual Care</strong> — Video visits only. {bookingRules?.maxActiveAppointments === 1 ? "One appointment at a time." : ""}
            </div>
          )}

          {/* Booking limit reached */}
          {bookingRules && !bookingRules.canBook ? (
            <div style={{textAlign:"center",padding:48,color:T.textMuted}}>
              <div style={{fontSize:48,marginBottom:16}}>📋</div>
              <div style={{fontWeight:700,fontSize:16,color:T.text,marginBottom:8}}>Appointment Limit Reached</div>
              <div style={{fontSize:13,lineHeight:1.6,maxWidth:360,margin:"0 auto",marginBottom:20}}>
                {bookingRules.message || "You already have an active appointment. Please complete or cancel it before booking another."}
              </div>
              <Btn T={T} solid onClick={() => setApptTab("upcoming")}>View My Appointments</Btn>
            </div>
          ) : <>

          {bookStep===1 && (
            <div style={card(T)}>
              <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>Select a Date</div>
              <div style={{color:T.textMuted,fontSize:12,marginBottom:16}}>Weekdays only, Mon–Fri</div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                <button onClick={() => setBookMonth(m => { const d=new Date(m); d.setMonth(d.getMonth()-1); return d; })}
                  style={{background:"none",border:"none",color:T.textMuted,cursor:"pointer",fontSize:18,padding:"0 6px"}}>‹</button>
                <span style={{fontWeight:700}}>{MONTHS[bookMonth.getMonth()]} {bookMonth.getFullYear()}</span>
                <button onClick={() => setBookMonth(m => { const d=new Date(m); d.setMonth(d.getMonth()+1); return d; })}
                  style={{background:"none",border:"none",color:T.textMuted,cursor:"pointer",fontSize:18,padding:"0 6px"}}>›</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
                {renderCal()}
              </div>
            </div>
          )}

          {bookStep===2 && bookDate && (
            <div>
              <div style={card(T)}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:15}}>{fmtDate(bookDate)}</div>
                    <div style={{color:T.textMuted,fontSize:12,marginTop:2}}>Select a time slot</div>
                  </div>
                  <Btn T={T} small onClick={() => setBookStep(1)}>‹ Back</Btn>
                </div>
                {slots.length===0
                  ? <div style={{color:T.textMuted,fontSize:13}}>No standard slots available. You can still submit a request.</div>
                  : <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                      {slots.map(s => (
                        <button key={s.start_time} onClick={() => setSelSlot({start:s.start_time,end:s.end_time,isOpen:true})}
                          style={{padding:"10px 8px",borderRadius:8,border:`1px solid ${selSlot?.start===s.start_time?T.green:T.border}`,
                            background:selSlot?.start===s.start_time?`${T.green}20`:T.surfaceHi,
                            color:selSlot?.start===s.start_time?T.green:T.text,
                            fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                          {fmtTime(s.start_time)}
                        </button>
                      ))}
                    </div>
                }
              </div>
              <div style={card(T)}>
                <div style={{marginBottom:14}}>
                  <label style={lbl(T)}>Visit Type</label>
                  {isPerVisit ? (
                    <div style={{padding:"10px 14px",borderRadius:8,border:`1px solid ${T.border}`,background:T.surfaceHi,fontSize:13,color:T.text}}>
                      📹 Video Visit
                      <span style={{fontSize:11,color:T.textMuted,marginLeft:8}}>(virtual care)</span>
                    </div>
                  ) : (
                    <select value={bookType} onChange={e=>setBookType(e.target.value)} style={input(T)}>
                      <option value="in_person">In Person</option>
                      <option value="phone">Phone Call</option>
                      <option value="video">Video Visit</option>
                    </select>
                  )}
                </div>
                <div style={{marginBottom:14}}>
                  <label style={lbl(T)}>Phone (for reminders)</label>
                  <input type="tel" value={bookPhone} onChange={e=>setBookPhone(e.target.value)}
                    placeholder="(555) 555-5555" style={input(T)} />
                </div>
                <div style={{marginBottom:18}}>
                  <label style={lbl(T)}>Reason for Visit</label>
                  <textarea value={bookNotes} onChange={e=>setBookNotes(e.target.value)}
                    placeholder="Briefly describe your reason..." rows={3}
                    style={{...input(T),resize:"none"}} />
                </div>
                <Btn T={T} solid fullWidth onClick={() => setBookStep(3)} disabled={!selSlot}>Review →</Btn>
              </div>
            </div>
          )}

          {bookStep===3 && bookDate && selSlot && (
            <div style={card(T)}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <div style={{fontWeight:700,fontSize:15}}>Confirm Appointment</div>
                <Btn T={T} small onClick={() => setBookStep(2)}>‹ Back</Btn>
              </div>
              {[
                ["Date", fmtDate(bookDate)],
                ["Time", `${fmtTime(selSlot.start)} – ${fmtTime(selSlot.end)}`],
                ["Type", typeLabel(bookType)],
                ["Status", selSlot.isOpen ? "Will auto-confirm" : "Pending approval"],
                ...(isPerVisit ? [["Plan", "Virtual Care (per-visit)"]] : []),
              ].map(([l,v]) => (
                <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${T.border}`,fontSize:13}}>
                  <span style={{color:T.textMuted}}>{l}</span>
                  <span style={{fontWeight:600}}>{v}</span>
                </div>
              ))}
              {bookNotes && <div style={{marginTop:12,color:T.textMuted,fontSize:13}}>{bookNotes}</div>}
              <div style={{background:`${T.blue}10`,border:`1px solid ${T.blue}25`,borderRadius:10,padding:"12px 14px",margin:"16px 0",fontSize:13,color:T.textMuted}}>
                <strong style={{color:T.blue}}>Note:</strong> Open slots auto-confirm. Requests outside availability are sent for approval.
              </div>
              <Btn T={T} solid fullWidth onClick={confirmBooking}>Confirm Booking</Btn>
            </div>
          )}

          {bookStep===4 && bookResult && (
            <div style={{...card(T),textAlign:"center",padding:40}}>
              <div style={{fontSize:48,marginBottom:16}}>{bookResult.confirmed?"✅":"📋"}</div>
              <div style={{fontWeight:800,fontSize:18,marginBottom:8}}>
                {bookResult.confirmed?"Appointment Confirmed!":"Request Submitted!"}
              </div>
              <div style={{color:T.textMuted,fontSize:13,marginBottom:24,lineHeight:1.6}}>{bookResult.msg}</div>
              <Btn T={T} solid onClick={() => { setApptTab("upcoming"); }}>View My Appointments</Btn>
            </div>
          )}

          </>}
        </div>
      )}

      {apptTab==="history" && (
        loading ? <div style={{color:T.textMuted,textAlign:"center",padding:40}}>Loading...</div> :
        history.length === 0
          ? <div style={{textAlign:"center",padding:48,color:T.textMuted}}>
              <div style={{fontSize:36,marginBottom:12}}>🗂️</div>
              <div>No past appointments</div>
            </div>
          : history.map(a => apptCard(a, false))
      )}
    </div>
  );
}

// ─── FHIR R4 Normalizer ──────────────────────────────────────────────────────
function normalizeFhirResource(fhir: any, patientRef: { reference: string }, ev: NostrEvent): any | null {
  const rt = fhir.resourceType;
  const timestamp = new Date(ev.created_at * 1000).toISOString();

  // Base: ensure patient reference uses consistent format
  const ensurePatientRef = (r: any) => {
    if (r.subject) r.subject = patientRef;
    if (r.patient) r.patient = patientRef;
    return r;
  };

  switch (rt) {
    case "Patient":
      // Enrich with data from the event
      return {
        ...fhir,
        meta: { lastUpdated: timestamp },
      };

    case "Encounter":
      return ensurePatientRef({
        resourceType: "Encounter",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        status: fhir.status || "finished",
        class: fhir.class || {
          system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          code: "AMB", display: "ambulatory",
        },
        subject: patientRef,
        period: fhir.period || { start: timestamp },
        reasonCode: fhir.reasonCode,
        note: fhir.note,
      });

    case "Observation":
      return ensurePatientRef({
        resourceType: "Observation",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        status: fhir.status || "final",
        category: [{
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }],
        }],
        code: fhir.code,
        subject: patientRef,
        effectiveDateTime: fhir.effectiveDateTime || timestamp,
        valueQuantity: fhir.valueQuantity,
      });

    case "MedicationRequest":
      return ensurePatientRef({
        resourceType: "MedicationRequest",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        status: fhir.status || "active",
        intent: fhir.intent || "order",
        subject: patientRef,
        medicationCodeableConcept: fhir.medicationCodeableConcept,
        dosageInstruction: fhir.dosageInstruction,
        authoredOn: fhir.authoredOn || timestamp,
        // Map extended Rx fields into FHIR extensions
        ...(fhir.sig && {
          extension: [
            ...(fhir.sig ? [{ url: "urn:nostr:ehr:rx:sig", valueString: fhir.sig }] : []),
            ...(fhir.qty ? [{ url: "urn:nostr:ehr:rx:qty", valueString: fhir.qty }] : []),
            ...(fhir.refills !== undefined ? [{ url: "urn:nostr:ehr:rx:refills", valueInteger: fhir.refills }] : []),
            ...(fhir.pharmacy ? [{ url: "urn:nostr:ehr:rx:pharmacy", valueString: fhir.pharmacy }] : []),
          ],
        }),
      });

    case "Condition":
      return ensurePatientRef({
        resourceType: "Condition",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        clinicalStatus: fhir.clinicalStatus || { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
        severity: fhir.severity,
        code: fhir.code,
        subject: patientRef,
        onsetDateTime: fhir.onsetDateTime,
        recordedDate: fhir.recordedDate || timestamp,
        note: fhir.note,
      });

    case "AllergyIntolerance":
      return ensurePatientRef({
        resourceType: "AllergyIntolerance",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        clinicalStatus: fhir.clinicalStatus || { coding: [{ code: "active" }] },
        code: fhir.code,
        patient: patientRef,
        reaction: fhir.reaction,
        recordedDate: fhir.recordedDate || timestamp,
      });

    case "Immunization":
      return ensurePatientRef({
        resourceType: "Immunization",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        status: fhir.status || "completed",
        vaccineCode: fhir.vaccineCode,
        patient: patientRef,
        occurrenceDateTime: fhir.occurrenceDateTime,
        doseQuantity: fhir.doseQuantity,
        recorded: fhir.recorded || timestamp,
      });

    case "ServiceRequest":
      return ensurePatientRef({
        resourceType: "ServiceRequest",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        status: fhir.status || "active",
        intent: fhir.intent || "order",
        category: fhir.category ? [{
          coding: [{
            system: "http://snomed.info/sct",
            code: fhir.category === "lab" ? "108252007" : "363679005",
            display: fhir.category === "lab" ? "Laboratory procedure" : "Imaging",
          }],
        }] : undefined,
        priority: fhir.priority,
        code: fhir.code,
        subject: patientRef,
        authoredOn: fhir.authoredOn || timestamp,
        reasonCode: fhir.reasonCode,
        performer: fhir.performer,
        note: fhir.note,
      });

    case "DiagnosticReport": {
      // Normalize category from string to CodeableConcept
      const catCode = fhir.category === "lab" ? "LAB" : fhir.category === "imaging" ? "IMG" : fhir.category;
      const report: any = {
        resourceType: "DiagnosticReport",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        status: fhir.status || "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: catCode }] }],
        code: fhir.code,
        subject: patientRef,
        effectiveDateTime: fhir.effectiveDate || timestamp,
        issued: fhir.issued || timestamp,
        conclusion: fhir.conclusion,
      };
      // Map interpretation string to CodeableConcept
      if (fhir.interpretation) {
        const interpMap: Record<string, string> = { normal: "N", abnormal: "A", critical: "AA" };
        report.conclusionCode = [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: interpMap[fhir.interpretation] || fhir.interpretation }] }];
      }
      // Map analytes into presentedForm or extension (non-standard data)
      if (fhir.analytes && fhir.analytes.length > 0) {
        report.extension = [{
          url: "urn:nostr:ehr:analytes",
          valueString: JSON.stringify(fhir.analytes),
        }];
      }
      // Include freetext result
      if (fhir.result && typeof fhir.result === "string") {
        report.conclusion = report.conclusion || fhir.result;
      }
      return report;
    }

    case "RxOrder":
      // Map custom RxOrder to MedicationRequest with extensions
      return ensurePatientRef({
        resourceType: "MedicationRequest",
        id: fhir.id,
        meta: { lastUpdated: timestamp, tag: [{ system: "urn:nostr:ehr", code: "rx-order" }] },
        status: fhir.status || "active",
        intent: "order",
        subject: patientRef,
        medicationCodeableConcept: { text: fhir.drug },
        dosageInstruction: [{ text: `${fhir.dose || ""} ${fhir.sig || ""}`.trim(), route: fhir.route ? { text: fhir.route } : undefined }],
        authoredOn: fhir.authoredOn || timestamp,
        dispenseRequest: {
          quantity: fhir.qty ? { value: parseFloat(fhir.qty) || undefined, unit: fhir.qty } : undefined,
          expectedSupplyDuration: fhir.daysSupply ? { value: fhir.daysSupply, unit: "days", system: "http://unitsofmeasure.org", code: "d" } : undefined,
          numberOfRepeatsAllowed: fhir.refills,
        },
        extension: [
          ...(fhir.daw !== undefined ? [{ url: "urn:nostr:ehr:rx:daw", valueBoolean: fhir.daw }] : []),
          ...(fhir.pharmacy ? [{ url: "urn:nostr:ehr:rx:pharmacy", valueString: fhir.pharmacy }] : []),
          ...(fhir.indication ? [{ url: "urn:nostr:ehr:rx:indication", valueString: fhir.indication }] : []),
        ],
      });

    case "DocumentReference":
      return ensurePatientRef({
        resourceType: "DocumentReference",
        id: fhir.id,
        meta: { lastUpdated: timestamp },
        status: fhir.status || "current",
        type: fhir.type,
        subject: patientRef,
        date: fhir.date || timestamp,
        description: fhir.description,
        content: fhir.content,
      });

    default:
      // Unknown resource type — pass through with patient ref
      return ensurePatientRef({ ...fhir, meta: { lastUpdated: timestamp } });
  }
}

// ─── My Data: Relay Sync & Export ────────────────────────────────────────────
const ALL_CLINICAL_KINDS = [
  FHIR_KINDS.Patient, FHIR_KINDS.Encounter, FHIR_KINDS.MedicationRequest,
  FHIR_KINDS.Observation, FHIR_KINDS.Condition, FHIR_KINDS.AllergyIntolerance,
  FHIR_KINDS.Immunization, FHIR_KINDS.Message,
  FHIR_KINDS.ServiceRequest, FHIR_KINDS.DiagnosticReport,
  FHIR_KINDS.RxOrder, FHIR_KINDS.DocumentReference,
];

const KIND_LABELS: Record<number, string> = {
  2110: "Demographics", 2111: "Encounters", 2112: "Medications",
  2113: "Vitals", 2114: "Conditions", 2115: "Allergies",
  2116: "Immunizations", 2117: "Messages", 2118: "Orders",
  2119: "Results", 2121: "Documents",
};

function MyDataView({ keys, relay, practicePk, practiceName, connections, T }: {
  keys: PatientKeys;
  relay: ReturnType<typeof useRelay>;
  practicePk: string;
  practiceName: string;
  connections: PracticeConnection[];
  T: Theme;
}) {
  // Personal relay config
  const [personalRelay, setPersonalRelay] = useState(() =>
    localStorage.getItem("portal_personal_relay") || ""
  );
  const [editingRelay, setEditingRelay] = useState(false);
  const [relayDraft, setRelayDraft] = useState(personalRelay);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncLog, setSyncLog] = useState<string[]>([]);
  const [syncResult, setSyncResult] = useState<{
    pulled: number; pushed: number; failed: number; byKind: Record<number, number>;
  } | null>(null);

  // Export state
  const [exporting, setExporting] = useState(false);

  const savePersonalRelay = () => {
    let url = relayDraft.trim();
    if (url && !url.startsWith("wss://") && !url.startsWith("ws://")) {
      url = `wss://${url}`;
    }
    setPersonalRelay(url);
    localStorage.setItem("portal_personal_relay", url);
    setEditingRelay(false);
  };

  const addLog = (msg: string) => setSyncLog(prev => [...prev, `${new Date().toLocaleTimeString()} — ${msg}`]);

  // Pull all events from practice relay for this patient
  const pullEvents = (): Promise<NostrEvent[]> => {
    return new Promise((resolve) => {
      if (relay.status !== "connected") { resolve([]); return; }
      const allEvents: NostrEvent[] = [];
      const seen = new Set<string>();
      let resolved = false;

      const subId = relay.subscribe(
        { kinds: ALL_CLINICAL_KINDS, "#p": [keys.pkHex], limit: 5000 },
        (ev) => {
          if (!seen.has(ev.id)) {
            seen.add(ev.id);
            allEvents.push(ev);
          }
        },
        () => {
          // EOSE received — all events delivered
          if (!resolved) {
            resolved = true;
            relay.unsubscribe(subId);
            resolve(allEvents);
          }
        }
      );

      // Fallback timeout in case EOSE never comes
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          relay.unsubscribe(subId);
          resolve(allEvents);
        }
      }, 15000);
    });
  };

  // Push events to a relay via a temporary WebSocket
  const pushToRelay = (targetUrl: string, events: NostrEvent[]): Promise<{ pushed: number; failed: number }> => {
    return new Promise((resolve) => {
      let pushed = 0;
      let failed = 0;
      let idx = 0;
      const pending = new Map<string, ReturnType<typeof setTimeout>>();

      const ws = new WebSocket(targetUrl);

      ws.onerror = () => {
        addLog(`Connection error to ${targetUrl}`);
        resolve({ pushed, failed: events.length - pushed });
      };

      ws.onclose = () => {
        // Resolve with whatever we got
        if (idx < events.length || pending.size > 0) {
          failed += events.length - pushed - failed;
          resolve({ pushed, failed });
        }
      };

      ws.onmessage = (e) => {
        try {
          const [type, id, ok] = JSON.parse(e.data);
          if (type === "OK") {
            const timer = pending.get(id);
            if (timer) clearTimeout(timer);
            pending.delete(id);
            if (ok) pushed++;
            else failed++;

            // Send next event
            sendNext();

            // Check if done
            if (pushed + failed === events.length) {
              ws.close();
              resolve({ pushed, failed });
            }
          }
        } catch {}
      };

      const sendNext = () => {
        while (idx < events.length && pending.size < 10) {
          const ev = events[idx++];
          ws.send(JSON.stringify(["EVENT", ev]));
          const timer = setTimeout(() => {
            pending.delete(ev.id);
            failed++;
            if (pushed + failed === events.length) {
              ws.close();
              resolve({ pushed, failed });
            }
            sendNext();
          }, 8000);
          pending.set(ev.id, timer);
        }
      };

      ws.onopen = () => {
        addLog(`Connected to ${targetUrl}`);
        sendNext();
      };
    });
  };

  // Sync: pull from practice relay → push to personal relay
  const handleSync = async () => {
    if (!personalRelay) return;
    setSyncing(true);
    setSyncLog([]);
    setSyncResult(null);

    addLog(`Pulling records from ${practiceName}...`);
    const events = await pullEvents();

    if (events.length === 0) {
      addLog("No events found on practice relay.");
      setSyncing(false);
      return;
    }

    // Count by kind
    const byKind: Record<number, number> = {};
    events.forEach(ev => { byKind[ev.kind] = (byKind[ev.kind] || 0) + 1; });
    const summary = Object.entries(byKind)
      .map(([k, v]) => `${KIND_LABELS[Number(k)] || `Kind ${k}`}: ${v}`)
      .join(", ");
    addLog(`Pulled ${events.length} events (${summary})`);

    addLog(`Publishing to ${personalRelay}...`);
    const { pushed, failed } = await pushToRelay(personalRelay, events);

    addLog(`Done — ${pushed} synced, ${failed} failed`);
    setSyncResult({ pulled: events.length, pushed, failed, byKind });
    setSyncing(false);
  };

  // Sync from all connected practices
  const handleSyncAll = async () => {
    if (!personalRelay || connections.length <= 1) return;
    // For now, just sync from the active practice
    // Multi-practice sync would require connecting to each relay sequentially
    await handleSync();
  };

  // Export: pull from practice relay → download as JSON
  const handleExport = async () => {
    setExporting(true);
    setSyncLog([]);
    setSyncResult(null);

    addLog(`Pulling records from ${practiceName}...`);
    const events = await pullEvents();

    if (events.length === 0) {
      addLog("No events found to export.");
      setExporting(false);
      return;
    }

    const byKind: Record<number, number> = {};
    events.forEach(ev => { byKind[ev.kind] = (byKind[ev.kind] || 0) + 1; });

    const bundle = {
      version: 1,
      format: "nostr-ehr-export",
      exported_at: new Date().toISOString(),
      patient_npub: keys.npub || "",
      patient_pk: keys.pkHex,
      source_relay: relay.status === "connected" ? "connected" : "unknown",
      source_practice_pk: practicePk,
      source_practice_name: practiceName,
      event_count: events.length,
      kinds_summary: byKind,
      events: events.sort((a, b) => a.created_at - b.created_at),
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `health-records-${practiceName.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    const summary = Object.entries(byKind)
      .map(([k, v]) => `${KIND_LABELS[Number(k)] || `Kind ${k}`}: ${v}`)
      .join(", ");
    addLog(`Exported ${events.length} events (${summary})`);
    setSyncResult({ pulled: events.length, pushed: events.length, failed: 0, byKind });
    setExporting(false);
  };

  // FHIR R4 Export: pull, decrypt, normalize, bundle
  const handleFhirExport = async () => {
    setExporting(true);
    setSyncLog([]);
    setSyncResult(null);

    addLog(`Pulling records from ${practiceName}...`);
    const events = await pullEvents();

    if (events.length === 0) {
      addLog("No events found to export.");
      setExporting(false);
      return;
    }

    addLog(`Decrypting ${events.length} events...`);
    
    const entries: any[] = [];
    const byKind: Record<number, number> = {};
    let skipped = 0;

    // Build patient resource from demographics or keys
    const patientResource = {
      resourceType: "Patient",
      id: keys.pkHex.slice(0, 16),
      identifier: [{ system: "urn:nostr:pubkey", value: keys.pkHex }],
      ...(keys.name && keys.name !== "Patient" ? { name: [{ text: keys.name }] } : {}),
    };
    entries.push({
      fullUrl: `urn:uuid:${patientResource.id}`,
      resource: patientResource,
    });

    const patientRef = { reference: `Patient/${patientResource.id}` };

    for (const ev of events) {
      try {
        const patientContent = ev.tags.find(t => t[0] === "patient-content")?.[1];
        if (!patientContent) { skipped++; continue; }
        const plain = await portalDecrypt(patientContent, keys, practicePk);
        const fhir = JSON.parse(plain);
        if (!fhir.resourceType) { skipped++; continue; }

        // Normalize to R4-compliant structure
        const resource = normalizeFhirResource(fhir, patientRef, ev);
        if (resource) {
          byKind[ev.kind] = (byKind[ev.kind] || 0) + 1;
          entries.push({
            fullUrl: `urn:uuid:${resource.id || ev.id}`,
            resource,
          });
        }
      } catch { skipped++; }
    }

    // Build FHIR R4 Bundle
    const bundle = {
      resourceType: "Bundle",
      id: crypto.randomUUID(),
      type: "collection",
      timestamp: new Date().toISOString(),
      meta: {
        lastUpdated: new Date().toISOString(),
        source: `nostr:${practicePk}`,
        tag: [{
          system: "urn:nostr:ehr",
          code: "patient-export",
          display: `Exported from ${practiceName}`,
        }],
      },
      total: entries.length,
      entry: entries,
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fhir-bundle-${practiceName.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    const summary = Object.entries(byKind)
      .map(([k, v]) => `${KIND_LABELS[Number(k)] || `Kind ${k}`}: ${v}`)
      .join(", ");
    addLog(`FHIR export: ${entries.length} resources (${summary})${skipped > 0 ? `, ${skipped} skipped` : ""}`);
    setSyncResult({ pulled: events.length, pushed: entries.length, failed: skipped, byKind });
    setExporting(false);
  };

  return (
    <div>
      <SectionHeader title="My Data" icon="🔑" T={T} />

      {/* Identity card */}
      <div style={{ ...card(T), borderLeft: `3px solid ${T.green}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>🪪 Your Nostr Identity</div>
          <button onClick={() => { navigator.clipboard.writeText(keys.npub || ""); }} style={{
            background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 6,
            padding: "4px 10px", fontSize: 11, fontWeight: 600, color: T.textMuted,
            cursor: "pointer", fontFamily: "inherit",
          }}>📋 Copy npub</button>
        </div>
        <div style={{
          padding: "8px 12px", background: T.surfaceHi, border: `1px solid ${T.border}`,
          borderRadius: 8, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11,
          color: T.text, wordBreak: "break-all" as const, lineHeight: 1.6,
        }}>
          {keys.npub}
        </div>
        {keys.name && (
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>
            Logged in as <span style={{ color: T.text, fontWeight: 600 }}>{keys.name}</span>
          </div>
        )}
        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6, lineHeight: 1.5 }}>
          This is your public key. Share it with any Nostr-based provider to give them access to your records. Your private key (nsec) never leaves your device.
        </div>
      </div>

      {/* Explainer */}
      <div style={{ ...card(T), borderLeft: `3px solid ${T.accent}` }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 6 }}>Your Records, Your Control</div>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.7 }}>
          Every clinical record at {practiceName} is encrypted to your personal key. You can sync these records to your own relay or export them as a file — no permission needed.
        </div>
      </div>

      {/* Personal Relay Config */}
      <div style={card(T)}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: T.text }}>🌐 Personal Relay</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
          Your own Nostr relay where you store a personal copy of your health records.
        </div>

        {!editingRelay && personalRelay ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{
                flex: 1, padding: "10px 14px",
                background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8,
                fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", color: T.text,
              }}>
                {personalRelay}
              </div>
              <Btn small T={T} onClick={() => { setRelayDraft(personalRelay); setEditingRelay(true); }}>Edit</Btn>
            </div>
          </div>
        ) : !editingRelay && !personalRelay ? (
          <div>
            <div style={{
              padding: "16px", background: `${T.blue}08`, border: `1px dashed ${T.blue}40`,
              borderRadius: 8, marginBottom: 12, fontSize: 12, color: T.textMuted, lineHeight: 1.7,
            }}>
              No personal relay configured. Add one to sync your records to infrastructure you control. Your events are republished with their original signatures intact — cryptographic proof they came from your provider.
            </div>
            <Btn T={T} onClick={() => { setRelayDraft(""); setEditingRelay(true); }}>+ Add Personal Relay</Btn>
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 10 }}>
              <label style={lbl(T)}>Relay URL</label>
              <input
                value={relayDraft}
                onChange={e => setRelayDraft(e.target.value)}
                placeholder="wss://relay.example.com"
                style={{ ...input(T), fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
                onKeyDown={e => { if (e.key === "Enter") savePersonalRelay(); }}
              />
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                Must be a Nostr relay you have write access to
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn solid T={T} onClick={savePersonalRelay} disabled={!relayDraft.trim()}>Save</Btn>
              <Btn T={T} onClick={() => setEditingRelay(false)}>Cancel</Btn>
              {personalRelay && (
                <Btn T={T} col={T.red} onClick={() => {
                  setPersonalRelay("");
                  localStorage.removeItem("portal_personal_relay");
                  setEditingRelay(false);
                }}>Remove</Btn>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sync & Export Actions */}
      <div style={card(T)}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: T.text }}>📡 Sync & Export</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>
          Pull your records from {practiceName} and save them where you choose.
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <Btn solid T={T} onClick={handleSync} disabled={!personalRelay || syncing || exporting || relay.status !== "connected"}>
            {syncing ? "Syncing..." : "⇄ Sync to My Relay"}
          </Btn>
          <Btn T={T} onClick={handleExport} disabled={syncing || exporting || relay.status !== "connected"}>
            {exporting ? "Exporting..." : "📥 Export as Nostr"}
          </Btn>
          <Btn T={T} col={T.blue} onClick={handleFhirExport} disabled={syncing || exporting || relay.status !== "connected"}>
            {exporting ? "Exporting..." : "🏥 Export as FHIR"}
          </Btn>
        </div>

        {!personalRelay && (
          <div style={{ fontSize: 12, color: T.amber, marginBottom: 12 }}>
            Add a personal relay above to enable sync.
          </div>
        )}

        {relay.status !== "connected" && (
          <div style={{ fontSize: 12, color: T.red, marginBottom: 12 }}>
            Not connected to practice relay. Waiting for connection...
          </div>
        )}
      </div>

      {/* Sync Log */}
      {syncLog.length > 0 && (
        <div style={card(T)}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: T.text }}>📋 Activity Log</div>
          <div style={{
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "12px 14px", maxHeight: 200, overflowY: "auto",
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, lineHeight: 1.8,
          }}>
            {syncLog.map((line, i) => (
              <div key={i} style={{ color: line.includes("error") || line.includes("failed") ? T.red : line.includes("Done") ? T.green : T.textMuted }}>
                {line}
              </div>
            ))}
            {(syncing || exporting) && (
              <div style={{ color: T.amber, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: T.amber, animation: "portalPulse 1s ease-in-out infinite" }} />
                Working...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sync Result Summary */}
      {syncResult && (
        <div style={{ ...card(T), borderLeft: `3px solid ${syncResult.failed === 0 ? T.green : T.amber}` }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: syncResult.failed === 0 ? T.green : T.amber }}>
            {syncResult.failed === 0 ? "✓ Complete" : "⚠ Completed with errors"}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div style={{ background: T.surfaceHi, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{syncResult.pulled}</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>Pulled</div>
            </div>
            <div style={{ background: T.surfaceHi, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: T.green }}>{syncResult.pushed}</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>Saved</div>
            </div>
            {syncResult.failed > 0 && (
              <div style={{ background: T.surfaceHi, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: T.red }}>{syncResult.failed}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>Failed</div>
              </div>
            )}
          </div>

          {/* Breakdown by kind */}
          <div style={{ fontSize: 12, color: T.textMuted }}>
            {Object.entries(syncResult.byKind).map(([kind, count]) => (
              <div key={kind} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${T.border}` }}>
                <span>{KIND_LABELS[Number(kind)] || `Kind ${kind}`}</span>
                <span style={{ fontWeight: 600, color: T.text }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Privacy note */}
      <div style={{ padding: "14px 16px", background: `${T.accent}10`, border: `1px solid ${T.accent}25`, borderRadius: 8, fontSize: 12, color: T.textMuted, lineHeight: 1.7, marginTop: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 4, color: T.accent }}>🔐 How This Works</div>
        Events are copied as-is with their original cryptographic signatures. This means you have verifiable proof each record was authored by {practiceName}. Your personal relay stores the encrypted events — you decrypt them with your key, just like here.
      </div>
    </div>
  );
}

// ─── Main Portal ──────────────────────────────────────────────────────────────
export default function PatientPortal() {
  const [connections, setConnections] = useState<PracticeConnection[]>(() => loadConnections());
  const [activeConnection, setActiveConnection] = useState<PracticeConnection | null>(null);
  const [keys, setKeys] = useState<PatientKeys | null>(null);
  const [tab, setTab] = useState<Tab>("records");
  const [dark, setDark] = useState(true);
  const [videoCall, setVideoCall] = useState<{appointmentId:number}|null>(null);
  const [showPracticeSwitcher, setShowPracticeSwitcher] = useState(false);
  const [guardianChildren, setGuardianChildren] = useState<GuardianChild[]>([]);
  const [activeChild, setActiveChild] = useState<GuardianChild|null>(null);
  const [showPatientSwitcher, setShowPatientSwitcher] = useState(false);
  const [billingModel, setBillingModel] = useState<string|null>(null);

  // Fetch billing model for tab visibility (messages hidden for per-visit)
  useEffect(() => {
    if (!keys?.npub || !activeConnection?.calendarApi) return;
    fetch(`${activeConnection.calendarApi}/api/patients/${encodeURIComponent(keys.npub)}/booking-rules`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.billingModel) setBillingModel(data.billingModel); })
      .catch(() => {});
  }, [keys?.npub, activeConnection?.calendarApi]);

  // PIN auth state
  const [pinCredential, setPinCredential] = useState<StoredCredential | null>(null);
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<PatientKeys | null>(null); // keys waiting for PIN setup decision
  const [prfCredential, setPrfCredential] = useState<StoredCredential | null>(null); // WebAuthn PRF credential found
  const [showPasskeySetup, setShowPasskeySetup] = useState(false); // show passkey registration modal

  const relay = useRelay(activeConnection?.relay || connections[0]?.relay || "wss://localhost");
  const T = dark ? DARK : LIGHT;

  // Fetch guardian grants (kind 2104) to discover children this user can view
  useEffect(() => {
    if (!keys || !activeConnection || relay.status !== "connected") return;
    const grants: NostrEvent[] = [];
    const subId = relay.subscribe(
      { kinds: [STAFF_KINDS.GuardianGrant], "#p": [keys.pkHex], limit: 50 },
      (ev: NostrEvent) => { if (!grants.find(g => g.id === ev.id)) grants.push(ev); }
    );
    const timer = setTimeout(async () => {
      relay.unsubscribe(subId);
      const children: GuardianChild[] = [];
      for (const ev of grants) {
        try {
          const sharedX = getSharedSecret(keys.sk, ev.pubkey); // practice signed it
          const plain = await nip44Decrypt(ev.content, sharedX);
          const payload = JSON.parse(plain);
          if (payload.childPatientId && payload.childPkHex && payload.childSharedSecret) {
            const existing = children.findIndex(c => c.childPatientId === payload.childPatientId);
            const child: GuardianChild = {
              childPatientId: payload.childPatientId,
              childPkHex: payload.childPkHex,
              childSharedSecret: fromHex(payload.childSharedSecret),
              childName: payload.childName || "Child",
            };
            if (existing >= 0) children[existing] = child;
            else children.push(child);
          }
        } catch (e) {
          console.warn("[Guardian] Failed to decrypt grant:", e);
        }
      }
      if (children.length > 0) {
        console.log(`[Guardian] Found ${children.length} child patient(s)`);
        setGuardianChildren(children);
      }
    }, 2500);
    return () => { clearTimeout(timer); try { relay.unsubscribe(subId); } catch {} };
  }, [keys?.pkHex, activeConnection?.id, relay.status]);

  const toggleTheme = () => {
    setDark(d => !d);
    localStorage.setItem("portal_theme", dark ? "light" : "dark");
  };

  const handleSelectPractice = (conn: PracticeConnection) => {
    setActiveConnection(conn);
    localStorage.setItem("portal_active_connection", conn.id);
  };

  const handleAddConnection = (conn: PracticeConnection) => {
    const updated = [...connections, conn];
    setConnections(updated);
    saveConnections(updated);
  };

  const handleRemoveConnection = (id: string) => {
    const updated = connections.filter(c => c.id !== id);
    setConnections(updated);
    saveConnections(updated);
    if (activeConnection?.id === id) {
      setActiveConnection(null);
      setKeys(null);
    }
  };

  // Called after successful nsec login — check if we should offer passkey or PIN setup
  const handleLogin = (k: PatientKeys) => {
    if (!activeConnection) return;
    // Store non-sensitive metadata
    if (k.npub) localStorage.setItem("portal_patient_npub", k.npub);
    if (k.name && k.name !== "Patient") localStorage.setItem("portal_patient_name", k.name);
    localStorage.setItem("portal_active_connection", activeConnection.id);
    // Remove any old plaintext sk if present
    localStorage.removeItem("portal_patient_sk");

    // NIP-07 users don't need PIN/passkey — extension is their authenticator
    if (k.nip07) {
      setKeys(k);
      return;
    }
    const credId = credentialId(k.pkHex, activeConnection.id);
    loadCredential(credId).then(existing => {
      if (existing?.hasPrf) {
        // Passkey already set up — just log in directly
        setKeys(k);
      } else if (isPrfLikelySupported()) {
        // Browser supports PRF — offer passkey setup (even if PIN exists)
        // If they already have a PIN they can skip, but let's give them the option
        setPendingKeys(k);
        setShowPasskeySetup(true);
      } else if (existing?.hasPin) {
        // Has PIN, no PRF support — just log in
        setKeys(k);
      } else {
        // No PRF support, no PIN — offer PIN setup
        setPendingKeys(k);
        setShowPinSetup(true);
      }
    }).catch(() => {
      setKeys(k); // fallback
    });
  };

  // User confirmed passkey registration from PasskeySetupModal
  const handlePasskeyRegister = async (): Promise<boolean> => {
    if (!pendingKeys || !activeConnection) return false;
    const result = await registerPasskey(
      pendingKeys.pkHex,
      pendingKeys.npub || "",
      pendingKeys.name || "Patient"
    );
    if (!result) return false; // PRF not supported
    const { encryptedSk, iv } = await encryptSkWithPrf(pendingKeys.sk, result.prfOutput);
    const cred: StoredCredential = {
      id: credentialId(pendingKeys.pkHex, activeConnection.id),
      encryptedSk, iv,
      salt: "", // unused for PRF — salt field is for PBKDF2/PIN only
      pkHex: pendingKeys.pkHex,
      npub: pendingKeys.npub,
      name: pendingKeys.name,
      practiceId: activeConnection.id,
      createdAt: Date.now(),
      hasPin: false,
      hasPrf: true,
      webauthnCredentialId: result.credentialId,
      webauthnPrfSalt: result.prfSalt,
    };
    await saveCredential(cred);
    return true;
  };

  // PasskeySetupModal: user chose "Use a PIN instead"
  const handlePasskeySkipToPin = () => {
    setShowPasskeySetup(false);
    if (!pendingKeys || !activeConnection) return;
    // If they already have a PIN, just log in — don't make them set it again
    const credId = credentialId(pendingKeys.pkHex, activeConnection.id);
    loadCredential(credId).then(existing => {
      if (existing?.hasPin) {
        setKeys(pendingKeys);
        setPendingKeys(null);
      } else {
        setShowPinSetup(true);
      }
    }).catch(() => {
      setShowPinSetup(true);
    });
  };

  // PasskeySetupModal: user chose "Skip for now" or passkey succeeded
  const handlePasskeySkipAll = () => {
    setShowPasskeySetup(false);
    if (pendingKeys) {
      setKeys(pendingKeys);
      setPendingKeys(null);
    }
  };

  // User confirmed a PIN after nsec login
  const handlePinSet = async (pin: string) => {
    if (!pendingKeys || !activeConnection) return;
    const { encryptedSk, iv, salt } = await encryptSk(pendingKeys.sk, pin);
    const cred: StoredCredential = {
      id: credentialId(pendingKeys.pkHex, activeConnection.id),
      encryptedSk, iv, salt,
      pkHex: pendingKeys.pkHex,
      npub: pendingKeys.npub,
      name: pendingKeys.name,
      practiceId: activeConnection.id,
      createdAt: Date.now(),
      hasPin: true,
    };
    await saveCredential(cred);
    setShowPinSetup(false);
    setKeys(pendingKeys);
    setPendingKeys(null);
  };

  // User skipped PIN setup — still log them in, save credential without PIN so we don't ask again this session
  const handlePinSkip = () => {
    if (!pendingKeys || !activeConnection) return;
    setShowPinSetup(false);
    setKeys(pendingKeys);
    setPendingKeys(null);
  };

  const handleLogout = () => {
    setKeys(null);
    setActiveConnection(null);
    setPinCredential(null);
    setPrfCredential(null);
    setShowPasskeySetup(false);
    setPendingKeys(null);
    localStorage.removeItem("portal_patient_sk");
    localStorage.removeItem("portal_patient_npub");
    localStorage.removeItem("portal_patient_name");
    localStorage.removeItem("portal_active_connection");
  };

  const handleSwitchPractice = (conn: PracticeConnection) => {
    setActiveConnection(conn);
    localStorage.setItem("portal_active_connection", conn.id);
    setTab("records");
    if (conn.billingApi && keys?.npub) {
      fetch(`${conn.billingApi}/api/patients/${encodeURIComponent(keys.npub)}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.name) {
            localStorage.setItem(`portal_name_${conn.id}_${keys.npub}`, data.name);
            setKeys(k => k ? { ...k, name: data.name } : k);
          }
        }).catch(() => {});
    }
  };

  // Auto-login: check for saved credentials (passkey or PIN)
  useEffect(() => {
    const savedTheme = localStorage.getItem("portal_theme");
    if (savedTheme) setDark(savedTheme === "dark");

    const activeId = localStorage.getItem("portal_active_connection");
    if (!activeId) return;
    const conn = connections.find(c => c.id === activeId);
    if (!conn) return;

    setActiveConnection(conn);

    // Check IndexedDB for passkey (PRF) or PIN credentials for this practice
    listCredentials().then(creds => {
      // Prefer passkey (PRF) over PIN
      const prfMatch = creds.find(c => c.practiceId === activeId && c.hasPrf);
      if (prfMatch) {
        setPrfCredential(prfMatch);
        return;
      }
      const match = creds.find(c => c.practiceId === activeId && c.hasPin);
      if (match) {
        setPinCredential(match);
        return;
      }
    }).catch(() => {});
  }, []);

  // Passkey setup modal (shown over pending login — before PIN setup)
  if (showPasskeySetup && pendingKeys) {
    return (
      <>
        <div style={{ filter: "blur(4px)", pointerEvents: "none", userSelect: "none" }}>
          <div style={{ minHeight: "100vh", background: T.bg }} />
        </div>
        <PasskeySetupModal
          T={T}
          onRegister={handlePasskeyRegister}
          onSkipToPin={handlePasskeySkipToPin}
          onSkipAll={handlePasskeySkipAll}
        />
      </>
    );
  }

  // PIN setup modal (shown over pending login)
  if (showPinSetup && pendingKeys) {
    return (
      <>
        {/* Render logged-in state underneath so transition is instant after PIN set */}
        <div style={{ filter: "blur(4px)", pointerEvents: "none", userSelect: "none" }}>
          {/* placeholder — will be replaced by portal once PIN is set */}
          <div style={{ minHeight: "100vh", background: T.bg }} />
        </div>
        <PinSetupModal T={T} onSetPin={handlePinSet} onSkip={handlePinSkip} />
      </>
    );
  }

  // Not logged in — show practice picker or unified login
  if (!keys || !activeConnection) {
    if (activeConnection && !keys) {
      return <UnifiedLoginScreen
        connection={activeConnection}
        onLogin={handleLogin}
        onBack={() => { setActiveConnection(null); setPinCredential(null); setPrfCredential(null); }}
        dark={dark}
        toggleTheme={toggleTheme}
        storedCredential={prfCredential || pinCredential}
      />;
    }
    return <PracticePicker
      connections={connections}
      onSelect={handleSelectPractice}
      onAdd={handleAddConnection}
      onRemove={handleRemoveConnection}
      dark={dark}
      toggleTheme={toggleTheme}
    />;
  }

  // Build viewing keys — either self or guardian-viewing-child
  const viewingKeys: PatientKeys = activeChild ? {
    ...keys,
    pkHex: activeChild.childPkHex,
    npub: npubEncode(fromHex(activeChild.childPkHex)),
    name: activeChild.childName,
    overrideSharedSecret: activeChild.childSharedSecret,
  } : keys;
  const viewingName = activeChild ? activeChild.childName : (keys.name && keys.name !== "Patient" ? keys.name : "My Records");

  // Determine which tabs to show based on connection capabilities
  const hasCal = !!activeConnection.calendarApi;
  const tabs: [Tab, string, string][] = [
    ["records", "📋", "Visits"],
    ["vitals", "📈", "Growth"],
    ["meds", "💊", "Meds"],
    ["immunizations", "💉", "Vaccines"],
    ...(billingModel !== "per-visit" ? [["messages" as Tab, "💬", "Messages"] as [Tab, string, string]] : []),
    ...(hasCal ? [["appointments" as Tab, "📅", "Schedule"] as [Tab, string, string]] : []),
    ["mydata", "🔑", "My Data"],
  ];

  const relayColor = relay.status === "connected" ? T.green : relay.status === "connecting" ? T.amber : T.textMuted;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'DM Sans','IBM Plex Sans',system-ui,sans-serif", color: T.text, transition: "background 0.3s, color 0.3s" }}>

      {/* Header */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 20px", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", height: 58 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${activeChild ? T.blue : T.accent}, ${activeChild ? "#60a5fa" : T.accentLt})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#fff", fontFamily: "inherit", boxShadow: `0 2px 10px ${T.accent}35` }}>
              {viewingName[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: T.text, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: 6 }}>
                {viewingName}
                {guardianChildren.length > 0 && (
                  <button onClick={() => setShowPatientSwitcher(s => !s)} style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 600, color: T.textMuted, cursor: "pointer", fontFamily: "inherit" }}>
                    ▾ Switch
                  </button>
                )}
              </div>
              <div onClick={connections.length > 1 ? () => setShowPracticeSwitcher(s => !s) : undefined}
                style={{ fontSize: 11, color: relayColor, display: "flex", alignItems: "center", gap: 4, cursor: connections.length > 1 ? "pointer" : "default" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: relayColor, display: "inline-block",
                  boxShadow: relay.status === "connected" ? `0 0 5px ${T.green}` : "none",
                  animation: relay.status === "connecting" ? "portalPulse 1s ease-in-out infinite" : "none"
                }} />
                {relay.status === "connected" ? activeConnection.name : relay.status === "connecting" ? "Connecting..." : "Reconnecting..."}
                {connections.length > 1 && <span style={{ fontSize: 9, marginLeft: 2 }}>▾</span>}
                <style>{`@keyframes portalPulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
              </div>
            </div>
            {/* Practice switcher dropdown */}
            {showPracticeSwitcher && connections.length > 1 && (
              <>
                <div onClick={() => setShowPracticeSwitcher(false)} style={{ position: "fixed", inset: 0, zIndex: 150 }} />
                <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 8, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.3)", zIndex: 151, minWidth: 240, overflow: "hidden" }}>
                  <div style={{ padding: "8px 12px", fontSize: 10, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, borderBottom: `1px solid ${T.border}` }}>
                    Switch Practice
                  </div>
                  {connections.map(conn => (
                    <div key={conn.id} onClick={() => { handleSwitchPractice(conn); setShowPracticeSwitcher(false); }}
                      style={{
                        padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                        background: conn.id === activeConnection.id ? `${T.accent}10` : "transparent",
                        borderLeft: conn.id === activeConnection.id ? `3px solid ${T.accent}` : "3px solid transparent",
                      }}
                      onMouseEnter={e => { if (conn.id !== activeConnection.id) (e.currentTarget as HTMLElement).style.background = T.surfaceHi; }}
                      onMouseLeave={e => { if (conn.id !== activeConnection.id) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: `${T.accent}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: T.accent, flexShrink: 0 }}>
                        {conn.name[0].toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{conn.name}</div>
                        <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {conn.relay.replace("wss://", "")}
                        </div>
                      </div>
                      {conn.id === activeConnection.id && <span style={{ color: T.green, fontSize: 12 }}>●</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
            {/* Patient switcher (guardian → children) */}
            {showPatientSwitcher && guardianChildren.length > 0 && (
              <>
                <div onClick={() => setShowPatientSwitcher(false)} style={{ position: "fixed", inset: 0, zIndex: 150 }} />
                <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 8, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.3)", zIndex: 151, minWidth: 220, overflow: "hidden" }}>
                  <div style={{ padding: "8px 12px", fontSize: 10, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, borderBottom: `1px solid ${T.border}` }}>
                    Switch Patient
                  </div>
                  <div onClick={() => { setActiveChild(null); setShowPatientSwitcher(false); }}
                    style={{ padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: !activeChild ? `${T.accent}10` : "transparent", borderLeft: !activeChild ? `3px solid ${T.accent}` : "3px solid transparent" }}
                    onMouseEnter={e => { if (activeChild) (e.currentTarget as HTMLElement).style.background = T.surfaceHi; }}
                    onMouseLeave={e => { if (activeChild) (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: `${T.accent}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: T.accent, flexShrink: 0 }}>
                      {(keys.name && keys.name !== "Patient") ? keys.name[0].toUpperCase() : "P"}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>My Records</div>
                    {!activeChild && <span style={{ color: T.green, fontSize: 12, marginLeft: "auto" }}>●</span>}
                  </div>
                  {guardianChildren.map(child => (
                    <div key={child.childPatientId} onClick={() => { setActiveChild(child); setShowPatientSwitcher(false); }}
                      style={{ padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: activeChild?.childPatientId === child.childPatientId ? `${T.blue}10` : "transparent", borderLeft: activeChild?.childPatientId === child.childPatientId ? `3px solid ${T.blue}` : "3px solid transparent" }}
                      onMouseEnter={e => { if (activeChild?.childPatientId !== child.childPatientId) (e.currentTarget as HTMLElement).style.background = T.surfaceHi; }}
                      onMouseLeave={e => { if (activeChild?.childPatientId !== child.childPatientId) (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: `${T.blue}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: T.blue, flexShrink: 0 }}>
                        {child.childName[0].toUpperCase()}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{child.childName}</div>
                      {activeChild?.childPatientId === child.childPatientId && <span style={{ color: T.green, fontSize: 12, marginLeft: "auto" }}>●</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={toggleTheme} style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 9px", cursor: "pointer", color: T.textMuted, fontSize: 14, lineHeight: 1 }}>
              {dark ? "☀️" : "🌙"}
            </button>
            <button onClick={handleLogout} style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 14px", color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>
              Sign Out
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", overflowX: "auto", scrollbarWidth: "none" }}>
          {tabs.map(([id, icon, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: "10px 16px", border: "none", cursor: "pointer", fontFamily: "inherit",
              background: "transparent",
              borderBottom: tab === id ? `2px solid ${T.accent}` : "2px solid transparent",
              color: tab === id ? T.accent : T.textMuted,
              fontSize: 12, fontWeight: tab === id ? 700 : 400, whiteSpace: "nowrap",
              transition: "all 0.15s",
            }}>
              {icon} {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 20px" }}>
        {tab === "records"       && <VisitHistory      keys={viewingKeys} relay={relay} practicePk={activeConnection.practicePk} practiceName={activeConnection.name} T={T} />}
        {tab === "vitals"        && <VitalsView        keys={viewingKeys} relay={relay} practicePk={activeConnection.practicePk} T={T} />}
        {tab === "meds"          && <MedicationsView   keys={viewingKeys} relay={relay} practicePk={activeConnection.practicePk} T={T} />}
        {tab === "immunizations" && <ImmunizationsView keys={viewingKeys} relay={relay} practicePk={activeConnection.practicePk} practiceName={activeConnection.name} T={T} />}
        {tab === "messages"      && <MessagingView     keys={viewingKeys} relay={relay} practicePk={activeConnection.practicePk} practiceName={activeConnection.name} T={T} guardianPkHex={activeChild ? toHex(getPublicKey(keys.sk)) : undefined} />}
        {tab === "appointments"  && <AppointmentsView  keys={viewingKeys} calendarApi={activeConnection.calendarApi} T={T} onJoinVideo={(id:number)=>setVideoCall({appointmentId:id})} />}
        {tab === "mydata"        && <MyDataView        keys={keys} relay={relay} practicePk={activeConnection.practicePk} practiceName={activeConnection.name} connections={connections} T={T} />}
      </div>

      {/* Video Call Overlay */}
      {videoCall && keys && (
        <VideoRoom
          appointmentId={videoCall.appointmentId}
          role="patient"
          sk={keys.sk}
          localPkHex={keys.pkHex}
          remotePkHex={activeConnection.practicePk}
          relay={relay}
          remoteName={activeConnection.name}
          onClose={() => setVideoCall(null)}
          T={T}
        />
      )}
    </div>
  );
}
