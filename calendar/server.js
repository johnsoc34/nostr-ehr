/**
 * server.js — Immutable Health Calendar Service
 * Runs on port 3002
 */

require("dotenv").config({ path: "/opt/immutable-health-calendar/.env" });
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const db      = require("./db");
const { sendReminders } = require("./reminders");

const app  = express();
const PORT = process.env.PORT || 3003;




const PRACTICE_NAME = process.env.PRACTICE_NAME || "Immutable Health Pediatrics";
const PRACTICE_PK = process.env.PRACTICE_PK || "";

// Approval email via Resend


app.use(cors({
  origin: [
    "https://calendar.immutablehealthpediatrics.com",
    "https://portal.immutablehealthpediatrics.com",
    "https://billing.immutablehealthpediatrics.com",
    "http://localhost:3000",
  ],
  credentials: true,
}));
app.use(express.json());

// Rate limit appointment creation (public endpoint)
const rateLimit = require("express-rate-limit");
const appointmentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 appointments per IP per hour
  message: { error: "Too many appointment requests. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/appointments", (req, res, next) => {
  if (req.method === "POST" && !req.session.authed) return appointmentLimiter(req, res, next);
  next();
});

// ─── Session auth ─────────────────────────────────────────────────────────────
const session = require("express-session");
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.CALENDAR_SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const CALENDAR_PASSWORD_HASH = process.env.CALENDAR_PASSWORD_HASH || "";

function requireAuth(req, res, next) {
  // Public routes: login, logout, TURN credentials, and portal-facing patient endpoints
  if (req.path === "/login" || req.path === "/logout" || req.path === "/api/turn-credentials") {
    return next();
  }
  // Portal reads: patient appointments (scoped by npub) and available slots
  // Portal writes: create appointment (requires patient_npub in body)
  if (req.path.startsWith("/api/appointments/patient/") || req.path.startsWith("/api/availability/") || (req.path === "/api/appointments" && req.method === "POST")) {
    return next();
  }
  // EHR calendar view: appointment queries, visit tracking, and management
  if (req.path === "/api/appointments" && req.method === "GET") {
    return next();
  }
  if (req.path.match(/^\/api\/appointments\/\d+/) && ["GET","PATCH"].includes(req.method)) {
    return next();
  }
  if (req.session.authed) {
    return next();
  }
  // API routes return 401 JSON, page routes redirect to login
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.redirect("/login");
}
app.use(requireAuth);

