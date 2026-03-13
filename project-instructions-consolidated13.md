# NostrEHR Project Knowledge — Consolidated (March 13, 2026)

This single document replaces all previous project knowledge files:
- ~~project-instructions-consolidated12.md (March 12, session 1)~~ (superseded by this version)

---

## What This Is

NostrEHR is a Nostr-native pediatric electronic health record (EHR) system built for Immutable Health Pediatrics. It's the first patient-portable encrypted health record system where a single private key (nsec) gives a patient complete ownership of their medical history across any provider who runs the software.

The system supports two patient models: **monthly membership** (DPC) and **per-visit** (virtual consultations). Both use the same core EHR, encryption, and Nostr infrastructure. The distinction is in onboarding (who generates keys), billing (membership vs per-encounter), and access management.

### Core Innovation: Dual Encryption
Every FHIR event is encrypted twice in a single Nostr event:
- `.content` — encrypted for the practice (practice can decrypt with their key)
- `patient-content` tag — encrypted for the patient (patient can independently decrypt)

### Guardian Model (New — March 13, 2026)
Parents/guardians get their own keypair and access children's records via **kind 2104 GuardianGrant** events. The grant contains the child's X₂ shared secret encrypted to the guardian's pubkey. The guardian can decrypt `patient-content` tags on the child's events without ever holding the child's nsec. One parent login → see all children via patient switcher in the portal.

### NIP-42 vs NIP-44 — Complementary Layers
- **NIP-42 (Relay Authentication):** Controls who can connect to the relay. Pubkey whitelist = "bouncer at the door."
- **NIP-44 (Encryption):** Controls who can read data. ECDH shared secret → HKDF → ChaCha20-Poly1305. Even with relay access, data is useless without the right key.

### Messaging Exception to Read-Only
Clinical records (kinds 2110-2116, 2118-2121) are practice-authored and read-only for patients. **Messages (kind 2117)** are bidirectional — both sides can write. Telehealth signaling (kinds 4050-4055) works the same way.

---

## Roadmap Status (19/19 + Guardian Model — 100%)

### Complete
1. ✅ Problem List / Conditions (kind 2114, SNOMED + ICD-10, append-only status)
2. ✅ Terminology Database (270 curated pediatric diagnoses, 15 categories)
3. ✅ Dot Phrases / Text Templates (12 built-in, custom CRUD)
4. ✅ Offline / Local-First — All 3 Layers (IndexedDB read cache, write queue, sync reconciliation)
5. ✅ Lab Results / DiagnosticReport (structured analytes, LOINC codes, result-without-order)
6. ✅ Audit Trail (server-side, hourly cron, basic auth)
7. ✅ Patient Portal (portal.immutablehealthpediatrics.com) — multi-practice with data sovereignty
8. ✅ Billing Integration (billing.immutablehealthpediatrics.com)
9. ✅ Calendar / Scheduling (calendar.immutablehealthpediatrics.com)
10. ✅ PDF Generation (6 forms)
11. ✅ Clinical Decision Support (immunization schedule, well-child tracking, allergy-medication alerts)
12. ✅ Patient Timeline
13. ✅ Document Attachment (NIP-B7 Blossom)
14. ✅ Encounter Signing / Immutability Verification
15. ✅ FHIR REST API
16. ✅ Multi-Practice Patient Portal
17. ✅ Telehealth — Nostr-signaled WebRTC video visits
18. ✅ Multi-User / Role-Based Access
19. ✅ Universal Patient Identity + Virtual Care Infrastructure
20. ✅ Guardian Model — kind 2104 grants, portal multi-patient, family linking (March 13, 2026)
21. ✅ Virtual Consultation Pipeline — intake form, onboarding, one-click patient creation (March 13, 2026)

### TODO List
- Hover tooltips on regenerate/republish buttons explaining what they do
- Guardian messaging: handle guardian signing vs child tagging for portal messages
- "Create Family" batch flow in Add Patient form (create parent + N children in one step)
- API endpoint to trigger relay whitelist sync from EHR/billing UI
- Rotate Resend API key (exposed during session)
- Portal QR code camera login — patient scans QR to import nsec
- Docker Compose for server-side stack (Tier 2 distribution)
- Update EHR `.env.local` with real practice info for PDF generation
- HIPAA telehealth documentation
- Practice key rotation planning
- Electron rebuild with guardian model + virtual consultation pipeline
- Debug portal-side telehealth (patient signaling events not publishing)
- Lightning payment integration (Strike API)
- Portal: auto-connect via URL parameter for intake patients
- Billing dashboard: per-visit revenue stat card, type badges on members table

