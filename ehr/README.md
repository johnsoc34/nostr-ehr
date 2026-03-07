# NostrEHR — Local Development Setup

**Phase 2: Real Nostr Cryptography**

This is the local Next.js project for NostrEHR. It uses real secp256k1 keypairs,
genuine Schnorr signatures, and FHIR R4 resource structures.

---

## Prerequisites

- Node.js 18+ (check: `node --version`)
- npm 9+ (check: `npm --version`)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start development server
npm run dev

# 3. Open in browser
open http://localhost:3000
```

---

## Project Structure

```
nostr-ehr/
├── src/
│   ├── lib/
│   │   ├── nostr.ts        ← Core crypto: keypairs, signing, verification
│   │   └── fhir.ts         ← FHIR R4 resource builders
│   ├── components/         ← React UI components (to be added)
│   └── app/                ← Next.js app router pages
├── package.json
└── README.md
```

---

## Key Files to Understand

### `src/lib/nostr.ts`
The heart of the system. Contains:
- `generateKeypair()` — creates real secp256k1 keys
- `signFhirEvent()` — wraps a FHIR resource in a signed Nostr event
- `FHIR_KINDS` — event kind number constants for each resource type
- `verifyNostrEvent()` — verifies a signature without the private key

### `src/lib/fhir.ts`
FHIR R4 resource builders:
- `buildEncounter()` — SOAP note → FHIR Encounter
- `buildMedicationRequest()` — Med order → FHIR MedicationRequest
- `buildLabObservation()` — Lab result → FHIR Observation

---

## Phase Roadmap

| Phase | Status | What it adds |
|-------|--------|-------------|
| 1 | ✅ Done | UI prototype, simulated crypto |
| 2 | ✅ Now | Real nostr-tools keypairs + signing |
| 3 | Next | strfry relay on VPS, NIP-42 auth |
| 4 | Later | Full FHIR serialization in events |
| 5 | Later | NIP-44 encryption of PHI |
| 6 | Later | Full SOAP note creation workflow |
| 7 | Later | Patient portal (read-only) |
| 8 | Later | HIPAA documentation finalized |

---

## ⚠️ Phase 2 Security Notice

Events in Phase 2 are signed but **not encrypted**. The FHIR payload is
plaintext JSON inside the Nostr event content.

**Do not use real patient data until Phase 5 (NIP-44 encryption) is complete.**

Use synthetic/demo data only during development.

---

## Environment Variables (Phase 3+)

Create a `.env.local` file (never commit this):

```bash
# Practice private key — hex encoded, generated once
# Store a backup encrypted offline (USB drive in a safe)
PRACTICE_NSEC=nsec1...

# Relay WebSocket URL
RELAY_URL=wss://relay.yourpractice.com

# Database
DATABASE_URL=postgresql://localhost:5432/nostr_ehr
```

---

## Dependencies

- **`@nostr/tools`** — Nostr protocol: keypairs, signing, verification, NIPs
- **`next`** — React framework with API routes (your app server)
- **`react`** / **`react-dom`** — UI
- **`typescript`** — Type safety (strongly recommended for crypto code)
- **`tailwindcss`** — Utility CSS

---

## Useful Commands

```bash
# Type-check without building
npx tsc --noEmit

# Test the nostr lib directly (Node.js)
node -e "
const { generateKeypair } = require('./src/lib/nostr.ts');
const kp = generateKeypair();
console.log('npub:', kp.npub);
"
```
