/**
 * src/lib/terminology.ts
 * Local curated terminology for pediatric diagnoses
 * SNOMED CT + ICD-10-CM codes
 * Custom entries persist in localStorage
 */

export interface DiagnosisTerm {
  display: string;        // Human-readable name
  snomed?: string;        // SNOMED CT code
  icd10?: string;         // ICD-10-CM code
  category?: string;      // For grouping in search results
  custom?: boolean;       // User-added term
}

// ─── Custom term persistence ────────────────────────────────────────────────
const CUSTOM_TERMS_KEY = "nostr_ehr_custom_diagnoses";

export function loadCustomTerms(): DiagnosisTerm[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TERMS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveCustomTerm(term: DiagnosisTerm): void {
  const existing = loadCustomTerms();
  // Avoid duplicates by display name (case-insensitive)
  if (!existing.find(t => t.display.toLowerCase() === term.display.toLowerCase())) {
    existing.push({ ...term, custom: true });
    localStorage.setItem(CUSTOM_TERMS_KEY, JSON.stringify(existing));
  }
}

export function removeCustomTerm(display: string): void {
  const existing = loadCustomTerms().filter(t => t.display.toLowerCase() !== display.toLowerCase());
  localStorage.setItem(CUSTOM_TERMS_KEY, JSON.stringify(existing));
}

// ─── Search ─────────────────────────────────────────────────────────────────
export function searchDiagnoses(query: string, limit = 20): DiagnosisTerm[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase().trim();
  const all = [...PEDIATRIC_DIAGNOSES, ...loadCustomTerms()];

  // Score matches: exact start > word start > contains
  const scored = all
    .map(t => {
      const d = t.display.toLowerCase();
      const icd = (t.icd10 || "").toLowerCase();
      const snomed = (t.snomed || "").toLowerCase();
      let score = 0;
      if (d === q) score = 100;
      else if (d.startsWith(q)) score = 80;
      else if (d.split(/[\s,/-]+/).some(w => w.startsWith(q))) score = 60;
      else if (d.includes(q)) score = 40;
      else if (icd.startsWith(q) || snomed.startsWith(q)) score = 50;
      else if (icd.includes(q) || snomed.includes(q)) score = 30;
      return { term: t, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.term.display.localeCompare(b.term.display));

  return scored.slice(0, limit).map(s => s.term);
}

// ─── Curated pediatric diagnoses ────────────────────────────────────────────
// Organized by category for maintainability
// Sources: AAP common pediatric diagnoses, ICD-10-CM 2024, SNOMED CT US Edition

export const PEDIATRIC_DIAGNOSES: DiagnosisTerm[] = [
  // ── Respiratory ──────────────────────────────────────────────────────────
  { display: "Asthma, mild intermittent", snomed: "426979002", icd10: "J45.20", category: "Respiratory" },
  { display: "Asthma, mild persistent", snomed: "426656000", icd10: "J45.30", category: "Respiratory" },
  { display: "Asthma, moderate persistent", snomed: "427295004", icd10: "J45.40", category: "Respiratory" },
  { display: "Asthma, severe persistent", snomed: "427603009", icd10: "J45.50", category: "Respiratory" },
  { display: "Asthma, exercise-induced", snomed: "233683003", icd10: "J45.990", category: "Respiratory" },
  { display: "Reactive airway disease", snomed: "31387002", icd10: "J68.3", category: "Respiratory" },
  { display: "Acute upper respiratory infection", snomed: "54150009", icd10: "J06.9", category: "Respiratory" },
  { display: "Acute bronchiolitis, RSV", snomed: "6142004", icd10: "J21.0", category: "Respiratory" },
  { display: "Acute bronchiolitis, unspecified", snomed: "4120002", icd10: "J21.9", category: "Respiratory" },
  { display: "Acute bronchitis", snomed: "10509002", icd10: "J20.9", category: "Respiratory" },
  { display: "Croup (acute laryngotracheitis)", snomed: "71186008", icd10: "J05.0", category: "Respiratory" },
  { display: "Pneumonia, unspecified organism", snomed: "233604007", icd10: "J18.9", category: "Respiratory" },
  { display: "Pneumonia, viral", snomed: "75570004", icd10: "J12.9", category: "Respiratory" },
  { display: "Pneumonia, bacterial", snomed: "53084003", icd10: "J15.9", category: "Respiratory" },
  { display: "Allergic rhinitis, seasonal", snomed: "367498001", icd10: "J30.2", category: "Respiratory" },
  { display: "Allergic rhinitis, perennial", snomed: "446096008", icd10: "J30.89", category: "Respiratory" },
  { display: "Sinusitis, acute", snomed: "15805002", icd10: "J01.90", category: "Respiratory" },
  { display: "Sinusitis, chronic", snomed: "40055000", icd10: "J32.9", category: "Respiratory" },
  { display: "Nasal congestion", snomed: "68235000", icd10: "R09.81", category: "Respiratory" },
  { display: "Epistaxis (nosebleed)", snomed: "12441001", icd10: "R04.0", category: "Respiratory" },
  { display: "Influenza with other respiratory manifestations", snomed: "6142004", icd10: "J11.1", category: "Respiratory" },
  { display: "COVID-19", snomed: "840539006", icd10: "U07.1", category: "Respiratory" },

  // ── ENT / Ear ────────────────────────────────────────────────────────────
  { display: "Acute otitis media, right ear", snomed: "194281003", icd10: "H66.91", category: "ENT" },
  { display: "Acute otitis media, left ear", snomed: "194281003", icd10: "H66.92", category: "ENT" },
  { display: "Acute otitis media, bilateral", snomed: "194281003", icd10: "H66.93", category: "ENT" },
  { display: "Otitis media with effusion", snomed: "65363002", icd10: "H65.90", category: "ENT" },
  { display: "Otitis externa", snomed: "3135009", icd10: "H60.90", category: "ENT" },
  { display: "Cerumen impaction", snomed: "18070006", icd10: "H61.20", category: "ENT" },
  { display: "Pharyngitis, acute (sore throat)", snomed: "405737000", icd10: "J02.9", category: "ENT" },
  { display: "Streptococcal pharyngitis (strep throat)", snomed: "43878008", icd10: "J02.0", category: "ENT" },
  { display: "Tonsillitis, acute", snomed: "17741008", icd10: "J03.90", category: "ENT" },
  { display: "Peritonsillar abscess", snomed: "18099001", icd10: "J36", category: "ENT" },
  { display: "Hearing loss, sensorineural, unilateral", snomed: "60700002", icd10: "H90.5", category: "ENT" },
  { display: "Hearing loss, conductive", snomed: "44057004", icd10: "H90.2", category: "ENT" },

  // ── GI / Abdominal ──────────────────────────────────────────────────────
  { display: "Acute gastroenteritis", snomed: "25374005", icd10: "K52.9", category: "GI" },
  { display: "Viral gastroenteritis", snomed: "240370009", icd10: "A08.4", category: "GI" },
  { display: "Gastroesophageal reflux disease (GERD)", snomed: "235595009", icd10: "K21.0", category: "GI" },
  { display: "Gastroesophageal reflux without esophagitis", snomed: "196731005", icd10: "K21.9", category: "GI" },
  { display: "Constipation, functional", snomed: "236069009", icd10: "K59.04", category: "GI" },
  { display: "Encopresis", snomed: "302751001", icd10: "R15.9", category: "GI" },
  { display: "Abdominal pain, unspecified", snomed: "21522001", icd10: "R10.9", category: "GI" },
  { display: "Abdominal pain, periumbilical", snomed: "21522001", icd10: "R10.33", category: "GI" },
  { display: "Nausea and vomiting", snomed: "16932000", icd10: "R11.2", category: "GI" },
  { display: "Diarrhea, unspecified", snomed: "62315008", icd10: "R19.7", category: "GI" },
  { display: "Celiac disease", snomed: "396331005", icd10: "K90.0", category: "GI" },
  { display: "Lactose intolerance", snomed: "267425008", icd10: "E73.9", category: "GI" },
  { display: "Cow's milk protein allergy", snomed: "782555009", icd10: "K52.29", category: "GI" },
  { display: "Appendicitis, acute", snomed: "85189001", icd10: "K35.80", category: "GI" },
  { display: "Pyloric stenosis", snomed: "7111002", icd10: "K31.1", category: "GI" },
  { display: "Failure to thrive", snomed: "432788009", icd10: "R62.51", category: "GI" },

  // ── Dermatology ──────────────────────────────────────────────────────────
  { display: "Atopic dermatitis (eczema), mild", snomed: "24079001", icd10: "L20.9", category: "Dermatology" },
  { display: "Atopic dermatitis (eczema), moderate", snomed: "24079001", icd10: "L20.9", category: "Dermatology" },
  { display: "Atopic dermatitis (eczema), severe", snomed: "24079001", icd10: "L20.9", category: "Dermatology" },
  { display: "Contact dermatitis", snomed: "40275004", icd10: "L25.9", category: "Dermatology" },
  { display: "Diaper dermatitis", snomed: "91487003", icd10: "L22", category: "Dermatology" },
  { display: "Seborrheic dermatitis (cradle cap)", snomed: "86708008", icd10: "L21.0", category: "Dermatology" },
  { display: "Urticaria (hives)", snomed: "126485001", icd10: "L50.9", category: "Dermatology" },
  { display: "Impetigo", snomed: "48277006", icd10: "L01.00", category: "Dermatology" },
  { display: "Cellulitis, unspecified", snomed: "128045006", icd10: "L03.90", category: "Dermatology" },
  { display: "Abscess, cutaneous", snomed: "44132006", icd10: "L02.91", category: "Dermatology" },
  { display: "Tinea corporis (ringworm)", snomed: "47382004", icd10: "B35.4", category: "Dermatology" },
  { display: "Tinea capitis", snomed: "5441008", icd10: "B35.0", category: "Dermatology" },
  { display: "Tinea pedis (athlete's foot)", snomed: "6020002", icd10: "B35.3", category: "Dermatology" },
  { display: "Verruca vulgaris (common wart)", snomed: "735510005", icd10: "B07.8", category: "Dermatology" },
  { display: "Molluscum contagiosum", snomed: "40070004", icd10: "B08.1", category: "Dermatology" },
  { display: "Acne vulgaris, mild", snomed: "11381005", icd10: "L70.0", category: "Dermatology" },
  { display: "Acne vulgaris, moderate", snomed: "11381005", icd10: "L70.0", category: "Dermatology" },
  { display: "Acne vulgaris, severe", snomed: "11381005", icd10: "L70.0", category: "Dermatology" },
  { display: "Insect bite, nonvenomous", snomed: "276433004", icd10: "T14.1", category: "Dermatology" },
  { display: "Scabies", snomed: "128869009", icd10: "B86", category: "Dermatology" },
  { display: "Head lice (pediculosis capitis)", snomed: "81000006", icd10: "B85.0", category: "Dermatology" },
  { display: "Alopecia areata", snomed: "68225006", icd10: "L63.9", category: "Dermatology" },

  // ── Infectious Disease ───────────────────────────────────────────────────
  { display: "Hand, foot, and mouth disease", snomed: "266104002", icd10: "B08.4", category: "Infectious" },
  { display: "Fifth disease (erythema infectiosum)", snomed: "52079000", icd10: "B08.3", category: "Infectious" },
  { display: "Roseola (exanthem subitum)", snomed: "51490003", icd10: "B08.20", category: "Infectious" },
  { display: "Varicella (chickenpox)", snomed: "38907003", icd10: "B01.9", category: "Infectious" },
  { display: "Scarlet fever", snomed: "30242009", icd10: "A38.9", category: "Infectious" },
  { display: "Mononucleosis", snomed: "271558008", icd10: "B27.90", category: "Infectious" },
  { display: "Conjunctivitis, viral", snomed: "9826008", icd10: "B30.9", category: "Infectious" },
  { display: "Conjunctivitis, bacterial", snomed: "243321009", icd10: "H10.029", category: "Infectious" },
  { display: "Conjunctivitis, allergic", snomed: "231857006", icd10: "H10.45", category: "Infectious" },
  { display: "Oral thrush (oral candidiasis)", snomed: "79740000", icd10: "B37.0", category: "Infectious" },
  { display: "Candidal diaper rash", snomed: "72000004", icd10: "B37.2", category: "Infectious" },
  { display: "Pinworms (enterobiasis)", snomed: "426836004", icd10: "B80", category: "Infectious" },
  { display: "Urinary tract infection", snomed: "68566005", icd10: "N39.0", category: "Infectious" },
  { display: "Periorbital cellulitis", snomed: "75543006", icd10: "H05.019", category: "Infectious" },
  { display: "Lymphadenitis, cervical", snomed: "127087002", icd10: "L04.0", category: "Infectious" },

  // ── Behavioral / Developmental / Mental Health ───────────────────────────
  { display: "ADHD, predominantly inattentive", snomed: "192023006", icd10: "F90.0", category: "Behavioral" },
  { display: "ADHD, predominantly hyperactive/impulsive", snomed: "192023006", icd10: "F90.1", category: "Behavioral" },
  { display: "ADHD, combined type", snomed: "406506008", icd10: "F90.2", category: "Behavioral" },
  { display: "Generalized anxiety disorder", snomed: "21897009", icd10: "F41.1", category: "Behavioral" },
  { display: "Separation anxiety disorder", snomed: "428550005", icd10: "F93.0", category: "Behavioral" },
  { display: "Social anxiety disorder", snomed: "25501002", icd10: "F40.10", category: "Behavioral" },
  { display: "Major depressive disorder, single episode, mild", snomed: "79298009", icd10: "F32.0", category: "Behavioral" },
  { display: "Major depressive disorder, single episode, moderate", snomed: "79298009", icd10: "F32.1", category: "Behavioral" },
  { display: "Adjustment disorder with depressed mood", snomed: "192042003", icd10: "F43.21", category: "Behavioral" },
  { display: "Adjustment disorder with anxiety", snomed: "192039006", icd10: "F43.22", category: "Behavioral" },
  { display: "Oppositional defiant disorder", snomed: "78640007", icd10: "F91.3", category: "Behavioral" },
  { display: "Autism spectrum disorder", snomed: "35919005", icd10: "F84.0", category: "Behavioral" },
  { display: "Autism spectrum disorder, requiring support", snomed: "35919005", icd10: "F84.0", category: "Behavioral" },
  { display: "Autism spectrum disorder, requiring substantial support", snomed: "35919005", icd10: "F84.0", category: "Behavioral" },
  { display: "Specific learning disorder, reading (dyslexia)", snomed: "59770009", icd10: "F81.0", category: "Behavioral" },
  { display: "Specific learning disorder, math (dyscalculia)", snomed: "48631000", icd10: "F81.2", category: "Behavioral" },
  { display: "Speech sound disorder", snomed: "229721007", icd10: "F80.0", category: "Behavioral" },
  { display: "Expressive language disorder", snomed: "47900007", icd10: "F80.1", category: "Behavioral" },
  { display: "Mixed receptive-expressive language disorder", snomed: "62545002", icd10: "F80.2", category: "Behavioral" },
  { display: "Developmental coordination disorder", snomed: "363235000", icd10: "F82", category: "Behavioral" },
  { display: "Global developmental delay", snomed: "224958001", icd10: "F88", category: "Behavioral" },
  { display: "Intellectual disability, mild", snomed: "86765009", icd10: "F70", category: "Behavioral" },
  { display: "Enuresis (bedwetting)", snomed: "8009008", icd10: "F98.0", category: "Behavioral" },
  { display: "Tic disorder", snomed: "44913001", icd10: "F95.9", category: "Behavioral" },
  { display: "Tourette syndrome", snomed: "5765002", icd10: "F95.2", category: "Behavioral" },
  { display: "Selective mutism", snomed: "247581009", icd10: "F94.0", category: "Behavioral" },
  { display: "Insomnia, behavioral", snomed: "193462001", icd10: "F51.02", category: "Behavioral" },
  { display: "Obsessive-compulsive disorder", snomed: "191736004", icd10: "F42.9", category: "Behavioral" },
  { display: "Post-traumatic stress disorder", snomed: "47505003", icd10: "F43.10", category: "Behavioral" },

  // ── Musculoskeletal / Orthopedic ─────────────────────────────────────────
  { display: "Growing pains", snomed: "88424005", icd10: "M79.3", category: "MSK" },
  { display: "Flat feet (pes planus)", snomed: "53226007", icd10: "M21.40", category: "MSK" },
  { display: "In-toeing (metatarsus adductus)", snomed: "397012009", icd10: "Q66.22", category: "MSK" },
  { display: "Nursemaid's elbow (radial head subluxation)", snomed: "50744008", icd10: "S53.001A", category: "MSK" },
  { display: "Torticollis, congenital muscular", snomed: "84301002", icd10: "Q68.0", category: "MSK" },
  { display: "Scoliosis, adolescent idiopathic", snomed: "203639008", icd10: "M41.129", category: "MSK" },
  { display: "Back pain, low", snomed: "279039007", icd10: "M54.5", category: "MSK" },
  { display: "Knee pain", snomed: "30989003", icd10: "M25.569", category: "MSK" },
  { display: "Osgood-Schlatter disease", snomed: "72047008", icd10: "M92.50", category: "MSK" },
  { display: "Sprain, ankle", snomed: "44465007", icd10: "S93.409A", category: "MSK" },
  { display: "Fracture, forearm", snomed: "263225007", icd10: "S52.90", category: "MSK" },
  { display: "Developmental dysplasia of hip", snomed: "54781000", icd10: "Q65.89", category: "MSK" },
  { display: "Plagiocephaly (flat head)", snomed: "21850008", icd10: "Q67.3", category: "MSK" },

  // ── Allergic / Immunologic ───────────────────────────────────────────────
  { display: "Food allergy, peanut", snomed: "91935009", icd10: "T78.01", category: "Allergy" },
  { display: "Food allergy, tree nut", snomed: "91934008", icd10: "T78.09", category: "Allergy" },
  { display: "Food allergy, egg", snomed: "91930004", icd10: "T78.09", category: "Allergy" },
  { display: "Food allergy, milk", snomed: "782555009", icd10: "T78.07", category: "Allergy" },
  { display: "Food allergy, unspecified", snomed: "414285001", icd10: "T78.1", category: "Allergy" },
  { display: "Anaphylaxis", snomed: "39579001", icd10: "T78.2", category: "Allergy" },
  { display: "Allergic reaction, unspecified", snomed: "421961002", icd10: "T78.40", category: "Allergy" },
  { display: "Drug allergy", snomed: "416098002", icd10: "T88.7", category: "Allergy" },
  { display: "Angioedema", snomed: "41291007", icd10: "T78.3", category: "Allergy" },

  // ── Endocrine / Metabolic ────────────────────────────────────────────────
  { display: "Obesity, childhood", snomed: "190966007", icd10: "E66.01", category: "Endocrine" },
  { display: "Overweight", snomed: "238131007", icd10: "E66.3", category: "Endocrine" },
  { display: "Short stature", snomed: "237837007", icd10: "E34.3", category: "Endocrine" },
  { display: "Constitutional growth delay", snomed: "276587009", icd10: "E34.3", category: "Endocrine" },
  { display: "Type 1 diabetes mellitus", snomed: "46635009", icd10: "E10.9", category: "Endocrine" },
  { display: "Type 2 diabetes mellitus", snomed: "44054006", icd10: "E11.9", category: "Endocrine" },
  { display: "Hypothyroidism, acquired", snomed: "40930008", icd10: "E03.9", category: "Endocrine" },
  { display: "Congenital hypothyroidism", snomed: "190268003", icd10: "E03.1", category: "Endocrine" },
  { display: "Hyperthyroidism", snomed: "34486009", icd10: "E05.90", category: "Endocrine" },
  { display: "Precocious puberty", snomed: "400179000", icd10: "E30.1", category: "Endocrine" },
  { display: "Delayed puberty", snomed: "400003000", icd10: "E30.0", category: "Endocrine" },
  { display: "Gynecomastia, pubertal", snomed: "4754008", icd10: "N62", category: "Endocrine" },
  { display: "Vitamin D deficiency", snomed: "34713006", icd10: "E55.9", category: "Endocrine" },
  { display: "Iron deficiency anemia", snomed: "87522002", icd10: "D50.9", category: "Endocrine" },

  // ── Genitourinary ────────────────────────────────────────────────────────
  { display: "Phimosis", snomed: "449826002", icd10: "N47.1", category: "GU" },
  { display: "Balanitis", snomed: "44882003", icd10: "N48.1", category: "GU" },
  { display: "Undescended testicle, unilateral", snomed: "204878001", icd10: "Q53.10", category: "GU" },
  { display: "Hydrocele", snomed: "55434001", icd10: "N43.3", category: "GU" },
  { display: "Inguinal hernia", snomed: "396232000", icd10: "K40.90", category: "GU" },
  { display: "Umbilical hernia", snomed: "396347007", icd10: "K42.9", category: "GU" },
  { display: "Labial adhesion", snomed: "61028005", icd10: "N90.89", category: "GU" },
  { display: "Vulvovaginitis, prepubertal", snomed: "30800001", icd10: "N77.1", category: "GU" },
  { display: "Dysmenorrhea", snomed: "431416009", icd10: "N94.6", category: "GU" },

  // ── Cardiology ───────────────────────────────────────────────────────────
  { display: "Innocent heart murmur (Still's murmur)", snomed: "87801003", icd10: "R01.0", category: "Cardiology" },
  { display: "Ventricular septal defect", snomed: "30288003", icd10: "Q21.0", category: "Cardiology" },
  { display: "Atrial septal defect", snomed: "70142008", icd10: "Q21.1", category: "Cardiology" },
  { display: "Patent ductus arteriosus", snomed: "83330001", icd10: "Q25.0", category: "Cardiology" },
  { display: "Patent foramen ovale", snomed: "204317008", icd10: "Q21.1", category: "Cardiology" },
  { display: "Supraventricular tachycardia", snomed: "6456007", icd10: "I47.1", category: "Cardiology" },
  { display: "Syncope (fainting)", snomed: "271594007", icd10: "R55", category: "Cardiology" },
  { display: "Chest pain, non-cardiac", snomed: "29857009", icd10: "R07.9", category: "Cardiology" },
  { display: "Hypertension, primary", snomed: "59621000", icd10: "I10", category: "Cardiology" },
  { display: "Elevated blood pressure", snomed: "14140009", icd10: "R03.0", category: "Cardiology" },
  { display: "Kawasaki disease", snomed: "75053002", icd10: "M30.3", category: "Cardiology" },

  // ── Neurology ────────────────────────────────────────────────────────────
  { display: "Febrile seizure, simple", snomed: "41497008", icd10: "R56.00", category: "Neurology" },
  { display: "Febrile seizure, complex", snomed: "91175000", icd10: "R56.01", category: "Neurology" },
  { display: "Epilepsy, generalized", snomed: "19598007", icd10: "G40.309", category: "Neurology" },
  { display: "Epilepsy, absence", snomed: "69060004", icd10: "G40.A09", category: "Neurology" },
  { display: "Migraine without aura", snomed: "56097005", icd10: "G43.009", category: "Neurology" },
  { display: "Migraine with aura", snomed: "37796009", icd10: "G43.109", category: "Neurology" },
  { display: "Tension headache", snomed: "398057008", icd10: "G44.209", category: "Neurology" },
  { display: "Headache, unspecified", snomed: "25064002", icd10: "R51.9", category: "Neurology" },
  { display: "Concussion without loss of consciousness", snomed: "62564004", icd10: "S06.0X0A", category: "Neurology" },
  { display: "Cerebral palsy", snomed: "128188000", icd10: "G80.9", category: "Neurology" },
  { display: "Breath-holding spells", snomed: "51194007", icd10: "R06.89", category: "Neurology" },
  { display: "Night terrors", snomed: "59820001", icd10: "F51.4", category: "Neurology" },
  { display: "Sleepwalking", snomed: "65956006", icd10: "F51.3", category: "Neurology" },

  // ── Ophthalmology ────────────────────────────────────────────────────────
  { display: "Amblyopia (lazy eye)", snomed: "387742006", icd10: "H53.009", category: "Ophthalmology" },
  { display: "Strabismus, esotropia", snomed: "16596007", icd10: "H50.00", category: "Ophthalmology" },
  { display: "Strabismus, exotropia", snomed: "399101005", icd10: "H50.10", category: "Ophthalmology" },
  { display: "Nasolacrimal duct obstruction", snomed: "246907003", icd10: "H04.559", category: "Ophthalmology" },
  { display: "Chalazion", snomed: "1482004", icd10: "H00.19", category: "Ophthalmology" },
  { display: "Hordeolum (stye)", snomed: "397513003", icd10: "H00.019", category: "Ophthalmology" },
  { display: "Myopia", snomed: "57190000", icd10: "H52.10", category: "Ophthalmology" },

  // ── Hematology ───────────────────────────────────────────────────────────
  { display: "Iron deficiency without anemia", snomed: "35240004", icd10: "E61.1", category: "Hematology" },
  { display: "Anemia, unspecified", snomed: "271737000", icd10: "D64.9", category: "Hematology" },
  { display: "Sickle cell trait", snomed: "16402000", icd10: "D57.3", category: "Hematology" },
  { display: "Sickle cell disease", snomed: "417357006", icd10: "D57.1", category: "Hematology" },
  { display: "Thrombocytopenia", snomed: "302215000", icd10: "D69.6", category: "Hematology" },
  { display: "Immune thrombocytopenic purpura (ITP)", snomed: "32273002", icd10: "D69.3", category: "Hematology" },
  { display: "Neutropenia", snomed: "165517008", icd10: "D70.9", category: "Hematology" },
  { display: "Lymphadenopathy, generalized", snomed: "30746006", icd10: "R59.1", category: "Hematology" },
  { display: "Lymphadenopathy, localized", snomed: "30746006", icd10: "R59.0", category: "Hematology" },

  // ── Neonatal ─────────────────────────────────────────────────────────────
  { display: "Newborn jaundice, physiologic", snomed: "387712008", icd10: "P59.9", category: "Neonatal" },
  { display: "Newborn jaundice, breast milk", snomed: "206388002", icd10: "P59.3", category: "Neonatal" },
  { display: "Neonatal hyperbilirubinemia", snomed: "387712008", icd10: "P59.9", category: "Neonatal" },
  { display: "Colic, infantile", snomed: "73645005", icd10: "R10.83", category: "Neonatal" },
  { display: "Umbilical granuloma", snomed: "75367002", icd10: "P83.6", category: "Neonatal" },
  { display: "Tongue-tie (ankyloglossia)", snomed: "67787004", icd10: "Q38.1", category: "Neonatal" },
  { display: "Erythema toxicum neonatorum", snomed: "78243000", icd10: "P83.1", category: "Neonatal" },
  { display: "Breastfeeding difficulty", snomed: "82491006", icd10: "P92.5", category: "Neonatal" },
  { display: "Poor weight gain, newborn", snomed: "276610007", icd10: "P92.6", category: "Neonatal" },

  // ── Well Visit / Preventive ──────────────────────────────────────────────
  { display: "Well child visit, newborn", snomed: "170099002", icd10: "Z00.110", category: "Preventive" },
  { display: "Well child visit, infant", snomed: "170099002", icd10: "Z00.129", category: "Preventive" },
  { display: "Well child visit, 1-4 years", snomed: "170099002", icd10: "Z00.129", category: "Preventive" },
  { display: "Well child visit, 5-11 years", snomed: "170099002", icd10: "Z00.129", category: "Preventive" },
  { display: "Well adolescent visit, 12-17 years", snomed: "170099002", icd10: "Z00.129", category: "Preventive" },
  { display: "Well adolescent visit, 18-21 years", snomed: "170099002", icd10: "Z00.129", category: "Preventive" },
  { display: "Sports physical (PPE)", snomed: "310861008", icd10: "Z02.5", category: "Preventive" },
  { display: "Lead screening", snomed: "252856007", icd10: "Z13.88", category: "Preventive" },
  { display: "Developmental screening", snomed: "268545006", icd10: "Z13.40", category: "Preventive" },
  { display: "Autism screening", snomed: "268545006", icd10: "Z13.41", category: "Preventive" },
  { display: "Depression screening, adolescent", snomed: "171207006", icd10: "Z13.31", category: "Preventive" },

  // ── Other / General ──────────────────────────────────────────────────────
  { display: "Fever, unspecified", snomed: "386661006", icd10: "R50.9", category: "General" },
  { display: "Fatigue", snomed: "84229001", icd10: "R53.83", category: "General" },
  { display: "Weight loss, unintentional", snomed: "89362005", icd10: "R63.4", category: "General" },
  { display: "Poor appetite", snomed: "79890006", icd10: "R63.0", category: "General" },
  { display: "Dehydration", snomed: "34095006", icd10: "E86.0", category: "General" },
  { display: "Foreign body in ear", snomed: "432061002", icd10: "T16.9", category: "General" },
  { display: "Foreign body in nose", snomed: "432108000", icd10: "T17.1", category: "General" },
  { display: "Laceration, face", snomed: "283682007", icd10: "S01.90", category: "General" },
  { display: "Laceration, extremity", snomed: "283682007", icd10: "S61.009A", category: "General" },
  { display: "Burns, first degree", snomed: "403190006", icd10: "T30.1", category: "General" },
  { display: "Burns, second degree", snomed: "403191005", icd10: "T30.2", category: "General" },
  { display: "Adverse effect of medication", snomed: "281647001", icd10: "T88.7", category: "General" },
  { display: "Vaccine adverse reaction", snomed: "293104008", icd10: "T50.B95A", category: "General" },
];
