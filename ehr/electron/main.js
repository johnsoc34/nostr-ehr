const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// ─── Paths ───────────────────────────────────────────────────────────────────
const USER_DATA = app.getPath("userData");
const CONFIG_PATH = path.join(USER_DATA, "config.json");
const isDev = !app.isPackaged;

// In production, the Next.js app is at resources/nextapp
// In dev, it's at ../  (the ehr/ directory)
const NEXT_APP_DIR = isDev
  ? path.resolve(__dirname, "..")
  : path.join(process.resourcesPath, "nextapp");

const ENV_LOCAL_PATH = path.join(NEXT_APP_DIR, ".env.local");

let mainWindow = null;
let setupWindow = null;
let nextProcess = null;
let nextPort = 3000;

// ─── Config Management ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {}
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function writeEnvLocal(config) {
  const lines = [
    `NEXT_PUBLIC_RELAY_URL=${config.relayUrl || ""}`,
    `NEXT_PUBLIC_PRACTICE_PUBKEY=${config.practicePubkey || ""}`,
    `NEXT_PUBLIC_PRACTICE_NAME=${config.practiceName || ""}`,
    `NEXT_PUBLIC_PORTAL_URL=${config.portalUrl || ""}`,
    `NEXT_PUBLIC_BILLING_URL=${config.billingUrl || ""}`,
    `NEXT_PUBLIC_CALENDAR_URL=${config.calendarUrl || ""}`,
    `NEXT_PUBLIC_BLOSSOM_URL=${config.blossomUrl || ""}`,
    `NEXT_PUBLIC_TURN_API_KEY=${config.turnApiKey || ""}`,
    `NEXT_PUBLIC_PRACTICE_ADDRESS=${config.practiceAddress || ""}`,
    `NEXT_PUBLIC_PRACTICE_CITY_STATE_ZIP=${config.practiceCityStateZip || ""}`,
    `NEXT_PUBLIC_PRACTICE_PHONE=${config.practicePhone || ""}`,
    `NEXT_PUBLIC_PRACTICE_FAX=${config.practiceFax || ""}`,
    `NEXT_PUBLIC_PRACTICE_PROVIDER=${config.practiceProvider || ""}`,
  ];
  fs.writeFileSync(ENV_LOCAL_PATH, lines.join("\n") + "\n", "utf-8");
}

// ─── Find Available Port ────────────────────────────────────────────────────
async function findPort(start = 3000) {
  const net = require("net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(start, () => {
      server.close(() => resolve(start));
    });
    server.on("error", () => resolve(findPort(start + 1)));
  });
}

