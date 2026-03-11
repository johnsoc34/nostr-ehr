# NostrEHR

**Sovereign pediatric electronic health records built on Nostr.**

NostrEHR is a complete EHR system where patient data is encrypted end-to-end using Nostr's cryptographic primitives and stored on a self-hosted relay. No cloud databases, no third-party data processors, no vendor lock-in. The practice owns its data, and patients hold their own keys.

Built for the Direct Primary Care model with Bitcoin payment support.

---

## Architecture

NostrEHR is a suite of 7 applications that work together:

| App | Description | Runs On |
|-----|-------------|---------|
| **EHR** | Provider-facing clinical workstation | Doctor's local PC (Electron) |
| **Patient Portal** | Patient-facing health records access | Server (public) |
| **Billing** | DPC membership management & invoicing | Server (private) |
| **Calendar** | Appointment scheduling (Express) | Server (private) |
| **Blossom** | Encrypted file storage (NIP-B7) | Server (private) |
| **FHIR API** | Read-only FHIR R4 endpoints | Server (private) |
| **Audit Trail** | Hourly relay event audit reports | Server (private) |

### Data Flow

```
Doctor (EHR) ──NIP-44 encrypt──▶ Self-hosted Nostr Relay ◀───NIP-44 decrypt── Patient (Portal)
                                         │
                                    SQLite (relay DB)
                                    Encrypted at rest
```

All clinical data is encrypted with NIP-44 dual encryption before leaving the EHR:
- **Practice copy**: encrypted to the practice pubkey (provider access)
- **Patient copy**: encrypted to the patient's pubkey (patient access via portal)

The relay stores only encrypted blobs. Even with full database access, data is unreadable without the private keys.

## Features

### Clinical
- **Encounters** — SOAP notes with dot phrase templates, encounter signing, addendums
- **Problem List** — SNOMED + ICD-10 coded conditions with append-only status tracking
- **Medications** — active/inactive tracking, allergy-interaction alerts
- **Immunizations** — vaccine tracking with CDC schedule evaluation
- **Lab & Imaging Orders** — ServiceRequest/DiagnosticReport with result attachment
- **Vitals & Growth Charts** — WHO (0-2yr) and CDC (2-20yr) percentile curves
- **Documents** — encrypted file attachments via Blossom (NIP-B7)
- **Clinical Decision Support** — immunization gap detection, well-child visit tracking

### Patient Portal
- **Multi-practice capable** — patients connect to any NostrEHR practice with one identity
- **Secure messaging** — encrypted provider-patient communication (kind 2117)
- **Health record access** — view encounters, vitals, medications, immunizations, labs
- **Data sovereignty** — Nostr export, FHIR R4 export, relay sync to personal relay
- **WebAuthn/YubiKey login** — PRF-based passkey authentication

See [Patient Portal Setup](patient-portal/SETUP.md) for login instructions and deployment guide.


### Infrastructure
- **Telehealth** — Nostr-signaled WebRTC video visits with TURN relay support
- **Multi-user access** — per-staff keypairs with ECDH shared secrets (kinds 2100-2102)
- **Service agents** — dedicated server keypairs for billing (NIP-17 DMs) and FHIR API (kind 2103)
- **Billing integration** — DPC membership management, NIP-17 encrypted invoice DMs
- **FHIR REST API** — read-only R4 endpoints with API key auth and scoping
- **Offline-first** — IndexedDB cache, write queue, sync reconciliation
- **Calendar visit tracking** — clickable color workflow (checked-in, ready, complete, signed) with inline schedule comments
- **PDF generation** — school excuse, immunization record, growth chart, sports physical, child care, kindergarten forms

### Security
- **NIP-44 dual encryption** on all clinical events
- **NIP-42 relay authentication** with pubkey whitelist
- **NIP-17 gift wraps** for billing DMs (sender-anonymous)
- **Practice key cold storage** — daily operations use staff keypairs
- **Service agent isolation** — server-side services use scoped keypairs, practice nsec never on server
- **WebAuthn/YubiKey** authentication for EHR and portal
- **15-minute session timeout** with security gate re-auth
- **Patient keys never persisted** — shown once at creation, only npub stored