---

## Phase 6: Guardian Model (Completed March 13, 2026)

### Architecture
Parents/guardians are Patient records with `guardianOf: string[]` linking to child patient IDs. Access is cryptographic: kind 2104 `GuardianGrant` events contain the child's X₂ shared secret encrypted to the guardian's pubkey.

### Event Kind
| Kind | Name | Purpose |
|------|------|---------|
| 2104 | GuardianGrant | Guardian (parent) read access to child's records — practice-signed |

### GuardianGrantPayload
```typescript
interface GuardianGrantPayload {
  childPatientId: string;          // child's patient UUID
  childPkHex: string;              // child's public key (hex)
  childSharedSecret: string;       // hex-encoded X₂ = getSharedSecret(practiceSk, childPkHex)
  childName: string;               // display name for portal patient switcher
  guardianPkHex: string;           // guardian's public key (hex)
}
```

### Tags on kind 2104 events
```json
["p", "<guardianPkHex>"]        // portal queries: {kinds:[2104], #p:[guardianPk]}
["pt", "<childPatientId>"]      // child patient UUID
["child-p", "<childPkHex>"]     // child pubkey for reference
["grant", "guardian-access"]     // grant type marker
```

### Patient Interface additions
```typescript
guardianOf?: string[];    // array of child patient IDs this person is guardian of
guardianNpub?: string;    // for child patients: their primary guardian's npub
```

### Helper functions (patients.ts)
- `linkGuardian(guardianId, childId, guardianNpub)` — links both directions in localStorage
- `unlinkGuardian(guardianId, childId)` — removes link
- `getGuardianChildren(guardianId)` — returns child Patient[]
- `getChildGuardians(childId)` — returns guardian Patient[]

### EHR: GuardianSection component
In DemographicsCard, shows "Family Links" section:
- "Guardian of" list with children's names/ages (if this patient is a guardian)
- "Guardian(s)" list (if this patient has guardians)
- "+ Link child patient" button (admin only) — dropdown, publishes kind 2104 grant
- "Republish all guardian grants" utility button
- Unlink with confirmation

### EHR: Auto-republish on re-key
When a child patient is re-keyed, `handleRekey` automatically finds all guardians via `loadPatients().filter(p => p.guardianOf?.includes(patient.id))` and republishes their kind 2104 grants with the new X₂.

### Portal: Multi-patient switcher
- After login, useEffect fetches `{kinds:[2104], "#p":[loggedInPkHex]}`
- Decrypts each grant → builds `GuardianChild[]` with childPkHex + childSharedSecret
- `viewingKeys` derivation: when child selected, swaps pkHex + uses `overrideSharedSecret` for decryption
- `portalDecrypt()` uses `keys.overrideSharedSecret || getSharedSecret(keys.sk, otherPkHex)`
- Patient switcher in header (orange for self, blue for children)
- All clinical tabs use viewingKeys; My Data stays on guardian's own keys
- Telehealth uses guardian's own keys for signing (guardian is in the call)

### Guardian access model
- Guardian gets read-only clinical data access + messaging ability
- Guardian does NOT hold the child's nsec
- At 18: doctor hands child their nsec directly, revokes guardian grant
- Multiple guardians per child supported (both parents, grandparent)
- Multiple children per guardian supported (the whole point for families)
- A guardian can also be a patient (common: mom is a patient + guardian of 3 kids)

---

## Virtual Consultation Pipeline (Completed March 13, 2026)

### State Machine
```
pending → approved → ready → scheduled (drops off sidebar)
                              ↘ expired (after 14 days)
```

### Intake Form (`/request` on calendar)
- Parent name, contact preference (email/text), email, phone (required toggles based on preference)
- Child name, DOB, state (validated against LICENSED_STATES)
- Chief complaint, preferred date/time, optional npub

