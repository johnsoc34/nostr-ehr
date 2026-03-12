# Patient Portal

The NostrEHR Patient Portal gives patients direct access to their encrypted medical records using their Nostr keypair. No account creation, no email, no passwords — just your key.

## For Patients

### Access Your Records

If your practice runs NostrEHR, you can access your records at their portal URL (ask your practice for the link). You'll need the access code (nsec) your provider gave you when they set up your chart.

**Login methods (in order of security):**

1. **Passkey / YubiKey** — Tap to login. Set up automatically on your first visit (Chrome, Edge).
2. **PIN** — 4+ digit PIN. Offered on Safari/Firefox where passkeys aren't fully supported.
3. **NIP-07 extension** — If you use a Nostr signing extension (Alby, nos2x, etc.).
4. **Access code (nsec)** — Direct entry. Use this for your first login, then set up a passkey or PIN.

### What You Can Do

- View visit notes, vitals, medications, immunizations, allergies, and lab results
- Send and receive encrypted messages with your provider
- Join telehealth video visits
- Export your complete medical record (Nostr events or FHIR R4 format)
- Connect to multiple practices — your key works across any NostrEHR provider
- Connect to your own private health relay.

### Data Sovereignty

Your records are encrypted with your personal key. Your practice has their copy, and you have yours — neither party needs permission from the other to access their copy. If you switch providers, your data goes with you.

You can view your records at any compatible portal — including [portal.immutablehealthpediatrics.com](https://portal.immutablehealthpediatrics.com).
---

## For Practice Administrators

### Step 1: Install dependencies

```bash
cd patient-portal
npm install
```

### Step 2: Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your practice relay URL, public key, and service URLs. See `.env.example` for all available options.

### Step 3: Deploy

**Development (local testing):**

```bash
npm run dev
```

Portal runs at http://localhost:3001 (EHR uses 3000).

**Production (server):**

```bash
npm run build
pm2 start npm --name patient-portal -- start
```

Configure nginx to reverse-proxy your portal domain to port 3001. See `docs/DEPLOYMENT.md` for the full server setup guide.

### Step 4: Test login

1. Open the portal URL in a browser
2. Get a patient's nsec from the EHR (Overview tab → Portal Access)
3. Paste the nsec into the login screen
4. Verify their records load correctly

### Folder structure

```
patient-portal/
├── src/
│   ├── app/
│   │   ├── page.tsx          # Main portal SPA
│   │   └── layout.tsx        # HTML layout / metadata
│   └── lib/
│       ├── nostr.ts          # Nostr protocol + crypto
│       ├── nip44.ts          # NIP-44 decryption
│       ├── telehealth.ts     # WebRTC video visit signaling
│       └── VideoRoom.tsx     # Telehealth UI component
├── .env.example              # Environment variable template
├── next.config.js
├── package.json
└── tsconfig.json
```

### Multi-Practice Support

The portal is practice-agnostic. A single portal instance can serve patients from multiple NostrEHR practices. Patients connect to any practice by entering their nsec — the portal discovers which relay and practice key to use from the patient's stored events. Patients can also add additional practice connections from the My Data tab.
