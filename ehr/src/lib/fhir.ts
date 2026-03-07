/**
 * src/lib/fhir.ts
 * FHIR R4 resource builders for NostrEHR
 */

export interface SoapNote {
  subjective:  string;
  objective:   string;
  assessment:  string;
  plan:        string;
}

export function buildEncounter(patientId: string, chiefComplaint: string, noteText: string) {
  return {
    resourceType: "Encounter",
    id:           crypto.randomUUID(),
    status:       "finished",
    class: {
      system:  "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code:    "AMB",
      display: "ambulatory",
    },
    subject:    { reference: `Patient/${patientId}` },
    period:     { start: new Date().toISOString() },
    reasonCode: [{ text: chiefComplaint }],
    note: [{ text: noteText }],
  };
}

export function buildPatient(id: string, name: string, dob: string, gender: string) {
  return {
    resourceType: "Patient",
    id,
    name: [{ text: name }],
    birthDate: dob,
    gender,
  };
}

export function buildMedicationRequest(patientId: string, medName: string, dose: string, sig: string, startDate?: string) {
  return {
    resourceType:                "MedicationRequest",
    id:                          crypto.randomUUID(),
    status:                      "active",
    intent:                      "order",
    subject:                     { reference: `Patient/${patientId}` },
    medicationCodeableConcept:   { text: medName },
    dosageInstruction:           [{ text: `${dose} ${sig}` }],
    authoredOn:                  startDate || new Date().toISOString(),
  };
}

export function buildAllergyIntolerance(patientId: string, allergen: string, reaction: string, severity: string) {
  return {
    resourceType: "AllergyIntolerance",
    id:           crypto.randomUUID(),
    clinicalStatus: { coding: [{ code: "active" }] },
    code:         { text: allergen },
    patient:      { reference: `Patient/${patientId}` },
    reaction:     [{ manifestation: [{ text: reaction }], severity }],
    recordedDate: new Date().toISOString(),
  };
}

export function buildImmunization(patientId: string, vaccine: string, dateGiven: string, doseNumber?: string) {
  return {
    resourceType:   "Immunization",
    id:             crypto.randomUUID(),
    status:         "completed",
    vaccineCode:    { text: vaccine },
    patient:        { reference: `Patient/${patientId}` },
    occurrenceDateTime: dateGiven,
    doseQuantity:   doseNumber ? { value: parseInt(doseNumber) } : undefined,
    recorded:       new Date().toISOString(),
  };
}

export function buildCondition(
  patientId: string,
  display: string,
  opts: {
    snomedCode?: string;
    icd10Code?: string;
    clinicalStatus?: "active" | "resolved" | "inactive";
    severity?: "mild" | "moderate" | "severe";
    onsetDate?: string;
    note?: string;
  } = {}
) {
  const {
    snomedCode,
    icd10Code,
    clinicalStatus = "active",
    severity,
    onsetDate,
    note,
  } = opts;

  // FHIR R4 CodeableConcept with optional SNOMED + ICD-10 codings
  const coding: any[] = [];
  if (snomedCode) {
    coding.push({
      system: "http://snomed.info/sct",
      code: snomedCode,
      display,
    });
  }
  if (icd10Code) {
    coding.push({
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: icd10Code,
      display,
    });
  }

  return {
    resourceType: "Condition",
    id: crypto.randomUUID(),
    clinicalStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: clinicalStatus,
      }],
    },
    ...(severity && {
      severity: {
        coding: [{
          system: "http://snomed.info/sct",
          code: severity === "mild" ? "255604002"
              : severity === "moderate" ? "6736007"
              : "24484000",
          display: severity,
        }],
      },
    }),
    code: {
      coding: coding.length > 0 ? coding : undefined,
      text: display,
    },
    subject: { reference: `Patient/${patientId}` },
    ...(onsetDate && { onsetDateTime: onsetDate }),
    recordedDate: new Date().toISOString(),
    ...(note && { note: [{ text: note }] }),
  };
}

export function buildServiceRequest(
  patientId: string,
  category: "lab" | "imaging",
  test: string,
  indication: string,
  priority: "routine" | "stat",
  facility: string,
  instructions: string,
  loincCode?: string
) {
  return {
    resourceType:  "ServiceRequest",
    id:            crypto.randomUUID(),
    status:        "active",
    intent:        "order",
    category,
    priority,
    code:          loincCode
      ? { text: test, coding: [{ system: "http://loinc.org", code: loincCode, display: test }] }
      : { text: test },
    subject:       { reference: `Patient/${patientId}` },
    authoredOn:    new Date().toISOString(),
    reasonCode:    indication    ? [{ text: indication }]    : undefined,
    performer:     facility      ? [{ display: facility }]   : undefined,
    note:          instructions  ? [{ text: instructions }]  : undefined,
  };
}

export interface LabAnalyte {
  name: string;
  value: string;
  unit: string;
  refRange: string;
  flag: "normal" | "high" | "low" | "critical";
  loinc?: string;
}

export function buildDiagnosticReport(
  patientId: string,
  orderId: string | null,
  test: string,
  category: "lab" | "imaging",
  resultText: string,
  interpretation: "normal" | "abnormal" | "critical",
  impression: string,
  resultDate: string,
  analytes?: LabAnalyte[]
) {
  return {
    resourceType:   "DiagnosticReport",
    id:             crypto.randomUUID(),
    status:         "final",
    category,
    code:           { text: test },
    subject:        { reference: `Patient/${patientId}` },
    basedOn:        orderId ? [{ reference: `ServiceRequest/${orderId}` }] : undefined,
    effectiveDate:  resultDate || new Date().toISOString().split("T")[0],
    issued:         new Date().toISOString(),
    interpretation,
    conclusion:     impression || undefined,
    result:         resultText,
    analytes:       analytes && analytes.length > 0 ? analytes : undefined,
  };
}

export function buildRxOrder(
  patientId: string,
  drug: string,
  dose: string,
  sig: string,
  route: string,
  qty: string,
  daysSupply: number,
  refills: number,
  daw: boolean,
  pharmacy: string,
  indication: string
) {
  return {
    resourceType:       "RxOrder",
    id:                 crypto.randomUUID(),
    status:             "active",
    subject:            { reference: `Patient/${patientId}` },
    authoredOn:         new Date().toISOString(),
    drug,
    dose,
    sig,
    route,
    qty,
    daysSupply,
    refills,
    daw,
    pharmacy:           pharmacy   || undefined,
    indication:         indication || undefined,
  };
}

export function buildDocumentReference(
  patientId: string,
  title: string,
  category: string,
  contentType: string,
  url: string,
  hash: string,
  size: number,
  fileKey: string,
  description?: string,
) {
  return {
    resourceType: "DocumentReference",
    id:           crypto.randomUUID(),
    status:       "current",
    type:         { text: category },
    subject:      { reference: `Patient/${patientId}` },
    date:         new Date().toISOString(),
    description:  description || title,
    content: [{
      attachment: {
        contentType,
        url,
        hash: `sha256:${hash}`,
        title,
        size,
      },
    }],
    fileKey,
  };
}