### Onboarding Page (`/onboard/:id` on calendar)
- Served by Express with server-injected config (practice PK, relay URL, portal URL)
- Parent generates their own keypair client-side (secp256k1, pure JS, no libraries)
- nsec shown once with copy button + "I have saved it" checkbox
- npub POSTs back to `POST /api/intake/:id/npub` → transitions approved → ready
- Connection string displayed for portal setup
- "I already have a Nostr identity" skip path for existing npub holders

### Calendar Server Routes (new)
- `GET /api/intake/active` — returns pending + approved + ready (must be BEFORE /:id route)
- `POST /api/intake/:id/npub` — patient submits npub, validates format, transitions to ready
- `GET /onboard/:id` — serves onboarding page with injected config
- Updated `POST /api/intake/:id/approve` — sends email notification via Resend, returns onboard_url
- `sendApprovalEmail()` — dark-themed HTML email with onboard link
- Stale intake expiration: setInterval every 6 hours, expires 14-day-old approved requests

### Calendar DB additions
- `contact_preference` column (TEXT, default 'email')
- `child_name` column (TEXT)
- `updateIntakeNpub(id, npub)` — transitions approved → ready
- `getIntakeByStatus(...statuses)` — flexible multi-status query
- `expireStaleIntake(daysOld)` — auto-expire stale requests
- `markIntakeScheduled(id)` — transitions ready → scheduled

### EHR: Multi-state intake sidebar
- Orange (pending) — approve/decline buttons
- Amber (approved) — "Awaiting onboarding" with copyable onboard link
- Green (ready) — "Click to create patient"
- Status badge pill on each card

### EHR: One-click "Create Patient from Intake"
When intake is in "ready" state, the detail modal shows a green button that:
1. Creates child patient (practice-keyed, per-visit, from intake data)
2. Imports guardian by npub (self-keyed, per-visit)
3. Links guardian → child in localStorage
4. Publishes demographics + staff grants + FHIR grants for both
5. Publishes kind 2104 guardian grant
6. Syncs both to billing via confirm-ehr-sync (upsert)
7. Updates intake status

### Billing: confirm-ehr-sync upsert
Route now INSERTs if patient npub not found in billing DB (was UPDATE-only before). Accepts `name` parameter for new records. Per-visit patients get `status: 'active'`, `patient_type: 'per-visit'`, `monthly_fee: 0`. This ensures all patients (monthly and per-visit) get billing records and are included in relay whitelist sync.

### Calendar .env additions
```
RESEND_API_KEY=re_...
RESEND_FROM=noreply@immutablehealthpediatrics.com
PORTAL_URL=https://portal.immutablehealthpediatrics.com
PRACTICE_NAME=Immutable Health Pediatrics
PRACTICE_PK=<64-char hex>
RELAY_URL=wss://relay.immutablehealthpediatrics.com
BILLING_API=https://billing.immutablehealthpediatrics.com
CALENDAR_ORIGIN=https://calendar.immutablehealthpediatrics.com
LICENSED_STATES=CA
```

All server.js const defaults are empty strings (no practice-specific info in git).

---

## Phase 19: Universal Patient Identity Model (March 11, 2026)

### Architecture: Two Orthogonal Axes

| Flag | Values | Meaning |
|------|--------|---------|
| `keySource` | `"practice"` / `"self"` | Who generated/holds the cryptographic keys |
| `billingModel` | `"monthly"` / `"per-visit"` | How the patient pays |

### Patient Interface (`patients.ts`)
```typescript
interface Patient {
  id: string;
  name: string;
  dob: string;
  sex: "male" | "female" | "other" | "unknown";
  phone?: string; email?: string; address?: string; city?: string; state?: string; zip?: string;
  createdAt: number;
  nsec?: string;
  npub?: string;
  keySource: "practice" | "self";
  billingModel: "monthly" | "per-visit";
  nsecStored?: boolean;
  guardianOf?: string[];       // Phase 6: child patient IDs
  guardianNpub?: string;       // Phase 6: guardian's npub (on child records)
}
```

---

## System Architecture — 7 Applications

