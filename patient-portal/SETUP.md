# Patient Portal Setup Instructions

## Step 1: Install dependencies

```bash
cd patient-portal
npm install
```

## Step 2: Configure environment

Copy the example environment file and fill in your practice details:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your practice relay, pubkey, and service URLs. See `.env.example` for all available options.

## Step 3: Run the portal

**Development mode (local testing):**

```bash
npm run dev
```

Portal will run at: **http://localhost:3001** (EHR runs on 3000, portal on 3001)

**Production (server deployment):**

```bash
npm run build
pm2 start npm --name patient-portal -- start
```

Configure nginx to reverse-proxy your portal domain to port 3001. See `docs/DEPLOYMENT.md` for the full server setup guide.

## Step 4: Test login

1. Open the portal URL in a browser
2. Get a patient's nsec from your EHR (Overview tab → Portal Access)
3. Paste the nsec into the login screen
4. You should see their records

## Folder structure

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

## Authentication methods

The portal supports multiple login methods:

- **WebAuthn Passkey / YubiKey** — Strongest option, auto-triggered on supported browsers
- **PIN** — 4+ digit PIN with AES-GCM encrypted nsec in IndexedDB
- **NIP-07 browser extension** — Alby, nos2x, or other Nostr signing extensions
- **nsec direct entry** — Fallback, collapsible by default when other methods are available

On first login, patients enter their nsec. On PRF-capable browsers (Chrome, Edge), they're prompted to create a passkey for future logins. On Safari/Firefox, PIN setup is offered instead.
