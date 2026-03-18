#!/usr/bin/env node
/**
 * electron-build.js
 * 
 * Optimized Electron build script for NostrEHR.
 * 
 * Problem: electron-builder bundles ALL node_modules (~300MB+), including
 * electron itself, typescript, electron-builder, etc. into the installer.
 * 
 * Solution: 
 * 1. Run next build (needs all deps)
 * 2. Create a clean staging directory with only production deps
 * 3. Point electron-builder at the staged directory
 * 
 * Usage: node electron-build.js
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const STAGE = path.join(ROOT, ".electron-stage");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

console.log("=== NostrEHR Electron Build (Optimized) ===\n");

// Step 1: Build Next.js (needs all deps)
console.log("[1/5] Building Next.js...");
run("npx next build");

// Step 2: Create staging directory
console.log("[2/5] Creating staging directory...");
rmrf(STAGE);
fs.mkdirSync(STAGE, { recursive: true });
fs.mkdirSync(path.join(STAGE, "nextapp"), { recursive: true });

// Step 3: Copy only what's needed for production
console.log("[3/5] Copying production files...");

// Copy the Next.js build output
const copyItems = [
  { from: ".next", to: "nextapp/.next" },
  { from: "public", to: "nextapp/public" },
  { from: "next.config.js", to: "nextapp/next.config.js" },
  { from: "package.json", to: "nextapp/package.json" },
];

for (const item of copyItems) {
  const src = path.join(ROOT, item.from);
  const dst = path.join(STAGE, item.to);
  if (fs.existsSync(src)) {
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

// Step 3b: Overwrite practice-specific assets with generic defaults
const defaults = path.join(ROOT, "electron", "defaults");
if (fs.existsSync(defaults)) {
  const defaultFiles = fs.readdirSync(defaults);
  for (const f of defaultFiles) {
    const src = path.join(defaults, f);
    const dst = path.join(STAGE, "nextapp", "public", f);
    fs.copyFileSync(src, dst);
    console.log(`  → Replaced public/${f} with generic default`);
  }
}

// Step 4: Install only production dependencies in staging
console.log("[4/5] Installing production dependencies (this takes a minute)...");
run("npm install --omit=dev --ignore-scripts", { cwd: path.join(STAGE, "nextapp") });

// Copy electron files and package.json for the app shell
fs.cpSync(path.join(ROOT, "electron"), path.join(STAGE, "app", "electron"), { recursive: true });

// Copy package.json but strip the "build" section (electron-builder rejects it in app dir)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
delete pkg.build;
delete pkg.devDependencies;
fs.writeFileSync(path.join(STAGE, "app", "package.json"), JSON.stringify(pkg, null, 2));

// Step 5: Run electron-builder with custom config pointing to staged files
console.log("[5/5] Building installer...");

// Write a temporary electron-builder config that uses the staged directory
const builderConfig = {
  appId: "com.nostrehr.app",
  productName: "NostrEHR",
  copyright: "Copyright © 2026 NostrEHR Contributors",
  asar: false,
  directories: {
    output: path.join(ROOT, "dist-electron"),
    app: path.join(STAGE, "app"),
  },
  extraResources: [
    {
      from: path.join(STAGE, "nextapp"),
      to: "nextapp",
    },
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: path.join(ROOT, "electron", "icon.png"),
    artifactName: "NostrEHR-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "NostrEHR",
  },
  mac: {
    target: "dmg",
    category: "public.app-category.medical",
    icon: path.join(ROOT, "electron", "icon.png"),
    artifactName: "NostrEHR-${version}.${ext}",
  },
  linux: {
    target: ["AppImage"],
    category: "Office",
    icon: path.join(ROOT, "electron", "icon.png"),
    artifactName: "NostrEHR-${version}.${ext}",
  },
};

const configPath = path.join(STAGE, "builder-config.json");
fs.writeFileSync(configPath, JSON.stringify(builderConfig, null, 2));

run(`npx electron-builder --win --config "${configPath}"`);

// Cleanup staging
console.log("\nCleaning up staging directory...");
rmrf(STAGE);

console.log("\n=== Build complete! ===");
console.log(`Output: ${path.join(ROOT, "dist-electron")}`);

// Show size
const distDir = path.join(ROOT, "dist-electron");
if (fs.existsSync(distDir)) {
  const files = fs.readdirSync(distDir).filter(f => f.endsWith(".exe"));
  for (const f of files) {
    const size = fs.statSync(path.join(distDir, f)).size;
    console.log(`  ${f}: ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
}