### 1. EHR (Provider-facing)
- Next.js 14, React, TypeScript — pure client-side SPA (~12,000+ lines)
- File: `C:\Users\water\Desktop\Nostr-EHR\ehr\src\app\page.tsx`
- Lib files: `src/lib/nostr.ts`, `nip44.ts`, `dual-encryption.ts`, `fhir.ts`, `patients.ts`, `growth.ts`, `terminology.ts`, `cache.ts`, `pdf.ts`, `cds.ts`, `telehealth.ts`, `VideoRoom.tsx`

### 2. Patient Portal — port 3001
- Server: `/home/nostr/patient-portal/src/app/page.tsx`
- Multi-practice + multi-patient (guardian switcher)

### 3. Billing — port 3002
- Root: `/opt/immutable-health-billing/`
- DB: `/var/lib/immutable-health/billing.db` (shared with calendar)
- `confirm-ehr-sync` route: upserts (INSERT if not exists, UPDATE if exists)

### 4. Calendar — port 3003
- Root: `/opt/immutable-health-calendar/`
- Source: `server.js` (Express), `db.js` (better-sqlite3, shares billing.db)
- Public pages: `/request` (intake form), `/onboard/:id` (patient onboarding)
- Intake state machine: pending → approved → ready → scheduled/expired
- Auth exemptions: `/api/`, `/request`, `/onboard/`, `/login`, `/logout`

### 5. Blossom — port 3004
### 6. FHIR API — port 3005
### 7. Audit Trail — `/home/nostr/audit/`

---

## Multi-User / Role-Based Access

### Event Kinds
| Kind | Name | Purpose |
|------|------|---------|
| 2100 | PatientKeyGrant | Per-staff per-patient X₂ |
| 2101 | PracticeKeyGrant | Per-staff X₁ (practice-wide) |
| 2102 | StaffRoster | Encrypted staff list |
| 2103 | ServiceAgentGrant | Authorizes service pubkeys |
| 2104 | GuardianGrant | Guardian access to child's records |

---

## Key Development Rules

