/**
 * src/lib/cds.ts
 * Clinical Decision Support — Immunization Schedule + Well-Check Intervals
 *
 * Encodes the CDC Recommended Childhood Immunization Schedule (birth–18 years).
 * Evaluates a patient's immunization history against the schedule and returns
 * a status board: green (up to date) or yellow (due/overdue) for each vaccine series.
 *
 * Also computes AAP well-child visit intervals.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VaccineDose {
  /** Minimum age in days to receive this dose */
  minAgeDays: number;
  /** Minimum interval in days since previous dose (0 for first dose) */
  minIntervalDays: number;
  /** Recommended age in days (used for "due" display, not hard logic) */
  recommendedAgeDays: number;
}

export interface VaccineSeries {
  /** Display name */
  name: string;
  /** Short abbreviation for the UI */
  abbrev: string;
  /** Dose schedule */
  doses: VaccineDose[];
  /** Aliases — vaccine names that count toward this series (lowercase) */
  aliases: string[];
  /** Max age in days after which this series no longer applies (null = no max) */
  maxAgeDays: number | null;
  /** Notes for the UI */
  notes?: string;
}

export interface ImmunizationRecord {
  vaccine: string;   // vaccineCode.text from FHIR
  date: string;      // YYYY-MM-DD (occurrenceDateTime)
}

export type VaccineStatus = "up_to_date" | "due" | "complete" | "not_yet";

export interface VaccineEvaluation {
  series: VaccineSeries;
  status: VaccineStatus;
  dosesGiven: number;
  dosesRequired: number;
  /** Dates of doses received (sorted oldest first) */
  datesGiven: string[];
  /** When the next dose is due (null if complete or not yet eligible) */
  nextDueDate: string | null;
  /** Human-readable status message */
  message: string;
}

export interface WellCheckEvaluation {
  status: "up_to_date" | "due" | "overdue" | "unknown";
  lastVisitDate: string | null;
  nextDueDate: string | null;
  nextDueLabel: string;
  message: string;
}

// ─── Helper: days/months/years ────────────────────────────────────────────────

const DAYS = 1;
const WEEKS = 7;
const MONTHS = 30.44;  // average days in a month
const YEARS = 365.25;

function d(n: number) { return Math.round(n); }

// ─── CDC Recommended Childhood Immunization Schedule ──────────────────────────
// Source: CDC 2024 Recommended Immunization Schedule for Children and
//         Adolescents Aged 18 Years or Younger
// https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html