## Nostr Event Kinds

### Organizational (NIP PR submitted)
| Kind | Resource | Description |
|------|----------|-------------|
| 2100 | PatientKeyGrant | Per-staff per-patient decryption grant |
| 2101 | PracticeKeyGrant | Per-staff practice-wide decryption grant |
| 2102 | StaffRoster | Encrypted staff member list and roles |
| 2103 | ServiceAgentGrant | Authorizes server-side service keypairs |

### Clinical
| Kind | Resource | Description |
|------|----------|-------------|
| 2110 | Patient | Demographics (name, DOB, sex) |
| 2111 | Encounter | SOAP notes, nurse notes |
| 2112 | MedicationRequest | Active/completed medications |
| 2113 | Observation | Vitals (weight, height, BMI, BP, HR, temp, SpO2) |
| 2114 | Condition | Problem list entries (SNOMED + ICD-10) |
| 2115 | AllergyIntolerance | Drug, food, environmental allergies |
| 2116 | Immunization | Vaccine administrations |
| 2117 | Message | Encrypted provider-patient messaging |
| 2118 | ServiceRequest | Lab/imaging orders |
| 2119 | DiagnosticReport | Lab/imaging results |
| 2120 | RxOrder | Prescription orders |
| 2121 | DocumentReference | Encrypted file attachment metadata |

### Telehealth Signaling
| Kind | Resource | Description |
|------|----------|-------------|
| 4050 | Lobby | Join/leave video call lobby |
| 4051 | SDPOffer | WebRTC SDP offer (provider → patient) |
| 4052 | SDPAnswer | WebRTC SDP answer (patient → provider) |
| 4053 | ICECandidate | ICE candidates (bidirectional) |
| 4054 | CallState | Mute/video toggle sync |
| 4055 | CallEnd | Call ended (persistent for audit) |

## Patient Data Sovereignty

NostrEHR is built on a fundamental principle: **patients own their health data.**

Because all clinical records are standard Nostr events containing FHIR R4 JSON, patients are not locked into any specific portal or application. With their nsec (private key) and the relay URL, a patient — or any developer they trust — can:

- **Build a custom portal** — Fork `patient-portal/` and modify the UI, add features, or build a mobile app. The data layer is just Nostr subscriptions + NIP-44 decryption.
- **Export to FHIR** — The built-in portal supports FHIR R4 Bundle export. Any FHIR-compatible system can ingest these records.
- **Use any Nostr client** — Messages (kind 2117) and billing invoices (kind 1059) are readable in standard Nostr clients that support NIP-17.
- **Mirror to another relay** — Patients can republish their events to a personal relay for redundancy or to share with another provider.
- **Write a client from scratch** — The data model is documented above. Any developer who understands Nostr and FHIR can build an alternative client.

### Encryption

Each event has two encrypted copies of the same FHIR JSON:

- `content` — Encrypted to the practice pubkey (NIP-44, practice can always read)
- `patient-content` tag — Encrypted to the patient pubkey (NIP-44, patient can always read their own data)

To decrypt your records, compute the NIP-44 shared secret between your nsec and the practice pubkey, then decrypt the `patient-content` tag value on each event.

### Building a Custom Client

A minimal patient client needs to:

1. Connect to the practice relay via WebSocket
2. Subscribe to events tagged with the patient's pubkey: `{"kinds": [2110,2111,2112,2113,2114,2115,2116,2117,2118,2119,2121], "#p": ["<patient_pubkey_hex>"]}`
3. For each event, decrypt the `patient-content` tag using NIP-44 with `getSharedSecret(patientSk, practicePubkey)`
4. Parse the decrypted string as FHIR R4 JSON

The `patient-portal/src/lib/` directory contains reference implementations of the Nostr connection, NIP-44 decryption, and FHIR data handling.

For the complete interoperability specification — including FHIR payload schemas, required tags, and connection string formats — see [INTEROPERABILITY.md](patient-portal/INTEROPERABILITY.md).

## Quick Start

