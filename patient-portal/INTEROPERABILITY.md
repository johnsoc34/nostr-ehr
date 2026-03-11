# NostrEHR Interoperability Specification

This document defines the data contract required for any Nostr-based EHR system to be compatible with the NostrEHR Patient Portal. If your EHR publishes events matching this spec, patients can view their records at any compatible portal — including [portal.immutablehealthpediatrics.com](https://portal.immutablehealthpediatrics.com).

For the encryption pattern, see [NIP-XX PR #2258](https://github.com/nostr-protocol/nips/pull/2258).

---

## Overview

The portal reads encrypted FHIR R4 JSON payloads from Nostr events. To be compatible, an EHR must:

1. Publish Nostr events with the correct kind numbers (2110–2121)
2. Use NIP-44 dual encryption (practice copy + patient copy)
3. Include the required Nostr event tags
4. Encrypt valid FHIR R4 JSON with the fields documented below

The portal is read-only for clinical data. Patients can only write messages (kind 2117) and telehealth signaling (kinds 4050–4055).

---

## Encryption: Dual NIP-44

Every clinical event carries two independently encrypted copies of the same FHIR payload:

| Location | Encrypted for | Description |
|---|---|---|
| `.content` | Practice | `nip44Encrypt(json, getSharedSecret(practiceSk, practicePkHex))` |
| `["patient-content", "..."]` tag | Patient | `nip44Encrypt(json, getSharedSecret(practiceSk, patientPkHex))` |

The patient decrypts their copy using: `nip44Decrypt(tag_value, getSharedSecret(patientSk, practicePkHex))`

This works because NIP-44's ECDH shared secret is symmetric: `getSharedSecret(A, B_pub) === getSharedSecret(B, A_pub)`.

If the portal finds events for a patient but none have a `patient-content` tag, it displays a "patient access not enabled" message.

---

## Event Kinds

### Clinical (practice-authored, patient read-only)

| Kind | FHIR Resource | Description |
|---|---|---|
| 2110 | Patient | Demographics |
| 2111 | Encounter | Visit notes, addendums, nurse notes |
| 2112 | MedicationRequest | Active medications, prescriptions |
| 2113 | Observation | Vitals (weight, height, BMI, BP, HR, temp, SpO2, HC) |
| 2114 | Condition | Problem list (diagnoses) |
| 2115 | AllergyIntolerance | Allergies |
| 2116 | Immunization | Vaccinations |
| 2117 | — (plain text) | Bidirectional messaging (both sides can write) |
| 2118 | ServiceRequest | Lab and imaging orders |
| 2119 | DiagnosticReport | Lab/imaging results |
| 2120 | MedicationRequest | Prescription orders (extended Rx fields) |
| 2121 | DocumentReference | Encrypted file attachments (NIP-B7 Blossom) |

### Organizational (practice-authored)

| Kind | Purpose |
|---|---|
| 2100 | PatientKeyGrant — per-staff per-patient ECDH shared secret |
| 2101 | PracticeKeyGrant — per-staff practice shared secret (X₁) |
| 2102 | StaffRoster — staff members, roles, permissions |
| 2103 | ServiceAgentGrant — trust chain for service agent keypairs |

### Telehealth (bidirectional)

| Kind | Purpose |
|---|---|
| 4050 | Lobby (join/leave) |
| 4051 | SDP Offer (provider → patient) |
| 4052 | SDP Answer (patient → provider) |
| 4053 | ICE Candidate (bidirectional) |
| 4054 | Call State (mute/video sync) |
| 4055 | Call End |

---

## Required Event Tags

Every clinical event (kinds 2110–2121) must include:

```json
[
  ["p", "<patient_pubkey_hex>"],
  ["pt", "<patient_uuid>"],
  ["patient-content", "<nip44_encrypted_fhir_json>"]
]
```

### Additional tags by context

**Status changes** (problems, meds, allergies) use append-only markers:

```json
["e", "<original_event_id>", "", "status-update"]
```

**Deletions** (soft-delete via append):

```json
["e", "<original_event_id>", "", "deletion"]
```

**Encounter addendums:**

```json
["e", "<original_encounter_id>", "", "addendum"]
```

**Diagnostic report linked to an order:**

```json
["e", "<order_event_id>", "", "result"]
```

---

## FHIR Payload Schemas

The decrypted `patient-content` value must be a JSON string containing a FHIR R4 resource. Below are the minimum required fields for each resource type. The portal gracefully ignores unrecognized fields.

### Encounter (kind 2111)

The portal displays `reasonCode[0].text` as the visit title and `note[0].text` as the expandable note body.

```json
{
  "resourceType": "Encounter",
  "status": "finished",
  "reasonCode": [{ "text": "Well child visit" }],
  "note": [{ "text": "Full visit note text here..." }],
  "period": { "start": "2026-03-09T10:00:00Z" }
}
```

### Observation (kind 2113)

The portal filters vitals by LOINC code. Currently rendered: weight (`29463-7`) and height (`8302-2`).

```json
{
  "resourceType": "Observation",
  "status": "final",
  "code": {
    "coding": [{ "system": "http://loinc.org", "code": "29463-7", "display": "Body weight" }]
  },
  "effectiveDateTime": "2026-03-09T10:00:00Z",
  "valueQuantity": { "value": 12.5, "unit": "kg", "system": "http://unitsofmeasure.org", "code": "kg" }
}
```

Supported LOINC codes:

| Code | Measurement | Expected unit |
|---|---|---|
| 29463-7 | Body weight | kg |
| 8302-2 | Body height | cm |
| 39156-5 | BMI | kg/m2 |
| 8480-6 | Systolic BP | mmHg |
| 8462-4 | Diastolic BP | mmHg |
| 8867-4 | Heart rate | /min |
| 8310-5 | Body temperature | Cel |
| 2708-6 | SpO2 | % |
| 9843-4 | Head circumference | cm |

### MedicationRequest (kind 2112)

The portal displays `medicationCodeableConcept.text` as the drug name, `dosageInstruction[0].text` as the dosage, and `authoredOn` as the start date.

```json
{
  "resourceType": "MedicationRequest",
  "status": "active",
  "intent": "order",
  "medicationCodeableConcept": { "text": "Amoxicillin 250mg/5mL" },
  "dosageInstruction": [{ "text": "5mL PO TID x 10 days" }],
  "authoredOn": "2026-03-09"
}
```

### Condition (kind 2114)

```json
{
  "resourceType": "Condition",
  "clinicalStatus": {
    "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active" }]
  },
  "code": {
    "coding": [
      { "system": "http://snomed.info/sct", "code": "195967001", "display": "Asthma" },
      { "system": "http://hl7.org/fhir/sid/icd-10-cm", "code": "J45.20" }
    ],
    "text": "Asthma"
  },
  "onsetDateTime": "2024-06-15",
  "note": [{ "text": "Mild intermittent, well controlled" }]
}
```

### AllergyIntolerance (kind 2115)

```json
{
  "resourceType": "AllergyIntolerance",
  "clinicalStatus": { "coding": [{ "code": "active" }] },
  "code": { "text": "Penicillin" },
  "reaction": [{ "manifestation": [{ "text": "Hives" }], "severity": "moderate" }]
}
```

### Immunization (kind 2116)

The portal groups immunizations by `vaccineCode.text` and sorts by `occurrenceDateTime`. It also provides a printable immunization record.

```json
{
  "resourceType": "Immunization",
  "status": "completed",
  "vaccineCode": { "text": "DTaP" },
  "occurrenceDateTime": "2026-01-15",
  "doseQuantity": { "value": 0.5, "unit": "mL" }
}
```

### Message (kind 2117)

Messages are the one bidirectional resource. Both practice and patient can publish kind 2117 events. The decrypted content is plain text (not FHIR JSON). Messages use threading via event tags:

**New message (thread root):**

```json
tags: [
  ["p", "<practice_pubkey_hex>"],
  ["p", "<patient_pubkey_hex>"],
  ["subject", "Question about medication"]
]
```

**Reply (references thread root):**

```json
tags: [
  ["p", "<practice_pubkey_hex>"],
  ["p", "<patient_pubkey_hex>"],
  ["subject", "Re: Question about medication"],
  ["e", "<root_message_event_id>"]
]
```

The `.content` field is `nip44Encrypt(plaintext_message, sharedSecret)` — not FHIR JSON.

### ServiceRequest (kind 2118)

```json
{
  "resourceType": "ServiceRequest",
  "status": "active",
  "intent": "order",
  "category": "lab",
  "code": { "text": "CBC with differential" },
  "priority": "routine",
  "reasonCode": [{ "text": "Annual screening" }],
  "note": [{ "text": "Fasting not required" }]
}
```

### DiagnosticReport (kind 2119)

```json
{
  "resourceType": "DiagnosticReport",
  "status": "final",
  "category": "lab",
  "code": { "text": "CBC with differential" },
  "effectiveDate": "2026-03-09",
  "conclusion": "All values within normal limits",
  "interpretation": "normal",
  "analytes": [
    { "name": "WBC", "value": "7.5", "unit": "10^3/uL", "range": "4.5-11.0", "flag": "" },
    { "name": "Hemoglobin", "value": "14.2", "unit": "g/dL", "range": "12.0-16.0", "flag": "" }
  ]
}
```

---

## Relay Requirements

- **nostr-rs-relay 0.9.0+** (or compatible)
- NIP-42 pubkey whitelist recommended (controls who can connect)
- `max_event_bytes >= 65536` (SDP offers for telehealth are ~22KB after encryption)
- Kind 1059 should be exempted from pubkey whitelist if using NIP-17 billing DMs

---

## Connection String

For patients to connect to your practice from any compatible portal, provide a connection string in one of these formats:

**JSON:**

```json
{
  "practice_name": "Your Practice Name",
  "relay": "wss://relay.yourpractice.com",
  "practice_pk": "64_char_hex_pubkey",
  "billing_api": "https://billing.yourpractice.com",
  "calendar_api": "https://calendar.yourpractice.com"
}
```

**URI:**

```
nostr+ehr://relay.yourpractice.com?pk=64_char_hex_pubkey&name=Your+Practice&billing=https://billing.yourpractice.com&calendar=https://calendar.yourpractice.com
```

Only `relay` and `practice_pk` are required. `billing_api` and `calendar_api` are optional.

---

## Minimum Viable Implementation

To display records on a compatible portal, an EHR must at minimum:

1. Generate a practice keypair (secp256k1)
2. Generate patient keypairs at enrollment
3. Run a nostr-rs-relay with the practice + patient pubkeys whitelisted
4. Publish kind 2111 (Encounter) events with dual NIP-44 encryption
5. Include `["p", patientPkHex]` and `["patient-content", encrypted]` tags

That's enough for patients to see their visit notes. Add more kinds incrementally — each one lights up an additional tab in the portal.

---

## Reference Implementation

The complete reference implementation is at [github.com/johnsoc34/nostr-ehr](https://github.com/johnsoc34/nostr-ehr):

- `ehr/src/lib/nostr.ts` — Schnorr signing, ECDH, bech32 encoding
- `ehr/src/lib/nip44.ts` — NIP-44 v2 ChaCha20-Poly1305 encryption
- `ehr/src/lib/dual-encryption.ts` — dual encrypt/decrypt helpers
- `ehr/src/app/page.tsx` — EHR application (event publishing)
- `patient-portal/src/app/page.tsx` — portal application (event reading)
