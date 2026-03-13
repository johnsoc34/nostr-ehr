/**
 * src/lib/patients.ts
 * Patient management — persisted to localStorage
 * Each patient gets a UUID and their own FHIR Patient resource on the relay
 *
 * Phase 19: Universal patient identity model
 *   - keySource: "practice" (we generated/hold keys) | "self" (patient brought their own npub)
 *   - billingModel: "monthly" (membership) | "per-visit" (pay per encounter)
 *   - nsecStored: whether doctor chose to retain nsec locally (practice-keyed patients only)
 *   - addPatientByNpub() for patients who bring their own Nostr identity
 */
import { 
  generateSecretKey, 
  getPublicKey, 
  npubEncode, 
  nsecEncode, 
  nsecToBytes,
  npubToHex,
  toHex 
} from './nostr';

export interface Patient {
  id:        string;   // UUID — used as FHIR patient ID and relay query key
  name:      string;
  dob:       string;   // YYYY-MM-DD
  sex:       "male" | "female" | "other" | "unknown";
  phone?:    string;
  email?:    string;
  address?:  string;
  city?:     string;
  state?:    string;
  zip?:      string;
  createdAt: number;   // Unix timestamp

  // Identity
  nsec?:     string;   // Patient's secret key — only if keySource="practice" AND nsecStored=true
  npub?:     string;   // Patient's public key (bech32 npub format)

  // Phase 19: Universal identity model
  keySource:     "practice" | "self";   // who generated/holds the keys
  billingModel:  "monthly" | "per-visit"; // how they pay
  nsecStored?:   boolean;               // did the doctor choose to retain the nsec locally?

  // Phase 6: Guardian model
  guardianOf?:   string[];       // array of child patient IDs this person is guardian of
  guardianNpub?: string;         // for child patients: their primary guardian's npub
}

const KEY = "nostr_ehr_patients";

// ─── Migration ────────────────────────────────────────────────────────────────
// Existing patients lack keySource/billingModel. Apply sensible defaults.
function migratePatient(p: any): Patient {
  if (!p.keySource) {
    p.keySource = "practice";   // all existing patients were practice-generated
  }
  if (!p.billingModel) {
    p.billingModel = "monthly"; // all existing patients were DPC members
  }
  // Existing patients with nsec stored: mark as explicitly stored
  if (p.keySource === "practice" && p.nsec && p.nsecStored === undefined) {
    p.nsecStored = true;
  }
  return p as Patient;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function loadPatients(): Patient[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as any[];
    return parsed.map(migratePatient);
  } catch { return []; }
}

export function savePatients(patients: Patient[]): void {
  localStorage.setItem(KEY, JSON.stringify(patients));
}

// ─── Create: Practice-keyed patient (generates or imports keypair) ────────────
// Returns { patient, nsec } — nsec is ALWAYS returned for display,
// but only persisted in patient record if storeNsec=true.
export interface PatientCreationResult {
  patient: Patient;
  nsec: string;   // ephemeral — show once, may not be stored
}

export function addPatient(
  p: Omit<Patient, "id" | "createdAt" | "nsec" | "npub" | "keySource" | "billingModel" | "nsecStored"> & {
    existingNsec?: string;
    storeNsec?: boolean;       // doctor's choice — persist nsec in localStorage?
    billingModel?: "monthly" | "per-visit";
  }
): PatientCreationResult {
  let sk: Uint8Array;
  let nsec: string;
  let npub: string;
  
  // Check if using existing nsec
  if (p.existingNsec && p.existingNsec.trim().startsWith('nsec1')) {
    try {
      sk = nsecToBytes(p.existingNsec.trim());
      const pk = getPublicKey(sk);
      nsec = p.existingNsec.trim();
      npub = npubEncode(pk);
    } catch (error) {
      throw new Error('Invalid nsec format');
    }
  } else {
    // Generate new keypair
    sk = generateSecretKey();
    const pk = getPublicKey(sk);
    nsec = nsecEncode(sk);
    npub = npubEncode(pk);
  }
  
  const storeNsec = p.storeNsec ?? false;
  
  // Remove creation-only fields from patient object
  const { existingNsec, storeNsec: _s, billingModel: bm, ...patientData } = p;
  
  const patient: Patient = { 
    ...patientData, 
    id: crypto.randomUUID(), 
    createdAt: Date.now(),
    nsec: storeNsec ? nsec : undefined,
    npub,
    keySource: "practice",
    billingModel: bm || "monthly",
    nsecStored: storeNsec,
  };
  
  const all = loadPatients();
  all.push(patient);
  savePatients(all);

  // Always return nsec for one-time display regardless of storage choice
  return { patient, nsec };
}

