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


// Licensed states for virtual consultations (Phase 5)
const LICENSED_STATES = (process.env.LICENSED_STATES || "").split(",").map(s => s.trim().toUpperCase());

// Virtual consultation pipeline env vars
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "";
const PORTAL_URL = process.env.PORTAL_URL || "";
const PRACTICE_NAME = process.env.PRACTICE_NAME || "Immutable Health Pediatrics";
const PRACTICE_PK = process.env.PRACTICE_PK || "";
const RELAY_URL_CFG = process.env.RELAY_URL || "";
const BILLING_API = process.env.BILLING_API || "";
const CALENDAR_ORIGIN = process.env.CALENDAR_ORIGIN || "";

// Approval email via Resend
async function sendApprovalEmail(intake, onboardUrl) {
  if (!RESEND_API_KEY || !intake.email) {
    console.log("[intake] Skipping email: " + (!RESEND_API_KEY ? "no API key" : "no email address"));
    return;
  }
  try {
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;background:#0a0d12;color:#e2e8f0;padding:32px;border-radius:12px;">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="font-size:24px;font-weight:800;color:#f7931a;">${PRACTICE_NAME}</div>
          <div style="font-size:13px;color:#6b7fa3;margin-top:4px;">Virtual Consultation</div>
        </div>
        <div style="background:#111620;border:1px solid #1e2d44;border-radius:10px;padding:20px;margin-bottom:20px;">
          <div style="font-size:15px;font-weight:700;color:#22c55e;margin-bottom:8px;">Your consultation request has been approved!</div>
          <div style="font-size:13px;color:#94a3b8;line-height:1.6;">
            Hi ${intake.name},<br><br>
            Your virtual consultation request for <strong style="color:#e2e8f0;">${intake.child_name || "your child"}</strong> has been approved.
            To get started, you need to set up your secure access code.
          </div>
        </div>
        <div style="text-align:center;margin-bottom:20px;">
          <a href="${onboardUrl}" style="display:inline-block;padding:14px 32px;background:#f7931a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">
            Set Up Your Access Code
          </a>
        </div>
        <div style="font-size:11px;color:#475569;text-align:center;line-height:1.5;">
          This link is unique to you. Do not share it.<br>
          If you did not request this, you can safely ignore this email.
        </div>
      </div>`;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + RESEND_API_KEY },
      body: JSON.stringify({ from: RESEND_FROM, to: intake.email, subject: "Your consultation request has been approved - " + PRACTICE_NAME, html }),
    });
    if (resp.ok) console.log("[intake] Approval email sent to " + intake.email);
    else console.error("[intake] Email failed:", resp.status, await resp.text());
  } catch (e) { console.error("[intake] Email error:", e.message); }
}

// Expire stale approved intakes every 6 hours
setInterval(() => {
  try {
    const result = db.expireStaleIntake(14);
    if (result.changes > 0) console.log("[intake] Expired " + result.changes + " stale intake(s)");
  } catch (e) { console.error("[intake] Expiration error:", e.message); }
}, 6 * 60 * 60 * 1000);

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Session auth ─────────────────────────────────────────────────────────────
const session = require("express-session");
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.CALENDAR_SESSION_SECRET || "imh-cal-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));

const crypto = require("crypto");
const CALENDAR_PASSWORD_HASH = process.env.CALENDAR_PASSWORD_HASH || crypto.createHash("sha256").update("changeme").digest("hex");

function requireAuth(req, res, next) {
  if (req.path.startsWith("/api/") || req.path === "/login" || req.path === "/logout" || req.path === "/request" || req.session.authed) {
    return next();
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

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (crypto.createHash("sha256").update(req.body.password).digest("hex") === CALENDAR_PASSWORD_HASH) {
    req.session.authed = true;
    req.session.save(() => res.redirect("/"));
  } else {
    res.redirect("/login?error=1");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});
// ─────────────────────────────────────────────────────────────────────────────

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
    if (!req.body.force) {
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
      });
      // Intake linkage: if this npub matches a ready intake, mark it scheduled
      try {
        const ready = db.getIntakeByStatus('ready');
        const match = ready.find(i => i.npub === patient_npub);
        if (match) {
          db.markIntakeScheduled(match.id);
          console.log('[calendar] Intake #' + match.id + ' (' + (match.child_name || match.name) + ') -> scheduled');
        }
      } catch (e) { console.error('[calendar] intake linkage:', e.message); }
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

// ─── Start ────────────────────────────────────────────────────────────────────


// Serve the public intake form (no auth — exempted in requireAuth)
app.get("/request", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "intake-request.html"));
});

// States endpoint for the intake form
app.get("/api/intake/states", (req, res) => {
  res.json({ states: LICENSED_STATES });
});

// ─── Virtual Visit Intake (Phase 5) ──────────────────────────────────────────

// Public endpoint — no auth required
app.post("/api/intake", (req, res) => {
  try {
    const { name, email, phone, date_of_birth, state, chief_complaint,
            preferred_date, preferred_time, npub } = req.body;
    if (!name || !state)
      return res.status(400).json({ error: "name and state are required" });
    const stateUpper = state.trim().toUpperCase();
    if (!LICENSED_STATES.includes(stateUpper))
      return res.status(403).json({
        error: "We are not licensed to provide care in " + stateUpper + ". Licensed states: " + LICENSED_STATES.join(", "),
      });
    const result = db.createIntakeRequest({
      name: name.trim(),
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      date_of_birth: date_of_birth || null,
      state: stateUpper,
      chief_complaint: chief_complaint?.trim() || null,
      preferred_date: preferred_date || null,
      preferred_time: preferred_time || null,
      npub: npub?.trim() || null,
    });
    console.log("[intake] New request from " + name + " (" + stateUpper + ")" + (npub ? " npub: " + npub.substring(0, 20) + "..." : ""));
    res.json({ id: result.lastInsertRowid, status: "pending",
      message: "Your consultation request has been submitted. We will contact you to confirm." });
  } catch (e) {
    console.error("[intake] Error:", e.message);
    res.status(500).json({ error: "Failed to submit request" });
  }
});

app.get("/api/intake/pending", (req, res) => {
  try { res.json(db.getPendingIntake()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/intake", (req, res) => {
  try { res.json(db.getAllIntake(parseInt(req.query.limit) || 50)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── Virtual Consultation Pipeline Routes ────────────────────────────────────

// GET /api/intake/active — EHR sidebar fetches pending + approved + ready
// MUST be before /api/intake/:id to avoid Express matching "active" as an ID
app.get("/api/intake/active", (req, res) => {
  try {
    const intakes = db.getIntakeByStatus("pending", "approved", "ready");
    res.json(intakes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/intake/:id/npub — patient submits npub after onboarding
app.post("/api/intake/:id/npub", (req, res) => {
  try {
    const { npub } = req.body;
    if (!npub || !npub.startsWith("npub1")) {
      return res.status(400).json({ error: "Valid npub required" });
    }
    const intake = db.getIntakeById(req.params.id);
    if (!intake) return res.status(404).json({ error: "Not found" });
    if (intake.status !== "approved") {
      return res.status(400).json({ error: "Intake must be in approved state" });
    }
    db.updateIntakeNpub(intake.id, npub);
    console.log("[intake] npub submitted for #" + intake.id + " (" + intake.name + "): " + npub.substring(0, 20) + "...");
    res.json({ success: true, status: "ready" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/intake/:id/scheduled — EHR marks intake as scheduled after patient creation
app.post("/api/intake/:id/scheduled", (req, res) => {
  try {
    const result = db.markIntakeScheduled(Number(req.params.id));
    if (result.changes === 0) return res.status(400).json({ error: "Not in ready state or not found" });
    console.log("[intake] #" + req.params.id + " -> scheduled");
    res.json({ success: true, status: "scheduled" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /onboard/:id — serves onboarding page with injected practice config
app.get("/onboard/:id", (req, res) => {
  try {
    const intake = db.getIntakeById(req.params.id);
    if (!intake) return res.status(404).send("Not found");
    if (intake.status !== "approved") {
      return res.status(400).send("This link is no longer valid. Your request may have already been processed or expired.");
    }
    // Read the static onboard.html and inject config
    const fs = require("fs");
    let html = fs.readFileSync(path.join(__dirname, "public", "onboard.html"), "utf8");
    // Inject config as a script tag before </head>
    const config = JSON.stringify({
      intakeId: intake.id,
      parentName: intake.name,
      childName: intake.child_name || "",
      practiceName: PRACTICE_NAME,
      practicePk: PRACTICE_PK,
      relayUrl: RELAY_URL_CFG,
      portalUrl: PORTAL_URL,
      billingApi: BILLING_API,
      calendarApi: CALENDAR_ORIGIN,
      npubEndpoint: CALENDAR_ORIGIN + "/api/intake/" + intake.id + "/npub",
    });
    html = html.replace("</head>", "<script>window.__ONBOARD_CONFIG__=" + config + ";</script></head>");
    res.send(html);
  } catch (e) {
    console.error("[onboard] Error:", e.message);
    res.status(500).send("Server error");
  }
});

app.get("/api/intake/:id", (req, res) => {
  try {
    const intake = db.getIntakeById(req.params.id);
    if (!intake) return res.status(404).json({ error: "Not found" });
    res.json(intake);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/intake/:id/approve", (req, res) => {
  try {
    const intake = db.getIntakeById(req.params.id);
    if (!intake) return res.status(404).json({ error: "Not found" });
    if (intake.status !== "pending") return res.status(400).json({ error: "Already processed" });
    const { date, start_time, end_time, appt_type } = req.body || {};
    let appointment_id = null;
    if (date && start_time && end_time) {
      const apptResult = db.createAppointment({
        patient_npub: intake.npub || "pending-intake-" + intake.id,
        patient_name: intake.name,
        patient_phone: intake.phone || null,
        date, start_time, end_time,
        appt_type: appt_type || "video",
        status: "confirmed",
        notes: intake.chief_complaint ? "Chief complaint: " + intake.chief_complaint : null,
        video_url: null, is_auto_booked: 0, visit_color: null, schedule_comment: null,
      });
      appointment_id = apptResult.lastInsertRowid;
    }
    db.updateIntakeStatus(intake.id, "approved", { appointment_id });
    const onboardUrl = CALENDAR_ORIGIN + "/onboard/" + intake.id;
    console.log("[intake] Approved #" + intake.id + " (" + intake.name + ") onboard: " + onboardUrl);
    // Send approval email (async, non-blocking)
    sendApprovalEmail(intake, onboardUrl).catch(e => console.error("[intake] email error:", e.message));
    res.json({ intake_id: intake.id, appointment_id, status: "approved", onboard_url: onboardUrl });
  } catch (e) {
    console.error("[intake] Approve error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/intake/:id/decline", (req, res) => {
  try {
    const intake = db.getIntakeById(req.params.id);
    if (!intake) return res.status(404).json({ error: "Not found" });
    if (intake.status !== "pending") return res.status(400).json({ error: "Already processed" });
    db.updateIntakeStatus(intake.id, "declined", { decline_reason: req.body.reason || null });
    console.log("[intake] Declined #" + intake.id + " (" + intake.name + ")");
    res.json({ intake_id: intake.id, status: "declined" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/licensed-states", (req, res) => {
  res.json({ states: LICENSED_STATES });
});

app.listen(PORT, () => {
  console.log(`[calendar] Service running on port ${PORT}`);
  console.log(`[calendar] DB: ${process.env.DB_PATH || "/var/lib/immutable-health/billing.db"}`);
  console.log(`[calendar] SMS provider: ${process.env.SMS_PROVIDER || "console (not configured)"}`);
});

// Proxy patients from billing API (avoids browser blocking localhost calls)
app.get("/api/proxy/patients", async (req, res) => {
  try {
    const r = await fetch("http://localhost:3002/api/patients/list");
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