// ─── Start Next.js Server ───────────────────────────────────────────────────
function startNextServer(port) {
  return new Promise((resolve, reject) => {
    const npxPath = process.platform === "win32" ? "npx.cmd" : "npx";

    // In production, use `next start`. In dev, use `next dev`.
    const args = isDev
      ? ["next", "dev", "-p", String(port)]
      : ["next", "start", "-p", String(port)];

    nextProcess = spawn(npxPath, args, {
      cwd: NEXT_APP_DIR,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    // Store PID for forceful cleanup on Windows
    nextProcess._pid = nextProcess.pid;

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        started = true;
        // Even if we don't see the ready message, try loading after 15s
        resolve(port);
      }
    }, 15000);

    nextProcess.stdout.on("data", (data) => {
      const output = data.toString();
      console.log("[next]", output.trim());
      if (!started && (output.includes("Ready") || output.includes("ready") || output.includes(`localhost:${port}`))) {
        started = true;
        clearTimeout(timeout);
        // Small delay to ensure server is fully ready
        setTimeout(() => resolve(port), 500);
      }
    });

    nextProcess.stderr.on("data", (data) => {
      console.error("[next:err]", data.toString().trim());
    });

    nextProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    nextProcess.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Next.js exited with code ${code}`));
      }
      nextProcess = null;
    });
  });
}

// ─── Setup Window (First Launch) ────────────────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 720,
    height: 840,
    resizable: true,
    frame: true,
    title: "NostrEHR — Practice Setup",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, "setup.html"));

  setupWindow.on("closed", () => {
    setupWindow = null;
    // If setup was closed without saving, quit
    if (!loadConfig()) {
      app.quit();
    }
  });
}

// ─── Main EHR Window ────────────────────────────────────────────────────────
function createMainWindow(port) {
  const config = loadConfig();
  const title = config?.practiceName
    ? `${config.practiceName} — NostrEHR`
    : "NostrEHR";

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://localhost:${port}`);

  // Inject runtime config before React hydrates
  mainWindow.webContents.on("dom-ready", () => {
    const config = loadConfig();
    if (!config) return;
    const json = JSON.stringify({
      practicePubkey: config.practicePubkey || "",
      practiceName: config.practiceName || "",
      relayUrl: config.relayUrl || "",
      billingUrl: config.billingUrl || "",
      calendarUrl: config.calendarUrl || "",
      portalUrl: config.portalUrl || "",
      blossomUrl: config.blossomUrl || "",
      turnApiKey: config.turnApiKey || "",
      demoMode: config.demoMode || false,
    });
    mainWindow.webContents.executeJavaScript(`window.__NOSTREHR_CONFIG__ = ${json};`);
  });
  
  // Inject demo mode banner and auto-login if in demo mode
  mainWindow.webContents.on("did-finish-load", () => {
    const config = loadConfig();
    if (config?.demoMode) {
      const bannerText = "DEMO MODE — Connected to public test relay. Do not enter real patient data.";
      const demoNsec = config.demoNsec || "";

      mainWindow.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('demo-banner')) return;
          var banner = document.createElement('div');
          banner.id = 'demo-banner';
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:linear-gradient(90deg,#92400e,#b45309);color:#fef3c7;padding:8px 16px;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:12px;font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
          banner.innerHTML = '<span>\\u26A0\\uFE0F ${bannerText}</span><button id=\\"demo-configure-btn\\" style=\\"background:#fef3c7;color:#92400e;border:none;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;margin-left:8px;\\">\\u2699\\uFE0F Configure Practice</button>';
          document.body.prepend(banner);
          document.body.style.paddingTop = '40px';
          document.getElementById('demo-configure-btn').addEventListener('click', function() {
            if (window.electronAPI) window.electronAPI.openSettings();
          });

          var demoPk = '${config.practicePubkey || ""}';
          if (demoPk) localStorage.setItem('__nostrehr_practice_pk__', demoPk);
          var nsec = '${demoNsec}';
          if (nsec) {
            var tryLogin = function(attempts) {
              if (attempts <= 0) return;
              var inputs = document.querySelectorAll('input');
              var nsecInput = null;
              for (var i = 0; i < inputs.length; i++) {
                if (inputs[i].placeholder && inputs[i].placeholder.indexOf('nsec') >= 0) {
                  nsecInput = inputs[i];
                  break;
                }
              }
              if (nsecInput) {
                var nativeSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, 'value'
                ).set;
                nativeSetter.call(nsecInput, nsec);
                nsecInput.dispatchEvent(new Event('input', { bubbles: true }));
                nsecInput.dispatchEvent(new Event('change', { bubbles: true }));
                setTimeout(function() {
                  var buttons = document.querySelectorAll('button');
                  for (var j = 0; j < buttons.length; j++) {
                    var txt = buttons[j].textContent || '';
                    if (txt.indexOf('Login') >= 0 || txt.indexOf('Unlock') >= 0) {
                      buttons[j].click();
                      break;
                    }
                  }
                }, 300);
              } else {
                setTimeout(function() { tryLogin(attempts - 1); }, 500);
              }
            };
            setTimeout(function() { tryLogin(10); }, 1000);
          }
        })();
      `);
    }
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Splash Window (while Next.js boots) ────────────────────────────────────
function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { contextIsolation: true },
  });

  splash.loadFile(path.join(__dirname, "splash.html"));
  return splash;
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────
ipcMain.handle("get-config", () => loadConfig());

ipcMain.handle("save-config", async (event, config) => {
  saveConfig(config);
  writeEnvLocal(config);
  return { success: true };
});

ipcMain.handle("setup-complete", async () => {
  if (setupWindow) {
    setupWindow.close();
    setupWindow = null;
  }
  // If main window exists (reconfiguring from demo mode), restart the app
  if (mainWindow) {
    mainWindow.close();
    mainWindow = null;
    if (nextProcess) {
      nextProcess.kill();
      nextProcess = null;
    }
  }
  await launchEHR();
});

ipcMain.handle("open-settings", () => {
  createSetupWindow();
});

ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("get-data-path", () => USER_DATA);

// ─── Launch EHR ─────────────────────────────────────────────────────────────
async function launchEHR() {
  const splash = createSplashWindow();

  try {
    nextPort = await findPort(3000);
    await startNextServer(nextPort);
    createMainWindow(nextPort);
  } catch (err) {
    dialog.showErrorBox(
      "NostrEHR — Startup Error",
      `Failed to start the EHR server:\n\n${err.message}\n\nPlease check that Node.js is installed and try again.`
    );
    app.quit();
    return;
  }

  // Close splash once main window is ready
  if (mainWindow) {
    mainWindow.once("ready-to-show", () => {
      if (!splash.isDestroyed()) splash.close();
    });
    // Fallback: close splash after 3s even if ready-to-show doesn't fire
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close();
    }, 3000);
  } else {
    if (!splash.isDestroyed()) splash.close();
  }
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const config = loadConfig();

  if (!config) {
    // First launch — show setup
    createSetupWindow();
  } else {
    // Config exists — write .env.local (in case app was moved) and launch
    writeEnvLocal(config);
    await launchEHR();
  }
});

function killNext() {
  if (!nextProcess) return;
  try {
    if (process.platform === "win32") {
      // shell: true on Windows spawns cmd.exe which doesn't forward kill to children
      require("child_process").execSync(`taskkill /F /T /PID ${nextProcess.pid}`, { stdio: "ignore" });
    } else {
      nextProcess.kill("SIGTERM");
    }
  } catch {}
  nextProcess = null;
}

app.on("window-all-closed", () => {
  killNext();
  app.quit();
});

app.on("before-quit", () => {
  killNext();
});
