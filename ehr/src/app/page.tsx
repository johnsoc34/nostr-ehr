"use client";
import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import {
  generateSecretKey, getPublicKey, getSharedSecret, buildAndSignEvent,
  npubEncode, nsecEncode, nsecToBytes, toHex, fromHex, FHIR_KINDS, verifyEvent, type NostrEvent,
  STAFF_KINDS, ROLE_PERMISSIONS, hasPermission, getAuthorizedPubkeys, isValidRosterEvent, isValidGrantEvent,
  type StaffRole, type StaffPermission, type StaffMember, type StaffRosterPayload,
  type PracticeKeyGrantPayload, type PatientKeyGrantPayload, type StaffSession
} from "../lib/nostr";
import { buildEncounter, buildMedicationRequest, buildAllergyIntolerance, buildImmunization,
         buildServiceRequest, buildDiagnosticReport, buildRxOrder, buildCondition, buildDocumentReference } from "../lib/fhir";
import { nip44Encrypt, nip44Decrypt } from "../lib/nip44";
import { dualEncrypt, dualEncryptWithSecrets, dualDecryptWithSecret, buildDualEncryptedTags } from "../lib/dual-encryption";
import { loadPatients, savePatients, addPatient, addPatientByNpub, updatePatient, clearStoredNsec,
         ageFromDob, type Patient, type PatientCreationResult } from "../lib/patients";
import { getWHOWeightCurves, getCDCWeightCurves } from "../lib/growth";
import { PEDIATRIC_DIAGNOSES } from "../lib/terminology";
import { cacheEvent, cacheEvents, getCachedEvents, getCachedEventsByKind, getLastSync, setLastSync, getCacheStats, clearCache, queueEvent, getQueuedEvents, removeQueuedEvent, getQueueCount, type CachedEvent, type QueuedEvent } from "../lib/cache";
import { generateSchoolExcuse, generateImmunizationRecord, generateGrowthChart, generateSportsPhysical, generateChildCareForm, generateKindergartenForm, type SchoolExcuseOpts, type ImmunizationEntry, type GrowthMeasurement, type GrowthChartCurvePoint, type GrowthChartDot, type SportsPhysicalData, type ChildCareFormData, type KindergartenFormData } from "../lib/pdf";
import { evaluateImmunizations, evaluateWellCheck, type ImmunizationRecord, type VaccineEvaluation, type WellCheckEvaluation } from "../lib/cds";
import VideoRoom from "../lib/VideoRoom";
import { TelehealthSession, TELEHEALTH_KINDS } from "../lib/telehealth";

const AGENT_KINDS = { ServiceAgentGrant: 2103 } as const;


// ─── Practice Configuration (from environment variables) ─────────────────────
// Electron: read config synchronously via preload. Falls back to env vars.
const _ec = (typeof window !== "undefined" && (window as any).__NOSTREHR_CONFIG__) || {};
const RELAY_URL = _ec.relayUrl || process.env.NEXT_PUBLIC_RELAY_URL || "wss://relay.example.com";
const BLOSSOM_URL = _ec.blossomUrl || process.env.NEXT_PUBLIC_BLOSSOM_URL || "";
let PRACTICE_PUBKEY = _ec.practicePubkey || process.env.NEXT_PUBLIC_PRACTICE_PUBKEY || (typeof window !== "undefined" && localStorage.getItem("__nostrehr_practice_pk__")) || "";
const PRACTICE_NAME = _ec.practiceName || process.env.NEXT_PUBLIC_PRACTICE_NAME || "My Practice";
const BILLING_URL = _ec.billingUrl || process.env.NEXT_PUBLIC_BILLING_URL || "";
const CALENDAR_URL = _ec.calendarUrl || process.env.NEXT_PUBLIC_CALENDAR_URL || "";
const PORTAL_URL = _ec.portalUrl || process.env.NEXT_PUBLIC_PORTAL_URL || "";
const TURN_API_KEY = _ec.turnApiKey || process.env.NEXT_PUBLIC_TURN_API_KEY || "";

interface Keypair { sk:Uint8Array; pkHex:string; npub:string; nsec:string; }
interface DecryptedEncounter { event:NostrEvent; fhir:any; note:string; chief:string; }

// Multi-user context: provides staff session to all child components without prop drilling
const StaffCtx = createContext<StaffSession|null>(null);
function useStaffSession() { return useContext(StaffCtx); }

// Module-level ref for cachedLoad (async functions can't use React hooks)
let _activeStaffSession: StaffSession|null = null;

/** Permission check: practice owner can do everything, staff checks session permissions */
function canDo(perm: StaffPermission): boolean {
  if (!_activeStaffSession) return true; // practice owner
  return _activeStaffSession.permissions.includes(perm);
}

/** Publish a dual-encrypted clinical event. Handles both practice owner and staff paths.
 *  Staff: encrypts with precomputed X₁/X₂, signs with staff key, adds authored-by tag.
 *  Practice owner: uses dualEncrypt with practice SK as before.
 *  Returns the signed event on success, null on failure. */
async function publishClinicalEvent(opts: {
  kind: number;
  plaintext: string;
  patientId: string;
  patientPkHex: string;
  fhirType: string;
  keys: Keypair;
  relay: ReturnType<typeof useRelay>;
  extraTags?: string[][];
}): Promise<NostrEvent|null> {
  const { kind, plaintext, patientId, patientPkHex, fhirType, keys, relay, extraTags=[] } = opts;
  const ss = _activeStaffSession;
  let practiceEncrypted: string;
  let patientEncrypted: string;
  let practicePk: string;

  if (ss) {
    // Staff: use precomputed secrets
    const patientSecret = ss.patientSecrets.get(patientId);
    if (!patientSecret) { console.error("[publish] No patient secret for", patientId); return null; }
    const result = await dualEncryptWithSecrets(plaintext, ss.practiceSharedSecret, patientSecret);
    practiceEncrypted = result.practiceEncrypted;
    patientEncrypted = result.patientEncrypted;
    practicePk = ss.practicePkHex;
  } else {
    // Practice owner: derive secrets on the fly
    const result = await dualEncrypt(plaintext, keys.sk, keys.pkHex, patientPkHex);
    practiceEncrypted = result.practiceEncrypted;
    patientEncrypted = result.patientEncrypted;
    practicePk = keys.pkHex;
  }

  const tags = buildDualEncryptedTags(practicePk, patientPkHex, patientEncrypted, fhirType, patientId);
  // Staff attribution tag
  if (ss) tags.push(["authored-by", ss.staffPkHex, ss.staffName]);
  // Extra tags (e.g. category, status markers, ["e", origId] for append-only)
  for (const t of extraTags) tags.push(t);

  const event = await buildAndSignEvent(kind, practiceEncrypted, tags, keys.sk);
  const ok = await relay.publishOrQueue(event, patientId, plaintext);
  return ok ? event : null;
}

/** Publish patient key grants (kind 2100) for a new patient to all active staff.
 *  Called during patient creation so staff can immediately access the new patient.
 *  Only works when logged in as practice owner (needs practice SK for ECDH). */
async function publishPatientGrantsForStaff(
  patient: {id:string; npub?:string},
  keys: Keypair,
  relay: ReturnType<typeof useRelay>,
){
  if(!patient.npub) return;
  try{
    const patientPkHex=npubToHex(patient.npub);
    // Fetch current roster from relay
    const rosterEvents:NostrEvent[]=[];
    await new Promise<void>(resolve=>{
      const subId=relay.subscribe(
        {kinds:[STAFF_KINDS.StaffRoster],authors:[keys.pkHex],limit:10},
        (ev:NostrEvent)=>rosterEvents.push(ev),
        ()=>{relay.unsubscribe(subId);resolve();}
      );
      setTimeout(()=>{try{relay.unsubscribe(subId);}catch{}resolve();},5000);
    });
    if(rosterEvents.length===0) return; // no staff configured
    const latest=rosterEvents.sort((a,b)=>b.created_at-a.created_at)[0];
    const selfSharedX=getSharedSecret(keys.sk,keys.pkHex);
    const rosterPlain=await nip44Decrypt(latest.content,selfSharedX);
    const rosterData:StaffRosterPayload=JSON.parse(rosterPlain);
    const activeStaff=rosterData.staff.filter(s=>!s.revokedAt);
    if(activeStaff.length===0) return;

    const patientSharedSecret=toHex(getSharedSecret(keys.sk,patientPkHex));
    let granted=0;
    for(const staff of activeStaff){
      try{
        const staffSharedX=getSharedSecret(keys.sk,staff.pkHex);
        const payload:PatientKeyGrantPayload={patientId:patient.id,patientPkHex,patientSharedSecret};
        const encrypted=await nip44Encrypt(JSON.stringify(payload),staffSharedX);
        const tags=[["p",staff.pkHex],["pt",patient.id],["grant","patient-secret"]];
        const event=await buildAndSignEvent(STAFF_KINDS.PatientKeyGrant,encrypted,tags,keys.sk);
        if(await relay.publish(event)) granted++;
      }catch(e){console.error(`[Grant] Failed for staff ${staff.name}:`,e);}
    }
    if(granted>0) console.log(`[Grant] Published ${granted} patient grants for ${patient.id} to ${activeStaff.length} staff`);
  }catch(e){console.error("[Grant] Failed to publish patient grants:",e);}
}

// Auto-publish a kind 2100 PatientKeyGrant to any active FHIR reader service agent.
// Called whenever a new patient is created so the FHIR API can immediately decrypt their data.
async function publishPatientGrantForFhirAgent(
  patient: {id:string; npub?:string},
  keys: Keypair,
  relay: ReturnType<typeof useRelay>,
){
  if(!patient.npub) return;
  try{
    // Find active FHIR reader agent from kind 2103 events
    const agentEvents:NostrEvent[]=[];
    await new Promise<void>(resolve=>{
      const subId=relay.subscribe(
        {kinds:[AGENT_KINDS.ServiceAgentGrant],authors:[keys.pkHex],"#service":["fhir-reader"],limit:5},
        (ev:NostrEvent)=>agentEvents.push(ev),
        ()=>{relay.unsubscribe(subId);resolve();}
      );
      setTimeout(()=>{try{relay.unsubscribe(subId);}catch{}resolve();},3000);
    });
    if(agentEvents.length===0) return; // no FHIR agent configured

    // Get the latest grant to find the agent pubkey
    const latest=agentEvents.sort((a,b)=>b.created_at-a.created_at)[0];
    const agentPkHex=latest.tags.find(t=>t[0]==="p")?.[1];
    if(!agentPkHex) return;

    const patientPkHex=npubToHex(patient.npub);
    const agentSharedX=getSharedSecret(keys.sk,agentPkHex);
    const patientSharedSecret=toHex(getSharedSecret(keys.sk,patientPkHex));
    const payload={patientId:patient.id,patientPkHex,patientSharedSecret};
    const encrypted=await nip44Encrypt(JSON.stringify(payload),agentSharedX);
    const tags=[["p",agentPkHex],["pt",patient.id],["grant","patient-secret"]];
    const event=await buildAndSignEvent(STAFF_KINDS.PatientKeyGrant,encrypted,tags,keys.sk);
    if(await relay.publish(event)){
      console.log(`[Grant] FHIR agent grant published for patient ${patient.id}`);
    }
  }catch(e){console.error("[Grant] Failed to publish FHIR agent grant:",e);}
}

// Publish a kind 2104 GuardianGrant — gives a guardian (parent) decryption access
// to a child patient's records. The grant contains the child's X₂ shared secret
// encrypted to the guardian's pubkey. The guardian can then decrypt patient-content
// tags on the child's clinical events from the portal.
async function publishGuardianGrant(
  child: { id: string; name: string; npub?: string },
  guardianPkHex: string,
  keys: Keypair,
  relay: ReturnType<typeof useRelay>,
): Promise<boolean> {
  if (!child.npub) return false;
  try {
    const childPkHex = npubToHex(child.npub);
    const childSharedSecret = toHex(getSharedSecret(keys.sk, childPkHex));
    const guardianSharedX = getSharedSecret(keys.sk, guardianPkHex);
 
    const payload: import("../lib/nostr").GuardianGrantPayload = {
      childPatientId: child.id,
      childPkHex,
      childSharedSecret,
      childName: child.name,
      guardianPkHex,
    };
 
    const encrypted = await nip44Encrypt(JSON.stringify(payload), guardianSharedX);
    const tags = [
      ["p", guardianPkHex],           // so portal can query: {kinds:[2104], #p:[guardianPk]}
      ["pt", child.id],               // child patient ID
      ["child-p", childPkHex],        // child pubkey for reference
      ["grant", "guardian-access"],    // grant type marker
    ];
 
    const event = await buildAndSignEvent(STAFF_KINDS.GuardianGrant, encrypted, tags, keys.sk);
    const ok = await relay.publish(event);
    if (ok) console.log(`[Guardian] Published grant: guardian ${guardianPkHex.slice(0,8)}... → child ${child.name} (${child.id})`);
    return ok;
  } catch (e) {
    console.error("[Guardian] Failed to publish grant:", e);
    return false;
  }
}

function npubToHex(npub: string): string {
  if (!npub || !npub.startsWith('npub')) throw new Error('Invalid npub');
  const data = npub.slice(5);
  const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
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

// ─── Styles ───────────────────────────────────────────────────────────────────
// ─── Theme System ────────────────────────────────────────────────────────────
const THEME_CSS = `
:root {
  --bg-app: #0f172a;
  --bg-card: #1e293b;
  --bg-input: #0f172a;
  --bg-deep: #0a1628;
  --bg-inset: #0c1a2e;
  --bg-hover: #162032;
  --bg-sidebar: #0f172a;
  --bg-header: #162032;
  --bg-tab-bar: #0f172a;
  --bg-modal: rgba(30,41,59,0.95);
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --text-label: #475569;
  --text-faint: #334155;
  --border: #334155;
  --border-subtle: #1e293b;
  --border-accent: #1e3a5f;
  --tab-active: #e0f2fe;
  --shadow: rgba(0,0,0,0.3);
  --shadow-heavy: rgba(0,0,0,0.5);
  --overlay: rgba(0,0,0,0.5);
  --bg-sent: #0c2240;
  --border-sent: #1e4a7f;
  --text-sender: #7dd3fc;
  --tint-green: #052e16;
  --tint-green-border: #166534;
  --tint-red: #1c0a0a;
  --tint-red-border: #991b1b;
  --tint-amber: #1c1408;
  --tint-amber-border: #78350f;
  --tint-purple: #1e1040;
  --tint-purple-border: #7c3aed;
  --accent-green: #4ade80;
  --accent-green-text: #4ade80;
  --accent-amber-text: #fde68a;
  --accent-amber-sub: #fbbf24;
  --accent-red-text: #fca5a5;
  --accent-red-sub: #fecaca;
  --grid-major: #1e3a5f;
  --grid-minor: #152238;
  --chart-label: #475569;
  --accent-purple: #c4b5fd;
  --accent-purple-sub: #a78bfa;
  --accent-blue: #7dd3fc;
  --accent-blue-sub: #38bdf8;
  --tab-selected-bg: #1e3a5f;
  --tab-selected-text: #7dd3fc;
}
html.light {
  --bg-app: #f1f5f9;
  --bg-card: #ffffff;
  --bg-input: #f1f5f9;
  --bg-deep: #e8ecf1;
  --bg-inset: #eef2f7;
  --bg-hover: #e2e8f0;
  --bg-sidebar: #ffffff;
  --bg-header: #f8fafc;
  --bg-tab-bar: #ffffff;
  --bg-modal: rgba(255,255,255,0.95);
  --text-primary: #0f172a;
  --text-secondary: #334155;
  --text-muted: #475569;
  --text-label: #64748b;
  --text-faint: #94a3b8;
  --border: #cbd5e1;
  --border-subtle: #e2e8f0;
  --border-accent: #60a5fa;
  --tab-active: #0369a1;
  --shadow: rgba(0,0,0,0.08);
  --shadow-heavy: rgba(0,0,0,0.15);
  --overlay: rgba(0,0,0,0.3);
  --bg-sent: #dbeafe;
  --border-sent: #93c5fd;
  --text-sender: #1d4ed8;
  --tint-green: #f0fdf4;
  --tint-green-border: #bbf7d0;
  --tint-red: #fef2f2;
  --tint-red-border: #fecaca;
  --tint-amber: #fffbeb;
  --tint-amber-border: #fde68a;
  --tint-purple: #faf5ff;
  --tint-purple-border: #c4b5fd;
  --accent-green: #16a34a;
  --accent-green-text: #15803d;
  --accent-amber-text: #92400e;
  --accent-amber-sub: #b45309;
  --accent-red-text: #dc2626;
  --accent-red-sub: #b91c1c;
  --grid-major: #cbd5e1;
  --grid-minor: #e2e8f0;
  --chart-label: #64748b;
  --accent-purple: #7c3aed;
  --accent-purple-sub: #6d28d9;
  --accent-blue: #2563eb;
  --accent-blue-sub: #1d4ed8;
  --tab-selected-bg: #2563eb;
  --tab-selected-text: #ffffff;
}
html.light select, html.light input, html.light textarea {
  color-scheme: light;
}
`;

function useTheme() {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("nostr_ehr_theme") !== "light";
  });
  useEffect(() => {
    const el = document.documentElement;
    if (dark) { el.classList.remove("light"); localStorage.setItem("nostr_ehr_theme", "dark"); }
    else { el.classList.add("light"); localStorage.setItem("nostr_ehr_theme", "light"); }
  }, [dark]);
  return { dark, toggle: () => setDark(d => !d) };
}

// Inject theme CSS once + apply saved theme class synchronously (before React hydration)
if (typeof document !== "undefined" && !document.getElementById("ehr-theme-css")) {
  const style = document.createElement("style");
  style.id = "ehr-theme-css";
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
  if (localStorage.getItem("nostr_ehr_theme") === "light") {
    document.documentElement.classList.add("light");
  }
}

const S = {
  app:   {height:"100vh",overflow:"hidden",background:"var(--bg-app)",color:"var(--text-primary)",fontFamily:"'DM Sans','Helvetica Neue',sans-serif",display:"flex"} as React.CSSProperties,
  panel: {flex:1,padding:"24px 28px",overflowY:"auto" as const},
  card:  {background:"var(--bg-card)",borderRadius:10,padding:"14px 16px",marginBottom:10} as React.CSSProperties,
  input: {width:"100%",background:"var(--bg-input)",border:"1px solid var(--border)",borderRadius:7,padding:"8px 10px",color:"var(--text-primary)",fontSize:12,fontFamily:"inherit",boxSizing:"border-box" as const,outline:"none"},
  lbl:   {color:"var(--text-label)",fontSize:10,textTransform:"uppercase" as const,letterSpacing:"0.6px",marginBottom:4,display:"block"},
  mono:  {fontFamily:"monospace",fontSize:10,background:"var(--bg-deep)",padding:"8px 10px",borderRadius:6,wordBreak:"break-all" as const,lineHeight:1.8},
  grid2: {display:"grid",gridTemplateColumns:"1fr 1fr",gap:10} as React.CSSProperties,
  grid3: {display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10} as React.CSSProperties,
};

function Badge({t,col="#0ea5e9",bg="var(--bg-inset)"}:{t:string;col?:string;bg?:string}){
  return <span style={{fontSize:10,padding:"2px 8px",borderRadius:12,background:bg,color:col,fontWeight:700,whiteSpace:"nowrap"}}>{t}</span>;
}
function Btn({children,onClick,col="#0ea5e9",solid=false,disabled=false,small=false,style={},title}:{
  children:React.ReactNode;onClick?:(e?:any)=>void;col?:string;solid?:boolean;disabled?:boolean;small?:boolean;style?:React.CSSProperties;title?:string;
}){
  return <button onClick={onClick} disabled={disabled} title={title} style={{
    background:solid?`linear-gradient(90deg,${col}cc,${col})`:"transparent",
    border:`1px solid ${col}44`,color:solid?"#fff":col,borderRadius:7,
    padding:small?"4px 10px":"7px 14px",fontSize:small?10:12,cursor:disabled?"not-allowed":"pointer",
    opacity:disabled?0.4:1,fontFamily:"inherit",fontWeight:solid?600:400,transition:"background 0.2s,color 0.2s",...style,
  }}>{children}</button>;
}
const ST_COL:Record<string,string>={connected:"var(--accent-green)",connecting:"#f59e0b",disconnected:"#64748b",error:"#f87171"};

// ─── Publish Patient Demographics (kind 2110) ────────────────────────────────
// Publishes a FHIR Patient resource to the relay so demographics sync across browsers.
// Called on patient creation and demographic updates. Latest event wins (current state only).
async function publishPatientDemographics(
  patient: Patient,
  keys: Keypair,
  relay: ReturnType<typeof useRelay>
): Promise<boolean> {
  if (!patient.npub) return false;
  try {
    const patientPkHex = npubToHex(patient.npub);
    const fhir: any = {
      resourceType: "Patient",
      id: patient.id,
      name: [{ text: patient.name }],
      birthDate: patient.dob || undefined,
      gender: patient.sex || "unknown",
    };
    // Add telecom (phone, email)
    const telecom: any[] = [];
    if (patient.phone) telecom.push({ system: "phone", value: patient.phone });
    if (patient.email) telecom.push({ system: "email", value: patient.email });
    if (telecom.length > 0) fhir.telecom = telecom;
    // Add address
    if (patient.address || patient.city || patient.state || patient.zip) {
      fhir.address = [{
        line: patient.address ? [patient.address] : undefined,
        city: patient.city || undefined,
        state: patient.state || undefined,
        postalCode: patient.zip || undefined,
      }];
    }
    fhir.meta = { lastUpdated: new Date().toISOString() };

    const { practiceEncrypted, patientEncrypted } = await dualEncrypt(
      JSON.stringify(fhir), keys.sk, keys.pkHex, patientPkHex
    );
    const tags = buildDualEncryptedTags(
      keys.pkHex, patientPkHex, patientEncrypted,
      "Patient", patient.id
    );
    const event = await buildAndSignEvent(FHIR_KINDS.Patient, practiceEncrypted, tags, keys.sk);
    const result = await relay.publishOrQueue(event, patient.id, JSON.stringify(fhir));
    if (result) {
      console.log(`[demographics] Published kind 2110 for ${patient.name}`);
    }
    return !!result;
  } catch (err) {
    console.error("[demographics] Failed to publish:", err);
    return false;
  }
}

// ─── useRelay ─────────────────────────────────────────────────────────────────
function useRelay(){
  const wsRef=useRef<WebSocket|null>(null);
  const pending=useRef<Record<string,(ok:boolean)=>void>>({});
  const subs=useRef<Record<string,(ev:NostrEvent)=>void>>({});
  const eoseCbs=useRef<Record<string,()=>void>>({});
  const [status,setStatus]=useState("disconnected");
  const [cacheInfo,setCacheInfo]=useState<{eventCount:number;lastSync:number}>({eventCount:0,lastSync:0});
  const [queueCount,setQueueCount]=useState(0);
  const [syncTrigger,setSyncTrigger]=useState(0);
  const retryDelay=useRef(2000);
  const retryTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const unmounted=useRef(false);
  const flushing=useRef(false);

  // Refresh cache stats periodically
  const refreshCacheStats=useCallback(async()=>{
    try{ const stats=await getCacheStats(); setCacheInfo(stats); }catch{}
  },[]);

  const refreshQueueCount=useCallback(async()=>{
    try{ const n=await getQueueCount(); setQueueCount(n); }catch{}
  },[]);

  // Flush queued events when relay reconnects
  const flushOutbox=useCallback(async(ws:WebSocket)=>{
    if(flushing.current)return;
    flushing.current=true;
    try{
      const queued=await getQueuedEvents();
      if(queued.length===0){flushing.current=false;return;}
      for(const item of queued){
        if(ws.readyState!==WebSocket.OPEN)break;
        const ok=await new Promise<boolean>(resolve=>{
          pending.current[item.eventId]=resolve;
          ws.send(JSON.stringify(["EVENT",item.event]));
          setTimeout(()=>{
            if(pending.current[item.eventId]){
              delete pending.current[item.eventId];
              resolve(false);
            }
          },6000);
        });
        if(ok){
          await removeQueuedEvent(item.eventId);
        }
      }
      await refreshQueueCount();
    }catch{}
    flushing.current=false;
    // Trigger component re-fetch so they pick up freshly-flushed events from relay
    setSyncTrigger(n=>n+1);
  },[refreshQueueCount]);

  const connect=useCallback(()=>{
    if(unmounted.current)return;
    if(wsRef.current?.readyState===WebSocket.OPEN)return;
    setStatus("connecting");
    const ws=new WebSocket(RELAY_URL);wsRef.current=ws;
    ws.onopen=()=>{
      setStatus("connected");
      retryDelay.current=2000; // reset backoff on success
      refreshCacheStats();
      refreshQueueCount();
      // Auto-flush outbox on reconnect
      flushOutbox(ws);
    };
    ws.onerror=()=>setStatus("error");
    ws.onclose=()=>{
      setStatus("disconnected");
      if(unmounted.current)return;
      // Auto-reconnect with exponential backoff (max 30s)
      retryTimer.current=setTimeout(()=>{
        retryDelay.current=Math.min(retryDelay.current*2,30000);
        connect();
      },retryDelay.current);
    };
    ws.onmessage=(e)=>{
      try{
        const [type,...rest]=JSON.parse(e.data);
        if(type==="OK"){
          const[id,ok]=rest as [string,boolean];
          pending.current[id]?.(ok);delete pending.current[id];
        } else if(type==="EVENT"){
          const[subId,ev]=rest as [string,NostrEvent];
          subs.current[subId]?.(ev);
        } else if(type==="EOSE"){
          const[subId]=rest as [string];
          eoseCbs.current[subId]?.();
        }
      }catch{}
    };
  },[refreshCacheStats,refreshQueueCount,flushOutbox]);

  useEffect(()=>{
    unmounted.current=false;
    connect();
    refreshCacheStats();
    refreshQueueCount();
    return()=>{
      unmounted.current=true;
      if(retryTimer.current)clearTimeout(retryTimer.current);
      wsRef.current?.close();
    };
  },[connect,refreshCacheStats,refreshQueueCount]);

  const publish=useCallback((event:NostrEvent):Promise<boolean>=>{
    return new Promise(resolve=>{
      if(wsRef.current?.readyState!==WebSocket.OPEN){resolve(false);return;}
      pending.current[event.id]=resolve;
      wsRef.current.send(JSON.stringify(["EVENT",event]));
      setTimeout(()=>{if(pending.current[event.id]){delete pending.current[event.id];resolve(false);}},6000);
    });
  },[]);

  /** Publish to relay, or queue to outbox if offline. Also caches locally for instant display.
   *  Returns "published" | "queued" | false (false = both relay and queue failed) */
  const publishOrQueue=useCallback(async(
    event:NostrEvent,
    patientId:string,
    fhirJson:string
  ):Promise<"published"|"queued"|false>=>{
    // Always cache locally for instant display
    const ptTag=event.tags.find((t:string[])=>t[0]==="pt");
    const pid=ptTag?.[1]||patientId;
    try{
      await cacheEvent(event.id,event.kind,pid,event.pubkey,event.created_at,fhirJson,event.tags);
    }catch{}

    // Try relay first
    const ok=await publish(event);
    if(ok) return "published";

    // Relay failed — queue for later
    try{
      await queueEvent({
        eventId:event.id,
        event,
        kind:event.kind,
        patientId:pid,
        fhirJson,
        tags:event.tags,
        queuedAt:Math.floor(Date.now()/1000),
      });
      await refreshQueueCount();
      return "queued";
    }catch{
      return false;
    }
  },[publish,refreshQueueCount]);

  const subCounter=useRef(0);
  const subscribe=useCallback((
    filters:object,
    onEvent:(ev:NostrEvent)=>void,
    onEose?:()=>void
  ):string=>{
    const subId="sub-"+Date.now()+"-"+(subCounter.current++);
    subs.current[subId]=onEvent;
    if(onEose)eoseCbs.current[subId]=onEose;
    if(wsRef.current?.readyState===WebSocket.OPEN){
      try{wsRef.current.send(JSON.stringify(["REQ",subId,filters]));}catch{}
    }
    return subId;
  },[]);

  const unsubscribe=useCallback((subId:string)=>{
    delete subs.current[subId];
    delete eoseCbs.current[subId];
    if(wsRef.current?.readyState===WebSocket.OPEN) wsRef.current.send(JSON.stringify(["CLOSE",subId]));
  },[]);

  return{status,connect,publish,publishOrQueue,subscribe,unsubscribe,cacheInfo,queueCount,syncTrigger,refreshCacheStats,refreshQueueCount};
}

// ─── Cache-aware loading helper ───────────────────────────────────────────────
// Loads from IndexedDB cache first (instant), then subscribes to relay for fresh data.
// Components call this instead of raw relay.subscribe for their initial data load.
// The `processDecrypted` callback receives decrypted FHIR items and builds component state.

interface CacheLoadOpts {
  kinds: number[];
  patientId: string;
  keys: Keypair;
  relay: ReturnType<typeof useRelay>;
  /** Process decrypted events and return state. Called with cached data first, then relay data. */
  processDecrypted: (items: {eventId:string; kind:number; created_at:number; fhir:any; tags:string[][]}[]) => void;
  /** Additional filter on raw Nostr events (e.g. check category). Return false to skip. */
  filterEvent?: (ev: NostrEvent) => boolean;
  /** Timeout for relay subscription collection (ms). Default 2500. */
  timeout?: number;
  /** Subscribe filter overrides (e.g. limit). Merged with kinds + #p filter. */
  extraFilters?: Record<string,any>;
  /** Multi-user: precomputed X₁ for staff decryption. If set, used instead of getSharedSecret. */
  practiceSharedSecret?: Uint8Array;
  /** Multi-user: practice pubkey for relay #p filter when logged in as staff. */
  practicePkHex?: string;
}

async function cachedLoad(opts: CacheLoadOpts): Promise<()=>void> {
  const { kinds, patientId, keys, relay, processDecrypted, filterEvent, timeout=2500, extraFilters={},
          practiceSharedSecret, practicePkHex } = opts;
  let cancelled = false;
  const cancel = () => { cancelled = true; };

  // Phase 1: Load from cache (instant)
  const cached: {eventId:string;kind:number;created_at:number;fhir:any;tags:string[][]}[] = [];
  for (const kind of kinds) {
    const events = await getCachedEvents(kind, patientId);
    for (const ce of events) {
      try {
        cached.push({ eventId: ce.eventId, kind: ce.kind, created_at: ce.created_at, fhir: JSON.parse(ce.fhirJson), tags: ce.tags });
      } catch {}
    }
  }
  if (cached.length > 0 && !cancelled) processDecrypted(cached);

  // Phase 2: Subscribe to relay for fresh data (if connected)
  if (relay.status !== "connected" || cancelled) return cancel;

  // Multi-user: use staff session values if available (module-level ref)
  // Events are tagged with practice pubkey, so filter by that; decrypt with X₁
  const ss = _activeStaffSession;
  const effectivePracticeSecret = practiceSharedSecret || ss?.practiceSharedSecret;
  const effectivePkHex = practicePkHex || ss?.practicePkHex || keys.pkHex;
  
  const found: NostrEvent[] = [];
  const seenIds = new Set<string>();
  const subId = relay.subscribe(
    { kinds, "#p": [effectivePkHex], limit: 500, ...extraFilters },
    (ev: NostrEvent) => {
      if (cancelled || seenIds.has(ev.id)) return;
      seenIds.add(ev.id);
      const ptTag = ev.tags.find((t: string[]) => t[0] === "pt");
      if (ptTag && ptTag[1] === patientId) {
        if (!filterEvent || filterEvent(ev)) found.push(ev);
      }
    }
  );

  const timerId = setTimeout(async () => {
    relay.unsubscribe(subId);
    if (cancelled) return;
    if (found.length === 0 && cached.length > 0) return; // cache is up to date

    // Multi-user: use precomputed X₁ if available, otherwise derive from practice key
    const sharedX = effectivePracticeSecret || getSharedSecret(keys.sk, keys.pkHex);
    const items: {eventId:string;kind:number;created_at:number;fhir:any;tags:string[][]}[] = [];
    const toCache: {eventId:string;kind:number;patientId:string;pubkey:string;created_at:number;fhirJson:string;tags:string[][]}[] = [];

    for (const ev of found) {
      try {
        const plain = await nip44Decrypt(ev.content, sharedX);
        const fhir = JSON.parse(plain);
        items.push({ eventId: ev.id, kind: ev.kind, created_at: ev.created_at, fhir, tags: ev.tags });
        toCache.push({ eventId: ev.id, kind: ev.kind, patientId, pubkey: ev.pubkey, created_at: ev.created_at, fhirJson: plain, tags: ev.tags });
      } catch {}
    }

    // Cache all freshly decrypted events
    if (toCache.length > 0) {
      await cacheEvents(toCache);
      const now = Math.floor(Date.now() / 1000);
      await setLastSync(now);
    }

    // Merge: combine cache + relay data (deduplicate by eventId, relay wins on conflict)
    if (!cancelled) {
      const relayIds = new Set(items.map(i => i.eventId));
      const cacheOnly = cached.filter(c => !relayIds.has(c.eventId));
      const merged = [...items, ...cacheOnly];
      processDecrypted(merged);
    }
  }, timeout);

  return () => { cancelled = true; clearTimeout(timerId); relay.unsubscribe(subId); };
}

// ─── Vitals Widget (for Growth Chart tab) ────────────────────────────────────
function VitalsWidget({patient,keys,relay,onSaved}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;onSaved:()=>void;
}){
  const [weight,setWeight]=useState("");
  const [weightUnit,setWeightUnit]=useState<"kg"|"lb">("lb");
  const [height,setHeight]=useState("");
  const [heightUnit,setHeightUnit]=useState<"cm"|"in">("in");
  const [hc,setHc]=useState("");
  const [hcUnit,setHcUnit]=useState<"cm"|"in">("in");
  const [saving,setSaving]=useState(false);
  const [status,setStatus]=useState<"idle"|"saved"|"error">("idle");
  const [errorMsg,setErrorMsg]=useState("");

  // Calculate BMI when both weight and height are present
  const bmi = (() => {
    const w = weight.trim() ? parseFloat(weight) : null;
    const h = height.trim() ? parseFloat(height) : null;
    if (!w || !h) return null;
    const kg = weightUnit === "lb" ? w * 0.453592 : w;
    const m = heightUnit === "in" ? (h * 2.54) / 100 : h / 100;
    return Math.round((kg / (m * m)) * 10) / 10;
  })();

  const hasAnyVital=!!(weight.trim()||height.trim()||hc.trim());

  const save=async()=>{
    if(!keys||!hasAnyVital)return;
    setSaving(true);
    setStatus("idle");
    try{
      const now=new Date().toISOString();
      let successCount=0;

      // Save weight if provided
      if(weight.trim()){
        const kg=weightUnit==="lb"?parseFloat(weight)*0.453592:parseFloat(weight);
        if(!isNaN(kg)&&kg>0){
          const obs={
            resourceType:"Observation",id:crypto.randomUUID(),status:"final",
            code:{coding:[{system:"http://loinc.org",code:"29463-7",display:"Body Weight"}]},
            subject:{reference:`Patient/${patient.id}`},
            effectiveDateTime:now,
            valueQuantity:{value:Math.round(kg*100)/100,unit:"kg",system:"http://unitsofmeasure.org",code:"kg"},
          };
          if(await publishClinicalEvent({kind:FHIR_KINDS.Observation,plaintext:JSON.stringify(obs),
            patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Observation",
            keys,relay,extraTags:[["obs","weight"]]})) successCount++;
        }
      }

      // Save height if provided
      if(height.trim()){
        const cm=heightUnit==="in"?parseFloat(height)*2.54:parseFloat(height);
        if(!isNaN(cm)&&cm>0){
          const obs={
            resourceType:"Observation",id:crypto.randomUUID(),status:"final",
            code:{coding:[{system:"http://loinc.org",code:"8302-2",display:"Body Height"}]},
            subject:{reference:`Patient/${patient.id}`},
            effectiveDateTime:now,
            valueQuantity:{value:Math.round(cm*10)/10,unit:"cm",system:"http://unitsofmeasure.org",code:"cm"},
          };
          if(await publishClinicalEvent({kind:FHIR_KINDS.Observation,plaintext:JSON.stringify(obs),
            patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Observation",
            keys,relay,extraTags:[["obs","height"]]})) successCount++;
        }
      }

      // Save HC if provided
      if(hc.trim()){
        const hcCm=hcUnit==="in"?parseFloat(hc)*2.54:parseFloat(hc);
        if(!isNaN(hcCm)&&hcCm>0){
          const obs={
            resourceType:"Observation",id:crypto.randomUUID(),status:"final",
            code:{coding:[{system:"http://loinc.org",code:"9843-4",display:"Head Circumference"}]},
            subject:{reference:`Patient/${patient.id}`},
            effectiveDateTime:now,
            valueQuantity:{value:Math.round(hcCm*10)/10,unit:"cm",system:"http://unitsofmeasure.org",code:"cm"},
          };
          if(await publishClinicalEvent({kind:FHIR_KINDS.Observation,plaintext:JSON.stringify(obs),
            patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Observation",
            keys,relay,extraTags:[["obs","hc"]]})) successCount++;
        }
      }

      if(successCount>0){
        setStatus("saved");
        setWeight("");setHeight("");setHc("");
        setTimeout(()=>{setStatus("idle");onSaved();},2000);
      } else {
        setStatus("error");
        setErrorMsg("Failed to save measurements");
        setTimeout(()=>setStatus("idle"),4000);
      }
    }finally{setSaving(false);}
  };

  return(
    <div style={{...S.card,background:"var(--bg-deep)",border:"1px solid var(--border-accent)",marginBottom:12,padding:"12px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{fontWeight:600,fontSize:12}}>📊 Record Vitals</div>
          {bmi&&<span style={{color:"#7dd3fc",fontSize:11}}>BMI: {bmi}</span>}
        </div>
        {status==="saved"&&<Badge t="✓ Saved" col="var(--accent-green)" bg="var(--tint-green)"/>}
        {status==="error"&&<span style={{color:"#f87171",fontSize:11}}>✗ {errorMsg}</span>}
      </div>
      {/* Weight + Height row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 60px 1fr 60px",gap:8,alignItems:"end",marginBottom:8}}>
        <div>
          <label style={S.lbl}>Weight</label>
          <input value={weight} onChange={e=>setWeight(e.target.value)}
            type="number" step="0.1" placeholder="22.5"
            style={{...S.input,padding:"6px 10px",fontSize:12}}/>
        </div>
        <div>
          <select value={weightUnit} onChange={e=>setWeightUnit(e.target.value as "kg"|"lb")}
            style={{...S.input,cursor:"pointer",padding:"6px 8px",fontSize:11}}>
            <option value="lb">lb</option>
            <option value="kg">kg</option>
          </select>
        </div>
        <div>
          <label style={S.lbl}>Height</label>
          <input value={height} onChange={e=>setHeight(e.target.value)}
            type="number" step="0.1" placeholder="34"
            style={{...S.input,padding:"6px 10px",fontSize:12}}/>
        </div>
        <div>
          <select value={heightUnit} onChange={e=>setHeightUnit(e.target.value as "cm"|"in")}
            style={{...S.input,cursor:"pointer",padding:"6px 8px",fontSize:11}}>
            <option value="in">in</option>
            <option value="cm">cm</option>
          </select>
        </div>
      </div>
      {/* HC row (under 2 only) + Save */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 60px auto",gap:8,alignItems:"end"}}>
        <div>
          <label style={S.lbl}>Head Circ</label>
          <input value={hc} onChange={e=>setHc(e.target.value)}
            type="number" step="0.1" placeholder="15.5"
            style={{...S.input,padding:"6px 10px",fontSize:12}}/>
        </div>
        <div>
          <select value={hcUnit} onChange={e=>setHcUnit(e.target.value as "cm"|"in")}
            style={{...S.input,cursor:"pointer",padding:"6px 8px",fontSize:11}}>
            <option value="in">in</option>
            <option value="cm">cm</option>
          </select>
        </div>
        <Btn solid col="#0ea5e9" disabled={!hasAnyVital||saving||!keys}
          onClick={save}>
          {saving?"⏳":"💾"} Save
        </Btn>
      </div>
    </div>
  );
}

// ─── Growth Chart ─────────────────────────────────────────────────────────────

// ─── WHO Head Circumference-for-age percentile data (0–24 months) ────────────
function getWHOHCCurves(sex:"male"|"female"){
  const male=[
    {age:0, p3:31.5,p10:32.1,p25:32.9,p50:34.5,p75:35.1,p90:35.7,p97:36.3},
    {age:1, p3:33.8,p10:34.5,p25:35.3,p50:36.9,p75:37.5,p90:38.1,p97:38.7},
    {age:2, p3:35.6,p10:36.4,p25:37.1,p50:38.3,p75:39.1,p90:39.7,p97:40.3},
    {age:3, p3:37.0,p10:37.7,p25:38.4,p50:39.5,p75:40.4,p90:41.0,p97:41.7},
    {age:4, p3:38.0,p10:38.8,p25:39.6,p50:40.6,p75:41.5,p90:42.2,p97:42.9},
    {age:5, p3:38.9,p10:39.7,p25:40.5,p50:41.5,p75:42.4,p90:43.1,p97:43.8},
    {age:6, p3:39.7,p10:40.5,p25:41.3,p50:42.3,p75:43.2,p90:43.9,p97:44.7},
    {age:7, p3:40.3,p10:41.1,p25:41.9,p50:43.0,p75:43.9,p90:44.6,p97:45.4},
    {age:8, p3:40.8,p10:41.6,p25:42.5,p50:43.5,p75:44.5,p90:45.2,p97:46.0},
    {age:9, p3:41.2,p10:42.1,p25:42.9,p50:44.0,p75:45.0,p90:45.7,p97:46.5},
    {age:10,p3:41.6,p10:42.5,p25:43.3,p50:44.4,p75:45.4,p90:46.1,p97:47.0},
    {age:11,p3:41.9,p10:42.8,p25:43.7,p50:44.8,p75:45.8,p90:46.5,p97:47.4},
    {age:12,p3:42.2,p10:43.1,p25:44.0,p50:45.1,p75:46.1,p90:46.9,p97:47.8},
    {age:13,p3:42.5,p10:43.4,p25:44.3,p50:45.4,p75:46.4,p90:47.2,p97:48.1},
    {age:14,p3:42.7,p10:43.6,p25:44.5,p50:45.7,p75:46.7,p90:47.5,p97:48.4},
    {age:15,p3:42.9,p10:43.8,p25:44.8,p50:45.9,p75:46.9,p90:47.7,p97:48.6},
    {age:16,p3:43.1,p10:44.0,p25:45.0,p50:46.1,p75:47.1,p90:47.9,p97:48.9},
    {age:17,p3:43.3,p10:44.2,p25:45.1,p50:46.3,p75:47.4,p90:48.2,p97:49.1},
    {age:18,p3:43.5,p10:44.4,p25:45.3,p50:46.5,p75:47.6,p90:48.4,p97:49.3},
    {age:19,p3:43.6,p10:44.6,p25:45.5,p50:46.7,p75:47.7,p90:48.6,p97:49.5},
    {age:20,p3:43.8,p10:44.7,p25:45.7,p50:46.9,p75:47.9,p90:48.8,p97:49.7},
    {age:21,p3:43.9,p10:44.9,p25:45.8,p50:47.1,p75:48.1,p90:49.0,p97:49.9},
    {age:22,p3:44.0,p10:45.0,p25:46.0,p50:47.2,p75:48.3,p90:49.2,p97:50.1},
    {age:23,p3:44.2,p10:45.1,p25:46.1,p50:47.4,p75:48.5,p90:49.3,p97:50.3},
    {age:24,p3:44.3,p10:45.3,p25:46.2,p50:47.5,p75:48.6,p90:49.5,p97:50.5},
  ];
  const female=[
    {age:0, p3:30.9,p10:31.5,p25:32.3,p50:33.9,p75:34.5,p90:35.1,p97:35.7},
    {age:1, p3:33.2,p10:33.9,p25:34.7,p50:36.2,p75:36.9,p90:37.5,p97:38.1},
    {age:2, p3:34.9,p10:35.7,p25:36.5,p50:37.6,p75:38.4,p90:39.1,p97:39.8},
    {age:3, p3:36.2,p10:37.0,p25:37.8,p50:38.9,p75:39.7,p90:40.4,p97:41.2},
    {age:4, p3:37.2,p10:38.0,p25:38.9,p50:40.0,p75:40.8,p90:41.6,p97:42.4},
    {age:5, p3:38.1,p10:38.9,p25:39.7,p50:40.9,p75:41.7,p90:42.5,p97:43.3},
    {age:6, p3:38.8,p10:39.7,p25:40.5,p50:41.7,p75:42.5,p90:43.3,p97:44.1},
    {age:7, p3:39.4,p10:40.3,p25:41.1,p50:42.3,p75:43.2,p90:44.0,p97:44.8},
    {age:8, p3:39.9,p10:40.8,p25:41.7,p50:42.9,p75:43.8,p90:44.6,p97:45.4},
    {age:9, p3:40.4,p10:41.3,p25:42.2,p50:43.4,p75:44.3,p90:45.1,p97:46.0},
    {age:10,p3:40.8,p10:41.7,p25:42.6,p50:43.8,p75:44.8,p90:45.6,p97:46.5},
    {age:11,p3:41.1,p10:42.0,p25:43.0,p50:44.2,p75:45.2,p90:46.0,p97:46.9},
    {age:12,p3:41.4,p10:42.3,p25:43.3,p50:44.5,p75:45.5,p90:46.3,p97:47.2},
    {age:13,p3:41.6,p10:42.6,p25:43.6,p50:44.8,p75:45.8,p90:46.7,p97:47.6},
    {age:14,p3:41.9,p10:42.9,p25:43.8,p50:45.1,p75:46.1,p90:47.0,p97:47.9},
    {age:15,p3:42.1,p10:43.1,p25:44.1,p50:45.3,p75:46.4,p90:47.2,p97:48.2},
    {age:16,p3:42.3,p10:43.3,p25:44.3,p50:45.6,p75:46.6,p90:47.5,p97:48.4},
    {age:17,p3:42.5,p10:43.5,p25:44.5,p50:45.8,p75:46.8,p90:47.7,p97:48.7},
    {age:18,p3:42.6,p10:43.6,p25:44.6,p50:45.9,p75:47.0,p90:47.9,p97:48.9},
    {age:19,p3:42.8,p10:43.8,p25:44.8,p50:46.1,p75:47.2,p90:48.1,p97:49.1},
    {age:20,p3:43.0,p10:44.0,p25:45.0,p50:46.3,p75:47.4,p90:48.3,p97:49.3},
    {age:21,p3:43.1,p10:44.1,p25:45.2,p50:46.5,p75:47.6,p90:48.5,p97:49.5},
    {age:22,p3:43.3,p10:44.3,p25:45.3,p50:46.7,p75:47.7,p90:48.7,p97:49.7},
    {age:23,p3:43.4,p10:44.5,p25:45.5,p50:46.8,p75:47.9,p90:48.9,p97:49.9},
    {age:24,p3:43.6,p10:44.6,p25:45.7,p50:47.0,p75:48.1,p90:49.1,p97:50.1},
  ];
  return sex==="male"?male:female;
}
// ─── CDC/WHO Height-for-age percentile data (inline) ─────────────────────────
function getWHOHeightCurves(sex:"male"|"female"){
  // WHO height-for-age 0–24 months
  const male=[
    {age:0, p3:46.1,p10:47.1,p25:48.2,p50:49.9,p75:51.6,p90:52.7,p97:53.7},
    {age:1, p3:50.8,p10:51.8,p25:53.0,p50:54.7,p75:56.4,p90:57.6,p97:58.6},
    {age:2, p3:54.4,p10:55.6,p25:56.8,p50:58.4,p75:60.1,p90:61.4,p97:62.4},
    {age:3, p3:57.3,p10:58.5,p25:59.8,p50:61.4,p75:63.2,p90:64.5,p97:65.5},
    {age:4, p3:59.7,p10:61.0,p25:62.3,p50:63.9,p75:65.7,p90:67.0,p97:68.0},
    {age:5, p3:61.7,p10:63.0,p25:64.4,p50:65.9,p75:67.7,p90:69.1,p97:70.1},
    {age:6, p3:63.3,p10:64.6,p25:66.0,p50:67.6,p75:69.4,p90:70.8,p97:71.9},
    {age:7, p3:64.8,p10:66.2,p25:67.6,p50:69.2,p75:71.0,p90:72.4,p97:73.5},
    {age:8, p3:66.2,p10:67.6,p25:69.0,p50:70.6,p75:72.5,p90:73.9,p97:75.0},
    {age:9, p3:67.5,p10:68.9,p25:70.4,p50:72.0,p75:73.9,p90:75.3,p97:76.5},
    {age:10,p3:68.7,p10:70.2,p25:71.7,p50:73.3,p75:75.2,p90:76.7,p97:77.9},
    {age:11,p3:69.9,p10:71.4,p25:72.9,p50:74.5,p75:76.5,p90:78.0,p97:79.2},
    {age:12,p3:71.0,p10:72.5,p25:74.0,p50:75.7,p75:77.7,p90:79.2,p97:80.5},
    {age:15,p3:73.9,p10:75.6,p25:77.2,p50:79.1,p75:81.1,p90:82.7,p97:84.2},
    {age:18,p3:76.9,p10:78.6,p25:80.4,p50:82.3,p75:84.4,p90:86.1,p97:87.7},
    {age:21,p3:79.4,p10:81.2,p25:83.1,p50:85.1,p75:87.2,p90:89.0,p97:90.6},
    {age:24,p3:81.7,p10:83.6,p25:85.5,p50:87.8,p75:90.1,p90:92.0,p97:93.9},
  ];
  const female=[
    {age:0, p3:45.6,p10:46.6,p25:47.8,p50:49.1,p75:50.8,p90:51.9,p97:52.9},
    {age:1, p3:49.8,p10:50.9,p25:52.0,p50:53.7,p75:55.4,p90:56.5,p97:57.6},
    {age:2, p3:53.0,p10:54.2,p25:55.4,p50:57.1,p75:58.8,p90:60.1,p97:61.1},
    {age:3, p3:55.6,p10:56.9,p25:58.2,p50:59.8,p75:61.5,p90:62.8,p97:63.8},
    {age:4, p3:57.8,p10:59.1,p25:60.4,p50:62.1,p75:63.8,p90:65.2,p97:66.2},
    {age:5, p3:59.6,p10:61.0,p25:62.3,p50:64.0,p75:65.8,p90:67.2,p97:68.2},
    {age:6, p3:61.2,p10:62.6,p25:64.0,p50:65.7,p75:67.6,p90:69.0,p97:70.1},
    {age:7, p3:62.7,p10:64.1,p25:65.6,p50:67.3,p75:69.2,p90:70.6,p97:71.8},
    {age:8, p3:64.0,p10:65.5,p25:67.0,p50:68.7,p75:70.7,p90:72.2,p97:73.3},
    {age:9, p3:65.3,p10:66.8,p25:68.3,p50:70.1,p75:72.1,p90:73.6,p97:74.8},
    {age:10,p3:66.5,p10:68.0,p25:69.5,p50:71.5,p75:73.5,p90:75.0,p97:76.2},
    {age:11,p3:67.7,p10:69.2,p25:70.8,p50:72.8,p75:74.8,p90:76.4,p97:77.6},
    {age:12,p3:68.9,p10:70.3,p25:72.0,p50:74.0,p75:76.1,p90:77.7,p97:78.9},
    {age:15,p3:72.0,p10:73.7,p25:75.4,p50:77.5,p75:79.7,p90:81.4,p97:82.7},
    {age:18,p3:75.0,p10:76.8,p25:78.7,p50:80.9,p75:83.2,p90:85.0,p97:86.4},
    {age:21,p3:77.5,p10:79.4,p25:81.3,p50:83.7,p75:86.1,p90:87.9,p97:89.4},
    {age:24,p3:80.0,p10:82.1,p25:84.0,p50:86.4,p75:88.9,p90:90.8,p97:92.2},
  ];
  return sex==="male"?male:female;
}

// ─── Height Velocity reference curves (cm/yr), ages 2–18 years ──────────────
// Based on Tanner/WHO velocity references. Ages in months (24–216).
function getHeightVelocityCurves(sex:"male"|"female"){
  // Boys: prepubertal deceleration, pubertal spurt ~12-14y
  const male=[
    {age:24, p3:6.0,p10:6.8,p25:7.4,p50:8.2,p75:9.0,p90:9.8,p97:10.6},
    {age:36, p3:5.5,p10:6.2,p25:6.8,p50:7.5,p75:8.2,p90:8.8,p97:9.5},
    {age:48, p3:5.0,p10:5.6,p25:6.2,p50:6.8,p75:7.5,p90:8.0,p97:8.6},
    {age:60, p3:4.5,p10:5.0,p25:5.6,p50:6.2,p75:6.8,p90:7.3,p97:7.8},
    {age:72, p3:4.2,p10:4.7,p25:5.2,p50:5.7,p75:6.3,p90:6.8,p97:7.3},
    {age:84, p3:4.0,p10:4.4,p25:4.9,p50:5.4,p75:5.9,p90:6.4,p97:6.9},
    {age:96, p3:3.8,p10:4.2,p25:4.6,p50:5.1,p75:5.6,p90:6.1,p97:6.6},
    {age:108,p3:3.6,p10:4.0,p25:4.4,p50:4.9,p75:5.4,p90:5.9,p97:6.4},
    {age:120,p3:3.5,p10:3.9,p25:4.3,p50:4.8,p75:5.3,p90:5.9,p97:6.5},
    {age:132,p3:3.5,p10:4.0,p25:4.5,p50:5.2,p75:6.0,p90:6.8,p97:7.8},
    {age:144,p3:3.7,p10:4.3,p25:5.2,p50:6.5,p75:7.8,p90:9.0,p97:10.2},
    {age:156,p3:3.5,p10:4.2,p25:5.5,p50:7.8,p75:9.5,p90:10.5,p97:11.5},
    {age:168,p3:2.5,p10:3.2,p25:4.5,p50:6.5,p75:8.5,p90:9.8,p97:10.8},
    {age:180,p3:1.2,p10:1.8,p25:2.5,p50:3.8,p75:5.5,p90:7.0,p97:8.2},
    {age:192,p3:0.5,p10:0.8,p25:1.2,p50:2.0,p75:3.0,p90:4.2,p97:5.5},
    {age:204,p3:0.2,p10:0.4,p25:0.6,p50:1.0,p75:1.5,p90:2.2,p97:3.0},
    {age:216,p3:0.0,p10:0.1,p25:0.3,p50:0.5,p75:0.8,p90:1.2,p97:1.8},
  ];
  // Girls: earlier pubertal spurt ~10-12y
  const female=[
    {age:24, p3:5.8,p10:6.5,p25:7.2,p50:8.0,p75:8.8,p90:9.5,p97:10.2},
    {age:36, p3:5.3,p10:5.9,p25:6.5,p50:7.2,p75:7.9,p90:8.5,p97:9.2},
    {age:48, p3:4.8,p10:5.4,p25:5.9,p50:6.5,p75:7.2,p90:7.7,p97:8.3},
    {age:60, p3:4.3,p10:4.8,p25:5.3,p50:5.9,p75:6.5,p90:7.0,p97:7.5},
    {age:72, p3:4.0,p10:4.5,p25:5.0,p50:5.5,p75:6.1,p90:6.6,p97:7.1},
    {age:84, p3:3.8,p10:4.3,p25:4.7,p50:5.2,p75:5.8,p90:6.3,p97:6.8},
    {age:96, p3:3.7,p10:4.1,p25:4.5,p50:5.0,p75:5.6,p90:6.2,p97:6.8},
    {age:108,p3:3.6,p10:4.0,p25:4.5,p50:5.2,p75:6.0,p90:6.8,p97:7.5},
    {age:120,p3:3.8,p10:4.3,p25:5.0,p50:6.0,p75:7.2,p90:8.2,p97:9.2},
    {age:132,p3:3.5,p10:4.0,p25:5.0,p50:6.8,p75:8.0,p90:8.8,p97:9.5},
    {age:144,p3:2.0,p10:2.5,p25:3.2,p50:4.5,p75:6.0,p90:7.0,p97:7.8},
    {age:156,p3:1.0,p10:1.5,p25:2.0,p50:2.8,p75:3.8,p90:4.8,p97:5.5},
    {age:168,p3:0.5,p10:0.8,p25:1.0,p50:1.5,p75:2.2,p90:3.0,p97:3.8},
    {age:180,p3:0.2,p10:0.3,p25:0.5,p50:0.8,p75:1.2,p90:1.8,p97:2.5},
    {age:192,p3:0.0,p10:0.1,p25:0.2,p50:0.4,p75:0.6,p90:1.0,p97:1.5},
    {age:204,p3:0.0,p10:0.0,p25:0.1,p50:0.2,p75:0.4,p90:0.6,p97:0.8},
    {age:216,p3:0.0,p10:0.0,p25:0.0,p50:0.1,p75:0.2,p90:0.4,p97:0.5},
  ];
  return sex==="male"?male:female;
}

function getCDCHeightCurves(sex:"male"|"female"){
  // CDC height-for-age, ages 24–240 months (2–20 years), key percentiles
  const male=[
    {age:24,p3:81.5,p10:83.5,p25:85.4,p50:87.1,p75:88.9,p90:90.6,p97:92.6},
    {age:36,p3:89.0,p10:91.3,p25:93.5,p50:95.7,p75:97.9,p90:100.0,p97:102.4},
    {age:48,p3:95.7,p10:98.3,p25:100.7,p50:103.3,p75:105.7,p90:107.9,p97:110.6},
    {age:60,p3:101.8,p10:104.5,p25:107.0,p50:109.9,p75:112.5,p90:114.9,p97:117.7},
    {age:72,p3:107.3,p10:110.1,p25:112.8,p50:115.9,p75:118.7,p90:121.3,p97:124.2},
    {age:84,p3:112.3,p10:115.3,p25:118.2,p50:121.5,p75:124.5,p90:127.3,p97:130.5},
    {age:96,p3:117.0,p10:120.2,p25:123.3,p50:126.9,p75:130.1,p90:133.1,p97:136.6},
    {age:108,p3:121.5,p10:124.9,p25:128.2,p50:132.0,p75:135.5,p90:138.8,p97:142.5},
    {age:120,p3:125.8,p10:129.5,p25:133.0,p50:137.0,p75:140.8,p90:144.3,p97:148.3},
    {age:132,p3:130.0,p10:133.9,p25:137.7,p50:141.9,p75:146.0,p90:149.8,p97:154.1},
    {age:144,p3:134.3,p10:138.4,p25:142.4,p50:146.9,p75:151.3,p90:155.3,p97:159.9},
    {age:156,p3:138.5,p10:142.8,p25:147.0,p50:151.8,p75:156.5,p90:160.8,p97:165.6},
    {age:168,p3:143.0,p10:147.5,p25:151.9,p50:157.0,p75:161.9,p90:166.3,p97:171.4},
    {age:180,p3:148.0,p10:152.6,p25:157.0,p50:162.2,p75:167.2,p90:171.6,p97:176.7},
    {age:192,p3:153.1,p10:157.5,p25:161.8,p50:166.8,p75:171.7,p90:175.9,p97:180.7},
    {age:204,p3:157.0,p10:161.3,p25:165.4,p50:170.1,p75:174.8,p90:178.9,p97:183.5},
    {age:216,p3:159.9,p10:164.0,p25:167.9,p50:172.3,p75:176.8,p90:180.7,p97:185.0},
    {age:228,p3:161.8,p10:165.7,p25:169.4,p50:173.7,p75:178.0,p90:181.7,p97:185.8},
    {age:240,p3:162.9,p10:166.7,p25:170.3,p50:174.5,p75:178.6,p90:182.2,p97:186.2},
  ];
  const female=[
    {age:24,p3:80.0,p10:82.1,p25:84.0,p50:85.7,p75:87.5,p90:89.3,p97:91.4},
    {age:36,p3:88.3,p10:90.5,p25:92.6,p50:94.7,p75:96.8,p90:98.8,p97:101.1},
    {age:48,p3:95.0,p10:97.4,p25:99.6,p50:101.9,p75:104.3,p90:106.5,p97:109.0},
    {age:60,p3:101.0,p10:103.5,p25:106.0,p50:108.4,p75:111.0,p90:113.4,p97:116.0},
    {age:72,p3:106.5,p10:109.2,p25:111.8,p50:114.5,p75:117.3,p90:119.8,p97:122.7},
    {age:84,p3:111.8,p10:114.7,p25:117.5,p50:120.4,p75:123.5,p90:126.1,p97:129.2},
    {age:96,p3:116.7,p10:119.8,p25:122.8,p50:126.0,p75:129.2,p90:132.1,p97:135.5},
    {age:108,p3:121.4,p10:124.7,p25:127.9,p50:131.4,p75:134.9,p90:138.0,p97:141.6},
    {age:120,p3:126.0,p10:129.5,p25:133.0,p50:136.8,p75:140.7,p90:144.1,p97:148.0},
    {age:132,p3:130.7,p10:134.5,p25:138.3,p50:142.4,p75:146.7,p90:150.4,p97:154.7},
    {age:144,p3:135.7,p10:139.7,p25:143.8,p50:148.2,p75:152.8,p90:156.7,p97:161.3},
    {age:156,p3:140.7,p10:144.8,p25:149.0,p50:153.5,p75:158.2,p90:162.2,p97:166.8},
    {age:168,p3:145.0,p10:149.0,p25:153.0,p50:157.4,p75:161.8,p90:165.6,p97:170.0},
    {age:180,p3:147.7,p10:151.5,p25:155.3,p50:159.4,p75:163.6,p90:167.2,p97:171.3},
    {age:192,p3:149.2,p10:152.9,p25:156.5,p50:160.5,p75:164.5,p90:168.0,p97:171.9},
    {age:204,p3:149.9,p10:153.5,p25:157.1,p50:160.9,p75:164.9,p90:168.3,p97:172.1},
    {age:216,p3:150.2,p10:153.7,p25:157.3,p50:161.1,p75:164.9,p90:168.3,p97:172.0},
    {age:228,p3:150.3,p10:153.8,p25:157.3,p50:161.1,p75:165.0,p90:168.3,p97:172.0},
    {age:240,p3:150.4,p10:153.9,p25:157.4,p50:161.2,p75:165.0,p90:168.3,p97:172.0},
  ];
  return sex==="male"?male:female;
}

function getCDCBMICurves(sex:"male"|"female"){
  const male=[
    {age:24,p3:14.2,p10:14.8,p25:15.4,p50:16.1,p75:16.9,p90:17.8,p97:19.1},
    {age:36,p3:13.7,p10:14.2,p25:14.8,p50:15.5,p75:16.3,p90:17.1,p97:18.4},
    {age:48,p3:13.4,p10:13.9,p25:14.5,p50:15.2,p75:16.0,p90:16.9,p97:18.2},
    {age:60,p3:13.2,p10:13.7,p25:14.3,p50:15.1,p75:15.9,p90:16.9,p97:18.3},
    {age:72,p3:13.1,p10:13.6,p25:14.2,p50:15.1,p75:16.0,p90:17.1,p97:18.7},
    {age:84,p3:13.0,p10:13.5,p25:14.2,p50:15.1,p75:16.1,p90:17.3,p97:19.1},
    {age:96,p3:13.0,p10:13.5,p25:14.3,p50:15.2,p75:16.4,p90:17.7,p97:19.7},
    {age:108,p3:13.0,p10:13.6,p25:14.4,p50:15.4,p75:16.7,p90:18.2,p97:20.4},
    {age:120,p3:13.1,p10:13.7,p25:14.6,p50:15.7,p75:17.1,p90:18.8,p97:21.3},
    {age:132,p3:13.2,p10:13.9,p25:14.9,p50:16.1,p75:17.7,p90:19.5,p97:22.3},
    {age:144,p3:13.4,p10:14.2,p25:15.3,p50:16.6,p75:18.3,p90:20.3,p97:23.3},
    {age:156,p3:13.8,p10:14.6,p25:15.8,p50:17.2,p75:19.1,p90:21.2,p97:24.4},
    {age:168,p3:14.2,p10:15.1,p25:16.3,p50:17.9,p75:19.8,p90:22.1,p97:25.5},
    {age:180,p3:14.8,p10:15.7,p25:17.0,p50:18.6,p75:20.7,p90:23.0,p97:26.6},
    {age:192,p3:15.4,p10:16.3,p25:17.7,p50:19.4,p75:21.5,p90:23.9,p97:27.5},
    {age:204,p3:16.0,p10:17.0,p25:18.4,p50:20.2,p75:22.3,p90:24.8,p97:28.5},
    {age:216,p3:16.6,p10:17.7,p25:19.1,p50:20.9,p75:23.1,p90:25.6,p97:29.3},
    {age:228,p3:17.2,p10:18.3,p25:19.7,p50:21.6,p75:23.8,p90:26.3,p97:30.1},
    {age:240,p3:17.7,p10:18.8,p25:20.3,p50:22.2,p75:24.4,p90:26.9,p97:30.7},
  ];
  const female=[
    {age:24,p3:13.9,p10:14.5,p25:15.2,p50:15.9,p75:16.8,p90:17.8,p97:19.2},
    {age:36,p3:13.5,p10:14.0,p25:14.7,p50:15.4,p75:16.3,p90:17.2,p97:18.6},
    {age:48,p3:13.2,p10:13.7,p25:14.4,p50:15.1,p75:16.0,p90:17.0,p97:18.5},
    {age:60,p3:13.0,p10:13.5,p25:14.2,p50:15.0,p75:15.9,p90:17.0,p97:18.6},
    {age:72,p3:12.9,p10:13.4,p25:14.1,p50:15.0,p75:16.0,p90:17.1,p97:18.9},
    {age:84,p3:12.8,p10:13.4,p25:14.1,p50:15.1,p75:16.2,p90:17.4,p97:19.4},
    {age:96,p3:12.8,p10:13.4,p25:14.2,p50:15.2,p75:16.4,p90:17.8,p97:20.0},
    {age:108,p3:12.9,p10:13.5,p25:14.3,p50:15.5,p75:16.8,p90:18.3,p97:20.7},
    {age:120,p3:13.0,p10:13.7,p25:14.6,p50:15.8,p75:17.3,p90:18.9,p97:21.5},
    {age:132,p3:13.2,p10:14.0,p25:15.0,p50:16.3,p75:17.9,p90:19.7,p97:22.5},
    {age:144,p3:13.5,p10:14.3,p25:15.5,p50:16.9,p75:18.7,p90:20.6,p97:23.6},
    {age:156,p3:13.9,p10:14.8,p25:16.1,p50:17.7,p75:19.6,p90:21.7,p97:24.9},
    {age:168,p3:14.4,p10:15.5,p25:16.8,p50:18.5,p75:20.6,p90:22.8,p97:26.2},
    {age:180,p3:15.1,p10:16.2,p25:17.6,p50:19.4,p75:21.6,p90:23.9,p97:27.4},
    {age:192,p3:15.7,p10:16.9,p25:18.4,p50:20.3,p75:22.6,p90:25.0,p97:28.6},
    {age:204,p3:16.3,p10:17.5,p25:19.1,p50:21.1,p75:23.5,p90:26.0,p97:29.7},
    {age:216,p3:16.8,p10:18.1,p25:19.8,p50:21.8,p75:24.3,p90:26.8,p97:30.6},
    {age:228,p3:17.2,p10:18.6,p25:20.3,p50:22.4,p75:24.9,p90:27.5,p97:31.3},
    {age:240,p3:17.5,p10:18.9,p25:20.7,p50:22.8,p75:25.3,p90:27.9,p97:31.8},
  ];
  return sex==="male"?male:female;
}

function GrowthChart({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const age=ageFromDob(patient.dob);
  const totalMonths=age.years*12+age.months;
  // Precise age in months for the current-age line (fractional, not rounded)
  const preciseAgeMonths=(()=>{
    const birth=new Date(patient.dob+"T00:00:00");
    const now=new Date();
    return (now.getTime()-birth.getTime())/(1000*60*60*24*30.4375);
  })();
  const sex=(patient.sex==="female"?"female":"male") as "male"|"female";
  const useWHO=totalMonths<=24;
  const curves=useWHO?getWHOWeightCurves(sex):getCDCWeightCurves(sex);
  const heightCurves=getCDCHeightCurves(sex);
  const bmiCurves=getCDCBMICurves(sex);
  const [growthTab,setGrowthTab]=useState<"weight"|"height"|"bmi"|"hc"|"hv">("weight");
  const chartRef=useRef<HTMLDivElement>(null);
  const [showPrintModal,setShowPrintModal]=useState(false);
  const [printSelections,setPrintSelections]=useState<Record<string,boolean>>({weight:true,height:true,bmi:false,hc:useWHO});

  // Weight observations from relay
  const [weightDots,setWeightDots]=useState<{ageMonths:number;kg:number;date:string;author?:string}[]>([]);
  const [heightDots,setHeightDots]=useState<{ageMonths:number;cm:number;date:string;author?:string}[]>([]);
  const [hcDots,setHcDots]=useState<{ageMonths:number;cm:number;date:string;author?:string}[]>([]);
  const [refreshTrigger,setRefreshTrigger]=useState(0);

  // Single subscription fetches all observations for this patient, splits into weight/height
  // Cache-first: loads from IndexedDB instantly, then refreshes from relay
  const processObservations=(items:{fhir:any;tags?:string[][]}[])=>{
    const wDots:typeof weightDots=[];
    const hDots:typeof heightDots=[];
    const hdDots:typeof hcDots=[];
    for(const{fhir:obs,tags}of items){
      try{
        if(!obs.valueQuantity?.value||!obs.effectiveDateTime) continue;
        const measDate=new Date(obs.effectiveDateTime);
        const birthDate=new Date(patient.dob);
        const ageMonths=(measDate.getTime()-birthDate.getTime())/(1000*60*60*24*30.4375);
        const ageMonthsR=Math.round(ageMonths*10)/10;
        const author=tags?.find((t:string[])=>t[0]==="authored-by")?.[2]||undefined;
        const isHC=obs.code?.coding?.some((c:any)=>c.code==="9843-4"||c.display?.toLowerCase().includes("head circumference")||c.display?.toLowerCase().includes("head circ"));
        const isWeight=!isHC&&(obs.valueQuantity.code==="kg"||
          obs.code?.coding?.some((c:any)=>c.code==="29463-7"||c.display?.toLowerCase().includes("weight")));
        const isHeight=!isHC&&(
          obs.code?.coding?.some((c:any)=>c.code==="8302-2"||c.display?.toLowerCase().includes("body height")));
        if(isHC){
          const cm=obs.valueQuantity.code==="cm"?obs.valueQuantity.value:obs.valueQuantity.value*2.54;
          hdDots.push({ageMonths:ageMonthsR,cm:Math.round(cm*10)/10,date:measDate.toLocaleDateString(),author});
        } else if(isWeight){
          const kg=obs.valueQuantity.code==="kg"?obs.valueQuantity.value:obs.valueQuantity.value*0.453592;
          wDots.push({ageMonths:ageMonthsR,kg:Math.round(kg*100)/100,date:measDate.toLocaleDateString(),author});
        } else if(isHeight){
          const cm=obs.valueQuantity.code==="cm"?obs.valueQuantity.value:obs.valueQuantity.value*2.54;
          hDots.push({ageMonths:ageMonthsR,cm:Math.round(cm*10)/10,date:measDate.toLocaleDateString(),author});
        }
      }catch{}
    }
    wDots.sort((a,b)=>a.ageMonths-b.ageMonths);
    hDots.sort((a,b)=>a.ageMonths-b.ageMonths);
    hdDots.sort((a,b)=>a.ageMonths-b.ageMonths);
    setWeightDots(wDots);
    setHeightDots(hDots);
    setHcDots(hdDots);
  };

  useEffect(()=>{
    if(!keys)return;
    let cleanup=()=>{};
    const p=cachedLoad({
      kinds:[FHIR_KINDS.Observation],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>processObservations(items.map(i=>({fhir:i.fhir,tags:i.tags}))),
      timeout:3000,
    });
    p.then(fn=>{if(fn)cleanup=fn;});
    return()=>{cleanup();p.then(fn=>{if(fn)fn();});};
  },[patient.id,keys,relay.status,relay.syncTrigger,refreshTrigger]);

  // Compute height velocity dots (cm/year) from consecutive height measurements
  const hvDots=useMemo(()=>{
    if(heightDots.length<2)return[];
    const sorted=[...heightDots].sort((a,b)=>a.ageMonths-b.ageMonths);
    const result:{ageMonths:number;val:number;date:string}[]=[];
    for(let i=1;i<sorted.length;i++){
      const dAge=sorted[i].ageMonths-sorted[i-1].ageMonths;
      if(dAge<3)continue; // need at least 3 months between measurements for meaningful velocity
      const dH=sorted[i].cm-sorted[i-1].cm;
      const vel=Math.round((dH/(dAge/12))*10)/10; // cm/year
      const midAge=(sorted[i].ageMonths+sorted[i-1].ageMonths)/2;
      result.push({ageMonths:midAge,val:vel,date:sorted[i].date});
    }
    return result;
  },[heightDots]);

  // Print growth chart as PDF
  const printChart=useCallback(()=>{
    // Determine which curves and dots to use based on current tab
    type CP={age:number;p3:number;p10:number;p25:number;p50:number;p75:number;p90:number;p97:number};
    let chartCurves:CP[];
    let dots:{ageMonths:number;val:number;date:string}[];
    let dotColor:string;
    let yLbl:string;
    let xLbl:string;
    let yStep:number;
    if(growthTab==="weight"){
      chartCurves=curves as CP[];
      dots=weightDots.map(d=>({ageMonths:d.ageMonths,val:d.kg,date:d.date}));
      dotColor="#f97316";yLbl="Weight (kg)";xLbl=useWHO?"Age (months)":"Age (years)";yStep=useWHO?2:10;
    }else if(growthTab==="height"){
      chartCurves=(useWHO?getWHOHeightCurves(sex):heightCurves) as CP[];
      dots=heightDots.map(d=>({ageMonths:d.ageMonths,val:d.cm,date:d.date}));
      dotColor="#22d3ee";yLbl="Height (cm)";xLbl=useWHO?"Age (months)":"Age (years)";yStep=useWHO?5:10;
    }else if(growthTab==="bmi"){
      chartCurves=bmiCurves as CP[];
      dots=weightDots.flatMap(w=>{const hm=heightDots.find(h=>Math.abs(h.ageMonths-w.ageMonths)<1.0);if(!hm)return[];const mH=hm.cm/100;return[{ageMonths:w.ageMonths,val:Math.round((w.kg/(mH*mH))*10)/10,date:w.date}];});
      dotColor="#a78bfa";yLbl="BMI";xLbl="Age (years)";yStep=2;
    }else if(growthTab==="hv"){
      chartCurves=getHeightVelocityCurves(sex) as CP[];
      dots=hvDots;
      dotColor="#10b981";yLbl="Growth Velocity (cm/yr)";xLbl="Age (years)";yStep=1;
    }else{
      chartCurves=getWHOHCCurves(sex) as CP[];
      dots=hcDots.map(d=>({ageMonths:d.ageMonths,val:d.cm,date:d.date}));
      dotColor="#f472b6";yLbl="Head Circ (cm)";xLbl="Age (months)";yStep=2;
    }
    // Gather per-chart measurements for table
    let measurements:GrowthMeasurement[]=[];
    if(growthTab==="weight") measurements=weightDots.map(d=>({date:d.date,ageMonths:d.ageMonths,weight:d.kg}));
    else if(growthTab==="height") measurements=heightDots.map(d=>({date:d.date,ageMonths:d.ageMonths,height:d.cm}));
    else if(growthTab==="hc") measurements=hcDots.map(d=>({date:d.date,ageMonths:d.ageMonths,hc:d.cm}));
    else if(growthTab==="bmi") measurements=dots.map(d=>({date:d.date,ageMonths:d.ageMonths,bmi:d.val}));
    else if(growthTab==="hv") measurements=hvDots.map(d=>({date:d.date,ageMonths:d.ageMonths,hv:d.val}));
    const tabLabel=growthTab==="weight"?"Weight-for-Age":growthTab==="height"?"Height-for-Age":growthTab==="bmi"?"BMI-for-Age":growthTab==="hv"?"Height Velocity":"Head Circumference-for-Age";
    const curveLabel=useWHO?"WHO 0–24 months":"CDC 2–20 years";
    const doc=generateGrowthChart(
      {name:patient.name,dob:patient.dob,sex:patient.sex},
      `${tabLabel} (${curveLabel})`,
      chartCurves,dots,dotColor,yLbl,xLbl,yStep,preciseAgeMonths,measurements
    );
    doc.save(`GrowthChart_${patient.name.replace(/\s+/g,"_")}_${growthTab}.pdf`);
  },[patient,weightDots,heightDots,hcDots,hvDots,growthTab,useWHO,curves,heightCurves,bmiCurves,sex,preciseAgeMonths]);

  // Print multiple growth charts in one PDF
  const printAllCharts=useCallback((selected:("weight"|"height"|"bmi"|"hc"|"hv")[])=>{
    // Filter out HC for CDC, filter out BMI/HV for WHO
    const filtered=useWHO?selected.filter(t=>t!=="bmi"&&t!=="hv"):selected.filter(t=>t!=="hc");
    if(filtered.length===0)return;
    type CP={age:number;p3:number;p10:number;p25:number;p50:number;p75:number;p90:number;p97:number};
    const curveLabel=useWHO?"WHO 0–24 months":"CDC 2–20 years";
    let doc:ReturnType<typeof generateGrowthChart>|null=null;
    for(const tab of filtered){
      let cc:CP[];let dd:{ageMonths:number;val:number;date:string}[];let dc:string;let yl:string;let xl:string;let ys:number;let tl:string;
      let tabMeasurements:GrowthMeasurement[]=[];
      if(tab==="weight"){
        cc=curves as CP[];dd=weightDots.map(d=>({ageMonths:d.ageMonths,val:d.kg,date:d.date}));dc="#f97316";yl="Weight (kg)";xl=useWHO?"Age (months)":"Age (years)";ys=useWHO?2:10;tl="Weight-for-Age";
        tabMeasurements=weightDots.map(d=>({date:d.date,ageMonths:d.ageMonths,weight:d.kg}));
      }else if(tab==="height"){
        cc=(useWHO?getWHOHeightCurves(sex):heightCurves) as CP[];dd=heightDots.map(d=>({ageMonths:d.ageMonths,val:d.cm,date:d.date}));dc="#22d3ee";yl="Height (cm)";xl=useWHO?"Age (months)":"Age (years)";ys=useWHO?5:10;tl="Height-for-Age";
        tabMeasurements=heightDots.map(d=>({date:d.date,ageMonths:d.ageMonths,height:d.cm}));
      }else if(tab==="bmi"){
        cc=bmiCurves as CP[];
        const bmiCalc=weightDots.flatMap(w=>{const hm=heightDots.find(h=>Math.abs(h.ageMonths-w.ageMonths)<1.0);if(!hm)return[];const mH=hm.cm/100;return[{ageMonths:w.ageMonths,val:Math.round((w.kg/(mH*mH))*10)/10,date:w.date}];});
        dd=bmiCalc;dc="#a78bfa";yl="BMI";xl="Age (years)";ys=2;tl="BMI-for-Age";
        tabMeasurements=bmiCalc.map(d=>({date:d.date,ageMonths:d.ageMonths,bmi:d.val}));
      }else if(tab==="hv"){
        cc=getHeightVelocityCurves(sex) as CP[];dd=hvDots;dc="#10b981";yl="Growth Velocity (cm/yr)";xl="Age (years)";ys=1;tl="Height Velocity";
        tabMeasurements=hvDots.map(d=>({date:d.date,ageMonths:d.ageMonths,hv:d.val}));
      }else{
        cc=getWHOHCCurves(sex) as CP[];dd=hcDots.map(d=>({ageMonths:d.ageMonths,val:d.cm,date:d.date}));dc="#f472b6";yl="Head Circ (cm)";xl="Age (months)";ys=2;tl="Head Circumference-for-Age";
        tabMeasurements=hcDots.map(d=>({date:d.date,ageMonths:d.ageMonths,hc:d.cm}));
      }
      doc=generateGrowthChart(
        {name:patient.name,dob:patient.dob,sex:patient.sex},
        `${tl} (${curveLabel})`,cc,dd,dc,yl,xl,ys,preciseAgeMonths,
        tabMeasurements,
        doc||undefined
      );
    }
    if(doc)doc.save(`GrowthCharts_${patient.name.replace(/\s+/g,"_")}_All.pdf`);
  },[patient,weightDots,heightDots,hcDots,useWHO,curves,heightCurves,bmiCurves,sex,preciseAgeMonths]);

  // Shared chart renderer
  const W=1060,H=520,PL=52,PR=108,PT=20,PB=48;
  const cw=W-PL-PR,ch=H-PT-PB;
  const pctLines=[
    {key:"p97" as const,col:"#f87171",label:"97th"},
    {key:"p90" as const,col:"#fbbf24",label:"90th"},
    {key:"p75" as const,col:"#4ade80",label:"75th"},
    {key:"p50" as const,col:"#38bdf8",label:"50th"},
    {key:"p25" as const,col:"#4ade80",label:"25th"},
    {key:"p10" as const,col:"#fbbf24",label:"10th"},
    {key:"p3"  as const,col:"#f87171",label:"3rd"},
  ];

  // Chart-specific Y-axis configuration for CDC 2-20
  type YAxisConfig={min:number;max:number;gridStep:number;labelStep:number;
    fmtLeft:(v:number)=>string;fmtRight?:(v:number)=>string};

  function getYAxisConfig(yLabel:string):YAxisConfig|null{
    if(!useWHO&&yLabel.startsWith("Height")){
      return{min:75,max:198,gridStep:3,labelStep:9,
        fmtLeft:v=>`${v}`,
        fmtRight:v=>`${Math.round(v/2.54)}″`};
    }
    if(!useWHO&&yLabel.startsWith("Weight")){
      return{min:5,max:105,gridStep:5,labelStep:10,
        fmtLeft:v=>`${v}`,
        fmtRight:v=>`${Math.round(v*2.205)} lb`};
    }
    return null; // use default dynamic scaling
  }

  function renderChart<T extends {age:number;p3:number;p10:number;p25:number;p50:number;p75:number;p90:number;p97:number}>(
    chartCurves:T[],
    dots:{ageMonths:number;val:number;date:string;author?:string}[],
    dotColor:string,
    yLabel:string,
    xLabel:string,
    yStep:number,
    fmtTooltip?:(val:number)=>string
  ){
    const allAges=chartCurves.map(c=>c.age);
    const minAge=Math.min(...allAges),maxAge=Math.max(...allAges);

    // Y-axis: use fixed config for CDC height/weight, dynamic for others
    const yConfig=getYAxisConfig(yLabel);
    let minVal:number,maxVal:number;
    if(yConfig){
      minVal=yConfig.min;maxVal=yConfig.max;
    }else{
      const allVals=chartCurves.flatMap(c=>[c.p3,c.p97]);
      minVal=Math.floor(Math.min(...allVals));
      maxVal=Math.ceil(Math.max(...allVals));
    }

    const ax=(a:number)=>Math.max(PL,Math.min(PL+cw, PL+(a-minAge)/(maxAge-minAge)*cw));
    const ay=(v:number)=>PT+ch-(v-minVal)/(maxVal-minVal)*ch;
    const ayClamp=(v:number)=>Math.max(PT+4,Math.min(PT+ch-4,ay(v)));

    // Y gridlines and labels
    const yGridStep=yConfig?yConfig.gridStep:yStep;
    const yLabelStep=yConfig?yConfig.labelStep:yStep;
    const yGridLines:number[]=[];
    const startY=yConfig?yConfig.min:minVal;
    const endY=yConfig?yConfig.max:maxVal;
    for(let v=startY;v<=endY;v+=yGridStep) yGridLines.push(v);

    // X-axis: gridlines every 6 months for CDC, every 2 months for WHO; labels every 2yr / 2mo
    const xGridLines:number[]=[];
    const xLabelTicks:number[]=[];
    if(maxAge<=24){
      for(let a=0;a<=24;a+=2){xGridLines.push(a);xLabelTicks.push(a);}
    }else{
      // Grid every 6 months
      for(let a=minAge;a<=maxAge;a+=6)xGridLines.push(a);
      // Labels every 2 years
      for(let a=minAge;a<=maxAge;a+=24)xLabelTicks.push(a);
    }

    const validDots=dots;
    return(
      <div style={{overflowX:"auto"}}>
        <svg width={W} height={H} style={{display:"block"}}>
          <defs>
            <clipPath id="chartClip"><rect x={PL} y={PT} width={cw} height={ch}/></clipPath>
          </defs>
          <rect x={PL} y={PT} width={cw} height={ch} fill="var(--bg-deep)" rx="4"/>
          {/* Y gridlines */}
          {yGridLines.map(v=>{
            const isLabel=(v-startY)%yLabelStep===0;
            return(<g key={v}>
              <line x1={PL} y1={ay(v)} x2={PL+cw} y2={ay(v)}
                stroke={isLabel?"var(--grid-major)":"var(--grid-minor)"} strokeWidth={isLabel?1:0.5}/>
              {isLabel&&<text x={PL-6} y={ay(v)+4} textAnchor="end" fill="var(--chart-label)" fontSize="9">
                {yConfig?yConfig.fmtLeft(v):v}
              </text>}
              {isLabel&&yConfig?.fmtRight&&<text x={PL+cw+6} y={ay(v)+4} textAnchor="start" fill="var(--chart-label)" fontSize="9">
                {yConfig.fmtRight(v)}
              </text>}
              {!yConfig&&<text x={PL-6} y={ay(v)+4} textAnchor="end" fill="var(--chart-label)" fontSize="9">{v}</text>}
            </g>);
          })}
          {/* X gridlines */}
          {xGridLines.map(a=>(
            <g key={`xg${a}`}>
              <line x1={ax(a)} y1={PT} x2={ax(a)} y2={PT+ch}
                stroke={xLabelTicks.includes(a)?"var(--grid-major)":"var(--grid-minor)"}
                strokeWidth={xLabelTicks.includes(a)?1:0.5}/>
            </g>
          ))}
          {/* X labels */}
          {xLabelTicks.map(a=>(
            <text key={`xl${a}`} x={ax(a)} y={PT+ch+14} textAnchor="middle" fill="var(--chart-label)" fontSize="9">
              {a<48?`${a}mo`:`${Math.round(a/12)}y`}
            </text>
          ))}
          {/* Clipped chart content — curves, dots, age line */}
          <g clipPath="url(#chartClip)">
          {pctLines.map(({key,col})=>(
            <path key={key} d={chartCurves.map((c,i)=>`${i===0?"M":"L"}${ax(c.age).toFixed(1)},${ay(c[key] as number).toFixed(1)}`).join(" ")}
              fill="none" stroke={col} strokeWidth="1.5" opacity="0.85"/>
          ))}
          {preciseAgeMonths>=minAge&&preciseAgeMonths<=maxAge&&(
            <line x1={ax(preciseAgeMonths)} y1={PT} x2={ax(preciseAgeMonths)} y2={PT+ch}
              stroke="#a78bfa" strokeWidth="2" strokeDasharray="4,3"/>
          )}
          {validDots.map((d,i)=>(
            <g key={i}>
              <title>{`${d.date}: ${fmtTooltip?fmtTooltip(d.val):d.val.toFixed(1)} · age ${d.ageMonths<24?d.ageMonths.toFixed(1)+" mo":(d.ageMonths/12).toFixed(1)+" yr"}${d.author?` · by ${d.author}`:""}`}</title>
              <circle cx={ax(d.ageMonths)} cy={ayClamp(d.val)} r="7" fill={dotColor} stroke="#fff" strokeWidth="2"/>
            </g>
          ))}
          {validDots.length>1&&(
            <path d={validDots.map((d,i)=>`${i===0?"M":"L"}${ax(d.ageMonths).toFixed(1)},${ayClamp(d.val).toFixed(1)}`).join(" ")}
              fill="none" stroke={dotColor} strokeWidth="2" strokeDasharray="4,3" opacity="0.8"/>
          )}
          </g>
          {/* Percentile labels (outside clip so they're always visible) */}
          {pctLines.map(({key,col,label})=>{
            const endVal=chartCurves[chartCurves.length-1][key] as number;
            const labelY=Math.max(PT+6,Math.min(PT+ch-2,ay(endVal)+4));
            return <text key={`lbl${key}`} x={PL+cw+(yConfig?52:3)} y={labelY}
              fill={col} fontSize="8" opacity="0.8">{label}</text>;
          })}
          <text x={PL+cw/2} y={H-2} textAnchor="middle" fill="var(--chart-label)" fontSize="10">{xLabel}</text>
          <text transform={`rotate(-90,12,${PT+ch/2})`} x="0" y={PT+ch/2+4}
            textAnchor="middle" fill="var(--chart-label)" fontSize="10">{yLabel}</text>
          {yConfig?.fmtRight&&<text transform={`rotate(90,${PL+cw+88},${PT+ch/2})`} x={PL+cw+88} y={PT+ch/2+4}
            textAnchor="middle" fill="var(--chart-label)" fontSize="10">
            {yLabel.startsWith("Weight")?"Weight (lbs)":yLabel.startsWith("Height")?"Height (in)":""}
          </text>}
        </svg>
      </div>
    );
  }

  // Compute BMI dots from paired weight+height measurements by date
  const bmiDots=weightDots.flatMap(w=>{
    const hMatch=heightDots.find(h=>Math.abs(h.ageMonths-w.ageMonths)<1.0);
    if(!hMatch)return[];
    const mHeight=hMatch.cm/100;
    const bmi=Math.round((w.kg/(mHeight*mHeight))*10)/10;
    return[{ageMonths:w.ageMonths,val:bmi,date:w.date}];
  });

  return(
    <div style={{...S.card,padding:"16px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div>
          <div style={{fontWeight:700,fontSize:14}}>📈 Growth Charts</div>
          <div style={{color:"var(--text-label)",fontSize:11,marginTop:2}}>
            {useWHO?"WHO Standards (0–24 months)":"CDC Reference (2–20 years)"} · {sex==="male"?"Boys":"Girls"}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{textAlign:"right"}}>
            <div style={{color:"var(--text-primary)",fontSize:13,fontWeight:600}}>{age.display}</div>
            <div style={{color:"var(--text-label)",fontSize:11}}>{new Date(patient.dob).toLocaleDateString()}</div>
          </div>
          <Btn small col="#06b6d4" onClick={()=>setShowPrintModal(true)}>🖨 Print</Btn>
        </div>
      </div>

      {/* Vitals input widget */}
      <VitalsWidget key={patient.id} patient={patient} keys={keys} relay={relay} onSaved={()=>setRefreshTrigger(t=>t+1)}/>

      {/* Chart tabs */}
      <div style={{display:"flex",gap:4,marginBottom:12,borderBottom:"1px solid var(--border-subtle)",paddingBottom:0}}>
        {([["weight","⚖️ Weight"],["height","📏 Height"]] as [string,string][])
        .concat(useWHO?[["hc","📐 Head Circ"]]:[["bmi","🧮 BMI"],["hv","📈 Ht Velocity"]])
        .map(([id,label])=>(
          <button key={id} onClick={()=>setGrowthTab(id as any)} style={{
            padding:"7px 14px",border:"none",cursor:"pointer",fontFamily:"inherit",
            background:"transparent",
            borderBottom:growthTab===id?"2px solid var(--tab-active)":"2px solid transparent",
            color:growthTab===id?"var(--tab-active)":"var(--text-muted)",fontSize:12,fontWeight:growthTab===id?600:400,
          }}>{label}</button>
        ))}
      </div>

      <div ref={chartRef}>
      {growthTab==="weight"&&renderChart(
        curves,
        weightDots.map(d=>({...d,val:d.kg})),
        "#f97316","Weight (kg)",useWHO?"Age (months)":"Age (years)",useWHO?2:10,
        (kg)=>`${kg.toFixed(2)} kg / ${(kg*2.20462).toFixed(1)} lbs`
      )}
      {growthTab==="height"&&renderChart(
        useWHO?getWHOHeightCurves(sex):heightCurves,
        heightDots.map(d=>({...d,val:d.cm})),
        "#22d3ee","Height (cm)",useWHO?"Age (months)":"Age (years)",useWHO?5:10,
        (cm)=>`${cm.toFixed(1)} cm / ${(cm/2.54).toFixed(1)} in`
      )}
      {growthTab==="bmi"&&renderChart(
        bmiCurves,
        bmiDots,
        "#a78bfa","BMI","Age (years)",2
      )}
      {growthTab==="hc"&&useWHO&&renderChart(
        getWHOHCCurves(sex),
        hcDots.map(d=>({...d,val:d.cm})),
        "#f472b6","Head Circ (cm)","Age (months)",2,
        (cm)=>`${cm.toFixed(1)} cm / ${(cm/2.54).toFixed(1)} in`
      )}
      {growthTab==="hv"&&!useWHO&&renderChart(
        getHeightVelocityCurves(sex),
        hvDots,
        "#10b981","Growth Velocity (cm/yr)","Age (years)",1,
        (v)=>`${v.toFixed(1)} cm/yr`
      )}
      </div>

      {growthTab==="bmi"&&bmiDots.length===0&&(
        <div style={{color:"var(--text-label)",fontSize:12,textAlign:"center",padding:"8px 0"}}>
          BMI requires both weight and height recorded on the same visit
        </div>
      )}
      {growthTab==="hv"&&hvDots.length===0&&(
        <div style={{color:"var(--text-label)",fontSize:12,textAlign:"center",padding:"8px 0"}}>
          Height velocity requires at least 2 height measurements ≥3 months apart
        </div>
      )}

      <div style={{display:"flex",flexWrap:"wrap" as const,gap:12,marginTop:8}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{width:16,height:2,background:"#a78bfa"}}/>
          <span style={{color:"#a78bfa",fontSize:11}}>Current age ({age.display})</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{width:10,height:10,borderRadius:"50%",
            background:growthTab==="weight"?"#f97316":growthTab==="height"?"#22d3ee":growthTab==="hv"?"#10b981":growthTab==="hc"?"#f472b6":"#a78bfa",
            border:"2px solid #fff"}}/>
          <span style={{color:"var(--text-secondary)",fontSize:11}}>
            {growthTab==="weight"
              ?`${weightDots.length} weight measurement${weightDots.length!==1?"s":""}`
              :growthTab==="height"
              ?`${heightDots.length} height measurement${heightDots.length!==1?"s":""}`
              :growthTab==="hc"
              ?`${hcDots.length} head circ measurement${hcDots.length!==1?"s":""}`
              :growthTab==="hv"
              ?`${hvDots.length} velocity point${hvDots.length!==1?"s":""}`
              :`${bmiDots.length} BMI point${bmiDots.length!==1?"s":""}`}
          </span>
        </div>
      </div>

      {/* Print Modal */}
      {showPrintModal&&<>
        <div onClick={()=>setShowPrintModal(false)} style={{position:"fixed",inset:0,background:"var(--overlay)",zIndex:300}}/>
        <div style={{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
          background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:12,padding:20,
          minWidth:320,zIndex:301,boxShadow:"0 20px 60px var(--shadow-heavy)"}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:14}}>🖨 Print Growth Charts</div>
          <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:12}}>Select charts to include in the PDF:</div>
          {([
            ["weight","⚖️ Weight",weightDots.length>0],
            ["height","📏 Height",heightDots.length>0],
            ...(useWHO
              ?[["hc","📐 Head Circumference",hcDots.length>0] as [string,string,boolean]]
              :[["bmi","🧮 BMI",bmiDots.length>0] as [string,string,boolean],
                ["hv","📈 Height Velocity",hvDots.length>0] as [string,string,boolean]]),
          ] as [string,string,boolean][]).map(([id,label,hasData])=>(
            <label key={id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",
              fontSize:13,color:hasData?"var(--text-primary)":"var(--text-label)",cursor:"pointer"}}>
              <input type="checkbox" checked={!!printSelections[id]}
                onChange={e=>setPrintSelections(p=>({...p,[id]:e.target.checked}))}/>
              {label}
              {!hasData&&<span style={{fontSize:10,color:"var(--text-muted)"}}>(no data)</span>}
            </label>
          ))}
          <div style={{display:"flex",gap:8,marginTop:16,justifyContent:"flex-end"}}>
            <Btn small col="#64748b" onClick={()=>setShowPrintModal(false)}>Cancel</Btn>
            <Btn small solid col="#06b6d4" onClick={()=>{
              const sel=(Object.entries(printSelections).filter(([,v])=>v).map(([k])=>k)) as ("weight"|"height"|"bmi"|"hc"|"hv")[];
              if(sel.length>0)printAllCharts(sel);
              setShowPrintModal(false);
            }} disabled={!Object.values(printSelections).some(v=>v)}>
              Generate PDF
            </Btn>
          </div>
        </div>
      </>}
    </div>
  );
}

// ─── Add Patient Form ─────────────────────────────────────────────────────────
function AddPatientForm({onAdd,onCancel,keys,relay}:{onAdd:(p:Patient)=>void;onCancel:()=>void;keys:Keypair;relay:ReturnType<typeof useRelay>}){
  // Mode: "new" = practice generates keys, "existing" = patient brings npub
  const [mode,setMode]=useState<"new"|"existing">("new");
  const [form,setForm]=useState({
    name:"",dob:"",sex:"female" as Patient["sex"],
    phone:"",email:"",address:"",city:"",state:"",zip:"",
    existingNsec:"",npub:"",billingModel:"monthly",
    storeNsec:false
  });
  const [created,setCreated]=useState<Patient|null>(null);
  const [createdNsec,setCreatedNsec]=useState<string>("");
  const [npubError,setNpubError]=useState("");
  // Family mode state
  const [children,setChildren]=useState<{name:string;dob:string;sex:string}[]>([{name:"",dob:"",sex:"female"}]);
  const [familyCreated,setFamilyCreated]=useState<{parent:Patient;parentNsec:string;children:{patient:Patient;nsec:string}[]}|null>(null);
  const [familyProgress,setFamilyProgress]=useState("");
  const set=(k:string,v:string)=>setForm(f=>({...f,[k]:v}));
 
  const canSubmit = mode === "new"
    ? form.name.trim() && form.dob
    : mode === "existing"
    ? form.name.trim() && form.npub.trim().startsWith("npub1")
    : form.name.trim() && form.dob && children.every(c=>c.name.trim()&&c.dob);
 
  const handleCreate=async()=>{
    if(mode==="existing"){
      // ── Self-keyed patient: import by npub ──
      try{
        const patient=addPatientByNpub({
          name:form.name, dob:form.dob||undefined, sex:(form.sex as Patient["sex"])||undefined,
          phone:form.phone||undefined, email:form.email||undefined,
          address:form.address||undefined, city:form.city||undefined,
          state:form.state||undefined, zip:form.zip||undefined,
          npub:form.npub.trim(),
          billingModel:form.billingModel as "monthly",
        });
        setCreated(patient);
        publishPatientDemographics(patient, keys, relay);
        publishPatientGrantsForStaff(patient, keys, relay);
        publishPatientGrantForFhirAgent(patient, keys, relay);
      }catch(err){
        setNpubError(err instanceof Error ? err.message : "Invalid npub");
        return;
      }
    } else if(mode==="family"){
      // ── Family batch: parent + N children ──
      setFamilyProgress("Creating parent...");

      // Create parent (practice-keyed or self-keyed)
      let parentPatient:Patient;
      let parentNsec="";
      if(form.npub.trim().startsWith("npub1")){
        // Self-keyed parent
        try{
          parentPatient=addPatientByNpub({
            name:form.name, dob:form.dob||undefined, sex:(form.sex as Patient["sex"])||undefined,
            phone:form.phone||undefined, email:form.email||undefined,
            address:form.address||undefined, city:form.city||undefined,
            state:form.state||undefined, zip:form.zip||undefined,
            npub:form.npub.trim(), billingModel:form.billingModel as "monthly",
          });
        }catch(err){
          setNpubError(err instanceof Error?err.message:"Invalid npub");
          setFamilyProgress("");return;
        }
      }else{
        const result=addPatient({
          ...form, storeNsec:form.storeNsec, billingModel:form.billingModel as "monthly",
        });
        parentPatient=result.patient;
        parentNsec=result.nsec;
      }
      await publishPatientDemographics(parentPatient,keys,relay);
      publishPatientGrantsForStaff(parentPatient,keys,relay);
      publishPatientGrantForFhirAgent(parentPatient,keys,relay);

      // Create each child
      const createdChildren:{patient:Patient;nsec:string}[]=[];
      for(let i=0;i<children.length;i++){
        const c=children[i];
        setFamilyProgress(`Creating child ${i+1} of ${children.length}: ${c.name}...`);
        const childResult=addPatient({
          name:c.name, dob:c.dob, sex:(c.sex as Patient["sex"])||"unknown",
          phone:undefined, email:undefined,
          address:form.address||undefined, city:form.city||undefined,
          state:form.state||undefined, zip:form.zip||undefined,
          storeNsec:form.storeNsec, billingModel:form.billingModel as "monthly",
        });
        createdChildren.push(childResult);

        // Publish demographics
        await publishPatientDemographics(childResult.patient,keys,relay);
        publishPatientGrantsForStaff(childResult.patient,keys,relay);
        publishPatientGrantForFhirAgent(childResult.patient,keys,relay);

        // Link guardian
        setFamilyProgress(`Linking ${c.name} to ${form.name}...`);
        const all=loadPatients();
        const guardian=all.find(p=>p.id===parentPatient.id);
        const childRec=all.find(p=>p.id===childResult.patient.id);
        if(guardian&&childRec){
          const existing=guardian.guardianOf||[];
          if(!existing.includes(childResult.patient.id)) guardian.guardianOf=[...existing,childResult.patient.id];
          childRec.guardianNpub=parentPatient.npub;
          savePatients(all);
          parentPatient={...parentPatient,guardianOf:guardian.guardianOf};
        }

        // Publish guardian grant
        if(parentPatient.npub){
          const guardianPkHex=npubToHex(parentPatient.npub);
          await publishGuardianGrant(childResult.patient,guardianPkHex,keys,relay);
        }
      }

      setFamilyProgress("");
      setFamilyCreated({parent:parentPatient,parentNsec,children:createdChildren});
      return;
    } else {
      // ── Practice-keyed patient: generate or import keypair ──
      const { patient, nsec } = addPatient({
        ...form,
        storeNsec: form.storeNsec,
        billingModel: form.billingModel as "monthly",
      });
      setCreatedNsec(nsec);
      setCreated(patient);
      publishPatientDemographics(patient, keys, relay);
      publishPatientGrantsForStaff(patient, keys, relay);
      publishPatientGrantForFhirAgent(patient, keys, relay);
    }
  };
 
  // ── Post-creation card: practice-keyed patient (show nsec) ──
  if(created && created.keySource==="practice"){
    return(
      <div style={{...S.card,border:"1px solid var(--tint-green-border)",background:"var(--tint-green)"}}>
        <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:"var(--accent-green)"}}>✓ Patient Created</div>
        <div style={{marginBottom:16}}>
          <div style={{fontSize:13,color:"var(--text-primary)",marginBottom:4}}>{created.name}</div>
          <div style={{fontSize:11,color:"var(--text-secondary)"}}>DOB: {created.dob} • {"Monthly Member"}</div>
        </div>
        
        <div style={{...S.card,background:"var(--bg-app)",padding:12,marginTop:8}}>
          <div style={{fontSize:10,fontWeight:600,color:"#fbbf24",marginBottom:4}}>🔑 Access Code</div>
          <div style={{...S.mono,background:"var(--bg-card)",padding:8,fontSize:10,userSelect:"all" as const}}>{createdNsec}</div>
          <div style={{fontSize:9,color:"var(--text-label)",marginTop:4}}>npub: {created.npub?.substring(0,24)}...</div>
          <div style={{fontSize:10,color:created.nsecStored?"var(--accent-green)":"#f87171",fontStyle:"italic",marginTop:8}}>
            {created.nsecStored
              ? "✓ Access code stored locally (can be revealed in Portal Access panel)"
              : "⚠️ This code is shown once and will NOT be stored. If lost, use Re-key to generate a new one."}
          </div>
        </div>
 
        <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap" as const}}>
        <Btn solid col="#0ea5e9" onClick={()=>{
          if(!created.nsecStored && !confirm("Have you saved the patient's access code? It will not be shown again.")) return;
          onAdd(created);
        }}>Continue</Btn>
  
        <Btn col="#fbbf24" onClick={()=>{
          navigator.clipboard.writeText(`${created.name}\nnsec: ${createdNsec}\nnpub: ${created.npub||""}`);
          alert("Keys (nsec + npub) copied to clipboard");
        }}>📋 Copy Keys</Btn>
  
        <Btn col="#7dd3fc" onClick={()=>{
          navigator.clipboard.writeText(created.npub||"");
          alert(`Public key (npub) copied:\n${created.npub}\n\nAdd this to billing system.`);
        }}>📋 Copy npub</Btn>
        </div>
      </div>
    );
  }
 
  // ── Post-creation card: self-keyed patient (show connection string) ──
  if(created && created.keySource==="self"){
    const connectionString = JSON.stringify({
      practice_name: PRACTICE_NAME,
      relay: RELAY_URL,
      practice_pk: PRACTICE_PUBKEY,
      ...(BILLING_URL ? { billing_api: BILLING_URL } : {}),
      ...(CALENDAR_URL ? { calendar_api: CALENDAR_URL } : {}),
    }, null, 2);
 
    return(
      <div style={{...S.card,border:"1px solid var(--tint-green-border)",background:"var(--tint-green)"}}>
        <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:"var(--accent-green)"}}>✓ Patient Added</div>
        <div style={{marginBottom:16}}>
          <div style={{fontSize:13,color:"var(--text-primary)",marginBottom:4}}>{created.name}</div>
          <div style={{fontSize:11,color:"var(--text-secondary)"}}>
            npub: {created.npub?.substring(0,20)}... • {"Monthly Member"}
          </div>
        </div>
 
        <div style={{...S.card,background:"var(--bg-app)",padding:16}}>
          <div style={{fontWeight:600,fontSize:12,color:"var(--accent-blue)",marginBottom:8}}>
            🔗 Practice Connection String
          </div>
          <div style={{fontSize:10,color:"var(--text-secondary)",marginBottom:12}}>
            Give this to the patient so they can add your practice in their portal. They manage their own keys — no access code needed.
          </div>
          <div style={{...S.mono,background:"var(--bg-card)",padding:12,fontSize:9,marginBottom:12,userSelect:"all" as const,whiteSpace:"pre-wrap" as const,wordBreak:"break-all" as const}}>
            {connectionString}
          </div>
        </div>
 
        <div style={{display:"flex",gap:8,marginTop:16}}>
          <Btn solid col="#0ea5e9" onClick={()=>onAdd(created)}>Continue</Btn>
          <Btn col="#7dd3fc" onClick={()=>{
            navigator.clipboard.writeText(connectionString);
            alert("Connection string copied to clipboard");
          }}>📋 Copy Connection String</Btn>
          <Btn col="#7dd3fc" onClick={()=>{
            navigator.clipboard.writeText(created.npub||"");
            alert("npub copied to clipboard");
          }}>📋 Copy npub</Btn>
        </div>
      </div>
    );
  }
 
  // ── Post-creation card: family batch ──
  if(familyCreated){
    const allKeys=[
      ...(familyCreated.parentNsec?[{name:familyCreated.parent.name,role:"Parent",nsec:familyCreated.parentNsec,npub:familyCreated.parent.npub||""}]:[]),
      ...familyCreated.children.map(c=>({name:c.patient.name,role:"Child",nsec:c.nsec,npub:c.patient.npub||""})),
    ];
    const copyAll=()=>{
      const lines=allKeys.map(k=>`${k.name} (${k.role})\nnsec: ${k.nsec}\nnpub: ${k.npub}`).join("\n\n");
      navigator.clipboard.writeText(lines);
      alert("All keys copied to clipboard");
    };
    const selfKeyedParent=familyCreated.parent.keySource==="self";
    return(
      <div style={{...S.card,border:"1px solid var(--tint-green-border)",background:"var(--tint-green)"}}>
        <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:"var(--accent-green)"}}>✓ Family Created — {familyCreated.children.length} child{familyCreated.children.length>1?"ren":""}</div>

        {/* Parent */}
        <div style={{marginBottom:16}}>
          <div style={{fontSize:13,color:"var(--text-primary)",fontWeight:600}}>{familyCreated.parent.name} <span style={{fontSize:10,color:"var(--text-muted)"}}>(Parent{selfKeyedParent?" — self-keyed":""})</span></div>
          {selfKeyedParent?(
            <div style={{fontSize:10,color:"#7dd3fc",marginTop:4}}>npub: <span style={{fontFamily:"monospace"}}>{familyCreated.parent.npub?.substring(0,24)}...</span></div>
          ):(
            <div style={{...S.card,background:"var(--bg-app)",padding:12,marginTop:8}}>
              <div style={{fontSize:10,fontWeight:600,color:"#fbbf24",marginBottom:4}}>🔑 Parent Access Code</div>
              <div style={{...S.mono,background:"var(--bg-card)",padding:8,fontSize:10,userSelect:"all" as const}}>{familyCreated.parentNsec}</div>
              <div style={{fontSize:9,color:"var(--text-label)",marginTop:4}}>npub: {familyCreated.parent.npub?.substring(0,24)}...</div>
              <Btn small col="#fbbf24" style={{marginTop:6}} onClick={()=>{
                navigator.clipboard.writeText(`${familyCreated.parent.name}\nnsec: ${familyCreated.parentNsec}\nnpub: ${familyCreated.parent.npub||""}`);
                alert("Parent keys (nsec + npub) copied");
              }}>📋 Copy Keys</Btn>
            </div>
          )}
        </div>

        {/* Children */}
        {familyCreated.children.map((c,i)=>(
          <div key={c.patient.id} style={{marginBottom:12}}>
            <div style={{fontSize:12,color:"var(--text-primary)",fontWeight:600}}>{c.patient.name} <span style={{fontSize:10,color:"var(--text-muted)"}}>(Child • {c.patient.dob})</span></div>
            <div style={{...S.card,background:"var(--bg-app)",padding:12,marginTop:4}}>
              <div style={{fontSize:10,fontWeight:600,color:"#fbbf24",marginBottom:4}}>🔑 Access Code</div>
              <div style={{...S.mono,background:"var(--bg-card)",padding:8,fontSize:10,userSelect:"all" as const}}>{c.nsec}</div>
              <div style={{fontSize:9,color:"var(--text-label)",marginTop:4}}>npub: {c.patient.npub?.substring(0,24)}...</div>
              <Btn small col="#fbbf24" style={{marginTop:6}} onClick={()=>{
                navigator.clipboard.writeText(`${c.patient.name}\nnsec: ${c.nsec}\nnpub: ${c.patient.npub||""}`);
                alert(`${c.patient.name} keys (nsec + npub) copied`);
              }}>📋 Copy Keys</Btn>
            </div>
          </div>
        ))}

        <div style={{fontSize:10,color:form.storeNsec?"var(--accent-green)":"#f87171",fontStyle:"italic",marginBottom:12}}>
          {form.storeNsec
            ? "✓ Access codes stored locally (can be revealed in Portal Access panel)"
            : "⚠️ These codes are shown once and will NOT be stored. Save them now."}
        </div>

        <div style={{display:"flex",gap:8,flexWrap:"wrap" as const}}>
          <Btn solid col="#0ea5e9" onClick={()=>{
            if(!form.storeNsec && !confirm("Have you saved all access codes? They will not be shown again.")) return;
            onAdd(familyCreated.parent);
          }}>Open Parent Chart</Btn>
          <Btn col="#7c3aed" onClick={copyAll}>📋 Copy All Keys</Btn>
          <Btn col="#7dd3fc" onClick={()=>{
            const npubs=allKeys.map(k=>`${k.name}: ${k.npub}`).join("\n");
            navigator.clipboard.writeText(npubs);
            alert("All npubs copied — paste into billing system");
          }}>📋 Copy npubs for Billing</Btn>
        </div>
      </div>
    );
  }

  // ── The form ──
  return(
    <div style={{...S.card,border:"1px solid var(--border-accent)"}}>
      <div style={{fontWeight:700,fontSize:14,marginBottom:16}}>➕ Add New Patient</div>
 
      {/* Mode toggle */}
      <div style={{display:"flex",gap:0,marginBottom:16,borderRadius:8,overflow:"hidden",border:"1px solid var(--border)"}}>
        {([["new","New Patient"],["family","New Family"],["existing","Existing Nostr Patient"]] as const).map(([m,label])=>(
          <button key={m} onClick={()=>{setMode(m);setNpubError("");}} style={{
            flex:1,padding:"8px 12px",fontSize:12,fontWeight:600,
            background:mode===m?"var(--tab-selected-bg)":"var(--bg-app)",color:mode===m?"var(--tab-selected-text)":"var(--text-muted)",
            border:"none",cursor:"pointer",fontFamily:"inherit",
            transition:"all 0.15s",
          }}>{label}</button>
        ))}
 
      </div>
 
      {/* npub field (existing mode only) */}
      {mode==="existing"&&(
        <div style={{marginBottom:12,padding:12,background:"var(--bg-inset)",border:"1px solid var(--border-accent)",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--accent-blue)",marginBottom:8}}>
            🔑 Patient's Public Key
          </div>
          <div style={{fontSize:10,color:"var(--text-muted)",marginBottom:8}}>
            The patient provides their npub. You never need their secret key.
          </div>
          <textarea
            value={form.npub}
            onChange={e=>{set("npub",e.target.value);setNpubError("");}}
            placeholder="npub1..."
            rows={2}
            style={{...S.input,resize:"none",fontFamily:"monospace",fontSize:11}}
          />
          {npubError&&<div style={{color:"#f87171",fontSize:11,marginTop:6}}>{npubError}</div>}
        </div>
      )}
 
      {/* Demographics */}
      <div style={S.grid2}>
        <div>
          <label style={S.lbl}>Full Name *</label>
          <input value={form.name} onChange={e=>set("name",e.target.value)} style={S.input} placeholder="Last, First"/>
        </div>
        <div>
          <label style={S.lbl}>Date of Birth {mode==="new"?"*":""}</label>
          <input type="date" value={form.dob} onChange={e=>set("dob",e.target.value)} style={S.input}/>
        </div>
      </div>
      <div style={{...S.grid2,marginTop:10}}>
        <div>
          <label style={S.lbl}>Sex</label>
          <select value={form.sex} onChange={e=>set("sex",e.target.value)} style={{...S.input,cursor:"pointer"}}>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        <div>
          <label style={S.lbl}>Phone</label>
          <input value={form.phone} onChange={e=>{
            const digits=e.target.value.replace(/\D/g,"").slice(0,10);
            const formatted=digits.length>6?`(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`:digits.length>3?`(${digits.slice(0,3)}) ${digits.slice(3)}`:digits.length>0?`(${digits}`:"";
            set("phone",formatted);
          }} style={S.input} placeholder="(555) 000-0000"/>
        </div>
      </div>
      <div style={{marginTop:10}}>
        <label style={S.lbl}>Email</label>
        <input value={form.email} onChange={e=>set("email",e.target.value)} style={S.input} placeholder="patient@email.com"/>
      </div>
 
      {/* Existing nsec field (new mode only) */}
      {mode==="new"&&(
        <div style={{marginTop:16,padding:12,background:"var(--tint-purple)",border:"1px solid var(--tint-purple-border)",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--accent-purple)",marginBottom:8}}>
            🔑 Existing Patient Key (Optional)
          </div>
          <div style={{fontSize:10,color:"var(--accent-purple-sub)",marginBottom:8}}>
            If patient already has an nsec from billing, paste it here. Leave blank to generate new keys.
          </div>
          <textarea
            value={form.existingNsec}
            onChange={e=>set("existingNsec",e.target.value)}
            placeholder="nsec1... (optional)"
            rows={2}
            style={{...S.input,resize:"none",fontFamily:"monospace",fontSize:11}}
          />
        </div>
      )}
 
      {/* Store nsec checkbox (new mode only) */}
      {mode==="new"&&(
        <div style={{marginTop:12,display:"flex",alignItems:"center",gap:8}}>
          <input
            type="checkbox"
            checked={form.storeNsec}
            onChange={e=>setForm(f=>({...f,storeNsec:e.target.checked}))}
            id="storeNsec"
            style={{accentColor:"#f59e0b",width:16,height:16}}
          />
          <label htmlFor="storeNsec" style={{fontSize:11,color:"var(--text-secondary)",cursor:"pointer"}}>
            Store access code locally for recovery (less secure, more convenient)
          </label>
        </div>
      )}
 
      {/* Parent npub field (family mode — optional, for self-keyed parent) */}
      {mode==="family"&&(
        <div style={{marginTop:12,padding:12,background:"var(--bg-inset)",border:"1px solid var(--border-accent)",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--accent-blue)",marginBottom:4}}>
            🔑 Parent's Nostr Key (Optional)
          </div>
          <div style={{fontSize:10,color:"var(--text-muted)",marginBottom:8}}>
            If the parent already has an npub, paste it here. Leave blank to generate new keys.
          </div>
          <textarea
            value={form.npub}
            onChange={e=>{set("npub",e.target.value);setNpubError("");}}
            placeholder="npub1... (optional — leave blank to generate)"
            rows={2}
            style={{...S.input,resize:"none",fontFamily:"monospace",fontSize:11}}
          />
          {npubError&&<div style={{color:"#f87171",fontSize:11,marginTop:6}}>{npubError}</div>}
        </div>
      )}

      {/* Children (family mode) */}
      {mode==="family"&&(
        <div style={{marginTop:16,padding:12,background:"var(--tint-green)",border:"1px solid var(--tint-green-border)",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--accent-green)",marginBottom:10}}>
            👶 Children ({children.length})
          </div>
          {children.map((c,i)=>(
            <div key={i} style={{display:"flex",gap:8,alignItems:"end",marginBottom:8}}>
              <div style={{flex:2}}>
                {i===0&&<label style={S.lbl}>Name *</label>}
                <input value={c.name} onChange={e=>{const n=[...children];n[i]={...n[i],name:e.target.value};setChildren(n);}}
                  style={S.input} placeholder="Last, First"/>
              </div>
              <div style={{flex:1}}>
                {i===0&&<label style={S.lbl}>DOB *</label>}
                <input type="date" value={c.dob} onChange={e=>{const n=[...children];n[i]={...n[i],dob:e.target.value};setChildren(n);}}
                  style={S.input}/>
              </div>
              <div style={{flex:1}}>
                {i===0&&<label style={S.lbl}>Sex</label>}
                <select value={c.sex} onChange={e=>{const n=[...children];n[i]={...n[i],sex:e.target.value};setChildren(n);}}
                  style={{...S.input,cursor:"pointer"}}>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                </select>
              </div>
              {children.length>1&&(
                <button onClick={()=>setChildren(children.filter((_,j)=>j!==i))} style={{
                  background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:"6px",fontFamily:"inherit"
                }}>✕</button>
              )}
            </div>
          ))}
          <button onClick={()=>setChildren([...children,{name:"",dob:"",sex:"female"}])} style={{
            fontSize:11,color:"var(--accent-green)",background:"none",border:"1px dashed var(--tint-green-border)",borderRadius:6,
            padding:"6px 12px",cursor:"pointer",fontFamily:"inherit",marginTop:4,width:"100%"
          }}>+ Add Child</button>
        </div>
      )}

      {familyProgress&&(
        <div style={{marginTop:12,fontSize:11,color:"#fbbf24",fontStyle:"italic"}}>{familyProgress}</div>
      )}

      <div style={{marginTop:10}}>
        <label style={S.lbl}>Street Address</label>
        <input value={form.address} onChange={e=>set("address",e.target.value)} style={S.input} placeholder="123 Main St"/>
      </div>
      <div style={{...S.grid3,marginTop:10}}>
        <div>
          <label style={S.lbl}>City</label>
          <input value={form.city} onChange={e=>set("city",e.target.value)} style={S.input}/>
        </div>
        <div>
          <label style={S.lbl}>State</label>
          <input value={form.state} onChange={e=>set("state",e.target.value)} style={S.input} placeholder="CA"/>
        </div>
        <div>
          <label style={S.lbl}>ZIP</label>
          <input value={form.zip} onChange={e=>set("zip",e.target.value)} style={S.input} placeholder="90210"/>
        </div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:16}}>
        <Btn solid col="#0ea5e9" disabled={!canSubmit} onClick={handleCreate}>
          {mode==="family"?"Create Family":mode==="new"?"Add Patient":"Add Existing Patient"}
        </Btn>
        <Btn col="#475569" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

function LabSummaryCard({patient,keys,relay,onNavigate}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;
  onNavigate:(tab:"labs"|"orders")=>void;
}){
  const REVIEWED_KEY="nostr_ehr_lab_reviewed";
  const loadReviewed=():Set<string>=>{try{return new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY)||"[]"));}catch{return new Set();}};
  const [reviewed,setReviewed]=useState<Set<string>>(()=>loadReviewed());
  const [summary,setSummary]=useState<{pending:number;abnormal:number;critical:number;
    abnormalIds:string[];criticalIds:string[]}|null>(null);

  const markAllReviewed=(ids:string[])=>{
    const next=new Set(reviewed);
    ids.forEach(id=>next.add(id));
    localStorage.setItem(REVIEWED_KEY,JSON.stringify([...next]));
    setReviewed(next);
  };

  useEffect(()=>{
    if(!keys)return;
    let cleanup=()=>{};
    const p=cachedLoad({
      kinds:[FHIR_KINDS.ServiceRequest,FHIR_KINDS.DiagnosticReport],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        const orders=items.filter(d=>d.fhir.resourceType==="ServiceRequest"&&d.fhir.category==="lab");
        const reports=items.filter(d=>d.fhir.resourceType==="DiagnosticReport");
        const resultOrderIds=new Set(reports.map(r=>{
          const eTag=r.tags.find((t:string[])=>t[0]==="e"&&t[3]==="result");
          return eTag?eTag[1]:null;
        }).filter(Boolean));
        const cancelledIds=new Set(orders.filter(o=>
          o.tags.find((t:string[])=>t[0]==="e"&&t[3]==="cancelled")
        ).map(o=>o.eventId));
        const pending=orders.filter(o=>!resultOrderIds.has(o.eventId)&&!cancelledIds.has(o.eventId)).length;
        const abnormalIds=reports.filter(r=>r.fhir.interpretation==="abnormal").map(r=>r.eventId);
        const criticalIds=reports.filter(r=>r.fhir.interpretation==="critical").map(r=>r.eventId);
        setSummary({pending,abnormal:abnormalIds.length,critical:criticalIds.length,abnormalIds,criticalIds});
      },
      timeout:2000,
    });
    p.then(fn=>{if(fn)cleanup=fn;});
    return()=>{cleanup();p.then(fn=>{if(fn)fn();});};
  },[keys,relay.status,relay.syncTrigger,patient.id]);

  if(!summary)return null;
  const unrevCritical=summary.criticalIds.filter(id=>!reviewed.has(id));
  const unrevAbnormal=summary.abnormalIds.filter(id=>!reviewed.has(id));
  if(summary.pending===0&&unrevCritical.length===0&&unrevAbnormal.length===0)return null;

  return(
    <div style={{...S.card,marginBottom:16,borderLeft:"3px solid var(--accent-green)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontWeight:600,fontSize:13}}>🧪 Lab Results</div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {unrevCritical.length>0&&(
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <button onClick={()=>onNavigate("labs")}
                style={{background:"transparent",border:"none",cursor:"pointer",padding:0}}>
                <Badge t={`⚠ ${unrevCritical.length} critical`} col="#f87171" bg="var(--tint-red)"/>
              </button>
              <button onClick={(e)=>{e.stopPropagation();markAllReviewed(unrevCritical);}} title="Mark critical results reviewed"
                style={{background:"transparent",border:"1px solid var(--border)",color:"var(--accent-green)",
                  cursor:"pointer",fontSize:10,padding:"2px 6px",borderRadius:5,fontFamily:"inherit",lineHeight:1}}>
                ✓
              </button>
            </div>
          )}
          {unrevAbnormal.length>0&&(
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <button onClick={()=>onNavigate("labs")}
                style={{background:"transparent",border:"none",cursor:"pointer",padding:0}}>
                <Badge t={`${unrevAbnormal.length} abnormal`} col="#fbbf24" bg="var(--tint-amber)"/>
              </button>
              <button onClick={(e)=>{e.stopPropagation();markAllReviewed(unrevAbnormal);}} title="Mark abnormal results reviewed"
                style={{background:"transparent",border:"1px solid var(--border)",color:"var(--accent-green)",
                  cursor:"pointer",fontSize:10,padding:"2px 6px",borderRadius:5,fontFamily:"inherit",lineHeight:1}}>
                ✓
              </button>
            </div>
          )}
          {summary.pending>0&&(
            <button onClick={()=>onNavigate("orders")}
              style={{background:"transparent",border:"none",cursor:"pointer",padding:0}}>
              <Badge t={`${summary.pending} pending`} col="#f59e0b" bg="var(--tint-amber)"/>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BillingStatusCard({patient}:{patient:Patient}){
  const [billing,setBilling]=useState<any>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");

  useEffect(()=>{
    if(!patient.npub){
      setLoading(false);
      return;
    }
    
    setLoading(true);
    setError("");
    
    fetch(`${BILLING_URL}/api/patients/${patient.npub}`)
      .then(res => {
        console.log('Billing API Response Status:', res.status);
        if (!res.ok) {
          throw new Error(`API returned ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        console.log('Billing API Data:', data);
        // Check if we got an error object back
        if (data.error) {
          setError(data.error);
        } else {
          setBilling(data);
        }
        setLoading(false);
      })
      .catch(err => {
        console.error('Billing API Error:', err);
        setError("Could not load billing info");
        setLoading(false);
      });
  },[patient.npub]);

  if(!patient.npub)return null;
  
  if(loading)return(
    <div style={{...S.card,marginBottom:16}}>
      <div style={{color:"var(--text-muted)",fontSize:13}}>Loading billing status...</div>
    </div>
  );

  if(error)return(
    <div style={{...S.card,marginBottom:16,border:"1px solid var(--tint-amber-border)",background:"var(--tint-amber)"}}>
      <div style={{color:"#f59e0b",fontSize:13}}>⚠️ {error}</div>
    </div>
  );

  if(!billing)return null;

  const isLapsed=billing.status==="lapsed";
  const isDelinquent=billing.status==="delinquent";
  const statusColor=isLapsed?"#f87171":isDelinquent?"#f59e0b":"var(--accent-green)";
  const statusBg=isLapsed?"var(--tint-red)":isDelinquent?"var(--tint-amber)":"var(--tint-green)";
  const balance = typeof billing.balance === 'string' ? parseFloat(billing.balance) : billing.balance;
  const monthlyFee = typeof billing.monthlyFee === 'string' ? parseFloat(billing.monthlyFee) : billing.monthlyFee;

  return(
    <div style={{...S.card,marginBottom:16,border:`1px solid ${statusColor}`,background:statusBg}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:statusColor,marginBottom:4}}>
            💳 Billing Status: {isLapsed?"Lapsed":isDelinquent?"Payment Overdue":"Active Member"}
          </div>
          {(isLapsed || isDelinquent) && balance > 0 && (
            <div style={{color:isLapsed?"#f87171":"#f59e0b",fontSize:12,marginBottom:6}}>
              Outstanding Balance: ${balance.toFixed(2)}
            </div>
          )}
          <div style={{color:"var(--text-muted)",fontSize:11}}>
            Monthly Fee: ${monthlyFee?.toFixed(2) || "150.00"}
            {billing.lastPayment&&` • Last Payment: ${new Date(billing.lastPayment).toLocaleDateString()}`}
            {billing.memberSince&&` • Member Since: ${new Date(billing.memberSince).toLocaleDateString()}`}
          </div>
        </div>
        {billing.paymentUrl&&(
          <a href={billing.paymentUrl} target="_blank" rel="noopener noreferrer" style={{textDecoration:"none"}}>
            <Btn small solid col={statusColor}>
              {isLapsed||isDelinquent?"Pay Now":"View"}
            </Btn>
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Patient Demographics ─────────────────────────────────────────────────────
function DemographicsCard({patient,onUpdated,keys,relay}:{patient:Patient;onUpdated:(p:Patient)=>void;keys:Keypair;relay:ReturnType<typeof useRelay>}){
  const [editing,setEditing]=useState(false);
  const [form,setForm]=useState({...patient});
  useEffect(()=>{ setForm({...patient}); setEditing(false); },[patient.id]);
  const set=(k:string,v:string)=>setForm(f=>({...f,[k]:v}));
  const age=ageFromDob(patient.dob);
  const [showAccess,setShowAccess]=useState(false);
  const [rekeyNsec,setRekeyNsec]=useState("");

  if(editing) return(
    <div style={{...S.card,border:"1px solid var(--border-accent)"}}>
      <div style={{fontWeight:700,fontSize:14,marginBottom:14}}>✏️ Edit Demographics</div>
      <div style={S.grid2}>
        <div><label style={S.lbl}>Full Name</label>
          <input value={form.name} onChange={e=>set("name",e.target.value)} style={S.input}/></div>
        <div><label style={S.lbl}>Date of Birth</label>
          <input type="date" value={form.dob} onChange={e=>set("dob",e.target.value)} style={S.input}/></div>
      </div>
      <div style={{...S.grid2,marginTop:10}}>
        <div><label style={S.lbl}>Sex</label>
          <select value={form.sex} onChange={e=>set("sex",e.target.value)} style={{...S.input,cursor:"pointer"}}>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
            <option value="unknown">Unknown</option>
          </select></div>
        <div><label style={S.lbl}>Phone</label>
          <input value={form.phone||""} onChange={e=>set("phone",e.target.value)} style={S.input}/></div>
      </div>
      <div style={{marginTop:10}}>
        <label style={S.lbl}>Email</label>
        <input value={form.email||""} onChange={e=>set("email",e.target.value)} style={S.input}/>
      </div>
      <div style={{marginTop:10}}>
        <label style={S.lbl}>Street Address</label>
        <input value={form.address||""} onChange={e=>set("address",e.target.value)} style={S.input}/>
      </div>
      <div style={{...S.grid3,marginTop:10}}>
        <div><label style={S.lbl}>City</label>
          <input value={form.city||""} onChange={e=>set("city",e.target.value)} style={S.input}/></div>
        <div><label style={S.lbl}>State</label>
          <input value={form.state||""} onChange={e=>set("state",e.target.value)} style={S.input}/></div>
        <div><label style={S.lbl}>ZIP</label>
          <input value={form.zip||""} onChange={e=>set("zip",e.target.value)} style={S.input}/></div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:14}}>
        <Btn solid col="#0ea5e9" onClick={async()=>{
          updatePatient(form); onUpdated(form); setEditing(false);
          publishPatientDemographics(form, keys, relay);
          // If billing model changed, push to billing API
        }}>Save Changes</Btn>
        <Btn col="#475569" onClick={()=>{setForm({...patient});setEditing(false);}}>Cancel</Btn>
      </div>
    </div>
  );

  const rows=[
    ["Name",          patient.name],
    ["Date of Birth", `${patient.dob} (${age.display})`],
    ["Sex",           patient.sex.charAt(0).toUpperCase()+patient.sex.slice(1)],
    ["Phone",         patient.phone||"—"],
    ["Email",         patient.email||"—"],
    ["Address",       [patient.address,patient.city,patient.state,patient.zip].filter(Boolean).join(", ")||"—"],
    ["Patient ID",    patient.id],
  ];
  
  const handleRekey=async()=>{
    if(!canDo("admin")){alert("Re-key requires doctor/admin permission.");return;}
    if(!confirm(
      "⚠️ Re-key this patient? This will:\n\n"+
      "1. Generate a new keypair (new nsec + npub)\n"+
      "2. Re-encrypt ALL existing records for the new patient key\n"+
      "3. The old nsec will stop working for the portal\n"+
      "4. You must give the patient their new access code\n"+
      "5. The relay whitelist must be updated (old npub removed, new added)\n\n"+
      "This cannot be undone. Continue?"
    )) return;

    try {
      // Generate new keypair
      const newSk=generateSecretKey();
      const newPk=getPublicKey(newSk);
      const newNsec=nsecEncode(newSk);
      const newNpub=npubEncode(newPk);
      const newPkHex=toHex(newPk);
      const oldNpub=patient.npub;

      // Fetch all events for this patient from relay
      const oldPkHex=npubToHex(patient.npub!);
      const events:NostrEvent[]=[];
      await new Promise<void>((resolve)=>{
        const subId=relay.subscribe(
          {kinds:Object.values(FHIR_KINDS),"#p":[oldPkHex]},
          (ev:NostrEvent)=>events.push(ev),
        );
        setTimeout(()=>{try{relay.unsubscribe(subId);}catch{}resolve();},5000);
      });

      let reEncrypted=0;
      let skipped=0;

      for(const ev of events){
        try{
          // Decrypt practice-content (using practice self-encryption)
          const practiceContent=ev.tags.find((t:string[])=>t[0]==="patient-content");
          if(!practiceContent?.[1])continue;

          // Decrypt with OLD patient key (practice→patient shared secret)
          const oldSharedX=getSharedSecret(keys.sk,oldPkHex);
          const plaintext=await nip44Decrypt(practiceContent[1],oldSharedX);

          // Re-encrypt with NEW patient key
          const {practiceEncrypted,patientEncrypted}=await dualEncrypt(
            plaintext,keys.sk,keys.pkHex,newPkHex
          );

          // Build new tags — replace old patient pubkey and patient-content
          const newTags=ev.tags.map((t:string[])=>{
            if(t[0]==="p"&&t[1]===oldPkHex) return ["p",newPkHex];
            if(t[0]==="patient-content") return ["patient-content",patientEncrypted];
            if(t[0]==="pt") return t; // keep patient UUID the same
            return t;
          });

          // Publish as new event with updated encryption
          const newEvent=await buildAndSignEvent(ev.kind,practiceEncrypted,newTags,keys.sk);
          const ok=await relay.publish(newEvent);
          if(ok) reEncrypted++;
          else skipped++;
        } catch(err){
          console.warn("[rekey] Failed to re-encrypt event",ev.id,err);
          skipped++;
        }
      }

      // Update local patient record (npub only, no nsec)
      const updated={...patient,npub:newNpub};
      updatePatient(updated);
      onUpdated(updated);

      // Hold new nsec in memory for one-time display
      setRekeyNsec(newNsec);

      // Publish updated demographics with new keypair
      publishPatientDemographics(updated,keys,relay);

      // Re-publish patient key grants for staff (new patient pubkey)
      publishPatientGrantsForStaff(updated,keys,relay);

      // Re-grant FHIR reader agent access with new patient pubkey
      publishPatientGrantForFhirAgent(updated,keys,relay);

      // Re-publish guardian grants for any guardians of this child (new X₂)
      const guardians=loadPatients().filter(p=>p.guardianOf?.includes(patient.id));
      for(const g of guardians){
        if(g.npub) publishGuardianGrant(updated,npubToHex(g.npub),keys,relay);
      }

      // Update billing record + trigger whitelist sync
      let billingStatus="";
      try{
        const res=await fetch(`${BILLING_URL}/api/patients/rekey`,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({oldNpub,newNpub})
        });
        if(res.ok){
          const data=await res.json();
          billingStatus=`✅ Billing updated for ${data.patient||patient.name}. Whitelist sync triggered.`;
          console.log('[rekey] Billing updated + whitelist synced');
        } else {
          const err=await res.json().catch(()=>({error:"Unknown"}));
          billingStatus=`⚠️ Billing update failed: ${err.error}. Update npub manually in billing.`;
          console.warn('[rekey] Billing update failed:',err);
        }
      }catch(err){
        billingStatus="⚠️ Could not reach billing API. Update npub manually in billing and run sync-whitelist.sh.";
        console.warn('[rekey] Billing API unreachable:',err);
      }

      alert(
        `✅ Re-key complete for ${patient.name}\n\n`+
        `Re-encrypted: ${reEncrypted} events\n`+
        `Skipped: ${skipped} events\n\n`+
        `Old npub: ${oldNpub}\n`+
        `New npub: ${newNpub}\n\n`+
        `${billingStatus}\n\n`+
        `The new access code is shown in the Portal Access panel.\n`+
        `Give it to the patient — it will not be stored.`
      );
    } catch(err){
      alert("Re-key failed: "+(err instanceof Error?err.message:"Unknown error"));
    }
  };

  return(
    <div style={S.card}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:14}}>👤 Demographics</div>
        <div style={{display:"flex",gap:8}}>
          <Btn small onClick={()=>setShowAccess(!showAccess)} col="#fbbf24">
            {showAccess?"🔑 Hide Access":"🔑 Portal Access"}
          </Btn>
          {canDo("write")&&<Btn small onClick={()=>setEditing(true)} col="#475569">Edit</Btn>}
        </div>
      </div>

      {/* Portal Access section — toggled by showAccess */}
      {showAccess&&(
        <div style={{background:"#1a1a2e",border:"1px solid var(--border)",borderRadius:8,padding:12,marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:600,color:"#fbbf24",marginBottom:8}}>🔑 Portal Access</div>
 
          {/* Self-keyed patient: show connection string, no re-key */}
          {patient.keySource==="self"?(
            <>
              <div style={{fontSize:10,color:"var(--text-muted)",marginBottom:8}}>
                This patient manages their own keys. Share the connection string so they can add your practice in their portal.
              </div>
              <div style={{...S.mono,background:"var(--bg-app)",padding:10,fontSize:9,marginBottom:8,userSelect:"all" as const,whiteSpace:"pre-wrap" as const,wordBreak:"break-all" as const}}>
                {JSON.stringify({practice_name:PRACTICE_NAME,relay:RELAY_URL,practice_pk:PRACTICE_PUBKEY,...(BILLING_URL?{billing_api:BILLING_URL}:{}),...(CALENDAR_URL?{calendar_api:CALENDAR_URL}:{})},null,2)}
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap" as const,marginBottom:8}}>
                <Btn small solid col="#7dd3fc" onClick={()=>{
                  navigator.clipboard.writeText(JSON.stringify({practice_name:PRACTICE_NAME,relay:RELAY_URL,practice_pk:PRACTICE_PUBKEY,...(BILLING_URL?{billing_api:BILLING_URL}:{}),...(CALENDAR_URL?{calendar_api:CALENDAR_URL}:{})}));
                  alert("Connection string copied to clipboard");
                }}>📋 Copy Connection String</Btn>
                <Btn small solid col="#0ea5e9" onClick={()=>{
                  navigator.clipboard.writeText(patient.npub||"");
                  alert(`Public key (npub) copied:\n${patient.npub}`);
                }}>📋 Copy npub</Btn>
              </div>
            </>
          ):(
            <>
              {/* Practice-keyed patient: nsec management + re-key */}
              <div style={{fontSize:10,color:"var(--text-muted)",marginBottom:8}}>
                {patient.nsecStored
                  ? "Access code is stored locally. You can reveal it or clear it below."
                  : "Access code was not stored. Use Re-key if the patient needs a new one."}
              </div>
 
              {/* Reveal stored nsec — admin/practice owner only */}
              {patient.nsecStored && patient.nsec && canDo("admin") && (
                <div style={{background:"var(--tint-purple)",border:"1px solid var(--tint-purple-border)",borderRadius:8,padding:10,marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:600,color:"#c4b5fd",marginBottom:6}}>🔑 Stored Access Code</div>
                  <div style={{...S.mono,background:"var(--bg-app)",padding:10,fontSize:10,marginBottom:6,userSelect:"all" as const}}>
                    {patient.nsec}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <Btn small col="#7c3aed" onClick={()=>{
                      navigator.clipboard.writeText(patient.nsec||"");
                      alert("Access code (nsec) copied to clipboard");
                    }}>📋 Copy nsec</Btn>
                    <Btn small col="#f87171" onClick={()=>{
                      if(!confirm("Remove stored access code? The patient can still use it — it just won't be recoverable from the EHR anymore.")) return;
                      clearStoredNsec(patient.id);
                      onUpdated({...patient, nsec:undefined, nsecStored:false});
                    }}>🗑 Clear stored nsec</Btn>
                  </div>
                </div>
              )}
 
              {/* Show new nsec if re-key just happened */}
              {rekeyNsec&&(
                <div style={{background:"var(--tint-green)",border:"1px solid var(--tint-green-border)",borderRadius:8,padding:12,marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:600,color:"var(--accent-green)",marginBottom:6}}>🔑 New Access Code (copy now!)</div>
                  <div style={{...S.mono,background:"var(--bg-app)",padding:10,fontSize:10,marginBottom:6,userSelect:"all" as const}}>
                    {rekeyNsec}
                  </div>
                  <div style={{fontSize:10,color:"#f87171",fontStyle:"italic",marginBottom:8}}>
                    ⚠️ This will disappear when you leave this patient's chart.
                  </div>
                  <Btn small col="#475569" onClick={()=>{
                    navigator.clipboard.writeText(rekeyNsec);
                    alert("New access code (nsec) copied to clipboard");
                  }}>📋 Copy new nsec</Btn>
                </div>
              )}
 
              <div style={{display:"flex",gap:8,flexWrap:"wrap" as const,marginBottom:8}}>
                <Btn small solid col="#0ea5e9" onClick={()=>{
                  navigator.clipboard.writeText(patient.npub||"");
                  alert(`Public key (npub) copied:\n${patient.npub}\n\nUse this for billing system.`);
                }}>📋 Copy npub</Btn>
                <Btn small col="#f59e0b" onClick={handleRekey} disabled={!canDo("admin")} title="Generate a new keypair for this patient. Re-encrypts all their events with the new key and updates the relay whitelist.">
                  🔄 Re-key patient
                </Btn>
                {!canDo("admin")&&<span style={{fontSize:10,color:"var(--text-muted)"}}>Doctor only</span>}
              </div>
            </>
          )}
        </div>
      )}
      
      {rows.map(([k,v])=>(
        <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid var(--border-subtle)"}}>
          <span style={{color:"var(--text-label)",fontSize:12}}>{k}</span>
          <span style={{color:"var(--text-primary)",fontSize:12,fontWeight:500,textAlign:"right",maxWidth:"60%"}}>{v}</span>
        </div>
      ))}
 
      {/* ── Guardian / Family Links ── */}
      <GuardianSection patient={patient} onUpdated={onUpdated} keys={keys} relay={relay}/>
    </div>
  );
}

function GuardianSection({patient,onUpdated,keys,relay}:{patient:Patient;onUpdated:(p:Patient)=>void;keys:Keypair;relay:ReturnType<typeof useRelay>}){
  const [expanded,setExpanded]=useState(false);
  const [linking,setLinking]=useState(false);
  const [selectedChildId,setSelectedChildId]=useState("");
  const [publishing,setPublishing]=useState(false);
  const allPatients=useMemo(()=>loadPatients(),[patient.id]);

  const isGuardian=!!(patient.guardianOf&&patient.guardianOf.length>0);
  const guardianChildren=isGuardian ? allPatients.filter(p=>patient.guardianOf!.includes(p.id)) : [];
  const childGuardians=allPatients.filter(p=>p.guardianOf?.includes(patient.id));

  const linkableChildren=allPatients.filter(p=>
    p.id!==patient.id && p.npub && !(patient.guardianOf||[]).includes(p.id)
  );

  const handleLinkChild=async(childId:string)=>{
    if(!patient.npub||!canDo("admin")) return;
    const child=allPatients.find(p=>p.id===childId);
    if(!child?.npub) return;
    setPublishing(true);
    try{
      const guardianPkHex=npubToHex(patient.npub);
      const all=loadPatients();
      const guardian=all.find(p=>p.id===patient.id);
      const childRec=all.find(p=>p.id===childId);
      if(!guardian||!childRec) return;
      const existing=guardian.guardianOf||[];
      if(!existing.includes(childId)) guardian.guardianOf=[...existing,childId];
      childRec.guardianNpub=patient.npub;
      savePatients(all);
      const ok=await publishGuardianGrant(child,guardianPkHex,keys,relay);
      if(ok){
        onUpdated({...patient,guardianOf:guardian.guardianOf});
        setLinking(false);setSelectedChildId("");
      } else alert("Failed to publish guardian grant to relay");
    }catch(e){
      console.error("[Guardian] Link failed:",e);
      alert("Error linking guardian: "+(e instanceof Error?e.message:"unknown"));
    }finally{ setPublishing(false); }
  };

  const handleUnlinkChild=async(childId:string)=>{
    if(!canDo("admin")) return;
    if(!confirm("Remove guardian access to this patient? The guardian will no longer see this child's records in the portal.")) return;
    const all=loadPatients();
    const guardian=all.find(p=>p.id===patient.id);
    const childRec=all.find(p=>p.id===childId);
    if(guardian&&guardian.guardianOf){
      guardian.guardianOf=guardian.guardianOf.filter(id=>id!==childId);
      if(guardian.guardianOf.length===0) delete guardian.guardianOf;
    }
    if(childRec) delete childRec.guardianNpub;
    savePatients(all);
    onUpdated({...patient,guardianOf:guardian?.guardianOf});
  };

  const republishGrants=async()=>{
    if(!patient.npub||!patient.guardianOf?.length) return;
    setPublishing(true);
    const guardianPkHex=npubToHex(patient.npub);
    let ok=0;
    for(const childId of patient.guardianOf){
      const child=allPatients.find(p=>p.id===childId);
      if(child?.npub){ if(await publishGuardianGrant(child,guardianPkHex,keys,relay)) ok++; }
    }
    setPublishing(false);
    if(ok>0) alert(`Republished ${ok} guardian grant(s)`);
  };

  if(!isGuardian&&childGuardians.length===0&&!canDo("admin")) return null;

  return(
    <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid var(--border-subtle)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,cursor:"pointer"}}
        onClick={()=>setExpanded(!expanded)}>
        <div style={{fontWeight:600,fontSize:13,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:6}}>
          👨‍👩‍👧 Family Links
          {isGuardian&&<span style={{fontSize:10,background:"#164e63",color:"#22d3ee",padding:"1px 6px",borderRadius:10,fontWeight:600}}>{guardianChildren.length} child{guardianChildren.length!==1?"ren":""}</span>}
          {childGuardians.length>0&&<span style={{fontSize:10,background:"#1c1917",color:"#f59e0b",padding:"1px 6px",borderRadius:10,fontWeight:600}}>has guardian</span>}
        </div>
        <span style={{fontSize:12,color:"var(--text-label)"}}>{expanded?"▾":"▸"}</span>
      </div>
      {expanded&&(
        <div style={{fontSize:12}}>
          {isGuardian&&(
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:600,color:"var(--text-label)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Guardian of</div>
              {guardianChildren.map(child=>(
                <div key={child.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 8px",background:"var(--bg-app)",borderRadius:6,marginBottom:4}}>
                  <div>
                    <span style={{fontWeight:600,color:"var(--text-primary)"}}>{child.name}</span>
                    {child.dob&&<span style={{color:"var(--text-muted)",marginLeft:8,fontSize:11}}>{ageFromDob(child.dob).display}</span>}
                  </div>
                  {canDo("admin")&&<button onClick={()=>handleUnlinkChild(child.id)} style={{fontSize:10,color:"#ef4444",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit"}}>✕</button>}
                </div>
              ))}
              {canDo("admin")&&<button onClick={()=>republishGrants()} disabled={publishing} title="Re-publish ECDH guardian grants so this parent can decrypt their children's records. Use after a child re-key." style={{fontSize:10,color:"#6b7fa3",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",marginTop:4}}>{publishing?"Publishing...":"↻ Republish all guardian grants"}</button>}
            </div>
          )}
          {childGuardians.length>0&&(
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:600,color:"var(--text-label)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Guardian(s)</div>
              {childGuardians.map(g=>(
                <div key={g.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 8px",background:"var(--bg-app)",borderRadius:6,marginBottom:4}}>
                  <span style={{fontWeight:600,color:"var(--text-primary)"}}>{g.name}</span>
                  <span style={{fontSize:10,color:"#22d3ee",fontFamily:"'IBM Plex Mono',monospace"}}>{g.npub?.substring(0,20)}...</span>
                </div>
              ))}
            </div>
          )}
          {canDo("admin")&&(
            <div>
              {!linking?(
                <button onClick={()=>setLinking(true)} style={{fontSize:11,fontWeight:600,color:"#f7931a",background:"#f7931a10",border:"1px solid #f7931a40",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontFamily:"inherit"}}>+ Link child patient</button>
              ):(
                <div style={{background:"var(--bg-app)",border:"1px solid var(--border-accent)",borderRadius:8,padding:10}}>
                  <div style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",marginBottom:6}}>Select a patient to link as child:</div>
                  <select value={selectedChildId} onChange={e=>setSelectedChildId(e.target.value)} style={{width:"100%",padding:"6px 10px",borderRadius:6,border:"1px solid var(--border)",background:"var(--bg-card)",color:"var(--text-primary)",fontSize:12,fontFamily:"inherit",marginBottom:8,cursor:"pointer"}}>
                    <option value="">Choose patient...</option>
                    {linkableChildren.map(p=><option key={p.id} value={p.id}>{p.name}{p.dob?` (${ageFromDob(p.dob).display})`:""}</option>)}
                  </select>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{if(selectedChildId)handleLinkChild(selectedChildId);}} disabled={!selectedChildId||publishing} style={{flex:1,padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:700,background:selectedChildId?"#f7931a":"var(--border)",color:selectedChildId?"#fff":"var(--text-muted)",border:"none",cursor:selectedChildId?"pointer":"default",fontFamily:"inherit",opacity:publishing?0.5:1}}>{publishing?"Publishing grant...":"Link & Publish Grant"}</button>
                    <button onClick={()=>{setLinking(false);setSelectedChildId("");}} style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:500,background:"transparent",color:"var(--text-muted)",border:"1px solid var(--border)",cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Encounters Tab (upcoming appointments + encounter history) ───────────────
const CAL_API=CALENDAR_URL;

function fmtApptTime(t:string){
  const[h,m]=t.split(":").map(Number);
  return `${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`;
}
function fmtApptDate(ds:string){
  return new Date(ds+"T00:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
}

function UpcomingAppointments({patient}:{patient:Patient}){
  const [appts,setAppts]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    if(!patient.npub)return;
    fetch(`${CAL_API}/api/appointments/patient/${encodeURIComponent(patient.npub)}`)
      .then(r=>r.json())
      .then(data=>{
        const today=new Date().toISOString().split("T")[0];
        const upcoming=data
          .filter((a:any)=>["confirmed","pending"].includes(a.status)&&a.date>=today)
          .sort((a:any,b:any)=>a.date.localeCompare(b.date)||a.start_time.localeCompare(b.start_time));
        setAppts(upcoming);
        setLoading(false);
      })
      .catch(()=>setLoading(false));
  },[patient.npub]);

  const typeLabel=(t:string)=>({in_person:"In Person",phone:"Phone",video:"Video"}[t]||t);
  const statusColor=(s:string)=>s==="confirmed"?"#22c55e":s==="pending"?"#f59e0b":"var(--text-muted)";

  return(
    <div style={{...S.card,marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:14}}>📅 Upcoming Appointments</div>
        {!loading&&<Badge t={`${appts.length} scheduled`} col="#7dd3fc" bg="var(--bg-inset)"/>}
      </div>

      {loading&&<div style={{color:"var(--text-label)",fontSize:12,padding:"8px 0"}}>Loading appointments…</div>}

      {!loading&&appts.length===0&&(
        <div style={{color:"var(--text-faint)",fontSize:12,padding:"8px 0",textAlign:"center"}}>
          No upcoming appointments scheduled
        </div>
      )}

      {appts.map((a:any)=>(
        <div key={a.id} style={{
          background:"var(--bg-app)",border:"1px solid var(--border-subtle)",borderLeft:`3px solid ${statusColor(a.status)}`,
          borderRadius:8,padding:"12px 14px",marginBottom:8
        }}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontWeight:600,fontSize:13,marginBottom:3}}>
                {fmtApptDate(a.date)}
              </div>
              <div style={{color:"var(--text-muted)",fontSize:11}}>
                {fmtApptTime(a.start_time)} – {fmtApptTime(a.end_time)}
              </div>
              {a.notes&&<div style={{color:"var(--text-secondary)",fontSize:11,marginTop:4}}>{a.notes}</div>}
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
              <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,
                background:"var(--bg-card)",color:"#7dd3fc",textTransform:"uppercase"}}>
                {typeLabel(a.appt_type)}
              </span>
              <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,
                background:`${statusColor(a.status)}20`,color:statusColor(a.status),textTransform:"uppercase"}}>
                {a.status}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EncounterHistory({patient,keys,relay}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;
}){
  const [encounters,setEncounters]=useState<DecryptedEncounter[]>([]);
  const [loading,setLoading]=useState(false);
  const [open,setOpen]=useState<string|null>(null);
  const [verifying,setVerifying]=useState<string|null>(null);
  const [verifyResults,setVerifyResults]=useState<Record<string,{valid:boolean;computedId:string;idMatch:boolean;checkedAt:string}>>({});
  const [addendumTarget,setAddendumTarget]=useState<string|null>(null);
  const [addendumText,setAddendumText]=useState("");
  const [addendumSaving,setAddendumSaving]=useState(false);
  const [addendums,setAddendums]=useState<Record<string,{text:string;date:number;eventId:string}[]>>({});

  const load=useCallback(async()=>{
    if(!keys)return;
    setLoading(true);
    return cachedLoad({
      kinds:[FHIR_KINDS.Encounter],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        // Separate addendums from original encounters
        const originals:DecryptedEncounter[]=[];
        const addendumMap:Record<string,{text:string;date:number;eventId:string}[]>={};

        for(const i of items){
          const eTag=i.tags.find((t:string[])=>t[0]==="e"&&t[3]==="addendum");
          if(eTag){
            const parentId=eTag[1];
            if(!addendumMap[parentId])addendumMap[parentId]=[];
            addendumMap[parentId].push({
              text:i.fhir.note?.[0]?.text||"",
              date:i.created_at,
              eventId:i.eventId,
            });
          }else{
            const noteText=i.fhir.note?.[0]?.text||"";
            const chief=i.fhir.reasonCode?.[0]?.text||"Visit";
            originals.push({
              event:{id:i.eventId,created_at:i.created_at,pubkey:i.fhir._pubkey||"",kind:i.kind,content:i.fhir._content||"",tags:i.tags,sig:i.fhir._sig||""} as NostrEvent,
              fhir:i.fhir,note:noteText,chief
            });
          }
        }
        // Sort addendums by date
        for(const k of Object.keys(addendumMap)){
          addendumMap[k].sort((a,b)=>a.date-b.date);
        }
        originals.sort((a,b)=>b.event.created_at-a.event.created_at);
        setEncounters(originals);
        setAddendums(addendumMap);
        setLoading(false);
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{ setEncounters([]);setAddendums({}); },[patient.id]);
  useEffect(()=>{ let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})}; },[load]);

  // ── Verify signature by fetching the raw event from relay ──
  const handleVerify=async(enc:DecryptedEncounter)=>{
    if(!keys)return;
    setVerifying(enc.event.id);
    try{
      // Fetch the raw event from the relay by ID
      const rawEvent=await new Promise<NostrEvent|null>((resolve)=>{
        let found:NostrEvent|null=null;
        const subId=relay.subscribe(
          {ids:[enc.event.id]},
          (ev:NostrEvent)=>{found=ev;},
        );
        setTimeout(()=>{
          relay.unsubscribe(subId);
          resolve(found);
        },3000);
      });

      if(!rawEvent){
        setVerifyResults(prev=>({...prev,[enc.event.id]:{valid:false,computedId:"not found",idMatch:false,checkedAt:new Date().toLocaleString()}}));
        return;
      }

      const result=await verifyEvent(rawEvent);
      setVerifyResults(prev=>({...prev,[enc.event.id]:{
        ...result,
        checkedAt:new Date().toLocaleString(),
      }}));
    }catch{
      setVerifyResults(prev=>({...prev,[enc.event.id]:{valid:false,computedId:"error",idMatch:false,checkedAt:new Date().toLocaleString()}}));
    }finally{
      setVerifying(null);
    }
  };

  // ── Save addendum ──
  const saveAddendum=async(parentId:string)=>{
    if(!keys||!addendumText.trim())return;
    setAddendumSaving(true);
    try{
      const fhir=buildEncounter(patient.id,"Addendum",addendumText.trim());
      if(await publishClinicalEvent({kind:FHIR_KINDS.Encounter,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Encounter",keys,relay,
        extraTags:[["e",parentId,"","addendum"]]})){
        setAddendumTarget(null);
        setAddendumText("");
        load();
      }
    }finally{setAddendumSaving(false);}
  };

  const fmtDate=(ts:number)=>new Date(ts*1000).toLocaleDateString("en-US",{weekday:"short",year:"numeric",month:"short",day:"numeric"});
  const fmtTime=(ts:number)=>new Date(ts*1000).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});

  return(
    <div>
      <UpcomingAppointments patient={patient}/>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:14}}>📋 Encounter History</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {loading&&<span style={{color:"var(--text-label)",fontSize:11}}>Loading…</span>}
          <Badge t={`${encounters.length} visits`} col="#7dd3fc" bg="var(--bg-inset)"/>
          <Btn small onClick={load} col="#475569" disabled={loading||!keys}>
            ↻ Refresh
          </Btn>
        </div>
      </div>

      {encounters.length===0&&!loading&&(
        <div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:24}}>
          No encounters found for this patient yet
        </div>
      )}

      {encounters.map((enc,i)=>{
        const isOpen=open===enc.event.id;
        const vr=verifyResults[enc.event.id];
        const encAddendums=addendums[enc.event.id]||[];
        const isVerifying=verifying===enc.event.id;
        const isNurseNote=enc.event.tags?.some((t:string[])=>t[0]==="encounter-type"&&t[1]==="nurse-note");
        const authoredBy=enc.event.tags?.find((t:string[])=>t[0]==="authored-by")?.[2];

        return(
          <div key={enc.event.id} style={{...S.card,borderLeft:`3px solid ${isNurseNote?"#38bdf8":vr?.valid?"#22c55e":"#0ea5e9"}`,
            animation:i===0?"fadeIn 0.3s ease":"none"}}>

            {/* Header row */}
            <div style={{display:"flex",justifyContent:"space-between",cursor:"pointer"}}
              onClick={()=>setOpen(o=>o===enc.event.id?null:enc.event.id)}>
              <div>
                <div style={{fontWeight:600,fontSize:13,marginBottom:3}}>{enc.chief}{authoredBy?` — ${authoredBy}`:""}</div>
                <div style={{color:"var(--text-label)",fontSize:11}}>
                  {fmtDate(enc.event.created_at)} · {fmtTime(enc.event.created_at)}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {vr?.valid&&<Badge t="✓ verified" col="var(--accent-green)" bg="var(--tint-green)"/>}
                {vr&&!vr.valid&&<Badge t="✗ invalid" col="#f87171" bg="var(--tint-red)"/>}
                {encAddendums.length>0&&<Badge t={`${encAddendums.length} addendum${encAddendums.length>1?"s":""}`} col="#fbbf24" bg="#1c1a05"/>}
                {isNurseNote
                  ?<Badge t="📋 note" col="#38bdf8" bg="var(--bg-inset)"/>
                  :<Badge t="🔒 signed" col="#a78bfa" bg="var(--tint-purple)"/>}
                <span style={{color:"var(--text-faint)"}}>{isOpen?"▲":"▼"}</span>
              </div>
            </div>

            {/* Expanded view */}
            {isOpen&&(
              <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--border-subtle)"}}>

                {/* Note content */}
                <div style={{background:"var(--bg-deep)",borderRadius:8,padding:"12px 14px",
                  color:"var(--text-secondary)",fontSize:12,lineHeight:1.9,whiteSpace:"pre-wrap",fontFamily:"monospace"}}>
                  {enc.note||"No note content"}
                </div>

                {/* Addendums */}
                {encAddendums.map((add,ai)=>(
                  <div key={add.eventId} style={{marginTop:8,background:"var(--bg-inset)",borderRadius:8,
                    padding:"10px 14px",borderLeft:"3px solid #fbbf24"}}>
                    <div style={{fontSize:10,color:"#fbbf24",fontWeight:600,marginBottom:4}}>
                      ADDENDUM — {fmtDate(add.date)} · {fmtTime(add.date)}
                    </div>
                    <div style={{color:"var(--text-secondary)",fontSize:12,lineHeight:1.7,whiteSpace:"pre-wrap",fontFamily:"monospace"}}>
                      {add.text}
                    </div>
                  </div>
                ))}

                {/* Action buttons */}
                <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
                  <Btn small col={vr?.valid?"#22c55e":"#7c3aed"}
                    onClick={(e:React.MouseEvent)=>{e.stopPropagation();handleVerify(enc);}}
                    disabled={isVerifying}>
                    {isVerifying?"⏳ Verifying…":vr?.valid?"✓ Re-verify":"🔐 Verify Signature"}
                  </Btn>
                  <Btn small col="#f59e0b"
                    onClick={(e:React.MouseEvent)=>{e.stopPropagation();setAddendumTarget(t=>t===enc.event.id?null:enc.event.id);setAddendumText("");}}>
                    {addendumTarget===enc.event.id?"Cancel":"+ Addendum"}
                  </Btn>
                </div>

                {/* Addendum input */}
                {addendumTarget===enc.event.id&&(
                  <div style={{marginTop:8,padding:10,background:"var(--bg-app)",borderRadius:8,border:"1px solid #fbbf2440"}}>
                    <div style={{fontSize:11,color:"#fbbf24",fontWeight:600,marginBottom:6}}>
                      Append Addendum (original note remains immutable)
                    </div>
                    <textarea value={addendumText} onChange={e=>setAddendumText(e.target.value)}
                      style={{...S.input,minHeight:80,fontFamily:"monospace",fontSize:12}}
                      placeholder="Type addendum text…"/>
                    <div style={{display:"flex",gap:8,marginTop:6}}>
                      <Btn small solid col="#f59e0b" disabled={addendumSaving||!addendumText.trim()}
                        onClick={()=>saveAddendum(enc.event.id)}>
                        {addendumSaving?"⏳ Saving…":"Sign & Publish Addendum"}
                      </Btn>
                    </div>
                  </div>
                )}

                {/* Signature verification panel */}
                {vr&&(
                  <div style={{marginTop:10,padding:"10px 12px",background:vr.valid?"var(--tint-green)":"var(--tint-red)",
                    borderRadius:8,border:`1px solid ${vr.valid?"var(--tint-green-border)":"var(--tint-red-border)"}`}}>
                    <div style={{fontSize:11,fontWeight:600,color:vr.valid?"var(--accent-green)":"#f87171",marginBottom:6}}>
                      {vr.valid?"✓ Cryptographic Signature Valid":"✗ Signature Verification Failed"}
                    </div>
                    <div style={{fontSize:10,color:"var(--text-secondary)",lineHeight:1.8,fontFamily:"monospace"}}>
                      <div>Event ID: {enc.event.id}</div>
                      <div>Computed: {vr.computedId}</div>
                      <div>ID Match: {vr.idMatch?"✓ yes":"✗ no"}</div>
                      <div>Signed by: {enc.event.pubkey||"(from relay)"}</div>
                      <div>Signed at: {fmtDate(enc.event.created_at)} {fmtTime(enc.event.created_at)}</div>
                      <div>Verified: {vr.checkedAt}</div>
                    </div>
                    {vr.valid&&(
                      <div style={{marginTop:6,fontSize:10,color:"#22c55e90"}}>
                        This note has not been altered since it was signed. The SHA-256 hash
                        of the serialized event matches the event ID, and the Schnorr signature
                        is valid for the signing pubkey.
                      </div>
                    )}
                  </div>
                )}

                {/* Event metadata (always shown) */}
                <div style={{marginTop:8,color:"var(--text-faint)",fontSize:10}}>
                  Event ID: {enc.event.id.slice(0,32)}… · Signed {fmtDate(enc.event.created_at)}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// ─── Dot Phrases / Text Templates ────────────────────────────────────────────

const DOT_PHRASES_KEY = "nostr_ehr_dot_phrases";

interface DotPhrase {
  trigger: string;
  label: string;
  body: string;
  builtin?: boolean;
}

const BUILTIN_DOT_PHRASES: DotPhrase[] = [
  {trigger:"wellchild",label:"Well Child Visit",builtin:true,body:`Date: {{today}}\nCC: Well child visit\n\nS:\nHere for routine well child check. {{patient.name}} is a {{patient.age}} {{patient.sex}}.\nParent reports child is doing well. No concerns.\nDiet: \nSleep: \nDevelopment: meeting milestones\nSchool/Social: \n\nROS: negative except as noted above\n\nO:\n  General: Well-appearing, active, in no distress\n  HEENT: NC/AT, PERRL, TMs clear bilaterally, oropharynx clear\n  Neck: Supple, no lymphadenopathy\n  Lungs: CTA bilaterally, no wheezing/crackles\n  CV: RRR, no murmur, normal S1/S2\n  Abdomen: Soft, NT/ND, +BS, no organomegaly\n  GU: Normal external genitalia, Tanner stage \n  Extremities: Full ROM, no edema\n  Skin: Clear, no rashes\n  Neuro: Alert, appropriate for age\n  Musculoskeletal: Normal gait, symmetric\n\nA:\nWell child visit — Z00.129\n\nP:\n- Anticipatory guidance provided\n- Vaccines given per schedule\n- Continue current diet/nutrition plan\n- Follow up: routine well child visit`},
  {trigger:"newborn",label:"Newborn Visit",builtin:true,body:`Date: {{today}}\nCC: Newborn visit\n\nS:\n{{patient.name}} is a {{patient.age}} presenting for newborn visit.\nBorn: \nDelivery: \nBirth weight: \nFeeding: breast / formula / mixed\nFeeding frequency: every  hours\nWet diapers/day: \nStools/day: \nJaundice: none noted / \nUmbilical cord: \nSleep: on back, own sleep surface\n\nParent concerns: none\n\nO:\n  General: Well-appearing newborn, appropriate tone and activity\n  HEENT: AF open/flat, no caput/cephalohematoma, red reflex present bilaterally, palate intact, nares patent\n  Neck: Supple, no masses\n  Lungs: CTA bilaterally, no grunting/flaring/retracting\n  CV: RRR, no murmur, femoral pulses equal bilaterally\n  Abdomen: Soft, NT/ND, cord attached/healing, no hernias\n  GU: Normal external genitalia\n  Hips: Ortolani/Barlow negative bilaterally\n  Skin: No jaundice / mild jaundice, no rashes\n  Neuro: Normal tone, Moro intact, suck/root present\n\nA:\nRoutine newborn care — Z00.110\n\nP:\n- Feeding: continue current, watch for hunger cues\n- Vitamin D supplementation 400 IU daily (if breastfed)\n- Cord care: keep dry, fold diaper below\n- Safe sleep counseling: back to sleep, no co-sleeping\n- Newborn screening: sent / results pending\n- Follow up: `},
  {trigger:"sick",label:"Sick Visit",builtin:true,body:`Date: {{today}}\nCC: \n\nS:\n{{patient.name}} is a {{patient.age}} {{patient.sex}} presenting with .\nOnset: \nDuration: \nAssociated symptoms: \nFever: Y/N, Tmax \nAppetite: \nActivity level: \nSick contacts: \nCurrent medications tried: \n\nROS: negative except as noted above\n\nO:\n  General: \n  HEENT: \n  Neck: \n  Lungs: \n  CV: RRR, no murmur\n  Abdomen: \n  Skin: \n\nA:\n\n\nP:\n- \n- Return precautions: worsening symptoms, high fever >5 days, difficulty breathing, dehydration signs\n- Follow up: PRN / `},
  {trigger:"adhd",label:"ADHD Follow-Up",builtin:true,body:`Date: {{today}}\nCC: ADHD follow-up\n\nS:\n{{patient.name}} is a {{patient.age}} {{patient.sex}} here for ADHD follow-up.\nCurrent medication: \nParent report: \nTeacher report/feedback: \nGrades: \nBehavior at home: \nSleep: \nAppetite: \nSide effects: none reported / \nVanderbilt scores: Parent  / Teacher \n\nO:\n  General: Well-appearing, appropriate behavior for age\n  Vitals: Wt  Ht  HR  BP \n  Psych: \n\nA:\nADHD — F90.\n\nP:\n- Continue / adjust medication: \n- Side effect monitoring: appetite, sleep, mood\n- Repeat Vanderbilt in  months\n- Follow up: `},
  {trigger:"asthma",label:"Asthma Follow-Up",builtin:true,body:`Date: {{today}}\nCC: Asthma follow-up\n\nS:\n{{patient.name}} is a {{patient.age}} {{patient.sex}} here for asthma follow-up.\nCurrent controller: \nRescue inhaler use: x/week\nNighttime symptoms: x/month\nActivity limitation: none / \nMissed school days: \nED visits / hospitalizations since last visit: \nTriggers: \nACT/cACT score: \n\nO:\n  General: Well-appearing, no respiratory distress\n  Lungs: CTA bilaterally / wheezing noted , good air movement\n  CV: RRR\n  Skin: No eczema flare\n\nA:\nAsthma, persistent — J45.\nCurrent control: well-controlled / not well-controlled / very poorly controlled\n\nP:\n- Continue / step up / step down: \n- Rescue: albuterol PRN\n- Asthma action plan reviewed: Y/N\n- Trigger avoidance counseling\n- Follow up: `},
  {trigger:"sports",label:"Sports Physical / PPE",builtin:true,body:`Date: {{today}}\nCC: Sports physical (PPE)\n\nS:\n{{patient.name}} is a {{patient.age}} {{patient.sex}} presenting for pre-participation sports exam.\nSport(s): \nHistory of: syncope/near-syncope, chest pain with exertion, palpitations, shortness of breath, dizziness, seizures — DENIED\nPrior concussions: \nPrior musculoskeletal injuries: \nFamily history: sudden cardiac death <50, cardiomyopathy, Marfan, long QT — DENIED\nMedications: \n\nO:\n  General: Well-appearing, athletic build\n  HEENT: PERRL, TMs clear, oropharynx normal\n  CV: RRR, no murmur standing and supine, normal S1/S2, no clicks\n  Lungs: CTA bilaterally\n  Abdomen: Soft, no organomegaly\n  MSK: Full ROM all joints, symmetric strength, negative valgus/varus, negative Lachman, negative anterior/posterior drawer, negative McMurray bilaterally\n  Skin: No concerning lesions\n  Neuro: CN II-XII intact, normal gait, Romberg negative\n\nA:\nSports physical — Z02.5\nCLEARED for full participation without restriction.\n\nP:\n- Cleared for: all sports\n- Restrictions: none\n- Discuss: hydration, nutrition, concussion awareness, protective equipment`},
  {trigger:"ear",label:"Ear Infection / AOM",builtin:true,body:`Date: {{today}}\nCC: Ear pain\n\nS:\n{{patient.name}} is a {{patient.age}} {{patient.sex}} presenting with ear pain.\nOnset: \nSide: R / L / bilateral\nFever: \nURI symptoms: \nEar drainage: \nPrior ear infections: \nTubes: N\n\nO:\n  General: \n  TMs: R:  L: \n  Oropharynx: \n  Neck: no lymphadenopathy / \n  Lungs: CTA\n\nA:\nAcute otitis media,  ear — H66.9\n\nP:\n- Amoxicillin 80-90 mg/kg/day divided BID x 10 days\n  OR watchful waiting (>2yo, unilateral, non-severe)\n- Ibuprofen/acetaminophen PRN for pain\n- Return if: no improvement in 48-72 hours, high fever, worsening symptoms\n- Follow up: PRN / recheck in  weeks if needed`},
  {trigger:"uti",label:"UTI",builtin:true,body:`Date: {{today}}\nCC: Urinary symptoms\n\nS:\n{{patient.name}} is a {{patient.age}} {{patient.sex}} presenting with .\nDysuria: \nFrequency: \nUrgency: \nFever: \nAbdominal/flank pain: \nHematuria: \nPrior UTIs: \nConstipation: \n\nO:\n  General: \n  Abdomen: Soft, ? suprapubic tenderness, no CVA tenderness\n  GU: Normal external genitalia, no discharge\n  UA: \n\nA:\nUrinary tract infection — N39.0\n\nP:\n- Urine culture sent\n- Start: \n- Encourage fluids\n- Follow up: with culture results / `},
  {trigger:"hpi",label:"HPI Template",builtin:true,body:`{{patient.name}} is a {{patient.age}} {{patient.sex}} who presents with .\nOnset: \nLocation: \nDuration: \nCharacter: \nAggravating factors: \nRelieving factors: \nTiming: \nSeverity: /10\nAssociated symptoms: `},
  {trigger:"pe",label:"Complete Physical Exam",builtin:true,body:`  General: Well-appearing, in no acute distress\n  HEENT: NC/AT, PERRL, TMs clear bilaterally, oropharynx clear, mucous membranes moist\n  Neck: Supple, no lymphadenopathy, no thyromegaly\n  Lungs: CTA bilaterally, no wheezing/crackles/rhonchi, no retractions\n  CV: RRR, no murmur/gallop/rub, normal S1/S2, cap refill <2 sec\n  Abdomen: Soft, NT/ND, +BS, no organomegaly, no masses\n  GU: Normal external genitalia\n  Extremities: Full ROM, no edema, no cyanosis\n  Skin: Warm, dry, no rashes or lesions\n  Neuro: Alert, oriented, CN II-XII grossly intact, normal tone and strength\n  Psych: Appropriate mood and affect`},
  {trigger:"ros",label:"Review of Systems (Negative)",builtin:true,body:`ROS: Constitutional: no fever, weight change, fatigue. HEENT: no headache, vision changes, hearing loss, rhinorrhea, sore throat. CV: no chest pain, palpitations, syncope. Resp: no cough, SOB, wheezing. GI: no nausea, vomiting, diarrhea, constipation, abdominal pain. GU: no dysuria, frequency, discharge. MSK: no joint pain, swelling, weakness. Skin: no rashes, lesions. Neuro: no dizziness, numbness, tingling, seizures. Psych: no depression, anxiety, sleep disturbance.`},
  {trigger:"counseling",label:"Anticipatory Guidance",builtin:true,body:`Anticipatory guidance provided:\n- Safety: \n- Nutrition: \n- Sleep: \n- Development: \n- Screen time: \n- Physical activity: \n- Dental: brushing 2x daily, dentist visits\n- Behavioral: `},
];

function loadDotPhrases(): DotPhrase[] {
  try {
    const raw = localStorage.getItem(DOT_PHRASES_KEY);
    const custom: DotPhrase[] = raw ? JSON.parse(raw) : [];
    const customTriggers = new Set(custom.map(c => c.trigger));
    return [
      ...BUILTIN_DOT_PHRASES.filter(b => !customTriggers.has(b.trigger)),
      ...custom,
    ];
  } catch { return [...BUILTIN_DOT_PHRASES]; }
}

function saveDotPhrases(phrases: DotPhrase[]): void {
  const toSave = phrases.filter(p => !p.builtin);
  localStorage.setItem(DOT_PHRASES_KEY, JSON.stringify(toSave));
}

function expandDotPhrase(body: string, patient: Patient): string {
  const age = ageFromDob(patient.dob);
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  return body
    .replace(/\{\{patient\.name\}\}/g, patient.name)
    .replace(/\{\{patient\.age\}\}/g, age.display)
    .replace(/\{\{patient\.dob\}\}/g, patient.dob)
    .replace(/\{\{patient\.sex\}\}/g, patient.sex)
    .replace(/\{\{today\}\}/g, today);
}

function DotPhrasePopup({ query, position, onSelect, onClose }: {
  query: string;
  position: { top: number; left: number };
  onSelect: (phrase: DotPhrase) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const phrases = loadDotPhrases();
  const matches = query
    ? phrases.filter(p => p.trigger.startsWith(query.toLowerCase()) || p.label.toLowerCase().includes(query.toLowerCase()))
    : phrases;

  useEffect(() => { setSelected(0); }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.min(s + 1, matches.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
      else if ((e.key === "Tab" || e.key === "Enter") && matches.length > 0) { e.preventDefault(); onSelect(matches[selected]); }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [matches, selected, onSelect, onClose]);

  if (matches.length === 0) return null;

  return (
    <div style={{
      position: "fixed", top: position.top, left: position.left, zIndex: 1000,
      background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
      maxHeight: 240, overflowY: "auto", minWidth: 280, maxWidth: 400,
      boxShadow: "0 4px 16px var(--shadow-heavy)", fontSize: 12,
    }}>
      <div style={{ padding: "6px 10px", color: "var(--text-label)", fontSize: 10, borderBottom: "1px solid var(--border)", fontWeight: 600 }}>
        DOT PHRASES — Tab/Enter to expand, Esc to close
      </div>
      {matches.map((p, i) => (
        <div key={p.trigger} onClick={() => onSelect(p)}
          style={{
            padding: "7px 10px", cursor: "pointer",
            background: i === selected ? "var(--bg-hover)" : "transparent",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            borderBottom: "1px solid var(--border-subtle)",
          }}
          onMouseEnter={() => setSelected(i)}
        >
          <div>
            <span style={{ color: "#0ea5e9", fontFamily: "monospace" }}>.{p.trigger}</span>
            <span style={{ color: "var(--text-secondary)", marginLeft: 8 }}>{p.label}</span>
          </div>
          {p.builtin && <span style={{ color: "var(--text-faint)", fontSize: 9 }}>BUILT-IN</span>}
        </div>
      ))}
    </div>
  );
}

function DotPhraseManager() {
  const [phrases, setPhrases] = useState<DotPhrase[]>(() => loadDotPhrases());
  const [editing, setEditing] = useState<DotPhrase | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ trigger: "", label: "", body: "" });
  const [expanded, setExpanded] = useState<string | null>(null);

  const saveNew = () => {
    if (!form.trigger.trim() || !form.body.trim()) return;
    const clean = form.trigger.toLowerCase().replace(/[^a-z0-9]/g, "");
    const newPhrase: DotPhrase = { trigger: clean, label: form.label || clean, body: form.body, builtin: false };
    const updated = [...phrases.filter(p => p.trigger !== clean), newPhrase];
    saveDotPhrases(updated.filter(p => !p.builtin));
    setPhrases(loadDotPhrases());
    setForm({ trigger: "", label: "", body: "" });
    setCreating(false);
  };

  const saveEdit = () => {
    if (!editing || !form.body.trim()) return;
    const updated = phrases.map(p =>
      p.trigger === editing.trigger ? { ...p, label: form.label || p.label, body: form.body, builtin: false } : p
    );
    saveDotPhrases(updated.filter(p => !p.builtin));
    setPhrases(loadDotPhrases());
    setEditing(null);
  };

  const deletePhrase = (trigger: string) => {
    const updated = phrases.filter(p => p.trigger !== trigger);
    saveDotPhrases(updated.filter(p => !p.builtin));
    setPhrases(loadDotPhrases());
  };

  const resetBuiltin = (trigger: string) => {
    const custom = phrases.filter(p => !p.builtin && p.trigger !== trigger);
    saveDotPhrases(custom);
    setPhrases(loadDotPhrases());
  };

  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>⚡ Dot Phrases</div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>Type <span style={{ fontFamily: "monospace", color: "#0ea5e9" }}>.trigger</span> in any note to expand templates</div>
        </div>
        <Btn small solid={!creating} col="#0ea5e9" onClick={() => { setCreating(!creating); setEditing(null); }}>
          {creating ? "Cancel" : "+ New Phrase"}
        </Btn>
      </div>
      {creating && (
        <div style={{ background: "var(--bg-app)", borderRadius: 8, padding: 12, marginBottom: 12, border: "1px solid var(--border)" }}>
          <div style={S.grid2}>
            <div><label style={S.lbl}>Trigger (no dot)</label><input value={form.trigger} onChange={e => setForm(f => ({ ...f, trigger: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") }))} style={S.input} placeholder="e.g. earinfection" /></div>
            <div><label style={S.lbl}>Label</label><input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} style={S.input} placeholder="e.g. Ear Infection Visit" /></div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={S.lbl}>Template Body</label>
            <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} rows={10} style={{ ...S.input, resize: "vertical" as const, fontFamily: "monospace", fontSize: 11, lineHeight: 1.6 }} placeholder={"Variables: {{patient.name}}, {{patient.age}}, {{patient.sex}}, {{patient.dob}}, {{today}}"} />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}><Btn small solid col="#0ea5e9" onClick={saveNew} disabled={!form.trigger.trim() || !form.body.trim()}>Save</Btn><Btn small col="#475569" onClick={() => setCreating(false)}>Cancel</Btn></div>
        </div>
      )}
      {editing && (
        <div style={{ background: "var(--bg-app)", borderRadius: 8, padding: 12, marginBottom: 12, border: "1px solid #f59e0b" }}>
          <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 8, fontWeight: 600 }}>Editing: .{editing.trigger} — {editing.label}</div>
          <div style={{ marginBottom: 8 }}><label style={S.lbl}>Label</label><input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} style={S.input} /></div>
          <div><label style={S.lbl}>Template Body</label><textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} rows={10} style={{ ...S.input, resize: "vertical" as const, fontFamily: "monospace", fontSize: 11, lineHeight: 1.6 }} /></div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <Btn small solid col="#f59e0b" onClick={saveEdit}>Save Changes</Btn>
            <Btn small col="#475569" onClick={() => setEditing(null)}>Cancel</Btn>
            {editing.builtin && <Btn small col="#64748b" onClick={() => { resetBuiltin(editing.trigger); setEditing(null); }}>Reset to Default</Btn>}
          </div>
        </div>
      )}
      {phrases.map(p => (
        <div key={p.trigger} style={{ borderBottom: "1px solid var(--border-subtle)", padding: "8px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ cursor: "pointer", flex: 1 }} onClick={() => setExpanded(expanded === p.trigger ? null : p.trigger)}>
              <span style={{ fontFamily: "monospace", color: "#0ea5e9", fontSize: 12 }}>.{p.trigger}</span>
              <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: 8 }}>{p.label}</span>
              {p.builtin && <span style={{ color: "var(--text-faint)", fontSize: 9, marginLeft: 6 }}>BUILT-IN</span>}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => { setEditing(p); setCreating(false); setForm({ trigger: p.trigger, label: p.label, body: p.body }); }} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 4 }}>✏️</button>
              {!p.builtin && (<button onClick={() => deletePhrase(p.trigger)} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 4 }}>🗑</button>)}
            </div>
          </div>
          {expanded === p.trigger && (<pre style={{ ...S.mono, marginTop: 6, fontSize: 10, maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap" }}>{p.body}</pre>)}
        </div>
      ))}
    </div>
  );
}

// ─── New Encounter Form ───────────────────────────────────────────────────────
function NewEncounterForm({patient,keys,relay,onDone,onCancel}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;onDone:()=>void;onCancel?:()=>void;
}){
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState<"idle"|"done"|"error">("idle");
  const [errorMsg,setErrorMsg]=useState("");
  const [dotPopup,setDotPopup]=useState<{query:string;pos:{top:number;left:number}}|null>(null);
  const textareaRef=useRef<HTMLTextAreaElement>(null);

  // Use ref so save effect can check load status without being in dependency array
  const draftLoadedRef = useRef(false);

  // Load draft from localStorage when patient changes
  useEffect(()=>{
    draftLoadedRef.current = false;
    setNote("");
    const saved=localStorage.getItem(`encounter_draft_${patient.id}`);
    if(saved){
      try{
        const draft=JSON.parse(saved);
        setNote(draft.note||"");
      }catch{}
    }
    // Small delay to ensure setNote("") runs before we allow saves
    const t = setTimeout(()=>{ draftLoadedRef.current = true; }, 50);
    return ()=>clearTimeout(t);
  },[patient.id]);

  // Save draft to localStorage on change — only after draft has loaded
  useEffect(()=>{
    if(!draftLoadedRef.current) return;
    localStorage.setItem(`encounter_draft_${patient.id}`,JSON.stringify({note}));
  },[note,patient.id]);

  const submit=async()=>{
    if(!keys)return;
    setBusy(true);
    setStatus("idle");
    try{
      const fhir=buildEncounter(patient.id,"Note",note);
      if(!await publishClinicalEvent({kind:FHIR_KINDS.Encounter,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Encounter",keys,relay})){
        setStatus("error");
        setErrorMsg("Encounter failed to save — check storage");
        setTimeout(()=>setStatus("idle"),4000);
        return;
      }
      setStatus("done");
      setNote("");
      localStorage.removeItem(`encounter_draft_${patient.id}`);
    }finally{setBusy(false);}
  };

  if(status==="done") return(
    <div style={{...S.card,background:"var(--tint-green)",border:"1px solid var(--tint-green-border)"}}>
      <div style={{color:"var(--accent-green)",fontWeight:600,marginBottom:8}}>✓ Encounter published and encrypted</div>
      <div style={{display:"flex",gap:8}}>
        <Btn solid col="#0ea5e9" onClick={()=>setStatus("idle")}>New Note</Btn>
        <Btn col="#475569" onClick={onDone}>View History</Btn>
      </div>
    </div>
  );

  return(
    <div style={S.card}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:14}}>📝 New Encounter — {patient.name}</div>
        <Badge t="🔒 NIP-44" col="#a78bfa" bg="var(--tint-purple)"/>
      </div>

      {status==="error"&&(
        <div style={{...S.card,background:"var(--tint-red)",border:"1px solid #f87171",marginBottom:12,padding:"10px 12px"}}>
          <div style={{color:"#f87171",fontSize:12}}>✗ {errorMsg}</div>
        </div>
      )}

      <textarea ref={textareaRef} value={note} onChange={e=>{
          setNote(e.target.value);
          // Dot phrase detection
          const ta=e.target;
          const val=ta.value;
          const pos=ta.selectionStart;
          const before=val.substring(0,pos);
          const dotMatch=before.match(/(?:^|\n|\s)\.([\w]*)$/);
          if(dotMatch){
            const rect=ta.getBoundingClientRect();
            // Approximate caret position
            const lineNum=before.split("\n").length;
            const lineH=20;
            const top=rect.top+Math.min(lineNum*lineH,rect.height-40);
            setDotPopup({query:dotMatch[1],pos:{top,left:rect.left+40}});
          } else {
            setDotPopup(null);
          }
        }}
        onKeyDown={e=>{if(e.key==="Escape"&&dotPopup){e.preventDefault();setDotPopup(null);}}}
        placeholder={"Write your clinical note here...\n\nType .wellchild, .sick, .newborn etc. to expand templates\n\nDate:\nCC:\n\nS:\nO:\n  Wt:\n  Ht:\n  BMI:\n\nA:\nP:"}
        rows={18} style={{...S.input,resize:"vertical" as const,marginBottom:14,width:"100%",fontFamily:"monospace",fontSize:13,lineHeight:1.7}}
        autoFocus
      />
      {dotPopup&&(
        <DotPhrasePopup query={dotPopup.query} position={dotPopup.pos}
          onSelect={(phrase)=>{
            const ta=textareaRef.current;
            if(!ta)return;
            const val=ta.value;
            const pos=ta.selectionStart;
            const before=val.substring(0,pos);
            const dotMatch=before.match(/(?:^|\n|\s)\.([\w]*)$/);
            if(dotMatch){
              const matchStart=pos-dotMatch[0].length+(dotMatch[0].startsWith("\n")||dotMatch[0].startsWith(" ")?1:0);
              const expanded=expandDotPhrase(phrase.body,patient);
              const newVal=val.substring(0,matchStart)+expanded+val.substring(pos);
              ta.focus();
              // Use execCommand for undo support
              ta.setSelectionRange(matchStart,pos);
              document.execCommand("insertText",false,expanded);
              if(ta.value===val){
                // fallback if execCommand didn't work
                setNote(newVal);
              }
            }
            setDotPopup(null);
          }}
          onClose={()=>setDotPopup(null)}
        />
      )}

      <div style={{display:"flex",gap:8}}>
        <Btn solid col="#0ea5e9" disabled={!note.trim()||busy||!keys}
          onClick={submit}>
          {busy?"⏳ Publishing…":"⚡ Encrypt & Publish"}
        </Btn>
      </div>
    </div>
  );
}

// ─── Nurse Note Form (lightweight, no sign permission required) ──────────────
function NurseNoteForm({patient,keys,relay,onDone}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;onDone:()=>void;
}){
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState<"idle"|"done"|"error">("idle");
  const textareaRef=useRef<HTMLTextAreaElement>(null);

  // Reset when patient changes
  useEffect(()=>{setNote("");setStatus("idle");},[patient.id]);

  const submit=async()=>{
    if(!keys||!note.trim())return;
    setBusy(true);
    try{
      const fhir=buildEncounter(patient.id,"Note",note.trim());
      fhir.class={system:"http://terminology.hl7.org/CodeSystem/v3-ActCode",code:"AMB",display:"nurse note"};
      if(!await publishClinicalEvent({kind:FHIR_KINDS.Encounter,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Encounter",keys,relay,
        extraTags:[["encounter-type","nurse-note"]]})){
        setStatus("error");
        return;
      }
      setStatus("done");
      setNote("");
    }finally{setBusy(false);}
  };

  if(status==="done") return(
    <div style={{...S.card,background:"var(--tint-green)",border:"1px solid var(--tint-green-border)"}}>
      <div style={{color:"var(--accent-green)",fontWeight:600,marginBottom:8}}>✓ Note saved</div>
      <div style={{display:"flex",gap:8}}>
        <Btn solid col="#0ea5e9" onClick={()=>setStatus("idle")}>New Note</Btn>
        <Btn col="#475569" onClick={onDone}>View History</Btn>
      </div>
    </div>
  );

  return(
    <div>
      <div style={{marginBottom:8,color:"#7dd3fc",fontSize:12,fontWeight:600}}>📋 Note — {patient.name}</div>
      <textarea ref={textareaRef} value={note} onChange={e=>setNote(e.target.value)}
        placeholder="Vitals review, triage notes, patient concerns, pre-visit observations..."
        rows={10} style={{...S.input,fontSize:13,lineHeight:1.7,fontFamily:"monospace",resize:"vertical",minHeight:150}}/>
      <div style={{display:"flex",gap:8,marginTop:10}}>
        <Btn solid col="#0ea5e9" onClick={submit} disabled={busy||!note.trim()}>
          {busy?"⏳ Saving…":"💾 Save Note"}
        </Btn>
        {status==="error"&&<span style={{color:"#f87171",fontSize:11,alignSelf:"center"}}>Failed to save</span>}
      </div>
    </div>
  );
}

// ─── Medication List ──────────────────────────────────────────────────────────
function MedicationList({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [meds,setMeds]=useState<any[]>([]);
  const [adding,setAdding]=useState(false);
  const [showInactive,setShowInactive]=useState(false);
  const [form,setForm]=useState({drug:"",dose:"",freq:"",start:new Date().toISOString().split('T')[0]});
  
  const load=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.MedicationRequest],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        const deletedIds=new Set<string>();
        for(const item of items){
          const deletionTag=item.tags.find(t=>t[0]==="e"&&t[3]==="deletion");
          if(deletionTag) deletedIds.add(deletionTag[1]);
        }
        const decrypted=items.filter(item=>!item.tags.find(t=>t[0]==="e"&&t[3]==="deletion")).map(item=>({
          event:{id:item.eventId,created_at:item.created_at,tags:item.tags},fhir:item.fhir,deleted:deletedIds.has(item.eventId)
        }));
        setMeds(decrypted.sort((a,b)=>b.event.created_at-a.event.created_at));
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setMeds([]);},[patient.id]);
  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);

  const save=async()=>{
    if(!keys||!form.drug.trim())return;
    const fhir=buildMedicationRequest(patient.id,form.drug,form.dose,form.freq,form.start);
    if(await publishClinicalEvent({kind:FHIR_KINDS.MedicationRequest,plaintext:JSON.stringify(fhir),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"MedicationRequest",keys,relay})){
      setForm({drug:"",dose:"",freq:"",start:new Date().toISOString().split('T')[0]});setAdding(false);load();}
  };

  const deleteMed=async(medId:string,drugName:string)=>{
    if(!keys)return;
    const deletionNote={
      resourceType:"MedicationRequest",id:crypto.randomUUID(),
      status:"stopped",intent:"order",
      medicationCodeableConcept:{text:`[DISCONTINUED: ${drugName}]`},
      subject:{reference:`Patient/${patient.id}`},
      authoredOn:new Date().toISOString(),
    };
    if(await publishClinicalEvent({kind:FHIR_KINDS.MedicationRequest,plaintext:JSON.stringify(deletionNote),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"MedicationRequest",keys,relay,
      extraTags:[["e", medId, "", "deletion"]]}))load();
  };

  const activeMeds=meds.filter(m=>!m.deleted);
  const inactiveMeds=meds.filter(m=>m.deleted);

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{fontWeight:700,fontSize:14}}>💊 Medications</div>
        {inactiveMeds.length>0&&<Badge t={`${inactiveMeds.length} inactive`} col="#64748b" bg="var(--bg-app)"/>}
      </div>
      <div style={{display:"flex",gap:8}}>
        {inactiveMeds.length>0&&<Btn small col="#64748b" onClick={()=>setShowInactive(!showInactive)}>{showInactive?"Hide Inactive":"Show Inactive"}</Btn>}
        {canDo("prescribe")&&<Btn small solid={!adding} col="#0ea5e9" onClick={()=>setAdding(!adding)}>{adding?"Cancel":"+ Add"}</Btn>}
      </div>
    </div>
    {adding&&<div style={{...S.card,marginBottom:12}}>
      <div style={S.grid2}>
        <div><label style={S.lbl}>Drug</label><input value={form.drug} onChange={e=>setForm(f=>({...f,drug:e.target.value}))} style={S.input} placeholder="Amoxicillin"/></div>
        <div><label style={S.lbl}>Dose</label><input value={form.dose} onChange={e=>setForm(f=>({...f,dose:e.target.value}))} style={S.input} placeholder="250mg"/></div>
      </div>
      <div style={{...S.grid2,marginTop:8}}>
        <div><label style={S.lbl}>Frequency</label><input value={form.freq} onChange={e=>setForm(f=>({...f,freq:e.target.value}))} style={S.input} placeholder="TID"/></div>
        <div><label style={S.lbl}>Start Date</label><input type="date" value={form.start} onChange={e=>setForm(f=>({...f,start:e.target.value}))} style={S.input}/></div>
      </div>
      <Btn solid col="#0ea5e9" onClick={save} disabled={!form.drug.trim()} style={{marginTop:10}}>Save</Btn>
    </div>}
    {activeMeds.length===0&&!adding&&<div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:24}}>No active medications</div>}
    {activeMeds.map(m=>{
      const f=m.fhir;
      const isRx=!!(f.sig||f.qty||f.daysSupply||f.refills!==undefined||f.pharmacy);
      return(
        <div key={m.event.id} style={{...S.card,borderLeft:`3px solid ${isRx?"#f59e0b":"#a78bfa"}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"start"}}>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                <div style={{fontWeight:600,fontSize:13}}>{f.medicationCodeableConcept?.text||f.drug}</div>
                {isRx&&<Badge t="Rx" col="#f59e0b" bg="var(--tint-amber)"/>}
              </div>
              {/* Sig line (Rx) or dose/freq (manual add) */}
              {f.sig
                ? <div style={{color:"var(--text-primary)",fontSize:11,marginTop:2,fontStyle:"italic"}}>{f.sig}</div>
                : <div style={{color:"var(--text-secondary)",fontSize:11,marginTop:2}}>{f.dosageInstruction?.[0]?.text}</div>
              }
              {/* Rx detail row */}
              {isRx&&(
                <div style={{display:"flex",gap:12,marginTop:4,flexWrap:"wrap" as const}}>
                  {f.qty&&<span style={{color:"var(--text-muted)",fontSize:10}}>Qty: {f.qty}</span>}
                  {f.daysSupply>0&&<span style={{color:"var(--text-muted)",fontSize:10}}>Days: {f.daysSupply}</span>}
                  {f.refills!==undefined&&<span style={{color:"var(--text-muted)",fontSize:10}}>Refills: {f.refills}</span>}
                  {f.daw&&<span style={{color:"#f87171",fontSize:10,fontWeight:600}}>DAW</span>}
                  {f.pharmacy&&<span style={{color:"var(--text-muted)",fontSize:10}}>📍 {f.pharmacy}</span>}
                  {f.indication&&<span style={{color:"var(--text-muted)",fontSize:10}}>Dx: {f.indication}</span>}
                </div>
              )}
              <div style={{color:"var(--text-label)",fontSize:10,marginTop:4}}>
                {isRx?"Prescribed:":"Started:"} {new Date(f.authoredOn).toLocaleDateString()}
              </div>
            </div>
            {canDo("prescribe")&&<button onClick={()=>deleteMed(m.event.id,f.medicationCodeableConcept?.text||f.drug)} style={{
              background:"transparent",border:"none",color:"var(--text-muted)",cursor:"pointer",fontSize:16,padding:4
            }}>🗑</button>}
          </div>
        </div>
      );
    })}
    {showInactive&&inactiveMeds.map(m=><div key={m.event.id} style={{...S.card,borderLeft:"3px solid var(--text-label)",opacity:0.6}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"start"}}>
        <div style={{flex:1}}>
          <div style={{fontWeight:600,fontSize:13}}>{m.fhir.medicationCodeableConcept?.text}</div>
          <div style={{color:"var(--text-secondary)",fontSize:11,marginTop:2}}>{m.fhir.dosageInstruction?.[0]?.text}</div>
          <div style={{color:"var(--text-label)",fontSize:10,marginTop:4}}>Started: {new Date(m.fhir.authoredOn).toLocaleDateString()}</div>
          <div style={{marginTop:4}}><Badge t="DISCONTINUED" col="#64748b" bg="var(--bg-app)"/></div>
        </div>
      </div>
    </div>)}
  </div>);
}

// ─── Allergy List ─────────────────────────────────────────────────────────────
function AllergyList({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [allergies,setAllergies]=useState<any[]>([]);
  const [adding,setAdding]=useState(false);
  const [deleting,setDeleting]=useState<string|null>(null);
  const [deleteReason,setDeleteReason]=useState("");
  const [form,setForm]=useState({allergen:"",reaction:"",severity:"mild"});
  
  const load=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.AllergyIntolerance],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        const deletedIds=new Set<string>();
        for(const item of items){
          const deletionTag=item.tags.find(t=>t[0]==="e"&&t[3]==="deletion");
          if(deletionTag) deletedIds.add(deletionTag[1]);
        }
        const decrypted=items.filter(item=>
          !item.tags.find(t=>t[0]==="e"&&t[3]==="deletion")&&!deletedIds.has(item.eventId)
        ).map(item=>({
          event:{id:item.eventId,created_at:item.created_at,tags:item.tags},fhir:item.fhir
        }));
        setAllergies(decrypted.sort((a,b)=>b.event.created_at-a.event.created_at));
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setAllergies([]);},[patient.id]);
  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);

  const save=async()=>{
    if(!keys||!form.allergen.trim())return;
    const fhir=buildAllergyIntolerance(patient.id,form.allergen,form.reaction,form.severity);
    if(await publishClinicalEvent({kind:FHIR_KINDS.AllergyIntolerance,plaintext:JSON.stringify(fhir),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"AllergyIntolerance",
      keys,relay})){setForm({allergen:"",reaction:"",severity:"mild"});setAdding(false);load();}
  };

  const confirmDelete=async(allergyId:string)=>{
    if(!keys||!deleteReason.trim())return;
    const deletionNote={
      resourceType:"AllergyIntolerance",id:crypto.randomUUID(),
      clinicalStatus:{coding:[{code:"inactive"}]},
      code:{text:`[DELETED: ${deleteReason}]`},
      patient:{reference:`Patient/${patient.id}`},
      recordedDate:new Date().toISOString(),
      note:[{text:`Deleted: ${deleteReason}`}]
    };
    if(await publishClinicalEvent({kind:FHIR_KINDS.AllergyIntolerance,plaintext:JSON.stringify(deletionNote),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"AllergyIntolerance",
      keys,relay,extraTags:[["e",allergyId,"","deletion"]]})){
      setAllergies(a=>a.filter(x=>x.event.id!==allergyId));
      setDeleting(null);
      setDeleteReason("");
    }
  };

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
      <div style={{fontWeight:700,fontSize:14}}>⚠️ Allergies</div>
      {canDo("allergies")&&<Btn small solid={!adding} col="#0ea5e9" onClick={()=>setAdding(!adding)}>{adding?"Cancel":"+ Add"}</Btn>}
    </div>
    {adding&&<div style={{...S.card,marginBottom:12}}>
      <div><label style={S.lbl}>Allergen</label><input value={form.allergen} onChange={e=>setForm(f=>({...f,allergen:e.target.value}))} style={S.input} placeholder="Penicillin"/></div>
      <div style={{marginTop:8}}><label style={S.lbl}>Reaction</label><input value={form.reaction} onChange={e=>setForm(f=>({...f,reaction:e.target.value}))} style={S.input} placeholder="Hives, swelling"/></div>
      <div style={{marginTop:8}}><label style={S.lbl}>Severity</label>
        <select value={form.severity} onChange={e=>setForm(f=>({...f,severity:e.target.value}))} style={{...S.input,cursor:"pointer"}}>
          <option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option>
        </select>
      </div>
      <Btn solid col="#0ea5e9" onClick={save} disabled={!form.allergen.trim()} style={{marginTop:10}}>Save</Btn>
    </div>}
    {allergies.length===0&&!adding&&<div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:24}}>No known allergies</div>}
    {allergies.map(a=><div key={a.event.id} style={{...S.card,borderLeft:"3px solid #f87171"}}>
      {deleting===a.event.id?(<>
        <div style={{fontWeight:600,fontSize:12,marginBottom:8}}>Delete: {a.fhir.code?.text}</div>
        <div><label style={S.lbl}>Reason for deletion</label>
          <input value={deleteReason} onChange={e=>setDeleteReason(e.target.value)} 
            style={S.input} placeholder="e.g. Added in error, resolved"/></div>
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <Btn small solid col="#f87171" disabled={!deleteReason.trim()} onClick={()=>confirmDelete(a.event.id)}>Confirm Delete</Btn>
          <Btn small col="#475569" onClick={()=>{setDeleting(null);setDeleteReason("");}}>Cancel</Btn>
        </div>
      </>):(<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"start"}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:13}}>{a.fhir.code?.text}</div>
            <div style={{color:"var(--text-secondary)",fontSize:11,marginTop:2}}>Reaction: {a.fhir.reaction?.[0]?.manifestation?.[0]?.text||"—"}</div>
            <div style={{color:"#f87171",fontSize:10,marginTop:4,textTransform:"capitalize"}}>Severity: {a.fhir.reaction?.[0]?.severity}</div>
          </div>
          {canDo("allergies")&&<button onClick={()=>setDeleting(a.event.id)} style={{
            background:"transparent",border:"none",color:"var(--text-muted)",cursor:"pointer",
            fontSize:16,padding:4
          }}>🗑</button>}
        </div>
      </>)}
    </div>)}
  </div>);
}

// ─── Problem List (Conditions) ───────────────────────────────────────────────
function DiagnosisSearch({onSelect,inputStyle}:{
  onSelect:(term:{display:string;snomed?:string;icd10?:string})=>void;
  inputStyle?:React.CSSProperties;
}){
  const [query,setQuery]=useState("");
  const [results,setResults]=useState<any[]>([]);
  const [showCustom,setShowCustom]=useState(false);
  const [custom,setCustom]=useState({display:"",snomed:"",icd10:""});
  const [focused,setFocused]=useState(false);
  const wrapRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{
    if(!query.trim()){setResults([]);return;}
    const q=query.toLowerCase().trim();
    const customTerms=(() => { try { return JSON.parse(localStorage.getItem("nostr_ehr_custom_diagnoses")||"[]"); } catch{return[];} })();
    const all=[...PEDIATRIC_DIAGNOSES,...customTerms];
    const scored=all.map(t=>{
      const d=t.display.toLowerCase();
      const icd=(t.icd10||"").toLowerCase();
      const snomed=(t.snomed||"").toLowerCase();
      let score=0;
      if(d===q) score=100;
      else if(d.startsWith(q)) score=80;
      else if(d.split(/[\s,/-]+/).some((w:string)=>w.startsWith(q))) score=60;
      else if(d.includes(q)) score=40;
      else if(icd.startsWith(q)||snomed.startsWith(q)) score=50;
      else if(icd.includes(q)||snomed.includes(q)) score=30;
      return {term:t,score};
    }).filter(s=>s.score>0).sort((a,b)=>b.score-a.score||a.term.display.localeCompare(b.term.display));
    setResults(scored.slice(0,15).map(s=>s.term));
  },[query]);

  useEffect(()=>{
    const handler=(e:MouseEvent)=>{
      if(wrapRef.current&&!wrapRef.current.contains(e.target as Node)){setFocused(false);setShowCustom(false);}
    };
    document.addEventListener("mousedown",handler);
    return()=>document.removeEventListener("mousedown",handler);
  },[]);

  const saveCustomAndSelect=()=>{
    if(!custom.display.trim())return;
    const term={display:custom.display.trim(),snomed:custom.snomed.trim()||undefined,icd10:custom.icd10.trim()||undefined,custom:true};
    const existing=(() => { try { return JSON.parse(localStorage.getItem("nostr_ehr_custom_diagnoses")||"[]"); } catch{return[];} })();
    if(!existing.find((t:any)=>t.display.toLowerCase()===term.display.toLowerCase())){
      existing.push(term);
      localStorage.setItem("nostr_ehr_custom_diagnoses",JSON.stringify(existing));
    }
    onSelect(term);
    setCustom({display:"",snomed:"",icd10:""});
    setShowCustom(false);
    setQuery("");
    setFocused(false);
  };

  return(
    <div ref={wrapRef} style={{position:"relative"}}>
      <input
        value={query}
        onChange={e=>setQuery(e.target.value)}
        onFocus={()=>setFocused(true)}
        placeholder="Search diagnoses (name, SNOMED, or ICD-10)…"
        style={inputStyle||S.input}
      />
      {focused&&(results.length>0||query.trim().length>1)&&(
        <div style={{
          position:"absolute",top:"100%",left:0,right:0,zIndex:50,
          background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:"0 0 8px 8px",
          maxHeight:300,overflowY:"auto",boxShadow:"0 4px 12px var(--shadow)"
        }}>
          {results.map((t,i)=>(
            <div key={`${t.display}-${i}`} onClick={()=>{
              onSelect(t);setQuery("");setResults([]);setFocused(false);
            }} style={{
              padding:"8px 12px",cursor:"pointer",borderBottom:"1px solid var(--border-subtle)",
              fontSize:12,display:"flex",justifyContent:"space-between",alignItems:"center",
            }}
            onMouseEnter={e=>(e.currentTarget.style.background="var(--bg-hover)")}
            onMouseLeave={e=>(e.currentTarget.style.background="transparent")}
            >
              <div>
                <span style={{color:"var(--text-primary)"}}>{t.display}</span>
                {t.custom&&<span style={{color:"#f59e0b",fontSize:9,marginLeft:6}}>CUSTOM</span>}
              </div>
              <div style={{display:"flex",gap:8,flexShrink:0}}>
                {t.icd10&&<span style={{color:"var(--text-muted)",fontSize:10,fontFamily:"monospace"}}>{t.icd10}</span>}
                {t.snomed&&<span style={{color:"var(--text-label)",fontSize:9,fontFamily:"monospace"}}>SNOMED:{t.snomed}</span>}
              </div>
            </div>
          ))}
          <div onClick={()=>setShowCustom(!showCustom)} style={{
            padding:"8px 12px",cursor:"pointer",borderTop:"1px solid var(--border)",
            color:"#0ea5e9",fontSize:12,display:"flex",alignItems:"center",gap:6,
          }}
          onMouseEnter={e=>(e.currentTarget.style.background="var(--bg-inset)")}
          onMouseLeave={e=>(e.currentTarget.style.background="transparent")}
          >
            <span>+</span> {showCustom?"Cancel custom entry":"Add custom diagnosis…"}
          </div>
          {showCustom&&(
            <div style={{padding:"8px 12px",background:"var(--bg-app)",borderTop:"1px solid var(--border)"}}>
              <div style={{marginBottom:6}}>
                <label style={S.lbl}>Diagnosis Name *</label>
                <input value={custom.display} onChange={e=>setCustom(c=>({...c,display:e.target.value}))}
                  placeholder="e.g. Posterior urethral valves" style={{...S.input,fontSize:11}}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                <div>
                  <label style={S.lbl}>SNOMED Code (optional)</label>
                  <input value={custom.snomed} onChange={e=>setCustom(c=>({...c,snomed:e.target.value}))}
                    placeholder="e.g. 236635008" style={{...S.input,fontSize:11}}/>
                </div>
                <div>
                  <label style={S.lbl}>ICD-10 Code (optional)</label>
                  <input value={custom.icd10} onChange={e=>setCustom(c=>({...c,icd10:e.target.value}))}
                    placeholder="e.g. Q64.2" style={{...S.input,fontSize:11}}/>
                </div>
              </div>
              <div style={{marginTop:6,display:"flex",justifyContent:"flex-end"}}>
                <Btn small solid col="#0ea5e9" onClick={saveCustomAndSelect}
                  disabled={!custom.display.trim()}>Add & Select</Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProblemList({patient,keys,relay,compact=false}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;compact?:boolean;
}){
  const [conditions,setConditions]=useState<any[]>([]);
  const [adding,setAdding]=useState(false);
  const [showResolved,setShowResolved]=useState(false);
  const [selectedDx,setSelectedDx]=useState<{display:string;snomed?:string;icd10?:string}|null>(null);
  const [form,setForm]=useState({
    severity:"" as ""|"mild"|"moderate"|"severe",
    onset:new Date().toISOString().split('T')[0],
    note:"",
  });

  const processConditions=(items:{eventId:string;kind:number;created_at:number;fhir:any;tags:string[][]}[])=>{
    const statusUpdates=new Map<string,{status:string;created_at:number;fhir:any}>();
    const originals:any[]=[];
    for(const item of items){
      const statusTag=item.tags.find(t=>t[0]==="e"&&t[3]==="status-update");
      if(statusTag){
        const origId=statusTag[1];
        const existing=statusUpdates.get(origId);
        if(!existing||item.created_at>existing.created_at){
          statusUpdates.set(origId,{status:item.fhir.clinicalStatus?.coding?.[0]?.code||"active",created_at:item.created_at,fhir:item.fhir});
        }
      } else {
        originals.push({event:{id:item.eventId,created_at:item.created_at,tags:item.tags},fhir:item.fhir});
      }
    }
    const merged=originals.map(o=>{
      const update=statusUpdates.get(o.event.id);
      if(update) return {event:o.event,fhir:{...o.fhir,clinicalStatus:update.fhir.clinicalStatus},currentStatus:update.status};
      return {...o,currentStatus:o.fhir.clinicalStatus?.coding?.[0]?.code||"active"};
    });
    setConditions(merged.sort((a,b)=>{
      if(a.currentStatus==="active"&&b.currentStatus!=="active")return -1;
      if(a.currentStatus!=="active"&&b.currentStatus==="active")return 1;
      return b.event.created_at-a.event.created_at;
    }));
  };

  const load=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.Condition],
      patientId:patient.id,
      keys,relay,
      processDecrypted:processConditions,
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setConditions([]);},[patient.id]);
  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);

  const save=async()=>{
    if(!keys||!selectedDx)return;
    const fhir=buildCondition(patient.id,selectedDx.display,{
      snomedCode:selectedDx.snomed,
      icd10Code:selectedDx.icd10,
      clinicalStatus:"active",
      severity:form.severity||undefined,
      onsetDate:form.onset||undefined,
      note:form.note||undefined,
    });
    if(await publishClinicalEvent({kind:FHIR_KINDS.Condition,plaintext:JSON.stringify(fhir),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Condition",keys,relay})){
      setSelectedDx(null);
      setForm({severity:"",onset:new Date().toISOString().split('T')[0],note:""});
      setAdding(false);
      load();
    }
  };

  const changeStatus=async(origEventId:string,origFhir:any,newStatus:"active"|"resolved"|"inactive")=>{
    if(!keys)return;
    const updatedFhir={
      ...origFhir,
      clinicalStatus:{
        coding:[{system:"http://terminology.hl7.org/CodeSystem/condition-clinical",code:newStatus}],
      },
    };
    if(await publishClinicalEvent({kind:FHIR_KINDS.Condition,plaintext:JSON.stringify(updatedFhir),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Condition",keys,relay,
      extraTags:[["e", origEventId, "", "status-update"]]}))load();
  };

  const active=conditions.filter(c=>c.currentStatus==="active");
  const resolved=conditions.filter(c=>c.currentStatus!=="active");

  // ── Compact mode (for Overview tab) ─────────────────────────────────────
  if(compact){
    return(
      <div style={{...S.card,borderLeft:"3px solid #a78bfa"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:active.length>0?8:0}}>
          <div style={{fontWeight:700,fontSize:13,color:"#a78bfa"}}>🩺 Problems</div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            {active.length>0&&<Badge t={`${active.length} active`} col="#a78bfa" bg="#1a0a2e"/>}
            {resolved.length>0&&<span style={{color:"var(--text-label)",fontSize:10,cursor:"pointer"}}
              onClick={()=>setShowResolved(!showResolved)}>{resolved.length} resolved</span>}
          </div>
        </div>
        {active.length===0&&resolved.length===0&&(
          <div style={{color:"var(--text-faint)",fontSize:12,padding:"4px 0"}}>No problems documented</div>
        )}
        {active.map(c=>{
          const f=c.fhir;
          const icd=f.code?.coding?.find((c:any)=>c.system?.includes("icd-10"))?.code;
          return(
            <div key={c.event.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",borderBottom:"1px solid var(--border-subtle)"}}>
              <div style={{fontSize:12,color:"var(--text-primary)"}}>
                {f.code?.text}
                {icd&&<span style={{color:"var(--text-label)",fontSize:10,marginLeft:6,fontFamily:"monospace"}}>{icd}</span>}
              </div>
              {f.severity?.coding?.[0]?.display&&(
                <Badge t={f.severity.coding[0].display} col={
                  f.severity.coding[0].display==="severe"?"#f87171":
                  f.severity.coding[0].display==="moderate"?"#f59e0b":"var(--text-muted)"
                } bg="var(--bg-app)"/>
              )}
            </div>
          );
        })}
        {showResolved&&resolved.map(c=>(
          <div key={c.event.id} style={{display:"flex",alignItems:"center",padding:"3px 0",borderBottom:"1px solid var(--border-subtle)",opacity:0.5}}>
            <div style={{fontSize:12,color:"var(--text-muted)"}}>{c.fhir.code?.text}</div>
            <Badge t={c.currentStatus.toUpperCase()} col="#475569" bg="var(--bg-app)"/>
          </div>
        ))}
      </div>
    );
  }

  // ── Full tab mode ───────────────────────────────────────────────────────
  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{fontWeight:700,fontSize:14}}>🩺 Problem List</div>
        {resolved.length>0&&<Badge t={`${resolved.length} resolved`} col="#64748b" bg="var(--bg-app)"/>}
      </div>
      <div style={{display:"flex",gap:8}}>
        {resolved.length>0&&<Btn small col="#64748b" onClick={()=>setShowResolved(!showResolved)}>
          {showResolved?"Hide Resolved":"Show Resolved"}
        </Btn>}
        {canDo("write")&&<Btn small solid={!adding} col="#a78bfa" onClick={()=>setAdding(!adding)}>{adding?"Cancel":"+ Add"}</Btn>}
      </div>
    </div>

    {adding&&canDo("write")&&(
      <div style={{...S.card,marginBottom:12,borderLeft:"3px solid #a78bfa"}}>
        <div style={{marginBottom:8}}>
          <label style={S.lbl}>Diagnosis</label>
          {selectedDx?(
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:"var(--bg-app)",borderRadius:7,border:"1px solid var(--border)"}}>
              <span style={{color:"var(--text-primary)",fontSize:12,flex:1}}>{selectedDx.display}</span>
              <div style={{display:"flex",gap:6,flexShrink:0}}>
                {selectedDx.icd10&&<span style={{color:"var(--text-muted)",fontSize:10,fontFamily:"monospace"}}>{selectedDx.icd10}</span>}
                {selectedDx.snomed&&<span style={{color:"var(--text-label)",fontSize:9,fontFamily:"monospace"}}>SNOMED:{selectedDx.snomed}</span>}
              </div>
              <button onClick={()=>setSelectedDx(null)} style={{background:"transparent",border:"none",color:"var(--text-muted)",cursor:"pointer",fontSize:14}}>×</button>
            </div>
          ):(
            <DiagnosisSearch onSelect={setSelectedDx}/>
          )}
        </div>
        <div style={S.grid3}>
          <div>
            <label style={S.lbl}>Severity</label>
            <select value={form.severity} onChange={e=>setForm(f=>({...f,severity:e.target.value as any}))}
              style={{...S.input,appearance:"auto" as any}}>
              <option value="">— none —</option>
              <option value="mild">Mild</option>
              <option value="moderate">Moderate</option>
              <option value="severe">Severe</option>
            </select>
          </div>
          <div>
            <label style={S.lbl}>Onset Date</label>
            <input type="date" value={form.onset} onChange={e=>setForm(f=>({...f,onset:e.target.value}))} style={S.input}/>
          </div>
          <div/>
        </div>
        <div style={{marginTop:8}}>
          <label style={S.lbl}>Note (optional)</label>
          <input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} style={S.input}
            placeholder="Additional clinical context…"/>
        </div>
        <div style={{marginTop:10}}>
          <Btn solid col="#a78bfa" onClick={save} disabled={!selectedDx}>Save Problem</Btn>
        </div>
      </div>
    )}

    {active.length===0&&!adding&&(
      <div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:24}}>No active problems</div>
    )}

    {active.map(c=>{
      const f=c.fhir;
      const icd=f.code?.coding?.find((cd:any)=>cd.system?.includes("icd-10"))?.code;
      const snomed=f.code?.coding?.find((cd:any)=>cd.system?.includes("snomed"))?.code;
      const severityDisplay=f.severity?.coding?.[0]?.display;
      return(
        <div key={c.event.id} style={{...S.card,borderLeft:"3px solid #a78bfa"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"start"}}>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                <div style={{fontWeight:600,fontSize:13}}>{f.code?.text}</div>
                {severityDisplay&&<Badge t={severityDisplay} col={
                  severityDisplay==="severe"?"#f87171":
                  severityDisplay==="moderate"?"#f59e0b":"var(--text-muted)"
                } bg="var(--bg-app)"/>}
              </div>
              <div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap" as const}}>
                {icd&&<span style={{color:"var(--text-muted)",fontSize:10,fontFamily:"monospace"}}>ICD-10: {icd}</span>}
                {snomed&&<span style={{color:"var(--text-label)",fontSize:10,fontFamily:"monospace"}}>SNOMED: {snomed}</span>}
              </div>
              {f.note?.[0]?.text&&(
                <div style={{color:"var(--text-secondary)",fontSize:11,marginTop:4,fontStyle:"italic"}}>{f.note[0].text}</div>
              )}
              <div style={{color:"var(--text-label)",fontSize:10,marginTop:4}}>
                {f.onsetDateTime&&<>Onset: {new Date(f.onsetDateTime).toLocaleDateString()} · </>}
                Recorded: {new Date(f.recordedDate).toLocaleDateString()}
              </div>
            </div>
            <div style={{display:"flex",gap:4,flexShrink:0}}>
              {canDo("write")&&<button onClick={()=>changeStatus(c.event.id,f,"resolved")} title="Mark resolved"
                style={{background:"transparent",border:"1px solid var(--border)",color:"var(--accent-green)",
                  cursor:"pointer",fontSize:10,padding:"3px 8px",borderRadius:6,fontFamily:"inherit"}}>
                ✓ Resolve
              </button>}
            </div>
          </div>
        </div>
      );
    })}

    {showResolved&&resolved.length>0&&(
      <>
        <div style={{color:"var(--text-label)",fontSize:11,fontWeight:600,margin:"12px 0 6px",textTransform:"uppercase",letterSpacing:"0.5px"}}>
          Resolved / Inactive
        </div>
        {resolved.map(c=>{
          const f=c.fhir;
          return(
            <div key={c.event.id} style={{...S.card,borderLeft:"3px solid var(--text-label)",opacity:0.6}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"start"}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600,fontSize:13}}>{f.code?.text}</div>
                  <div style={{color:"var(--text-label)",fontSize:10,marginTop:4}}>
                    {f.onsetDateTime&&<>Onset: {new Date(f.onsetDateTime).toLocaleDateString()} · </>}
                    Recorded: {new Date(f.recordedDate).toLocaleDateString()}
                  </div>
                  <div style={{marginTop:4}}>
                    <Badge t={c.currentStatus.toUpperCase()} col="#475569" bg="var(--bg-app)"/>
                  </div>
                </div>
                {canDo("write")&&<button onClick={()=>changeStatus(c.event.id,f,"active")} title="Reactivate"
                  style={{background:"transparent",border:"1px solid var(--border)",color:"#f59e0b",
                    cursor:"pointer",fontSize:10,padding:"3px 8px",borderRadius:6,fontFamily:"inherit"}}>
                  ↩ Reactivate
                </button>}
              </div>
            </div>
          );
        })}
      </>
    )}
  </div>);
}

// ─── Immunization List ────────────────────────────────────────────────────────
function ImmunizationList({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [immunizations,setImmunizations]=useState<any[]>([]);
  const [adding,setAdding]=useState(false);
  const [form,setForm]=useState({vaccine:"",date:new Date().toISOString().split('T')[0],dose:""});
  
  const load=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.Immunization],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        const decrypted=items.map(item=>({
          event:{id:item.eventId,created_at:item.created_at,tags:item.tags},fhir:item.fhir
        }));
        setImmunizations(decrypted.sort((a,b)=>new Date(b.fhir.occurrenceDateTime).getTime()-new Date(a.fhir.occurrenceDateTime).getTime()));
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setImmunizations([]);},[patient.id]);
  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);

  const save=async()=>{
    if(!keys||!form.vaccine.trim()||!form.date)return;
    const fhir=buildImmunization(patient.id,form.vaccine,form.date,form.dose);
    if(await publishClinicalEvent({kind:FHIR_KINDS.Immunization,plaintext:JSON.stringify(fhir),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Immunization",
      keys,relay})){setForm({vaccine:"",date:new Date().toISOString().split('T')[0],dose:""});setAdding(false);load();}
  };

  // Group by vaccine name
  const grouped=immunizations.reduce((acc,i)=>{
    const name=i.fhir.vaccineCode?.text||"Unknown";
    if(!acc[name])acc[name]=[];
    acc[name].push(i);
    return acc;
  },{} as Record<string,any[]>);

  // Sort each group by date (oldest first for timeline)
  Object.values(grouped).forEach((g:any)=>g.sort((a:any,b:any)=>
    new Date(a.fhir.occurrenceDateTime).getTime()-new Date(b.fhir.occurrenceDateTime).getTime()
  ));

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
      <div style={{fontWeight:700,fontSize:14}}>💉 Immunizations</div>
      <div style={{display:"flex",gap:8}}>
        <Btn small col="#10b981" onClick={()=>{
          const entries:ImmunizationEntry[]=immunizations.map((i:any)=>({vaccine:i.fhir.vaccineCode?.text||"Unknown",date:i.fhir.occurrenceDateTime||"",dose:i.fhir.doseQuantity?.value}));
          if(!entries.length)return;
          const doc=generateImmunizationRecord({name:patient.name,dob:patient.dob,sex:patient.sex},entries);
          doc.save(`ImmunizationRecord_${patient.name.replace(/\s+/g,"_")}.pdf`);
        }}>🖨 Print PDF</Btn>
        {canDo("immunizations")&&<Btn small solid={!adding} col="#0ea5e9" onClick={()=>setAdding(!adding)}>{adding?"Cancel":"+ Add"}</Btn>}
      </div>
    </div>
    {adding&&<div style={{...S.card,marginBottom:12}}>
      <div><label style={S.lbl}>Vaccine</label><input value={form.vaccine} onChange={e=>setForm(f=>({...f,vaccine:e.target.value}))} style={S.input} placeholder="DTaP"/></div>
      <div style={{...S.grid2,marginTop:8}}>
        <div><label style={S.lbl}>Date Given</label><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={S.input}/></div>
        <div><label style={S.lbl}>Dose #</label><input value={form.dose} onChange={e=>setForm(f=>({...f,dose:e.target.value}))} style={S.input} placeholder="1"/></div>
      </div>
      <Btn solid col="#0ea5e9" onClick={save} disabled={!form.vaccine.trim()||!form.date} style={{marginTop:10}}>Save</Btn>
    </div>}
    {immunizations.length===0&&!adding&&<div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:24}}>No immunizations recorded</div>}
    {Object.entries(grouped).map(([vaccine,doses]:[string,any])=><div key={vaccine} style={{...S.card,borderLeft:"3px solid var(--accent-green)"}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>{vaccine}</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap" as const}}>
        {doses.map((d:any)=><div key={d.event.id} style={{
          background:"var(--bg-card)",border:"1px solid var(--accent-green)",borderRadius:6,padding:"4px 8px"
        }}>
          <div style={{color:"var(--accent-green-text)",fontSize:10,fontWeight:600}}>
            {d.fhir.doseQuantity?`#${d.fhir.doseQuantity.value}`:"Dose"}
          </div>
          <div style={{color:"var(--text-secondary)",fontSize:9,marginTop:2}}>
            {new Date(d.fhir.occurrenceDateTime).toLocaleDateString()}
          </div>
        </div>)}
      </div>
    </div>)}
  </div>);
}

// ─── Messages View (threaded email style) ────────────────────────────────────
function MessagesView({patient,keys,relay,initialThreadId}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;
  initialThreadId?:string;
}){
  const [messages,setMessages]=useState<any[]>([]); // flat list of all decrypted messages
  const [selectedThreadId,setSelectedThreadId]=useState<string|null>(initialThreadId||null); // root event ID
  const [replyBody,setReplyBody]=useState("");
  const [composing,setComposing]=useState(false);
  const [newSubject,setNewSubject]=useState("");
  const [newBody,setNewBody]=useState("");
  const [newNoReply,setNewNoReply]=useState(false);
  const [replyNoReply,setReplyNoReply]=useState(false);
  const [sending,setSending]=useState(false);
  const [loading,setLoading]=useState(true);
  // Read state shared with sidebar inbox
  const [readIds,setReadIds]=useState<Set<string>>(()=>{
    try{ return new Set(JSON.parse(localStorage.getItem("nostr_ehr_msg_read")||"[]")); }catch{ return new Set(); }
  });
  const markThreadRead=(rootId:string)=>{
    // Mark the root event ID as read
    setReadIds(s=>{ const n=new Set(s); n.add(rootId); localStorage.setItem("nostr_ehr_msg_read",JSON.stringify([...n])); return n; });
  };

  const prevPatientId=useRef<string|null>(null);
  useEffect(()=>{
    if(prevPatientId.current&&prevPatientId.current!==patient.id){
      setMessages([]); setSelectedThreadId(initialThreadId||null); setComposing(false); setReplyBody("");
    }
    prevPatientId.current=patient.id;
  },[patient.id]);

  useEffect(()=>{
    if(!keys)return;
    setLoading(true);
    const ss=_activeStaffSession;
    const practicePkHex=ss?.practicePkHex||keys.pkHex;
    const patientHex=patient.npub?npubToHex(patient.npub):null;
    // X₁ for practice-copy decryption
    const sharedX=ss?.practiceSharedSecret||getSharedSecret(keys.sk,keys.pkHex);
    // X₂ for patient-copy decryption (staff gets from grants, practice owner derives)
    const patientSharedX=patientHex?(ss?.patientSecrets?.get(patient.id)||getSharedSecret(keys.sk,patientHex)):null;
    const seenIds=new Set<string>();
    let eose1=false,eose2=!patientHex,loadingDone=false;
    const finish=()=>{ if(!loadingDone){loadingDone=true;setLoading(false);} };
    const check=()=>{ if(eose1&&eose2)finish(); };

    // Phase 1: Hydrate from cache instantly
    getCachedEvents(FHIR_KINDS.Message,patient.id).then(cached=>{
      if(cached.length>0){
        const msgs=cached.map(ce=>{
          try{
            const fromPractice=ce.pubkey!==patientHex;
            const subject=ce.tags.find((t:string[])=>t[0]==="subject")?.[1]||"(no subject)";
            const eTag=ce.tags.find((t:string[])=>t[0]==="e")?.[1];
            const rootId=eTag||ce.eventId;
            const noReply=ce.tags.some((t:string[])=>t[0]==="no-reply"&&t[1]==="true");
            seenIds.add(ce.eventId);
            return{event:{id:ce.eventId,created_at:ce.created_at,pubkey:ce.pubkey,kind:ce.kind,content:"",tags:ce.tags,sig:""},text:ce.fhirJson,fromPractice,subject,rootId,noReply};
          }catch{return null;}
        }).filter(Boolean);
        if(msgs.length>0){
          setMessages(msgs.sort((a:any,b:any)=>a.event.created_at-b.event.created_at));
          finish();
        }
      }
    }).catch(()=>{});

    // Phase 2: Relay overlay (skip if offline)
    if(relay.status!=="connected"){ setTimeout(finish,100); return; }

    const process=async(ev:NostrEvent)=>{
      if(seenIds.has(ev.id))return;
      seenIds.add(ev.id);
      // Filter by patient: only process messages for this patient
      const ptTag=ev.tags.find((t:string[])=>t[0]==="pt")?.[1];
      const evPTags=ev.tags.filter((t:string[])=>t[0]==="p").map(t=>t[1]);
      // Must be tagged with this patient's pubkey (via pt tag or p tag)
      if(ptTag && ptTag!==patient.id) return;
      if(!ptTag && patientHex && !evPTags.includes(patientHex)) return;
      try{
        // Detect guardian message: signed by guardian, tagged with child's pubkey
        const guardianOfTag=ev.tags.find((t:string[])=>t[0]==="guardian-of")?.[1];
        const isGuardianMsg=!!guardianOfTag && guardianOfTag===patientHex && ev.pubkey!==patientHex;
        // Practice-side = any pubkey that isn't the patient AND not a guardian
        const fromPractice=ev.pubkey!==patientHex && !isGuardianMsg;
        let plain:string|null=null;
        if(isGuardianMsg){
          // Guardian message: decrypt with getSharedSecret(practiceSk, guardianPk)
          const guardianSharedX=getSharedSecret(keys.sk,ev.pubkey);
          try{ plain=await nip44Decrypt(ev.content,guardianSharedX); }catch{}
        } else if(fromPractice){
          if(patientSharedX){ try{ plain=await nip44Decrypt(ev.content,patientSharedX); }catch{} }
          if(!plain){ try{ plain=await nip44Decrypt(ev.content,sharedX); }catch{} }
        } else if(patientSharedX){
          const pc=ev.tags.find((t:string[])=>t[0]==="patient-content")?.[1];
          if(pc){ try{ plain=await nip44Decrypt(pc,patientSharedX); }catch{} }
          if(!plain){ try{ plain=await nip44Decrypt(ev.content,patientSharedX); }catch{} }
        }
        if(plain){
          cacheEvent(ev.id,ev.kind,patient.id,ev.pubkey,ev.created_at,plain,ev.tags).catch(()=>{});
          const subject=ev.tags.find((t:string[])=>t[0]==="subject")?.[1]||"(no subject)";
          const eTag=ev.tags.find((t:string[])=>t[0]==="e")?.[1];
          const rootId=eTag||ev.id;
          const noReply=ev.tags.some((t:string[])=>t[0]==="no-reply"&&t[1]==="true");
          setMessages(prev=>{
            if(prev.find((m:any)=>m.event.id===ev.id))return prev;
            return [...prev,{event:ev,text:plain,fromPractice,subject,rootId,noReply,isGuardianMsg,guardianPk:isGuardianMsg?ev.pubkey:undefined}]
              .sort((a:any,b:any)=>a.event.created_at-b.event.created_at);
          });
        }
      }catch{}
    };
    
    // Single subscription: all kind 2117 events tagged with the practice pubkey
    // Catches: practice-authored, staff-authored, AND patient-authored (since patients tag practice pk)
    // Direction determined by fromPractice check in process callback
    const s1=relay.subscribe({kinds:[FHIR_KINDS.Message],"#p":[practicePkHex],limit:500},process,()=>{eose1=true;eose2=true;check();});
    const s2:string|null=null;
    const fb=setTimeout(()=>finish(),3000);
    return()=>{ clearTimeout(fb); relay.unsubscribe(s1); if(s2)relay.unsubscribe(s2); };
  },[patient.id,patient.npub,keys,relay.status,relay.syncTrigger]);

  // Auto-select thread whenever initialThreadId changes (sidebar re-click) or messages arrive
  useEffect(()=>{
    if(initialThreadId){
      setSelectedThreadId(initialThreadId);
    }
  },[initialThreadId]);
  useEffect(()=>{
    if(initialThreadId&&messages.length>0){
      setSelectedThreadId(initialThreadId);
    }
  },[messages.length]);

  // Group messages into threads keyed by rootId
  const threads=useMemo(()=>{
    const map:Record<string,any[]>={};
    messages.forEach(m=>{
      if(!map[m.rootId])map[m.rootId]=[];
      map[m.rootId].push(m);
    });
    // Sort threads by latest message timestamp desc
    return Object.entries(map)
      .map(([rootId,msgs])=>({rootId,msgs,latest:msgs[msgs.length-1]}))
      .sort((a,b)=>b.latest.event.created_at-a.latest.event.created_at);
  },[messages]);

  const selectedThread=threads.find(t=>t.rootId===selectedThreadId)||null;

  // Send new message (root)
  const send=async()=>{
    if(!keys||!patient.npub||!newBody.trim()||sending)return;
    setSending(true);
    try{
      const subject=newSubject.trim()||"Message from your provider";
      const extraTags:string[][]=[ ["subject",subject] ];
      if(newNoReply) extraTags.push(["no-reply","true"]);
      const event=await publishClinicalEvent({kind:FHIR_KINDS.Message,plaintext:newBody.trim(),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub),fhirType:"Message",keys,relay,
        extraTags});
      if(event){
        const newMsg={event:{...event,created_at:Math.floor(Date.now()/1000)},text:newBody.trim(),fromPractice:true,subject,rootId:event.id,noReply:newNoReply};
        setMessages(m=>[...m,newMsg]);
        setSelectedThreadId(event.id);
        setNewSubject(""); setNewBody(""); setNewNoReply(false); setComposing(false);
      }
    }finally{ setSending(false); }
  };

  // Reply to existing thread
  const sendReply=async()=>{
    if(!keys||!patient.npub||!replyBody.trim()||sending||!selectedThreadId)return;
    setSending(true);
    try{
      const rootMsg=selectedThread?.msgs[0];
      const subject=rootMsg?.subject||"Re: message";
      const replySubject=subject.startsWith("Re:")?subject:`Re: ${subject}`;
      const extraTags:string[][]=[ ["subject",replySubject],["e",selectedThreadId] ];
      if(replyNoReply) extraTags.push(["no-reply","true"]);
      const event=await publishClinicalEvent({kind:FHIR_KINDS.Message,plaintext:replyBody.trim(),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub),fhirType:"Message",keys,relay,
        extraTags});
      if(event){
        const newMsg={event:{...event,created_at:Math.floor(Date.now()/1000)},text:replyBody.trim(),fromPractice:true,subject:replySubject,rootId:selectedThreadId,noReply:replyNoReply};
        setMessages(m=>[...m,newMsg]);
        setReplyBody(""); setReplyNoReply(false);
      }
    }finally{ setSending(false); }
  };

  const fmtDate=(ts:number)=>new Date(ts*1000).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
  const relT=(ts:number)=>{
    const diff=Math.floor(Date.now()/1000)-ts;
    if(diff<3600)return`${Math.floor(diff/60)}m ago`;
    if(diff<86400)return`${Math.floor(diff/3600)}h ago`;
    if(diff<604800)return`${Math.floor(diff/86400)}d ago`;
    return new Date(ts*1000).toLocaleDateString("en-US",{month:"short",day:"numeric"});
  };

  if(loading)return(
    <div style={{...S.card,textAlign:"center",padding:40,color:"var(--text-muted)"}}>
      <div style={{fontSize:24,marginBottom:12}}>⏳</div>
      <div style={{fontSize:14}}>Loading messages...</div>
    </div>
  );

  return(
    <div style={{display:"flex",gap:0,height:"calc(100vh - 160px)",minHeight:400}}>
      {/* ── Thread list (left) ── */}
      <div style={{width:320,flexShrink:0,borderRight:"1px solid var(--border-subtle)",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--border-subtle)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontSize:13,fontWeight:700}}>💬 Messages <span style={{color:"var(--text-label)",fontWeight:400,fontSize:11}}>({threads.length})</span></div>
          <button onClick={()=>{setComposing(true);setSelectedThreadId(null);}} style={{
            background:"#0ea5e9",border:"none",color:"#fff",borderRadius:6,
            padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"
          }}>✏ Compose</button>
        </div>

        {!patient.npub&&(
          <div style={{margin:12,padding:"10px 12px",background:"var(--tint-red)",border:"1px solid #f87171",borderRadius:8,fontSize:11,color:"#f87171"}}>
            ⚠️ No portal access — generate an access code in Overview to enable messaging.
          </div>
        )}

        <div style={{flex:1,overflowY:"auto"}}>
          {threads.length===0&&(
            <div style={{padding:32,textAlign:"center",color:"var(--text-faint)",fontSize:12}}>No messages yet.</div>
          )}
          {threads.map(({rootId,msgs,latest})=>{
            const isSel=rootId===selectedThreadId;
            const isRead=readIds.has(rootId);
            const rootMsg=msgs[0];
            const replyCount=msgs.length-1;
            const threadNoReply=msgs.some((m:any)=>m.noReply);
            return(
              <div key={rootId} onClick={()=>{setSelectedThreadId(rootId);setComposing(false);markThreadRead(rootId);}}
                style={{
                  padding:"6px 14px",borderBottom:"1px solid var(--border-subtle)",cursor:"pointer",
                  background:isSel?"var(--bg-hover)":"transparent",
                  borderLeft:isSel?"3px solid #0ea5e9":isRead?"3px solid transparent":"3px solid #0ea5e944",
                  opacity:isRead&&!isSel?0.7:1,
                }}
                onMouseEnter={e=>{ if(!isSel)(e.currentTarget as HTMLElement).style.background="var(--bg-hover)"; }}
                onMouseLeave={e=>{ if(!isSel)(e.currentTarget as HTMLElement).style.background="transparent"; }}
              >
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:1}}>
                  <div style={{fontSize:12,fontWeight:isRead&&!isSel?400:600,color:latest.fromPractice?"var(--text-sender)":isRead&&!isSel?"var(--text-muted)":"var(--text-primary)",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis",maxWidth:200}}>
                    {rootMsg.fromPractice?"You (Practice)":"Patient"}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                    {threadNoReply&&<span style={{fontSize:9,color:"#f59e0b",background:"var(--bg-card)",border:"1px solid #f59e0b44",borderRadius:4,padding:"1px 5px"}}>🔒 No reply</span>}
                    {replyCount>0&&<span style={{fontSize:9,background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:99,padding:"1px 6px",color:"var(--text-muted)"}}>{replyCount} repl{replyCount===1?"y":"ies"}</span>}
                    <div style={{fontSize:10,color:"var(--text-label)"}}>{relT(latest.event.created_at)}</div>
                  </div>
                </div>
                <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)",marginBottom:3,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>
                  {rootMsg.subject}
                </div>
                <div style={{fontSize:11,color:"var(--text-label)",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>
                  {latest.text.slice(0,65)}{latest.text.length>65?"…":""}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right pane ── */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {!selectedThread&&!composing&&(
          <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--text-faint)",flexDirection:"column",gap:12}}>
            <div style={{fontSize:32}}>💬</div>
            <div style={{fontSize:13}}>Select a conversation or compose a new message</div>
          </div>
        )}

        {/* Thread detail */}
        {selectedThread&&!composing&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            {/* Thread header */}
            <div style={{padding:"16px 20px",borderBottom:"1px solid var(--border-subtle)",flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
                <div style={{fontSize:16,fontWeight:700}}>{selectedThread.msgs[0].subject}</div>
                {selectedThread.msgs.some((m:any)=>m.noReply)&&(
                  <span style={{fontSize:10,color:"#f59e0b",background:"var(--bg-card)",border:"1px solid #f59e0b44",borderRadius:5,padding:"2px 7px",fontWeight:600}}>🔒 No Reply</span>
                )}
              </div>
              <div style={{fontSize:11,color:"var(--text-label)"}}>{selectedThread.msgs.length} message{selectedThread.msgs.length!==1?"s":""} · with {patient.name}</div>
            </div>

            {/* Messages */}
            <div style={{flex:1,overflowY:"auto",padding:"14px 12px",display:"flex",flexDirection:"column",gap:12}}>
                {selectedThread.msgs.map((msg:any,i:number)=>{
                  const fromMe=msg.fromPractice;
                  const senderLabel=fromMe?"You (Practice)":msg.isGuardianMsg?(() => {
                    const guardians=loadPatients().filter(p=>p.npub&&npubToHex(p.npub)===msg.guardianPk);
                    return guardians[0]?.name ? `${guardians[0].name} (Guardian)` : "Guardian";
                  })():patient.name;
                  return(
                    <div key={msg.event.id} style={{display:"flex",flexDirection:"column",alignItems:fromMe?"flex-end":"flex-start"}}>
                      {/* Sender + timestamp */}
                      <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:4,
                        flexDirection:fromMe?"row-reverse":"row"}}>
                        <span style={{fontSize:11,fontWeight:600,color:fromMe?"var(--text-sender)":msg.isGuardianMsg?"#fbbf24":"var(--text-primary)"}}>
                          {senderLabel}
                        </span>
                        <span style={{fontSize:10,color:"var(--text-label)"}}>{fmtDate(msg.event.created_at)}</span>
                      </div>
                      {/* Bubble */}
                      <div style={{
                        maxWidth:"80%",
                        padding:"10px 14px",
                        borderRadius:fromMe?"16px 16px 4px 16px":"16px 16px 16px 4px",
                        background:fromMe?"var(--bg-sent)":"var(--bg-card)",
                        border:`1px solid ${fromMe?"var(--border-sent)":"var(--border)"}`,
                        fontSize:13,lineHeight:1.7,color:"var(--text-primary)",
                        whiteSpace:"pre-wrap",wordBreak:"break-word" as const,
                      }}>
                        {msg.text}
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Reply box or locked notice */}
            {patient.npub&&(
              selectedThread.msgs.some((m:any)=>m.noReply)
              ?(
                <div style={{padding:"12px 20px",borderTop:"1px solid var(--border-subtle)",flexShrink:0,
                  display:"flex",alignItems:"center",gap:10,background:"var(--bg-deep)"}}>
                  <span style={{fontSize:13}}>🔒</span>
                  <span style={{fontSize:12,color:"var(--text-muted)"}}>Reply disabled for this thread — patient cannot respond.</span>
                </div>
              ):(
                <div style={{padding:"12px 20px",borderTop:"1px solid var(--border-subtle)",flexShrink:0}}>
                  <textarea value={replyBody} onChange={e=>setReplyBody(e.target.value)}
                    placeholder="Write a reply..."
                    rows={3}
                    onKeyDown={e=>{if(e.key==="Enter"&&e.metaKey){e.preventDefault();sendReply();}}}
                    style={{...S.input,resize:"none",marginBottom:8,lineHeight:1.6}}
                    disabled={sending}
                  />
                  <div style={{display:"flex",alignItems:"center",gap:12}}>
                    <Btn solid col="#0ea5e9" onClick={sendReply} disabled={!replyBody.trim()||sending}>
                      {sending?"Sending…":"↩ Send Reply"}
                    </Btn>
                    <span style={{fontSize:10,color:"var(--text-faint)"}}>⌘+Enter</span>
                    <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",marginLeft:"auto"}}>
                      <input type="checkbox" checked={replyNoReply} onChange={e=>setReplyNoReply(e.target.checked)}
                        style={{accentColor:"#f59e0b",width:14,height:14,cursor:"pointer"}}/>
                      <span style={{fontSize:11,color:replyNoReply?"#f59e0b":"var(--text-label)",fontWeight:replyNoReply?600:400,userSelect:"none" as const}}>
                        Do not reply
                      </span>
                    </label>
                  </div>
                </div>
              )
            )}
          </div>
        )}

        {/* Compose new message */}
        {composing&&(
          <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:15,fontWeight:700}}>New Message</div>
              <button onClick={()=>setComposing(false)} style={{background:"none",border:"none",color:"var(--text-label)",cursor:"pointer",fontSize:18,lineHeight:1}}>✕</button>
            </div>
            <div style={{marginBottom:12}}>
              <label style={S.lbl}>To</label>
              <div style={{...S.input,color:"var(--text-muted)",padding:"8px 10px"}}>{patient.name}</div>
            </div>
            <div style={{marginBottom:12}}>
              <label style={S.lbl}>Subject</label>
              <input value={newSubject} onChange={e=>setNewSubject(e.target.value)}
                placeholder="Subject line..."
                style={{...S.input,padding:"8px 10px"}}/>
            </div>
            <div style={{marginBottom:16}}>
              <label style={S.lbl}>Message</label>
              <textarea value={newBody} onChange={e=>setNewBody(e.target.value)}
                placeholder="Type your message..."
                rows={10}
                style={{...S.input,resize:"vertical" as const,lineHeight:1.6}}/>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <Btn solid col="#0ea5e9" onClick={send} disabled={!newBody.trim()||sending||!patient.npub}>
                {sending?"Sending…":"Send Message"}
              </Btn>
              <Btn col="#475569" onClick={()=>{setComposing(false);setNewSubject("");setNewBody("");setNewNoReply(false);}}>Discard</Btn>
              <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",marginLeft:"auto"}}>
                <input type="checkbox" checked={newNoReply} onChange={e=>setNewNoReply(e.target.checked)}
                  style={{accentColor:"#f59e0b",width:14,height:14,cursor:"pointer"}}/>
                <span style={{fontSize:11,color:newNoReply?"#f59e0b":"var(--text-label)",fontWeight:newNoReply?600:400,userSelect:"none" as const}}>
                  Do not reply
                </span>
              </label>
            </div>
            {!patient.npub&&<div style={{marginTop:8,fontSize:11,color:"#f87171"}}>⚠️ Patient needs portal access to receive messages.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
// ─── Results View (Labs + Imaging tabs) ──────────────────────────────────────
// Shows all ServiceRequests of a given category (pending AND resulted).
// Pending orders show with an "Enter Result" button.
// Resulted orders show the DiagnosticReport inline.

// ── Lab analyte templates with LOINC codes and pediatric reference ranges ──
const LAB_ANALYTE_TEMPLATES: Record<string,{name:string;unit:string;refRange:string;loinc:string}[]> = {
  "CBC with differential": [
    {name:"WBC",        unit:"K/uL",  refRange:"4.5–13.5",  loinc:"6690-2"},
    {name:"RBC",        unit:"M/uL",  refRange:"4.0–5.5",   loinc:"789-8"},
    {name:"Hemoglobin", unit:"g/dL",  refRange:"11.5–15.5", loinc:"718-7"},
    {name:"Hematocrit", unit:"%",     refRange:"35–45",     loinc:"4544-3"},
    {name:"MCV",        unit:"fL",    refRange:"75–95",     loinc:"787-2"},
    {name:"MCH",        unit:"pg",    refRange:"24–33",     loinc:"785-6"},
    {name:"MCHC",       unit:"g/dL",  refRange:"31–37",     loinc:"786-4"},
    {name:"RDW",        unit:"%",     refRange:"11.5–14.5", loinc:"788-0"},
    {name:"Platelets",  unit:"K/uL",  refRange:"150–400",   loinc:"777-3"},
    {name:"Neutrophils",unit:"%",     refRange:"40–70",     loinc:"770-8"},
    {name:"Lymphocytes",unit:"%",     refRange:"20–45",     loinc:"736-9"},
    {name:"Monocytes",  unit:"%",     refRange:"2–10",      loinc:"5905-5"},
    {name:"Eosinophils",unit:"%",     refRange:"1–6",       loinc:"713-8"},
    {name:"Basophils",  unit:"%",     refRange:"0–2",       loinc:"706-2"},
  ],
  "Complete metabolic panel (CMP)": [
    {name:"Glucose",       unit:"mg/dL",  refRange:"70–100",   loinc:"2345-7"},
    {name:"BUN",           unit:"mg/dL",  refRange:"7–20",     loinc:"3094-0"},
    {name:"Creatinine",    unit:"mg/dL",  refRange:"0.3–0.7",  loinc:"2160-0"},
    {name:"Sodium",        unit:"mEq/L",  refRange:"136–145",  loinc:"2951-2"},
    {name:"Potassium",     unit:"mEq/L",  refRange:"3.5–5.0",  loinc:"2823-3"},
    {name:"Chloride",      unit:"mEq/L",  refRange:"98–106",   loinc:"2075-0"},
    {name:"CO2",           unit:"mEq/L",  refRange:"20–28",    loinc:"2028-9"},
    {name:"Calcium",       unit:"mg/dL",  refRange:"8.8–10.8", loinc:"17861-6"},
    {name:"Total Protein", unit:"g/dL",   refRange:"6.0–8.3",  loinc:"2885-2"},
    {name:"Albumin",       unit:"g/dL",   refRange:"3.5–5.5",  loinc:"1751-7"},
    {name:"Bilirubin Total",unit:"mg/dL", refRange:"0.1–1.2",  loinc:"1975-2"},
    {name:"Alk Phos",      unit:"U/L",    refRange:"100–400",  loinc:"6768-6"},
    {name:"AST",           unit:"U/L",    refRange:"10–40",    loinc:"1920-8"},
    {name:"ALT",           unit:"U/L",    refRange:"10–40",    loinc:"1742-6"},
  ],
  "Basic metabolic panel (BMP)": [
    {name:"Glucose",    unit:"mg/dL",  refRange:"70–100",   loinc:"2345-7"},
    {name:"BUN",        unit:"mg/dL",  refRange:"7–20",     loinc:"3094-0"},
    {name:"Creatinine", unit:"mg/dL",  refRange:"0.3–0.7",  loinc:"2160-0"},
    {name:"Sodium",     unit:"mEq/L",  refRange:"136–145",  loinc:"2951-2"},
    {name:"Potassium",  unit:"mEq/L",  refRange:"3.5–5.0",  loinc:"2823-3"},
    {name:"Chloride",   unit:"mEq/L",  refRange:"98–106",   loinc:"2075-0"},
    {name:"CO2",        unit:"mEq/L",  refRange:"20–28",    loinc:"2028-9"},
    {name:"Calcium",    unit:"mg/dL",  refRange:"8.8–10.8", loinc:"17861-6"},
  ],
  "Lipid panel": [
    {name:"Total Cholesterol",unit:"mg/dL", refRange:"<170",    loinc:"2093-3"},
    {name:"LDL",              unit:"mg/dL", refRange:"<110",    loinc:"2089-1"},
    {name:"HDL",              unit:"mg/dL", refRange:">45",     loinc:"2085-9"},
    {name:"Triglycerides",    unit:"mg/dL", refRange:"<150",    loinc:"2571-8"},
  ],
  "Iron studies": [
    {name:"Iron",        unit:"mcg/dL", refRange:"50–120",   loinc:"2498-4"},
    {name:"TIBC",        unit:"mcg/dL", refRange:"250–400",  loinc:"2500-7"},
    {name:"% Saturation",unit:"%",      refRange:"20–50",    loinc:"2502-3"},
    {name:"Ferritin",    unit:"ng/mL",  refRange:"12–150",   loinc:"2276-4"},
  ],
  "Urinalysis": [
    {name:"Color",         unit:"",     refRange:"Yellow",    loinc:"5778-6"},
    {name:"Clarity",       unit:"",     refRange:"Clear",     loinc:"32167-9"},
    {name:"Specific Gravity",unit:"",   refRange:"1.005–1.030",loinc:"2965-2"},
    {name:"pH",            unit:"",     refRange:"5.0–8.0",   loinc:"2756-5"},
    {name:"Protein",       unit:"",     refRange:"Negative",  loinc:"2888-6"},
    {name:"Glucose",       unit:"",     refRange:"Negative",  loinc:"2350-7"},
    {name:"Ketones",       unit:"",     refRange:"Negative",  loinc:"2514-8"},
    {name:"Blood",         unit:"",     refRange:"Negative",  loinc:"5794-3"},
    {name:"Nitrite",       unit:"",     refRange:"Negative",  loinc:"2514-8"},
    {name:"Leukocyte Esterase",unit:"", refRange:"Negative",  loinc:"5799-2"},
    {name:"WBC",           unit:"/hpf", refRange:"0–5",       loinc:"5821-4"},
    {name:"Bacteria",      unit:"",     refRange:"None",      loinc:"25145-4"},
  ],
  "Hemoglobin A1c": [
    {name:"HbA1c", unit:"%", refRange:"<5.7", loinc:"4548-4"},
  ],
  "TSH": [
    {name:"TSH", unit:"mIU/L", refRange:"0.5–4.5", loinc:"3016-3"},
  ],
  "Free T4": [
    {name:"Free T4", unit:"ng/dL", refRange:"0.8–1.8", loinc:"3024-7"},
  ],
  "Lead level": [
    {name:"Lead, Blood", unit:"mcg/dL", refRange:"<3.5", loinc:"5671-3"},
  ],
  "Ferritin": [
    {name:"Ferritin", unit:"ng/mL", refRange:"12–150", loinc:"2276-4"},
  ],
  "Vitamin D 25-OH": [
    {name:"25-OH Vitamin D", unit:"ng/mL", refRange:"30–100", loinc:"14635-7"},
  ],
};

// Parse a reference range string and auto-flag a numeric value
function autoFlagFromRange(value:string, refRange:string): "normal"|"high"|"low"|"critical" {
  const num=parseFloat(value);
  if(isNaN(num))return "normal";
  const range=refRange.trim();
  // Handle "<X" format (e.g. "<170", "<3.5")
  const ltMatch=range.match(/^<\s*([\d.]+)$/);
  if(ltMatch){
    const max=parseFloat(ltMatch[1]);
    return num>=max?"high":"normal";
  }
  // Handle ">X" format (e.g. ">45")
  const gtMatch=range.match(/^>\s*([\d.]+)$/);
  if(gtMatch){
    const min=parseFloat(gtMatch[1]);
    return num<=min?"low":"normal";
  }
  // Handle "low–high" or "low-high" format
  const rangeMatch=range.match(/([\d.]+)\s*[–\-—]\s*([\d.]+)/);
  if(rangeMatch){
    const lo=parseFloat(rangeMatch[1]);
    const hi=parseFloat(rangeMatch[2]);
    if(num<lo)return "low";
    if(num>hi)return "high";
    return "normal";
  }
  return "normal";
}

function getAnalyteTemplateRows(testName:string):{id:string;name:string;value:string;unit:string;refRange:string;flag:"normal";loinc:string}[]{
  const template=LAB_ANALYTE_TEMPLATES[testName];
  if(!template)return [];
  return template.map(t=>({id:crypto.randomUUID(),name:t.name,value:"",unit:t.unit,refRange:t.refRange,flag:"normal" as const,loinc:t.loinc}));
}

function ResultsView({patient,keys,relay,category}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;
  category:"lab"|"imaging";
}){
  const [orders,setOrders]=useState<any[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [entering,setEntering]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saveStatus,setSaveStatus]=useState<"idle"|"saved"|"error">("idle");
  type AnalyteFlag="normal"|"high"|"low"|"critical";
  interface AnalyteRow{id:string;name:string;value:string;unit:string;refRange:string;flag:AnalyteFlag;loinc?:string;}
  const newRow=():AnalyteRow=>({id:crypto.randomUUID(),name:"",value:"",unit:"",refRange:"",flag:"normal"});
  const emptyResultForm={resultText:"",interpretation:"normal" as "normal"|"abnormal"|"critical",impression:"",resultDate:new Date().toISOString().split("T")[0]};
  const [resultForm,setResultForm]=useState(emptyResultForm);
  const [analytes,setAnalytes]=useState<AnalyteRow[]>(()=>[newRow()]);
  const [standaloneMode,setStandaloneMode]=useState(false);
  const [standaloneForm,setStandaloneForm]=useState({test:"",customTest:""});

  const processResults=(items:{eventId:string;kind:number;created_at:number;fhir:any;tags:string[][]}[])=>{
    const orderEvents=items.filter(d=>d.fhir.resourceType==="ServiceRequest"&&d.fhir.category===category);
    const resultEvents=items.filter(d=>d.fhir.resourceType==="DiagnosticReport"&&d.fhir.category===category);
    const resultByOrder:Record<string,any>={};
    const standaloneResults:any[]=[];
    for(const r of resultEvents){
      const eTag=r.tags.find((t:string[])=>t[0]==="e"&&t[3]==="result");
      if(eTag) resultByOrder[eTag[1]]={event:{id:r.eventId,created_at:r.created_at,tags:r.tags},fhir:r.fhir};
      else standaloneResults.push(r);
    }
    const merged:any[]=orderEvents.map(o=>{
      const result=resultByOrder[o.eventId]||null;
      const cancelledTag=o.tags.find((t:string[])=>t[0]==="e"&&t[3]==="cancelled");
      const status:OrderStatus=cancelledTag?"cancelled":result?"resulted":"active";
      return{event:{id:o.eventId,created_at:o.created_at,tags:o.tags},fhir:o.fhir,result,status};
    });
    for(const sr of standaloneResults){
      merged.push({
        event:{id:sr.eventId,created_at:sr.created_at,tags:sr.tags},
        fhir:{resourceType:"ServiceRequest",code:sr.fhir.code,category:sr.fhir.category,
          subject:sr.fhir.subject,authoredOn:sr.fhir.issued},
        result:{event:{id:sr.eventId,created_at:sr.created_at,tags:sr.tags},fhir:sr.fhir},
        status:"resulted" as OrderStatus,standalone:true,
      });
    }
    merged.sort((a,b)=>b.event.created_at-a.event.created_at);
    setOrders(merged);
  };

  const load=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.ServiceRequest,FHIR_KINDS.DiagnosticReport],
      patientId:patient.id,
      keys,relay,
      processDecrypted:processResults,
      timeout:2500,
    });
  },[keys,relay,patient.id,category]);

  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);
  useEffect(()=>{setOrders([]);setSelectedId(null);setEntering(false);setStandaloneMode(false);setResultForm(emptyResultForm);},[patient.id,category]);

  const saveResult=async(order:any)=>{
    const validAnalytes=analytes.filter(a=>a.name.trim()&&a.value.trim());
    if(!keys)return;
    if(category==="lab"&&validAnalytes.length===0)return;
    if(category==="imaging"&&!resultForm.resultText.trim())return;
    const overallInterp:"normal"|"abnormal"|"critical"=category==="lab"
      ?(validAnalytes.some(a=>a.flag==="critical")?"critical"
        :validAnalytes.some(a=>a.flag==="high"||a.flag==="low")?"abnormal":"normal")
      :resultForm.interpretation;
    setSaving(true);
    try{
      const fhir=buildDiagnosticReport(
        patient.id,order.standalone?null:order.event.id,
        order.fhir.code?.text||"",
        category,
        resultForm.resultText,overallInterp,
        resultForm.impression,resultForm.resultDate,
        category==="lab"?validAnalytes.map(a=>({name:a.name,value:a.value,unit:a.unit,refRange:a.refRange,flag:a.flag,loinc:a.loinc||undefined})):undefined
      );
      const linkTag:string[][]=order.standalone?[]:[["e",order.event.id,"","result"]];
      if(await publishClinicalEvent({kind:FHIR_KINDS.DiagnosticReport,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"DiagnosticReport",keys,relay,
        extraTags:linkTag})){
        setEntering(false);setResultForm(emptyResultForm);setAnalytes([newRow()]);setSaveStatus("saved");
        setTimeout(()=>setSaveStatus("idle"),2000);
        load();
      } else {
        setSaveStatus("error");setTimeout(()=>setSaveStatus("idle"),3000);
      }
    }finally{setSaving(false);}
  };

  // ── Save standalone result (no linked order) ──
  const saveStandaloneResult=async()=>{
    const testName=standaloneForm.test==="custom"?standaloneForm.customTest:standaloneForm.test;
    if(!keys||!testName.trim())return;
    const validAnalytes=analytes.filter(a=>a.name.trim()&&a.value.trim());
    if(category==="lab"&&validAnalytes.length===0)return;
    if(category==="imaging"&&!resultForm.resultText.trim())return;
    const overallInterp:"normal"|"abnormal"|"critical"=category==="lab"
      ?(validAnalytes.some(a=>a.flag==="critical")?"critical"
        :validAnalytes.some(a=>a.flag==="high"||a.flag==="low")?"abnormal":"normal")
      :resultForm.interpretation;
    setSaving(true);
    try{
      const fhir=buildDiagnosticReport(
        patient.id,null,testName,category,
        resultForm.resultText,overallInterp,
        resultForm.impression,resultForm.resultDate,
        category==="lab"?validAnalytes.map(a=>({name:a.name,value:a.value,unit:a.unit,refRange:a.refRange,flag:a.flag,loinc:a.loinc||undefined})):undefined
      );
      if(await publishClinicalEvent({kind:FHIR_KINDS.DiagnosticReport,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"DiagnosticReport",keys,relay})){
        setStandaloneMode(false);setStandaloneForm({test:"",customTest:""});
        setResultForm(emptyResultForm);setAnalytes([newRow()]);setSaveStatus("saved");
        setTimeout(()=>setSaveStatus("idle"),2000);
        load();
      } else {
        setSaveStatus("error");setTimeout(()=>setSaveStatus("idle"),3000);
      }
    }finally{setSaving(false);}
  };

  const interpBadge=(i:string)=>{
    if(i==="critical")return <Badge t="⚠ Critical" col="#f87171" bg="var(--tint-red)"/>;
    if(i==="abnormal")return <Badge t="Abnormal"   col="#fbbf24" bg="var(--tint-amber)"/>;
    return <Badge t="Normal" col="var(--accent-green)" bg="var(--tint-green)"/>;
  };

  const pending=orders.filter(o=>o.status==="active");
  const resulted=orders.filter(o=>o.status==="resulted");
  const cancelled=orders.filter(o=>o.status==="cancelled");

  const renderOrder=(order:any)=>{
    const isSelected=selectedId===order.event.id;
    const borderCol=order.status==="resulted"?"var(--accent-green)":order.status==="cancelled"?"var(--text-faint)":"#f59e0b";
    return(
      <div key={order.event.id}
        onClick={(e)=>{
          if((e.target as HTMLElement).closest('button,input,textarea,select'))return;
          setSelectedId(id=>id===order.event.id?null:order.event.id);
          setEntering(false);setResultForm(emptyResultForm);
        }}
        style={{...S.card,cursor:"pointer",borderLeft:`3px solid ${borderCol}`,
          background:isSelected?"var(--bg-hover)":"var(--bg-card)"}}>

        {/* Collapsed row */}
        {!isSelected&&(
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontWeight:600,fontSize:13}}>
                {order.fhir.code?.text}
                {order.fhir.priority==="stat"&&<span style={{color:"#f87171",fontSize:10,marginLeft:6,fontWeight:700}}>STAT</span>}
              </div>
              <div style={{color:"var(--text-label)",fontSize:10,marginTop:2}}>
                {new Date(order.event.created_at*1000).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
                {order.fhir.reasonCode?.[0]?.text&&` · ${order.fhir.reasonCode[0].text}`}
              </div>
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              {order.status==="resulted"&&order.result&&interpBadge(order.result.fhir.interpretation)}
              {order.status==="active"&&<Badge t="Pending" col="#f59e0b" bg="var(--tint-amber)"/>}
              {order.status==="cancelled"&&<Badge t="Cancelled" col="#64748b" bg="var(--bg-app)"/>}
            </div>
          </div>
        )}

        {/* Expanded detail */}
        {isSelected&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>
                  {category==="imaging"?"🩻":"🧪"} {order.fhir.code?.text}
                  {order.fhir.priority==="stat"&&<span style={{color:"#f87171",fontSize:11,marginLeft:8,fontWeight:700}}>STAT</span>}
                </div>
                <div style={{color:"var(--text-muted)",fontSize:10,marginTop:3}}>
                  {new Date(order.event.created_at*1000).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
                </div>
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {order.status==="resulted"&&<Badge t="✓ Resulted" col="var(--accent-green)" bg="var(--tint-green)"/>}
                {order.status==="active"&&<Badge t="Pending" col="#f59e0b" bg="var(--tint-amber)"/>}
                {order.status==="cancelled"&&<Badge t="Cancelled" col="#64748b" bg="var(--bg-app)"/>}
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              {order.fhir.reasonCode?.[0]?.text&&(
                <div><span style={S.lbl}>Indication</span><div style={{fontSize:12}}>{order.fhir.reasonCode[0].text}</div></div>
              )}
              {order.fhir.performer?.[0]?.display&&(
                <div><span style={S.lbl}>{category==="imaging"?"Facility":"Lab"}</span>
                  <div style={{fontSize:12}}>{order.fhir.performer[0].display}</div></div>
              )}
              {order.fhir.note?.[0]?.text&&(
                <div><span style={S.lbl}>Instructions</span><div style={{fontSize:12}}>{order.fhir.note[0].text}</div></div>
              )}
            </div>

            {/* Result display */}
            {order.result&&(
              <div style={{...S.card,background:"var(--bg-deep)",border:"1px solid var(--border)",padding:"10px 12px",marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontWeight:600,fontSize:12}}>Result</div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {interpBadge(order.result.fhir.interpretation)}
                    <span style={{color:"var(--text-label)",fontSize:10}}>
                      Ordered {new Date(order.event.created_at*1000).toLocaleDateString("en-US",{month:"short",day:"numeric"})}
                      {" · "}
                      Resulted {order.result.fhir.effectiveDate
                        ? new Date(order.result.fhir.effectiveDate).toLocaleDateString("en-US",{month:"short",day:"numeric"})
                        : new Date(order.result.event.created_at*1000).toLocaleDateString("en-US",{month:"short",day:"numeric"})}
                    </span>
                  </div>
                </div>
                {/* Structured analyte table */}
                {order.result.fhir.analytes&&order.result.fhir.analytes.length>0&&(
                  <div style={{overflowX:"auto",marginBottom:order.result.fhir.result?8:0}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                      <thead>
                        <tr style={{borderBottom:"1px solid var(--border-accent)"}}>
                          {["Analyte","Value","Unit","Ref Range","Flag"].map(h=>(
                            <th key={h} style={{textAlign:"left",padding:"3px 6px",color:"var(--text-label)",fontWeight:600,fontSize:10}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {order.result.fhir.analytes.map((a:any,i:number)=>(
                          <tr key={i} style={{borderBottom:"1px solid var(--border-subtle)"}}>
                            <td style={{padding:"4px 6px",color:"var(--text-primary)"}}>{a.name}</td>
                            <td style={{padding:"4px 6px",fontWeight:600,
                              color:a.flag==="critical"?"#f87171":a.flag==="high"||a.flag==="low"?"#fbbf24":"var(--text-primary)"}}>
                              {a.value}
                            </td>
                            <td style={{padding:"4px 6px",color:"var(--text-muted)"}}>{a.unit}</td>
                            <td style={{padding:"4px 6px",color:"var(--text-muted)"}}>{a.refRange}</td>
                            <td style={{padding:"4px 6px"}}>
                              {a.flag==="critical"&&<Badge t="CRIT" col="#f87171" bg="var(--tint-red)"/>}
                              {a.flag==="high"&&<Badge t="H" col="#fbbf24" bg="var(--tint-amber)"/>}
                              {a.flag==="low"&&<Badge t="L" col="#93c5fd" bg="var(--bg-inset)"/>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {order.result.fhir.conclusion&&(
                  <div style={{marginBottom:6}}>
                    <span style={S.lbl}>Impression</span>
                    <div style={{fontSize:12,fontStyle:"italic"}}>{order.result.fhir.conclusion}</div>
                  </div>
                )}
                {order.result.fhir.result&&(
                  <div style={{...S.mono,fontSize:11,whiteSpace:"pre-wrap",maxHeight:200,overflowY:"auto"}}>
                    {order.result.fhir.result}
                  </div>
                )}
              </div>
            )}

            {/* Enter result (pending only) */}
            {order.status==="active"&&!entering&&canDo("sign")&&(
              <div style={{marginTop:8}}>
                <Btn solid col="var(--accent-green)" small onClick={()=>{
                  setEntering(true);setResultForm(emptyResultForm);
                  // Auto-populate analytes from template if available
                  const testName=order.fhir.code?.text||"";
                  const templateRows=getAnalyteTemplateRows(testName);
                  setAnalytes(templateRows.length>0?templateRows:[newRow()]);
                }}>
                  + Enter Result
                </Btn>
              </div>
            )}

            {/* Result entry form */}
            {entering&&order.event.id===selectedId&&(
              <div style={{...S.card,marginTop:10,border:"1px solid var(--border-accent)",background:"var(--bg-deep)"}}>
                <div style={{fontWeight:600,fontSize:12,marginBottom:10}}>
                  📋 Enter Result — {order.fhir.code?.text}
                </div>

                {category==="lab"?(
                  <>
                    <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 2fr 1fr auto",gap:4,marginBottom:4}}>
                      {["Analyte","Value","Unit","Ref Range","Flag",""].map(h=>(
                        <span key={h} style={{...S.lbl,marginBottom:0}}>{h}</span>
                      ))}
                    </div>
                    {analytes.map((row,idx)=>(
                      <div key={row.id} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 2fr 1fr auto",gap:4,marginBottom:4,alignItems:"center"}}>
                        <input value={row.name} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,name:e.target.value}:r))}
                          style={{...S.input,fontSize:11}} placeholder="e.g. WBC"/>
                        <input value={row.value} onChange={e=>{
                          const val=e.target.value;
                          setAnalytes(a=>a.map((r,i)=>{
                            if(i!==idx)return r;
                            const flag=val.trim()&&r.refRange.trim()?autoFlagFromRange(val,r.refRange):r.flag;
                            return {...r,value:val,flag};
                          }));
                        }}
                          style={{...S.input,fontSize:11,
                            borderColor:row.flag==="critical"?"#f87171":row.flag==="high"||row.flag==="low"?"#fbbf24":"",
                          }} placeholder="8.2"/>
                        <input value={row.unit} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,unit:e.target.value}:r))}
                          style={{...S.input,fontSize:11}} placeholder="K/uL"/>
                        <input value={row.refRange} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,refRange:e.target.value}:r))}
                          style={{...S.input,fontSize:11}} placeholder="4.5–11.0"/>
                        <select value={row.flag} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,flag:e.target.value as AnalyteFlag}:r))}
                          style={{...S.input,fontSize:11,cursor:"pointer",padding:"8px 4px",
                            color:row.flag==="critical"?"#f87171":row.flag==="high"||row.flag==="low"?"#fbbf24":"inherit",
                          }}>
                          <option value="normal">Nml</option>
                          <option value="high">H</option>
                          <option value="low">L</option>
                          <option value="critical">CRIT</option>
                        </select>
                        <button onClick={()=>setAnalytes(a=>a.length>1?a.filter((_,i)=>i!==idx):a)}
                          style={{background:"transparent",border:"none",color:"var(--text-label)",cursor:"pointer",fontSize:16,padding:"0 4px"}}>×</button>
                      </div>
                    ))}
                    <Btn small col="#475569" onClick={()=>setAnalytes(a=>[...a,newRow()])}>+ Add Row</Btn>
                    <div style={{marginTop:8}}>
                      <label style={S.lbl}>Notes (optional)</label>
                      <input value={resultForm.resultText}
                        onChange={e=>setResultForm(f=>({...f,resultText:e.target.value}))}
                        style={S.input} placeholder="e.g. Specimen hemolyzed, repeat recommended"/>
                    </div>
                    <div style={{marginTop:8}}>
                      <label style={S.lbl}>Date Resulted</label>
                      <input type="date" value={resultForm.resultDate}
                        onChange={e=>setResultForm(f=>({...f,resultDate:e.target.value}))}
                        style={{...S.input,width:"auto"}}/>
                    </div>
                  </>
                ):(
                  <>
                    <div style={{marginBottom:8}}>
                      <label style={S.lbl}>Report</label>
                      <textarea value={resultForm.resultText}
                        onChange={e=>setResultForm(f=>({...f,resultText:e.target.value}))}
                        rows={6} placeholder="Paste radiology report here…"
                        style={{...S.input,resize:"vertical" as const,lineHeight:1.6,fontFamily:"monospace",fontSize:12}}/>
                    </div>
                    <div style={{marginBottom:8}}>
                      <label style={S.lbl}>Impression (brief summary)</label>
                      <input value={resultForm.impression}
                        onChange={e=>setResultForm(f=>({...f,impression:e.target.value}))}
                        style={S.input} placeholder="e.g. No acute cardiopulmonary process"/>
                    </div>
                    <div style={{...S.grid2,marginBottom:8}}>
                      <div>
                        <label style={S.lbl}>Interpretation</label>
                        <select value={resultForm.interpretation}
                          onChange={e=>setResultForm(f=>({...f,interpretation:e.target.value as "normal"|"abnormal"|"critical"}))}
                          style={{...S.input,cursor:"pointer"}}>
                          <option value="normal">Normal</option>
                          <option value="abnormal">Abnormal</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>
                      <div>
                        <label style={S.lbl}>Date Resulted</label>
                        <input type="date" value={resultForm.resultDate}
                          onChange={e=>setResultForm(f=>({...f,resultDate:e.target.value}))}
                          style={S.input}/>
                      </div>
                    </div>
                  </>
                )}

                <div style={{display:"flex",gap:8,alignItems:"center",marginTop:10}}>
                  <Btn solid col="var(--accent-green)"
                    disabled={saving||(category==="lab"?analytes.filter(a=>a.name.trim()&&a.value.trim()).length===0:!resultForm.resultText.trim())}
                    onClick={()=>saveResult(order)}>
                    {saving?"⏳ Saving…":"✓ Save Result"}
                  </Btn>
                  <Btn col="#475569" onClick={()=>{setEntering(false);setResultForm(emptyResultForm);setAnalytes([newRow()]);}}>Cancel</Btn>
                  {saveStatus==="error"&&<span style={{color:"#f87171",fontSize:11}}>✗ Failed</span>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:14}}>
          {category==="imaging"?"🩻 Imaging":"🧪 Labs"}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {saveStatus==="saved"&&<Badge t="✓ Saved" col="var(--accent-green)" bg="var(--tint-green)"/>}
          {pending.length>0&&<Badge t={`${pending.length} pending`} col="#f59e0b" bg="var(--tint-amber)"/>}
          <Btn small solid col="var(--accent-green)" onClick={()=>{
            setStandaloneMode(!standaloneMode);setEntering(false);
            setStandaloneForm({test:"",customTest:""});
            setResultForm(emptyResultForm);setAnalytes([newRow()]);
          }}>
            {standaloneMode?"Cancel":"+ Enter Result (No Order)"}
          </Btn>
        </div>
      </div>

      {/* ── Standalone result entry (no linked order) ── */}
      {standaloneMode&&(
        <div style={{...S.card,marginBottom:16,border:"1px solid var(--border)",background:"var(--bg-deep)"}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>
            📋 Enter Result — No Linked Order
          </div>
          <div style={{marginBottom:10}}>
            <label style={S.lbl}>{category==="lab"?"Test Name":"Study"}</label>
            {category==="lab"?(
              <select value={standaloneForm.test} onChange={e=>{
                const val=e.target.value;
                setStandaloneForm(f=>({...f,test:val}));
                if(val&&val!=="custom"){
                  const templateRows=getAnalyteTemplateRows(val);
                  if(templateRows.length>0) setAnalytes(templateRows);
                }
              }} style={{...S.input,cursor:"pointer"}}>
                <option value="">Select a test…</option>
                {LAB_TESTS.map(t=><option key={t.loinc} value={t.display}>{t.display}</option>)}
                <option value="custom">— Custom test —</option>
              </select>
            ):(
              <select value={standaloneForm.test} onChange={e=>setStandaloneForm(f=>({...f,test:e.target.value}))}
                style={{...S.input,cursor:"pointer"}}>
                <option value="">Select a study…</option>
                {IMAGING_STUDIES.map(s=><option key={s} value={s}>{s}</option>)}
                <option value="custom">— Custom study —</option>
              </select>
            )}
            {standaloneForm.test==="custom"&&(
              <input value={standaloneForm.customTest} onChange={e=>setStandaloneForm(f=>({...f,customTest:e.target.value}))}
                style={{...S.input,marginTop:6}} placeholder={category==="lab"?"e.g. Celiac panel":"e.g. Wrist X-Ray"}/>
            )}
          </div>

          {category==="lab"?(
            <>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 2fr 1fr auto",gap:4,marginBottom:4}}>
                {["Analyte","Value","Unit","Ref Range","Flag",""].map(h=>(
                  <span key={h} style={{...S.lbl,marginBottom:0}}>{h}</span>
                ))}
              </div>
              {analytes.map((row,idx)=>(
                <div key={row.id} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 2fr 1fr auto",gap:4,marginBottom:4,alignItems:"center"}}>
                  <input value={row.name} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,name:e.target.value}:r))}
                    style={{...S.input,fontSize:11}} placeholder="e.g. WBC"/>
                  <input value={row.value} onChange={e=>{
                    const val=e.target.value;
                    setAnalytes(a=>a.map((r,i)=>{
                      if(i!==idx)return r;
                      const flag=val.trim()&&r.refRange.trim()?autoFlagFromRange(val,r.refRange):r.flag;
                      return {...r,value:val,flag};
                    }));
                  }}
                    style={{...S.input,fontSize:11,
                      borderColor:row.flag==="critical"?"#f87171":row.flag==="high"||row.flag==="low"?"#fbbf24":"",
                    }} placeholder="8.2"/>
                  <input value={row.unit} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,unit:e.target.value}:r))}
                    style={{...S.input,fontSize:11}} placeholder="K/uL"/>
                  <input value={row.refRange} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,refRange:e.target.value}:r))}
                    style={{...S.input,fontSize:11}} placeholder="4.5–11.0"/>
                  <select value={row.flag} onChange={e=>setAnalytes(a=>a.map((r,i)=>i===idx?{...r,flag:e.target.value as AnalyteFlag}:r))}
                    style={{...S.input,fontSize:11,cursor:"pointer",padding:"8px 4px",
                      color:row.flag==="critical"?"#f87171":row.flag==="high"||row.flag==="low"?"#fbbf24":"inherit",
                    }}>
                    <option value="normal">Nml</option>
                    <option value="high">H</option>
                    <option value="low">L</option>
                    <option value="critical">CRIT</option>
                  </select>
                  <button onClick={()=>setAnalytes(a=>a.length>1?a.filter((_,i)=>i!==idx):a)}
                    style={{background:"transparent",border:"none",color:"var(--text-label)",cursor:"pointer",fontSize:16,padding:"0 4px"}}>×</button>
                </div>
              ))}
              <Btn small col="#475569" onClick={()=>setAnalytes(a=>[...a,newRow()])}>+ Add Row</Btn>
              <div style={{marginTop:8}}>
                <label style={S.lbl}>Notes (optional)</label>
                <input value={resultForm.resultText}
                  onChange={e=>setResultForm(f=>({...f,resultText:e.target.value}))}
                  style={S.input} placeholder="e.g. Specimen hemolyzed, repeat recommended"/>
              </div>
            </>
          ):(
            <>
              <div style={{marginBottom:8}}>
                <label style={S.lbl}>Report</label>
                <textarea value={resultForm.resultText}
                  onChange={e=>setResultForm(f=>({...f,resultText:e.target.value}))}
                  rows={6} placeholder="Paste radiology report here…"
                  style={{...S.input,resize:"vertical" as const,lineHeight:1.6,fontFamily:"monospace",fontSize:12}}/>
              </div>
              <div style={{marginBottom:8}}>
                <label style={S.lbl}>Impression</label>
                <input value={resultForm.impression}
                  onChange={e=>setResultForm(f=>({...f,impression:e.target.value}))}
                  style={S.input} placeholder="e.g. No acute cardiopulmonary process"/>
              </div>
              <div style={{...S.grid2,marginBottom:8}}>
                <div>
                  <label style={S.lbl}>Interpretation</label>
                  <select value={resultForm.interpretation}
                    onChange={e=>setResultForm(f=>({...f,interpretation:e.target.value as any}))}
                    style={{...S.input,cursor:"pointer"}}>
                    <option value="normal">Normal</option>
                    <option value="abnormal">Abnormal</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
                <div>
                  <label style={S.lbl}>Date Resulted</label>
                  <input type="date" value={resultForm.resultDate}
                    onChange={e=>setResultForm(f=>({...f,resultDate:e.target.value}))}
                    style={S.input}/>
                </div>
              </div>
            </>
          )}
          {category==="lab"&&(
            <div style={{marginTop:8}}>
              <label style={S.lbl}>Date Resulted</label>
              <input type="date" value={resultForm.resultDate}
                onChange={e=>setResultForm(f=>({...f,resultDate:e.target.value}))}
                style={{...S.input,width:"auto"}}/>
            </div>
          )}
          <div style={{display:"flex",gap:8,alignItems:"center",marginTop:10}}>
            <Btn solid col="var(--accent-green)"
              disabled={saving||!(standaloneForm.test==="custom"?standaloneForm.customTest.trim():standaloneForm.test)||(category==="lab"?analytes.filter(a=>a.name.trim()&&a.value.trim()).length===0:!resultForm.resultText.trim())}
              onClick={saveStandaloneResult}>
              {saving?"⏳ Saving…":"✓ Save Result"}
            </Btn>
            <Btn col="#475569" onClick={()=>{setStandaloneMode(false);setResultForm(emptyResultForm);setAnalytes([newRow()]);}}>Cancel</Btn>
          </div>
        </div>
      )}

      {orders.length===0&&!standaloneMode&&(
        <div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:32}}>
          No {category==="imaging"?"imaging":"lab"} orders or results yet
        </div>
      )}

      {/* Pending section */}
      {pending.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:10,color:"var(--text-label)",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:6}}>
            Pending
          </div>
          {pending.map(renderOrder)}
        </div>
      )}

      {/* Resulted section */}
      {resulted.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:10,color:"var(--text-label)",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:6}}>
            Resulted
          </div>
          {resulted.map(renderOrder)}
        </div>
      )}

      {/* Cancelled section */}
      {cancelled.length>0&&(
        <div style={{opacity:0.5}}>
          <div style={{fontSize:10,color:"var(--text-label)",textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:6}}>
            Cancelled
          </div>
          {cancelled.map(renderOrder)}
        </div>
      )}
    </div>
  );
}

// ─── Orders View ──────────────────────────────────────────────────────────────
type OrderCategory = "lab"|"imaging"|"rx";
type OrderStatus   = "active"|"resulted"|"cancelled";

// Common picklists
const LAB_TESTS:{display:string;loinc:string}[]=[
  {display:"CBC with differential",          loinc:"58410-2"},
  {display:"Complete metabolic panel (CMP)", loinc:"24323-8"},
  {display:"Basic metabolic panel (BMP)",    loinc:"51990-0"},
  {display:"Hemoglobin A1c",                 loinc:"4548-4"},
  {display:"TSH",                            loinc:"3016-3"},
  {display:"Free T4",                        loinc:"3024-7"},
  {display:"Lead level",                     loinc:"5671-3"},
  {display:"Lipid panel",                    loinc:"57698-3"},
  {display:"Urinalysis",                     loinc:"24357-6"},
  {display:"Urine culture",                  loinc:"630-4"},
  {display:"Group A Strep rapid",            loinc:"11268-0"},
  {display:"Flu A/B rapid",                  loinc:"92142-9"},
  {display:"COVID-19",                       loinc:"94500-6"},
  {display:"Ferritin",                       loinc:"2276-4"},
  {display:"Iron studies",                   loinc:"24360-0"},
  {display:"Vitamin D 25-OH",               loinc:"14635-7"},
  {display:"Hepatitis B surface Ag",         loinc:"5195-3"},
  {display:"Hepatitis B surface Ab",         loinc:"10900-9"},
  {display:"HIV 4th gen",                    loinc:"89365-1"},
  {display:"RPR",                            loinc:"20507-0"},
  {display:"Newborn screen (state panel)",   loinc:"54089-8"},
];
const IMAGING_STUDIES = [
  "Chest X-Ray PA/Lateral","Chest X-Ray AP (portable)","Abdominal X-Ray",
  "Hip ultrasound","Renal/bladder ultrasound","Testicular ultrasound",
  "Sinus X-Ray","Bone age (left hand)","Spine X-Ray","Echocardiogram",
  "Head CT","Abdominal CT","Chest CT","Brain MRI","Spine MRI",
];

function OrdersView({patient,keys,relay,autoOpen,onAutoOpenConsumed}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;
  autoOpen?:"lab"|"imaging"|"rx"|null;
  onAutoOpenConsumed?:()=>void;
}){
  type OrderTab = "lab"|"imaging"|"rx";
  const [orderTab,setOrderTab]=useState<OrderTab>(autoOpen??(  "lab"));
  const [orders,setOrders]=useState<any[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [adding,setAdding]=useState(()=>!!autoOpen);
  const [entering,setEntering]=useState(false); // entering result for selected order
  const [statusFilter,setStatusFilter]=useState<"all"|OrderStatus>("all");
  const [saving,setSaving]=useState(false);
  const [saveStatus,setSaveStatus]=useState<"idle"|"saved"|"error">("idle");

  // ── Lab / Imaging order form ──
  const emptyLabForm={test:"",customTest:"",indication:"",priority:"routine" as "routine"|"stat",facility:"",instructions:""};
  const [labForm,setLabForm]=useState(emptyLabForm);

  // ── Rx order form ──
  const emptyRxForm={
    drug:"",dose:"",sig:"",route:"oral",qty:"",
    daysSupply:"",refills:"0",daw:false,pharmacy:"",indication:""
  };
  const [rxForm,setRxForm]=useState(emptyRxForm);

  // ── Result entry form ──
  const emptyResultForm={resultText:"",interpretation:"normal" as "normal"|"abnormal"|"critical",impression:"",resultDate:new Date().toISOString().split("T")[0]};
  const [resultForm,setResultForm]=useState(emptyResultForm);
  const [allergies,setAllergies]=useState<string[]>([]);
  useEffect(()=>{
    (async()=>{
      const cached=await getCachedEvents(FHIR_KINDS.AllergyIntolerance,patient.id);
      const names=cached.map(c=>{
        try{const f=JSON.parse(c.fhirJson);return f.code?.text||f.substance?.text||"";}catch{return "";}
      }).filter(Boolean).map(n=>n.toLowerCase());
      setAllergies(names);
    })();
  },[patient.id]);

  // Drug-class cross-reactivity map: allergen → related drug names
  // If a patient is allergic to "penicillin", prescribing "amoxicillin" should flag.
  const DRUG_CLASS_MAP: Record<string,string[]> = {
    "penicillin":    ["amoxicillin","amoxil","augmentin","ampicillin","unasyn","piperacillin","zosyn","nafcillin","dicloxacillin","penicillin"],
    "amoxicillin":   ["penicillin","augmentin","ampicillin","amoxil"],
    "cephalosporin": ["cephalexin","keflex","cefdinir","omnicef","ceftriaxone","rocephin","cefazolin","cefuroxime","cefixime","suprax","cefepime","ceclor","cefaclor"],
    "sulfa":         ["sulfamethoxazole","bactrim","septra","trimethoprim","sulfasalazine","sulfonamide"],
    "sulfamethoxazole":["bactrim","septra","sulfa","trimethoprim-sulfamethoxazole","tmp-smx"],
    "nsaid":         ["ibuprofen","motrin","advil","naproxen","aleve","ketorolac","toradol","meloxicam","diclofenac","indomethacin","celecoxib"],
    "ibuprofen":     ["nsaid","motrin","advil","naproxen","aleve","ketorolac"],
    "aspirin":       ["ibuprofen","nsaid","motrin","advil","naproxen","ketorolac"],
    "codeine":       ["hydrocodone","oxycodone","morphine","tramadol"],
    "morphine":      ["codeine","hydrocodone","oxycodone","hydromorphone"],
    "erythromycin":  ["azithromycin","zithromax","clarithromycin","biaxin"],
    "azithromycin":  ["erythromycin","clarithromycin","zithromax","z-pack"],
    "egg":           ["fluzone","influenza","flu vaccine"],
    "latex":         [],
    "contrast":      [],
  };

  const checkAllergyInteraction = (drugName: string): {matched:boolean; allergen:string; message:string} | null => {
    if (!drugName.trim() || allergies.length === 0) return null;
    const drugLower = drugName.toLowerCase();

    for (const allergen of allergies) {
      // Direct match: allergen name appears in drug name or vice versa
      if (drugLower.includes(allergen) || allergen.includes(drugLower.split(/\s/)[0])) {
        return { matched: true, allergen, message: `Patient has a documented allergy to "${allergen}"` };
      }

      // Class-based match: check if the allergen's drug class includes this drug
      for (const [classKey, classMembers] of Object.entries(DRUG_CLASS_MAP)) {
        const allergenMatchesClass = allergen.includes(classKey) || classMembers.some(m => allergen.includes(m));
        if (allergenMatchesClass) {
          const drugMatchesClass = drugLower.includes(classKey) || classMembers.some(m => drugLower.includes(m));
          if (drugMatchesClass) {
            return { matched: true, allergen, message: `Patient is allergic to "${allergen}" — "${drugName.split(/\s/)[0]}" is in the same drug class` };
          }
        }
      }
    }
    return null;
  };

  const allergyWarning = checkAllergyInteraction(rxForm.drug);

  // ── Load all orders for this patient ──
  const load=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.ServiceRequest,FHIR_KINDS.DiagnosticReport],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        const orderEvents=items.filter(d=>d.fhir.resourceType==="ServiceRequest");
        const resultEvents=items.filter(d=>d.fhir.resourceType==="DiagnosticReport");
        const resultByOrder:Record<string,any>={};
        for(const r of resultEvents){
          const eTag=r.tags.find((t:string[])=>t[0]==="e"&&t[3]==="result");
          if(eTag) resultByOrder[eTag[1]]={event:{id:r.eventId,created_at:r.created_at,tags:r.tags},fhir:r.fhir};
        }
        const merged=orderEvents.map(o=>{
          const result=resultByOrder[o.eventId]||null;
          const cancelledTag=o.tags.find((t:string[])=>t[0]==="e"&&t[3]==="cancelled");
          const status:OrderStatus=cancelledTag?"cancelled":result?"resulted":"active";
          return{event:{id:o.eventId,created_at:o.created_at,tags:o.tags},fhir:o.fhir,result,status};
        });
        merged.sort((a,b)=>b.event.created_at-a.event.created_at);
        setOrders(merged);
      },
      timeout:2500,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setOrders([]);},[patient.id]);
  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);
  // When switching patient tabs, reset UI state
  useEffect(()=>{ onAutoOpenConsumed?.(); },[]);

  // ── Filtered + categorised orders for current sub-tab ──
  const categoryForFhir=(fhir:any):OrderTab=>fhir.category==="imaging"?"imaging":"lab";
  const visibleOrders=orders.filter(o=>
    categoryForFhir(o.fhir)===orderTab && o.status==="active"
  );
  const selected=visibleOrders.find(o=>o.event.id===selectedId)||null;

  // ── Save a lab or imaging order ──
  const saveLabOrder=async()=>{
    if(!keys)return;
    const testName=labForm.test==="__custom__"?labForm.customTest.trim():labForm.test;
    if(!testName)return;
    const loincCode=orderTab==="lab"
      ? LAB_TESTS.find(t=>t.display===labForm.test)?.loinc
      : undefined;
    setSaving(true);
    try{
      const fhir=buildServiceRequest(
        patient.id,orderTab as "lab"|"imaging",
        testName,labForm.indication,
        labForm.priority,labForm.facility,labForm.instructions,
        loincCode
      );
      if(await publishClinicalEvent({kind:FHIR_KINDS.ServiceRequest,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"ServiceRequest",keys,relay,
        extraTags:[["category",orderTab],["priority",labForm.priority],["order-status","active"]]})){
        setLabForm(emptyLabForm);setAdding(false);setSaveStatus("saved");
        setTimeout(()=>setSaveStatus("idle"),2000);
        load();
      } else {
        setSaveStatus("error");setTimeout(()=>setSaveStatus("idle"),3000);
      }
    }finally{setSaving(false);}
  };

  // ── Save an Rx order ──
  const saveRxOrder=async()=>{
    if(!keys||!rxForm.drug.trim()||!rxForm.sig.trim())return;
    // Allergy interaction gate — require explicit confirmation
    if(allergyWarning){
      const confirmed=window.confirm(
        `⚠️ ALLERGY ALERT\n\n${allergyWarning.message}\n\nAre you sure you want to prescribe "${rxForm.drug}"?`
      );
      if(!confirmed)return;
    }
    setSaving(true);
    try{
      // Publish as MedicationRequest (kind 2112) so it lands in the Medications tab.
      // All Rx fields are stored in the FHIR payload alongside the standard fields.
      const fhir={
        resourceType:"MedicationRequest",
        id:crypto.randomUUID(),
        status:"active",
        intent:"order",
        subject:{reference:`Patient/${patient.id}`},
        medicationCodeableConcept:{text:rxForm.drug},
        // Standard dosage field (for backwards compat with MedicationList display)
        dosageInstruction:[{text:`${rxForm.dose} ${rxForm.sig}`.trim()}],
        authoredOn:new Date().toISOString(),
        // Extended Rx fields — displayed in MedicationList when present
        drug:rxForm.drug,
        dose:rxForm.dose,
        sig:rxForm.sig,
        route:rxForm.route,
        qty:rxForm.qty,
        daysSupply:parseInt(rxForm.daysSupply)||0,
        refills:parseInt(rxForm.refills)||0,
        daw:rxForm.daw,
        pharmacy:rxForm.pharmacy||undefined,
        indication:rxForm.indication||undefined,
      };
      if(await publishClinicalEvent({kind:FHIR_KINDS.MedicationRequest,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"MedicationRequest",keys,relay})){
        setRxForm(emptyRxForm);setAdding(false);setSaveStatus("saved");
        setTimeout(()=>setSaveStatus("idle"),2000);
        // Note: do NOT call load() here — this event is kind 2112 and won't appear
        // in OrdersView's subscription (which only watches ServiceRequest/DiagnosticReport)
      } else {
        setSaveStatus("error");setTimeout(()=>setSaveStatus("idle"),3000);
      }
    }finally{setSaving(false);}
  };

  // ── Save a result (DiagnosticReport) for a ServiceRequest ──
  const saveResult=async()=>{
    if(!keys||!selected||!resultForm.resultText.trim())return;
    setSaving(true);
    try{
      const fhir=buildDiagnosticReport(
        patient.id,selected.event.id,
        selected.fhir.code?.text||selected.fhir.drug||"",
        selected.fhir.category||"lab",
        resultForm.resultText,resultForm.interpretation,
        resultForm.impression,resultForm.resultDate
      );
      if(await publishClinicalEvent({kind:FHIR_KINDS.DiagnosticReport,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"DiagnosticReport",keys,relay,
        extraTags:[["e",selected.event.id,"","result"]]})){
        setEntering(false);setResultForm(emptyResultForm);setSaveStatus("saved");
        setTimeout(()=>setSaveStatus("idle"),2000);
        load();
      } else {
        setSaveStatus("error");setTimeout(()=>setSaveStatus("idle"),3000);
      }
    }finally{setSaving(false);}
  };

  // ── Cancel an order (appends a cancellation marker event) ──
  const cancelOrder=async(orderId:string,resourceType:string)=>{
    if(!keys)return;
    // Publish a tombstone: same kind, minimal payload, carries ["e", orderId, "", "cancelled"] tag
    const fhir={resourceType,id:crypto.randomUUID(),status:"cancelled",subject:{reference:`Patient/${patient.id}`},authoredOn:new Date().toISOString()};
    const kind=resourceType==="RxOrder"?FHIR_KINDS.RxOrder:FHIR_KINDS.ServiceRequest;
    if(await publishClinicalEvent({kind,plaintext:JSON.stringify(fhir),
      patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:resourceType,keys,relay,
      extraTags:[["e",orderId,"","cancelled"]]})){setSelectedId(null);load();}
  };

  // ── Status badge helper ──
  const statusBadge=(s:OrderStatus)=>{
    if(s==="resulted") return <Badge t="✓ Resulted" col="var(--accent-green)" bg="var(--tint-green)"/>;
    if(s==="cancelled")return <Badge t="Cancelled"  col="#64748b" bg="var(--bg-app)"/>;
    return <Badge t="Pending" col="#f59e0b" bg="var(--tint-amber)"/>;
  };

  // ── Interpretation badge ──
  const interpBadge=(i:string)=>{
    if(i==="critical") return <Badge t="⚠ Critical" col="#f87171" bg="var(--tint-red)"/>;
    if(i==="abnormal") return <Badge t="Abnormal"   col="#fbbf24" bg="var(--tint-amber)"/>;
    return <Badge t="Normal" col="var(--accent-green)" bg="var(--tint-green)"/>;
  };

  const subTabStyle=(active:boolean)=>({
    padding:"6px 14px",border:"none",cursor:"pointer",fontFamily:"inherit",
    background:active?"var(--bg-card)":"transparent",
    borderRadius:6,color:active?"var(--tab-active)":"var(--text-muted)",fontSize:12,fontWeight:active?600:400,
  } as React.CSSProperties);

  // ── Order form for lab / imaging ──
  const renderLabForm=()=>(
    <div style={{...S.card,marginBottom:12,border:"1px solid var(--border-accent)"}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:12}}>
        {orderTab==="lab"?"🧪 New Lab Order":"🩻 New Imaging Order"}
      </div>
      <div style={{marginBottom:8}}>
        <label style={S.lbl}>{orderTab==="lab"?"Test":"Study"}</label>
        <select
          value={labForm.test}
          onChange={e=>setLabForm(f=>({...f,test:e.target.value,customTest:""}))}
          style={{...S.input,cursor:"pointer",marginBottom:labForm.test==="__custom__"?6:0}}
        >
          <option value="">— select or type below —</option>
          {orderTab==="lab"
            ? LAB_TESTS.map(t=><option key={t.loinc} value={t.display}>{t.display}</option>)
            : IMAGING_STUDIES.map(t=><option key={t} value={t}>{t}</option>)
          }
          <option value="__custom__">Other (type below)…</option>
        </select>
        {labForm.test==="__custom__"&&(
          <input
            value={labForm.customTest}
            onChange={e=>setLabForm(f=>({...f,customTest:e.target.value}))}
            placeholder={orderTab==="lab"?"e.g. Anti-CCP":"e.g. Shoulder MRI"}
            style={S.input}
            autoFocus
          />
        )}
      </div>
      <div style={S.grid2}>
        <div>
          <label style={S.lbl}>Indication / Diagnosis</label>
          <input value={labForm.indication} onChange={e=>setLabForm(f=>({...f,indication:e.target.value}))}
            style={S.input} placeholder="e.g. Well child visit, Fever"/>
        </div>
        <div>
          <label style={S.lbl}>Priority</label>
          <select value={labForm.priority} onChange={e=>setLabForm(f=>({...f,priority:e.target.value as "routine"|"stat"}))}
            style={{...S.input,cursor:"pointer"}}>
            <option value="routine">Routine</option>
            <option value="stat">STAT</option>
          </select>
        </div>
      </div>
      <div style={{...S.grid2,marginTop:8}}>
        <div>
          <label style={S.lbl}>{orderTab==="lab"?"Lab":"Facility"}</label>
          <input value={labForm.facility} onChange={e=>setLabForm(f=>({...f,facility:e.target.value}))}
            style={S.input} placeholder={orderTab==="lab"?"Quest / LabCorp / In-house":"Children's Radiology"}/>
        </div>
        <div>
          <label style={S.lbl}>Special Instructions</label>
          <input value={labForm.instructions} onChange={e=>setLabForm(f=>({...f,instructions:e.target.value}))}
            style={S.input} placeholder={orderTab==="lab"?"e.g. Fasting 8h":"e.g. With contrast"}/>
        </div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:12,alignItems:"center"}}>
        <Btn solid col="#0ea5e9"
          disabled={saving||!keys||(labForm.test==="")||(labForm.test==="__custom__"&&!labForm.customTest.trim())}
          onClick={saveLabOrder}>
          {saving?"⏳ Saving…":"⚡ Place Order"}
        </Btn>
        <Btn col="#475569" onClick={()=>{setAdding(false);setLabForm(emptyLabForm);}}>Cancel</Btn>
        {saveStatus==="error"&&<span style={{color:"#f87171",fontSize:11}}>✗ Failed — check connection</span>}
      </div>
    </div>
  );

  // ── Rx order form ──
  const renderRxForm=()=>(
    <div style={{...S.card,marginBottom:12,border:"1px solid var(--border-accent)"}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:12}}>💊 New Prescription</div>
      <div style={{marginBottom:8}}>
        <label style={S.lbl}>Drug / Strength / Formulation</label>
        <input value={rxForm.drug} onChange={e=>setRxForm(f=>({...f,drug:e.target.value}))}
          style={S.input} placeholder="e.g. Amoxicillin 400mg/5mL suspension" autoFocus/>
          {allergyWarning && (
          <div style={{
            marginTop:6, padding:"8px 12px", borderRadius:8,
            background:"var(--tint-red)", border:"1px solid var(--tint-red-border)",
            display:"flex", alignItems:"center", gap:8,
          }}>
            <span style={{fontSize:18}}>⚠️</span>
            <div>
              <div style={{fontWeight:700, fontSize:12, color:"#fca5a5"}}>ALLERGY ALERT</div>
              <div style={{fontSize:11, color:"#fecaca", marginTop:2}}>{allergyWarning.message}</div>
            </div>
          </div>
        )}
      </div>
      <div style={{...S.grid2,marginBottom:8}}>
        <div>
          <label style={S.lbl}>Dose</label>
          <input value={rxForm.dose} onChange={e=>setRxForm(f=>({...f,dose:e.target.value}))}
            style={S.input} placeholder="e.g. 5 mL, 400 mg"/>
        </div>
        <div>
          <label style={S.lbl}>Route</label>
          <select value={rxForm.route} onChange={e=>setRxForm(f=>({...f,route:e.target.value}))}
            style={{...S.input,cursor:"pointer"}}>
            <option value="oral">Oral</option>
            <option value="topical">Topical</option>
            <option value="inhaled">Inhaled</option>
            <option value="otic">Otic</option>
            <option value="ophthalmic">Ophthalmic</option>
            <option value="intranasal">Intranasal</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div style={{marginBottom:8}}>
        <label style={S.lbl}>Sig (full directions)</label>
        <input value={rxForm.sig} onChange={e=>setRxForm(f=>({...f,sig:e.target.value}))}
          style={S.input} placeholder="e.g. Take 5 mL by mouth twice daily for 10 days with food"/>
      </div>
      <div style={{...S.grid3,marginBottom:8}}>
        <div>
          <label style={S.lbl}>Dispense Qty</label>
          <input value={rxForm.qty} onChange={e=>setRxForm(f=>({...f,qty:e.target.value}))}
            style={S.input} placeholder="150 mL"/>
        </div>
        <div>
          <label style={S.lbl}>Days Supply</label>
          <input type="number" min={1} value={rxForm.daysSupply} onChange={e=>setRxForm(f=>({...f,daysSupply:e.target.value}))}
            style={S.input} placeholder="10"/>
        </div>
        <div>
          <label style={S.lbl}>Refills</label>
          <input type="number" min={0} max={12} value={rxForm.refills} onChange={e=>setRxForm(f=>({...f,refills:e.target.value}))}
            style={S.input} placeholder="0"/>
        </div>
      </div>
      <div style={{...S.grid2,marginBottom:8}}>
        <div>
          <label style={S.lbl}>Indication / Diagnosis</label>
          <input value={rxForm.indication} onChange={e=>setRxForm(f=>({...f,indication:e.target.value}))}
            style={S.input} placeholder="e.g. Acute otitis media"/>
        </div>
        <div>
          <label style={S.lbl}>Pharmacy</label>
          <input value={rxForm.pharmacy} onChange={e=>setRxForm(f=>({...f,pharmacy:e.target.value}))}
            style={S.input} placeholder="e.g. CVS - Main St"/>
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <label style={{...S.lbl,marginBottom:0,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
          <input type="checkbox" checked={rxForm.daw} onChange={e=>setRxForm(f=>({...f,daw:e.target.checked}))}
            style={{cursor:"pointer"}}/>
          DAW — Dispense as Written (no substitution)
        </label>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <Btn solid col="#a78bfa"
          disabled={saving||!keys||!rxForm.drug.trim()||!rxForm.sig.trim()}
          onClick={saveRxOrder}>
          {saving?"⏳ Saving…":"⚡ Write Prescription"}
        </Btn>
        <Btn col="#475569" onClick={()=>{setAdding(false);setRxForm(emptyRxForm);}}>Cancel</Btn>
        {saveStatus==="error"&&<span style={{color:"#f87171",fontSize:11}}>✗ Failed — check connection</span>}
      </div>
    </div>
  );

  // ── Result entry form ──
  const renderResultForm=(order:any)=>(
    <div style={{...S.card,marginTop:12,border:"1px solid var(--border-accent)",background:"var(--bg-deep)"}}>
      <div style={{fontWeight:600,fontSize:12,marginBottom:10}}>
        📋 Enter Result — {order.fhir.code?.text||order.fhir.drug}
      </div>
      <div style={{marginBottom:8}}>
        <label style={S.lbl}>Result</label>
        <textarea
          value={resultForm.resultText}
          onChange={e=>setResultForm(f=>({...f,resultText:e.target.value}))}
          rows={5}
          placeholder={order.fhir.category==="imaging"
            ?"Paste radiology report here…"
            :"e.g. WBC 8.2 (4.5–11.0), Hgb 12.4 (11.5–15.5), Plt 285 (150–400)…"}
          style={{...S.input,resize:"vertical" as const,lineHeight:1.6,fontFamily:"monospace",fontSize:12}}
        />
      </div>
      <div style={{...S.grid2,marginBottom:8}}>
        <div>
          <label style={S.lbl}>Interpretation</label>
          <select value={resultForm.interpretation}
            onChange={e=>setResultForm(f=>({...f,interpretation:e.target.value as "normal"|"abnormal"|"critical"}))}
            style={{...S.input,cursor:"pointer"}}>
            <option value="normal">Normal</option>
            <option value="abnormal">Abnormal</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div>
          <label style={S.lbl}>Date Resulted</label>
          <input type="date" value={resultForm.resultDate}
            onChange={e=>setResultForm(f=>({...f,resultDate:e.target.value}))}
            style={S.input}/>
        </div>
      </div>
      {order.fhir.category==="imaging"&&(
        <div style={{marginBottom:8}}>
          <label style={S.lbl}>Impression (brief summary)</label>
          <input value={resultForm.impression}
            onChange={e=>setResultForm(f=>({...f,impression:e.target.value}))}
            style={S.input} placeholder="e.g. No acute cardiopulmonary process"/>
        </div>
      )}
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <Btn solid col="var(--accent-green)"
          disabled={saving||!resultForm.resultText.trim()}
          onClick={saveResult}>
          {saving?"⏳ Saving…":"✓ Save Result"}
        </Btn>
        <Btn col="#475569" onClick={()=>{setEntering(false);setResultForm(emptyResultForm);}}>Cancel</Btn>
        {saveStatus==="error"&&<span style={{color:"#f87171",fontSize:11}}>✗ Failed</span>}
      </div>
    </div>
  );

  // ── Order detail pane ──
  const renderDetail=(order:any)=>{
    const isRx=order.fhir.resourceType==="RxOrder";
    const borderCol=order.status==="resulted"?"var(--accent-green)":order.status==="cancelled"?"var(--text-label)":"#f59e0b";
    return(
      <div style={{...S.card,borderLeft:`3px solid ${borderCol}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
          <div>
            <div style={{fontWeight:700,fontSize:14}}>
              {isRx?"💊":order.fhir.category==="imaging"?"🩻":"🧪"} {order.fhir.code?.text||order.fhir.drug}
            </div>
            <div style={{color:"var(--text-muted)",fontSize:10,marginTop:3}}>
              {new Date(order.event.created_at*1000).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
              {order.fhir.priority==="stat"&&<span style={{color:"#f87171",marginLeft:8,fontWeight:700}}>STAT</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            {statusBadge(order.status)}
            {order.status==="active"&&(
              <button onClick={()=>cancelOrder(order.event.id,order.fhir.resourceType)} style={{
                background:"transparent",color:"var(--text-label)",cursor:"pointer",
                fontSize:11,padding:"2px 6px",borderRadius:4,border:"1px solid var(--border)"
              }}>Cancel order</button>
            )}
          </div>
        </div>

        {/* Order details */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          {order.fhir.reasonCode?.[0]?.text&&(
            <div><span style={S.lbl}>Indication</span><div style={{fontSize:12}}>{order.fhir.reasonCode[0].text}</div></div>
          )}
          {order.fhir.indication&&(
            <div><span style={S.lbl}>Indication</span><div style={{fontSize:12}}>{order.fhir.indication}</div></div>
          )}
          {order.fhir.performer?.[0]?.display&&(
            <div><span style={S.lbl}>{isRx?"Pharmacy":order.fhir.category==="imaging"?"Facility":"Lab"}</span>
              <div style={{fontSize:12}}>{order.fhir.performer[0].display}</div></div>
          )}
          {order.fhir.pharmacy&&(
            <div><span style={S.lbl}>Pharmacy</span><div style={{fontSize:12}}>{order.fhir.pharmacy}</div></div>
          )}
          {order.fhir.note?.[0]?.text&&(
            <div><span style={S.lbl}>Instructions</span><div style={{fontSize:12}}>{order.fhir.note[0].text}</div></div>
          )}
        </div>

        {/* Rx-specific fields */}
        {isRx&&(
          <div style={{...S.card,background:"var(--bg-deep)",padding:"10px 12px",marginBottom:10}}>
            <div style={{...S.grid2,gap:8}}>
              {order.fhir.dose&&<div><span style={S.lbl}>Dose</span><div style={{fontSize:12}}>{order.fhir.dose}</div></div>}
              {order.fhir.route&&<div><span style={S.lbl}>Route</span><div style={{fontSize:12,textTransform:"capitalize"}}>{order.fhir.route}</div></div>}
              {order.fhir.qty&&<div><span style={S.lbl}>Qty</span><div style={{fontSize:12}}>{order.fhir.qty}</div></div>}
              {order.fhir.daysSupply>0&&<div><span style={S.lbl}>Days Supply</span><div style={{fontSize:12}}>{order.fhir.daysSupply}</div></div>}
              <div><span style={S.lbl}>Refills</span><div style={{fontSize:12}}>{order.fhir.refills}</div></div>
              <div><span style={S.lbl}>DAW</span><div style={{fontSize:12}}>{order.fhir.daw?"Yes — no substitution":"No"}</div></div>
            </div>
            {order.fhir.sig&&(
              <div style={{marginTop:8}}>
                <span style={S.lbl}>Sig</span>
                <div style={{fontSize:12,fontStyle:"italic",color:"var(--text-primary)"}}>{order.fhir.sig}</div>
              </div>
            )}
          </div>
        )}

        {/* Result (if resulted) */}
        {order.result&&(
          <div style={{...S.card,background:"var(--bg-deep)",border:"1px solid var(--border)",padding:"10px 12px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontWeight:600,fontSize:12}}>Result</div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {interpBadge(order.result.fhir.interpretation)}
                <span style={{color:"var(--text-label)",fontSize:10}}>
                  {new Date(order.result.event.created_at*1000).toLocaleDateString()}
                </span>
              </div>
            </div>
            {order.result.fhir.conclusion&&(
              <div style={{marginBottom:6}}>
                <span style={S.lbl}>Impression</span>
                <div style={{fontSize:12,fontStyle:"italic"}}>{order.result.fhir.conclusion}</div>
              </div>
            )}
            <div style={{...S.mono,fontSize:11,whiteSpace:"pre-wrap",maxHeight:180,overflowY:"auto"}}>
              {order.result.fhir.result}
            </div>
          </div>
        )}

        {/* Enter result button */}
        {order.status==="active"&&!entering&&!isRx&&(
          <div style={{marginTop:10}}>
            <Btn solid col="var(--accent-green)" small onClick={()=>{setEntering(true);setResultForm(emptyResultForm);}}>
              + Enter Result
            </Btn>
          </div>
        )}
        {entering&&order.event.id===selectedId&&!isRx&&renderResultForm(order)}
      </div>
    );
  };

  const counts={
    lab:    orders.filter(o=>categoryForFhir(o.fhir)==="lab"    &&o.status==="active").length,
    imaging:orders.filter(o=>categoryForFhir(o.fhir)==="imaging"&&o.status==="active").length,
    rx:     0,
  };

  return(
    <div>
      {/* Header row */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{display:"flex",gap:4}}>
          {(["lab","imaging","rx"] as const).map(t=>(
            <button key={t} onClick={()=>{setOrderTab(t);setSelectedId(null);setAdding(false);setEntering(false);}}
              style={subTabStyle(orderTab===t)}>
              {t==="lab"?"🧪 Lab":t==="imaging"?"🩻 Imaging":"💊 Rx"}
              {counts[t]>0&&<span style={{marginLeft:5,fontSize:10,color:"var(--text-label)"}}>({counts[t]})</span>}
            </button>
          ))}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {saveStatus==="saved"&&<Badge t="✓ Saved" col="var(--accent-green)" bg="var(--tint-green)"/>}
          {((orderTab==="rx"&&canDo("prescribe"))||(orderTab!=="rx"&&canDo("order")))&&(
          <Btn small solid col={orderTab==="rx"?"#a78bfa":"#0ea5e9"}
            onClick={()=>{setAdding(!adding);setSelectedId(null);setEntering(false);}}>
          {adding?"Cancel":`+ New ${orderTab==="lab"?"Lab Order":orderTab==="imaging"?"Imaging Order":"Rx"}`}          </Btn>
          )}
        </div>
      </div>

      {/* New order form */}
      {adding&&(orderTab==="rx"?renderRxForm():renderLabForm())}

      {/* Empty state */}
      {!adding&&visibleOrders.length===0&&(
        <div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:32}}>
          {`No pending ${orderTab==="lab"?"lab":"imaging"} orders`}
        </div>
      )}

      {/* Order list */}
      {visibleOrders.map(order=>(
        <div key={order.event.id}
          onClick={(e)=>{
            if((e.target as HTMLElement).closest('button,input,textarea,select')) return;
            setSelectedId(id=>id===order.event.id?null:order.event.id);
            setEntering(false);
            setResultForm(emptyResultForm);
          }}
          style={{
            ...S.card,
            cursor:"pointer",
            borderLeft:`3px solid ${order.status==="resulted"?"var(--accent-green)":order.status==="cancelled"?"var(--text-faint)":"#f59e0b"}`,
            opacity:order.status==="cancelled"?0.5:1,
            background:selectedId===order.event.id?"var(--bg-hover)":"var(--bg-card)",
          }}>
          {/* Collapsed row */}
          {selectedId!==order.event.id&&(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:600,fontSize:13}}>
                  {order.fhir.code?.text||order.fhir.drug}
                  {order.fhir.priority==="stat"&&
                    <span style={{color:"#f87171",fontSize:10,marginLeft:6,fontWeight:700}}>STAT</span>}
                </div>
                <div style={{color:"var(--text-label)",fontSize:10,marginTop:2}}>
                  {new Date(order.event.created_at*1000).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
                  {order.fhir.reasonCode?.[0]?.text&&` · ${order.fhir.reasonCode[0].text}`}
                  {order.fhir.indication&&` · ${order.fhir.indication}`}
                </div>
              </div>
              {statusBadge(order.status)}
            </div>
          )}
          {/* Expanded detail */}
          {selectedId===order.event.id&&renderDetail(order)}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH MAINTENANCE — Clinical Decision Support
// ═══════════════════════════════════════════════════════════════════════════════

function HealthMaintenanceView({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [immunizations,setImmunizations]=useState<any[]>([]);
  const [encounters,setEncounters]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);

  // Load immunizations
  const loadImm=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.Immunization],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        setImmunizations(items.map(item=>({
          vaccine:item.fhir.vaccineCode?.text||"Unknown",
          date:item.fhir.occurrenceDateTime||"",
        })));
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  // Load encounters (for well-check detection)
  const loadEnc=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.Encounter],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        setEncounters(items.map(item=>({
          chief:item.fhir.reasonCode?.[0]?.text||"",
          date:item.fhir.period?.start?.split("T")[0]||"",
        })));
        setLoading(false);
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setImmunizations([]);setEncounters([]);setLoading(true);},[patient.id]);
  useEffect(()=>{
    let c1:()=>void=()=>{},c2:()=>void=()=>{};
    const p1=loadImm();p1.then(fn=>{if(fn)c1=fn;});
    const p2=loadEnc();p2.then(fn=>{if(fn)c2=fn;});
    // If no encounters come back, clear loading after timeout
    const t=setTimeout(()=>setLoading(false),3000);
    return()=>{c1();c2();p1.then(fn=>{if(fn)fn();});p2.then(fn=>{if(fn)fn();});clearTimeout(t);};
  },[loadImm,loadEnc]);

  // Find last well-child visit
  const lastWellCheck=useMemo(()=>{
    const wellVisits=encounters
      .filter(e=>{
        const c=(e.chief||"").toLowerCase();
        return c.includes("well")&&(c.includes("child")||c.includes("check")||c.includes("visit")||c.includes("exam"));
      })
      .sort((a,b)=>new Date(b.date).getTime()-new Date(a.date).getTime());
    return wellVisits[0]?.date||null;
  },[encounters]);

  // Evaluate
  const immRecords:ImmunizationRecord[]=immunizations;
  const vaccineEvals=useMemo(()=>evaluateImmunizations(patient.dob,immRecords),[patient.dob,immRecords]);
  const wellCheckEval=useMemo(()=>evaluateWellCheck(patient.dob,lastWellCheck),[patient.dob,lastWellCheck]);

  const age=ageFromDob(patient.dob);

  // Status colors
  const statusColor=(status:string)=>{
    switch(status){
      case "up_to_date":case "complete": return "var(--accent-green)"; // green
      case "due":case "overdue": return "#facc15";          // yellow
      case "not_yet": return "var(--text-label)";                     // gray
      default: return "var(--text-label)";
    }
  };
  const statusIcon=(status:string)=>{
    switch(status){
      case "up_to_date": return "✓";
      case "complete": return "✓✓";
      case "due":case "overdue": return "●";
      case "not_yet": return "○";
      default: return "○";
    }
  };
  const statusLabel=(status:string)=>{
    switch(status){
      case "up_to_date": return "Up to Date";
      case "complete": return "Complete";
      case "due": return "Due";
      case "overdue": return "Overdue";
      case "not_yet": return "Not Yet Due";
      default: return "";
    }
  };

  // Separate into groups for display
  const dueVaccines=vaccineEvals.filter(e=>e.status==="due");
  const upToDateVaccines=vaccineEvals.filter(e=>e.status==="up_to_date"||e.status==="complete");
  const notYetVaccines=vaccineEvals.filter(e=>e.status==="not_yet");

  // Summary counts
  const dueCount=dueVaccines.length+(wellCheckEval.status==="due"||wellCheckEval.status==="overdue"?1:0);

  if(loading) return <div style={S.card}><div style={{color:"var(--text-muted)",fontSize:12}}>Loading health maintenance data...</div></div>;

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:14}}>🩺 Health Maintenance</div>
        <div style={{fontSize:11,color:"var(--text-muted)"}}>{patient.name} · {age.display}</div>
      </div>

      {/* Summary banner */}
      <div style={{
        ...S.card,
        background:dueCount>0?"var(--tint-amber)":"var(--tint-green)",
        border:`1px solid ${dueCount>0?"var(--tint-amber-border)":"var(--tint-green-border)"}`,
        marginBottom:14,
      }}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{
            width:36,height:36,borderRadius:"50%",
            background:dueCount>0?"#facc15":"#4ade80",
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:16,fontWeight:700,color:"#0f172a",
          }}>
            {dueCount>0?dueCount:"✓"}
          </div>
          <div>
            <div style={{fontWeight:600,fontSize:13,color:dueCount>0?"var(--accent-amber-text)":"var(--accent-green-text)"}}>
              {dueCount>0?`${dueCount} item${dueCount>1?"s":""} due`:"All up to date"}
            </div>
            <div style={{fontSize:11,color:dueCount>0?"var(--accent-amber-sub)":"var(--accent-green)",marginTop:2}}>
              {dueCount>0?"Action needed at next visit":"No preventive items are overdue"}
            </div>
          </div>
        </div>
      </div>

      {/* ── Well-Child Visit ──────────────────────────────────────────── */}
      <div style={{
        ...S.card,
        borderLeft:`3px solid ${statusColor(wellCheckEval.status)}`,
        marginBottom:14,
      }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontWeight:600,fontSize:13}}>
              <span style={{color:statusColor(wellCheckEval.status),marginRight:6}}>{statusIcon(wellCheckEval.status)}</span>
              Well-Child Visit
            </div>
            <div style={{fontSize:11,color:"var(--text-secondary)",marginTop:3}}>{wellCheckEval.message}</div>
            {wellCheckEval.lastVisitDate&&(
              <div style={{fontSize:10,color:"var(--text-muted)",marginTop:2}}>Last visit: {new Date(wellCheckEval.lastVisitDate).toLocaleDateString()}</div>
            )}
          </div>
          <Badge
            t={statusLabel(wellCheckEval.status)}
            col={statusColor(wellCheckEval.status)}
            bg={statusColor(wellCheckEval.status)+"18"}
          />
        </div>
      </div>

      {/* ── Immunizations Due (Yellow) ────────────────────────────────── */}
      {dueVaccines.length>0&&(
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:"#facc15",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:6}}>
            ● Immunizations Due ({dueVaccines.length})
          </div>
          {dueVaccines.map(ev=>(
            <VaccineRow key={ev.series.abbrev} ev={ev} statusColor={statusColor} statusIcon={statusIcon} statusLabel={statusLabel}/>
          ))}
        </div>
      )}

      {/* ── Up to Date (Green) ────────────────────────────────────────── */}
      {upToDateVaccines.length>0&&(
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--accent-green)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:6}}>
            ✓ Up to Date ({upToDateVaccines.length})
          </div>
          {upToDateVaccines.map(ev=>(
            <VaccineRow key={ev.series.abbrev} ev={ev} statusColor={statusColor} statusIcon={statusIcon} statusLabel={statusLabel}/>
          ))}
        </div>
      )}

      {/* ── Not Yet Due (Gray) ────────────────────────────────────────── */}
      {notYetVaccines.length>0&&(
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--text-label)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:6}}>
            ○ Not Yet Due ({notYetVaccines.length})
          </div>
          {notYetVaccines.map(ev=>(
            <VaccineRow key={ev.series.abbrev} ev={ev} statusColor={statusColor} statusIcon={statusIcon} statusLabel={statusLabel}/>
          ))}
        </div>
      )}
    </div>
  );
}

// Extracted as a top-level component to avoid remount issues
function VaccineRow({ev,statusColor,statusIcon,statusLabel}:{
  ev:VaccineEvaluation;
  statusColor:(s:string)=>string;
  statusIcon:(s:string)=>string;
  statusLabel:(s:string)=>string;
}){
  const [expanded,setExpanded]=useState(false);
  const col=statusColor(ev.status);

  return(
    <div style={{
      ...S.card,
      borderLeft:`3px solid ${col}`,
      marginBottom:4,
      cursor:"pointer",
    }} onClick={()=>setExpanded(!expanded)}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
          <span style={{color:col,fontSize:12,fontWeight:700,width:18,textAlign:"center"}}>{statusIcon(ev.status)}</span>
          <div>
            <div style={{fontWeight:600,fontSize:12}}>{ev.series.name}</div>
            <div style={{fontSize:10,color:"var(--text-secondary)",marginTop:1}}>{ev.message}</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{fontSize:10,color:"var(--text-muted)"}}>{ev.dosesGiven}/{ev.dosesRequired}</div>
          <Badge t={statusLabel(ev.status)} col={col} bg={col+"18"}/>
          <span style={{color:"var(--text-label)",fontSize:10}}>{expanded?"▼":"▶"}</span>
        </div>
      </div>

      {expanded&&(
        <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid var(--border)"}}>
          {/* Dose history */}
          {ev.datesGiven.length>0&&(
            <div style={{marginBottom:6}}>
              <div style={{fontSize:10,color:"var(--text-muted)",marginBottom:4}}>Doses received:</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {ev.datesGiven.map((date,i)=>(
                  <div key={i} style={{
                    background:"var(--tint-green)",border:"1px solid var(--tint-green-border)",
                    borderRadius:6,padding:"3px 8px",fontSize:10,color:"var(--accent-green)",
                  }}>
                    Dose {i+1}: {new Date(date).toLocaleDateString()}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Next due */}
          {ev.nextDueDate&&(
            <div style={{fontSize:10,color:col}}>
              Next due: {new Date(ev.nextDueDate).toLocaleDateString()}
            </div>
          )}

          {/* Notes */}
          {ev.series.notes&&(
            <div style={{fontSize:10,color:"var(--text-muted)",fontStyle:"italic",marginTop:4}}>{ev.series.notes}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATIENT TIMELINE — Unified Chronological View
// ═══════════════════════════════════════════════════════════════════════════════

type TimelineEventType = "encounter"|"medication"|"observation"|"condition"|"allergy"|"immunization"|"lab"|"imaging";

interface TimelineEntry {
  id: string;
  type: TimelineEventType;
  date: Date;
  icon: string;
  color: string;
  title: string;
  subtitle: string;
  detail?: string;
  fhir: any;
}

const TL_META: Record<TimelineEventType,{icon:string;color:string;label:string}> = {
  encounter:    {icon:"📋",color:"#0ea5e9",label:"Encounters"},
  medication:   {icon:"💊",color:"#a78bfa",label:"Medications"},
  observation:  {icon:"📏",color:"#06b6d4",label:"Vitals"},
  condition:    {icon:"🩺",color:"#f59e0b",label:"Conditions"},
  allergy:      {icon:"⚠️",color:"#f87171",label:"Allergies"},
  immunization: {icon:"💉",color:"var(--accent-green)",label:"Immunizations"},
  lab:          {icon:"🔬",color:"#fbbf24",label:"Labs"},
  imaging:      {icon:"🩻",color:"#e879f9",label:"Imaging"},
};

function TimelineView({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [entries,setEntries]=useState<TimelineEntry[]>([]);
  const [loading,setLoading]=useState(true);
  const [expandedId,setExpandedId]=useState<string|null>(null);
  const [filters,setFilters]=useState<Record<TimelineEventType,boolean>>(
    ()=>Object.fromEntries(Object.keys(TL_META).map(k=>[k,true])) as Record<TimelineEventType,boolean>
  );

  const loadAll=useCallback(async()=>{
    if(!keys)return;
    setLoading(true);
    const [encC,medC,obsC,condC,algC,immC,srC,drC]=await Promise.all([
      getCachedEvents(FHIR_KINDS.Encounter,patient.id),
      getCachedEvents(FHIR_KINDS.MedicationRequest,patient.id),
      getCachedEvents(FHIR_KINDS.Observation,patient.id),
      getCachedEvents(FHIR_KINDS.Condition,patient.id),
      getCachedEvents(FHIR_KINDS.AllergyIntolerance,patient.id),
      getCachedEvents(FHIR_KINDS.Immunization,patient.id),
      getCachedEvents(FHIR_KINDS.ServiceRequest,patient.id),
      getCachedEvents(FHIR_KINDS.DiagnosticReport,patient.id),
    ]);

    const parse=(items:CachedEvent[])=>items.map(c=>{
      try{return{fhir:JSON.parse(c.fhirJson),eventId:c.eventId,created_at:c.created_at,tags:c.tags};}catch{return null;}
    }).filter(Boolean) as {fhir:any;eventId:string;created_at:number;tags:string[][]}[];

    const all:TimelineEntry[]=[];

    // Encounters
    for(const e of parse(encC)){
      const chief=e.fhir.reasonCode?.[0]?.text||"Visit";
      const noteText=e.fhir.note?.[0]?.text||"";
      // Truncate preview
      const preview=noteText.length>200?noteText.slice(0,200)+"…":noteText;
      all.push({
        id:e.eventId,type:"encounter",
        date:new Date(e.fhir.period?.start||e.created_at*1000),
        icon:TL_META.encounter.icon,color:TL_META.encounter.color,
        title:chief,
        subtitle:noteText?preview.split("\n")[0]:"No note",
        detail:noteText,
        fhir:e.fhir,
      });
    }

    // Medications
    for(const e of parse(medC)){
      const drug=e.fhir.medicationCodeableConcept?.text||e.fhir.drug||"Unknown medication";
      const status=e.fhir.status||"active";
      const sig=e.fhir.dosageInstruction?.[0]?.text||"";
      all.push({
        id:e.eventId,type:"medication",
        date:new Date(e.fhir.authoredOn||e.created_at*1000),
        icon:TL_META.medication.icon,color:TL_META.medication.color,
        title:`${drug}${status==="stopped"?" — Stopped":""}`,
        subtitle:sig,
        fhir:e.fhir,
      });
    }

    // Observations (vitals) — group by date to cluster
    const obsParsed=parse(obsC);
    // Group vitals that share the same created_at (within 60 seconds)
    const obsGroups:Map<string,{fhir:any;eventId:string;created_at:number}[]>=new Map();
    for(const e of obsParsed){
      // Round to nearest minute for grouping
      const groupKey=Math.floor(e.created_at/60).toString();
      if(!obsGroups.has(groupKey))obsGroups.set(groupKey,[]);
      obsGroups.get(groupKey)!.push(e);
    }
    for(const [,group] of obsGroups){
      const parts:string[]=[];
      for(const e of group){
        const code=e.fhir.code?.coding?.[0]?.code||"";
        const display=e.fhir.code?.coding?.[0]?.display||e.fhir.code?.text||"Vital";
        const val=e.fhir.valueQuantity?.value;
        const unit=e.fhir.valueQuantity?.unit||"";
        if(val!=null){
          // Friendly display
          if(code==="29463-7"){
            const lbs=(val*2.20462).toFixed(1);
            parts.push(`Wt: ${val} kg (${lbs} lb)`);
          }else if(code==="8302-2"){
            const inches=(val/2.54).toFixed(1);
            parts.push(`Ht: ${val} cm (${inches} in)`);
          }else if(code==="9843-4"){
            parts.push(`HC: ${val} cm`);
          }else if(code==="8310-5"){
            parts.push(`Temp: ${val}°C`);
          }else{
            parts.push(`${display}: ${val} ${unit}`);
          }
        }
      }
      if(parts.length>0){
        all.push({
          id:group[0].eventId,type:"observation",
          date:new Date(group[0].created_at*1000),
          icon:TL_META.observation.icon,color:TL_META.observation.color,
          title:"Vitals recorded",
          subtitle:parts.join(" · "),
          fhir:group.map(g=>g.fhir),
        });
      }
    }

    // Conditions
    for(const e of parse(condC)){
      // Skip status-update events (they have an "e" tag with "status-update")
      const isStatusUpdate=e.tags.some((t:string[])=>t[0]==="e"&&t[3]==="status-update");
      const display=e.fhir.code?.text||"Unknown condition";
      const status=e.fhir.clinicalStatus?.coding?.[0]?.code||"active";
      const severity=e.fhir.severity?.coding?.[0]?.display||"";
      if(isStatusUpdate){
        all.push({
          id:e.eventId,type:"condition",
          date:new Date(e.created_at*1000),
          icon:TL_META.condition.icon,color:TL_META.condition.color,
          title:`${display} — ${status==="resolved"?"Resolved":status==="inactive"?"Inactivated":"Updated"}`,
          subtitle:severity?`Severity: ${severity}`:"Status changed",
          fhir:e.fhir,
        });
      }else{
        const icd=e.fhir.code?.coding?.find((c:any)=>c.system?.includes("icd-10"))?.code;
        all.push({
          id:e.eventId,type:"condition",
          date:new Date(e.fhir.onsetDateTime||e.fhir.recordedDate||e.created_at*1000),
          icon:TL_META.condition.icon,color:TL_META.condition.color,
          title:`${display} — Added`,
          subtitle:[icd,severity].filter(Boolean).join(" · ")||"New diagnosis",
          fhir:e.fhir,
        });
      }
    }

    // Allergies
    for(const e of parse(algC)){
      const allergen=e.fhir.code?.text||e.fhir.substance?.text||"Unknown allergen";
      const reaction=e.fhir.reaction?.[0]?.manifestation?.[0]?.text||"";
      const severity=e.fhir.reaction?.[0]?.severity||"";
      all.push({
        id:e.eventId,type:"allergy",
        date:new Date(e.fhir.recordedDate||e.created_at*1000),
        icon:TL_META.allergy.icon,color:TL_META.allergy.color,
        title:`Allergy: ${allergen}`,
        subtitle:[reaction,severity].filter(Boolean).join(" · ")||"Allergy recorded",
        fhir:e.fhir,
      });
    }

    // Immunizations
    for(const e of parse(immC)){
      const vaccine=e.fhir.vaccineCode?.text||"Unknown vaccine";
      const dose=e.fhir.doseQuantity?.value;
      all.push({
        id:e.eventId,type:"immunization",
        date:new Date(e.fhir.occurrenceDateTime||e.created_at*1000),
        icon:TL_META.immunization.icon,color:TL_META.immunization.color,
        title:vaccine,
        subtitle:dose?`Dose ${dose}`:"Vaccine administered",
        fhir:e.fhir,
      });
    }

    // ServiceRequests (lab/imaging orders)
    // Build a result map from DiagnosticReports
    const drParsed=parse(drC);
    const resultMap:Record<string,any>={};
    for(const r of drParsed){
      const eTag=r.tags.find((t:string[])=>t[0]==="e"&&t[3]==="result");
      if(eTag)resultMap[eTag[1]]=r.fhir;
    }

    for(const e of parse(srC)){
      // Skip cancelled tombstones
      const isCancelled=e.tags.some((t:string[])=>t[0]==="e"&&t[3]==="cancelled");
      if(isCancelled)continue;

      const testName=e.fhir.code?.text||"Unknown test";
      const category=(e.fhir.category||"lab").toLowerCase();
      const isImaging=category.includes("imaging")||category.includes("radiology");
      const type:TimelineEventType=isImaging?"imaging":"lab";
      const result=resultMap[e.eventId];

      let subtitle="Ordered";
      if(result){
        const interp=result.conclusion||result.interpretation||"";
        subtitle=`Result: ${interp}`.trim();
        if(result.result&&Array.isArray(result.result)){
          const parts=result.result.slice(0,3).map((r:any)=>`${r.display||r.name||""}: ${r.value||""}`).filter((s:string)=>s.length>2);
          if(parts.length>0)subtitle=parts.join(" · ");
        }
      }

      const priority=e.fhir.priority==="stat"?" (STAT)":"";
      all.push({
        id:e.eventId,type,
        date:new Date(e.fhir.authoredOn||e.created_at*1000),
        icon:TL_META[type].icon,color:TL_META[type].color,
        title:`${testName}${priority}`,
        subtitle,
        detail:result?JSON.stringify(result,null,2):undefined,
        fhir:e.fhir,
      });
    }

    // Sort by date descending
    all.sort((a,b)=>b.date.getTime()-a.date.getTime());
    setEntries(all);
    setLoading(false);
  },[keys,patient.id]);

  useEffect(()=>{setEntries([]);setLoading(true);},[patient.id]);
  useEffect(()=>{loadAll();},[loadAll]);

  // Group entries by date
  const filtered=entries.filter(e=>filters[e.type]);

  const dayGroups:Map<string,TimelineEntry[]>=new Map();
  for(const entry of filtered){
    const dayKey=entry.date.toISOString().split("T")[0];
    if(!dayGroups.has(dayKey))dayGroups.set(dayKey,[]);
    dayGroups.get(dayKey)!.push(entry);
  }

  const formatDayHeader=(dateStr:string)=>{
    const d=new Date(dateStr+"T12:00:00");
    const now=new Date();
    const today=now.toISOString().split("T")[0];
    const yesterday=new Date(now.getTime()-86400000).toISOString().split("T")[0];
    if(dateStr===today)return"Today";
    if(dateStr===yesterday)return"Yesterday";
    return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"});
  };

  // Counts per type
  const typeCounts:Record<string,number>={};
  for(const e of entries){typeCounts[e.type]=(typeCounts[e.type]||0)+1;}

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:14}}>📜 Patient Timeline</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {loading&&<span style={{color:"var(--text-label)",fontSize:11}}>Loading…</span>}
          <Badge t={`${filtered.length} events`} col="#7dd3fc" bg="var(--bg-inset)"/>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:14}}>
        {(Object.entries(TL_META) as [TimelineEventType,{icon:string;color:string;label:string}][]).map(([type,meta])=>{
          const active=filters[type];
          const count=typeCounts[type]||0;
          return(
            <button key={type} onClick={()=>setFilters(f=>({...f,[type]:!f[type]}))}
              style={{
                padding:"3px 10px",borderRadius:99,
                border:`1px solid ${active?meta.color+"55":"var(--border-subtle)"}`,
                background:active?meta.color+"15":"transparent",
                color:active?meta.color:"var(--text-faint)",
                fontSize:10,fontWeight:500,cursor:"pointer",fontFamily:"inherit",
                opacity:count===0?0.4:1,
              }}>
              {meta.icon} {meta.label}{count>0?` (${count})`:""}
            </button>
          );
        })}
      </div>

      {/* Empty state */}
      {!loading&&filtered.length===0&&(
        <div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:32}}>
          {entries.length===0?"No events recorded for this patient":"No events match the current filters"}
        </div>
      )}

      {/* Timeline */}
      <div style={{position:"relative",paddingLeft:24}}>
        {/* Vertical line */}
        <div style={{
          position:"absolute",left:9,top:0,bottom:0,width:2,
          background:"linear-gradient(to bottom, var(--border) 0%, var(--bg-card) 100%)",
          borderRadius:1,
        }}/>

        {[...dayGroups.entries()].map(([dayKey,dayEntries])=>(
          <div key={dayKey} style={{marginBottom:16}}>
            {/* Day header */}
            <div style={{
              position:"relative",marginBottom:8,marginLeft:-24,
              display:"flex",alignItems:"center",gap:8,
            }}>
              <div style={{
                width:20,height:20,borderRadius:"50%",
                background:"var(--bg-app)",border:"2px solid var(--border)",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:8,color:"var(--text-muted)",zIndex:1,flexShrink:0,
              }}>⬤</div>
              <div style={{fontSize:11,fontWeight:700,color:"var(--text-muted)",letterSpacing:"0.3px"}}>
                {formatDayHeader(dayKey)}
              </div>
            </div>

            {/* Day entries */}
            {dayEntries.map(entry=>{
              const isExpanded=expandedId===entry.id;
              return(
                <div key={entry.id}
                  onClick={()=>setExpandedId(id=>id===entry.id?null:entry.id)}
                  style={{
                    position:"relative",marginBottom:4,marginLeft:4,
                    background:isExpanded?"var(--bg-hover)":"var(--bg-card)",
                    border:`1px solid ${isExpanded?entry.color+"40":"#131c2e"}`,
                    borderLeft:`3px solid ${entry.color}`,
                    borderRadius:8,padding:"8px 12px",cursor:"pointer",
                  }}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:13,flexShrink:0}}>{entry.icon}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,fontSize:12,color:"var(--text-primary)",
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                      }}>{entry.title}</div>
                      <div style={{fontSize:10,color:"var(--text-secondary)",marginTop:1,
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                      }}>{entry.subtitle}</div>
                    </div>
                    <div style={{fontSize:10,color:"var(--text-label)",flexShrink:0,textAlign:"right"}}>
                      {entry.date.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded&&(
                    <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${entry.color}20`}}>
                      {entry.type==="encounter"&&entry.detail&&(
                        <pre style={{
                          fontSize:11,color:"var(--text-primary)",lineHeight:1.6,
                          whiteSpace:"pre-wrap",wordBreak:"break-word",
                          fontFamily:"'IBM Plex Mono',monospace",
                          background:"var(--bg-app)",borderRadius:6,padding:10,
                          maxHeight:400,overflowY:"auto",margin:0,
                        }}>{entry.detail}</pre>
                      )}
                      {entry.type==="medication"&&(
                        <div style={{fontSize:11,color:"var(--text-primary)",lineHeight:1.7}}>
                          {entry.fhir.drug&&<div><span style={{color:"var(--text-muted)"}}>Drug:</span> {entry.fhir.drug}</div>}
                          {entry.fhir.dose&&<div><span style={{color:"var(--text-muted)"}}>Dose:</span> {entry.fhir.dose}</div>}
                          {entry.fhir.sig&&<div><span style={{color:"var(--text-muted)"}}>Sig:</span> {entry.fhir.sig}</div>}
                          {entry.fhir.route&&<div><span style={{color:"var(--text-muted)"}}>Route:</span> {entry.fhir.route}</div>}
                          {entry.fhir.qty&&<div><span style={{color:"var(--text-muted)"}}>Qty:</span> {entry.fhir.qty}</div>}
                          {(entry.fhir.refills!=null)&&<div><span style={{color:"var(--text-muted)"}}>Refills:</span> {entry.fhir.refills}</div>}
                          {entry.fhir.pharmacy&&<div><span style={{color:"var(--text-muted)"}}>Pharmacy:</span> {entry.fhir.pharmacy}</div>}
                          {entry.fhir.indication&&<div><span style={{color:"var(--text-muted)"}}>Indication:</span> {entry.fhir.indication}</div>}
                          <div><span style={{color:"var(--text-muted)"}}>Status:</span> {entry.fhir.status}</div>
                        </div>
                      )}
                      {entry.type==="observation"&&Array.isArray(entry.fhir)&&(
                        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                          {entry.fhir.map((obs:any,i:number)=>{
                            const display=obs.code?.coding?.[0]?.display||"Vital";
                            const val=obs.valueQuantity?.value;
                            const unit=obs.valueQuantity?.unit||"";
                            return(
                              <div key={i} style={{
                                background:"#06b6d415",border:"1px solid #06b6d435",
                                borderRadius:6,padding:"4px 10px",fontSize:11,color:"#06b6d4",
                              }}>
                                {display}: {val} {unit}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {entry.type==="condition"&&(
                        <div style={{fontSize:11,color:"var(--text-primary)",lineHeight:1.7}}>
                          {entry.fhir.code?.coding?.map((c:any,i:number)=>(
                            <div key={i}><span style={{color:"var(--text-muted)"}}>{c.system?.includes("icd")?"ICD-10":"SNOMED"}:</span> {c.code} — {c.display}</div>
                          ))}
                          {entry.fhir.severity?.coding?.[0]?.display&&<div><span style={{color:"var(--text-muted)"}}>Severity:</span> {entry.fhir.severity.coding[0].display}</div>}
                          {entry.fhir.note?.[0]?.text&&<div><span style={{color:"var(--text-muted)"}}>Note:</span> {entry.fhir.note[0].text}</div>}
                        </div>
                      )}
                      {entry.type==="allergy"&&(
                        <div style={{fontSize:11,color:"var(--text-primary)",lineHeight:1.7}}>
                          {entry.fhir.reaction?.[0]?.manifestation?.[0]?.text&&<div><span style={{color:"var(--text-muted)"}}>Reaction:</span> {entry.fhir.reaction[0].manifestation[0].text}</div>}
                          {entry.fhir.reaction?.[0]?.severity&&<div><span style={{color:"var(--text-muted)"}}>Severity:</span> {entry.fhir.reaction[0].severity}</div>}
                        </div>
                      )}
                      {entry.type==="immunization"&&(
                        <div style={{fontSize:11,color:"var(--text-primary)",lineHeight:1.7}}>
                          <div><span style={{color:"var(--text-muted)"}}>Vaccine:</span> {entry.fhir.vaccineCode?.text}</div>
                          {entry.fhir.doseQuantity?.value&&<div><span style={{color:"var(--text-muted)"}}>Dose #:</span> {entry.fhir.doseQuantity.value}</div>}
                          <div><span style={{color:"var(--text-muted)"}}>Date given:</span> {new Date(entry.fhir.occurrenceDateTime).toLocaleDateString()}</div>
                        </div>
                      )}
                      {(entry.type==="lab"||entry.type==="imaging")&&(
                        <div style={{fontSize:11,color:"var(--text-primary)",lineHeight:1.7}}>
                          {entry.fhir.priority&&<div><span style={{color:"var(--text-muted)"}}>Priority:</span> {entry.fhir.priority}</div>}
                          {entry.fhir.reasonCode?.[0]?.text&&<div><span style={{color:"var(--text-muted)"}}>Indication:</span> {entry.fhir.reasonCode[0].text}</div>}
                          {entry.fhir.note?.[0]?.text&&<div><span style={{color:"var(--text-muted)"}}>Instructions:</span> {entry.fhir.note[0].text}</div>}
                          {entry.detail&&(
                            <pre style={{
                              fontSize:10,color:"var(--text-secondary)",lineHeight:1.5,
                              whiteSpace:"pre-wrap",fontFamily:"'IBM Plex Mono',monospace",
                              background:"var(--bg-app)",borderRadius:6,padding:8,marginTop:4,
                            }}>{entry.detail}</pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENTS — Encrypted File Attachments (NIP-B7 Blossom)
// ═══════════════════════════════════════════════════════════════════════════════

const DOC_CATEGORIES = [
  "Referral Letter","Outside Records","Lab Report (External)",
  "Imaging Report (External)","Consent Form","Insurance / Authorization",
  "School / Camp Form","Legal / Custody","Specialist Note","Discharge Summary","Other",
];

async function buildBlossomAuth(
  sk: Uint8Array,
  verb: "upload"|"get"|"list"|"delete",
  hash?: string,
  size?: number,
): Promise<string> {
  const tags: string[][] = [
    ["t", verb],
    ["expiration", String(Math.floor(Date.now()/1000)+300)],
  ];
  if(hash) tags.push(["x", hash]);
  if(size!=null) tags.push(["size", String(size)]);
  const event = await buildAndSignEvent(24242, `Authorize ${verb}`, tags, sk);
  return btoa(JSON.stringify(event));
}

function DocumentsView({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [documents,setDocuments]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  const [uploading,setUploading]=useState(false);
  const [showUpload,setShowUpload]=useState(false);
  const [uploadForm,setUploadForm]=useState({title:"",category:"Other",description:""});
  const [selectedFile,setSelectedFile]=useState<File|null>(null);
  const [uploadProgress,setUploadProgress]=useState("");
  const [expandedId,setExpandedId]=useState<string|null>(null);
  const [downloading,setDownloading]=useState<string|null>(null);

  const load=useCallback(async()=>{
    if(!keys)return;
    setLoading(true);
    return cachedLoad({
      kinds:[FHIR_KINDS.DocumentReference],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        const docs=items.map(item=>({
          event:{id:item.eventId,created_at:item.created_at,tags:item.tags},
          fhir:item.fhir,
        }));
        docs.sort((a,b)=>new Date(b.fhir.date).getTime()-new Date(a.fhir.date).getTime());
        setDocuments(docs);
        setLoading(false);
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setDocuments([]);setLoading(true);},[patient.id]);
  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);

  // ── AES-256-GCM symmetric encryption (Web Crypto API) ──

  const generateFileKey=async():Promise<{key:CryptoKey;keyHex:string}>=>{
    const key=await crypto.subtle.generateKey({name:"AES-GCM",length:256},true,["encrypt","decrypt"]);
    const raw=await crypto.subtle.exportKey("raw",key);
    const keyHex=Array.from(new Uint8Array(raw)).map(b=>b.toString(16).padStart(2,"0")).join("");
    return{key,keyHex};
  };

  const importFileKey=async(keyHex:string):Promise<CryptoKey>=>{
    const raw=new Uint8Array(keyHex.match(/.{2}/g)!.map(b=>parseInt(b,16)));
    return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["decrypt"]);
  };

  const encryptFile=async(data:ArrayBuffer,key:CryptoKey):Promise<ArrayBuffer>=>{
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,data);
    const result=new Uint8Array(12+ciphertext.byteLength);
    result.set(iv,0);
    result.set(new Uint8Array(ciphertext),12);
    return result.buffer;
  };

  const decryptFile=async(data:ArrayBuffer,key:CryptoKey):Promise<ArrayBuffer>=>{
    const iv=new Uint8Array(data.slice(0,12));
    const ciphertext=data.slice(12);
    return crypto.subtle.decrypt({name:"AES-GCM",iv},key,ciphertext);
  };

  const hashBuffer=async(buf:ArrayBuffer):Promise<string>=>{
    const hashBuf=await crypto.subtle.digest("SHA-256",buf);
    return Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,"0")).join("");
  };

  // ── Upload (Blossom BUD-01 / BUD-02) ──
  const handleUpload=async()=>{
    if(!keys||!selectedFile||!uploadForm.title.trim())return;
    setUploading(true);
    try{
      setUploadProgress("Reading file…");
      const fileData=await selectedFile.arrayBuffer();

      setUploadProgress("Generating encryption key…");
      const{key,keyHex}=await generateFileKey();

      setUploadProgress("Encrypting…");
      const encrypted=await encryptFile(fileData,key);

      const hash=await hashBuffer(encrypted);

      setUploadProgress("Signing authorization…");
      const authB64=await buildBlossomAuth(keys.sk,"upload",hash,encrypted.byteLength);

      setUploadProgress("Uploading encrypted file…");
      const uploadRes=await fetch(`${BLOSSOM_URL}/upload`,{
        method:"PUT",
        headers:{
          "Content-Type":"application/octet-stream",
          "Authorization":`Nostr ${authB64}`,
        },
        body:encrypted,
      });
      if(!uploadRes.ok){
        const errText=await uploadRes.text().catch(()=>"");
        throw new Error(`Upload failed (${uploadRes.status}): ${errText}`);
      }
      const blobDesc=await uploadRes.json();

      setUploadProgress("Publishing to relay…");
      const blobUrl=blobDesc.url||`${BLOSSOM_URL}/${hash}`;
      const fhir=buildDocumentReference(
        patient.id,
        uploadForm.title,
        uploadForm.category,
        selectedFile.type||"application/octet-stream",
        blobUrl,
        hash,
        selectedFile.size,
        keyHex,
        uploadForm.description||undefined,
      );

      if(await publishClinicalEvent({kind:FHIR_KINDS.DocumentReference,plaintext:JSON.stringify(fhir),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"DocumentReference",keys,relay})){
        setUploadProgress("✓ Uploaded successfully");
        setShowUpload(false);
        setSelectedFile(null);
        setUploadForm({title:"",category:"Other",description:""});
        load();
      }else{
        setUploadProgress("✗ Failed to publish event");
      }
    }catch(err:any){
      console.error("Upload error:",err);
      setUploadProgress(`✗ Error: ${err.message}`);
    }finally{
      setUploading(false);
      setTimeout(()=>setUploadProgress(""),4000);
    }
  };

  // ── Download / View ──
  const handleDownload=async(doc:any)=>{
    if(!keys||!doc.fhir.fileKey||!doc.fhir.content?.[0]?.attachment)return;
    setDownloading(doc.event.id);
    try{
      const att=doc.fhir.content[0].attachment;
      const hash=att.hash?.replace("sha256:","");
      const fetchUrl=att.url||`${BLOSSOM_URL}/${hash}`;

      let res=await fetch(fetchUrl);
      if(!res.ok){
        const authB64=await buildBlossomAuth(keys.sk,"get",hash);
        res=await fetch(fetchUrl,{headers:{"Authorization":`Nostr ${authB64}`}});
        if(!res.ok) throw new Error("Failed to fetch file");
      }
      const encryptedBuf=await res.arrayBuffer();

      const actualHash=await hashBuffer(encryptedBuf);
      if(hash&&actualHash!==hash) console.warn("Hash mismatch — file may be corrupted");

      const fileKey=await importFileKey(doc.fhir.fileKey);
      const decrypted=await decryptFile(encryptedBuf,fileKey);

      const contentType=att.contentType||"application/octet-stream";
      const blob=new Blob([decrypted],{type:contentType});
      const downloadUrl=URL.createObjectURL(blob);

      const viewableTypes=["application/pdf","image/png","image/jpeg","image/gif","image/webp","text/plain"];
      if(viewableTypes.includes(contentType)){
        window.open(downloadUrl,"_blank");
      }else{
        const a=document.createElement("a");
        a.href=downloadUrl;
        a.download=att.title||"download";
        a.click();
      }
      setTimeout(()=>URL.revokeObjectURL(downloadUrl),30000);
    }catch(err:any){
      console.error("Download error:",err);
      alert(`Failed to download: ${err.message}`);
    }finally{
      setDownloading(null);
    }
  };

  const fmtSize=(bytes:number)=>{
    if(bytes<1024)return`${bytes} B`;
    if(bytes<1024*1024)return`${(bytes/1024).toFixed(1)} KB`;
    return`${(bytes/1024/1024).toFixed(1)} MB`;
  };

  const catIcon=(cat:string)=>{
    const m:Record<string,string>={
      "Referral Letter":"📨","Outside Records":"📁","Lab Report (External)":"🔬",
      "Imaging Report (External)":"🩻","Consent Form":"📝","Insurance / Authorization":"🏥",
      "School / Camp Form":"🏫","Legal / Custody":"⚖️","Specialist Note":"👨‍⚕️",
      "Discharge Summary":"🏨","Other":"📎",
    };
    return m[cat]||"📎";
  };

  if(loading) return <div style={S.card}><div style={{color:"var(--text-muted)",fontSize:12}}>Loading documents…</div></div>;

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:14}}>📎 Documents</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <Badge t={`${documents.length} files`} col="#7dd3fc" bg="var(--bg-inset)"/>
          {canDo("write")&&<Btn small solid col="#0ea5e9" onClick={()=>setShowUpload(!showUpload)}>
            {showUpload?"Cancel":"+ Upload"}
          </Btn>}
        </div>
      </div>

      {showUpload&&(
        <div style={{...S.card,marginBottom:12,border:"1px solid var(--border-accent)"}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:12}}>📤 Upload Document</div>
          <div style={{marginBottom:8}}>
            <label style={S.lbl}>File</label>
            <input type="file" onChange={e=>setSelectedFile(e.target.files?.[0]||null)}
              style={{...S.input,padding:6,cursor:"pointer"}}
              accept=".pdf,.jpg,.jpeg,.png,.gif,.doc,.docx,.txt,.csv,.xml,.html"/>
            {selectedFile&&(
              <div style={{fontSize:10,color:"var(--text-muted)",marginTop:4}}>
                {selectedFile.name} · {fmtSize(selectedFile.size)} · {selectedFile.type||"unknown type"}
              </div>
            )}
          </div>
          <div style={{marginBottom:8}}>
            <label style={S.lbl}>Title</label>
            <input value={uploadForm.title} onChange={e=>setUploadForm(f=>({...f,title:e.target.value}))}
              style={S.input} placeholder="e.g. ENT Referral Letter, CBC from Quest"/>
          </div>
          <div style={{...S.grid2,marginBottom:8}}>
            <div>
              <label style={S.lbl}>Category</label>
              <select value={uploadForm.category} onChange={e=>setUploadForm(f=>({...f,category:e.target.value}))}
                style={{...S.input,cursor:"pointer"}}>
                {DOC_CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Description (optional)</label>
              <input value={uploadForm.description} onChange={e=>setUploadForm(f=>({...f,description:e.target.value}))}
                style={S.input} placeholder="Additional notes"/>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <Btn solid col="#0ea5e9"
              disabled={uploading||!selectedFile||!uploadForm.title.trim()||!keys}
              onClick={handleUpload}>
              {uploading?"⏳ Uploading…":"🔒 Encrypt & Upload"}
            </Btn>
            {uploadProgress&&(
              <span style={{fontSize:11,color:uploadProgress.startsWith("✓")?"var(--accent-green)":uploadProgress.startsWith("✗")?"#f87171":"var(--text-secondary)"}}>
                {uploadProgress}
              </span>
            )}
          </div>
          <div style={{fontSize:10,color:"var(--text-label)",marginTop:8,lineHeight:1.5}}>
            🌸 Files are encrypted client-side with AES-256-GCM before upload to your self-hosted
            Blossom server (NIP-B7). The decryption key is stored in the patient's encrypted
            Nostr event — only you and the patient can access it.
          </div>
        </div>
      )}

      {documents.length===0&&!showUpload&&(
        <div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:32}}>
          No documents attached to this patient's chart
        </div>
      )}

      {documents.map(doc=>{
        const att=doc.fhir.content?.[0]?.attachment||{};
        const isExpanded=expandedId===doc.event.id;
        const isDownloading=downloading===doc.event.id;
        return(
          <div key={doc.event.id} style={{
            ...S.card,borderLeft:"3px solid #0ea5e9",cursor:"pointer",
            background:isExpanded?"var(--bg-hover)":"var(--bg-card)",
          }} onClick={()=>setExpandedId(id=>id===doc.event.id?null:doc.event.id)}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:18}}>{catIcon(doc.fhir.type?.text||"Other")}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {att.title||doc.fhir.description||"Untitled"}
                </div>
                <div style={{fontSize:10,color:"var(--text-muted)",marginTop:1}}>
                  {doc.fhir.type?.text||"Other"} · {fmtSize(att.size||0)} · {new Date(doc.fhir.date).toLocaleDateString()}
                </div>
              </div>
              <Btn small solid col="#0ea5e9" onClick={(e:React.MouseEvent)=>{
                e.stopPropagation();
                handleDownload(doc);
              }} disabled={isDownloading}>
                {isDownloading?"⏳":"⬇ Open"}
              </Btn>
            </div>
            {isExpanded&&(
              <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid var(--border)",fontSize:11,color:"var(--text-primary)",lineHeight:1.7}}>
                {doc.fhir.description&&doc.fhir.description!==att.title&&(
                  <div><span style={{color:"var(--text-muted)"}}>Description:</span> {doc.fhir.description}</div>
                )}
                <div><span style={{color:"var(--text-muted)"}}>File:</span> {att.title}</div>
                <div><span style={{color:"var(--text-muted)"}}>Type:</span> {att.contentType}</div>
                <div><span style={{color:"var(--text-muted)"}}>Size:</span> {fmtSize(att.size||0)}</div>
                <div><span style={{color:"var(--text-muted)"}}>Hash:</span> <span style={{fontFamily:"monospace",fontSize:9}}>{att.hash}</span></div>
                <div><span style={{color:"var(--text-muted)"}}>Uploaded:</span> {new Date(doc.fhir.date).toLocaleString()}</div>
                <div style={{marginTop:6,padding:"6px 8px",background:"var(--bg-app)",borderRadius:6,fontSize:10,color:"var(--text-label)"}}>
                  🌸 NIP-B7 Blossom · AES-256-GCM encrypted · Key in dual-encrypted Nostr event · Server stores only ciphertext
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMS & LETTERS — PDF Generation
// ═══════════════════════════════════════════════════════════════════════════════

function FormsLettersView({patient,keys,relay,onNavigate}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;onNavigate:(tab:string)=>void}){
  const [activeForm,setActiveForm]=useState<string|null>(null);
  const [generating,setGenerating]=useState(false);

  // ── Data loaders (shared across forms) ────────────────────
  const [immunizations,setImmunizations]=useState<any[]>([]);
  const [allergies,setAllergies]=useState<any[]>([]);
  const [medications,setMedications]=useState<any[]>([]);
  const [conditions,setConditions]=useState<any[]>([]);
  const [observations,setObservations]=useState<any[]>([]);
  const [dataLoaded,setDataLoaded]=useState(false);

  const loadChartData=useCallback(async()=>{
    if(!keys||dataLoaded)return;
    const [immC,algC,medC,condC,obsC]=await Promise.all([
      getCachedEvents(FHIR_KINDS.Immunization,patient.id),
      getCachedEvents(FHIR_KINDS.AllergyIntolerance,patient.id),
      getCachedEvents(FHIR_KINDS.MedicationRequest,patient.id),
      getCachedEvents(FHIR_KINDS.Condition,patient.id),
      getCachedEvents(FHIR_KINDS.Observation,patient.id),
    ]);
    const parse=(items:CachedEvent[])=>items.map(c=>{try{return JSON.parse(c.fhirJson);}catch{return null;}}).filter(Boolean);
    const filterDeleted=(items:CachedEvent[])=>{
      const deletedIds=new Set<string>();
      for(const item of items){ const d=item.tags.find((t:string[])=>t[0]==="e"&&t[3]==="deletion"); if(d) deletedIds.add(d[1]); }
      return items.filter(i=>!i.tags.find((t:string[])=>t[0]==="e"&&t[3]==="deletion")&&!deletedIds.has(i.eventId));
    };
    setImmunizations(parse(immC));
    setAllergies(parse(filterDeleted(algC)));
    setMedications(parse(medC));
    setConditions(parse(condC));
    setObservations(parse(obsC));
    setDataLoaded(true);
  },[keys,patient.id,dataLoaded]);

  useEffect(()=>{loadChartData();},[loadChartData]);
  useEffect(()=>{setDataLoaded(false);setActiveForm(null);},[patient.id]);

  // Convert immunizations to ImmunizationEntry[]
  const immEntries:ImmunizationEntry[]=immunizations.map(f=>({
    vaccine:f.vaccineCode?.text||"Unknown",
    date:f.occurrenceDateTime||"",
    dose:f.doseQuantity?.value,
  }));

  // Convenience lists
  const allergyNames=allergies.map(a=>a.code?.text||a.substance?.text||"Unknown");
  const medNames=medications.filter(m=>m.status!=="stopped").map(m=>m.medicationCodeableConcept?.text||"Unknown");
  const condNames=conditions.filter(c=>c.clinicalStatus?.coding?.[0]?.code!=="resolved").map(c=>c.code?.text||"Unknown");

  // ── School Excuse Form State ──────────────────────────────
  const [excuseForm,setExcuseForm]=useState({
    startDate:new Date().toISOString().split("T")[0],
    endDate:new Date().toISOString().split("T")[0],
    amOnly:false,pmOnly:false,
    reason:"illness" as "illness"|"chronic-condition"|"appointment",
  });

  // ── Child Care Form State ─────────────────────────────────
  const [ccForm,setCcForm]=useState({
    centerName:"",hoursFrom:"8:00 AM",hoursTo:"5:00 PM",daysPerWeek:"5",
    hearingNotes:"Normal",visionNotes:"Normal",developmentalNotes:"Normal",
    speechNotes:"Normal",dentalNotes:"Normal",otherNotes:"",comments:"",
    medicineAllergy:"",insectAllergy:"",foodAllergy:"",asthma:false,
    tbRiskPresent:false,tbTestPerformed:false,reviewedWithParent:true,
  });

  // ── Kindergarten Form State ───────────────────────────────
  const [kgForm,setKgForm]=useState({
    school:"",
    healthHistory:new Date().toISOString().split("T")[0],
    physicalExam:new Date().toISOString().split("T")[0],
    dental:"",nutritional:"",developmental:"",vision:"",hearing:"",
    tbRisk:"",bloodAnemia:"",urine:"",bloodLead:"",
    noConditionsOfConcern:true,conditionsFound:"",
  });

  // ── Generate handlers ─────────────────────────────────────
  const genSchoolExcuse=()=>{
    setGenerating(true);
    try{
      const doc=generateSchoolExcuse({
        patient:{name:patient.name,dob:patient.dob,sex:patient.sex},
        ...excuseForm,
      });
      doc.save(`SchoolExcuse_${patient.name.replace(/\s+/g,"_")}_${excuseForm.startDate}.pdf`);
    }finally{setGenerating(false);}
  };

  const genImmRecord=()=>{
    setGenerating(true);
    try{
      const doc=generateImmunizationRecord(
        {name:patient.name,dob:patient.dob,sex:patient.sex},
        immEntries
      );
      doc.save(`ImmunizationRecord_${patient.name.replace(/\s+/g,"_")}.pdf`);
    }finally{setGenerating(false);}
  };

  const genSportsPhysical=()=>{
    setGenerating(true);
    try{
      // Get latest vitals
      const latestWeight=observations.filter(o=>o.code?.coding?.some((c:any)=>c.code==="29463-7")).sort((a:any,b:any)=>new Date(b.effectiveDateTime).getTime()-new Date(a.effectiveDateTime).getTime())[0];
      const latestHeight=observations.filter(o=>o.code?.coding?.some((c:any)=>c.code==="8302-2")).sort((a:any,b:any)=>new Date(b.effectiveDateTime).getTime()-new Date(a.effectiveDateTime).getTime())[0];
      const vitals:{height?:string;weight?:string}={};
      if(latestWeight){const kg=latestWeight.valueQuantity?.value;if(kg)vitals.weight=`${(kg*2.205).toFixed(1)} lbs`;}
      if(latestHeight){const cm=latestHeight.valueQuantity?.value;if(cm){const inches=cm/2.54;const ft=Math.floor(inches/12);const rem=Math.round(inches%12);vitals.height=`${ft}'${rem}"`;}}
      const doc=generateSportsPhysical({
        patient:{name:patient.name,dob:patient.dob,sex:patient.sex},
        vitals,
        allergies:allergyNames.length?allergyNames:["NKDA"],
        medications:medNames,
        conditions:condNames,
      });
      doc.save(`SportsPhysical_${patient.name.replace(/\s+/g,"_")}.pdf`);
    }finally{setGenerating(false);}
  };

  const genChildCareForm=()=>{
    setGenerating(true);
    try{
      const doc=generateChildCareForm({
        patient:{name:patient.name,dob:patient.dob,sex:patient.sex,address:patient.address,city:patient.city,state:patient.state,zip:patient.zip},
        centerName:ccForm.centerName,hoursFrom:ccForm.hoursFrom,hoursTo:ccForm.hoursTo,daysPerWeek:ccForm.daysPerWeek,
        allergies:{medicine:ccForm.medicineAllergy||allergyNames.join(", ")||"None",insect:ccForm.insectAllergy||"None",food:ccForm.foodAllergy||"None",asthma:ccForm.asthma},
        hearingNotes:ccForm.hearingNotes,visionNotes:ccForm.visionNotes,developmentalNotes:ccForm.developmentalNotes,
        speechNotes:ccForm.speechNotes,dentalNotes:ccForm.dentalNotes,otherNotes:ccForm.otherNotes,
        comments:ccForm.comments,medications:medNames.join(", ")||"None",
        immunizations:immEntries,tbRiskPresent:ccForm.tbRiskPresent,
        tbTestPerformed:ccForm.tbTestPerformed,reviewedWithParent:ccForm.reviewedWithParent,
      });
      doc.save(`ChildCareForm_LIC701_${patient.name.replace(/\s+/g,"_")}.pdf`);
    }finally{setGenerating(false);}
  };

  const genKindergartenForm=()=>{
    setGenerating(true);
    try{
      const doc=generateKindergartenForm({
        patient:{name:patient.name,dob:patient.dob,sex:patient.sex,address:patient.address,city:patient.city,state:patient.state,zip:patient.zip},
        school:kgForm.school,
        examDates:{healthHistory:kgForm.healthHistory||undefined,physicalExam:kgForm.physicalExam||undefined,
          dental:kgForm.dental||undefined,nutritional:kgForm.nutritional||undefined,developmental:kgForm.developmental||undefined,
          vision:kgForm.vision||undefined,hearing:kgForm.hearing||undefined,tbRisk:kgForm.tbRisk||undefined,
          bloodAnemia:kgForm.bloodAnemia||undefined,urine:kgForm.urine||undefined,bloodLead:kgForm.bloodLead||undefined},
        immunizations:immEntries,noConditionsOfConcern:kgForm.noConditionsOfConcern,conditionsFound:kgForm.conditionsFound,
      });
      doc.save(`KindergartenEntry_PM171A_${patient.name.replace(/\s+/g,"_")}.pdf`);
    }finally{setGenerating(false);}
  };

  // ── Shared styles ─────────────────────────────────────────
  const formCard:React.CSSProperties={...S.card,marginBottom:12,background:"var(--bg-card)",border:"1px solid var(--border-subtle)"};
  const label:React.CSSProperties={fontSize:11,color:"var(--text-secondary)",marginBottom:4,display:"block"};
  const inputS:React.CSSProperties={...S.input,width:"100%",boxSizing:"border-box" as const};
  const row:React.CSSProperties={display:"flex",gap:12,marginBottom:10};

  // ── Form cards ────────────────────────────────────────────
  const forms:{id:string;icon:string;title:string;desc:string;color:string}[]=[
    {id:"excuse",icon:"📝",title:"School Excuse",desc:"Absence excuse for school attendance",color:"#3b82f6"},
    {id:"imm",icon:"💉",title:"Immunization Record",desc:`Official vaccine record · ${immEntries.length} doses on file`,color:"#10b981"},
    {id:"sports",icon:"🏃",title:"Sports Physical (PPE)",desc:"Preparticipation physical evaluation",color:"#f59e0b"},
    {id:"childcare",icon:"🏫",title:"Child Care Form (LIC 701)",desc:"California pre-admission health evaluation",color:"#8b5cf6"},
    {id:"kinder",icon:"🎒",title:"Kindergarten Entry (PM 171 A)",desc:"California CHDP school entry health report",color:"#ec4899"},
    {id:"growth",icon:"📊",title:"Growth Chart",desc:"Printable growth chart with measurements",color:"#06b6d4"},
  ];

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
      <div style={{fontWeight:700,fontSize:16}}>📋 Forms & Letters</div>
      {activeForm&&<Btn small col="#64748b" onClick={()=>setActiveForm(null)}>← Back to all forms</Btn>}
    </div>

    {!activeForm&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      {forms.map(f=>(
        <div key={f.id} onClick={()=>setActiveForm(f.id)} style={{...S.card,cursor:"pointer",background:"var(--bg-card)",border:"1px solid var(--border-subtle)",transition:"all 0.15s ease"}}
          onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor=f.color;(e.currentTarget as HTMLElement).style.background="var(--bg-hover)";}}
          onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor="var(--border-subtle)";(e.currentTarget as HTMLElement).style.background="var(--bg-card)";}}>
          <div style={{fontSize:28,marginBottom:8}}>{f.icon}</div>
          <div style={{fontWeight:600,fontSize:14,marginBottom:4}}>{f.title}</div>
          <div style={{fontSize:11,color:"var(--text-muted)"}}>{f.desc}</div>
        </div>
      ))}
    </div>}

    {/* ── School Excuse ──────────────────────── */}
    {activeForm==="excuse"&&<div style={formCard}>
      <div style={{fontWeight:600,fontSize:14,marginBottom:12}}>📝 School Excuse</div>
      <div style={row}>
        <div style={{flex:1}}>
          <span style={label}>Start Date</span>
          <input type="date" style={inputS} value={excuseForm.startDate} onChange={e=>setExcuseForm(p=>({...p,startDate:e.target.value}))}/>
        </div>
        <div style={{flex:1}}>
          <span style={label}>End Date</span>
          <input type="date" style={inputS} value={excuseForm.endDate} onChange={e=>setExcuseForm(p=>({...p,endDate:e.target.value}))}/>
        </div>
      </div>
      <div style={row}>
        <div style={{flex:1}}>
          <span style={label}>Reason</span>
          <select style={inputS} value={excuseForm.reason} onChange={e=>setExcuseForm(p=>({...p,reason:e.target.value as any}))}>
            <option value="illness">Illness</option>
            <option value="chronic-condition">Chronic Condition</option>
            <option value="appointment">Medical Appointment</option>
          </select>
        </div>
        <div style={{display:"flex",gap:16,alignItems:"flex-end",paddingBottom:4}}>
          <label style={{fontSize:12,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:4}}>
            <input type="checkbox" checked={excuseForm.amOnly} onChange={e=>setExcuseForm(p=>({...p,amOnly:e.target.checked,pmOnly:false}))}/>AM only
          </label>
          <label style={{fontSize:12,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:4}}>
            <input type="checkbox" checked={excuseForm.pmOnly} onChange={e=>setExcuseForm(p=>({...p,pmOnly:e.target.checked,amOnly:false}))}/>PM only
          </label>
        </div>
      </div>
      <Btn solid col="#3b82f6" onClick={genSchoolExcuse} disabled={generating}>
        {generating?"Generating…":"Generate PDF"}
      </Btn>
    </div>}

    {/* ── Immunization Record ────────────────── */}
    {activeForm==="imm"&&<div style={formCard}>
      <div style={{fontWeight:600,fontSize:14,marginBottom:8}}>💉 Immunization Record</div>
      <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:12}}>
        {immEntries.length} vaccination{immEntries.length!==1?"s":""} on file.
        The PDF will include all recorded immunizations grouped by vaccine type.
      </div>
      {immEntries.length===0&&<div style={{...S.card,background:"var(--bg-card)",marginBottom:12,fontSize:12,color:"#f59e0b"}}>
        ⚠️ No immunizations recorded yet. Add them on the Immunizations tab first.
      </div>}
      <Btn solid col="#10b981" onClick={genImmRecord} disabled={generating||immEntries.length===0}>
        {generating?"Generating…":"Generate PDF"}
      </Btn>
    </div>}

    {/* ── Sports Physical ────────────────────── */}
    {activeForm==="sports"&&<div style={formCard}>
      <div style={{fontWeight:600,fontSize:14,marginBottom:8}}>🏃 Sports Physical (PPE)</div>
      <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:12}}>
        Auto-fills patient demographics, vitals, allergies, medications, and conditions from the chart.
        Exam checkboxes and eligibility section are left blank for hand-completion and signature.
      </div>
      <div style={{...S.card,background:"var(--bg-card)",marginBottom:12,fontSize:12}}>
        <div style={{color:"var(--text-muted)",marginBottom:6}}>Will include from chart:</div>
        <div style={{color:"var(--text-primary)"}}>Allergies: {allergyNames.length?allergyNames.join(", "):<span style={{color:"var(--text-muted)"}}>NKDA</span>}</div>
        <div style={{color:"var(--text-primary)"}}>Medications: {medNames.length?medNames.join(", "):<span style={{color:"var(--text-muted)"}}>None</span>}</div>
        <div style={{color:"var(--text-primary)"}}>Conditions: {condNames.length?condNames.join(", "):<span style={{color:"var(--text-muted)"}}>None</span>}</div>
      </div>
      <Btn solid col="#f59e0b" onClick={genSportsPhysical} disabled={generating}>
        {generating?"Generating…":"Generate PDF"}
      </Btn>
    </div>}

    {/* ── Child Care Form (LIC 701) ──────────── */}
    {activeForm==="childcare"&&<div style={formCard}>
      <div style={{fontWeight:600,fontSize:14,marginBottom:12}}>🏫 Child Care Form (LIC 701)</div>
      <div style={row}>
        <div style={{flex:2}}>
          <span style={label}>Child Care Center Name</span>
          <input style={inputS} value={ccForm.centerName} onChange={e=>setCcForm(p=>({...p,centerName:e.target.value}))} placeholder="Name of center"/>
        </div>
        <div style={{flex:1}}>
          <span style={label}>Days/Week</span>
          <input style={inputS} value={ccForm.daysPerWeek} onChange={e=>setCcForm(p=>({...p,daysPerWeek:e.target.value}))}/>
        </div>
      </div>
      <div style={row}>
        <div style={{flex:1}}>
          <span style={label}>Hours From</span>
          <input style={inputS} value={ccForm.hoursFrom} onChange={e=>setCcForm(p=>({...p,hoursFrom:e.target.value}))}/>
        </div>
        <div style={{flex:1}}>
          <span style={label}>Hours To</span>
          <input style={inputS} value={ccForm.hoursTo} onChange={e=>setCcForm(p=>({...p,hoursTo:e.target.value}))}/>
        </div>
      </div>
      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginTop:8,marginBottom:8}}>Screening Results</div>
      <div style={row}>
        <div style={{flex:1}}><span style={label}>Hearing</span><input style={inputS} value={ccForm.hearingNotes} onChange={e=>setCcForm(p=>({...p,hearingNotes:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Vision</span><input style={inputS} value={ccForm.visionNotes} onChange={e=>setCcForm(p=>({...p,visionNotes:e.target.value}))}/></div>
      </div>
      <div style={row}>
        <div style={{flex:1}}><span style={label}>Developmental</span><input style={inputS} value={ccForm.developmentalNotes} onChange={e=>setCcForm(p=>({...p,developmentalNotes:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Speech/Language</span><input style={inputS} value={ccForm.speechNotes} onChange={e=>setCcForm(p=>({...p,speechNotes:e.target.value}))}/></div>
      </div>
      <div style={row}>
        <div style={{flex:1}}><span style={label}>Dental</span><input style={inputS} value={ccForm.dentalNotes} onChange={e=>setCcForm(p=>({...p,dentalNotes:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Other</span><input style={inputS} value={ccForm.otherNotes} onChange={e=>setCcForm(p=>({...p,otherNotes:e.target.value}))}/></div>
      </div>
      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginTop:8,marginBottom:8}}>TB Screening</div>
      <div style={{display:"flex",gap:16,marginBottom:12}}>
        <label style={{fontSize:12,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:4}}>
          <input type="checkbox" checked={ccForm.tbRiskPresent} onChange={e=>setCcForm(p=>({...p,tbRiskPresent:e.target.checked}))}/>TB risk factors present
        </label>
        {ccForm.tbRiskPresent&&<label style={{fontSize:12,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:4}}>
          <input type="checkbox" checked={ccForm.tbTestPerformed} onChange={e=>setCcForm(p=>({...p,tbTestPerformed:e.target.checked}))}/>TB test performed
        </label>}
      </div>
      <div style={{marginBottom:12}}>
        <span style={label}>Comments</span>
        <textarea style={{...inputS,height:50}} value={ccForm.comments} onChange={e=>setCcForm(p=>({...p,comments:e.target.value}))}/>
      </div>
      <Btn solid col="#8b5cf6" onClick={genChildCareForm} disabled={generating}>
        {generating?"Generating…":"Generate PDF"}
      </Btn>
    </div>}

    {/* ── Kindergarten Entry (PM 171 A) ──────── */}
    {activeForm==="kinder"&&<div style={formCard}>
      <div style={{fontWeight:600,fontSize:14,marginBottom:12}}>🎒 Kindergarten Entry Form (PM 171 A)</div>
      <div style={row}>
        <div style={{flex:1}}>
          <span style={label}>School Name</span>
          <input style={inputS} value={kgForm.school} onChange={e=>setKgForm(p=>({...p,school:e.target.value}))} placeholder="School name"/>
        </div>
      </div>
      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginTop:8,marginBottom:8}}>Exam/Screening Dates</div>
      <div style={row}>
        <div style={{flex:1}}><span style={label}>Health History</span><input type="date" style={inputS} value={kgForm.healthHistory} onChange={e=>setKgForm(p=>({...p,healthHistory:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Physical Exam</span><input type="date" style={inputS} value={kgForm.physicalExam} onChange={e=>setKgForm(p=>({...p,physicalExam:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Dental</span><input type="date" style={inputS} value={kgForm.dental} onChange={e=>setKgForm(p=>({...p,dental:e.target.value}))}/></div>
      </div>
      <div style={row}>
        <div style={{flex:1}}><span style={label}>Vision</span><input type="date" style={inputS} value={kgForm.vision} onChange={e=>setKgForm(p=>({...p,vision:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Hearing</span><input type="date" style={inputS} value={kgForm.hearing} onChange={e=>setKgForm(p=>({...p,hearing:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>TB Risk</span><input type="date" style={inputS} value={kgForm.tbRisk} onChange={e=>setKgForm(p=>({...p,tbRisk:e.target.value}))}/></div>
      </div>
      <div style={row}>
        <div style={{flex:1}}><span style={label}>Blood (Anemia)</span><input type="date" style={inputS} value={kgForm.bloodAnemia} onChange={e=>setKgForm(p=>({...p,bloodAnemia:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Urine</span><input type="date" style={inputS} value={kgForm.urine} onChange={e=>setKgForm(p=>({...p,urine:e.target.value}))}/></div>
        <div style={{flex:1}}><span style={label}>Blood Lead</span><input type="date" style={inputS} value={kgForm.bloodLead} onChange={e=>setKgForm(p=>({...p,bloodLead:e.target.value}))}/></div>
      </div>
      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginTop:8,marginBottom:8}}>Results</div>
      <div style={{display:"flex",gap:16,marginBottom:8}}>
        <label style={{fontSize:12,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:4}}>
          <input type="radio" checked={kgForm.noConditionsOfConcern} onChange={()=>setKgForm(p=>({...p,noConditionsOfConcern:true,conditionsFound:""}))}/>No conditions of concern
        </label>
        <label style={{fontSize:12,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:4}}>
          <input type="radio" checked={!kgForm.noConditionsOfConcern} onChange={()=>setKgForm(p=>({...p,noConditionsOfConcern:false}))}/>Conditions found
        </label>
      </div>
      {!kgForm.noConditionsOfConcern&&<div style={{marginBottom:12}}>
        <span style={label}>Describe conditions</span>
        <textarea style={{...inputS,height:50}} value={kgForm.conditionsFound} onChange={e=>setKgForm(p=>({...p,conditionsFound:e.target.value}))}/>
      </div>}
      <Btn solid col="#ec4899" onClick={genKindergartenForm} disabled={generating}>
        {generating?"Generating…":"Generate PDF"}
      </Btn>
    </div>}

    {/* ── Growth Chart ── */}
    {activeForm==="growth"&&<div style={formCard}>
      <div style={{fontWeight:600,fontSize:14,marginBottom:8}}>📊 Growth Chart PDF</div>
      <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:12}}>
        Go to the <strong style={{color:"#06b6d4",cursor:"pointer"}} onClick={()=>onNavigate("growth")}>Growth Chart tab</strong> and click Print.
        You can select which charts (Weight, Height, BMI, Head Circumference) to include in a single multi-page PDF.
      </div>
      <Btn small solid col="#06b6d4" onClick={()=>onNavigate("growth")}>Go to Growth Chart →</Btn>
    </div>}
  </div>);
}

type ChartTab = "overview"|"timeline"|"encounters"|"problems"|"growth"|"vitals"|"meds"|"allergies"|"immunizations"|"messages"|"labs"|"imaging"|"orders"|"docs"|"forms"|"health";
function PatientChart({patient,keys,relay,onPatientUpdated,initialTab,initialThreadId,inboxClickCount}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;
  onPatientUpdated:(p:Patient)=>void;
  initialTab?:ChartTab;
  initialThreadId?:string;
  inboxClickCount?:number;
}){
  const [tab,setTab]=useState<ChartTab>(initialTab||"overview");
  // When sidebar clicks the same open patient with a new thread, force tab + thread update
  useEffect(()=>{
    if(initialTab) setTab(initialTab as ChartTab);
  },[initialTab,initialThreadId,inboxClickCount]);
  // Reset to overview when switching patients
  useEffect(()=>{ setTab(initialTab||"overview"); setShowDemographics(false); },[patient.id]);
  const [showActions,setShowActions]=useState(false);
  const [showNewEncounter,setShowNewEncounter]=useState(false);
  const [showNurseNote,setShowNurseNote]=useState(false);
  const [encounterDraft,setEncounterDraft]=useState({chief:"",note:"",weight:"",weightUnit:"lb" as "kg"|"lb"});
  const [encounterKey,setEncounterKey]=useState(0);
  const [panelCollapsed,setPanelCollapsed]=useState(false);
  const [showDemographics,setShowDemographics]=useState(false);
  const [ordersAutoOpen,setOrdersAutoOpen]=useState<"lab"|"imaging"|"rx"|null>(null);
  const [ordersKey,setOrdersKey]=useState(0);
  const tabsRef=useRef<HTMLDivElement>(null);
  const [tabScroll,setTabScroll]=useState<{left:boolean;right:boolean}>({left:false,right:false});
  const updateTabScroll=useCallback(()=>{
    const el=tabsRef.current;if(!el)return;
    setTabScroll({left:el.scrollLeft>2,right:el.scrollLeft<el.scrollWidth-el.clientWidth-2});
  },[]);
  useEffect(()=>{
    const el=tabsRef.current;if(!el)return;
    updateTabScroll();
    el.addEventListener("scroll",updateTabScroll,{passive:true});
    const ro=new ResizeObserver(updateTabScroll);ro.observe(el);
    return()=>{el.removeEventListener("scroll",updateTabScroll);ro.disconnect();};
  },[updateTabScroll]);
  const age=ageFromDob(patient.dob);
  const tabs:[ChartTab,string][]=[
    ["overview","Overview"],["timeline","Timeline"],["encounters","Encounters"],["problems","Problems"],
    ["growth","Growth Chart"],["vitals","Vitals"],
    ["meds","Medications"],["allergies","Allergies"],["immunizations","Immunizations"],
    ["messages","Messages"],["labs","Labs"],["imaging","Imaging"],["orders","Orders"],["docs","Documents"],["forms","Forms"],["health","Health Maint."],
  ];

  return(
    <div>
      {/* Patient header */}
      <div style={{...S.card,background:"var(--bg-header)",marginBottom:0,borderRadius:"10px 10px 0 0"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:18,fontWeight:700}}>{patient.name}</div>
            <div style={{color:"var(--text-muted)",fontSize:12,marginTop:2}}>
              {patient.dob} · {age.display} · {patient.sex.charAt(0).toUpperCase()+patient.sex.slice(1)}
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Badge t={`ID: ${patient.id.slice(0,8)}…`} col="var(--text-label)" bg="var(--bg-app)"/>
          </div>
        </div>
      </div>

      {/* Chart tabs */}
      <div style={{display:"flex",alignItems:"center",background:"var(--bg-tab-bar)",borderBottom:"1px solid var(--border-subtle)",marginBottom:16,position:"relative"}}>
        {tabScroll.left&&<button onClick={()=>{tabsRef.current?.scrollBy({left:-200,behavior:"smooth"})}} style={{
          position:"absolute",left:0,top:0,bottom:0,width:32,zIndex:2,border:"none",cursor:"pointer",
          background:"linear-gradient(to right,var(--bg-tab-bar) 70%,transparent)",color:"var(--text-primary)",fontSize:18,
          display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",padding:0,
        }}>‹</button>}
        <div ref={tabsRef} style={{display:"flex",overflowX:"auto",scrollbarWidth:"none",msOverflowStyle:"none",flex:1,minWidth:0,WebkitOverflowScrolling:"touch"} as React.CSSProperties}>
          {tabs.map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{
              padding:"10px 16px",border:"none",cursor:"pointer",fontFamily:"inherit",
              background:"transparent",borderBottom:tab===id?"2px solid var(--tab-active)":"2px solid transparent",
              color:tab===id?"var(--tab-active)":"var(--text-muted)",fontSize:12,fontWeight:tab===id?600:400,
              whiteSpace:"nowrap",flexShrink:0,
            }}>{label}</button>
          ))}
        </div>
        {tabScroll.right&&<button onClick={()=>{tabsRef.current?.scrollBy({left:200,behavior:"smooth"})}} style={{
          position:"absolute",right:0,top:0,bottom:0,width:32,zIndex:2,border:"none",cursor:"pointer",
          background:"linear-gradient(to left,var(--bg-tab-bar) 70%,transparent)",color:"var(--text-primary)",fontSize:18,
          display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",padding:0,
        }}>›</button>}
        {(canDo("sign")||canDo("order")||canDo("prescribe")||canDo("write"))&&(
        <div style={{position:"relative",marginLeft:12,marginRight:16,flexShrink:0}}>
          <button onClick={()=>setShowActions(!showActions)} style={{
            width:28,height:28,borderRadius:"50%",border:"1px solid #0ea5e9",
            background:"linear-gradient(135deg,#0ea5e9,#06b6d4)",color:"#fff",
            fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",
            alignItems:"center",justifyContent:"center"
          }}>+</button>
          {showActions&&(
            <div style={{position:"absolute",top:34,right:0,background:"var(--bg-card)",
              border:"1px solid var(--border)",borderRadius:8,minWidth:180,zIndex:100,
              boxShadow:"0 4px 12px var(--shadow)"}}>
              {canDo("sign")&&<button onClick={()=>{setShowNewEncounter(true);setShowNurseNote(false);setShowActions(false);setEncounterKey(k=>k+1);}} style={{
                width:"100%",padding:"10px 14px",border:"none",background:"transparent",
                color:"var(--text-primary)",fontSize:13,textAlign:"left",cursor:"pointer",
                fontFamily:"inherit",display:"flex",alignItems:"center",gap:8,
                borderBottom:"1px solid var(--border)"
              }}>📝 New Encounter</button>}
              {canDo("write")&&!canDo("sign")&&<button onClick={()=>{setShowNurseNote(true);setShowNewEncounter(false);setShowActions(false);setEncounterKey(k=>k+1);}} style={{
                width:"100%",padding:"10px 14px",border:"none",background:"transparent",
                color:"var(--text-primary)",fontSize:13,textAlign:"left",cursor:"pointer",
                fontFamily:"inherit",display:"flex",alignItems:"center",gap:8,
                borderBottom:"1px solid var(--border)"
              }}>📋 Note</button>}
              {canDo("order")&&<button onClick={()=>{setTab("orders");setOrdersAutoOpen("lab");setOrdersKey(k=>k+1);setShowActions(false);}} style={{
                width:"100%",padding:"10px 14px",border:"none",background:"transparent",
                color:"var(--text-primary)",fontSize:13,textAlign:"left",cursor:"pointer",
                fontFamily:"inherit",display:"flex",alignItems:"center",gap:8,
                borderTop:"1px solid var(--border)"
              }}>🧪 New Lab Order</button>}
              {canDo("order")&&<button onClick={()=>{setTab("orders");setOrdersAutoOpen("imaging");setOrdersKey(k=>k+1);setShowActions(false);}}style={{
                width:"100%",padding:"10px 14px",border:"none",background:"transparent",
                color:"var(--text-primary)",fontSize:13,textAlign:"left",cursor:"pointer",
                fontFamily:"inherit",display:"flex",alignItems:"center",gap:8,
                borderTop:"1px solid var(--border)"
              }}>🩻 New Imaging Order</button>}
              {canDo("prescribe")&&<button onClick={()=>{setTab("orders");setOrdersAutoOpen("rx");setOrdersKey(k=>k+1);setShowActions(false);}}style={{
                width:"100%",padding:"10px 14px",border:"none",background:"transparent",
                color:"var(--text-primary)",fontSize:13,textAlign:"left",cursor:"pointer",
                fontFamily:"inherit",display:"flex",alignItems:"center",gap:8,
                borderTop:"1px solid var(--border)"
              }}>💊 New Prescription</button>}
            </div>
          )}
        </div>
        )}
      </div>

      {tab==="overview" &&(
        <>
          {showDemographics && keys ? (
            <div style={{marginBottom:16}}>
              <DemographicsCard patient={patient} onUpdated={(p)=>{onPatientUpdated(p);setShowDemographics(false);}} keys={keys} relay={relay}/>
              <div style={{marginTop:8}}>
                <Btn small col="#475569" onClick={()=>setShowDemographics(false)}>← Back to Overview</Btn>
              </div>
            </div>
          ) : (
            <>
              <BillingStatusCard patient={patient}/>
              <OverviewTiles patient={patient} keys={keys} relay={relay} onNavigate={t=>{
                if(t==="demographics"){setShowDemographics(true);}
                else setTab(t as ChartTab);
              }}/>
            </>
          )}
        </>
      )}
      {tab==="timeline"      &&<TimelineView patient={patient} keys={keys} relay={relay}/>}
      {tab==="problems"       &&<ProblemList patient={patient} keys={keys} relay={relay}/>}
      {tab==="encounters"    &&<EncounterHistory patient={patient} keys={keys} relay={relay}/>}
      {tab==="growth"        &&<GrowthChart patient={patient} keys={keys} relay={relay}/>}
      {tab==="vitals"        &&<VitalsHistory patient={patient} keys={keys} relay={relay}/>}
      {tab==="meds"          &&<MedicationList patient={patient} keys={keys} relay={relay}/>}
      {tab==="allergies"     &&<AllergyList patient={patient} keys={keys} relay={relay}/>}
      {tab==="immunizations" &&<ImmunizationList patient={patient} keys={keys} relay={relay}/>}
      {tab==="messages"  &&<MessagesView patient={patient} keys={keys} relay={relay} initialThreadId={initialThreadId}/>}
      {tab==="labs"      &&<ResultsView category="lab"     patient={patient} keys={keys} relay={relay}/>}
      {tab==="imaging"   &&<ResultsView category="imaging" patient={patient} keys={keys} relay={relay}/>}
      {tab==="orders"    &&<OrdersView
        key={ordersKey}
        patient={patient} keys={keys} relay={relay}
        autoOpen={ordersAutoOpen}
        onAutoOpenConsumed={()=>setOrdersAutoOpen(null)}
      />}
      {tab==="docs"      &&<DocumentsView patient={patient} keys={keys} relay={relay}/>}
      {tab==="forms"     &&<FormsLettersView patient={patient} keys={keys} relay={relay} onNavigate={t=>setTab(t as ChartTab)}/>}
      {tab==="health"    &&<HealthMaintenanceView patient={patient} keys={keys} relay={relay}/>}


      {/* New Encounter Side Panel */}
      {showNewEncounter&&(
        <>
          {/* Collapse/Expand Tab */}
          <div onClick={()=>setPanelCollapsed(!panelCollapsed)} style={{
            position:"fixed",top:"50%",right:panelCollapsed?0:450,transform:"translateY(-50%)",
            width:32,height:80,background:"var(--bg-card)",border:"1px solid var(--border)",
            borderRight:panelCollapsed?"1px solid var(--border)":"none",
            borderRadius:panelCollapsed?"8px 0 0 8px":"0 0 0 8px",
            display:"flex",alignItems:"center",justifyContent:"center",
            cursor:"pointer",zIndex:201,transition:"right 0.2s ease",
            boxShadow:"-2px 0 8px rgba(0,0,0,0.2)"
          }}>
            <span style={{fontSize:16,color:"var(--text-secondary)"}}>{panelCollapsed?"◀":"▶"}</span>
          </div>

          {/* Side Panel */}
          <div style={{position:"fixed",top:0,right:panelCollapsed?-450:0,width:450,height:"100vh",
            background:"var(--bg-app)",borderLeft:"1px solid var(--border-subtle)",zIndex:200,
            overflowY:"auto",boxShadow:"-4px 0 12px var(--shadow)",
            transition:"right 0.2s ease"}}>
            <div style={{position:"sticky",top:0,background:"var(--bg-card)",padding:"12px 16px",
              borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",
              alignItems:"center",zIndex:10}}>
              <div style={{fontWeight:600,fontSize:14}}>📝 New Encounter — {patient.name}</div>
              <button onClick={()=>setShowNewEncounter(false)} style={{
                width:28,height:28,borderRadius:"50%",border:"1px solid var(--text-label)",
                background:"transparent",color:"var(--text-secondary)",fontSize:18,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center"
              }}>×</button>
            </div>
            <div style={{padding:16}}>
              <NewEncounterForm key={encounterKey} patient={patient} keys={keys} relay={relay} 
                onDone={()=>{setShowNewEncounter(false);setTab("encounters");}}/>
            </div>
          </div>
        </>
      )}

      {/* Nurse Note Side Panel */}
      {showNurseNote&&(
        <>
          <div onClick={()=>setPanelCollapsed(!panelCollapsed)} style={{
            position:"fixed",top:"50%",right:panelCollapsed?0:400,transform:"translateY(-50%)",
            width:32,height:80,background:"var(--bg-card)",border:"1px solid var(--border)",
            borderRight:panelCollapsed?"1px solid var(--border)":"none",
            borderRadius:panelCollapsed?"8px 0 0 8px":"0 0 0 8px",
            display:"flex",alignItems:"center",justifyContent:"center",
            cursor:"pointer",zIndex:201,transition:"right 0.2s ease",
            boxShadow:"-2px 0 8px rgba(0,0,0,0.2)"
          }}>
            <span style={{fontSize:16,color:"var(--text-secondary)"}}>{panelCollapsed?"◀":"▶"}</span>
          </div>
          <div style={{position:"fixed",top:0,right:panelCollapsed?-400:0,width:400,height:"100vh",
            background:"var(--bg-app)",borderLeft:"1px solid var(--border-subtle)",zIndex:200,
            overflowY:"auto",boxShadow:"-4px 0 12px var(--shadow)",
            transition:"right 0.2s ease"}}>
            <div style={{position:"sticky",top:0,background:"var(--bg-card)",padding:"12px 16px",
              borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",
              alignItems:"center",zIndex:10}}>
              <div style={{fontWeight:600,fontSize:14}}>📋 Note — {patient.name}</div>
              <button onClick={()=>setShowNurseNote(false)} style={{
                width:28,height:28,borderRadius:"50%",border:"1px solid var(--text-label)",
                background:"transparent",color:"var(--text-secondary)",fontSize:18,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center"
              }}>×</button>
            </div>
            <div style={{padding:16}}>
              <NurseNoteForm key={encounterKey} patient={patient} keys={keys} relay={relay}
                onDone={()=>{setShowNurseNote(false);setTab("encounters");}}/>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Portal Connection String Generator ──────────────────────────────────────
function PortalConnectionGenerator({pkHex}:{pkHex:string}){
  const [copied,setCopied]=useState<string|null>(null);
  const [showUri,setShowUri]=useState(false);

  const connJson = JSON.stringify({
    relay: RELAY_URL,
    practice_pk: pkHex,
    practice_name: PRACTICE_NAME,
    billing_api: BILLING_URL,
    calendar_api: CALENDAR_URL,
  }, null, 2);

  const connUri = `nostr+ehr://${RELAY_URL.replace("wss://","")}?pk=${pkHex}&name=${encodeURIComponent(PRACTICE_NAME)}&billing=${encodeURIComponent(BILLING_URL)}&calendar=${encodeURIComponent(CALENDAR_URL)}`;

  const copy=(label:string,val:string)=>{
    navigator.clipboard.writeText(val);
    setCopied(label);
    setTimeout(()=>setCopied(null),2000);
  };

  if(!pkHex) return null;

  return(
    <div style={{...S.card,marginTop:16}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:4}}>
        🔗 Patient Portal Connection String
      </div>
      <div style={{fontSize:11,color:"var(--text-secondary)",marginBottom:12,lineHeight:1.6}}>
        Patients paste this into the portal to connect to your practice.
        Safe to share — contains only public info (relay URL, public key, API endpoints).
      </div>

      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap" as const}}>
        <Btn small solid={!showUri} col="#0ea5e9" onClick={()=>setShowUri(false)}>JSON</Btn>
        <Btn small solid={showUri} col="#0ea5e9" onClick={()=>setShowUri(true)}>URI</Btn>
      </div>

      <div style={{...S.mono,fontSize:9,padding:10,background:"var(--bg-deep)",marginBottom:10,maxHeight:160,overflowY:"auto" as const,whiteSpace:"pre-wrap" as const,wordBreak:"break-all" as const}}>
        {showUri ? connUri : connJson}
      </div>

      <div style={{display:"flex",gap:8}}>
        <Btn small col="#0ea5e9" onClick={()=>copy("conn",showUri ? connUri : connJson)}>
          {copied==="conn"?"✓ Copied":"📋 Copy"}
        </Btn>
      </div>
    </div>
  );
}

// ─── Overview Tiles ───────────────────────────────────────────────────────────
function OverviewTiles({patient,keys,relay,onNavigate}:{
  patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>;
  onNavigate:(tab:string)=>void;
}){
  const [conditions,setConditions]=useState<any[]>([]);
  const [meds,setMeds]=useState<any[]>([]);
  const [allergies,setAllergies]=useState<any[]>([]);
  const [immunizations,setImmunizations]=useState<any[]>([]);
  const [latestWeight,setLatestWeight]=useState<{value:string;date:string}|null>(null);
  const [latestHeight,setLatestHeight]=useState<{value:string;date:string}|null>(null);

  // Reset on patient change
  useEffect(()=>{ setConditions([]); setMeds([]); setAllergies([]); setImmunizations([]); setLatestWeight(null); setLatestHeight(null); },[patient.id]);

  // Problems
  const loadProblems=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({ kinds:[FHIR_KINDS.Condition], patientId:patient.id, keys, relay,
      processDecrypted:(items)=>{
        const statusUpdates=new Map<string,{status:string;created_at:number;fhir:any}>();
        const originals:any[]=[];
        for(const item of items){
          const statusTag=item.tags.find((t:string[])=>t[0]==="e"&&t[3]==="status-update");
          if(statusTag){ const origId=statusTag[1]; const ex=statusUpdates.get(origId); if(!ex||item.created_at>ex.created_at) statusUpdates.set(origId,{status:item.fhir.clinicalStatus?.coding?.[0]?.code||"active",created_at:item.created_at,fhir:item.fhir}); }
          else originals.push({event:{id:item.eventId,created_at:item.created_at,tags:item.tags},fhir:item.fhir});
        }
        setConditions(originals.map(o=>{ const u=statusUpdates.get(o.event.id); return u?{...o,currentStatus:u.status}:{...o,currentStatus:o.fhir.clinicalStatus?.coding?.[0]?.code||"active"}; })
          .filter(c=>c.currentStatus==="active").sort((a,b)=>b.event.created_at-a.event.created_at));
      }, timeout:2000 });
  },[keys,relay,patient.id]);

  // Medications
  const loadMeds=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({ kinds:[FHIR_KINDS.MedicationRequest], patientId:patient.id, keys, relay,
      processDecrypted:(items)=>{
        const deletedIds=new Set<string>();
        for(const item of items){ const d=item.tags.find((t:string[])=>t[0]==="e"&&t[3]==="deletion"); if(d) deletedIds.add(d[1]); }
        setMeds(items.filter(i=>!i.tags.find((t:string[])=>t[0]==="e"&&t[3]==="deletion")&&!deletedIds.has(i.eventId))
          .map(i=>({event:{id:i.eventId,created_at:i.created_at},fhir:i.fhir}))
          .sort((a,b)=>b.event.created_at-a.event.created_at));
      }, timeout:2000 });
  },[keys,relay,patient.id]);

  // Allergies
  const loadAllergies=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({ kinds:[FHIR_KINDS.AllergyIntolerance], patientId:patient.id, keys, relay,
      processDecrypted:(items)=>{
        const deletedIds=new Set<string>();
        for(const item of items){ const d=item.tags.find((t:string[])=>t[0]==="e"&&t[3]==="deletion"); if(d) deletedIds.add(d[1]); }
        setAllergies(items.filter(i=>!i.tags.find((t:string[])=>t[0]==="e"&&t[3]==="deletion")&&!deletedIds.has(i.eventId))
          .map(i=>({event:{id:i.eventId,created_at:i.created_at},fhir:i.fhir}))
          .sort((a,b)=>b.event.created_at-a.event.created_at));
      }, timeout:2000 });
  },[keys,relay,patient.id]);

  // Immunizations
  const loadImmunizations=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({ kinds:[FHIR_KINDS.Immunization], patientId:patient.id, keys, relay,
      processDecrypted:(items)=>{
        setImmunizations(items.map(i=>({event:{id:i.eventId,created_at:i.created_at},fhir:i.fhir}))
          .sort((a,b)=>new Date(b.fhir.occurrenceDateTime).getTime()-new Date(a.fhir.occurrenceDateTime).getTime()));
      }, timeout:2000 });
  },[keys,relay,patient.id]);

  // Weight + Height (from Observations)
  const loadVitals=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({ kinds:[FHIR_KINDS.Observation], patientId:patient.id, keys, relay,
      processDecrypted:(items)=>{
        let wt:any=null,ht:any=null;
        for(const item of items){
          const code=item.fhir.code?.coding?.[0]?.code;
          if(code==="29463-7"){ if(!wt||item.created_at>wt.created_at) wt=item; }
          if(code==="8302-2"){ if(!ht||item.created_at>ht.created_at) ht=item; }
        }
        if(wt){
          const kg=wt.fhir.valueQuantity?.value;
          const lb=kg?(kg*2.20462).toFixed(1):null;
          const date=wt.fhir.effectiveDateTime?.split("T")[0]||"";
          setLatestWeight(lb?{value:`${lb} lb`,date}:null);
        }
        if(ht){
          const cm=ht.fhir.valueQuantity?.value;
          const inches=cm?Math.round(cm/2.54):null;
          const display=inches!=null?`${inches}"`:`${cm} cm`;
          const date=ht.fhir.effectiveDateTime?.split("T")[0]||"";
          setLatestHeight({value:display,date});
        }
      }, timeout:2000 });
  },[keys,relay,patient.id]);

  const useLoad=(fn:()=>Promise<any>)=>{ useEffect(()=>{ let c:()=>void=()=>{}; const p=fn(); p.then(fn2=>{if(fn2)c=fn2;}); return()=>{c();p.then(fn2=>{if(fn2)fn2();});}; },[fn]); };
  useLoad(loadProblems); useLoad(loadMeds); useLoad(loadAllergies); useLoad(loadImmunizations); useLoad(loadVitals);

  const age=ageFromDob(patient.dob);

  // ── Tile primitives ──────────────────────────────────────────────────────────
  const TILE_BG="var(--bg-card)";
  const TILE_BORDER="var(--border-subtle)";

  const Tile=({col,children}:{col:string;children:React.ReactNode})=>(
    <div style={{
      background:TILE_BG,border:`1px solid ${TILE_BORDER}`,borderRadius:8,
      display:"flex",flexDirection:"column",overflow:"hidden",
      boxShadow:"0 2px 8px var(--shadow)",
    }}>{children}</div>
  );

  const TileHeader=({col,icon,label,meta,tab,action}:{
    col:string;icon:string;label:string;meta?:string;tab?:string;action?:React.ReactNode;
  })=>(
    <div onClick={()=>tab&&onNavigate(tab)} style={{
      display:"flex",alignItems:"center",justifyContent:"space-between",
      padding:"7px 12px",
      background:`linear-gradient(90deg,${col}18 0%,${TILE_BG} 100%)`,
      borderBottom:`1px solid ${TILE_BORDER}`,borderLeft:`3px solid ${col}`,
      cursor:tab?"pointer":"default",
      userSelect:"none" as const,
    }}
      onMouseEnter={e=>{ if(tab)(e.currentTarget as HTMLElement).style.background=`linear-gradient(90deg,${col}28 0%,${col}08 100%)`; }}
      onMouseLeave={e=>{ if(tab)(e.currentTarget as HTMLElement).style.background=`linear-gradient(90deg,${col}18 0%,${TILE_BG} 100%)`; }}
    >
      <div style={{display:"flex",alignItems:"center",gap:7}}>
        <span style={{fontSize:13}}>{icon}</span>
        <span style={{fontSize:12,fontWeight:700,color:"var(--text-primary)",letterSpacing:"0.01em"}}>{label}</span>
        {meta&&<span style={{fontSize:10,color:"var(--text-label)",fontWeight:400}}>{meta}</span>}
      </div>
      {action&&<div onClick={e=>e.stopPropagation()}>{action}</div>}
    </div>
  );

  const TileBody=({children}:{children:React.ReactNode})=>(
    <div style={{padding:"10px 12px",flex:1,overflowY:"auto" as const,maxHeight:220,minHeight:60}}>
      {children}
    </div>
  );

  const Empty=()=><div style={{color:"var(--text-faint)",fontSize:11,fontStyle:"italic",padding:"4px 0"}}>None on file</div>;

  const DRow=({label,val}:{label:string;val?:string})=>val?(
    <div style={{display:"flex",gap:0,fontSize:11,marginBottom:4,lineHeight:1.4}}>
      <span style={{color:"var(--text-label)",width:72,flexShrink:0}}>{label}</span>
      <span style={{color:"var(--text-primary)"}}>{val}</span>
    </div>
  ):null;

  const ProblemRow=({text,chronic}:{text:string;chronic:boolean})=>(
    <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:4,fontSize:11}}>
      <span style={{width:6,height:6,borderRadius:"50%",background:chronic?"#a78bfa":"var(--text-muted)",flexShrink:0,marginTop:3,display:"inline-block"}}/>
      <span style={{color:"var(--text-primary)",lineHeight:1.4}}>{text}</span>
    </div>
  );

  const MedRow=({name,dose}:{name:string;dose?:string})=>(
    <div style={{marginBottom:5,fontSize:11,lineHeight:1.4}}>
      <span style={{color:"var(--accent-green)",fontWeight:600}}>{name}</span>
      {dose&&<span style={{color:"var(--text-label)"}}> {dose}</span>}
    </div>
  );

  const AllergyRow=({name,reaction}:{name:string;reaction?:string})=>(
    <div style={{marginBottom:5,fontSize:11,lineHeight:1.4,display:"flex",gap:6,alignItems:"baseline"}}>
      <span style={{color:"#fca5a5",fontWeight:600}}>{name}</span>
      {reaction&&<span style={{color:"var(--text-muted)",fontSize:10}}>— {reaction}</span>}
    </div>
  );

  const ImmRow=({name,date}:{name:string;date:string})=>(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4,fontSize:11,gap:8}}>
      <span style={{color:"var(--text-primary)",lineHeight:1.4}}>{name}</span>
      <span style={{color:"var(--text-label)",fontSize:10,flexShrink:0,whiteSpace:"nowrap" as const}}>{date}</span>
    </div>
  );

  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>

      {/* ── Demographics ── */}
      <Tile col="#0ea5e9">
        <TileHeader col="#0ea5e9" icon="👤" label="Demographics" tab="overview"
          action={canDo("write")?<span onClick={()=>onNavigate("demographics")} style={{fontSize:10,color:"var(--text-label)",cursor:"pointer"}}
            onMouseEnter={e=>(e.currentTarget.style.color="#0ea5e9")}
            onMouseLeave={e=>(e.currentTarget.style.color="var(--text-label)")}>Edit</span>:undefined}
        />
        <TileBody>
          <DRow label="DOB" val={patient.dob}/>
          <DRow label="Age / Sex" val={`${age.display} · ${patient.sex.charAt(0).toUpperCase()+patient.sex.slice(1)}`}/>
          <DRow label="Phone" val={patient.phone}/>
          <DRow label="Email" val={patient.email}/>
          {patient.address&&<DRow label="Address" val={`${patient.address}${patient.city?`, ${patient.city}`:""}${patient.state?` ${patient.state}`:""}${patient.zip?` ${patient.zip}`:""}`}/>}
          {!patient.phone&&!patient.email&&!patient.address&&<Empty/>}
        </TileBody>
      </Tile>

      {/* ── Allergies ── */}
      <Tile col="#f87171">
        <TileHeader col="#f87171" icon="⚠️" label="Allergies"
          meta={allergies.length>0?`${allergies.length} on file`:undefined} tab="allergies"/>
        <TileBody>
          {allergies.length===0
            ?<div style={{fontSize:11,color:"#22c55e",fontWeight:600}}>✓ No Known Allergies</div>
            :allergies.slice(0,8).map((a,i)=>(
              <AllergyRow key={i}
                name={a.fhir.code?.text||a.fhir.code?.coding?.[0]?.display||"Unknown"}
                reaction={a.fhir.reaction?.[0]?.manifestation?.[0]?.text}/>
            ))
          }
        </TileBody>
      </Tile>

      {/* ── Problem List ── */}
      <Tile col="#a78bfa">
        <TileHeader col="#a78bfa" icon="🩺" label="Problem List"
          meta={conditions.length>0?`${conditions.length} active`:undefined} tab="problems"/>
        <TileBody>
          {conditions.length===0?<Empty/>:conditions.slice(0,12).map((c,i)=>{
            const text=c.fhir.code?.coding?.[0]?.display||c.fhir.code?.text||"Unknown";
            const chronic=c.fhir.category?.[0]?.coding?.[0]?.code==="problem-list-item"||
              (c.fhir.note?.[0]?.text||"").toLowerCase().includes("chronic");
            return <ProblemRow key={i} text={text} chronic={chronic}/>;
          })}
        </TileBody>
      </Tile>

      {/* ── Medications ── */}
      <Tile col="#34d399">
        <TileHeader col="#34d399" icon="💊" label="Medications"
          meta={meds.length>0?`${meds.length} active`:undefined} tab="meds"/>
        <TileBody>
          {meds.length===0?<Empty/>:meds.slice(0,10).map((m,i)=>(
            <MedRow key={i}
              name={m.fhir.medicationCodeableConcept?.text||"Unknown"}
              dose={m.fhir.dosageInstruction?.[0]?.text}/>
          ))}
        </TileBody>
      </Tile>

      {/* ── Weight & Height ── */}
      <Tile col="#38bdf8">
        <TileHeader col="#38bdf8" icon="📏" label="Weight & Height"
          meta="Most recent" tab="vitals"/>
        <TileBody>
          {!latestWeight&&!latestHeight?<Empty/>:(
            <div style={{display:"flex",gap:40,paddingTop:6}}>
              {latestWeight&&(
                <div>
                  <div style={{fontSize:11,color:"var(--text-label)",marginBottom:2,textTransform:"uppercase" as const,letterSpacing:"0.5px"}}>Weight</div>
                  <div style={{fontSize:26,fontWeight:700,color:"#7dd3fc",lineHeight:1}}>{latestWeight.value}</div>
                  <div style={{fontSize:10,color:"var(--text-label)",marginTop:4}}>{latestWeight.date}</div>
                </div>
              )}
              {latestHeight&&(
                <div>
                  <div style={{fontSize:11,color:"var(--text-label)",marginBottom:2,textTransform:"uppercase" as const,letterSpacing:"0.5px"}}>Height</div>
                  <div style={{fontSize:26,fontWeight:700,color:"#7dd3fc",lineHeight:1}}>{latestHeight.value}</div>
                  <div style={{fontSize:10,color:"var(--text-label)",marginTop:4}}>{latestHeight.date}</div>
                </div>
              )}
            </div>
          )}
        </TileBody>
      </Tile>

      {/* ── Immunizations ── */}
      <Tile col="#fb923c">
        <TileHeader col="#fb923c" icon="💉" label="Immunizations"
          meta={immunizations.length>0?`${immunizations.length} on file`:undefined} tab="immunizations"/>
        <TileBody>
          {immunizations.length===0?<Empty/>:immunizations.slice(0,8).map((imm,i)=>(
            <ImmRow key={i}
              name={imm.fhir.vaccineCode?.text||"Unknown"}
              date={imm.fhir.occurrenceDateTime?.split("T")[0]||""}/>
          ))}
        </TileBody>
      </Tile>

    </div>
  );
}

// ─── Staff Management (Multi-User) ────────────────────────────────────────────
function StaffManagement({keys,relay}:{keys:Keypair;relay:ReturnType<typeof useRelay>}){
  const [roster,setRoster]=useState<StaffMember[]>([]);
  const [loading,setLoading]=useState(true);
  const [showAdd,setShowAdd]=useState(false);
  const [showKeygen,setShowKeygen]=useState(false);
  const [newName,setNewName]=useState("");
  const [newNpub,setNewNpub]=useState("");
  const [newRole,setNewRole]=useState<StaffRole>("nurse");
  const [publishing,setPublishing]=useState(false);
  const [error,setError]=useState("");
  const [copied,setCopied]=useState<string|null>(null);
  const [revokeConfirm,setRevokeConfirm]=useState<string|null>(null);
  const [republishing,setRepublishing]=useState<string|null>(null);

  // Keygen state
  const [genKey,setGenKey]=useState<{nsec:string;npub:string;pkHex:string}|null>(null);
  const subIdRef=useRef<string|null>(null);
  const timeoutRef=useRef<ReturnType<typeof setTimeout>|null>(null);

  // Load roster from relay on mount
  useEffect(()=>{
    if(relay.status!=="connected")return;
    setLoading(true);
    let done=false;
    let latestEvent:NostrEvent|null=null;

    const doSubscribe=()=>{
      const subId=relay.subscribe(
        {kinds:[STAFF_KINDS.StaffRoster],authors:[keys.pkHex],limit:10},
        (ev:NostrEvent)=>{
          if(!isValidRosterEvent(ev,keys.pkHex))return;
          if(!latestEvent||ev.created_at>latestEvent.created_at){
            latestEvent=ev;
          }
        },
        async()=>{
          if(done)return;
          done=true;
          relay.unsubscribe(subId);
          if(latestEvent){
            try{
              const sharedX=getSharedSecret(keys.sk,keys.pkHex);
              const plain=await nip44Decrypt(latestEvent.content,sharedX);
              const payload:StaffRosterPayload=JSON.parse(plain);
              setRoster(payload.staff||[]);
            }catch(e){console.error("[Staff] Failed to decrypt roster:",e);}
          }
          setLoading(false);
        }
      );
      subIdRef.current=subId;
      timeoutRef.current=setTimeout(()=>{
        if(!done){done=true;setLoading(false);relay.unsubscribe(subId);}
      },5000);
    };

    // Delay to ensure WebSocket is ready after React state change
    const startTimer=setTimeout(doSubscribe,200);
    return()=>{
      done=true;
      clearTimeout(startTimer);
      if(timeoutRef.current)clearTimeout(timeoutRef.current);
      if(subIdRef.current)relay.unsubscribe(subIdRef.current);
    };
  },[relay.status,keys.pkHex]);

  // Publish updated roster to relay
  const publishRoster=async(updatedStaff:StaffMember[])=>{
    const payload:StaffRosterPayload={staff:updatedStaff};
    const sharedX=getSharedSecret(keys.sk,keys.pkHex);
    const encrypted=await nip44Encrypt(JSON.stringify(payload),sharedX);
    // Tags: staff pubkeys for reference (no d-tag needed since kind 2102 is regular, not replaceable)
    const tags=[["roster","v1"],...updatedStaff.filter(s=>!s.revokedAt).map(s=>["p",s.pkHex,s.role])];
    const event=await buildAndSignEvent(STAFF_KINDS.StaffRoster,encrypted,tags,keys.sk);
    return await relay.publish(event);
  };

  // Publish practice shared secret grant for a staff member
  const publishPracticeGrant=async(staffPkHex:string)=>{
    const practiceSharedSecret=toHex(getSharedSecret(keys.sk,keys.pkHex));
    const payload:PracticeKeyGrantPayload={practiceSharedSecret,practicePkHex:keys.pkHex};
    const staffSharedX=getSharedSecret(keys.sk,staffPkHex);
    const encrypted=await nip44Encrypt(JSON.stringify(payload),staffSharedX);
    const tags=[["p",staffPkHex],["grant","practice-secret"]];
    const event=await buildAndSignEvent(STAFF_KINDS.PracticeKeyGrant,encrypted,tags,keys.sk);
    return await relay.publish(event);
  };

  // Publish patient key grants for a staff member (all current patients)
  const publishPatientGrants=async(staffPkHex:string)=>{
    const patients=loadPatients();
    const staffSharedX=getSharedSecret(keys.sk,staffPkHex);
    let success=0;
    for(const p of patients){
      if(!p.npub)continue;
      try{
        const patientPkHex=npubToHex(p.npub);
        const patientSharedSecret=toHex(getSharedSecret(keys.sk,patientPkHex));
        const payload:PatientKeyGrantPayload={patientId:p.id,patientPkHex,patientSharedSecret};
        const encrypted=await nip44Encrypt(JSON.stringify(payload),staffSharedX);
        const tags=[["p",staffPkHex],["pt",p.id],["grant","patient-secret"]];
        const event=await buildAndSignEvent(STAFF_KINDS.PatientKeyGrant,encrypted,tags,keys.sk);
        if(await relay.publish(event))success++;
      }catch(e){console.error(`Grant failed for patient ${p.id}:`,e);}
    }
    return success;
  };

  // Add staff member
  const handleAddStaff=async()=>{
    if(!newName.trim()||!newNpub.trim()){setError("Name and npub/nsec are required.");return;}
    setError("");setPublishing(true);
    try{
      let pkHex:string;
      const input=newNpub.trim();
      if(input.startsWith("nsec1")){
        // Derive pubkey from nsec
        try{
          const staffSk=nsecToBytes(input);
          const staffPk=getPublicKey(staffSk);
          pkHex=toHex(staffPk);
        }catch{
          setError("Invalid nsec format.");setPublishing(false);return;
        }
      }else if(input.startsWith("npub1")){
        pkHex=npubToHex(input);
      }else if(/^[0-9a-fA-F]{64}$/.test(input)){
        pkHex=input;
      }else{
        setError("Enter an npub, nsec, or 64-char hex public key.");setPublishing(false);return;
      }

      // Check for duplicates
      if(roster.some(s=>s.pkHex===pkHex&&!s.revokedAt)){
        setError("This key is already in the roster.");setPublishing(false);return;
      }
      if(pkHex===keys.pkHex){
        setError("Cannot add the practice key as a staff member.");setPublishing(false);return;
      }

      const member:StaffMember={
        pkHex,name:newName.trim(),role:newRole,
        permissions:ROLE_PERMISSIONS[newRole],
        addedAt:Math.floor(Date.now()/1000),
      };
      const updated=[...roster.filter(s=>s.pkHex!==pkHex),member];

      // 1. Publish roster
      if(!await publishRoster(updated)){
        setError("Failed to publish roster to relay.");setPublishing(false);return;
      }
      // 2. Publish practice shared secret grant
      if(!await publishPracticeGrant(pkHex)){
        setError("Roster updated but practice grant failed. Try re-publishing grants.");
      }
      // 3. Publish patient key grants
      const granted=await publishPatientGrants(pkHex);
      console.log(`Published ${granted} patient key grants for ${newName.trim()}`);

      setRoster(updated);
      setNewName("");setNewNpub("");setNewRole("nurse");setShowAdd(false);
    }catch(e:any){
      setError(e.message||"Failed to add staff member.");
    }finally{setPublishing(false);}
  };

  // Revoke staff member (soft revocation)
  const handleRevoke=async(pkHex:string)=>{
    setPublishing(true);
    const updated=roster.map(s=>s.pkHex===pkHex?{...s,revokedAt:Math.floor(Date.now()/1000)}:s);
    if(await publishRoster(updated)){
      setRoster(updated);
    }
    setPublishing(false);setRevokeConfirm(null);
  };

  // Key generator
  const handleGenerate=()=>{
    const sk=generateSecretKey();
    const pk=getPublicKey(sk);
    setGenKey({nsec:nsecEncode(sk),npub:npubEncode(pk),pkHex:toHex(pk)});
  };

  const copyVal=(label:string,val:string)=>{
    navigator.clipboard.writeText(val);
    setCopied(label);setTimeout(()=>setCopied(null),2000);
  };

  const activeStaff=roster.filter(s=>!s.revokedAt);
  const revokedStaff=roster.filter(s=>!!s.revokedAt);

  const roleColors:Record<StaffRole,string>={doctor:"#8b5cf6",nurse:"#0ea5e9",ma:"#22c55e",frontdesk:"#f59e0b"};
  const roleLabels:Record<StaffRole,string>={doctor:"Doctor",nurse:"Nurse",ma:"Medical Assistant",frontdesk:"Front Desk"};

  return(
    <div style={{...S.card,marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div>
          <div style={{fontWeight:600,fontSize:13}}>👥 Staff Management</div>
          <div style={{fontSize:10,color:"var(--text-muted)",marginTop:2}}>Authorize staff access with per-user keypairs</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <Btn small col="#64748b" onClick={()=>{setShowKeygen(!showKeygen);if(!showKeygen)setShowAdd(false);}}>
            {showKeygen?"✕ Close":"🔑 Key Generator"}
          </Btn>
          <Btn small solid col="#22c55e" onClick={()=>{setShowAdd(!showAdd);if(!showAdd)setShowKeygen(false);}}>
            {showAdd?"✕ Cancel":"+ Add Staff"}
          </Btn>
        </div>
      </div>

      {/* Key Generator */}
      {showKeygen&&(
        <div style={{background:"var(--bg-app)",border:"1px solid var(--border)",borderRadius:8,padding:14,marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:12,marginBottom:8,color:"var(--text-primary)"}}>🔑 Generate Staff Keypair</div>
          <div style={{fontSize:11,color:"var(--text-muted)",marginBottom:12,lineHeight:1.6}}>
            Generate a Nostr keypair for a new staff member. Give them the nsec (secret key) securely — 
            it will only be shown once. Keep the npub (public key) to add them to the roster.
          </div>
          {!genKey?(
            <Btn solid col="#0ea5e9" onClick={handleGenerate}>Generate New Keypair</Btn>
          ):(
            <div>
              <div style={{marginBottom:10}}>
                <label style={{...S.lbl,color:"#fbbf24"}}>Secret Key (nsec) — give to staff member securely</label>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <div style={{...S.mono,flex:1,fontSize:9,padding:8,background:"var(--bg-card)",wordBreak:"break-all" as const}}>
                    {genKey.nsec}
                  </div>
                  <Btn small col="#fbbf24" onClick={()=>copyVal("nsec",genKey.nsec)}>
                    {copied==="nsec"?"✓":"📋"}
                  </Btn>
                </div>
              </div>
              <div style={{marginBottom:10}}>
                <label style={S.lbl}>Public Key (npub) — enter this in the "Add Staff" form</label>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <div style={{...S.mono,flex:1,fontSize:9,padding:8,background:"var(--bg-card)",wordBreak:"break-all" as const}}>
                    {genKey.npub}
                  </div>
                  <Btn small col="#0ea5e9" onClick={()=>copyVal("npub",genKey.npub)}>
                    {copied==="npub"?"✓":"📋"}
                  </Btn>
                </div>
              </div>
              <div style={{display:"flex",gap:8,marginTop:10}}>
                <Btn small col="#22c55e" onClick={()=>{setNewNpub(genKey.npub);setShowKeygen(false);setShowAdd(true);}}>
                  Use This Key → Add Staff
                </Btn>
                <Btn small col="#64748b" onClick={()=>setGenKey(null)}>Generate Another</Btn>
              </div>
              <div style={{fontSize:10,color:"#ef4444",marginTop:8,fontWeight:600}}>
                ⚠ The nsec above will not be shown again. Make sure the staff member has saved it before closing.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add Staff Form */}
      {showAdd&&(
        <div style={{background:"var(--bg-app)",border:"1px solid var(--border)",borderRadius:8,padding:14,marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:12,marginBottom:10,color:"var(--text-primary)"}}>Add Staff Member</div>
          <div style={{marginBottom:10}}>
            <label style={S.lbl}>Name</label>
            <input value={newName} onChange={e=>{setNewName(e.target.value);setError("");}}
              placeholder="e.g. Jane Doe" spellCheck={false}
              style={{width:"100%",background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:6,
                padding:"8px 12px",color:"var(--text-primary)",fontSize:12,boxSizing:"border-box" as const,outline:"none"}}
              onFocus={e=>e.currentTarget.style.borderColor="#0ea5e9"}
              onBlur={e=>e.currentTarget.style.borderColor="var(--border)"}
            />
          </div>
          <div style={{marginBottom:10}}>
            <label style={S.lbl}>Key (npub, nsec, or hex)</label>
            <input value={newNpub} onChange={e=>{setNewNpub(e.target.value);setError("");}}
              placeholder="npub1… / nsec1… / 64-char hex" spellCheck={false} autoComplete="off"
              style={{width:"100%",background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:6,
                padding:"8px 12px",color:"var(--text-primary)",fontSize:11,fontFamily:"monospace",
                boxSizing:"border-box" as const,outline:"none"}}
              onFocus={e=>e.currentTarget.style.borderColor="#0ea5e9"}
              onBlur={e=>e.currentTarget.style.borderColor="var(--border)"}
            />
          </div>
          <div style={{marginBottom:12}}>
            <label style={S.lbl}>Role</label>
            <div style={{display:"flex",gap:6,flexWrap:"wrap" as const}}>
              {(Object.keys(ROLE_PERMISSIONS) as StaffRole[]).map(r=>(
                <button key={r} onClick={()=>setNewRole(r)}
                  style={{
                    padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                    border:`1px solid ${newRole===r?roleColors[r]:"var(--border)"}`,
                    background:newRole===r?roleColors[r]+"20":"transparent",
                    color:newRole===r?roleColors[r]:"var(--text-secondary)",
                    fontFamily:"inherit",
                  }}>
                  {roleLabels[r]}
                </button>
              ))}
            </div>
            <div style={{fontSize:10,color:"var(--text-muted)",marginTop:6}}>
              Permissions: {ROLE_PERMISSIONS[newRole].join(", ")}
            </div>
          </div>
          {error&&(
            <div style={{color:"#fca5a5",fontSize:11,marginBottom:10,padding:"6px 10px",
              background:"var(--tint-red)",borderRadius:6,border:"1px solid var(--tint-red-border)"}}>{error}</div>
          )}
          <Btn solid col="#22c55e" onClick={handleAddStaff} disabled={publishing||!newName.trim()||!newNpub.trim()}>
            {publishing?"Publishing…":"Authorize Staff Member"}
          </Btn>
        </div>
      )}

      {/* Active Staff */}
      {loading?(
        <div style={{fontSize:11,color:"var(--text-muted)",padding:8}}>Loading roster…</div>
      ):activeStaff.length===0?(
        <div style={{fontSize:11,color:"var(--text-label)",padding:"12px 0",textAlign:"center"}}>
          No staff members authorized yet. Click "+ Add Staff" to get started.
        </div>
      ):(
        <div>
          {activeStaff.map(s=>(
            <div key={s.pkHex} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",
              borderBottom:"1px solid var(--border-subtle)"}}>
              <div style={{
                width:8,height:8,borderRadius:4,background:roleColors[s.role],flexShrink:0
              }}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{s.name}</div>
                <div style={{fontSize:10,color:roleColors[s.role],fontWeight:600}}>{roleLabels[s.role]}</div>
                <div style={{fontSize:9,color:"var(--text-label)",fontFamily:"monospace",
                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const}}>
                  {npubEncode(fromHex(s.pkHex))}
                </div>
              </div>
              <div style={{fontSize:9,color:"var(--text-label)",flexShrink:0}}>
                {new Date(s.addedAt*1000).toLocaleDateString()}
              </div>
              {revokeConfirm===s.pkHex?(
                <div style={{display:"flex",gap:4}}>
                  <Btn small col="#ef4444" onClick={()=>handleRevoke(s.pkHex)} disabled={publishing}>Confirm</Btn>
                  <Btn small col="#64748b" onClick={()=>setRevokeConfirm(null)}>Cancel</Btn>
                </div>
              ):(
                <div style={{display:"flex",gap:4}}>
                  <Btn small col="#0ea5e9" title="Re-publish decryption grants for all patients to this staff member. Use after adding new patients, or if this staff member can't decrypt a chart." disabled={republishing===s.pkHex} onClick={async()=>{
                    setRepublishing(s.pkHex);
                    try{
                      const granted=await publishPatientGrants(s.pkHex);
                      alert(`Published ${granted} patient grants for ${s.name}`);
                    }catch(e){alert("Failed: "+e);}
                    finally{setRepublishing(null);}
                  }}>{republishing===s.pkHex?"⏳":"🔄"} Grants</Btn>
                  <Btn small col="#ef4444" title="Revoke this staff member's access — deletes their key grants from the relay" onClick={()=>setRevokeConfirm(s.pkHex)}>Revoke</Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Revoked Staff (collapsed) */}
      {revokedStaff.length>0&&(
        <details style={{marginTop:10}}>
          <summary style={{fontSize:10,color:"var(--text-label)",cursor:"pointer",userSelect:"none" as const}}>
            {revokedStaff.length} revoked staff member{revokedStaff.length>1?"s":""}
          </summary>
          {revokedStaff.map(s=>(
            <div key={s.pkHex} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",
              opacity:0.5,borderBottom:"1px solid var(--border-subtle)"}}>
              <div style={{width:8,height:8,borderRadius:4,background:"var(--text-label)",flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,color:"var(--text-muted)",textDecoration:"line-through"}}>{s.name}</div>
                <div style={{fontSize:9,color:"var(--text-label)"}}>{roleLabels[s.role]} — revoked {new Date((s.revokedAt||0)*1000).toLocaleDateString()}</div>
              </div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

interface ServiceAgent {
  name: string;
  service: "billing" | "fhir-reader";
  pkHex: string;
  nsec: string;
  npub: string;
  grantedAt: number;
}

function ServiceAgentsManager({ keys, relay }: {
  keys: Keypair;
  relay: ReturnType<typeof useRelay>;
}) {
  const [agents, setAgents] = useState<{ service: string; pkHex: string; grantedAt: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<"billing" | "fhir-reader" | null>(null);
  const [generatedAgent, setGeneratedAgent] = useState<ServiceAgent | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [republishing, setRepublishing] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!keys || relay.status !== "connected") return;
    let cancelled = false;
    const found: { service: string; pkHex: string; grantedAt: number }[] = [];

    const subId = relay.subscribe(
      { kinds: [AGENT_KINDS.ServiceAgentGrant], authors: [keys.pkHex], limit: 20 },
      (ev: NostrEvent) => {
        if (ev.pubkey !== keys.pkHex) return;
        const serviceTag = ev.tags.find(t => t[0] === "service")?.[1];
        const pTag = ev.tags.find(t => t[0] === "p")?.[1];
        if (serviceTag && pTag) {
          const existing = found.findIndex(a => a.service === serviceTag);
          if (existing >= 0) {
            if (ev.created_at > found[existing].grantedAt) {
              found[existing] = { service: serviceTag, pkHex: pTag, grantedAt: ev.created_at };
            }
          } else {
            found.push({ service: serviceTag, pkHex: pTag, grantedAt: ev.created_at });
          }
        }
      },
      () => {
        if (!cancelled) { setAgents(found); setLoading(false); }
        relay.unsubscribe(subId);
      }
    );
    setTimeout(() => { try { relay.unsubscribe(subId); } catch {} if (!cancelled) setLoading(false); }, 5000);
    return () => { cancelled = true; };
  }, [keys, relay.status]);

  const copyVal = (label: string, val: string) => {
    navigator.clipboard.writeText(val);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleGenerate = (service: "billing" | "fhir-reader") => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    setGeneratedAgent({
      name: service === "billing" ? "Billing Agent" : "FHIR Reader",
      service,
      pkHex: toHex(pk),
      nsec: nsecEncode(sk),
      npub: npubEncode(pk),
      grantedAt: Math.floor(Date.now() / 1000),
    });
    setGenerating(service);
  };

  const handlePublish = async () => {
    if (!generatedAgent || !keys) return;
    setPublishing(true);
    setStatus("Publishing service agent grant...");

    try {
      const { service, pkHex } = generatedAgent;

      const agentGrantPayload = {
        agentPubkey: pkHex,
        service,
        permissions: service === "billing" ? ["send-invoices"] : ["read-clinical-data"],
        grantedAt: Math.floor(Date.now() / 1000),
      };
      const agentSharedX = getSharedSecret(keys.sk, pkHex);
      const encryptedGrant = await nip44Encrypt(JSON.stringify(agentGrantPayload), agentSharedX);
      const grantTags = [
        ["p", pkHex],
        ["service", service],
        ["d", `service-agent-${service}`],
      ];
      const grantEvent = await buildAndSignEvent(
        AGENT_KINDS.ServiceAgentGrant, encryptedGrant, grantTags, keys.sk
      );
      const grantOk = await relay.publish(grantEvent);
      if (!grantOk) {
        setStatus("✗ Failed to publish service agent grant.");
        setPublishing(false);
        return;
      }
      setStatus("✓ Agent grant published.");

      if (service === "fhir-reader") {
        setStatus("Publishing practice key grant for FHIR reader...");
        const practiceSharedSecret = toHex(getSharedSecret(keys.sk, keys.pkHex));
        const practicePayload = { practiceSharedSecret, practicePkHex: keys.pkHex };
        const encrypted1013 = await nip44Encrypt(JSON.stringify(practicePayload), agentSharedX);
        const tags1013 = [["p", pkHex], ["grant", "practice-secret"]];
        const event1013 = await buildAndSignEvent(STAFF_KINDS.PracticeKeyGrant, encrypted1013, tags1013, keys.sk);
        const ok1013 = await relay.publish(event1013);
        if (!ok1013) {
          setStatus("✗ Agent grant published but practice key grant failed. FHIR reader won't be able to decrypt.");
          setPublishing(false);
          return;
        }

        setStatus("Publishing patient key grants for FHIR reader...");
        const patients = loadPatients();
        let granted = 0;
        for (const p of patients) {
          if (!p.npub) continue;
          try {
            const patientPkHex = npubToHex(p.npub);
            const patientSharedSecret = toHex(getSharedSecret(keys.sk, patientPkHex));
            const payload = { patientId: p.id, patientPkHex, patientSharedSecret };
            const encrypted = await nip44Encrypt(JSON.stringify(payload), agentSharedX);
            const tags = [["p", pkHex], ["pt", p.id], ["grant", "patient-secret"]];
            const event = await buildAndSignEvent(STAFF_KINDS.PatientKeyGrant, encrypted, tags, keys.sk);
            if (await relay.publish(event)) granted++;
          } catch (e) { console.warn(`Patient grant failed for ${p.id}:`, e); }
        }
        setStatus(`✓ All grants published. FHIR reader has access to ${granted} patients.`);
      } else {
        setStatus("✓ Billing agent authorized. No decryption grants needed.");
      }

      setAgents(prev => {
        const filtered = prev.filter(a => a.service !== service);
        return [...filtered, { service, pkHex, grantedAt: Math.floor(Date.now() / 1000) }];
      });

    } catch (e: any) {
      setStatus(`✗ Error: ${e.message}`);
    } finally {
      setPublishing(false);
    }
  };

  const handleRepublish = async (agent: { service: string; pkHex: string }) => {
    if (!keys) return;
    setRepublishing(agent.service);
    try {
      const { service, pkHex } = agent;

      // Re-publish kind 2103 ServiceAgentGrant
      const agentGrantPayload = {
        agentPubkey: pkHex,
        service,
        permissions: service === "billing" ? ["send-invoices"] : ["read-clinical-data"],
        grantedAt: Math.floor(Date.now() / 1000),
      };
      const agentSharedX = getSharedSecret(keys.sk, pkHex);
      const encryptedGrant = await nip44Encrypt(JSON.stringify(agentGrantPayload), agentSharedX);
      const grantTags = [
        ["p", pkHex],
        ["service", service],
        ["d", `service-agent-${service}`],
      ];
      const grantEvent = await buildAndSignEvent(
        AGENT_KINDS.ServiceAgentGrant, encryptedGrant, grantTags, keys.sk
      );
      const grantOk = await relay.publish(grantEvent);
      if (!grantOk) { alert("Failed to publish agent grant."); return; }

      if (service === "fhir-reader") {
        // Re-publish practice key grant + patient key grants
        const practiceSharedSecret = toHex(getSharedSecret(keys.sk, keys.pkHex));
        const practicePayload = { practiceSharedSecret, practicePkHex: keys.pkHex };
        const encrypted1013 = await nip44Encrypt(JSON.stringify(practicePayload), agentSharedX);
        const tags1013 = [["p", pkHex], ["grant", "practice-secret"]];
        const event1013 = await buildAndSignEvent(STAFF_KINDS.PracticeKeyGrant, encrypted1013, tags1013, keys.sk);
        await relay.publish(event1013);

        const patients = loadPatients();
        let granted = 0;
        for (const p of patients) {
          if (!p.npub) continue;
          try {
            const patientPkHex = npubToHex(p.npub);
            const patientSharedSecret = toHex(getSharedSecret(keys.sk, patientPkHex));
            const payload = { patientId: p.id, patientPkHex, patientSharedSecret };
            const encrypted = await nip44Encrypt(JSON.stringify(payload), agentSharedX);
            const tags = [["p", pkHex], ["pt", p.id], ["grant", "patient-secret"]];
            const event = await buildAndSignEvent(STAFF_KINDS.PatientKeyGrant, encrypted, tags, keys.sk);
            if (await relay.publish(event)) granted++;
          } catch (e) { console.warn(`Patient grant failed for ${p.id}:`, e); }
        }
        alert(`Re-published all grants for FHIR Reader (${granted} patients).`);
      } else {
        alert("Re-published billing agent grant.");
      }

      // Update timestamp
      setAgents(prev => prev.map(a => a.service === service
        ? { ...a, grantedAt: Math.floor(Date.now() / 1000) } : a
      ));
    } catch (e: any) {
      alert(`Re-publish failed: ${e.message}`);
    } finally {
      setRepublishing(null);
    }
  };

  const serviceLabels: Record<string, string> = {
    billing: "Billing Agent",
    "fhir-reader": "FHIR Reader",
  };
  const serviceIcons: Record<string, string> = {
    billing: "💳",
    "fhir-reader": "🔬",
  };
  const serviceDescriptions: Record<string, string> = {
    billing: "Sends NIP-17 encrypted invoice DMs. Cannot read clinical data.",
    "fhir-reader": "Reads clinical data via ECDH grants. Cannot sign as practice.",
  };

  return (
    <div style={{ ...S.card, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>🤖 Service Agents</div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 12 }}>
        Dedicated keypairs for server-side services. Practice nsec stays in cold storage.
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 8 }}>Loading agents...</div>
      ) : (
        <>
          {agents.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {agents.map(a => (
                <div key={a.service} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
                  borderBottom: "1px solid var(--border-subtle)"
                }}>
                  <div style={{ fontSize: 20 }}>{serviceIcons[a.service] || "🔧"}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                      {serviceLabels[a.service] || a.service}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-label)", fontFamily: "monospace" }}>
                      {a.pkHex.slice(0, 16)}...{a.pkHex.slice(-8)}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
                      Authorized {new Date(a.grantedAt * 1000).toLocaleDateString()}
                    </div>
                  </div>
                  {a.service === "fhir-reader" && (
                    <Btn small col="#0ea5e9" disabled={republishing === a.service}
                      title="Re-publish the service agent grant and all patient decryption keys. Use after adding new patients or if the FHIR API returns decryption errors."
                      onClick={() => handleRepublish(a)}>
                      {republishing === a.service ? "⏳" : "🔄"} Grants
                    </Btn>
                  )}
                  <div style={{
                    fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 8,
                    background: "var(--tint-green)", color: "#10b981"
                  }}>Active</div>
                </div>
              ))}
            </div>
          )}

          {!generating && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
              {!agents.find(a => a.service === "billing") && (
                <Btn small solid col="#f59e0b" onClick={() => handleGenerate("billing")}>
                  + Billing Agent
                </Btn>
              )}
              {!agents.find(a => a.service === "fhir-reader") && (
                <Btn small solid col="#8b5cf6" onClick={() => handleGenerate("fhir-reader")}>
                  + FHIR Reader
                </Btn>
              )}
              {agents.length === 2 && (
                <div style={{ fontSize: 10, color: "var(--text-label)", alignSelf: "center" }}>
                  Both agents configured.
                </div>
              )}
            </div>
          )}

          {generatedAgent && (
            <div style={{
              background: "var(--bg-app)", border: "1px solid var(--border)", borderRadius: 8,
              padding: 16, marginTop: 12
            }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: "var(--text-primary)", marginBottom: 8 }}>
                {serviceIcons[generatedAgent.service]} {generatedAgent.name} — New Keypair
              </div>

              <div style={{
                background: "var(--tint-red)", border: "1px solid var(--tint-red-border)", borderRadius: 6,
                padding: 10, marginBottom: 12, fontSize: 10, color: "#fca5a5"
              }}>
                ⚠️ Save the nsec below to the server's <code>.env</code> file.
                It will NOT be shown again after you close this panel.
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>
                  nsec (save to server .env as {generatedAgent.service === "billing"
                    ? "BILLING_AGENT_NSEC" : "FHIR_AGENT_NSEC"})
                </div>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "var(--bg-card)", borderRadius: 6, padding: "6px 10px"
                }}>
                  <code style={{
                    fontSize: 10, color: "#fbbf24", fontFamily: "monospace",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1
                  }}>
                    {generatedAgent.nsec}
                  </code>
                  <Btn small col={copied === "nsec" ? "#22c55e" : "#64748b"}
                    onClick={() => copyVal("nsec", generatedAgent.nsec)}>
                    {copied === "nsec" ? "✓" : "Copy"}
                  </Btn>
                </div>
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>
                  Public key (hex) — add to relay whitelist
                </div>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "var(--bg-card)", borderRadius: 6, padding: "6px 10px"
                }}>
                  <code style={{
                    fontSize: 10, color: "var(--text-secondary)", fontFamily: "monospace",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1
                  }}>
                    {generatedAgent.pkHex}
                  </code>
                  <Btn small col={copied === "pk" ? "#22c55e" : "#64748b"}
                    onClick={() => copyVal("pk", generatedAgent.pkHex)}>
                    {copied === "pk" ? "✓" : "Copy"}
                  </Btn>
                </div>
              </div>

              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 12 }}>
                {serviceDescriptions[generatedAgent.service]}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                {!status.startsWith("✓ All grants published") && !status.startsWith("✓ Billing agent authorized") ? (
                  <>
                    <Btn small solid col="#22c55e" onClick={handlePublish} disabled={publishing}>
                      {publishing ? "Publishing..." : "Publish Grants to Relay"}
                    </Btn>
                    <Btn small col="#64748b" onClick={() => { setGeneratedAgent(null); setGenerating(null); setStatus(""); }}>
                      Cancel
                    </Btn>
                  </>
                ) : (
                  <Btn small solid col="#22c55e" onClick={() => { setGeneratedAgent(null); setGenerating(null); setStatus(""); }}>
                    ✓ Done
                  </Btn>
                )}
              </div>

              {status && (
                <div style={{
                  fontSize: 10, marginTop: 8, padding: "6px 10px", borderRadius: 6,
                  background: status.startsWith("✗") ? "var(--tint-red)" : "var(--tint-green)",
                  color: status.startsWith("✗") ? "#f87171" : "var(--accent-green)",
                  border: `1px solid ${status.startsWith("✗") ? "var(--tint-red-border)" : "var(--tint-green-border)"}`
                }}>
                  {status}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Settings (Practice Identity, Security, Service Agents, Staff, Backup) ───
function SettingsView({keys,relay}:{keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [showKeys,setShowKeys]=useState(false);
  const [copied,setCopied]=useState<string|null>(null);
  const [securityUnlocked,setSecurityUnlocked]=useState(false);
  const [unlockError,setUnlockError]=useState("");
  const [unlockLoading,setUnlockLoading]=useState(false);
  const [nsecUnlockInput,setNsecUnlockInput]=useState("");
  const [showNsecUnlock,setShowNsecUnlock]=useState(false);
  const unlockTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null);

  const UNLOCK_TIMEOUT=5*60*1000; // 5 minutes

  // Auto-lock after timeout
  useEffect(()=>{
    if(!securityUnlocked)return;
    if(unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current=setTimeout(()=>{
      setSecurityUnlocked(false);
      setShowKeys(false);
      setNsecUnlockInput("");
    },UNLOCK_TIMEOUT);
    return ()=>{ if(unlockTimerRef.current) clearTimeout(unlockTimerRef.current); };
  },[securityUnlocked]);

  const handleUnlockYubiKey=async()=>{
    const store=loadAuthStore();
    if(!store?.credentials?.length)return;
    setUnlockLoading(true);
    setUnlockError("");
    try{
      const skHex=await authenticateYubiKey(store);
      if(skHex && keys && skHex===toHex(keys.sk)){
        setSecurityUnlocked(true);
        setNsecUnlockInput("");
      } else {
        setUnlockError("Authentication failed or key mismatch.");
      }
    } catch {
      setUnlockError("YubiKey authentication failed.");
    } finally {
      setUnlockLoading(false);
    }
  };

  const handleUnlockNsec=()=>{
    if(!keys)return;
    setUnlockError("");
    try{
      const trimmed=nsecUnlockInput.trim();
      let inputSk:Uint8Array;
      if(trimmed.startsWith("nsec1")){
        inputSk=nsecToBytes(trimmed);
      } else if(/^[0-9a-fA-F]{64}$/.test(trimmed)){
        inputSk=fromHex(trimmed);
      } else {
        setUnlockError("Invalid key format.");
        return;
      }
      if(toHex(inputSk)===toHex(keys.sk)){
        setSecurityUnlocked(true);
        setNsecUnlockInput("");
      } else {
        setUnlockError("Key does not match the active practice key.");
      }
    } catch {
      setUnlockError("Invalid key. Please check and try again.");
    }
  };

  const handleLock=()=>{
    setSecurityUnlocked(false);
    setShowKeys(false);
    setNsecUnlockInput("");
    if(unlockTimerRef.current){ clearTimeout(unlockTimerRef.current); unlockTimerRef.current=null; }
  };

  const copyKey=(type:string,value:string)=>{
    navigator.clipboard.writeText(value);
    setCopied(type);
    setTimeout(()=>setCopied(null),2000);
  };

  const exportBackup=()=>{
    if(!keys)return;
    const backup={
      exported:new Date().toISOString(),
      practice:PRACTICE_NAME,
      nsec:keys.nsec,
      npub:keys.npub,
      warning:"KEEP THIS FILE SECURE - Contains your practice master key"
    };
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`nostr-ehr-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if(!keys)return <div style={{padding:"24px 28px"}}>Loading keys...</div>;

  const authStore=loadAuthStore();
  const hasYubiKeys=(authStore?.credentials?.length??0)>0;

  // Security gate overlay for sensitive sections
  const SecurityGate=({children}:{children:React.ReactNode})=>{
    if(securityUnlocked) return <>{children}</>;
    return(
      <div style={{...S.card,background:"var(--bg-app)",border:"1px solid var(--border)",marginBottom:16,position:"relative",overflow:"hidden"}}>
        <div style={{textAlign:"center",padding:"32px 24px"}}>
          <div style={{fontSize:32,marginBottom:12}}>🔒</div>
          <div style={{fontWeight:700,fontSize:14,color:"var(--text-primary)",marginBottom:4}}>
            Security Sections Locked
          </div>
          <div style={{fontSize:11,color:"var(--text-muted)",marginBottom:20,maxWidth:320,margin:"0 auto 20px"}}>
            Re-authenticate to access practice keys, backup, YubiKey management, and device settings.
            Auto-locks after 5 minutes.
          </div>

          {/* YubiKey unlock */}
          {hasYubiKeys&&(
            <div style={{marginBottom:16}}>
              <button
                onClick={handleUnlockYubiKey}
                disabled={unlockLoading}
                style={{
                  padding:"14px 28px",background:"var(--bg-app)",
                  border:"2px solid var(--border)",borderRadius:12,cursor:unlockLoading?"default":"pointer",
                  transition:"all 0.2s",display:"inline-flex",alignItems:"center",gap:8,
                  color:"var(--text-primary)",fontSize:13,fontWeight:600,fontFamily:"inherit",
                }}
                onMouseEnter={e=>{if(!unlockLoading)e.currentTarget.style.borderColor="#0ea5e9";}}
                onMouseLeave={e=>{if(!unlockLoading)e.currentTarget.style.borderColor="var(--border)";}}
              >
                <span style={{fontSize:18,animation:unlockLoading?"pulse 1.5s ease-in-out infinite":"none"}}>🔑</span>
                {unlockLoading?"Tap YubiKey…":"Unlock with YubiKey"}
              </button>
            </div>
          )}

          {/* Divider */}
          {hasYubiKeys&&(
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,color:"var(--text-label)",fontSize:11,maxWidth:280,margin:"0 auto 16px"}}>
              <div style={{flex:1,height:1,background:"var(--border)"}}/>
              <span>or enter key manually</span>
              <div style={{flex:1,height:1,background:"var(--border)"}}/>
            </div>
          )}

          {/* Nsec/hex unlock */}
          <div style={{maxWidth:320,margin:"0 auto"}}>
            <div style={{position:"relative",marginBottom:8}}>
              <input
                type={showNsecUnlock?"text":"password"}
                value={nsecUnlockInput}
                onChange={e=>{setNsecUnlockInput(e.target.value);setUnlockError("");}}
                onKeyDown={e=>{if(e.key==="Enter")handleUnlockNsec();}}
                placeholder="nsec1… or hex"
                autoComplete="off"
                spellCheck={false}
                style={{
                  width:"100%",background:"var(--bg-card)",
                  border:`1px solid ${unlockError?"#ef4444":"var(--border)"}`,
                  borderRadius:8,padding:"10px 38px 10px 12px",
                  color:"var(--text-primary)",fontSize:12,fontFamily:"monospace",
                  boxSizing:"border-box",outline:"none",
                }}
                onFocus={e=>e.currentTarget.style.borderColor=unlockError?"#ef4444":"#0ea5e9"}
                onBlur={e=>e.currentTarget.style.borderColor=unlockError?"#ef4444":"var(--border)"}
              />
              <button
                onClick={()=>setShowNsecUnlock(!showNsecUnlock)}
                style={{
                  position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",
                  background:"none",border:"none",cursor:"pointer",
                  color:"var(--text-muted)",fontSize:14,padding:"2px 4px",
                }}
                tabIndex={-1}
              >{showNsecUnlock?"🙈":"👁"}</button>
            </div>
            <Btn solid col="#0ea5e9" onClick={handleUnlockNsec} disabled={!nsecUnlockInput.trim()}>
              Unlock
            </Btn>
          </div>

          {/* Error */}
          {unlockError&&(
            <div style={{color:"#fca5a5",fontSize:11,marginTop:10,padding:"6px 12px",
              background:"var(--tint-red)",borderRadius:6,border:"1px solid var(--tint-red-border)",display:"inline-block"}}>
              {unlockError}
            </div>
          )}
        </div>
      </div>
    );
  };

  return(
    <div style={{padding:"24px 28px"}}>
      <div style={{...S.card,marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontWeight:700,fontSize:16,marginBottom:4}}>⚙️ Practice Settings</div>
          <div style={{fontSize:11,color:"var(--text-muted)"}}>Security & Key Management</div>
        </div>
      </div>

      {/* Dot Phrases — top of settings */}
      <DotPhraseManager/>

      {/* Practice Identity (PUBLIC — no gate) */}
      <div style={{...S.card,marginBottom:16}}>
        <div style={{fontWeight:600,fontSize:13,marginBottom:12}}>🏥 Practice Identity</div>
        <div style={{marginBottom:8}}>
          <label style={S.lbl}>Public Key (npub)</label>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <div style={{...S.mono,flex:1,fontSize:9,padding:8}}>
              {keys.npub}
            </div>
            <Btn small col="#0ea5e9" onClick={()=>copyKey("npub",keys.npub)}>
              {copied==="npub"?"✓":"📋"}
            </Btn>
          </div>
          <div style={{fontSize:10,color:"var(--text-muted)",marginTop:4}}>
            Share this with patients or other providers (public, safe to share)
          </div>
        </div>
      </div>

      {/* Relay Status (PUBLIC — no gate) */}
      <div style={{...S.card,marginBottom:16}}>
        <div style={{fontWeight:600,fontSize:13,marginBottom:12}}>🌐 Relay Configuration</div>
        <div style={{marginBottom:8}}>
          <label style={S.lbl}>Connected Relay</label>
          <div style={{...S.mono,fontSize:10,padding:8}}>
            {RELAY_URL}
          </div>
        </div>
        <div style={{fontSize:11,color:"var(--text-muted)"}}>
          Self-hosted relay with whitelist authorization. Your public key is whitelisted.
        </div>
      </div>

      {/* Portal Connection Generator (PUBLIC — no gate) */}
      <PortalConnectionGenerator pkHex={keys.pkHex} />

      {/* ═══ SECURITY GATE ═══ Practice owner only — hidden for staff */}
      {keys.pkHex===PRACTICE_PUBKEY&&(<>
      <div style={{marginTop:24,marginBottom:8}}>
        {securityUnlocked&&(
          <div style={{display:"flex",justifyContent:"flex-end",marginBottom:6}}>
            <Btn small col="#f59e0b" onClick={handleLock}>🔒 Lock</Btn>
          </div>
        )}
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <div style={{flex:1,height:1,background:"var(--border)"}}/>
          <span style={{fontSize:10,color:securityUnlocked?"var(--accent-green)":"var(--text-muted)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.5px"}}>
            {securityUnlocked?"🔓 Unlocked — auto-locks in 5 min":"🔒 Protected Sections"}
          </span>
          <div style={{flex:1,height:1,background:"var(--border)"}}/>
        </div>
      </div>

      <SecurityGate>
        {/* Critical Warning — top of locked section */}
        <div style={{...S.card,background:"var(--tint-red)",border:"1px solid var(--tint-red-border)",marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:13,color:"var(--accent-red-text)",marginBottom:8}}>
            🚨 Critical: Backup Your Practice Keys
          </div>
          <div style={{fontSize:11,color:"var(--accent-red-sub)",lineHeight:1.6}}>
            Your practice keys encrypt ALL patient data. If you lose them (clear browser data, switch computers, etc), 
            you will lose access to ALL patient records permanently. There is no password reset or recovery mechanism.
          </div>
        </div>

        {/* Staff Management */}
        <StaffManagement keys={keys} relay={relay}/>
        <ServiceAgentsManager keys={keys} relay={relay}/>

        {/* Backup Actions */}
        <div style={{...S.card,marginBottom:16}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:12}}>💾 Backup & Recovery</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap" as const}}>
            <Btn solid col="#0ea5e9" onClick={exportBackup}>
              📥 Download Backup File
            </Btn>
            <Btn col="#64748b" onClick={()=>window.print()}>
              🖨 Print Emergency Backup
            </Btn>
          </div>
          <div style={{fontSize:10,color:"var(--text-muted)",marginTop:8}}>
            Store backup file on encrypted USB drive. Keep paper backup in secure physical location (safe, lockbox).
          </div>
        </div>

        {/* YubiKey Authentication */}
        <YubiKeyManager keys={keys} />

        {/* Forget This Device */}
        <div style={{...S.card,marginTop:16}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:4}}>🗑️ Device Management</div>
          <div style={{fontSize:11,color:"var(--text-muted)",marginBottom:12}}>
            Remove all stored credentials from this browser. You&apos;ll need to enter your nsec and re-register YubiKeys on next login.
          </div>
          <Btn col="#ef4444" onClick={()=>{
            if(!confirm("This will remove all saved login data from this device. You will need your nsec to sign in again. Continue?")) return;
            clearAuthStore();
            localStorage.removeItem(REMEMBERED_SK_KEY);
            localStorage.removeItem("nostr_ehr_practice_sk"); // clear legacy key too
            alert("Device credentials cleared. You will need your nsec on next sign-in.");
          }}>
            Forget This Device
          </Btn>
        </div>
      </SecurityGate>
      </>)}
    </div>
  );
}

// ─── Calendar/Schedule View ──────────────────────────────────────────────────
const CAL_MONTHS_FULL=["January","February","March","April","May","June","July","August","September","October","November","December"];
const CAL_DAYS_SHORT=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const CAL_DAYS_FULL=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function CalendarView({onStartVideo,onOpenChart,keys,relay}:{onStartVideo?:(apptId:number,patientName:string,patientPkHex:string)=>void;onOpenChart?:(patientNpub:string)=>void;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);
  const todayD=useMemo(()=>{ const d=new Date(); d.setHours(0,0,0,0); return d; },[]);
  const todayStr=useMemo(()=>calDateStr(todayD),[todayD]);
  const [calMonth,setCalMonth]=useState(()=>{ const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),1); });
  const [selectedDate,setSelectedDate]=useState<Date>(()=>{ const d=new Date(); d.setHours(0,0,0,0); return d; });
  const [monthAppts,setMonthAppts]=useState<Record<string,any[]>>({});
  const [dayAppts,setDayAppts]=useState<any[]>([]);
  const [daySlots,setDaySlots]=useState<any[]>([]);
  const [pending,setPending]=useState<any[]>([]);
  const [loadingDay,setLoadingDay]=useState(false);
  const [view,setView]=useState<"schedule"|"availability">("schedule");
  const [templates,setTemplates]=useState<any[]>([]);
  const [pendingChanges,setPendingChanges]=useState<Record<number,Record<string,boolean>>>({});
  const [openDays,setOpenDays]=useState<Set<number>>(new Set());
  const [savingAvail,setSavingAvail]=useState(false);
  const [patients,setPatients]=useState<Patient[]>([]);


  // Modal state
  const [apptModal,setApptModal]=useState(false);
  const [detailModal,setDetailModal]=useState<any|null>(null);
  const [editingId,setEditingId]=useState<number|null>(null);
  const [apptForm,setApptForm]=useState({patient_npub:"",patient_name:"",date:"",start_time:"09:00",end_time:"09:30",appt_type:"in_person",notes:"",video_url:"",status:"confirmed"});
  const [saving,setSaving]=useState(false);
  const [visitColorMenu,setVisitColorMenu]=useState<number|null>(null); // appt id of open menu
  const [editingComment,setEditingComment]=useState<number|null>(null); // appt id being comment-edited
  const [commentDraft,setCommentDraft]=useState("");

  // Visit workflow colors
  const VISIT_COLORS:{[k:string]:{color:string;label:string}}={
    "":         {color:"#3b82f6",label:"—"},           // baseline/default = blue
    checked_in: {color:"#e879f9",label:"Checked In"},   // magenta
    ready:      {color:"#22c55e",label:"Ready for Provider"}, // green
    complete:   {color:"#e8edf5",label:"Visit Complete"},     // white
    signed:     {color:"#a78bfa",label:"Visit Signed"},       // purple
  };
  function visitBarColor(appt:any){ return VISIT_COLORS[appt.visit_color||""]?.color||"#3b82f6"; }

  // Quick-update visit tracking (fire-and-forget PATCH)
  const updateVisitField=async(id:number,field:"visit_color"|"schedule_comment",value:string)=>{
    try{
      await fetch(`${CAL_API}/api/appointments/${id}/visit`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({[field]:value})});
      // Update local state so UI is instant
      setDayAppts(prev=>prev.map(a=>a.id===id?{...a,[field]:value}:a));
    }catch(e){ console.error("visit update failed",e); }
  };

  useEffect(()=>{ setPatients(loadPatients()); },[]);

  function calDateStr(d:Date){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
  function fmtT(t:string){ const[h,m]=t.split(":").map(Number); return`${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`; }
  function fmtD(ds:string){ const d=new Date(ds+"T00:00:00"); return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}); }
  function typeLabel(t:string){ return({in_person:"In Person",phone:"Phone",video:"Video"} as any)[t]||t; }
  function statusColor(s:string){ return({confirmed:"#22c55e",pending:"#f59e0b",cancelled:"#6b7fa3",declined:"#ef4444"} as any)[s]||"#6b7fa3"; }
  function addMins(t:string,m:number){ const[h,mm]=t.split(":").map(Number);const tot=h*60+mm+m;return`${String(Math.floor(tot/60)%24).padStart(2,"0")}:${String(tot%60).padStart(2,"0")}`; }

  const loadMonth=useCallback(async(base:Date)=>{
    const y=base.getFullYear(), m=String(base.getMonth()+1).padStart(2,"0");
    const last=new Date(base.getFullYear(),base.getMonth()+1,0).getDate();
    try{
      const res=await fetch(`${CAL_API}/api/appointments?start=${y}-${m}-01&end=${y}-${m}-${String(last).padStart(2,"0")}`);
      const data=await res.json();
      const byDate:Record<string,any[]>={};
      (Array.isArray(data)?data:[]).forEach((a:any)=>{ if(!byDate[a.date])byDate[a.date]=[]; byDate[a.date].push(a); });
      setMonthAppts(byDate);
    }catch{}
  },[]);

  const loadDay=useCallback(async(date:Date)=>{
    setLoadingDay(true);
    const ds=calDateStr(date);
    try{
      const[appts,slots]=await Promise.all([
        fetch(`${CAL_API}/api/appointments?date=${ds}`).then(r=>r.json()).catch(()=>[]),
        fetch(`${CAL_API}/api/availability/${ds}`).then(r=>r.json()).catch(()=>[]),
      ]);
      setDayAppts(Array.isArray(appts)?appts:[]);
      setDaySlots(Array.isArray(slots)?slots:[]);
    }finally{ setLoadingDay(false); }
  },[]);

  const loadPending=useCallback(async()=>{
    const now=new Date(); const future=new Date(now); future.setDate(future.getDate()+30);
    try{
      const res=await fetch(`${CAL_API}/api/appointments?start=${calDateStr(now)}&end=${calDateStr(future)}`);
      const data=await res.json();
      setPending((Array.isArray(data)?data:[]).filter((a:any)=>a.status==="pending"));
    }catch{}
  },[]);

  useEffect(()=>{ loadMonth(calMonth); },[calMonth,loadMonth]);
  useEffect(()=>{ loadDay(selectedDate); },[selectedDate,loadDay]);

  // Auto-process ready intakes on startup

  useEffect(()=>{ loadPending(); },[loadPending]);


  const selectDate=(d:Date)=>{ setSelectedDate(d); setView("schedule"); };
  const changeMonth=(dir:number)=>setCalMonth(c=>new Date(c.getFullYear(),c.getMonth()+dir,1));
  const changeDay=(dir:number)=>{ const d=new Date(selectedDate); d.setDate(d.getDate()+dir); selectDate(d); };
  const goToday=()=>{ const t=new Date(); t.setHours(0,0,0,0); setCalMonth(new Date(t.getFullYear(),t.getMonth(),1)); selectDate(t); };

  // Mini calendar grid
  const calY=calMonth.getFullYear(), calM=calMonth.getMonth();
  const daysInMonth=new Date(calY,calM+1,0).getDate();
  const firstDow=new Date(calY,calM,1).getDay(); // Sun=0
  const daysInPrev=new Date(calY,calM,0).getDate();
  const selStr=calDateStr(selectedDate);

  // Day schedule time blocks
  const dow=selectedDate.getDay();
  const isWeekend=dow===0||dow===6;
  const apptsByTime:Record<string,any>={};
  dayAppts.filter(a=>a.status!=="cancelled"&&a.status!=="declined").forEach(a=>{ apptsByTime[a.start_time]=a; });
  const slotsByTime:Record<string,any>={};
  daySlots.forEach(s=>{ if(!apptsByTime[s.start_time]) slotsByTime[s.start_time]=s; });
  const allTimes=[...new Set([...Object.keys(apptsByTime),...Object.keys(slotsByTime)])].sort();
  const apptCount=monthAppts[selStr]?.filter((a:any)=>a.status!=="cancelled"&&a.status!=="declined").length||0;

  const openNew=(date?:string,time?:string)=>{
    setEditingId(null);
    setApptForm({patient_npub:"",patient_name:"",date:date||selStr,start_time:time||"09:00",end_time:time?addMins(time,30):"09:30",appt_type:"in_person",notes:"",video_url:"",status:"confirmed"});
    setApptModal(true);
  };
  const openEdit=async(id:number)=>{
    try{
      const a=await fetch(`${CAL_API}/api/appointments/${id}`).then(r=>r.json());
      setEditingId(id);
      setApptForm({patient_npub:a.patient_npub||"",patient_name:a.patient_name||"",date:a.date,start_time:a.start_time,end_time:a.end_time,appt_type:a.appt_type||"in_person",notes:a.notes||"",video_url:a.video_url||"",status:a.status||"confirmed"});
      setDetailModal(null);
      setApptModal(true);
    }catch{}
  };
  const saveAppt=async()=>{
    if(!apptForm.patient_name||!apptForm.date||!apptForm.start_time)return;
    setSaving(true);
    try{
      if(editingId){
        await fetch(`${CAL_API}/api/appointments/${editingId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(apptForm)});
      } else {
        await fetch(`${CAL_API}/api/appointments`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...apptForm,force:true})});
      }
      setApptModal(false);
      await Promise.all([loadMonth(calMonth),loadDay(selectedDate),loadPending()]);
    }finally{ setSaving(false); }
  };
  const quickStatus=async(id:number,status:string)=>{
    await fetch(`${CAL_API}/api/appointments/${id}/status`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status})});
    await Promise.all([loadMonth(calMonth),loadDay(selectedDate),loadPending()]);
  };
  const delAppt=async(id:number)=>{
    if(!confirm("Delete this appointment?"))return;
    await fetch(`${CAL_API}/api/appointments/${id}`,{method:"DELETE"});
    setDetailModal(null);
    await Promise.all([loadMonth(calMonth),loadDay(selectedDate),loadPending()]);
  };
  const showDetail=async(id:number)=>{
    try{ const a=await fetch(`${CAL_API}/api/appointments/${id}`).then(r=>r.json()); setDetailModal(a); }catch{}
  };

  // Availability
  const loadAvailability=useCallback(async()=>{
    try{ const t=await fetch(`${CAL_API}/api/availability/templates`).then(r=>r.json()); setTemplates(Array.isArray(t)?t:[]); }catch{}
  },[]);
  useEffect(()=>{ if(view==="availability") loadAvailability(); },[view,loadAvailability]);

  const allSlots:string[]=[];
  for(let h=9;h<16;h++) for(let m=0;m<60;m+=30) allSlots.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);

  const saveAvailability=async()=>{
    setSavingAvail(true);
    try{
      for(const [dayStr,changes] of Object.entries(pendingChanges)){
        const day=parseInt(dayStr);
        const toDelete=templates.filter(t=>t.day_of_week===day);
        for(const t of toDelete) await fetch(`${CAL_API}/api/availability/templates/${t.id}`,{method:"DELETE"});
        // Rebuild from current chip states
        for(const [time,active] of Object.entries(changes)){
          if(active){
            const[h,m]=time.split(":").map(Number);
            const endM=m+30; const endStr=`${String(m===30?h+1:h).padStart(2,"0")}:${String(endM%60).padStart(2,"0")}`;
            await fetch(`${CAL_API}/api/availability/templates`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({day_of_week:day,start_time:time,end_time:endStr,duration_min:30})});
          }
        }
      }
      setPendingChanges({});
      await loadAvailability();
      setView("schedule");
    }finally{ setSavingAvail(false); }
  };

  const CS={ // calendar styles inline
    surface:"var(--bg-app)", surfaceHi:"var(--bg-hover)", border:"var(--border)",
    text:"var(--text-primary)", muted:"var(--text-muted)", accent:"#f7931a",
    green:"#22c55e", red:"#ef4444", amber:"#f59e0b", blue:"#3b82f6", purple:"#8b5cf6",
  };

  // SSR guard — after all hooks, safe to return early now
  if(!mounted) return <div style={{flex:1,background:"var(--bg-app)"}}/>;

  return(
    <div style={{display:"flex",height:"calc(100vh - 52px)",overflow:"hidden",background:CS.surface,fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:CS.text}}>

      {/* ── Left Sidebar ── */}
      <div style={{width:240,background:CS.surface,borderRight:`1px solid ${CS.border}`,display:"flex",flexDirection:"column",flexShrink:0,overflowY:"auto"}}>

        {/* Mini Calendar */}
        <div style={{padding:16,borderBottom:`1px solid ${CS.border}`}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <button onClick={()=>changeMonth(-1)} style={{background:"none",border:"none",color:CS.muted,cursor:"pointer",fontSize:18,padding:"0 4px",lineHeight:1}}>‹</button>
            <span style={{fontWeight:700,fontSize:13}}>{CAL_MONTHS_FULL[calM]} {calY}</span>
            <button onClick={()=>changeMonth(1)} style={{background:"none",border:"none",color:CS.muted,cursor:"pointer",fontSize:18,padding:"0 4px",lineHeight:1}}>›</button>
          </div>
          {/* Day-of-week headers */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,textAlign:"center",marginBottom:2}}>
            {CAL_DAYS_SHORT.map(d=><div key={d} style={{fontSize:10,color:CS.muted,fontWeight:600,textTransform:"uppercase",padding:"2px 0"}}>{d[0]}</div>)}
          </div>
          {/* Grid */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,textAlign:"center"}}>
            {/* Prev month fill */}
            {Array.from({length:firstDow},(_,i)=>(
              <div key={`p${i}`} style={{padding:"4px 2px",fontSize:12,color:CS.border}}>{daysInPrev-firstDow+i+1}</div>
            ))}
            {/* Current month */}
            {Array.from({length:daysInMonth},(_,i)=>{
              const d=i+1;
              const ds=`${calY}-${String(calM+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
              const isToday=ds===todayStr;
              const isSel=ds===selStr;
              const hasAppts=!!(monthAppts[ds]?.filter((a:any)=>a.status!=="cancelled"&&a.status!=="declined").length);
              return(
                <div key={d} onClick={()=>selectDate(new Date(calY,calM,d))}
                  style={{padding:"4px 2px",fontSize:12,lineHeight:1.8,borderRadius:6,cursor:"pointer",
                    background:isSel?CS.accent:"transparent",
                    color:isSel?"#fff":isToday?CS.accent:CS.text,
                    fontWeight:isSel||isToday?700:400,
                    position:"relative",
                  }}>
                  {d}
                  {hasAppts&&<span style={{display:"block",width:4,height:4,borderRadius:"50%",background:isSel?"#fff":CS.blue,margin:"-2px auto 0"}}/>}
                </div>
              );
            })}
            {/* Next month fill */}
            {Array.from({length:(7-(firstDow+daysInMonth)%7)%7},(_,i)=>(
              <div key={`n${i}`} style={{padding:"4px 2px",fontSize:12,color:CS.border}}>{i+1}</div>
            ))}
          </div>
        </div>

        {/* Pending Approvals */}
        <div style={{padding:"14px 16px",flex:1}}>
          <div style={{fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:10}}>Pending Approval</div>
          {pending.length===0&&<div style={{color:CS.muted,fontSize:12}}>No pending requests</div>}
          {pending.map(a=>(
            <div key={a.id} onClick={()=>showDetail(a.id)}
              style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,borderLeft:`3px solid ${CS.amber}`,borderRadius:8,padding:"10px 12px",marginBottom:8,cursor:"pointer"}}>
              <div style={{fontWeight:600,fontSize:12,marginBottom:2}}>{a.patient_name}</div>
              <div style={{color:CS.muted,fontSize:11}}>{fmtD(a.date)} · {fmtT(a.start_time)} · {typeLabel(a.appt_type)}</div>
              <div style={{display:"flex",gap:6,marginTop:8}}>
                <button onClick={e=>{e.stopPropagation();quickStatus(a.id,"confirmed");}} style={{background:"#22c55e20",border:`1px solid ${CS.green}`,color:CS.green,borderRadius:6,padding:"3px 9px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✓ Confirm</button>
                <button onClick={e=>{e.stopPropagation();quickStatus(a.id,"declined");}} style={{background:"#ef444420",border:`1px solid ${CS.red}`,color:CS.red,borderRadius:6,padding:"3px 9px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✗ Decline</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Day Schedule ── */}
      {view==="schedule"&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* Schedule header */}
          <div style={{padding:"16px 24px",borderBottom:`1px solid ${CS.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
            <div>
              <h2 style={{fontSize:20,fontWeight:800,letterSpacing:"-0.02em"}}>
                {selectedDate.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
              </h2>
              <p style={{fontSize:12,color:CS.muted,marginTop:2}}>
                {isWeekend?(apptCount>0?`Weekend · ${apptCount} appointment${apptCount!==1?"s":""}`:"Weekend — office closed"):apptCount>0?`${apptCount} appointment${apptCount!==1?"s":""}`:loadingDay?"Loading…":"No appointments scheduled"}
              </p>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={()=>changeDay(-1)} style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>‹ Prev</button>
              <button onClick={goToday} style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Today</button>
              <button onClick={()=>changeDay(1)} style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Next ›</button>
              <button onClick={()=>setView("availability")} style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>⚙ Availability</button>
              <button onClick={()=>openNew()} style={{background:CS.accent,border:"none",color:"#fff",borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ New Appointment</button>
            </div>
          </div>

          {/* Schedule body */}
          <div onClick={()=>{if(visitColorMenu!==null)setVisitColorMenu(null);}} style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
            {isWeekend&&allTimes.length===0&&(
              <div style={{textAlign:"center",padding:"60px 20px",color:CS.muted}}>
                <div style={{fontSize:40,marginBottom:14}}>🏖️</div>
                <p style={{marginBottom:12}}>Weekend — office closed</p>
                <button onClick={()=>openNew(selStr)} style={{background:"transparent",border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"6px 14px",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Schedule anyway</button>
              </div>
            )}
            {isWeekend&&allTimes.length>0&&(
              <div style={{marginBottom:16,padding:"10px 14px",background:"#f59e0b10",border:"1px solid #f59e0b30",borderRadius:8,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:16}}>🏖️</span>
                <span style={{fontSize:12,color:CS.amber,fontWeight:600}}>Weekend — {allTimes.length} appointment{allTimes.length!==1?"s":""} scheduled outside normal hours</span>
                <span style={{marginLeft:"auto"}}><button onClick={()=>openNew(selStr)} style={{background:"transparent",border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"4px 10px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>+ Add</button></span>
              </div>
            )}
            {!isWeekend&&!loadingDay&&allTimes.length===0&&
              <div style={{textAlign:"center",padding:"60px 20px",color:CS.muted}}>
                <div style={{fontSize:40,marginBottom:14}}>📅</div>
                <p style={{marginBottom:12}}>No appointments today</p>
                <button onClick={()=>openNew(selStr)} style={{background:CS.accent,border:"none",color:"#fff",borderRadius:7,padding:"7px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ New Appointment</button>
              </div>
            }
            {allTimes.map(time=>{
              const appt=apptsByTime[time];
              const slot=slotsByTime[time];
              return(
                <div key={time} style={{display:"flex",gap:16,marginBottom:4,minHeight:56}}>
                  <div style={{width:52,flexShrink:0,textAlign:"right",color:CS.muted,fontSize:11,fontWeight:600,paddingTop:4,fontFamily:"monospace"}}>{fmtT(time)}</div>
                  <div style={{flex:1,borderTop:`1px solid ${CS.border}`,paddingTop:4,minHeight:56}}>
                    {appt?(
                      <div style={{display:"flex",gap:0,alignItems:"stretch",marginBottom:4,position:"relative"}}>
                        {/* ── Visit Color Indicator (clickable) ── */}
                        <div onClick={e=>{e.stopPropagation();setVisitColorMenu(visitColorMenu===appt.id?null:appt.id);}}
                          style={{width:6,flexShrink:0,borderRadius:"4px 0 0 4px",background:visitBarColor(appt),cursor:"pointer",transition:"width 0.15s"}}
                          onMouseEnter={e=>(e.currentTarget as HTMLElement).style.width="10px"}
                          onMouseLeave={e=>(e.currentTarget as HTMLElement).style.width="6px"}
                          title={VISIT_COLORS[appt.visit_color||""]?.label||"Set visit status"}
                        />
                        {/* Visit color dropdown */}
                        {visitColorMenu===appt.id&&(
                          <div onClick={e=>e.stopPropagation()} style={{position:"absolute",left:14,top:0,zIndex:50,background:CS.surface,border:`1px solid ${CS.border}`,borderRadius:8,padding:6,boxShadow:"0 8px 24px var(--shadow-heavy)",minWidth:180}}>
                            {Object.entries(VISIT_COLORS).map(([key,{color,label}])=>(
                              <div key={key} onClick={()=>{updateVisitField(appt.id,"visit_color",key);setVisitColorMenu(null);}}
                                style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,color:CS.text,background:(appt.visit_color||"")=== key?`${color}15`:"transparent"}}
                                onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background=`${color}20`}
                                onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=(appt.visit_color||"")===key?`${color}15`:"transparent"}
                              >
                                <span style={{width:12,height:12,borderRadius:3,background:color,border:color==="#e8edf5"?`1px solid ${CS.border}`:"none",flexShrink:0}}/>
                                {label==="—"?"Baseline":label}
                                {(appt.visit_color||"")=== key&&<span style={{marginLeft:"auto",fontSize:10}}>✓</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {/* ── Main appointment card ── */}
                        <div onClick={()=>showDetail(appt.id)} style={{
                          flex:1,borderRadius:"0 8px 8px 0",padding:"10px 14px",
                          background:CS.surfaceHi,cursor:"pointer",
                          display:"flex",flexDirection:"column",gap:4,
                          transition:"transform 0.15s",
                        }}
                          onMouseEnter={e=>(e.currentTarget as HTMLElement).style.transform="translateX(2px)"}
                          onMouseLeave={e=>(e.currentTarget as HTMLElement).style.transform="translateX(0)"}
                        >
                          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                            <div>
                              <div style={{fontWeight:700,fontSize:13,marginBottom:3}}>{appt.patient_name}</div>
                              <div style={{fontSize:11,color:CS.muted,display:"flex",gap:8,flexWrap:"wrap" as const}}>
                                <span>{fmtT(appt.start_time)} – {fmtT(appt.end_time)}</span>
                                <span style={{background:`${statusColor(appt.appt_type==="in_person"?CS.green:appt.appt_type==="phone"?CS.blue:CS.purple)}20`,color:appt.appt_type==="in_person"?CS.green:appt.appt_type==="phone"?CS.blue:CS.purple,padding:"1px 7px",borderRadius:99,fontSize:10,fontWeight:700,textTransform:"uppercase"}}>{typeLabel(appt.appt_type)}</span>
                                <span style={{background:`${statusColor(appt.status)}20`,color:statusColor(appt.status),padding:"1px 7px",borderRadius:99,fontSize:10,fontWeight:700,textTransform:"uppercase"}}>{appt.status}</span>
                                {appt.visit_color&&VISIT_COLORS[appt.visit_color]&&<span style={{background:`${VISIT_COLORS[appt.visit_color].color}20`,color:VISIT_COLORS[appt.visit_color].color,padding:"1px 7px",borderRadius:99,fontSize:10,fontWeight:700}}>{VISIT_COLORS[appt.visit_color].label}</span>}
                                {appt.notes&&<span>· {appt.notes.substring(0,40)}{appt.notes.length>40?"…":""}</span>}
                              </div>
                            </div>
                            <div style={{display:"flex",gap:6,flexShrink:0}}>
                              {appt.status==="pending"&&<>
                                <button onClick={e=>{e.stopPropagation();quickStatus(appt.id,"confirmed");}} style={{background:"#22c55e20",border:`1px solid ${CS.green}`,color:CS.green,borderRadius:6,padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✓</button>
                                <button onClick={e=>{e.stopPropagation();quickStatus(appt.id,"declined");}} style={{background:"#ef444420",border:`1px solid ${CS.red}`,color:CS.red,borderRadius:6,padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✗</button>
                              </>}
                              <button onClick={e=>{e.stopPropagation();openEdit(appt.id);}} style={{background:"none",border:`1px solid ${CS.border}`,color:CS.muted,borderRadius:6,padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Edit</button>
                            </div>
                          </div>
                          {/* ── Schedule Comment (inline editable) ── */}
                          <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                            {editingComment===appt.id?(
                              <div style={{display:"flex",flex:1,gap:6,alignItems:"center"}}>
                                <input autoFocus value={commentDraft} onChange={e=>setCommentDraft(e.target.value)}
                                  onKeyDown={e=>{if(e.key==="Enter"){updateVisitField(appt.id,"schedule_comment",commentDraft);setEditingComment(null);}if(e.key==="Escape")setEditingComment(null);}}
                                  style={{flex:1,background:"var(--bg-input)",border:`1px solid ${CS.accent}`,borderRadius:5,padding:"4px 8px",color:"var(--text-primary)",fontSize:11,fontFamily:"inherit",outline:"none"}}
                                  placeholder="Add comment for staff…"
                                />
                                <button onClick={()=>{updateVisitField(appt.id,"schedule_comment",commentDraft);setEditingComment(null);}}
                                  style={{background:CS.accent,border:"none",color:"#fff",borderRadius:5,padding:"3px 8px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Save</button>
                                <button onClick={()=>setEditingComment(null)}
                                  style={{background:"none",border:`1px solid ${CS.border}`,color:CS.muted,borderRadius:5,padding:"3px 6px",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
                              </div>
                            ):(
                              <div onClick={()=>{setEditingComment(appt.id);setCommentDraft(appt.schedule_comment||"");}}
                                style={{flex:1,fontSize:11,color:appt.schedule_comment?CS.amber:CS.muted,fontStyle:appt.schedule_comment?"normal":"italic",cursor:"pointer",padding:"2px 4px",borderRadius:4,minHeight:18,display:"flex",alignItems:"center",gap:4}}
                                onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background="#f7931a10"}
                                onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background="transparent"}
                              >
                                <span style={{fontSize:10}}>{appt.schedule_comment?"💬":"＋"}</span>
                                {appt.schedule_comment||"Add comment…"}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ):slot?(
                      <div onClick={()=>openNew(selStr,time)} style={{cursor:"pointer",minHeight:48,padding:"4px 8px",borderRadius:6,position:"relative"}}
                        onMouseEnter={e=>{ (e.currentTarget as HTMLElement).style.background="#f7931a08"; (e.currentTarget.querySelector(".slot-hint") as HTMLElement).style.display="block"; }}
                        onMouseLeave={e=>{ (e.currentTarget as HTMLElement).style.background="transparent"; (e.currentTarget.querySelector(".slot-hint") as HTMLElement).style.display="none"; }}
                      >
                        <span className="slot-hint" style={{display:"none",fontSize:11,color:CS.accent,fontWeight:600}}>+ Book this slot</span>
                      </div>
                    ):null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Availability Manager ── */}
      {view==="availability"&&(
        <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
          <h2 style={{fontSize:16,fontWeight:800,marginBottom:4}}>Manage Availability</h2>
          <p style={{color:CS.muted,fontSize:12,marginBottom:20}}>Toggle time slots to open or close them for patient self-booking. Changes apply every week.</p>
          {CAL_DAYS_FULL.slice(1,6).map((day,idx)=>{
            const dayTemplates=templates.filter(t=>t.day_of_week===idx);
            const activeSlots=new Set(dayTemplates.map(t=>t.start_time));
            const changes=pendingChanges[idx]||{};
            const isOpen=openDays.has(idx);
            return(
              <div key={day} style={{background:CS.surface,border:`1px solid ${CS.border}`,borderRadius:10,marginBottom:10,overflow:"hidden"}}>
                <div onClick={()=>setOpenDays(s=>{ const n=new Set(s); n.has(idx)?n.delete(idx):n.add(idx); return n; })}
                  style={{padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
                  <span style={{fontWeight:700,fontSize:13}}>{day}</span>
                  <span style={{color:CS.muted,fontSize:11}}>{dayTemplates.length} slots open {isOpen?"↑":"›"}</span>
                </div>
                {isOpen&&(
                  <div style={{padding:"0 16px 12px",display:"flex",flexWrap:"wrap" as const,gap:6}}>
                    {allSlots.map(t=>{
                      const active=(t in changes)?changes[t]:activeSlots.has(t);
                      return(
                        <div key={t} onClick={()=>setPendingChanges(p=>({...p,[idx]:{...p[idx],[t]:!active}}))}
                          style={{padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                            fontFamily:"monospace",
                            background:active?"#22c55e20":"var(--bg-hover)",
                            border:`1px solid ${active?CS.green:CS.border}`,
                            color:active?CS.green:CS.muted,
                          }}>{fmtT(t)}</div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div style={{display:"flex",gap:10,marginTop:16}}>
            <button onClick={saveAvailability} disabled={savingAvail} style={{background:CS.accent,border:"none",color:"#fff",borderRadius:7,padding:"8px 20px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",opacity:savingAvail?0.5:1}}>{savingAvail?"Saving…":"Save Changes"}</button>
            <button onClick={()=>{ setPendingChanges({}); setView("schedule"); }} style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"8px 20px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── New/Edit Appointment Modal ── */}
      {apptModal&&(
        <div onClick={()=>setApptModal(false)} style={{position:"fixed",inset:0,background:"var(--overlay)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:CS.surface,border:`1px solid ${CS.border}`,borderRadius:14,padding:"28px 32px",width:480,maxWidth:"95vw",maxHeight:"90vh",overflowY:"auto"}}>
            <h3 style={{fontSize:16,fontWeight:800,marginBottom:20,letterSpacing:"-0.01em"}}>{editingId?"Edit Appointment":"New Appointment"}</h3>
            <div style={{marginBottom:16}}>
              <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>Patient</label>
              <select value={apptForm.patient_npub} onChange={e=>{const p=patients.find(pt=>pt.npub===e.target.value);setApptForm(f=>({...f,patient_npub:e.target.value,patient_name:p?.name||f.patient_name}));}}
                style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none"}}>
                <option value="">— Select patient —</option>
                {patients.map(p=><option key={p.id} value={p.npub||""}>{p.name}</option>)}
              </select>
            </div>
            <div style={{marginBottom:16}}>
              <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>Patient Name</label>
              <input value={apptForm.patient_name} onChange={e=>setApptForm(f=>({...f,patient_name:e.target.value}))} style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none"}} placeholder="Name"/>
              {!editingId&&apptForm.patient_name&&!apptForm.patient_npub&&(
                <div style={{marginTop:6,padding:"6px 10px",background:"#f59e0b10",border:"1px solid #f59e0b30",borderRadius:6,fontSize:11,color:CS.amber,display:"flex",alignItems:"center",gap:6}}>
                  ⚠️ No patient record selected — create a patient first so the appointment links to their chart.
                </div>
              )}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
              <div>
                <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>Date</label>
                <input type="date" value={apptForm.date} onChange={e=>setApptForm(f=>({...f,date:e.target.value}))} style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>Type</label>
                <select value={apptForm.appt_type} onChange={e=>setApptForm(f=>({...f,appt_type:e.target.value}))} style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none"}}>
                  <option value="in_person">In Person</option>
                  <option value="phone">Phone</option>
                  <option value="video">Video</option>
                </select>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
              <div>
                <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>Start Time</label>
                <input type="time" value={apptForm.start_time} step={900} onChange={e=>setApptForm(f=>({...f,start_time:e.target.value}))} style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>End Time</label>
                <input type="time" value={apptForm.end_time} step={900} onChange={e=>setApptForm(f=>({...f,end_time:e.target.value}))} style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
              </div>
            </div>
            {apptForm.appt_type==="video"&&(
              <div style={{marginBottom:16}}>
                <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>Video Link</label>
                <input type="url" value={apptForm.video_url} onChange={e=>setApptForm(f=>({...f,video_url:e.target.value}))} placeholder="https://..." style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
              </div>
            )}
            <div style={{marginBottom:24}}>
              <label style={{display:"block",fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:6}}>Notes</label>
              <textarea value={apptForm.notes} onChange={e=>setApptForm(f=>({...f,notes:e.target.value}))} rows={3} style={{width:"100%",background:"var(--bg-hover)",border:`1px solid ${CS.border}`,borderRadius:8,padding:"9px 12px",color:CS.text,fontSize:13,fontFamily:"inherit",outline:"none",resize:"vertical"}} placeholder="Chief complaint, visit reason..."/>
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",borderTop:`1px solid ${CS.border}`,paddingTop:16}}>
              <button onClick={()=>setApptModal(false)} style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"7px 16px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={saveAppt} disabled={saving||!apptForm.patient_name||!apptForm.date} style={{background:CS.accent,border:"none",color:"#fff",borderRadius:7,padding:"7px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",opacity:saving||!apptForm.patient_name?0.5:1}}>{saving?"Saving…":editingId?"Save Changes":"Save Appointment"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail Modal ── */}
      {detailModal&&(
        <div onClick={()=>setDetailModal(null)} style={{position:"fixed",inset:0,background:"var(--overlay)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:CS.surface,border:`1px solid ${CS.border}`,borderRadius:14,padding:"28px 32px",width:480,maxWidth:"95vw",maxHeight:"90vh",overflowY:"auto"}}>
            <h3 style={{fontSize:16,fontWeight:800,marginBottom:20}}>{detailModal.patient_name}</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
              {[["Date",fmtD(detailModal.date)],["Time",`${fmtT(detailModal.start_time)} – ${fmtT(detailModal.end_time)}`],["Type",typeLabel(detailModal.appt_type)],["Status",detailModal.status]].map(([label,val])=>(
                <div key={label}>
                  <div style={{fontSize:11,color:CS.muted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4}}>{label}</div>
                  <div style={{fontWeight:600}}>{val}</div>
                </div>
              ))}
            </div>
            {detailModal.notes&&<div style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,borderRadius:8,padding:"12px 14px",fontSize:13,lineHeight:1.6,marginBottom:12}}>{detailModal.notes}</div>}
            {detailModal.visit_color&&VISIT_COLORS[detailModal.visit_color]&&(
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <span style={{width:10,height:10,borderRadius:3,background:VISIT_COLORS[detailModal.visit_color].color,border:VISIT_COLORS[detailModal.visit_color].color==="#e8edf5"?`1px solid ${CS.border}`:"none"}}/>
                <span style={{fontSize:12,fontWeight:600,color:VISIT_COLORS[detailModal.visit_color].color}}>{VISIT_COLORS[detailModal.visit_color].label}</span>
              </div>
            )}
            {detailModal.schedule_comment&&(
              <div style={{background:"#f59e0b10",border:"1px solid #f59e0b30",borderRadius:8,padding:"10px 14px",fontSize:12,color:CS.amber,marginBottom:12,display:"flex",alignItems:"flex-start",gap:6}}>
                <span style={{flexShrink:0}}>💬</span>
                <span>{detailModal.schedule_comment}</span>
              </div>
            )}
            {detailModal.appt_type==="video"&&detailModal.patient_npub&&onStartVideo&&(
              <button onClick={()=>{
                try{
                  const pkHex = detailModal.patient_npub.startsWith("npub") 
                    ? npubToHex(detailModal.patient_npub)
                    : detailModal.patient_npub;
                  onStartVideo(detailModal.id, detailModal.patient_name, pkHex);
                  setDetailModal(null);
                }catch(e){ alert("Cannot start video: invalid patient key"); }
              }} style={{
                width:"100%",padding:"12px",borderRadius:8,
                background:"var(--tint-green)",color:"var(--accent-green-text)",fontSize:14,fontWeight:700,
                border:"1px solid var(--accent-green)",
                cursor:"pointer",fontFamily:"inherit",marginBottom:12,
                display:"flex",alignItems:"center",justifyContent:"center",gap:8,
              }}>
                📹 Start Video Visit
              </button>
            )}
            {detailModal.patient_npub&&onOpenChart&&(
              <button onClick={()=>{onOpenChart(detailModal.patient_npub);setDetailModal(null);}} style={{
                width:"100%",padding:"10px",borderRadius:8,border:`1px solid ${CS.blue}40`,
                background:`${CS.blue}10`,color:CS.blue,fontSize:13,fontWeight:700,
                cursor:"pointer",fontFamily:"inherit",marginBottom:12,
                display:"flex",alignItems:"center",justifyContent:"center",gap:8,
              }}>
                📋 Open Chart
              </button>
            )}
            {detailModal.patient_phone&&<div style={{fontSize:12,color:CS.muted,marginBottom:12}}>Phone: {detailModal.patient_phone}</div>}
            <div style={{display:"flex",gap:8,flexWrap:"wrap" as const,borderTop:`1px solid ${CS.border}`,paddingTop:16}}>
              {detailModal.status==="pending"&&<>
                <button onClick={()=>quickStatus(detailModal.id,"confirmed").then(()=>setDetailModal(null))} style={{background:"#22c55e20",border:`1px solid ${CS.green}`,color:CS.green,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✓ Confirm</button>
                <button onClick={()=>quickStatus(detailModal.id,"declined").then(()=>setDetailModal(null))} style={{background:"#ef444420",border:`1px solid ${CS.red}`,color:CS.red,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✗ Decline</button>
              </>}
              {detailModal.status==="confirmed"&&<button onClick={()=>quickStatus(detailModal.id,"cancelled").then(()=>setDetailModal(null))} style={{background:"#ef444420",border:`1px solid ${CS.red}`,color:CS.red,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cancel Appointment</button>}
              <button onClick={()=>openEdit(detailModal.id)} style={{background:CS.surfaceHi,border:`1px solid ${CS.border}`,color:CS.text,borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✏ Edit</button>
              <button onClick={()=>setDetailModal(null)} style={{background:"none",border:`1px solid transparent`,color:CS.muted,borderRadius:7,padding:"6px 14px",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Vitals History ───────────────────────────────────────────────────────────
function VitalsHistory({patient,keys,relay}:{patient:Patient;keys:Keypair|null;relay:ReturnType<typeof useRelay>}){
  const [adding,setAdding]=useState(false);
  const [saving,setSaving]=useState(false);
  const [status,setStatus]=useState<"idle"|"saved"|"error">("idle");
  const [records,setRecords]=useState<any[]>([]);
  const [form,setForm]=useState({
    bp_systolic:"",bp_diastolic:"",temp:"",tempUnit:"F" as "F"|"C",
    hr:"",rr:"",spo2:"",vision_od:"",vision_os:"",hearing_r:"",hearing_l:""
  });
  const set=(k:string,v:string)=>setForm(f=>({...f,[k]:v}));

  const load=useCallback(async()=>{
    if(!keys)return;
    return cachedLoad({
      kinds:[FHIR_KINDS.Observation],
      patientId:patient.id,
      keys,relay,
      processDecrypted:(items)=>{
        const byDate:Record<string,any>={};
        for(const item of items){
          const date=item.fhir.effectiveDateTime?.split("T")[0]||"unknown";
          if(!byDate[date])byDate[date]={date,items:[],created_at:item.created_at,authors:new Set<string>()};
          const authorTag=item.tags?.find((t:string[])=>t[0]==="authored-by");
          // Carry per-item author for tooltip; aggregate unique names for date header
          item.fhir._authorName=authorTag?.[2]||null;
          byDate[date].items.push(item.fhir);
          if(authorTag?.[2]) byDate[date].authors.add(authorTag[2]);
        }
        setRecords(Object.values(byDate).map((r:any)=>({...r,authors:[...r.authors]})).sort((a:any,b:any)=>b.created_at-a.created_at));
      },
      timeout:2000,
    });
  },[keys,relay,patient.id]);

  useEffect(()=>{setRecords([]);},[patient.id]);
  useEffect(()=>{let c:()=>void=()=>{};const p=load();p.then(fn=>{if(fn)c=fn;});return()=>{c();p.then(fn=>{if(fn)fn();})};},[load]);

  const save=async()=>{
    if(!keys||!patient.npub)return;
    setSaving(true);
    const now=new Date().toISOString();
    let saved=0;

    const publishVital=async(obs:any,obsTag:string)=>{
      if(await publishClinicalEvent({kind:FHIR_KINDS.Observation,plaintext:JSON.stringify(obs),
        patientId:patient.id,patientPkHex:npubToHex(patient.npub!),fhirType:"Observation",
        keys,relay,extraTags:[["obs","vitals"],["obs-type",obsTag]]})) saved++;
    };

    const {bp_systolic,bp_diastolic,temp,tempUnit,hr,rr,spo2,vision_od,vision_os,hearing_r,hearing_l}=form;

    if(bp_systolic&&bp_diastolic){
      await publishVital({resourceType:"Observation",id:crypto.randomUUID(),status:"final",
        code:{coding:[{system:"http://loinc.org",code:"55284-4",display:"Blood Pressure"}]},
        subject:{reference:`Patient/${patient.id}`},effectiveDateTime:now,
        component:[
          {code:{coding:[{code:"8480-6",display:"Systolic"}]},valueQuantity:{value:parseInt(bp_systolic),unit:"mmHg"}},
          {code:{coding:[{code:"8462-4",display:"Diastolic"}]},valueQuantity:{value:parseInt(bp_diastolic),unit:"mmHg"}}
        ]
      },"bp");
    }
    if(temp){
      const celsius=tempUnit==="F"?(parseFloat(temp)-32)*5/9:parseFloat(temp);
      await publishVital({resourceType:"Observation",id:crypto.randomUUID(),status:"final",
        code:{coding:[{system:"http://loinc.org",code:"8310-5",display:"Body Temperature"}]},
        subject:{reference:`Patient/${patient.id}`},effectiveDateTime:now,
        valueQuantity:{value:Math.round(celsius*10)/10,unit:"°C"},
        _display:{original:temp,originalUnit:tempUnit}
      },"temp");
    }
    if(hr){
      await publishVital({resourceType:"Observation",id:crypto.randomUUID(),status:"final",
        code:{coding:[{system:"http://loinc.org",code:"8867-4",display:"Heart Rate"}]},
        subject:{reference:`Patient/${patient.id}`},effectiveDateTime:now,
        valueQuantity:{value:parseInt(hr),unit:"bpm"}
      },"hr");
    }
    if(rr){
      await publishVital({resourceType:"Observation",id:crypto.randomUUID(),status:"final",
        code:{coding:[{system:"http://loinc.org",code:"9279-1",display:"Respiratory Rate"}]},
        subject:{reference:`Patient/${patient.id}`},effectiveDateTime:now,
        valueQuantity:{value:parseInt(rr),unit:"breaths/min"}
      },"rr");
    }
    if(spo2){
      await publishVital({resourceType:"Observation",id:crypto.randomUUID(),status:"final",
        code:{coding:[{system:"http://loinc.org",code:"59408-5",display:"Oxygen Saturation"}]},
        subject:{reference:`Patient/${patient.id}`},effectiveDateTime:now,
        valueQuantity:{value:parseFloat(spo2),unit:"%"}
      },"spo2");
    }
    if(vision_od||vision_os){
      await publishVital({resourceType:"Observation",id:crypto.randomUUID(),status:"final",
        code:{coding:[{system:"http://loinc.org",code:"79880-1",display:"Visual Acuity"}]},
        subject:{reference:`Patient/${patient.id}`},effectiveDateTime:now,
        component:[
          ...(vision_od?[{code:{coding:[{display:"OD (Right)"}]},valueString:vision_od}]:[]),
          ...(vision_os?[{code:{coding:[{display:"OS (Left)"}]},valueString:vision_os}]:[])
        ]
      },"vision");
    }
    if(hearing_r||hearing_l){
      await publishVital({resourceType:"Observation",id:crypto.randomUUID(),status:"final",
        code:{coding:[{system:"http://loinc.org",code:"32437-6",display:"Hearing Screening"}]},
        subject:{reference:`Patient/${patient.id}`},effectiveDateTime:now,
        component:[
          ...(hearing_r?[{code:{coding:[{display:"Right Ear"}]},valueString:hearing_r}]:[]),
          ...(hearing_l?[{code:{coding:[{display:"Left Ear"}]},valueString:hearing_l}]:[])
        ]
      },"hearing");
    }

    setSaving(false);
    if(saved>0){
      setStatus("saved");
      setForm({bp_systolic:"",bp_diastolic:"",temp:"",tempUnit:"F",hr:"",rr:"",spo2:"",vision_od:"",vision_os:"",hearing_r:"",hearing_l:""});
      setAdding(false);
      setTimeout(()=>{setStatus("idle");load();},1500);
    } else {
      setStatus("error");
      setTimeout(()=>setStatus("idle"),3000);
    }
  };

  // Helper to extract a value from a vitals record
  const getVal=(items:any[],obsType:string)=>{
    const item=items.find((i:any)=>i.code?.coding?.[0]?.display?.toLowerCase().includes(
      obsType==="bp"?"blood pressure":obsType==="temp"?"temperature":
      obsType==="hr"?"heart":obsType==="rr"?"respiratory":
      obsType==="spo2"?"oxygen":obsType==="vision"?"visual":"hearing"
    ));
    if(!item)return null;
    if(item.component){
      if(obsType==="bp"){
        const sys=item.component.find((c:any)=>c.code?.coding?.[0]?.display==="Systolic");
        const dia=item.component.find((c:any)=>c.code?.coding?.[0]?.display==="Diastolic");
        return sys&&dia?`${sys.valueQuantity.value}/${dia.valueQuantity.value}`:null;
      }
      if(obsType==="vision"){
        const od=item.component.find((c:any)=>c.code?.coding?.[0]?.display==="OD (Right)");
        const os=item.component.find((c:any)=>c.code?.coding?.[0]?.display==="OS (Left)");
        return[od?`OD: ${od.valueString}`:"",os?`OS: ${os.valueString}`:""].filter(Boolean).join(" / ");
      }
      if(obsType==="hearing"){
        const r=item.component.find((c:any)=>c.code?.coding?.[0]?.display==="Right Ear");
        const l=item.component.find((c:any)=>c.code?.coding?.[0]?.display==="Left Ear");
        return[r?`R: ${r.valueString}`:"",l?`L: ${l.valueString}`:""].filter(Boolean).join(" / ");
      }
    }
    if(item.valueQuantity){
      const v=item.valueQuantity;
      if(obsType==="temp"){
        const f=Math.round((v.value*9/5+32)*10)/10;
        return`${f}°F (${v.value}°C)`;
      }
      return`${v.value} ${v.unit}`;
    }
    return null;
  };

  const vitalDefs=[
    {key:"bp",label:"BP",icon:"❤️",unit:"mmHg",col:"#f87171"},
    {key:"temp",label:"Temp",icon:"🌡️",unit:"",col:"#fb923c"},
    {key:"hr",label:"HR",icon:"💓",unit:"bpm",col:"#f472b6"},
    {key:"rr",label:"RR",icon:"🫁",unit:"breaths/min",col:"#60a5fa"},
    {key:"spo2",label:"SpO₂",icon:"🩸",unit:"%",col:"#34d399"},
    {key:"vision",label:"Vision",icon:"👁️",unit:"",col:"#a78bfa"},
    {key:"hearing",label:"Hearing",icon:"👂",unit:"",col:"#fbbf24"},
  ];

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
      <div style={{fontWeight:700,fontSize:14}}>🩺 Vitals</div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {status==="saved"&&<Badge t="✓ Saved" col="var(--accent-green)" bg="var(--tint-green)"/>}
        {status==="error"&&<Badge t="✗ Error" col="#f87171" bg="var(--tint-red)"/>}
        <Btn small solid={!adding} col="#0ea5e9" onClick={()=>setAdding(!adding)}>{adding?"Cancel":"+ Record Vitals"}</Btn>
      </div>
    </div>

    {adding&&<div style={{...S.card,background:"var(--bg-deep)",border:"1px solid var(--border-accent)",marginBottom:16}}>
      <div style={{fontWeight:600,fontSize:12,marginBottom:12,color:"#7dd3fc"}}>📊 New Vitals Entry</div>
      
      {/* Row 1: BP + Temp + HR + RR */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 20px 1fr 80px 1fr 1fr",gap:6,alignItems:"end",marginBottom:10}}>
        <div>
          <label style={S.lbl}>Systolic BP</label>
          <input value={form.bp_systolic} onChange={e=>set("bp_systolic",e.target.value)}
            type="number" placeholder="120" style={{...S.input,fontSize:12}}/>
        </div>
        <div style={{textAlign:"center",paddingBottom:8,color:"var(--text-label)",fontSize:14}}>/</div>
        <div>
          <label style={S.lbl}>Diastolic BP</label>
          <input value={form.bp_diastolic} onChange={e=>set("bp_diastolic",e.target.value)}
            type="number" placeholder="80" style={{...S.input,fontSize:12}}/>
        </div>
        <div>
          <label style={{...S.lbl,opacity:0}}>_</label>
          <Badge t="mmHg" col="#f87171" bg="var(--tint-red)"/>
        </div>
        <div>
          <label style={S.lbl}>Temp</label>
          <input value={form.temp} onChange={e=>set("temp",e.target.value)}
            type="number" step="0.1" placeholder="98.6" style={{...S.input,fontSize:12}}/>
        </div>
        <div>
          <label style={{...S.lbl,opacity:0}}>_</label>
          <select value={form.tempUnit} onChange={e=>set("tempUnit",e.target.value)}
            style={{...S.input,cursor:"pointer",fontSize:11}}>
            <option value="F">°F</option>
            <option value="C">°C</option>
          </select>
        </div>
      </div>

      {/* Row 2: HR + RR + SpO2 */}
      <div style={{...S.grid3,marginBottom:10}}>
        <div>
          <label style={S.lbl}>Heart Rate (bpm)</label>
          <input value={form.hr} onChange={e=>set("hr",e.target.value)}
            type="number" placeholder="72" style={{...S.input,fontSize:12}}/>
        </div>
        <div>
          <label style={S.lbl}>Resp Rate (breaths/min)</label>
          <input value={form.rr} onChange={e=>set("rr",e.target.value)}
            type="number" placeholder="16" style={{...S.input,fontSize:12}}/>
        </div>
        <div>
          <label style={S.lbl}>SpO₂ (%)</label>
          <input value={form.spo2} onChange={e=>set("spo2",e.target.value)}
            type="number" step="0.1" placeholder="98" style={{...S.input,fontSize:12}}/>
        </div>
      </div>

      {/* Row 3: Vision */}
      <div style={{...S.grid2,marginBottom:10}}>
        <div>
          <label style={S.lbl}>Vision OD / Right Eye</label>
          <input value={form.vision_od} onChange={e=>set("vision_od",e.target.value)}
            placeholder="20/20" style={{...S.input,fontSize:12}}/>
        </div>
        <div>
          <label style={S.lbl}>Vision OS / Left Eye</label>
          <input value={form.vision_os} onChange={e=>set("vision_os",e.target.value)}
            placeholder="20/20" style={{...S.input,fontSize:12}}/>
        </div>
      </div>

      {/* Row 4: Hearing */}
      <div style={{...S.grid2,marginBottom:12}}>
        <div>
          <label style={S.lbl}>Hearing Right Ear</label>
          <input value={form.hearing_r} onChange={e=>set("hearing_r",e.target.value)}
            placeholder="Pass / Refer / dB" style={{...S.input,fontSize:12}}/>
        </div>
        <div>
          <label style={S.lbl}>Hearing Left Ear</label>
          <input value={form.hearing_l} onChange={e=>set("hearing_l",e.target.value)}
            placeholder="Pass / Refer / dB" style={{...S.input,fontSize:12}}/>
        </div>
      </div>

      <Btn solid col="#0ea5e9" disabled={saving} onClick={save}>
        {saving?"⏳ Saving…":"💾 Save Vitals"}
      </Btn>
    </div>}

    {records.length===0&&!adding&&<div style={{...S.card,color:"var(--text-faint)",textAlign:"center",padding:32}}>
      No vitals recorded
    </div>}

    {records.map((rec:any,i:number)=>(
      <div key={i} style={{...S.card,marginBottom:10}}>
        <div style={{fontSize:11,color:"var(--text-label)",marginBottom:10,fontWeight:600,display:"flex",justifyContent:"space-between"}}>
          <span>{new Date(rec.date).toLocaleDateString('en-US',{weekday:'short',year:'numeric',month:'short',day:'numeric'})}</span>
          {rec.authors?.length>0&&rec.items.every((it:any)=>it._authorName)&&<span style={{fontSize:10,color:"var(--text-muted)",fontWeight:400,fontStyle:"italic"}}>
            by {rec.authors.join(", ")}
          </span>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
          {vitalDefs.map(({key,label,icon,col})=>{
            const val=getVal(rec.items,key);
            if(!val)return null;
            return(
              <div key={key} style={{background:"var(--bg-app)",borderRadius:8,padding:"8px 10px",borderLeft:`3px solid ${col}`}}>
                <div style={{fontSize:9,color:"var(--text-muted)",marginBottom:2}}>{icon} {label}</div>
                <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{val}</div>
              </div>
            );
          })}
        </div>
      </div>
    ))}
  </div>);
}

// ─── Inbox Sidebar ────────────────────────────────────────────────────────────
// localStorage keys:
//   nostr_ehr_msg_read   : JSON string[]  — event IDs that have been read (clicked)
//   nostr_ehr_msg_done   : JSON {id,ts}[] — event IDs marked done, with timestamp

function useInboxState(){
  const [read,setRead]=useState<Set<string>>(()=>{
    try{ return new Set(JSON.parse(localStorage.getItem("nostr_ehr_msg_read")||"[]")); }catch{ return new Set(); }
  });
  const [done,setDone]=useState<{id:string;ts:number}[]>(()=>{
    try{ return JSON.parse(localStorage.getItem("nostr_ehr_msg_done")||"[]"); }catch{ return []; }
  });
  const [starred,setStarred]=useState<Set<string>>(()=>{
    try{ return new Set(JSON.parse(localStorage.getItem("nostr_ehr_msg_starred")||"[]")); }catch{ return new Set(); }
  });
  const [notes,setNotes]=useState<Record<string,string>>(()=>{
    try{ return JSON.parse(localStorage.getItem("nostr_ehr_msg_notes")||"{}"); }catch{ return {}; }
  });

  const markRead=(id:string)=>{
    setRead(s=>{ const n=new Set(s); n.add(id); localStorage.setItem("nostr_ehr_msg_read",JSON.stringify([...n])); return n; });
  };
  const markUnread=(id:string)=>{
    setRead(s=>{ const n=new Set(s); n.delete(id); localStorage.setItem("nostr_ehr_msg_read",JSON.stringify([...n])); return n; });
  };
  const markDone=(id:string)=>{
    setDone(prev=>{
      const next=[...prev.filter(d=>d.id!==id),{id,ts:Date.now()}];
      localStorage.setItem("nostr_ehr_msg_done",JSON.stringify(next));
      return next;
    });
    markRead(id);
  };
  const undoDone=(id:string)=>{
    setDone(prev=>{
      const next=prev.filter(d=>d.id!==id);
      localStorage.setItem("nostr_ehr_msg_done",JSON.stringify(next));
      return next;
    });
  };
  const toggleStar=(id:string)=>{
    setStarred(s=>{
      const n=new Set(s);
      if(n.has(id)) n.delete(id); else n.add(id);
      localStorage.setItem("nostr_ehr_msg_starred",JSON.stringify([...n]));
      return n;
    });
  };
  const setNote=(id:string,text:string)=>{
    setNotes(prev=>{
      const next={...prev};
      if(text.trim()) next[id]=text.trim(); else delete next[id];
      localStorage.setItem("nostr_ehr_msg_notes",JSON.stringify(next));
      return next;
    });
  };

  // Done items are permanent — threads marked done never reappear in the inbox.
  // "Recent done" shows items done in the last 48h for undo purposes.
  const RECENT_WINDOW=48*60*60*1000;
  const doneIds=new Set(done.map(d=>d.id));
  const recentDone=done.filter(d=>d.ts>Date.now()-RECENT_WINDOW);
  return{read,done:doneIds,doneEntries:done,recentDone,starred,notes,markRead,markUnread,markDone,undoDone,toggleStar,setNote};
}

function InboxView({keys,relay,patients,onOpenPatientMessages,onUnreadChange}:{
  keys:Keypair|null;
  relay:ReturnType<typeof useRelay>;
  patients:Patient[];
  onOpenPatientMessages:(patientId:string, rootId:string)=>void;
  onUnreadChange?:(count:number)=>void;
}){
  const [msgs,setMsgs]=useState<{id:string;patientId:string;patientName:string;subject:string;preview:string;ts:number;rootId?:string}[]>([]);
  const [ctxMenu,setCtxMenu]=useState<{x:number;y:number;msgId:string;patientId:string;noReply:boolean}|null>(null);
  const [showRecent,setShowRecent]=useState(false);
  const {read,done,doneEntries,recentDone,starred,notes,markRead,markUnread,markDone,undoDone,toggleStar,setNote}=useInboxState();
  const [editingNote,setEditingNote]=useState<string|null>(null);
  const [noteText,setNoteText]=useState("");

  // Subscribe to ALL messages (both directions) so we can build complete threads
  const buildThreads=(items:{eventId:string;pubkey:string;created_at:number;tags:string[][];text:string}[])=>{
    const threadMap:Record<string,{
      patientId:string;patientName:string;subject:string;
      msgs:{id:string;ts:number;fromPractice:boolean;preview:string}[];
    }>={};
    const ss=_activeStaffSession;
    const practicePk=ss?.practicePkHex||keys!.pkHex;
    for(const item of items){
      const fromPractice=item.pubkey===practicePk;
      const eTag=item.tags.find((t:string[])=>t[0]==="e")?.[1];
      const rootId=eTag||item.eventId;
      const subject=item.tags.find((t:string[])=>t[0]==="subject")?.[1]||"(no subject)";
      const preview=item.text.length>80?item.text.slice(0,80)+"…":item.text;
      const patientHex=fromPractice
        ?item.tags.find((t:string[])=>t[0]==="p"&&t[1]!==practicePk)?.[1]
        :item.pubkey;
      const patient=patientHex?patients.find(p=>p.npub&&npubToHex(p.npub)===patientHex):null;
      const patientName=patient?.name||"Unknown Patient";
      const patientId=patient?.id||patientHex||"unknown";
      if(!threadMap[rootId]){
        threadMap[rootId]={patientId,patientName,subject,msgs:[]};
      } else {
        if(patient){ threadMap[rootId].patientId=patientId; threadMap[rootId].patientName=patientName; }
        if(!eTag) threadMap[rootId].subject=subject;
      }
      const noReply=item.tags?.some((t:string[])=>t[0]==="no-reply"&&t[1]==="true")||false;
      threadMap[rootId].msgs.push({id:item.eventId,ts:item.created_at,fromPractice,preview,noReply});
    }
    const threads=Object.entries(threadMap).map(([rootId,t])=>{
      const sorted=[...t.msgs].sort((a,b)=>a.ts-b.ts);
      const latest=sorted[sorted.length-1];
      const hasUnread=!latest.fromPractice;
      const noReply=sorted.some((m:any)=>m.noReply);
      return{id:rootId,rootId,patientId:t.patientId,patientName:t.patientName,
        subject:t.subject,preview:latest.preview,ts:latest.ts,hasUnread,noReply,msgCount:sorted.length};
    });
    threads.sort((a,b)=>b.ts-a.ts);
    return threads;
  };

  useEffect(()=>{
    if(!keys)return;
    const ss=_activeStaffSession;
    const queryPk=ss?.practicePkHex||keys.pkHex;
    const sharedX=ss?.practiceSharedSecret||getSharedSecret(keys.sk,keys.pkHex);

    // Shared accumulator — keyed by eventId, persists across polls
    const itemMap=new Map<string,{eventId:string;pubkey:string;created_at:number;tags:string[][];text:string}>();
    let latestTs=0; // track newest event timestamp for since-based polling
    let pollTimer:ReturnType<typeof setTimeout>|null=null;
    let destroyed=false;

    const processEvent=async(ev:NostrEvent)=>{
      if(itemMap.has(ev.id))return;
      try{
        const fromPractice=ev.pubkey===queryPk;
        let plain:string|null=null;
        if(fromPractice){
          try{ plain=await nip44Decrypt(ev.content,sharedX); }catch{}
        } else {
          const ptTag=ev.tags.find((t:string[])=>t[0]==="pt");
          const ptId=ptTag?.[1];
          const patientSecret=ptId&&ss?.patientSecrets?.get(ptId);
          if(patientSecret){
            try{ plain=await nip44Decrypt(ev.content,patientSecret); }catch{}
          } else {
            try{ plain=await nip44Decrypt(ev.content,getSharedSecret(keys.sk,ev.pubkey)); }catch{}
          }
          if(!plain) try{ plain=await nip44Decrypt(ev.content,sharedX); }catch{}
        }
        if(!plain)return;
        const patientHex=fromPractice
          ?ev.tags.find((t:string[])=>t[0]==="p"&&t[1]!==queryPk)?.[1]
          :ev.pubkey;
        const pt=patientHex?patients.find(p=>p.npub&&npubToHex(p.npub)===patientHex):null;
        const ptId2=pt?.id||patientHex||"unknown";
        cacheEvent(ev.id,ev.kind,ptId2,ev.pubkey,ev.created_at,plain,ev.tags).catch(()=>{});
        itemMap.set(ev.id,{eventId:ev.id,pubkey:ev.pubkey,created_at:ev.created_at,tags:ev.tags,text:plain});
        if(ev.created_at>latestTs) latestTs=ev.created_at;
        setMsgs(buildThreads([...itemMap.values()]));
      }catch{}
    };

    const doFetch=(since?:number)=>{
      if(destroyed||relay.status!=="connected")return;
      const filter:any={kinds:[FHIR_KINDS.Message],"#p":[queryPk],limit:500};
      if(since) filter.since=since;
      const subId=relay.subscribe(filter,(ev:NostrEvent)=>{ processEvent(ev); },()=>{
        relay.unsubscribe(subId);
        // Schedule next poll 30s after EOSE
        if(!destroyed) pollTimer=setTimeout(()=>doFetch(latestTs||undefined),30000);
      });
    };

    // Phase 1: cache
    getCachedEventsByKind(FHIR_KINDS.Message).then(cached=>{
      if(cached.length>0){
        for(const ce of cached){
          itemMap.set(ce.eventId,{eventId:ce.eventId,pubkey:ce.pubkey,created_at:ce.created_at,tags:ce.tags,text:ce.fhirJson});
          if(ce.created_at>latestTs) latestTs=ce.created_at;
        }
        setMsgs(buildThreads([...itemMap.values()]));
      }
    }).catch(()=>{});

    // Phase 2: initial full fetch, then poll
    if(relay.status==="connected") doFetch();

    return()=>{
      destroyed=true;
      if(pollTimer) clearTimeout(pollTimer);
    };
  },[keys,relay.status,relay.syncTrigger,patients]);

  // activeMsgs: filter out done threads UNLESS a new patient message arrived after it was done
  const doneMap=new Map(doneEntries.map(d=>[d.id,d]));
  const activeMsgs=msgs.filter(m=>{
    const d=doneMap.get(m.id);
    if(!d)return true; // not done
    // Resurface if thread timestamp is newer than when it was done (new reply came in)
    return m.ts > Math.floor(d.ts/1000);
  });
  const unreadCount=activeMsgs.filter(m=>!read.has(m.id)&&(m as any).hasUnread).length;

  // Notify parent of unread count changes (for nav badge)
  useEffect(()=>{ onUnreadChange?.(unreadCount); },[unreadCount]);

  const relT=(ts:number)=>{
    const diff=Math.floor(Date.now()/1000)-ts;
    if(diff<60)return"just now";
    if(diff<3600)return`${Math.floor(diff/60)}m`;
    if(diff<86400)return`${Math.floor(diff/3600)}h`;
    return new Date(ts*1000).toLocaleDateString("en-US",{month:"short",day:"numeric"});
  };

  const handleClick=(msg:typeof msgs[0])=>{
    markRead(msg.id);
    onOpenPatientMessages(msg.patientId, msg.rootId||"");
    setCtxMenu(null);
  };

  const handleCtx=(e:React.MouseEvent,msgId:string,patientId?:string,noReply?:boolean)=>{
    e.preventDefault();
    setCtxMenu({x:e.clientX,y:e.clientY,msgId,patientId:patientId||"",noReply:!!noReply});
  };

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",minHeight:"calc(100vh - 120px)"}}
      onClick={()=>setCtxMenu(null)}>

      {/* Inbox header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div>
          <div style={{fontSize:18,fontWeight:700,color:"var(--text-primary)",marginBottom:2}}>
            Inbox
            {unreadCount>0&&<span style={{
              background:"#ef4444",color:"#fff",borderRadius:99,
              padding:"2px 8px",fontSize:11,fontWeight:700,marginLeft:10,verticalAlign:"middle",
            }}>{unreadCount} new</span>}
          </div>
          <div style={{fontSize:12,color:"var(--text-label)"}}>
            {activeMsgs.length===0?"No active threads":`${activeMsgs.length} active thread${activeMsgs.length!==1?"s":""}`}
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {activeMsgs.filter(m=>read.has(m.id)&&!m.hasUnread&&!starred.has(m.id)).length>1&&(
            <button onClick={e=>{e.stopPropagation();
              const clearable=activeMsgs.filter(m=>read.has(m.id)&&!m.hasUnread&&!starred.has(m.id));
              if(confirm(`Done ${clearable.length} read+replied threads?`)) clearable.forEach(m=>markDone(m.id));
            }} style={{
              background:"var(--bg-card)",border:"1px solid var(--border)",color:"var(--text-muted)",
              borderRadius:7,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:"6px 14px",fontWeight:600,
            }} title="Mark done: threads that are read and where you spoke last (excludes starred and patient-waiting)">
              ✓ Done replied ({activeMsgs.filter(m=>read.has(m.id)&&!m.hasUnread&&!starred.has(m.id)).length})
            </button>
          )}
          {recentDone.length>0&&(
            <button onClick={e=>{e.stopPropagation();setShowRecent(v=>!v);}} style={{
              background:"var(--bg-card)",border:"1px solid var(--border)",color:showRecent?"var(--text-primary)":"var(--text-muted)",
              borderRadius:7,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:"6px 14px",fontWeight:600,
            }}>
              {showRecent?"Hide":"Recent done"} ({recentDone.length})
            </button>
          )}
        </div>
      </div>

      {/* Thread list */}
      <div style={{flex:1,overflowY:"auto",borderRadius:10,border:"1px solid var(--border-subtle)",background:"var(--bg-app)"}}>
        {activeMsgs.length===0&&!showRecent&&(
          <div style={{padding:"48px 24px",color:"var(--text-faint)",fontSize:13,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:12}}>📭</div>
            No active messages
          </div>
        )}
        {activeMsgs.map((msg,i)=>{
          const isRead=read.has(msg.id);
          const hasUnread=(msg as any).hasUnread&&!isRead;
          const isStarred=starred.has(msg.id);
          const isClosed=(msg as any).noReply;
          const hasNote=!!notes[msg.id];
          const msgCount=(msg as any).msgCount||1;
          const borderColor=isStarred?"#f59e0b":hasUnread?"#0ea5e9":"transparent";
          const bgColor=isStarred?"var(--bg-inset)":hasUnread?"var(--bg-inset)":"var(--bg-app)";
          return(
            <div key={msg.id}>
              <div
                onClick={()=>handleClick(msg)}
                onContextMenu={e=>handleCtx(e,msg.id,msg.patientId,(msg as any).noReply)}
                style={{
                  padding:"7px 16px",
                  borderBottom:i<activeMsgs.length-1?"1px solid var(--border-subtle)":"none",
                  cursor:"pointer",
                  background:bgColor,
                  borderLeft:`3px solid ${borderColor}`,
                  transition:"background 0.1s",
                  display:"flex",alignItems:"center",gap:12,
                }}
                onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background="var(--bg-hover)"}
                onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=bgColor}
              >
                {/* Star toggle */}
                <div onClick={e=>{e.stopPropagation();toggleStar(msg.id);}} style={{
                  flexShrink:0,cursor:"pointer",fontSize:14,width:20,textAlign:"center",
                  opacity:isStarred?1:0.25,transition:"opacity 0.15s",
                }} title={isStarred?"Unstar (remove pin)":"Star (pin as waiting)"}>
                  {isStarred?"⭐":"☆"}
                </div>

                {/* Avatar circle */}
                <div style={{
                  width:32,height:32,borderRadius:"50%",flexShrink:0,
                  background:isStarred?"linear-gradient(135deg,#f59e0b,#d97706)":hasUnread?"linear-gradient(135deg,#0ea5e9,#3b82f6)":"var(--bg-deep)",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:13,fontWeight:700,color:(hasUnread||isStarred)?"#fff":"var(--text-label)",
                }}>
                  {msg.patientName.charAt(0).toUpperCase()}
                </div>

                {/* Patient name — fixed width */}
                <div style={{width:120,flexShrink:0,
                  fontSize:13,fontWeight:hasUnread?700:400,
                  color:hasUnread?"var(--text-primary)":"var(--text-muted)",
                  overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>
                  {msg.patientName}
                </div>

                {/* Subject — fixed width */}
                <div style={{width:150,flexShrink:0,
                  fontSize:12,fontWeight:hasUnread?600:400,
                  color:hasUnread?"#0ea5e9":"var(--text-label)",
                  overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>
                  {isClosed&&<span title="Thread closed — no reply" style={{marginRight:4}}>🔒</span>}
                  {msg.subject}
                  {msgCount>1&&<span style={{fontSize:10,color:"var(--text-faint)",background:"var(--bg-deep)",borderRadius:99,padding:"1px 5px",marginLeft:5}}>{msgCount}</span>}
                </div>

                {/* Preview — takes remaining space */}
                <div style={{flex:1,minWidth:0,
                  fontSize:12,color:"var(--text-muted)",
                  overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>
                  {msg.preview}
                </div>

                {/* Staff note — between preview and timestamp */}
                {hasNote?(
                  <div style={{flexShrink:1,minWidth:0,maxWidth:250,
                    fontSize:10,color:"#f59e0b",cursor:"pointer",
                    overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}
                    onClick={e=>{e.stopPropagation();setEditingNote(msg.id);setNoteText(notes[msg.id]||"");}}>
                    📝 {notes[msg.id]}
                  </div>
                ):<div style={{flexShrink:0}}/>}

                {/* Indicators — far right */}
                <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                  <div style={{fontSize:11,color:hasUnread?"var(--text-label)":"var(--text-faint)",minWidth:36,textAlign:"right"}}>
                    {relT(msg.ts)}
                  </div>
                  {hasUnread&&(
                    <div style={{width:7,height:7,borderRadius:"50%",background:"#0ea5e9",flexShrink:0}}/>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Recent done section */}
        {showRecent&&recentDone.length>0&&(
          <div>
            <div style={{padding:"8px 20px",fontSize:10,color:"var(--text-faint)",textTransform:"uppercase",letterSpacing:"0.5px",borderTop:"1px solid var(--border-subtle)",background:"var(--bg-deep)"}}>
              Done · last 48h — right-click to restore
            </div>
            {recentDone.map(d=>{
              const msg=msgs.find(m=>m.id===d.id);
              if(!msg)return null;
              return(
                <div key={d.id}
                  style={{padding:"6px 16px",borderBottom:"1px solid #0a0f1a",opacity:0.45,cursor:"pointer",
                    display:"flex",alignItems:"center",gap:12}}
                  onContextMenu={e=>handleCtx(e,d.id,"",false)}>
                  <div style={{width:28,height:28,borderRadius:"50%",background:"var(--bg-deep)",
                    display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"var(--text-label)",fontWeight:700,flexShrink:0}}>
                    {msg.patientName.charAt(0).toUpperCase()}
                  </div>
                  <div style={{width:130,flexShrink:0,fontSize:12,color:"var(--text-muted)",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{msg.patientName}</div>
                  <div style={{flex:1,minWidth:0,fontSize:11,color:"var(--text-faint)",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{msg.subject}</div>
                  <div style={{fontSize:10,color:"var(--text-faint)",flexShrink:0}}>{relT(Math.floor(d.ts/1000))}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Note editor modal */}
      {editingNote&&(
        <div style={{position:"fixed",inset:0,background:"var(--overlay)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>{setNote(editingNote,noteText);setEditingNote(null);}}>
          <div style={{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:12,padding:20,width:400,maxWidth:"90vw"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:14,fontWeight:700,color:"var(--text-primary)",marginBottom:12}}>📝 Staff Note</div>
            <textarea value={noteText} onChange={e=>setNoteText(e.target.value)}
              placeholder="Internal note (only visible to staff)..."
              rows={3} autoFocus
              style={{width:"100%",boxSizing:"border-box" as const,background:"var(--bg-app)",border:"1px solid var(--border)",borderRadius:8,color:"var(--text-primary)",fontSize:13,padding:"10px 12px",resize:"vertical" as const,fontFamily:"inherit",lineHeight:1.5}}
            />
            <div style={{display:"flex",gap:8,marginTop:12,justifyContent:"flex-end"}}>
              {notes[editingNote]&&(
                <button onClick={()=>{setNote(editingNote,"");setNoteText("");setEditingNote(null);}} style={{
                  background:"none",border:"1px solid var(--border)",color:"#f87171",borderRadius:6,padding:"6px 14px",fontSize:12,cursor:"pointer",fontFamily:"inherit",
                }}>Delete note</button>
              )}
              <button onClick={()=>{setNote(editingNote,noteText);setEditingNote(null);}} style={{
                background:"#0ea5e9",border:"none",color:"#fff",borderRadius:6,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Context menu */}
      {ctxMenu&&(
        <div style={{
          position:"fixed",left:ctxMenu.x,top:ctxMenu.y,
          background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:8,
          zIndex:9999,boxShadow:"0 8px 32px var(--shadow-heavy)",overflow:"hidden",minWidth:180,
        }}
          onClick={e=>e.stopPropagation()}>
          {done.has(ctxMenu.msgId)?(
            <button onClick={()=>{undoDone(ctxMenu.msgId);setCtxMenu(null);}} style={{
              display:"block",width:"100%",padding:"10px 16px",background:"none",border:"none",
              color:"var(--text-primary)",fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",
            }}>↩ Restore to inbox</button>
          ):(
            <>
              {read.has(ctxMenu.msgId)?(
                <button onClick={()=>{markUnread(ctxMenu.msgId);setCtxMenu(null);}} style={{
                  display:"block",width:"100%",padding:"10px 16px",background:"none",border:"none",
                  color:"var(--text-primary)",fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",
                }}>● Mark as unread</button>
              ):(
                <button onClick={()=>{markRead(ctxMenu.msgId);setCtxMenu(null);}} style={{
                  display:"block",width:"100%",padding:"10px 16px",background:"none",border:"none",
                  color:"var(--text-primary)",fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",
                }}>○ Mark as read</button>
              )}
              <button onClick={()=>{toggleStar(ctxMenu.msgId);setCtxMenu(null);}} style={{
                display:"block",width:"100%",padding:"10px 16px",background:"none",border:"none",
                color:"#f59e0b",fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",
                borderTop:"1px solid var(--border)",
              }}>{starred.has(ctxMenu.msgId)?"☆ Unstar":"⭐ Star (waiting)"}</button>
              <button onClick={()=>{setEditingNote(ctxMenu.msgId);setNoteText(notes[ctxMenu.msgId]||"");setCtxMenu(null);}} style={{
                display:"block",width:"100%",padding:"10px 16px",background:"none",border:"none",
                color:"var(--text-primary)",fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",
              }}>{notes[ctxMenu.msgId]?"📝 Edit note":"📝 Add note"}</button>
              <button onClick={()=>{markDone(ctxMenu.msgId);setCtxMenu(null);}} style={{
                display:"block",width:"100%",padding:"10px 16px",background:"none",border:"none",
                color:"#f87171",fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",
                borderTop:"1px solid var(--border)",
              }}>✓ Done</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Patient List Sidebar ─────────────────────────────────────────────────────
function PatientListSidebar({patients,selected,onSelect,onAdd,onSettings,search,staffSession,dark,onToggleTheme}:{
  patients:Patient[];selected:Patient|null;onSelect:(p:Patient)=>void;onAdd:()=>void;onSettings:()=>void;search:string;
  staffSession?:StaffSession|null;dark?:boolean;onToggleTheme?:()=>void;
}){
  const roleColors:Record<string,string>={doctor:"#8b5cf6",nurse:"#0ea5e9",ma:"#22c55e",frontdesk:"#f59e0b"};

  return(
    <div style={{width:180,background:"var(--bg-sidebar)",borderRight:"1px solid var(--border-subtle)",
      display:"flex",flexDirection:"column",flexShrink:0,minHeight:"100vh"}}>

      {/* Logo + staff banner */}
      <div style={{padding:"16px 14px 12px",borderBottom:"1px solid var(--border-subtle)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:staffSession?10:0}}>
          <div style={{width:30,height:30,borderRadius:7,
            background:"linear-gradient(135deg,#06b6d4,#3b82f6)",
            display:"flex",alignItems:"center",justifyContent:"center",
            color:"#fff",fontWeight:700,fontSize:14,flexShrink:0}}>N</div>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>NostrEHR</div>
            <div style={{color:"var(--accent-green)",fontSize:9,textTransform:"uppercase",letterSpacing:"0.5px"}}>v1.2</div>
          </div>
        </div>
        {staffSession&&(
          <div style={{padding:"6px 10px",borderRadius:6,
            background:roleColors[staffSession.role]+"15",
            border:`1px solid ${roleColors[staffSession.role]}30`}}>
            <div style={{fontSize:11,fontWeight:600,color:roleColors[staffSession.role]}}>
              {staffSession.staffName}
            </div>
            <div style={{fontSize:9,color:"var(--text-muted)",textTransform:"capitalize"}}>
              {staffSession.role} · {staffSession.patientSecrets.size} pts
            </div>
          </div>
        )}
      </div>

      {/* Spacer */}
      <div style={{flex:1}}/>

      {/* Bottom actions */}
      <div style={{padding:"8px 12px",borderTop:"1px solid var(--border-subtle)"}}>
        {!staffSession&&(
          <a href={`${BILLING_URL}/dashboard`} target="_blank" rel="noopener noreferrer"
             style={{textDecoration:"none",display:"block",marginBottom:8}}>
            <button style={{
              width:"100%",background:"var(--bg-inset)",border:"1px solid var(--border-accent)",borderRadius:7,
              padding:"7px 10px",color:"var(--accent-blue)",fontSize:11,fontWeight:600,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontFamily:"inherit"
            }}>
              💳 Billing
            </button>
          </a>
        )}
        <div style={{display:"flex",gap:6}}>
          {!staffSession&&<Btn solid col="#0ea5e9" onClick={onAdd}>+ Patient</Btn>}
          <Btn col="#475569" onClick={onToggleTheme} title={dark?"Switch to light mode":"Switch to dark mode"}>{dark?"☀️":"🌙"}</Btn>
          <Btn col="#475569" onClick={onSettings}>⚙️</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── WebAuthn / YubiKey Utilities ─────────────────────────────────────────────

interface WebAuthnCredential {
  credentialId: string;   // base64url
  iv: string;             // base64
  ciphertext: string;     // base64
  salt: string;           // base64
  name: string;           // friendly name
  registeredAt: string;   // ISO date
}

interface AuthStore {
  credentials: WebAuthnCredential[];
}

const AUTH_STORE_KEY = "nostr_ehr_auth_store";
const REMEMBERED_SK_KEY = "nostr_ehr_remembered_sk"; // encrypted or plaintext depending on mode

function loadAuthStore(): AuthStore | null {
  try {
    const raw = localStorage.getItem(AUTH_STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveAuthStore(store: AuthStore): void {
  localStorage.setItem(AUTH_STORE_KEY, JSON.stringify(store));
}

function clearAuthStore(): void {
  localStorage.removeItem(AUTH_STORE_KEY);
}

// base64url encode/decode (WebAuthn uses base64url, not base64)
function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(buf: Uint8Array): string {
  let binary = "";
  buf.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

function fromBase64(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Check if browser supports WebAuthn with PRF extension
async function checkPrfSupport(): Promise<boolean> {
  try {
    if (!window.PublicKeyCredential) return false;
    // Check if PRF extension is likely supported (Chrome 116+)
    return typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function";
  } catch { return false; }
}

// Encrypt practice nsec hex with AES-256-GCM using PRF-derived key
async function encryptWithPrfKey(prfOutput: ArrayBuffer, skHex: string): Promise<{ iv: string; ciphertext: string }> {
  // Derive AES key from PRF output via HKDF
  const keyMaterial = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("nostr-ehr-yubikey-v1"), info: new Uint8Array(0) },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(skHex)
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

// Decrypt practice nsec hex with AES-256-GCM using PRF-derived key
async function decryptWithPrfKey(prfOutput: ArrayBuffer, iv: string, ciphertext: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("nostr-ehr-yubikey-v1"), info: new Uint8Array(0) },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv).buffer as ArrayBuffer },
    aesKey,
    fromBase64(ciphertext).buffer as ArrayBuffer
  );
  return new TextDecoder().decode(plainBuf);
}

// Register a new YubiKey credential with PRF extension
async function registerYubiKey(skHex: string, existingCredIds: string[] = []): Promise<WebAuthnCredential | null> {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: `${PRACTICE_NAME} EHR`, id: window.location.hostname },
        user: { id: userId, name: "practice", displayName: PRACTICE_NAME },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { alg: -7, type: "public-key" },   // ES256
          { alg: -257, type: "public-key" },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "cross-platform",
          residentKey: "discouraged",
          userVerification: "preferred",
        },
        excludeCredentials: existingCredIds.map(id => ({
          id: fromBase64Url(id).buffer as ArrayBuffer,
          type: "public-key" as const,
        })),
        extensions: {
          // @ts-ignore — PRF extension type not yet in all TS defs
          prf: { eval: { first: salt } },
        },
        timeout: 60000,
      }
    }) as PublicKeyCredential | null;

    if (!credential) return null;

    const response = credential.response as AuthenticatorAttestationResponse;
    const extResults = (credential as any).getClientExtensionResults?.();
    
    // Check if PRF was actually supported
    if (!extResults?.prf?.results?.first) {
      throw new Error("PRF_NOT_SUPPORTED");
    }

    const prfOutput = extResults.prf.results.first;
    const { iv, ciphertext } = await encryptWithPrfKey(prfOutput, skHex);
    const credentialId = toBase64Url(credential.rawId);

    return {
      credentialId,
      iv,
      ciphertext,
      salt: toBase64(salt),
      name: `YubiKey ${new Date().toLocaleDateString()}`,
      registeredAt: new Date().toISOString(),
    };
  } catch (err: any) {
    if (err.message === "PRF_NOT_SUPPORTED") throw err;
    console.error("YubiKey registration failed:", err);
    return null;
  }
}

// Authenticate with a registered YubiKey and decrypt the nsec
async function authenticateYubiKey(store: AuthStore): Promise<string | null> {
  try {
    const allowCredentials = store.credentials.map(c => ({
      id: fromBase64Url(c.credentialId).buffer as ArrayBuffer,
      type: "public-key" as const,
    }));

    // We need to try each credential's salt — build PRF eval for all
    // WebAuthn will use the salt from the first credential for the eval
    // but we'll try each credential's salt in sequence if needed
    for (const cred of store.credentials) {
      try {
        const salt = fromBase64(cred.salt);
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials,
            userVerification: "preferred",
            extensions: {
              // @ts-ignore
              prf: { eval: { first: salt } },
            },
            timeout: 60000,
          }
        }) as PublicKeyCredential | null;

        if (!assertion) continue;

        const extResults = (assertion as any).getClientExtensionResults?.();
        if (!extResults?.prf?.results?.first) continue;

        // Find which credential was actually used
        const usedCredId = toBase64Url(assertion.rawId);
        const usedCred = store.credentials.find(c => c.credentialId === usedCredId);
        if (!usedCred) continue;

        // If the used credential's salt matches what we sent, decrypt directly
        // Otherwise we need to retry with the correct salt
        if (usedCred.credentialId === cred.credentialId) {
          const skHex = await decryptWithPrfKey(extResults.prf.results.first, usedCred.iv, usedCred.ciphertext);
          return skHex;
        }
      } catch (err) {
        console.warn("YubiKey auth attempt failed:", err);
        continue;
      }
    }
    return null;
  } catch (err) {
    console.error("YubiKey authentication failed:", err);
    return null;
  }
}

// ─── Session Timeout Hook ─────────────────────────────────────────────────────

function useSessionTimeout(active: boolean, timeoutMs: number, onTimeout: () => void) {
  const lastActivity = useRef(Date.now());
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  // Reset the activity timestamp when session becomes active (user logs in)
  useEffect(() => {
    if (active) {
      lastActivity.current = Date.now();
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const resetTimer = () => { lastActivity.current = Date.now(); };
    // mousemove excluded — too sensitive, resets on any micro-movement
    const events = ["mousedown", "keydown", "scroll", "touchstart", "click"];
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }));

    const checker = setInterval(() => {
      const elapsed = Date.now() - lastActivity.current;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 60000 && remaining > 0) {
        console.log(`[session] Auto-lock in ${Math.ceil(remaining / 1000)}s`);
      }
      if (elapsed > timeoutMs) {
        console.log("[session] Timed out — locking");
        onTimeoutRef.current();
      }
    }, 30000); // check every 30 seconds

    return () => {
      events.forEach(e => window.removeEventListener(e, resetTimer));
      clearInterval(checker);
    };
  }, [active, timeoutMs]);
}

// ─── Login Screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }: { onLogin: (keys: Keypair) => void }) {
  const [nsecInput, setNsecInput] = useState("");
  const [showNsec, setShowNsec] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [yubiKeyPrompt, setYubiKeyPrompt] = useState(false);
  const [authStore, setAuthStore] = useState<AuthStore | null>(null);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // On mount, check if we have registered YubiKeys
  useEffect(() => {
    const store = loadAuthStore();
    setAuthStore(store);
    
    // Check if this was a timeout (session flag)
    const wasTimedOut = sessionStorage.getItem("nostr_ehr_timed_out");
    if (wasTimedOut) {
      setTimedOut(true);
      sessionStorage.removeItem("nostr_ehr_timed_out");
    }

    // Check for remembered plaintext key (non-YubiKey "remember me")
    // Also check for legacy key from pre-login-screen versions
    const rememberedSk = localStorage.getItem(REMEMBERED_SK_KEY) || localStorage.getItem("nostr_ehr_practice_sk");
    if (rememberedSk && !store?.credentials?.length) {
      // If session timed out, don't auto-login — require user action
      if (wasTimedOut) {
        // Store the key reference so we know to show "Unlock" instead of full nsec entry
        setHasStoredKey(true);
        return;
      }
      // Fresh page load (not a timeout) — auto-login with stored key
      try {
        const sk = fromHex(rememberedSk);
        const pk = getPublicKey(sk);
        onLogin({ sk, pkHex: toHex(pk), npub: npubEncode(pk), nsec: nsecEncode(sk) });
        return;
      } catch {
        localStorage.removeItem(REMEMBERED_SK_KEY);
        localStorage.removeItem("nostr_ehr_practice_sk");
      }
    }

    // If YubiKeys registered, auto-trigger authentication
    if (store?.credentials?.length) {
      triggerYubiKeyAuth(store);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const triggerYubiKeyAuth = async (store: AuthStore) => {
    setYubiKeyPrompt(true);
    setError("");
    setLoading(true);
    try {
      const skHex = await authenticateYubiKey(store);
      if (!mountedRef.current) return;
      if (skHex) {
        const sk = fromHex(skHex);
        const pk = getPublicKey(sk);
        onLogin({ sk, pkHex: toHex(pk), npub: npubEncode(pk), nsec: nsecEncode(sk) });
      } else {
        setError("Authentication failed. Try again or enter your key manually.");
        setYubiKeyPrompt(false);
      }
    } catch {
      if (!mountedRef.current) return;
      setError("YubiKey authentication failed. Enter your key manually.");
      setYubiKeyPrompt(false);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const handleManualLogin = () => {
    setError("");
    setLoading(true);
    try {
      const trimmed = nsecInput.trim();
      let sk: Uint8Array;
      
      if (trimmed.startsWith("nsec1")) {
        sk = nsecToBytes(trimmed);
      } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        sk = fromHex(trimmed);
      } else {
        setError("Invalid key format. Enter an nsec or 64-character hex key.");
        setLoading(false);
        return;
      }

      const pk = getPublicKey(sk);
      const skHex = toHex(sk);

      // If "remember this device" checked and no YubiKey, store plaintext
      if (rememberDevice) {
        localStorage.setItem(REMEMBERED_SK_KEY, skHex);
      }

      onLogin({ sk, pkHex: toHex(pk), npub: npubEncode(pk), nsec: nsecEncode(sk) });
    } catch {
      setError("Invalid key. Please check and try again.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleManualLogin();
  };

  // Unlock with stored key (after timeout, no nsec entry needed)
  const handleUnlock = () => {
    const storedSk = localStorage.getItem(REMEMBERED_SK_KEY) || localStorage.getItem("nostr_ehr_practice_sk");
    if (!storedSk) {
      setHasStoredKey(false);
      setError("Stored key not found. Please enter your key manually.");
      return;
    }
    try {
      const sk = fromHex(storedSk);
      const pk = getPublicKey(sk);
      onLogin({ sk, pkHex: toHex(pk), npub: npubEncode(pk), nsec: nsecEncode(sk) });
    } catch {
      setHasStoredKey(false);
      setError("Stored key is invalid. Please enter your key manually.");
      localStorage.removeItem(REMEMBERED_SK_KEY);
      localStorage.removeItem("nostr_ehr_practice_sk");
    }
  };

  const hasYubiKeys = (authStore?.credentials?.length ?? 0) > 0;

  return (
    <div style={{
      minHeight: "100vh", background: "#0f172a",
      backgroundImage: "url('/login-bg.png')",
      backgroundSize: "cover",
      backgroundPosition: "center",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
    }}>
      <div style={{
        width: 380, background: "rgba(30,41,59,0.92)", borderRadius: 16,
        border: "1px solid var(--border)", padding: "40px 36px",
        boxShadow: "0 25px 50px var(--shadow-heavy)",
        backdropFilter: "blur(12px)",
      }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14,
            overflow: "hidden",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            marginBottom: 16,
          }}><img src="/icon.png" alt="" style={{width:52,height:52}} /></div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>
            {PRACTICE_NAME.split(" ").length > 2 ? PRACTICE_NAME.split(" ").slice(0, -1).join(" ") : PRACTICE_NAME}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
            {PRACTICE_NAME.split(" ").length > 2 ? PRACTICE_NAME.split(" ").slice(-1)[0] : "EHR"}
          </div>
        </div>

        {/* Timed out notice */}
        {timedOut && (
          <div style={{
            background: "#172554", border: "1px solid var(--border-accent)", borderRadius: 8,
            padding: "10px 14px", marginBottom: 20, textAlign: "center",
          }}>
            <div style={{ fontSize: 12, color: "#93c5fd" }}>
              Session timed out for security
            </div>
          </div>
        )}

        {/* Quick unlock (stored key after timeout, no YubiKeys) */}
        {hasStoredKey && !hasYubiKeys && (
          <div style={{ marginBottom: 24 }}>
            <button
              onClick={handleUnlock}
              style={{
                width: "100%", padding: "16px",
                background: "linear-gradient(90deg, #0ea5e9cc, #0ea5e9)",
                border: "none", borderRadius: 10, cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", marginBottom: 2 }}>
                Unlock
              </div>
              <div style={{ fontSize: 11, color: "#bae6fd" }}>
                Device key stored — click to resume
              </div>
            </button>
            <div style={{
              display: "flex", alignItems: "center", gap: 12,
              margin: "16px 0", color: "var(--text-label)", fontSize: 11,
            }}>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span>or enter manually</span>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
          </div>
        )}

        {/* YubiKey auth prompt */}
        {hasYubiKeys && (
          <div style={{ marginBottom: 24 }}>
            <button
              onClick={() => authStore && triggerYubiKeyAuth(authStore)}
              disabled={loading}
              style={{
                width: "100%", padding: "20px 16px",
                background: yubiKeyPrompt && loading ? "#0c4a6e" : "var(--bg-app)",
                border: `2px solid ${yubiKeyPrompt && loading ? "#0ea5e9" : "var(--border)"}`,
                borderRadius: 12, cursor: loading ? "default" : "pointer",
                transition: "all 0.2s",
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.borderColor = "#0ea5e9"; }}
              onMouseLeave={e => { if (!loading) e.currentTarget.style.borderColor = "var(--border)"; }}
            >
              <div style={{
                fontSize: 22, marginBottom: 8,
                animation: yubiKeyPrompt && loading ? "pulse 1.5s ease-in-out infinite" : "none",
              }}>🔑</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                {yubiKeyPrompt && loading ? "Waiting for YubiKey…" : "Tap YubiKey to sign in"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {authStore?.credentials.length === 1
                  ? `1 key registered`
                  : `${authStore?.credentials.length} keys registered`}
              </div>
            </button>
          </div>
        )}

        {/* Divider (when YubiKeys exist) */}
        {hasYubiKeys && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            marginBottom: 20, color: "var(--text-label)", fontSize: 11,
          }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span>or enter manually</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>
        )}

        {/* Manual nsec entry */}
        <div style={{ marginBottom: 16 }}>
          <label style={{
            color: "var(--text-label)", fontSize: 10, textTransform: "uppercase",
            letterSpacing: "0.6px", marginBottom: 6, display: "block",
          }}>
            Practice Key
          </label>
          <div style={{ position: "relative" }}>
            <input
              type={showNsec ? "text" : "password"}
              value={nsecInput}
              onChange={e => { setNsecInput(e.target.value); setError(""); }}
              onKeyDown={handleKeyDown}
              placeholder="nsec1… or hex"
              autoComplete="off"
              spellCheck={false}
              style={{
                width: "100%", background: "var(--bg-app)",
                border: `1px solid ${error ? "#ef4444" : "var(--border)"}`,
                borderRadius: 8, padding: "12px 42px 12px 14px",
                color: "var(--text-primary)", fontSize: 13, fontFamily: "monospace",
                boxSizing: "border-box", outline: "none",
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.currentTarget.style.borderColor = error ? "#ef4444" : "#0ea5e9"}
              onBlur={e => e.currentTarget.style.borderColor = error ? "#ef4444" : "var(--border)"}
            />
            <button
              onClick={() => setShowNsec(!showNsec)}
              style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer",
                color: "var(--text-muted)", fontSize: 16, padding: "2px 4px",
              }}
              tabIndex={-1}
            >
              {showNsec ? "🙈" : "👁"}
            </button>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div style={{
            color: "#fca5a5", fontSize: 12, marginBottom: 14,
            padding: "8px 12px", background: "var(--tint-red)", borderRadius: 6,
            border: "1px solid #991b1b",
          }}>
            {error}
          </div>
        )}

        {/* Remember device checkbox (only shown when no YubiKeys) */}
        {!hasYubiKeys && (
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            marginBottom: 16, cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={e => setRememberDevice(e.target.checked)}
              style={{ accentColor: "#0ea5e9" }}
            />
            <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              Remember this device
            </span>
          </label>
        )}

        {/* Sign in button */}
        <button
          onClick={handleManualLogin}
          disabled={loading || !nsecInput.trim()}
          style={{
            width: "100%", padding: "12px 16px",
            background: !nsecInput.trim() || loading
              ? "var(--bg-card)"
              : "linear-gradient(90deg, #0ea5e9cc, #0ea5e9)",
            border: "1px solid #0ea5e944",
            borderRadius: 8, color: !nsecInput.trim() || loading ? "var(--text-label)" : "#fff",
            fontSize: 14, fontWeight: 600, cursor: !nsecInput.trim() || loading ? "not-allowed" : "pointer",
            fontFamily: "inherit", transition: "all 0.2s",
          }}
        >
          {loading && !yubiKeyPrompt ? "Signing in…" : "Sign In"}
        </button>

        {/* Footer */}
        <div style={{
          textAlign: "center", marginTop: 24,
          color: "var(--text-label)", fontSize: 11,
        }}>
          <span style={{ marginRight: 4 }}>🔒</span>
          Your key never leaves this device
        </div>
      </div>
    </div>
  );
}

// ─── YubiKey Manager (for Settings) ──────────────────────────────────────────

function YubiKeyManager({ keys }: { keys: Keypair }) {
  const [authStore, setAuthStore] = useState<AuthStore | null>(loadAuthStore());
  const [registering, setRegistering] = useState(false);
  const [status, setStatus] = useState("");
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null);

  useEffect(() => {
    checkPrfSupport().then(setPrfSupported);
  }, []);

  const handleRegister = async () => {
    setRegistering(true);
    setStatus("Tap your YubiKey now…");
    try {
      const existingIds = authStore?.credentials.map(c => c.credentialId) || [];
      const cred = await registerYubiKey(toHex(keys.sk), existingIds);
      if (cred) {
        const store = authStore || { credentials: [] };
        store.credentials.push(cred);
        saveAuthStore(store);
        setAuthStore({ ...store });
        setStatus("✓ YubiKey registered successfully");
        // Clear plaintext remembered key if it exists — YubiKey is now the auth method
        localStorage.removeItem(REMEMBERED_SK_KEY);
      } else {
        setStatus("Registration cancelled");
      }
    } catch (err: any) {
      if (err.message === "PRF_NOT_SUPPORTED") {
        setStatus("Your browser or YubiKey does not support the PRF extension. Use Chrome 116+ with a FIDO2-compatible key.");
      } else {
        setStatus("Registration failed: " + (err.message || "Unknown error"));
      }
    } finally {
      setRegistering(false);
      setTimeout(() => setStatus(""), 5000);
    }
  };

  const handleRemove = (credId: string) => {
    if (!authStore) return;
    const cred = authStore.credentials.find(c => c.credentialId === credId);
    if (!confirm(`Remove "${cred?.name || "YubiKey"}"? You'll need another registered key or your nsec to sign in.`)) return;
    const updated = { credentials: authStore.credentials.filter(c => c.credentialId !== credId) };
    if (updated.credentials.length === 0) {
      clearAuthStore();
      setAuthStore(null);
    } else {
      saveAuthStore(updated);
      setAuthStore(updated);
    }
  };

  const handleRename = (credId: string) => {
    if (!authStore) return;
    const cred = authStore.credentials.find(c => c.credentialId === credId);
    const newName = prompt("Enter a name for this key:", cred?.name || "");
    if (!newName?.trim()) return;
    const updated = {
      credentials: authStore.credentials.map(c =>
        c.credentialId === credId ? { ...c, name: newName.trim() } : c
      )
    };
    saveAuthStore(updated);
    setAuthStore(updated);
  };

  if (prfSupported === null) return null; // loading

  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>🔑 YubiKey Authentication</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 16 }}>
        Register a YubiKey for tap-to-login. Your practice key is encrypted and can only be unlocked with the physical key.
      </div>

      {/* Registered keys list */}
      {authStore?.credentials.map(cred => (
        <div key={cred.credentialId} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", background: "var(--bg-app)", borderRadius: 8,
          marginBottom: 8, border: "1px solid var(--border)",
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
              🔑 {cred.name}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
              Registered {new Date(cred.registeredAt).toLocaleDateString()}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Btn small col="#475569" onClick={() => handleRename(cred.credentialId)}>Rename</Btn>
            <Btn small col="#ef4444" onClick={() => handleRemove(cred.credentialId)}>Remove</Btn>
          </div>
        </div>
      ))}

      {/* Register button */}
      {prfSupported ? (
        <Btn solid col="#0ea5e9" onClick={handleRegister} disabled={registering}>
          {registering ? "Tap your YubiKey…" : "+ Register YubiKey"}
        </Btn>
      ) : (
        <div style={{
          fontSize: 11, color: "#f59e0b", padding: "10px 14px",
          background: "var(--tint-amber)", borderRadius: 8, border: "1px solid var(--tint-amber-border)",
        }}>
          Your browser does not support hardware key encryption (PRF extension). Use Chrome 116+ for YubiKey support.
        </div>
      )}

      {/* Status message */}
      {status && (
        <div style={{ fontSize: 11, color: status.startsWith("✓") ? "var(--accent-green)" : "#fbbf24", marginTop: 8 }}>
          {status}
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function Home(){
  const [keys,setKeys]=useState<Keypair|null>(null);
  const [patients,setPatients]=useState<Patient[]>([]);
  const [openPatients,setOpenPatients]=useState<Patient[]>([]);
  const [activePatientId,setActivePatientId]=useState<string|null>(null);
  const [patientInitialTabs,setPatientInitialTabs]=useState<Record<string,string>>({});
  const [patientInitialThreads,setPatientInitialThreads]=useState<Record<string,string>>({});
  const [inboxClickCount,setInboxClickCount]=useState(0);
  const [adding,setAdding]=useState(false);
  const [view,setView]=useState<"schedule"|"patients"|"settings"|"inbox">("schedule");
  const [inboxUnread,setInboxUnread]=useState(0);
  const [closeConfirm,setCloseConfirm]=useState<{show:boolean;newPatient:Patient|null}>({show:false,newPatient:null});
    const [patientSearch,setPatientSearch]=useState("");
  const [showAdvSearch,setShowAdvSearch]=useState(false);
  const [advSearch,setAdvSearch]=useState({phone:"",dob:"",email:"",address:"",city:"",state:"",zip:""});
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const relay=useRelay();
  const theme=useTheme();
  const [videoCall, setVideoCall] = useState<{appointmentId:number;patientName:string;patientPkHex:string}|null>(null);
  // Multi-user: staff session (null = logged in as practice owner)
  const [staffSession,setStaffSession]=useState<StaffSession|null>(null);
  const [staffBootstrapping,setStaffBootstrapping]=useState(false);
  const [staffError,setStaffError]=useState("");
  // Keep module-level ref in sync for cachedLoad (can't use React hooks in async functions)
  useEffect(()=>{ _activeStaffSession=staffSession; },[staffSession]);

  // Open a patient tab (max 4)
  const openPatient = useCallback((patient: Patient) => {
    // If already open, just switch to it
    if (openPatients.find(p => p.id === patient.id)) {
      setActivePatientId(patient.id);
      setView("patients");
      return;
    }
  
    // If less than 4 tabs, add it
    if (openPatients.length < 4) {
      setOpenPatients([...openPatients, patient]);
      setActivePatientId(patient.id);
      setView("patients");
      return;
    }

    // If 4 tabs already open, show close confirmation
    setCloseConfirm({ show: true, newPatient: patient });
  }, [openPatients]);

  // Close a patient tab
  const closePatient = (patientId: string) => {
    const newOpen = openPatients.filter(p => p.id !== patientId);
    setOpenPatients(newOpen);
  
    // If we closed the active tab, switch to first remaining tab (or null)
    if (activePatientId === patientId) {
      setActivePatientId(newOpen.length > 0 ? newOpen[0].id : null);
    }
  };

  // Replace a patient tab with a new one
  const replacePatient = (oldId: string, newPatient: Patient) => {
    const newOpen = openPatients.map(p => p.id === oldId ? newPatient : p);
    setOpenPatients(newOpen);
    setActivePatientId(newPatient.id);
    setCloseConfirm({ show: false, newPatient: null });
  };

  // Reorder patient tabs
  const reorderTabs = (fromIndex: number, toIndex: number) => {
    const newOrder = [...openPatients];
    const [movedPatient] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, movedPatient);
    setOpenPatients(newOrder);
  };

  const activePatient = openPatients.find(p => p.id === activePatientId) || null;

  // Listen for postMessage from calendar iframe (Open Chart button)
  useEffect(()=>{
    const handler=(e:MessageEvent)=>{
      if(e.data?.type==="open-patient-chart" && e.data?.npub){
        const npub=e.data.npub;
        const patient=patients.find(p=>p.npub===npub);
        if(patient){
          openPatient(patient);
        } else {
          // Patient not in local list, reload and try again
          const refreshed=loadPatients();
          setPatients(refreshed);
          const found=refreshed.find(p=>p.npub===npub);
          if(found) openPatient(found);
        }
      }
    };
    window.addEventListener("message",handler);
    return()=>window.removeEventListener("message",handler);
  },[patients, openPatient]);

  // Session timeout (15 minutes)
  const handleTimeout = useCallback(() => {
    sessionStorage.setItem("nostr_ehr_timed_out", "1");
    setKeys(null);
  }, []);
  useSessionTimeout(keys !== null, 15 * 60 * 1000, handleTimeout);

  const handleLogin = useCallback((loginKeys: Keypair) => {
    // Re-read runtime config in case Electron injected it after module init
    if (!PRACTICE_PUBKEY) {
      const injected = (window as any).__NOSTREHR_CONFIG__?.practicePubkey;
      const stored = localStorage.getItem("__nostrehr_practice_pk__");
      if (injected) PRACTICE_PUBKEY = injected;
      else if (stored) PRACTICE_PUBKEY = stored;
    }
    setKeys(loginKeys);
    // Load patients from localStorage first (instant)
    const allPatients = loadPatients();
    setPatients(allPatients);
    // Restore session
    try {
      const session = localStorage.getItem("nostr_ehr_session");
      if (session) {
        const s = JSON.parse(session);
        if (s.view) setView(s.view);
        if (s.openIds && Array.isArray(s.openIds)) {
          const restored = s.openIds.map((id: string) => allPatients.find(p => p.id === id)).filter(Boolean) as Patient[];
          if (restored.length > 0) {
            setOpenPatients(restored);
            if (s.activeId) setActivePatientId(s.activeId);
          }
        }
      }
    } catch {}
  }, []);

  // ─── Staff Bootstrap: detect staff login, fetch grants, build session ────────
  // Check practice owner: also check localStorage for Electron packaged app
  const isPracticeOwner = useMemo(() => {
    if (!keys) return false;
    if (PRACTICE_PUBKEY && keys.pkHex === PRACTICE_PUBKEY) return true;
    try { const stored = localStorage.getItem("__nostrehr_practice_pk__"); if (stored && keys.pkHex === stored) return true; } catch {}
    return !PRACTICE_PUBKEY; // If no pubkey configured at all, assume practice owner
  }, [keys]);
  useEffect(() => {
    if (!keys) return;
    if (isPracticeOwner) { setStaffSession(null); return; }
    if (relay.status !== "connected") return;
    setStaffBootstrapping(true);
    setStaffError("");
    let cancelled = false;

    const bootstrap = async () => {
      // Small delay to ensure WebSocket is fully ready after status change
      await new Promise(r => setTimeout(r, 150));
      if (cancelled) return;
      try {
        // 1. Fetch roster (kind 2102) signed by practice key
        const rosterEvent = await new Promise<NostrEvent | null>((resolve) => {
          let latest: NostrEvent | null = null;
          const subId = relay.subscribe(
            { kinds: [STAFF_KINDS.StaffRoster], authors: [PRACTICE_PUBKEY], limit: 10 },
            (ev: NostrEvent) => {
              if (ev.pubkey !== PRACTICE_PUBKEY) return;
              if (!latest || ev.created_at > latest.created_at) latest = ev;
            },
            () => { relay.unsubscribe(subId); resolve(latest); }
          );
          setTimeout(() => { relay.unsubscribe(subId); resolve(latest); }, 5000);
        });

        if (cancelled) return;
        if (!rosterEvent) { setStaffError("Could not load staff roster from relay."); setStaffBootstrapping(false); return; }

        // 2. Decrypt roster using ECDH between staff key and practice pubkey
        // The roster is encrypted to the practice key's self-shared-secret (X₁),
        // so staff can't decrypt it directly. We need the practice grant first.
        // But we need the roster to verify authorization...
        // Solution: check the ["p", staffPkHex, role] tags on the roster event (unencrypted)
        const staffTag = rosterEvent.tags.find(t => t[0] === "p" && t[1] === keys.pkHex);
        if (!staffTag) { setStaffError("Your key is not authorized in this practice's roster."); setStaffBootstrapping(false); return; }
        const tagRole = staffTag[2] as StaffRole || "ma";

        // 3. Fetch practice secret grant (kind 2101) for this staff member
        // Note: no #p relay filter — nostr-rs-relay 0.9.0 doesn't index it reliably
        const practiceGrant = await new Promise<NostrEvent | null>((resolve) => {
          let found: NostrEvent | null = null;
          const subId = relay.subscribe(
            { kinds: [STAFF_KINDS.PracticeKeyGrant], authors: [PRACTICE_PUBKEY], limit: 50 },
            (ev: NostrEvent) => {
              if (ev.pubkey !== PRACTICE_PUBKEY) return;
              // Check this grant is for us
              const pTag = ev.tags.find(t => t[0] === "p" && t[1] === keys.pkHex);
              if (pTag && (!found || ev.created_at > found.created_at)) found = ev;
            },
            () => { relay.unsubscribe(subId); resolve(found); }
          );
          setTimeout(() => { relay.unsubscribe(subId); resolve(found); }, 5000);
        });

        if (cancelled) return;
        if (!practiceGrant) { setStaffError("No practice key grant found. Ask the practice administrator to re-authorize you."); setStaffBootstrapping(false); return; }

        // Decrypt practice grant — encrypted via ECDH(practiceSk, staffPk)
        // Staff decrypts with ECDH(staffSk, practicePk) — same shared secret
        const grantSharedX = getSharedSecret(keys.sk, PRACTICE_PUBKEY);
        let practicePayload: PracticeKeyGrantPayload;
        try {
          const plain = await nip44Decrypt(practiceGrant.content, grantSharedX);
          practicePayload = JSON.parse(plain);
        } catch (e) {
          setStaffError("Failed to decrypt practice grant. Key may be invalid."); setStaffBootstrapping(false); return;
        }

        const practiceSharedSecret = fromHex(practicePayload.practiceSharedSecret);

        // 4. Now decrypt the roster with X₁ to get full staff details
        let rosterData: StaffRosterPayload;
        try {
          const rosterPlain = await nip44Decrypt(rosterEvent.content, practiceSharedSecret);
          rosterData = JSON.parse(rosterPlain);
        } catch {
          setStaffError("Failed to decrypt roster with practice secret."); setStaffBootstrapping(false); return;
        }

        const myEntry = rosterData.staff.find(s => s.pkHex === keys.pkHex && !s.revokedAt);
        if (!myEntry) { setStaffError("Your key has been revoked from this practice."); setStaffBootstrapping(false); return; }

        // 5. Fetch patient key grants (kind 2100) for this staff member
        const patientSecrets = new Map<string, Uint8Array>();
        await new Promise<void>((resolve) => {
          const subId = relay.subscribe(
            { kinds: [STAFF_KINDS.PatientKeyGrant], authors: [PRACTICE_PUBKEY], limit: 500 },
            async (ev: NostrEvent) => {
              if (ev.pubkey !== PRACTICE_PUBKEY) return;
              const pTag = ev.tags.find(t => t[0] === "p" && t[1] === keys.pkHex);
              if (!pTag) return;
              try {
                const plain = await nip44Decrypt(ev.content, grantSharedX);
                const grant: PatientKeyGrantPayload = JSON.parse(plain);
                patientSecrets.set(grant.patientId, fromHex(grant.patientSharedSecret));
              } catch {}
            },
            () => { relay.unsubscribe(subId); resolve(); }
          );
          setTimeout(() => { relay.unsubscribe(subId); resolve(); }, 8000);
        });

        if (cancelled) return;

        // 6. Build staff session
        const session: StaffSession = {
          staffSk: keys.sk,
          staffPkHex: keys.pkHex,
          staffName: myEntry.name,
          role: myEntry.role,
          permissions: myEntry.permissions,
          practiceSharedSecret,
          patientSecrets,
          practicePkHex: PRACTICE_PUBKEY,
        };
        setStaffSession(session);
        console.log(`[Staff] Session bootstrapped: ${myEntry.name} (${myEntry.role}), ${patientSecrets.size} patient secrets loaded`);
      } catch (e: any) {
        if (!cancelled) setStaffError(e.message || "Staff login failed.");
      } finally {
        if (!cancelled) setStaffBootstrapping(false);
      }
    };

    bootstrap();
    return () => { cancelled = true; };
  }, [keys, relay.status, isPracticeOwner]);

  // Sync patient roster from relay — discovers patients missing from localStorage
  // Uses kind 2110 (Patient demographics) as primary source, falls back to clinical event tags
  useEffect(() => {
    if (!keys || relay.status !== "connected") return;
    // Staff must wait for session bootstrap to get X₁ for decryption
    if (!isPracticeOwner && !staffSession) return;
    let cancelled = false;

    // Multi-user: query by practice pubkey (events are signed/tagged with practice key)
    const queryPkHex = isPracticeOwner ? keys.pkHex : PRACTICE_PUBKEY;
    // Multi-user: use precomputed X₁ if staff, derive if practice owner
    const decryptSecret = staffSession?.practiceSharedSecret || getSharedSecret(keys.sk, keys.pkHex);

    const syncPatients = async () => {
      // Phase 1: Collect kind 2110 Patient events (full demographics, encrypted)
      const demographicEvents = new Map<string, NostrEvent>(); // patientId → latest event
      
      await new Promise<void>((resolve) => {
        const subId = relay.subscribe(
          { kinds: [FHIR_KINDS.Patient], authors: [queryPkHex] },
          (ev: NostrEvent) => {
            const ptTag = ev.tags.find((t: string[]) => t[0] === "pt");
            if (!ptTag?.[1]) return;
            const patientId = ptTag[1];
            const existing = demographicEvents.get(patientId);
            // Keep latest event only (current state)
            if (!existing || ev.created_at > existing.created_at) {
              demographicEvents.set(patientId, ev);
            }
          },
          () => { relay.unsubscribe(subId); resolve(); }
        );
        setTimeout(() => { try { relay.unsubscribe(subId); } catch {} resolve(); }, 10000);
      });

      if (cancelled) return;

      // Phase 2: Also discover patients from clinical events (for patients without kind 2110)
      // Use #p tag filter (not authors) so events signed by staff are also found
      const discovered = new Map<string, { patientId: string; pkHex: string }>();
      const practicePkForFilter = isPracticeOwner ? keys.pkHex : PRACTICE_PUBKEY;
      
      await new Promise<void>((resolve) => {
        const subId = relay.subscribe(
          { kinds: [FHIR_KINDS.Encounter, FHIR_KINDS.MedicationRequest, FHIR_KINDS.Observation, FHIR_KINDS.Condition, FHIR_KINDS.AllergyIntolerance, FHIR_KINDS.Immunization, FHIR_KINDS.ServiceRequest, FHIR_KINDS.DiagnosticReport, FHIR_KINDS.DocumentReference], "#p": [practicePkForFilter] },
          (ev: NostrEvent) => {
            const ptTag = ev.tags.find((t: string[]) => t[0] === "pt");
            const pTags = ev.tags.filter((t: string[]) => t[0] === "p");
            if (!ptTag?.[1]) return;
            const patientId = ptTag[1];
            if (discovered.has(patientId)) return;
            const patientPk = pTags.find((t: string[]) => t[1] !== queryPkHex)?.[1];
            if (patientPk) {
              discovered.set(patientId, { patientId, pkHex: patientPk });
            }
          },
          () => { relay.unsubscribe(subId); resolve(); }
        );
        setTimeout(() => { try { relay.unsubscribe(subId); } catch {} resolve(); }, 15000);
      });

      if (cancelled) return;

      // Merge all known patient IDs
      const allPatientIds = new Set([...demographicEvents.keys(), ...discovered.keys()]);
      if (allPatientIds.size === 0) return;

      const existing = loadPatients();
      const existingById = new Map(existing.map(p => [p.id, p]));
      let changed = false;
      const updatedList = [...existing];

      for (const patientId of allPatientIds) {
        if (cancelled) break;
        const demEvent = demographicEvents.get(patientId);
        const disc = discovered.get(patientId);
        const existingPatient = existingById.get(patientId);

        // If we have a kind 2110 event, decrypt it for full demographics
        if (demEvent) {
          try {
            const decrypted = await nip44Decrypt(demEvent.content, decryptSecret);
            const fhir = JSON.parse(decrypted);
            const name = fhir.name?.[0]?.text || "Unknown Patient";
            const dob = fhir.birthDate || "";
            const sex = (fhir.gender || "unknown") as Patient["sex"];
            const phone = fhir.telecom?.find((t: any) => t.system === "phone")?.value || "";
            const email = fhir.telecom?.find((t: any) => t.system === "email")?.value || "";
            const addr = fhir.address?.[0];
            const address = addr?.line?.[0] || "";
            const city = addr?.city || "";
            const state = addr?.state || "";
            const zip = addr?.postalCode || "";
            
            // Get npub from event tags
            const pTags = demEvent.tags.filter((t: string[]) => t[0] === "p");
            const patientPk = pTags.find((t: string[]) => t[1] !== queryPkHex)?.[1];
            const npub = patientPk ? npubEncode(fromHex(patientPk)) : disc?.pkHex ? npubEncode(fromHex(disc.pkHex)) : "";

            if (existingPatient) {
              // Update existing patient with relay demographics if they have missing data
              const needsUpdate = !existingPatient.dob || !existingPatient.phone || existingPatient.name === "Unknown Patient";
              if (needsUpdate) {
                const idx = updatedList.findIndex(p => p.id === patientId);
                if (idx !== -1) {
                  updatedList[idx] = {
                    ...updatedList[idx],
                    name: existingPatient.name === "Unknown Patient" ? name : existingPatient.name,
                    dob: existingPatient.dob || dob,
                    sex: existingPatient.sex === "unknown" ? sex : existingPatient.sex,
                    phone: existingPatient.phone || phone,
                    email: existingPatient.email || email,
                    address: existingPatient.address || address,
                    city: existingPatient.city || city,
                    state: existingPatient.state || state,
                    zip: existingPatient.zip || zip,
                  };
                  changed = true;
                }
              }
            } else {
              // New patient — add with full demographics
              updatedList.push({
                id: patientId, name, dob, sex, phone, email, address, city, state, zip,
                createdAt: demEvent.created_at * 1000,
                npub,
              } as Patient);
              changed = true;
            }
          } catch (err) {
            console.warn(`[sync] Failed to decrypt kind 2110 for ${patientId}:`, err);
          }
        } else if (!existingPatient && disc) {
          // No kind 2110 event — fall back to billing API for name
          try {
            const npub = npubEncode(fromHex(disc.pkHex));
            let name = "Unknown Patient";
            try {
              const res = await fetch(`${BILLING_URL}/api/patients/${encodeURIComponent(npub)}`);
              if (res.ok) {
                const data = await res.json();
                if (data?.name) name = data.name;
              }
            } catch {}
            updatedList.push({
              id: disc.patientId, name, dob: "", sex: "unknown" as Patient["sex"],
              createdAt: Date.now(), npub,
            } as Patient);
            changed = true;
          } catch {}
        }
      }

      if (!cancelled && changed) {
        savePatients(updatedList);
        setPatients(updatedList);
        console.log(`[sync] Patient roster synced from relay (${allPatientIds.size} patients found)`);
      }
    };

    syncPatients();
    return () => { cancelled = true; };
  }, [keys, relay.status, isPracticeOwner, staffSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSignOut = useCallback(() => {
    // Clear stored keys so LoginScreen doesn't auto-login
    localStorage.removeItem(REMEMBERED_SK_KEY);
    localStorage.removeItem("nostr_ehr_practice_sk");
    setKeys(null);
    setStaffSession(null);
    setStaffError("");
    setStaffBootstrapping(false);
    setOpenPatients([]);
    setActivePatientId(null);
    setPatients([]);
  }, []);

  // Save session state to localStorage whenever it changes (skip first render to avoid clobbering restore)
  const sessionInitialized=useRef(false);
  useEffect(()=>{
    if(!sessionInitialized.current){sessionInitialized.current=true;return;}
    const session={
      view,
      openIds:openPatients.map(p=>p.id),
      activeId:activePatientId,
    };
    localStorage.setItem("nostr_ehr_session",JSON.stringify(session));
  },[view,openPatients,activePatientId]);

  const handleAdd = (p: Patient) => {
    setPatients(loadPatients());
    openPatient(p);
    setAdding(false);
  };

  // Login gate — show LoginScreen when not authenticated
  if (!keys) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  // Staff bootstrapping gate — show loading/error while staff session initializes
  if (!isPracticeOwner && keys && (staffBootstrapping || staffError || !staffSession)) {
    return (
      <div style={{...S.app,justifyContent:"center",alignItems:"center"}}>
        <div style={{maxWidth:400,textAlign:"center",padding:32}}>
          {staffBootstrapping || (!staffSession && !staffError) ? (
            <>
              <div style={{fontSize:32,marginBottom:16,animation:"pulse 1.5s ease-in-out infinite"}}>🔑</div>
              <div style={{fontSize:16,fontWeight:600,color:"var(--text-primary)",marginBottom:8}}>Loading Staff Session…</div>
              <div style={{fontSize:12,color:"var(--text-muted)"}}>Fetching authorization and decryption keys from relay</div>
            </>
          ) : (
            <>
              <div style={{fontSize:32,marginBottom:16}}>⚠️</div>
              <div style={{fontSize:16,fontWeight:600,color:"#fca5a5",marginBottom:8}}>Staff Login Failed</div>
              <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:20,lineHeight:1.6}}>{staffError}</div>
              <Btn col="#64748b" onClick={()=>{
                localStorage.removeItem(REMEMBERED_SK_KEY);
                localStorage.removeItem("nostr_ehr_practice_sk");
                setKeys(null);setStaffSession(null);setStaffError("");setStaffBootstrapping(false);
              }}>
                ← Back to Login
              </Btn>
            </>
          )}
        </div>
      </div>
    );
  }

  return(
    <StaffCtx.Provider value={staffSession}>
    <div style={S.app}>
      <PatientListSidebar
        patients={patients}
        selected={activePatient}
        onSelect={p=>{openPatient(p);setAdding(false);}}
        onAdd={()=>{setAdding(true);setActivePatientId(null);setView("patients");}}
        onSettings={()=>{setView("settings");setActivePatientId(null);setAdding(false);}}
        search={patientSearch}
        staffSession={staffSession}
        dark={theme.dark}
        onToggleTheme={theme.toggle}
      />
      <div style={S.panel}>
        
        {/* Top nav */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <button onClick={()=>{setView("schedule");setActivePatientId(null);setAdding(false);}} style={{
              background:"transparent",border:"none",color:view==="schedule"?"var(--tab-active)":"var(--text-muted)",
              fontSize:12,fontWeight:600,cursor:"pointer",padding:"4px 8px",
              borderBottom:view==="schedule"?"2px solid var(--tab-active)":"2px solid transparent",
              fontFamily:"inherit"
            }}>
              📅 Schedule
            </button>
            <button onClick={()=>setView("patients")} style={{
              background:"transparent",border:"none",color:view==="patients"||activePatient?"var(--tab-active)":"var(--text-muted)",
              fontSize:12,fontWeight:600,cursor:"pointer",padding:"4px 8px",
              borderBottom:view==="patients"||activePatient?"2px solid var(--tab-active)":"2px solid transparent",
              fontFamily:"inherit"
            }}>
              👥 Patients
            </button>
            {/* Inbox tab — doctor only (practice owner or doctor role) */}
            {(!staffSession||staffSession.role==="doctor")&&(
              <button onClick={()=>{setView("inbox");setActivePatientId(null);setAdding(false);}} style={{
                background:"transparent",border:"none",
                color:view==="inbox"?"var(--tab-active)":"var(--text-muted)",
                fontSize:12,fontWeight:600,cursor:"pointer",padding:"4px 8px",
                borderBottom:view==="inbox"?"2px solid var(--tab-active)":"2px solid transparent",
                fontFamily:"inherit",display:"flex",alignItems:"center",gap:6,
              }}>
                📬 Inbox
                {inboxUnread>0&&(
                  <span style={{
                    background:"#ef4444",color:"#fff",borderRadius:99,
                    padding:"1px 6px",fontSize:10,fontWeight:700,lineHeight:1.4,
                  }}>{inboxUnread}</span>
                )}
              </button>
            )}
          </div>
          {(view==="patients"||activePatient)&&(
            <div style={{position:"relative"}}>
              {/* Main search input */}
              <div style={{position:"relative"}}>
                <input
                  value={patientSearch}
                  onChange={e=>{setPatientSearch(e.target.value);if(showAdvSearch)setShowAdvSearch(false);}}
                  onFocus={e=>(e.target as HTMLInputElement).select()}
                  placeholder="Search patients…"
                  style={{...S.input,fontSize:11,padding:"5px 10px",width:220}}
                />
                {/* Advanced search link */}
                <button onClick={()=>{setShowAdvSearch(v=>!v);setPatientSearch("");}}
                  style={{position:"absolute",right:6,bottom:-16,
                    background:"none",border:"none",color:showAdvSearch?"#0ea5e9":"var(--text-faint)",
                    fontSize:10,cursor:"pointer",padding:0,fontFamily:"inherit",
                    textDecoration:"none",whiteSpace:"nowrap",
                  }}
                  onMouseEnter={e=>(e.currentTarget.style.color="var(--text-muted)")}
                  onMouseLeave={e=>(e.currentTarget.style.color=showAdvSearch?"#0ea5e9":"var(--text-faint)")}
                >
                  {showAdvSearch?"cancel":"advanced search"}
                </button>
              </div>

              {/* Quick search dropdown */}
              {(()=>{
                if(!patientSearch.trim()||showAdvSearch)return null;
                const q=patientSearch.trim().toLowerCase();
                // Support "last, first" and "first last" formats
                const matchName=(name:string)=>{
                  const n=name.toLowerCase();
                  if(n.includes(q))return true;
                  // "last, first" → try matching "first last"
                  const parts=q.split(/,\s*/);
                  if(parts.length===2){
                    const reversed=`${parts[1].trim()} ${parts[0].trim()}`;
                    if(n.includes(reversed))return true;
                  }
                  // "first last" → try matching "last, first"
                  const words=q.split(/\s+/);
                  if(words.length===2){
                    const flipped=`${words[1]}, ${words[0]}`;
                    if(n.includes(flipped)||n.startsWith(words[1]))return true;
                  }
                  return false;
                };
                const results=patients.filter(p=>matchName(p.name)).slice(0,8);
                if(!results.length)return null;
                return(
                  <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:200,
                    background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:8,
                    minWidth:240,boxShadow:`0 4px 12px var(--shadow)`}}>
                    {results.map(p=>(
                      <button key={p.id} onClick={()=>{openPatient(p);setAdding(false);setPatientSearch("");}} style={{
                        width:"100%",textAlign:"left",padding:"8px 12px",border:"none",
                        background:"transparent",cursor:"pointer",fontFamily:"inherit",
                        borderBottom:"1px solid var(--bg-app)",
                      }}
                        onMouseEnter={e=>(e.currentTarget.style.background="var(--bg-hover)")}
                        onMouseLeave={e=>(e.currentTarget.style.background="transparent")}
                      >
                        <div style={{color:"var(--text-primary)",fontSize:12,fontWeight:600}}>{p.name}</div>
                        <div style={{color:"var(--text-label)",fontSize:10}}>{p.dob} · {ageFromDob(p.dob).display}</div>
                      </button>
                    ))}
                  </div>
                );
              })()}

              {/* Advanced search panel */}
              {showAdvSearch&&(
                <div style={{position:"absolute",top:"calc(100% + 22px)",right:0,zIndex:200,
                  background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:10,
                  width:320,boxShadow:`0 4px 16px var(--shadow-heavy)`,padding:"14px 16px"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"var(--text-muted)",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.5px"}}>Advanced Search</div>
                  {([
                    ["phone","Phone","tel"],
                    ["dob","Date of Birth","date"],
                    ["email","Email","email"],
                    ["address","Address","text"],
                    ["city","City","text"],
                    ["state","State","text"],
                    ["zip","ZIP","text"],
                  ] as [keyof typeof advSearch,string,string][]).map(([field,label,type])=>(
                    <div key={field} style={{marginBottom:8}}>
                      <label style={{fontSize:10,color:"var(--text-label)",display:"block",marginBottom:3}}>{label}</label>
                      <input type={type} value={advSearch[field]}
                        onChange={e=>setAdvSearch(a=>({...a,[field]:e.target.value}))}
                        style={{...S.input,fontSize:11,padding:"5px 8px"}}/>
                    </div>
                  ))}
                  {/* Results */}
                  {(()=>{
                    const hasQuery=Object.values(advSearch).some(v=>v.trim());
                    if(!hasQuery)return(
                      <div style={{fontSize:11,color:"var(--text-faint)",textAlign:"center",padding:"8px 0"}}>Enter fields to search</div>
                    );
                    const results=patients.filter(p=>{
                      if(advSearch.phone.trim()&&!(p.phone||"").replace(/\D/g,"").includes(advSearch.phone.replace(/\D/g,"")))return false;
                      if(advSearch.dob.trim()&&p.dob!==advSearch.dob)return false;
                      if(advSearch.email.trim()&&!(p.email||"").toLowerCase().includes(advSearch.email.toLowerCase()))return false;
                      if(advSearch.address.trim()&&!(p.address||"").toLowerCase().includes(advSearch.address.toLowerCase()))return false;
                      if(advSearch.city.trim()&&!(p.city||"").toLowerCase().includes(advSearch.city.toLowerCase()))return false;
                      if(advSearch.state.trim()&&!(p.state||"").toLowerCase().includes(advSearch.state.toLowerCase()))return false;
                      if(advSearch.zip.trim()&&!(p.zip||"").includes(advSearch.zip.trim()))return false;
                      return true;
                    });
                    if(!results.length)return(
                      <div style={{fontSize:11,color:"var(--text-faint)",textAlign:"center",padding:"8px 0"}}>No patients found</div>
                    );
                    return(
                      <div style={{borderTop:"1px solid var(--border)",marginTop:8,paddingTop:8}}>
                        <div style={{fontSize:10,color:"var(--text-label)",marginBottom:6}}>{results.length} result{results.length!==1?"s":""}</div>
                        {results.slice(0,6).map(p=>(
                          <button key={p.id} onClick={()=>{openPatient(p);setAdding(false);setShowAdvSearch(false);setAdvSearch({phone:"",dob:"",email:"",address:"",city:"",state:"",zip:"",});}} style={{
                            width:"100%",textAlign:"left",padding:"7px 8px",border:"none",
                            background:"transparent",cursor:"pointer",fontFamily:"inherit",
                            borderRadius:6,marginBottom:2,
                          }}
                            onMouseEnter={e=>(e.currentTarget.style.background="var(--bg-hover)")}
                            onMouseLeave={e=>(e.currentTarget.style.background="transparent")}
                          >
                            <div style={{color:"var(--text-primary)",fontSize:12,fontWeight:600}}>{p.name}</div>
                            <div style={{color:"var(--text-label)",fontSize:10}}>
                              {[p.dob,p.phone,p.city].filter(Boolean).join(" · ")}
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  <button onClick={()=>{setAdvSearch({phone:"",dob:"",email:"",address:"",city:"",state:"",zip:""});}}
                    style={{marginTop:8,background:"none",border:"none",color:"var(--text-faint)",fontSize:10,cursor:"pointer",fontFamily:"inherit",padding:0}}
                    onMouseEnter={e=>(e.currentTarget.style.color="var(--text-muted)")}
                    onMouseLeave={e=>(e.currentTarget.style.color="var(--text-faint)")}
                  >clear fields</button>
                </div>
              )}
            </div>
          )}
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <div style={{display:"flex",gap:6,alignItems:"center",cursor:"default",position:"relative"}}
              title={RELAY_URL}>
              <div style={{width:7,height:7,borderRadius:"50%",
                background:relay.status==="connected"?(relay.queueCount>0?"#38bdf8":ST_COL.connected):
                  relay.cacheInfo.eventCount>0?"#fbbf24":ST_COL[relay.status]||ST_COL.disconnected,
                boxShadow:relay.status==="connected"?(relay.queueCount>0?"0 0 6px rgba(56,189,248,0.4)":`0 0 6px ${ST_COL.connected}`):
                  relay.cacheInfo.eventCount>0?"0 0 6px rgba(251,191,36,0.3)":"none",
                animation:relay.status==="connecting"||(relay.queueCount>0)?"pulse 1s ease-in-out infinite":"none"}}/>
              <span style={{
                color:relay.status==="connected"?(relay.queueCount>0?"#38bdf8":ST_COL.connected):
                  relay.cacheInfo.eventCount>0?"#fbbf24":ST_COL[relay.status]||ST_COL.disconnected,
                fontSize:11}}>
                {relay.status==="connected"?(relay.queueCount>0?`Connected · Syncing ${relay.queueCount} pending…`:"Connected"):
                 relay.status==="connecting"?"Connecting…":
                 relay.cacheInfo.eventCount>0?`Offline · ${relay.cacheInfo.eventCount.toLocaleString()} cached${relay.queueCount>0?` · ${relay.queueCount} pending`:""}`:
                 relay.queueCount>0?`Reconnecting… · ${relay.queueCount} pending`:
                 "Reconnecting…"}
              </span>
            </div>
            <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
            <Badge t="🔐 NIP-44 active" col="#a78bfa"/>
            <button onClick={handleSignOut} style={{
              background:"transparent",border:"1px solid var(--border)",borderRadius:6,
              padding:"3px 10px",color:"var(--text-muted)",fontSize:11,cursor:"pointer",
              fontFamily:"inherit",transition:"all 0.2s",
            }}
              onMouseEnter={e=>{e.currentTarget.style.color="#f87171";e.currentTarget.style.borderColor="#f8717144";}}
              onMouseLeave={e=>{e.currentTarget.style.color="var(--text-muted)";e.currentTarget.style.borderColor="var(--border)";}}
            >Sign Out</button>
          </div>
        </div>

        {/* Patient tabs (when Patients view is active and patients are open) */}
        {view==="patients"&&openPatients.length>0&&(
          <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"1px solid var(--border-subtle)",paddingBottom:0}}>
            {openPatients.map((p, index) => (
              <div 
                key={p.id}
                draggable
                onDragStart={() => setDraggedTabId(p.id)}
                onDragEnd={() => setDraggedTabId(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (draggedTabId && draggedTabId !== p.id) {
                    const draggedIndex = openPatients.findIndex(pt => pt.id === draggedTabId);
                    if (draggedIndex !== index) {
                      reorderTabs(draggedIndex, index);
                    }
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: activePatientId === p.id ? "var(--bg-card)" : "transparent",
                  padding: "8px 12px",
                  borderRadius: "8px 8px 0 0",
                  border: activePatientId === p.id ? "1px solid var(--border)" : "1px solid transparent",
                  borderBottom: "none",
                  cursor: draggedTabId === p.id ? "grabbing" : "grab",
                  opacity: draggedTabId === p.id ? 0.5 : 1,
                  transition: "opacity 0.2s"
                }}
              >
                <span 
                  onClick={() => setActivePatientId(p.id)} 
                  style={{
                    fontSize: 12,
                    fontWeight: activePatientId === p.id ? 600 : 400,
                    color: activePatientId === p.id ? "var(--text-primary)" : "var(--text-muted)",
                    cursor: "pointer"
                  }}
                >
                  {p.name}
                </span>
                <button 
                  onClick={() => closePatient(p.id)} 
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-muted)",
                    fontSize: 16,
                    cursor: "pointer",
                    padding: 0,
                    lineHeight: 1
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Content area — no side padding; PatientChart adds its own except on messages tab */}
        {view==="schedule"&&!activePatient&&<CalendarView onStartVideo={(id,name,pk)=>setVideoCall({appointmentId:id,patientName:name,patientPkHex:pk})} onOpenChart={(npub)=>{const p=patients.find(pt=>pt.npub===npub);if(p)openPatient(p);}} keys={keys} relay={relay}/>}
        {view==="settings"&&!activePatient&&<SettingsView keys={keys} relay={relay}/>}
        {view==="inbox"&&!activePatient&&keys&&(
          <InboxView
            keys={keys}
            relay={relay}
            patients={patients}
            onUnreadChange={setInboxUnread}
            onOpenPatientMessages={(patientId,rootId)=>{
              const pt=patients.find(p=>p.id===patientId);
              if(pt){
                setPatientInitialTabs(t=>({...t,[patientId]:"messages"}));
                setPatientInitialThreads(t=>({...t,[patientId]:rootId}));
                setInboxClickCount(c=>c+1);
                openPatient(pt);
                setAdding(false);
              }
            }}
          />
        )}
        {adding&&(
          <div style={{display:activePatient?"none":"block"}}>
            <AddPatientForm onAdd={handleAdd} onCancel={()=>setAdding(false)} keys={keys} relay={relay}/>
          </div>
        )}
        {!activePatient&&!adding&&view==="patients"&&(
          <div style={{...S.card,textAlign:"center",padding:48,color:"var(--text-faint)"}}>
            <div style={{fontSize:32,marginBottom:12}}>🩺</div>
            <div style={{fontSize:14,fontWeight:600,color:"var(--text-label)",marginBottom:8}}>
              {PRACTICE_NAME}
            </div>
            <div style={{fontSize:12,marginBottom:20}}>Select a patient from the list{keys?.pkHex===PRACTICE_PUBKEY?" or add a new one":""}</div>
            {keys?.pkHex===PRACTICE_PUBKEY&&<Btn solid col="#0ea5e9" onClick={()=>setAdding(true)}>+ Add Patient</Btn>}
          </div>
        )}
        {activePatient&&(
          <PatientChart patient={activePatient} keys={keys} relay={relay}
            initialTab={(patientInitialTabs[activePatient.id] as ChartTab|undefined)}
            initialThreadId={patientInitialThreads[activePatient.id]}
            inboxClickCount={inboxClickCount}
            onPatientUpdated={p=>{
              setOpenPatients(openPatients.map(op=>op.id===p.id?p:op));
              setPatients(loadPatients());
            }}/>
        )}

        {/* Video Call Overlay */}
      {videoCall && keys && (
        <VideoRoom
          appointmentId={videoCall.appointmentId}
          role="provider"
          sk={keys.sk}
          localPkHex={keys.pkHex}
          remotePkHex={videoCall.patientPkHex}
          relay={relay}
          remoteName={videoCall.patientName}
          onClose={() => setVideoCall(null)}
          calendarApi={CALENDAR_URL}
          turnApiKey={TURN_API_KEY}
        />
      )}

        {/* Close confirmation dialog */}
        {closeConfirm.show&&closeConfirm.newPatient&&(
          <div style={{
              position:"fixed",top:0,left:0,right:0,bottom:0,
              background:"var(--shadow-heavy)",display:"flex",alignItems:"center",
              justifyContent:"center",zIndex:1000
            }}>
            <div style={{...S.card,maxWidth:400,padding:24}}>
              <div style={{fontSize:16,fontWeight:700,marginBottom:12}}>
                Maximum 4 Patient Charts Open
              </div>
              <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:20}}>
                You already have 4 patient charts open. Which one would you like to close to open <strong>{closeConfirm.newPatient.name}</strong>?
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
                {openPatients.map(p=>(
                  <button key={p.id} onClick={()=>replacePatient(p.id,closeConfirm.newPatient!)} style={{
                    ...S.card,background:"var(--bg-app)",border:"1px solid var(--border)",
                    padding:"10px 14px",cursor:"pointer",textAlign:"left",
                    fontSize:13,fontFamily:"inherit",color:"var(--text-primary)"
                  }}>
                    Close: {p.name}
                  </button>
                ))}
              </div>
              <Btn onClick={()=>setCloseConfirm({show:false,newPatient:null})} col="#64748b">
                Cancel
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
    </StaffCtx.Provider>
  );
}
