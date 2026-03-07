# Patient Portal Setup Instructions

## Step 1: Copy the patient-portal folder

Copy the entire `patient-portal` folder into your project:

FROM: (wherever you extracted the zip)
TO:   C:\Users\water\Desktop\PediatricAdvice.org\Nostr EHR\nostr-ehr-local\nostr-ehr\patient-portal

## Step 2: Install dependencies

```powershell
cd "C:\Users\water\Desktop\PediatricAdvice.org\Nostr EHR\nostr-ehr-local\nostr-ehr\patient-portal"
npm install
```

## Step 3: Run the portal (dev mode)

```powershell
npm run dev
```

Portal will run at: http://localhost:3001
(Your main EHR runs on 3000, portal on 3001)

## Step 4: Test login

1. Open http://localhost:3001
2. Get a patient's nsec from your EHR (Overview tab > Portal Access)
3. Paste the nsec into the login screen
4. You should see their records!

## Folder structure inside your project:

nostr-ehr/
  src/                  <- Your main EHR
  patient-portal/       <- New patient portal
    src/
      app/
        page.tsx        <- Main portal page
        layout.tsx      <- HTML layout
      lib/
        nostr.ts        <- Crypto library
        nip44.ts        <- Decryption library
    package.json
    tsconfig.json
    next.config.js