// ─── Create: Self-keyed patient (patient brings their own npub) ───────────────
// No keypair generation. No nsec. The practice only knows the public key.
export function addPatientByNpub(p: {
  name:    string;
  dob?:    string;
  sex?:    Patient["sex"];
  phone?:  string;
  email?:  string;
  address?: string;
  city?:   string;
  state?:  string;
  zip?:    string;
  npub:    string;   // bech32 npub1...
  billingModel?: "monthly" | "per-visit";
}): Patient {
  // Validate npub format
  if (!p.npub || !p.npub.trim().startsWith('npub1')) {
    throw new Error('Invalid npub format — must start with npub1');
  }
  // Validate it decodes to a valid 32-byte hex pubkey
  try {
    const hex = npubToHex(p.npub.trim());
    if (hex.length !== 64) throw new Error('Invalid pubkey length');
  } catch (e) {
    throw new Error('Invalid npub — could not decode public key');
  }

  const patient: Patient = {
    id: crypto.randomUUID(),
    name: p.name,
    dob: p.dob || "",
    sex: p.sex || "unknown",
    phone: p.phone,
    email: p.email,
    address: p.address,
    city: p.city,
    state: p.state,
    zip: p.zip,
    createdAt: Date.now(),
    npub: p.npub.trim(),
    // No nsec — patient owns their keys
    keySource: "self",
    billingModel: p.billingModel || "per-visit",
    nsecStored: false,
  };

  const all = loadPatients();
  all.push(patient);
  savePatients(all);
  return patient;
}

// ─── Update / Delete ──────────────────────────────────────────────────────────

export function updatePatient(updated: Patient): void {
  const all = loadPatients().map(p => p.id === updated.id ? updated : p);
  savePatients(all);
}

export function deletePatient(id: string): void {
  savePatients(loadPatients().filter(p => p.id !== id));
}

// ─── Clear stored nsec (doctor decides to remove it after the fact) ───────────
export function clearStoredNsec(patientId: string): void {
  const all = loadPatients().map(p => {
    if (p.id === patientId && p.keySource === "practice") {
      return { ...p, nsec: undefined, nsecStored: false };
    }
    return p;
  });
  savePatients(all);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function ageFromDob(dob: string): { years: number; months: number; display: string } {
  if (!dob) return { years: 0, months: 0, display: "No DOB" };
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return { years: 0, months: 0, display: "Invalid DOB" };
  const now   = new Date();
  let years   = now.getFullYear() - birth.getFullYear();
  let months  = now.getMonth() - birth.getMonth();
  if (months < 0) { years--; months += 12; }
  if (now.getDate() < birth.getDate()) months--;
  const totalMonths = years * 12 + months;
  if (totalMonths < 24) return { years, months, display: `${totalMonths}mo` };
  return { years, months, display: `${years}y ${months}mo` };
}

// ─── Guardian Management ────────────────────────────────────────────────────

/** Link a guardian to a child patient (both directions in localStorage). */
export function linkGuardian(guardianId: string, childId: string, guardianNpub: string): void {
  const all = loadPatients();
  const guardian = all.find(p => p.id === guardianId);
  const child = all.find(p => p.id === childId);
  if (!guardian || !child) throw new Error("Patient not found");

  const existing = guardian.guardianOf || [];
  if (!existing.includes(childId)) {
    guardian.guardianOf = [...existing, childId];
  }
  child.guardianNpub = guardianNpub;
  savePatients(all);
}

/** Unlink a guardian from a child patient. */
export function unlinkGuardian(guardianId: string, childId: string): void {
  const all = loadPatients();
  const guardian = all.find(p => p.id === guardianId);
  const child = all.find(p => p.id === childId);

  if (guardian && guardian.guardianOf) {
    guardian.guardianOf = guardian.guardianOf.filter(id => id !== childId);
    if (guardian.guardianOf.length === 0) delete guardian.guardianOf;
  }
  if (child) delete child.guardianNpub;
  savePatients(all);
}

/** Get all children for a guardian. */
export function getGuardianChildren(guardianId: string): Patient[] {
  const all = loadPatients();
  const guardian = all.find(p => p.id === guardianId);
  if (!guardian?.guardianOf?.length) return [];
  return all.filter(p => guardian.guardianOf!.includes(p.id));
}

/** Get the guardian(s) for a child patient. */
export function getChildGuardians(childId: string): Patient[] {
  const all = loadPatients();
  return all.filter(p => p.guardianOf?.includes(childId));
}
