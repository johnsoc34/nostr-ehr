/**
 * src/lib/patients.ts
 * Patient management — persisted to localStorage
 * Each patient gets a UUID and their own FHIR Patient resource on the relay
 */
import { 
  generateSecretKey, 
  getPublicKey, 
  npubEncode, 
  nsecEncode, 
  nsecToBytes,
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
  // Phase 7: Patient portal keypair
  nsec?:     string;   // Patient's secret key (bech32 nsec format)
  npub?:     string;   // Patient's public key (bech32 npub format)
}

const KEY = "nostr_ehr_patients";

export function loadPatients(): Patient[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function savePatients(patients: Patient[]): void {
  localStorage.setItem(KEY, JSON.stringify(patients));
}

export function addPatient(p: Omit<Patient, "id" | "createdAt" | "nsec" | "npub"> & { existingNsec?: string }): Patient {
  let sk: Uint8Array;
  let nsec: string;
  let npub: string;
  
  // Check if using existing nsec
  if (p.existingNsec && p.existingNsec.trim().startsWith('nsec1')) {
    // Use existing key
    console.log('Using existing nsec:', p.existingNsec.substring(0, 10) + '...');
    try {
      sk = nsecToBytes(p.existingNsec.trim());
      console.log('SK decoded successfully, length:', sk.length);
      const pk = getPublicKey(sk);
      nsec = p.existingNsec.trim();
      npub = npubEncode(pk);
      console.log('npub:', npub.substring(0, 20) + '...');
    } catch (error) {
      console.error('nsecToBytes error:', error);
      throw new Error('Invalid nsec format');
    }
  } else {
    // Generate new keypair
    sk = generateSecretKey();
    const pk = getPublicKey(sk);
    nsec = nsecEncode(sk);
    npub = npubEncode(pk);
  }
  
  // Remove existingNsec from patient object
  const { existingNsec, ...patientData } = p;
  
  const patient: Patient = { 
    ...patientData, 
    id: crypto.randomUUID(), 
    createdAt: Date.now(),
    nsec,
npub
  };
  
  const all = loadPatients();
  all.push(patient);
  savePatients(all);
  return patient;
}

export function updatePatient(updated: Patient): void {
  const all = loadPatients().map(p => p.id === updated.id ? updated : p);
  savePatients(all);
}

export function deletePatient(id: string): void {
  savePatients(loadPatients().filter(p => p.id !== id));
}

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