export const CDC_SCHEDULE: VaccineSeries[] = [
  // ── Hepatitis B ──────────────────────────────────────────
  {
    name: "Hepatitis B",
    abbrev: "HepB",
    aliases: ["hep b", "hepatitis b", "hepb", "engerix", "recombivax", "pediarix"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: 0,             minIntervalDays: 0,          recommendedAgeDays: 0 },
      { minAgeDays: d(4 * WEEKS),  minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(1 * MONTHS) },
      { minAgeDays: d(24 * WEEKS), minIntervalDays: d(8 * WEEKS),  recommendedAgeDays: d(6 * MONTHS) },
    ],
  },

  // ── Rotavirus ────────────────────────────────────────────
  // RotaTeq (RV5): 3 doses. Rotarix (RV1): 2 doses.
  // We model the 3-dose series (RV5) as it's more common.
  // Max age for any dose: 8 months 0 days.
  {
    name: "Rotavirus",
    abbrev: "RV",
    aliases: ["rotavirus", "rv", "rotateq", "rotarix", "rv5", "rv1"],
    maxAgeDays: d(8 * MONTHS),
    doses: [
      { minAgeDays: d(6 * WEEKS),  minIntervalDays: 0,          recommendedAgeDays: d(2 * MONTHS) },
      { minAgeDays: d(10 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(4 * MONTHS) },
      { minAgeDays: d(14 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(6 * MONTHS) },
    ],
    notes: "3-dose series (RotaTeq). If Rotarix used, only 2 doses needed.",
  },

  // ── DTaP ─────────────────────────────────────────────────
  {
    name: "DTaP",
    abbrev: "DTaP",
    aliases: ["dtap", "diphtheria", "tetanus", "pertussis", "daptacel", "infanrix", "pediarix", "pentacel", "kinrix", "quadracel", "vaxelis"],
    maxAgeDays: d(7 * YEARS),  // DTaP only through age 6; Tdap after
    doses: [
      { minAgeDays: d(6 * WEEKS),  minIntervalDays: 0,          recommendedAgeDays: d(2 * MONTHS) },
      { minAgeDays: d(10 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(4 * MONTHS) },
      { minAgeDays: d(14 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(6 * MONTHS) },
      { minAgeDays: d(12 * MONTHS),minIntervalDays: d(6 * MONTHS), recommendedAgeDays: d(15 * MONTHS) },
      { minAgeDays: d(4 * YEARS),  minIntervalDays: d(6 * MONTHS), recommendedAgeDays: d(4 * YEARS) },
    ],
  },

  // ── Tdap (booster for adolescents) ───────────────────────
  {
    name: "Tdap",
    abbrev: "Tdap",
    aliases: ["tdap", "adacel", "boostrix"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: d(11 * YEARS), minIntervalDays: 0, recommendedAgeDays: d(11 * YEARS) },
    ],
    notes: "Single booster dose at 11–12 years.",
  },

  // ── Hib ──────────────────────────────────────────────────
  // PRP-OMP (PedvaxHIB): 2-dose primary + booster = 3.
  // PRP-T (ActHIB/Pentacel): 3-dose primary + booster = 4.
  // We model 4-dose series as the more conservative default.
  {
    name: "Hib",
    abbrev: "Hib",
    aliases: ["hib", "haemophilus", "acthib", "pedvaxhib", "pentacel", "vaxelis", "hiberix"],
    maxAgeDays: d(5 * YEARS),
    doses: [
      { minAgeDays: d(6 * WEEKS),  minIntervalDays: 0,          recommendedAgeDays: d(2 * MONTHS) },
      { minAgeDays: d(10 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(4 * MONTHS) },
      { minAgeDays: d(14 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(6 * MONTHS) },
      { minAgeDays: d(12 * MONTHS),minIntervalDays: d(8 * WEEKS),  recommendedAgeDays: d(12 * MONTHS) },
    ],
  },

  // ── PCV (Pneumococcal Conjugate) ─────────────────────────
  {
    name: "Pneumococcal (PCV)",
    abbrev: "PCV",
    aliases: ["pcv", "pcv13", "pcv15", "pcv20", "prevnar", "pneumococcal", "vaxneuvance"],
    maxAgeDays: d(5 * YEARS),
    doses: [
      { minAgeDays: d(6 * WEEKS),  minIntervalDays: 0,          recommendedAgeDays: d(2 * MONTHS) },
      { minAgeDays: d(10 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(4 * MONTHS) },
      { minAgeDays: d(14 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(6 * MONTHS) },
      { minAgeDays: d(12 * MONTHS),minIntervalDays: d(8 * WEEKS),  recommendedAgeDays: d(12 * MONTHS) },
    ],
  },

  // ── IPV (Polio) ──────────────────────────────────────────
  {
    name: "Polio (IPV)",
    abbrev: "IPV",
    aliases: ["ipv", "polio", "pediarix", "kinrix", "quadracel", "pentacel", "vaxelis"],
    maxAgeDays: d(18 * YEARS),
    doses: [
      { minAgeDays: d(6 * WEEKS),  minIntervalDays: 0,          recommendedAgeDays: d(2 * MONTHS) },
      { minAgeDays: d(10 * WEEKS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(4 * MONTHS) },
      { minAgeDays: d(6 * MONTHS), minIntervalDays: d(4 * WEEKS),  recommendedAgeDays: d(6 * MONTHS) },
      { minAgeDays: d(4 * YEARS),  minIntervalDays: d(6 * MONTHS), recommendedAgeDays: d(4 * YEARS) },
    ],
  },

  // ── Influenza ────────────────────────────────────────────
  // Annual, starting at 6 months. First year: 2 doses 4 weeks apart.
  // We model this as: if < 9 years old and < 2 lifetime flu doses, need a dose.
  // Otherwise, check if a flu shot was given in the current season (Aug–Jul).
  {
    name: "Influenza (Flu)",
    abbrev: "Flu",
    aliases: ["flu", "influenza", "fluzone", "fluarix", "flumist", "flucelvax", "flulaval", "afluria"],
    maxAgeDays: null,
    doses: [
      // Modeled as a single-dose series; the evaluator handles annual recurrence
      { minAgeDays: d(6 * MONTHS), minIntervalDays: 0, recommendedAgeDays: d(6 * MONTHS) },
    ],
    notes: "Annual dose. First-time vaccinees < 9 years need 2 doses 4 weeks apart.",
  },

  // ── MMR ──────────────────────────────────────────────────
  {
    name: "MMR",
    abbrev: "MMR",
    aliases: ["mmr", "measles", "mumps", "rubella", "m-m-r", "priorix", "proquad"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: d(12 * MONTHS), minIntervalDays: 0,          recommendedAgeDays: d(12 * MONTHS) },
      { minAgeDays: d(4 * YEARS),   minIntervalDays: d(4 * WEEKS), recommendedAgeDays: d(4 * YEARS) },
    ],
  },

  // ── Varicella ────────────────────────────────────────────
  {
    name: "Varicella",
    abbrev: "VAR",
    aliases: ["varicella", "chickenpox", "varivax", "proquad"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: d(12 * MONTHS), minIntervalDays: 0,          recommendedAgeDays: d(12 * MONTHS) },
      { minAgeDays: d(4 * YEARS),   minIntervalDays: d(3 * MONTHS), recommendedAgeDays: d(4 * YEARS) },
    ],
  },

  // ── Hepatitis A ──────────────────────────────────────────
  {
    name: "Hepatitis A",
    abbrev: "HepA",
    aliases: ["hep a", "hepatitis a", "hepa", "havrix", "vaqta"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: d(12 * MONTHS), minIntervalDays: 0,          recommendedAgeDays: d(12 * MONTHS) },
      { minAgeDays: d(18 * MONTHS), minIntervalDays: d(6 * MONTHS), recommendedAgeDays: d(18 * MONTHS) },
    ],
  },

  // ── HPV ──────────────────────────────────────────────────
  // 2 doses if started before age 15; 3 doses if started at 15+.
  // We model 2-dose series (most common in pediatrics).
  {
    name: "HPV",
    abbrev: "HPV",
    aliases: ["hpv", "gardasil", "human papillomavirus"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: d(9 * YEARS),   minIntervalDays: 0,            recommendedAgeDays: d(11 * YEARS) },
      { minAgeDays: d(9 * YEARS),   minIntervalDays: d(5 * MONTHS), recommendedAgeDays: d(11 * YEARS + 6 * MONTHS) },
    ],
    notes: "2-dose series if started before age 15. 3 doses if started at 15+.",
  },

  // ── MenACWY ──────────────────────────────────────────────
  {
    name: "Meningococcal ACWY",
    abbrev: "MenACWY",
    aliases: ["menacwy", "meningococcal", "menactra", "menveo", "menquadfi"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: d(11 * YEARS),  minIntervalDays: 0,          recommendedAgeDays: d(11 * YEARS) },
      { minAgeDays: d(16 * YEARS),  minIntervalDays: d(8 * WEEKS), recommendedAgeDays: d(16 * YEARS) },
    ],
  },

  // ── MenB (Serogroup B — shared clinical decision-making for 16-23) ───────
  {
    name: "Meningococcal B",
    abbrev: "MenB",
    aliases: ["menb", "bexsero", "trumenba", "meningococcal b"],
    maxAgeDays: null,
    doses: [
      { minAgeDays: d(16 * YEARS), minIntervalDays: 0,            recommendedAgeDays: d(16 * YEARS) },
      { minAgeDays: d(16 * YEARS), minIntervalDays: d(1 * MONTHS), recommendedAgeDays: d(16 * YEARS + 6 * MONTHS) },
    ],
    notes: "Shared clinical decision-making for ages 16–23.",
  },
];

// ─── Combination Vaccine Mapping ──────────────────────────────────────────────
// Combo vaccines count toward multiple series.
// Key = lowercase vaccine name, Value = array of series abbrevs it covers.

const COMBO_VACCINES: Record<string, string[]> = {
  "pediarix":  ["HepB", "DTaP", "IPV"],
  "pentacel":  ["DTaP", "IPV", "Hib"],
  "vaxelis":   ["DTaP", "IPV", "Hib", "HepB", "PCV"],   // Actually Hep B + DTaP + IPV + Hib + PCV
  "kinrix":    ["DTaP", "IPV"],
  "quadracel": ["DTaP", "IPV"],
  "proquad":   ["MMR", "VAR"],
  "twinrix":   ["HepA", "HepB"],  // mostly adult but sometimes used in adolescents
};

// ─── Matching Logic ───────────────────────────────────────────────────────────

/**
 * Determine which vaccine series a given vaccine name matches.
 * Returns array of series abbreviations.
 */
function matchVaccineToSeries(vaccineName: string): string[] {
  const lower = vaccineName.toLowerCase().trim();

  // Check combo vaccines first
  for (const [comboName, seriesAbbrevs] of Object.entries(COMBO_VACCINES)) {
    if (lower.includes(comboName)) return seriesAbbrevs;
  }

  // Check each series' aliases
  const matched: string[] = [];
  for (const series of CDC_SCHEDULE) {
    for (const alias of series.aliases) {
      if (lower.includes(alias) || alias.includes(lower)) {
        matched.push(series.abbrev);
        break;
      }
    }
  }

  return matched;
}

// ─── Evaluation Engine ────────────────────────────────────────────────────────

/**
 * Evaluate a patient's immunization status against the CDC schedule.
 *
 * @param dob - Patient date of birth (YYYY-MM-DD)
 * @param immunizations - All recorded immunization events
 * @param asOfDate - Date to evaluate as of (defaults to today)
 * @returns Array of evaluations, one per vaccine series
 */
export function evaluateImmunizations(
  dob: string,
  immunizations: ImmunizationRecord[],
  asOfDate?: Date,
): VaccineEvaluation[] {
  if (!dob) return [];
  const now = asOfDate || new Date();
  const birthDate = new Date(dob + "T00:00:00");
  if (isNaN(birthDate.getTime())) return [];
  const ageDays = Math.floor((now.getTime() - birthDate.getTime()) / (1000 * 60 * 60 * 24));

  const results: VaccineEvaluation[] = [];

  for (const series of CDC_SCHEDULE) {
    // Special handling for Flu — annual, not a fixed series
    if (series.abbrev === "Flu") {
      results.push(evaluateFlu(series, dob, ageDays, immunizations, now));
      continue;
    }

    // Find all doses that match this series
    const matchingDoses = immunizations
      .filter(imm => {
        const matched = matchVaccineToSeries(imm.vaccine);
        return matched.includes(series.abbrev);
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const dosesGiven = matchingDoses.length;
    const dosesRequired = series.doses.length;
    const datesGiven = matchingDoses.map(d => d.date);

    // Series doesn't apply yet (patient too young for first dose)
    if (ageDays < series.doses[0].minAgeDays) {
      results.push({
        series,
        status: "not_yet",
        dosesGiven,
        dosesRequired,
        datesGiven,
        nextDueDate: formatDateFromBirth(birthDate, series.doses[0].recommendedAgeDays),
        message: `Starts at ${formatAge(series.doses[0].recommendedAgeDays)}`,
      });
      continue;
    }

    // Patient has aged out of this series
    if (series.maxAgeDays && ageDays > series.maxAgeDays) {
      // Special case: Rotavirus — 2 doses (Rotarix) or 3 doses (RotaTeq) both valid
      // If patient has 2+ doses and aged out, consider complete
      const minCompleteDoses = series.abbrev === "RV" ? 2 : dosesRequired;
      if (dosesGiven >= minCompleteDoses) {
        results.push({
          series,
          status: "complete",
          dosesGiven,
          dosesRequired,
          datesGiven,
          nextDueDate: null,
          message: "Series complete",
        });
        continue;
      }
      // Aged out but incomplete — don't show. The vaccine is no longer available
      // (e.g., DTaP ages out at 7, replaced by Tdap at 11). Provider handles catch-up clinically.
      continue;
    }

    // All doses received
    if (dosesGiven >= dosesRequired) {
      results.push({
        series,
        status: "complete",
        dosesGiven,
        dosesRequired,
        datesGiven,
        nextDueDate: null,
        message: "Series complete",
      });
      continue;
    }

    // Determine next dose needed
    const nextDoseIndex = dosesGiven;  // 0-indexed
    const nextDose = series.doses[nextDoseIndex];

    // Calculate when next dose is due
    let nextDueDate: Date;

    if (dosesGiven === 0) {
      // First dose: due at recommended age
      nextDueDate = new Date(birthDate.getTime() + nextDose.recommendedAgeDays * 24 * 60 * 60 * 1000);
    } else {
      // Subsequent dose: later of (min age) or (last dose + min interval)
      const minAgeDate = new Date(birthDate.getTime() + nextDose.minAgeDays * 24 * 60 * 60 * 1000);
      const lastDoseDate = new Date(matchingDoses[matchingDoses.length - 1].date + "T00:00:00");
      const intervalDate = new Date(lastDoseDate.getTime() + nextDose.minIntervalDays * 24 * 60 * 60 * 1000);
      // Also consider recommended age
      const recommendedDate = new Date(birthDate.getTime() + nextDose.recommendedAgeDays * 24 * 60 * 60 * 1000);

      // Due date is the latest of: min age, min interval, recommended age
      nextDueDate = new Date(Math.max(minAgeDate.getTime(), intervalDate.getTime()));
      // But show recommended if it's later (patient might be ahead of schedule)
      if (recommendedDate.getTime() > nextDueDate.getTime() && recommendedDate.getTime() <= now.getTime() + 30 * 24 * 60 * 60 * 1000) {
        // Use recommended if within the next month
      }
    }

    const isDue = now.getTime() >= nextDueDate.getTime();
    // Also check if patient has aged out and hasn't completed
    const agedOut = series.maxAgeDays && ageDays > series.maxAgeDays;

    if (agedOut) {
      results.push({
        series,
        status: "due",
        dosesGiven,
        dosesRequired,
        datesGiven,
        nextDueDate: null,
        message: `Incomplete — ${dosesGiven}/${dosesRequired} doses (aged out of window)`,
      });
    } else if (isDue) {
      results.push({
        series,
        status: "due",
        dosesGiven,
        dosesRequired,
        datesGiven,
        nextDueDate: formatDate(nextDueDate),
        message: `Dose ${dosesGiven + 1} of ${dosesRequired} due`,
      });
    } else {
      results.push({
        series,
        status: "up_to_date",
        dosesGiven,
        dosesRequired,
        datesGiven,
        nextDueDate: formatDate(nextDueDate),
        message: `${dosesGiven}/${dosesRequired} — next due ${formatDate(nextDueDate)}`,
      });
    }
  }

  return results;
}

// ─── Flu Special Logic ────────────────────────────────────────────────────────

function evaluateFlu(
  series: VaccineSeries,
  dob: string,
  ageDays: number,
  immunizations: ImmunizationRecord[],
  now: Date,
): VaccineEvaluation {
  const birthDate = new Date(dob + "T00:00:00");

  // Too young
  if (ageDays < d(6 * MONTHS)) {
    return {
      series,
      status: "not_yet",
      dosesGiven: 0,
      dosesRequired: 1,
      datesGiven: [],
      nextDueDate: formatDateFromBirth(birthDate, d(6 * MONTHS)),
      message: "Starts at 6 months",
    };
  }

  // Find flu doses
  const fluDoses = immunizations
    .filter(imm => matchVaccineToSeries(imm.vaccine).includes("Flu"))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Current flu season: Aug 1 – Jul 31
  const currentSeasonStart = new Date(now.getFullYear(), 7, 1); // Aug 1
  if (now < currentSeasonStart) {
    currentSeasonStart.setFullYear(currentSeasonStart.getFullYear() - 1);
  }

  const dosesThisSeason = fluDoses.filter(d => new Date(d.date) >= currentSeasonStart);

  if (dosesThisSeason.length > 0) {
    return {
      series,
      status: "up_to_date",
      dosesGiven: fluDoses.length,
      dosesRequired: 1,
      datesGiven: fluDoses.map(d => d.date),
      nextDueDate: null,
      message: `Current season: vaccinated ${new Date(dosesThisSeason[0].date).toLocaleDateString()}`,
    };
  }

  // Flu season months (roughly Sep–Mar is prime time, but vaccine available Aug+)
  const month = now.getMonth(); // 0-indexed
  const inFluSeason = month >= 7 || month <= 2; // Aug through March

  if (inFluSeason) {
    return {
      series,
      status: "due",
      dosesGiven: fluDoses.length,
      dosesRequired: 1,
      datesGiven: fluDoses.map(d => d.date),
      nextDueDate: formatDate(now),
      message: "Annual flu vaccine due",
    };
  }

  return {
    series,
    status: "up_to_date",
    dosesGiven: fluDoses.length,
    dosesRequired: 1,
    datesGiven: fluDoses.map(d => d.date),
    nextDueDate: null,
    message: "Not flu season — next dose due in fall",
  };
}

// ─── AAP Well-Child Visit Schedule ────────────────────────────────────────────
// https://www.aap.org/en/practice-management/care-delivery-approaches/periodicity-schedule/

/** Well-child visit ages in days from birth */
const WELL_CHECK_SCHEDULE = [
  { ageDays: d(3 * DAYS),     label: "Newborn (3–5 days)" },
  { ageDays: d(2 * WEEKS),    label: "2–4 weeks" },
  { ageDays: d(2 * MONTHS),   label: "2 months" },
  { ageDays: d(4 * MONTHS),   label: "4 months" },
  { ageDays: d(6 * MONTHS),   label: "6 months" },
  { ageDays: d(9 * MONTHS),   label: "9 months" },
  { ageDays: d(12 * MONTHS),  label: "12 months" },
  { ageDays: d(15 * MONTHS),  label: "15 months" },
  { ageDays: d(18 * MONTHS),  label: "18 months" },
  { ageDays: d(24 * MONTHS),  label: "2 years" },
  { ageDays: d(30 * MONTHS),  label: "2½ years" },
  { ageDays: d(3 * YEARS),    label: "3 years" },
  { ageDays: d(4 * YEARS),    label: "4 years" },
  { ageDays: d(5 * YEARS),    label: "5 years" },
  { ageDays: d(6 * YEARS),    label: "6 years" },
  { ageDays: d(7 * YEARS),    label: "7 years" },
  { ageDays: d(8 * YEARS),    label: "8 years" },
  { ageDays: d(9 * YEARS),    label: "9 years" },
  { ageDays: d(10 * YEARS),   label: "10 years" },
  { ageDays: d(11 * YEARS),   label: "11 years" },
  { ageDays: d(12 * YEARS),   label: "12 years" },
  { ageDays: d(13 * YEARS),   label: "13 years" },
  { ageDays: d(14 * YEARS),   label: "14 years" },
  { ageDays: d(15 * YEARS),   label: "15 years" },
  { ageDays: d(16 * YEARS),   label: "16 years" },
  { ageDays: d(17 * YEARS),   label: "17 years" },
  { ageDays: d(18 * YEARS),   label: "18 years" },
];

/**
 * Evaluate when the next well-child visit is due.
 *
 * @param dob - Patient date of birth
 * @param lastWellCheckDate - Date of most recent well-child encounter (null if none)
 * @param asOfDate - Evaluate as of this date (default: now)
 */
export function evaluateWellCheck(
  dob: string,
  lastWellCheckDate: string | null,
  asOfDate?: Date,
): WellCheckEvaluation {
  if (!dob) return { status: "up_to_date", lastVisitDate: null, nextDueDate: "unknown", nextDueLabel: "", message: "No DOB on file" };
  const now = asOfDate || new Date();
  const birthDate = new Date(dob + "T00:00:00");
  if (isNaN(birthDate.getTime())) return { status: "up_to_date", lastVisitDate: null, nextDueDate: "unknown", nextDueLabel: "", message: "Invalid DOB" };
  const ageDays = Math.floor((now.getTime() - birthDate.getTime()) / (1000 * 60 * 60 * 24));

  if (!lastWellCheckDate) {
    // Never had a well check — find the most appropriate upcoming one
    const next = WELL_CHECK_SCHEDULE.find(s => s.ageDays >= ageDays) || WELL_CHECK_SCHEDULE[0];
    const nextDate = new Date(birthDate.getTime() + next.ageDays * 24 * 60 * 60 * 1000);
    return {
      status: ageDays > d(5 * DAYS) ? "due" : "up_to_date",
      lastVisitDate: null,
      nextDueDate: formatDate(nextDate),
      nextDueLabel: next.label,
      message: "No well-child visit on record",
    };
  }

  const lastVisit = new Date(lastWellCheckDate + "T00:00:00");

  // Find the next scheduled well-check after the patient's current age
  // The logic: find the next visit age that is >= current age AND that hasn't already been covered
  // by a recent visit (within a reasonable grace window)

  // Find which scheduled visits are still upcoming
  const nextVisit = WELL_CHECK_SCHEDULE.find(s => {
    const visitDate = new Date(birthDate.getTime() + s.ageDays * 24 * 60 * 60 * 1000);
    // This visit is in the future or within last 2 weeks (not yet done)
    return visitDate.getTime() > lastVisit.getTime() && s.ageDays >= ageDays - d(1 * MONTHS);
  });

  if (!nextVisit) {
    return {
      status: "up_to_date",
      lastVisitDate: lastWellCheckDate,
      nextDueDate: null,
      nextDueLabel: "18 years",
      message: "All recommended well-child visits completed",
    };
  }

  const nextDate = new Date(birthDate.getTime() + nextVisit.ageDays * 24 * 60 * 60 * 1000);
  const isDue = now.getTime() >= nextDate.getTime();

  // Grace period: allow 1 month before flagging as overdue
  const gracePeriod = d(1 * MONTHS) * 24 * 60 * 60 * 1000;
  const isOverdue = now.getTime() > nextDate.getTime() + gracePeriod;

  return {
    status: isOverdue ? "overdue" : isDue ? "due" : "up_to_date",
    lastVisitDate: lastWellCheckDate,
    nextDueDate: formatDate(nextDate),
    nextDueLabel: nextVisit.label,
    message: isDue
      ? `${nextVisit.label} well-child visit ${isOverdue ? "overdue" : "due"}`
      : `Next: ${nextVisit.label} visit (${formatDate(nextDate)})`,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  if (isNaN(date.getTime())) return "unknown";
  return date.toISOString().split("T")[0];
}

function formatDateFromBirth(birthDate: Date, offsetDays: number): string {
  const d = new Date(birthDate.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return formatDate(d);
}

function formatAge(days: number): string {
  if (days < 7) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.round(days / 30.44)} months`;
  const years = Math.floor(days / 365.25);
  const remainMonths = Math.round((days - years * 365.25) / 30.44);
  if (remainMonths > 0) return `${years} yr ${remainMonths} mo`;
  return `${years} years`;
}