1. **Real medical system** — be careful with data handling
2. **Nostr events are immutable** — no editing, only appending
3. **All patient data encrypted** — never log plaintext clinical data
4. **Never define React components inside render functions** — causes remount/focus loss
5. **Always `return cachedLoad()`** — never `await`, cleanup must propagate
6. **Portal's nostr.ts needs `// @ts-nocheck`** — TypeScript version mismatch on server
7. **FHIR API crypto.js must use custom ChaCha20-Poly1305** — NOT Node's crypto module
8. **All React hooks must be above early returns**
9. **Portal is practice-agnostic** — server only serves static JS; nsec never touches the server
10. **All clinical write paths use `publishClinicalEvent()`**
11. **`addPatient()` returns `{ patient, nsec }`** — all call sites must destructure
12. **Billing `confirm-ehr-sync` now upserts** — INSERTs new per-visit patients, not just UPDATE
13. **Calendar `db.js` shares billing.db** — schema changes affect both apps
14. **Calendar intake endpoints are public** — `/api/` prefix exempted from session auth
15. **`LICENSED_STATES` env var** — comma-separated codes. Currently: `CA`
16. **Calendar route ordering matters** — `/api/intake/active` must be before `/api/intake/:id`
17. **Server.js const defaults must be empty strings** — no practice URLs in git
18. **Never save HTML from browser "View Source"** — Cloudflare/CDN scripts get baked in and break JS
19. **Calendar mini-cal is Sunday-first** — `getDay()` native (Sun=0)
20. **Main website is not in git** — lives at `/var/www/immutablehealthpediatrics.com/` on server only
21. **Guardian grants auto-republish on child re-key** — `handleRekey` finds all guardians and republishes kind 2104
22. **Portal `overrideSharedSecret`** — guardian viewing child uses pre-computed X₂ from grant, not ECDH
23. **All patients (monthly + per-visit) sync to billing** — removed `billingModel === "monthly"` guard. Required for relay whitelist.
24. **Repo path is `C:\Users\water\Desktop\Nostr-EHR\`** — GitHub: `github.com/johnsoc34/nostr-ehr`

---

## Private Key Locations

| Key | Location | Scope |
|-----|----------|-------|
| Practice nsec | Doctor's local machine only (EHR login) | Signs all grants, clinical events, admin operations |
| Billing agent nsec | Server: billing `.env` (`BILLING_AGENT_NSEC`) | Signs NIP-17 invoice DMs only |
| FHIR agent nsec | Server: fhir-api `.env` (`FHIR_AGENT_NSEC`) | Decrypts clinical data for read-only API |
| Patient nsecs | Browser session memory (shown once at creation) | Patient portal login |
| Guardian nsecs | Browser session memory (shown once at onboarding) | Guardian portal login |
| Staff nsecs | Browser session memory (staff login) | Staff EHR operations |
| Child nsecs | EHR localStorage if `nsecStored: true` | Practice-escrowed, revealable by admin |

**No private keys ever touch the server** (except agent nsecs which are scoped).

---

## Completed Sessions

**March 13, 2026:**
- ✅ Phase 6: Guardian model foundation
  - Kind 2104 GuardianGrant in nostr.ts + GuardianGrantPayload interface
  - guardianOf/guardianNpub fields in patients.ts + 4 helper functions
  - publishGuardianGrant() + GuardianSection component in EHR page.tsx
  - Auto-republish guardian grants on child re-key
- ✅ Phase 2a: Portal multi-patient support
  - overrideSharedSecret on PatientKeys, GuardianChild interface
  - useEffect fetches kind 2104 grants, viewingKeys derivation
  - Patient switcher dropdown in header
  - Portal nostr.ts needs // @ts-nocheck
- ✅ Phase 2b: Relay + billing fixes
  - Removed billingModel === "monthly" guard — all patients sync to billing
  - confirm-ehr-sync upsert (INSERT if not exists)
  - EHR passes name in confirm-ehr-sync calls
- ✅ Phase 3: Virtual consultation pipeline
  - Calendar: 8 server.js additions (env vars, onboard route, npub endpoint, active endpoint, approval email, stale expiration)
  - onboard.html — guardian/family keypair generation
  - intake-request.html — child name, contact preference toggle, conditional required fields
  - calendar-db.js — contact_preference + child_name columns, 4 new functions
  - EHR multi-state sidebar (orange/amber/green), status-dependent detail modal
  - One-click "Create Child Patient + Link Guardian" button
  - Fixed: Cloudflare email-decode script corruption in intake form
  - Fixed: truncated intake-request.html (missing closing tags)
  - Fixed: missing LICENSED_STATES in calendar .env
  - Fixed: .env newline concatenation bug
  - Fixed: extra closing brace in AddPatientForm handleCreate
- Files changed: ehr/src/lib/nostr.ts, patients.ts, ehr/src/app/page.tsx, patient-portal/src/app/page.tsx, patient-portal/src/lib/nostr.ts, billing/app/api/patients/confirm-ehr-sync/route.ts, calendar/server.js, calendar/db.js, calendar/public/intake-request.html, calendar/public/onboard.html
- GitHub: push pending

**March 12, 2026:**
- ✅ Phase 5: Virtual consultation intake system (intake form, EHR sidebar, website virtual care page)

**March 11, 2026:**
- ✅ Phase 19: Universal patient identity model

**March 8, 2026:**
- ✅ Kind remapping + calendar visit tracking + service agents polish

**March 7, 2026:**
- ✅ GitHub publish (v1.0.0)

**March 6, 2026:**
- ✅ NIP-17, Electron, TypeScript fixes

**March 5, 2026:**
- ✅ Portal WebAuthn PRF, billing revamp

**March 4, 2026:**
- ✅ Multi-User / Role-Based Access

**March 2, 2026:**
- ✅ Telehealth

---

## Bugs Fixed (March 13, 2026)

- Per-visit patients not synced to billing — removed `billingModel === "monthly"` guard
- confirm-ehr-sync returned 404 for new per-visit patients — added INSERT path (upsert)
- Extra closing brace in AddPatientForm handleCreate — caused "return not allowed here" build error
- intake-request.html corrupted with Cloudflare email-decode script — rebuilt from scratch
- intake-request.html truncated (missing `</script></body></html>`) — rebuilt from scratch
- LICENSED_STATES missing from calendar .env — states dropdown empty
- .env newline missing — `CALENDAR_ORIGIN=...LICENSED_STATES=CA` concatenated on one line
- Calendar route ordering — `/api/intake/active` after `/:id` caused Express to match "active" as an ID
