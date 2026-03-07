# NostrEHR — Electron Desktop Wrapper

## Overview

The Electron wrapper packages the NostrEHR web application as a native desktop app
with a first-launch setup wizard, bundled Next.js server, and Windows installer (.exe).

## Directory Structure

```
ehr/
├── electron/
│   ├── main.js          # Electron main process
│   ├── preload.js       # IPC bridge (renderer ↔ main)
│   ├── setup.html       # First-launch configuration wizard
│   ├── splash.html      # Loading screen while Next.js boots
│   └── icon.png         # App icon (256x256 minimum)
├── src/                  # Existing Next.js EHR app
├── package.json          # Merged with Electron deps
└── next.config.js
```

## How It Works

1. **First Launch:** Electron checks for `config.json` in the user data directory.
   If not found, the setup wizard (`setup.html`) is shown.

2. **Setup Wizard:** A 3-step form collects:
   - Step 1: Relay URL, practice pubkey, practice name (required)
   - Step 2: Portal, billing, calendar, blossom URLs + TURN credentials (optional)
   - Step 3: Practice details for PDF generation (optional)

3. **Config Storage:** Configuration is saved to:
   - `%APPDATA%/NostrEHR/config.json` (Windows)
   - `~/Library/Application Support/NostrEHR/config.json` (macOS)
   - `~/.config/NostrEHR/config.json` (Linux)

4. **Server Boot:** Electron spawns `next start` on an available port (default 3000),
   shows a splash screen while it boots, then loads the EHR in a BrowserWindow.

5. **Subsequent Launches:** Config exists → write `.env.local` → boot server → show EHR.

## Setup

### Prerequisites
- Node.js 18+ (LTS recommended)
- npm or yarn

### Install Dependencies

```bash
cd ehr/
npm install
npm install --save-dev electron electron-builder concurrently wait-on
```

### Development

Run the EHR in Electron with hot reload:

```bash
npm run electron:dev
```

This starts Next.js dev server + Electron concurrently.

### Build Windows Installer

```bash
npm run electron:build
```

Output: `dist-electron/NostrEHR-Setup-1.0.0.exe`

### Build for All Platforms

```bash
npm run electron:build:all
```

## Merging with Existing package.json

The `electron-package-additions.json` file contains the fields to merge into
your existing EHR `package.json`. Specifically:

1. Add `"main": "electron/main.js"` to the root
2. Add the `electron:*` scripts to `"scripts"`
3. Add the `"build"` section (electron-builder config)
4. Add `electron`, `electron-builder`, `concurrently`, `wait-on` to `"devDependencies"`

## App Icon

Replace `electron/icon.png` with your practice logo. Minimum size: 256x256 pixels.
For best results on Windows, also provide `icon.ico` (multi-resolution).

## Environment Variables

The setup wizard writes all configuration to `.env.local` in the Next.js app directory.
The EHR reads these via `process.env.NEXT_PUBLIC_*` at build/runtime.

## Security Notes

- The Electron app runs **locally only** — no network exposure
- Patient data is encrypted end-to-end (NIP-44) before leaving the app
- The practice nsec is never stored by the Electron wrapper
- Config contains only public practice metadata (relay URL, pubkey, URLs)
- WebAuthn/YubiKey login works natively in Electron's Chromium