### Option 1: Desktop App (Recommended for Evaluation)

Download `NostrEHR-Setup-1.0.0.exe` from [Releases](../../releases).

Run the installer. On first launch, choose **Demo Mode** to explore with a temporary keypair, or enter your own relay and practice key configuration.

### Option 2: Development Setup

```bash
# Clone the repo
git clone https://github.com/johnsoc34/nostr-ehr.git
cd nostr-ehr/ehr

# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your relay URL, practice pubkey, etc.

# Run in development
npm run dev

# Run in Electron (dev mode)
npm run electron:dev
```

### Option 3: Full Stack Deployment

For a complete self-hosted deployment (relay + portal + billing + calendar + blossom + FHIR API):

1. **Server**: Ubuntu 22+ on a VPS (Hetzner, DigitalOcean, etc.)
2. **Relay**: Build and install [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay), apply NIP-17/NIP-42 patch
3. **TURN**: Install coturn for telehealth NAT traversal
4. **Apps**: Deploy portal, billing, calendar, blossom, fhir-api with PM2 behind nginx
5. **EHR**: Run locally on the doctor's PC (Electron or `npm run dev`)

See [deployment guide](ehr/docs/DEPLOYMENT.md) for detailed instructions.

## Project Structure

```
nostr-ehr/
├── ehr/                    # EHR desktop app (Next.js + Electron)
│   ├── electron/           # Electron shell, setup wizard, splash
│   ├── src/app/page.tsx    # Main EHR SPA (~10,000+ lines)
│   └── src/lib/            # nostr.ts, nip44.ts, fhir.ts, growth.ts, etc.
├── patient-portal/         # Patient portal (Next.js, server-deployed)
├── billing/                # Billing dashboard (Next.js, server-deployed)
├── calendar/               # Calendar/scheduling (Express, server-deployed)
├── fhir-api/               # FHIR REST API (Express, server-deployed)
├── blossom/                # File server config (NIP-B7)
├── audit/                  # Audit trail scripts
└── relay/                  # Relay config template + NIP-17 patch
```

## Technology Stack

- **Frontend**: Next.js 14, React 18, TypeScript
- **Desktop**: Electron
- **Protocol**: Nostr (NIP-44, NIP-42, NIP-17, NIP-07, NIP-B7)
- **Encryption**: NIP-44 (ChaCha20-Poly1305 + HKDF), AES-256-GCM (documents)
- **Auth**: WebAuthn PRF (passkeys/YubiKey), PBKDF2 PIN fallback
- **Relay**: nostr-rs-relay 0.9.0 (Rust, SQLite)
- **Telehealth**: WebRTC (DTLS-SRTP), coturn TURN relay
- **Server**: PM2, nginx, Let's Encrypt
- **Database**: SQLite (billing, FHIR API keys), nostr-rs-relay SQLite (clinical data)

## Requirements

- **Node.js** 18.17+ (LTS recommended; 20.x used in production)
- **Relay**: Self-hosted nostr-rs-relay 0.9.0 (for production use)
- **TURN server**: coturn (required for telehealth video visits across NAT/firewalls)
- **Server**: Any Linux VPS for portal/billing/calendar (optional for evaluation)

> **Note:** nostr-rs-relay requires a patch to exempt kind 1059 (NIP-17 gift wraps) from NIP-42 authentication, and `max_event_bytes` must be set to at least 65536 for telehealth SDP signaling. See the [deployment guide](ehr/docs/DEPLOYMENT.md) for details.

## Contributing

NostrEHR is open source under the MIT license. Contributions welcome.

This is a real medical system prepared for production. Please be thoughtful with changes that affect clinical data handling, encryption, or patient safety. PRs that touch encryption logic, key management, or clinical write paths require extra review. Open an issue before starting major work so we can coordinate.

## License

MIT

## Acknowledgments

Built on the [Nostr protocol](https://nostr.com) and the work of the open-source Nostr community. Secp256k1, Schnorr signatures, NIP-44 (ChaCha20-Poly1305), and ECDH are implemented from scratch in pure TypeScript with no external crypto dependencies.