app.get("/login", (req, res) => {
  if (req.session.authed) return res.redirect("/");
  const err = req.query.error ? "<div class=\"err\">Incorrect password. Please try again.</div>" : "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Immutable Health Calendar</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;background:#0a0d12;display:flex;align-items:center;justify-content:center;
    font-family:'DM Sans','IBM Plex Sans',system-ui,sans-serif;padding:24px;color:#e8edf5}
  .bg{position:fixed;inset:0;z-index:0;
    background-image:linear-gradient(#1e2d44 1px,transparent 1px),linear-gradient(90deg,#1e2d44 1px,transparent 1px);
    background-size:48px 48px;opacity:0.3;
    mask-image:radial-gradient(ellipse 80% 60% at 50% 40%,black 40%,transparent 100%)}
  .card{background:#111620;border:1px solid #1e2d44;border-radius:14px;padding:36px 40px;
    width:100%;max-width:400px;position:relative;z-index:1}
  .logo{width:52px;height:52px;border-radius:12px;
    background:linear-gradient(135deg,#f7931a,#fbb040);
    display:flex;align-items:center;justify-content:center;
    margin:0 auto 16px;font-size:24px;box-shadow:0 4px 20px #f7931a40}
  .title{text-align:center;font-size:20px;font-weight:800;color:#e8edf5;
    letter-spacing:-0.02em;margin-bottom:4px}
  .sub{text-align:center;font-size:13px;color:#6b7fa3;margin-bottom:28px}
  label{display:block;font-size:11px;font-weight:600;color:#6b7fa3;
    text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px}
  input{width:100%;background:#1a2233;border:1px solid #1e2d44;border-radius:8px;
    padding:11px 14px;color:#e8edf5;font-size:14px;font-family:inherit;outline:none;
    transition:border-color 0.15s}
  input:focus{border-color:#f7931a}
  .btn{width:100%;margin-top:20px;padding:12px;border-radius:8px;border:none;
    background:linear-gradient(135deg,#f7931a,#fbb040);color:#fff;font-size:15px;
    font-weight:700;cursor:pointer;font-family:inherit;
    box-shadow:0 2px 12px #f7931a40;transition:opacity 0.15s}
  .btn:hover{opacity:0.9}
  .err{background:#ef444415;border:1px solid #ef444440;border-radius:8px;
    padding:10px 14px;color:#ef4444;font-size:13px;margin-bottom:16px}
</style>
</head>
<body>
<div class="bg"></div>
<div class="card">
  <div class="logo">📅</div>
  <div class="title">Immutable Health</div>
  <div class="sub">Calendar &amp; Scheduling</div>
  ${err}
  <form method="POST" action="/login">
    <div style="margin-bottom:4px">
      <label>Dashboard Password</label>
      <input type="password" name="password" placeholder="Enter password" autofocus/>
    </div>
    <button class="btn" type="submit">Sign In &#8594;</button>
  </form>
</div>
</body>
</html>`);
});

app.post("/login", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const match = await bcrypt.compare(req.body.password, CALENDAR_PASSWORD_HASH);
    if (match) {
      req.session.authed = true;
      req.session.save(() => res.redirect("/"));
    } else {
      res.redirect("/login?error=1");
    }
  } catch {
    res.redirect("/login?error=1");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── TURN ephemeral credentials (API key auth, not session) ──────────────────
const TURN_API_KEY = process.env.TURN_API_KEY || "";
const TURN_SECRET  = process.env.TURN_SECRET  || "";
const TURN_HOST    = process.env.TURN_HOST    || "";

app.get("/api/turn-credentials", (req, res) => {
  // Validate bearer token
  const auth = req.headers.authorization;
  if (!TURN_API_KEY || !auth || auth !== `Bearer ${TURN_API_KEY}`) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  if (!TURN_SECRET || !TURN_HOST) {
    return res.status(503).json({ error: "TURN not configured" });
  }

  // TURN REST API: time-limited credentials (RFC 5766 / coturn use-auth-secret)
  const ttl = 86400; // 24 hours
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:nostrehr`;
  const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("base64");

  res.json({
    username,
    credential,
    ttl,
    uris: [
      `turn:${TURN_HOST}:3478`,
      `turns:${TURN_HOST}:5349`,
      `turn:${TURN_HOST}:3478?transport=tcp`,
    ],
  });
});

app.use(express.static(path.join(__dirname, "public")));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "immutable-health-calendar", ts: Date.now() });
});

// ─── Availability Templates ───────────────────────────────────────────────────

// GET /api/availability/templates
app.get("/api/availability/templates", (req, res) => {
  try {
    res.json(db.getTemplates());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/availability/templates
app.post("/api/availability/templates", (req, res) => {
  try {
    const { day_of_week, start_time, end_time, duration_min } = req.body;
    if (day_of_week === undefined || !start_time || !end_time)
      return res.status(400).json({ error: "day_of_week, start_time, end_time required" });
    const result = db.upsertTemplate(day_of_week, start_time, end_time, duration_min || 30);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/availability/templates/:id
app.delete("/api/availability/templates/:id", (req, res) => {
  try {
    db.deleteTemplate(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Availability Overrides ───────────────────────────────────────────────────

// GET /api/availability/overrides?start=2026-03-01&end=2026-03-31
app.get("/api/availability/overrides", (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end required" });
    res.json(db.getOverridesForRange(start, end));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/availability/overrides
app.post("/api/availability/overrides", (req, res) => {
  try {
    const { date, start_time, end_time, override_type, reason } = req.body;
    if (!date || !start_time || !end_time || !override_type)
      return res.status(400).json({ error: "date, start_time, end_time, override_type required" });
    const result = db.addOverride(date, start_time, end_time, override_type, reason);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/availability/overrides/:id
app.delete("/api/availability/overrides/:id", (req, res) => {
  try {
    db.deleteOverride(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/availability/:date — available slots for a specific date
app.get("/api/availability/:date", (req, res) => {
  try {
    const slots = db.getAvailableSlotsForDate(req.params.date);
    res.json(slots);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Appointments ─────────────────────────────────────────────────────────────

// GET /api/appointments?date=2026-03-05
// GET /api/appointments?start=2026-03-01&end=2026-03-31
app.get("/api/appointments", (req, res) => {
  try {
    const { date, start, end } = req.query;
    if (date) {
      return res.json(db.getAppointmentsForDate(date));
    }
    if (start && end) {
      return res.json(db.getAppointmentsForRange(start, end));
    }
    res.status(400).json({ error: "date or start+end required" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/appointments/patient/:npub — patient's upcoming appointments
app.get("/api/appointments/patient/:npub", (req, res) => {
  try {
    res.json(db.getAppointmentsForPatient(req.params.npub));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/appointments/:id
app.get("/api/appointments/:id", (req, res) => {
  try {
    const appt = db.getAppointmentById(req.params.id);
    if (!appt) return res.status(404).json({ error: "Not found" });
    res.json(appt);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// POST /api/appointments — create appointment (doctor manual or patient self-book)
app.post("/api/appointments", (req, res) => {
  try {
    const {
      patient_npub, patient_name, patient_phone,
      date, start_time, end_time, appt_type,
      notes, video_url, is_auto_booked
    } = req.body;

    if (!patient_npub || !patient_name || !date || !start_time || !end_time)
      return res.status(400).json({ error: "patient_npub, patient_name, date, start_time, end_time required" });

    // Check if slot is available (skip for doctor-created appointments via force flag)
    if (!req.body.force || !req.session.authed) {
      const available = db.getAvailableSlotsForDate(date);
      const slotOpen = available.some(s => s.start_time === start_time);

      // Auto-confirm if booking an open slot, otherwise pending
      const status = slotOpen ? "confirmed" : "pending";

      const result = db.createAppointment({
        patient_npub,
        patient_name,
        patient_phone: patient_phone || null,
        date,
        start_time,
        end_time,
        appt_type: appt_type || "in_person",
        status,
        notes: notes || null,
        video_url: video_url || null,
        is_auto_booked: slotOpen ? 1 : 0,
        visit_color: null,
        schedule_comment: null,
      });
      return res.json({ id: result.lastInsertRowid, status });
    }

    // Doctor manually creating — always confirmed
    const result = db.createAppointment({
      patient_npub,
      patient_name,
      patient_phone: patient_phone || null,
      date,
      start_time,
      end_time,
      appt_type: appt_type || "in_person",
      status: "confirmed",
      notes: notes || null,
      video_url: video_url || null,
      is_auto_booked: 0,
      visit_color: null,
      schedule_comment: null,
    });
    res.json({ id: result.lastInsertRowid, status: "confirmed" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/appointments/:id/status
app.patch("/api/appointments/:id/status", (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending","confirmed","cancelled","declined"].includes(status))
      return res.status(400).json({ error: "Invalid status" });
    db.updateAppointmentStatus(req.params.id, status);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/appointments/:id/visit — update visit_color and/or schedule_comment
app.patch("/api/appointments/:id/visit", (req, res) => {
  try {
    const { visit_color, schedule_comment } = req.body;
    db.updateVisitTracking(req.params.id, { visit_color, schedule_comment });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/appointments/:id — full update
app.put("/api/appointments/:id", (req, res) => {
  try {
    const { date, start_time, end_time, appt_type, notes, video_url, status, visit_color, schedule_comment } = req.body;
    db.updateAppointment(req.params.id, { date, start_time, end_time, appt_type, notes, video_url, status, visit_color: visit_color || null, schedule_comment: schedule_comment || null });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/appointments/:id
app.delete("/api/appointments/:id", (req, res) => {
  try {
    db.deleteAppointment(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Reminder trigger (called by cron) ────────────────────────────────────────

app.post("/api/reminders/send", async (req, res) => {
  try {
    await sendReminders();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// POST /api/whitelist/sync — regenerate relay whitelist from billing DB + restart relay
app.post("/api/whitelist/sync", async (req, res) => {
  try {
    const fs = require("fs");
    const { execSync } = require("child_process");

    // 1. Read current config.toml
    const configPath = "/home/nostr/config.toml";
    let config = fs.readFileSync(configPath, "utf8");

    // 2. Get all active npubs from billing DB
    const npubs = db.getAllActiveNpubs();

    // 3. Convert npubs to hex pubkeys
    // npub1... → hex. We need to bech32-decode them.
    const hexKeys = [];
    for (const npub of npubs) {
      try {
        // bech32 decode npub to hex
        const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        const data = npub.slice(5); // remove "npub1"
        const values = [];
        for (const c of data) {
          const v = CHARSET.indexOf(c);
          if (v === -1) continue;
          values.push(v);
        }
        // Convert 5-bit groups to 8-bit
        let acc = 0, bits = 0;
        const bytes = [];
        for (const v of values.slice(0, -6)) { // exclude checksum
          acc = (acc << 5) | v;
          bits += 5;
          while (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
          }
        }
        if (bytes.length === 32) {
          hexKeys.push(bytes.map(b => b.toString(16).padStart(2, "0")).join(""));
        }
      } catch { /* skip invalid npubs */ }
    }

    // 4. Always include practice pubkey
    const practicePk = PRACTICE_PK;
    if (practicePk && !hexKeys.includes(practicePk)) {
      hexKeys.unshift(practicePk);
    }

    // 5. Replace pubkey_whitelist in config.toml
    const whitelist = hexKeys.map(k => `"${k}"`).join(", ");
    const newLine = `pubkey_whitelist = [${whitelist}]`;

    if (config.match(/^pubkey_whitelist\s*=\s*\[.*\]/m)) {
      config = config.replace(/^pubkey_whitelist\s*=\s*\[.*\]/m, newLine);
    } else {
      // Append to [authorization] section
      config = config.replace(/\[authorization\]/, `[authorization]\n${newLine}`);
    }

    // 6. Write config
    fs.writeFileSync(configPath, config);

    // 7. Restart relay
    execSync("systemctl restart nostr-relay", { timeout: 10000 });

    console.log(`[whitelist] Synced ${hexKeys.length} pubkeys, relay restarted`);
    res.json({ success: true, pubkeyCount: hexKeys.length, pubkeys: hexKeys });
  } catch (e) {
    console.error("[whitelist] Sync error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[calendar] Service running on port ${PORT}`);
  console.log(`[calendar] DB: ${process.env.DB_PATH || "/var/lib/immutable-health/billing.db"}`);
  console.log(`[calendar] SMS provider: ${process.env.SMS_PROVIDER || "console (not configured)"}`);
});

// Proxy patients from billing API (avoids browser blocking localhost calls)
