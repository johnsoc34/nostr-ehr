/**
 * db.js — Calendar database schema and queries
 * Uses the existing billing SQLite database
 */

const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || "/var/lib/immutable-health/billing.db";

let db;
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- Weekly availability templates (Mon-Fri recurring)
    CREATE TABLE IF NOT EXISTS availability_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6), -- 0=Mon, 4=Fri
      start_time  TEXT NOT NULL,  -- "09:00"
      end_time    TEXT NOT NULL,  -- "09:30"
      slot_duration_min INTEGER DEFAULT 30,
      is_active   INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-date overrides: block a normally-open slot or open a normally-closed one
    CREATE TABLE IF NOT EXISTS availability_overrides (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL,  -- "2026-03-05"
      start_time  TEXT NOT NULL,
      end_time    TEXT NOT NULL,
      override_type TEXT NOT NULL CHECK(override_type IN ('block','open')),
      reason      TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Appointments
    CREATE TABLE IF NOT EXISTS appointments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_npub  TEXT NOT NULL,
      patient_name  TEXT NOT NULL,
      patient_phone TEXT,
      date          TEXT NOT NULL,   -- "2026-03-05"
      start_time    TEXT NOT NULL,   -- "09:00"
      end_time      TEXT NOT NULL,   -- "09:30"
      appt_type     TEXT NOT NULL DEFAULT 'in_person'
                    CHECK(appt_type IN ('in_person','phone','video')),
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','confirmed','cancelled','declined')),
      notes         TEXT,
      video_url     TEXT,
      is_auto_booked INTEGER DEFAULT 0, -- 1 = patient booked open slot directly
      reminder_sent  INTEGER DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Trigger to update updated_at
    CREATE TRIGGER IF NOT EXISTS appointments_updated_at
      AFTER UPDATE ON appointments
      FOR EACH ROW
      BEGIN
        UPDATE appointments SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
      END;
  `);

  // Seed default Mon-Fri 9am-4pm availability in 30-min slots if empty
  const count = db.prepare("SELECT COUNT(*) as n FROM availability_templates").get();
  if (count.n === 0) {
    const insert = db.prepare(`
      INSERT INTO availability_templates (day_of_week, start_time, end_time, slot_duration_min)
      VALUES (?, ?, ?, 30)
    `);
    const slots = [];
    for (let day = 0; day <= 4; day++) {        // Mon-Fri
      for (let h = 9; h < 16; h++) {            // 9am-4pm
        for (let m = 0; m < 60; m += 30) {      // 30-min slots
          const start = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
          const endH = m === 30 ? h + 1 : h;
          const endM = m === 30 ? 0 : 30;
          const end = `${String(endH).padStart(2,"0")}:${String(endM).padStart(2,"0")}`;
          slots.push([day, start, end]);
        }
      }
    }
    const insertMany = db.transaction((rows) => {
      for (const row of rows) insert.run(...row);
    });
    insertMany(slots);
    console.log(`[db] Seeded ${slots.length} default availability slots`);
  }
}

// ─── Availability ─────────────────────────────────────────────────────────────

function getTemplates() {
  return getDb().prepare(`
    SELECT * FROM availability_templates WHERE is_active = 1 ORDER BY day_of_week, start_time
  `).all();
}

function upsertTemplate(dayOfWeek, startTime, endTime, durationMin = 30) {
  return getDb().prepare(`
    INSERT INTO availability_templates (day_of_week, start_time, end_time, slot_duration_min)
    VALUES (?, ?, ?, ?)
  `).run(dayOfWeek, startTime, endTime, durationMin);
}

function deleteTemplate(id) {
  return getDb().prepare(`UPDATE availability_templates SET is_active = 0 WHERE id = ?`).run(id);
}

function getOverridesForRange(startDate, endDate) {
  return getDb().prepare(`
    SELECT * FROM availability_overrides
    WHERE date BETWEEN ? AND ?
    ORDER BY date, start_time
  `).all(startDate, endDate);
}

function addOverride(date, startTime, endTime, type, reason = null) {
  return getDb().prepare(`
    INSERT INTO availability_overrides (date, start_time, end_time, override_type, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(date, startTime, endTime, type, reason);
}

function deleteOverride(id) {
  return getDb().prepare(`DELETE FROM availability_overrides WHERE id = ?`).run(id);
}

/**
 * Compute available slots for a given date, accounting for:
 * 1. Weekly template for that day of week
 * 2. Per-date overrides (block or open)
 * 3. Existing confirmed/pending appointments
 */
function getAvailableSlotsForDate(date) {
  const db = getDb();
  const d = new Date(date + "T00:00:00");
  const dayOfWeek = (d.getDay() + 6) % 7; // Convert JS Sunday=0 to Mon=0

  // Get template slots for this day
  const templates = db.prepare(`
    SELECT * FROM availability_templates
    WHERE day_of_week = ? AND is_active = 1
    ORDER BY start_time
  `).all(dayOfWeek);

  // Get overrides for this date
  const overrides = db.prepare(`
    SELECT * FROM availability_overrides WHERE date = ?
  `).all(date);

  // Get booked appointments
  const booked = db.prepare(`
    SELECT start_time, end_time FROM appointments
    WHERE date = ? AND status IN ('confirmed','pending')
  `).all(date);

  const blockedByOverride = new Set(
    overrides.filter(o => o.override_type === "block").map(o => o.start_time)
  );
  const openedByOverride = overrides
    .filter(o => o.override_type === "open")
    .map(o => ({ start_time: o.start_time, end_time: o.end_time }));
  const bookedTimes = new Set(booked.map(b => b.start_time));

  // Build slot list from templates minus blocks minus booked
  const slots = templates
    .filter(t => !blockedByOverride.has(t.start_time))
    .filter(t => !bookedTimes.has(t.start_time))
    .map(t => ({
      start_time: t.start_time,
      end_time: t.end_time,
      duration_min: t.slot_duration_min,
      source: "template",
      available: true,
    }));

  // Add override-opened slots
  for (const o of openedByOverride) {
    if (!bookedTimes.has(o.start_time)) {
      slots.push({
        start_time: o.start_time,
        end_time: o.end_time,
        duration_min: 30,
        source: "override",
        available: true,
      });
    }
  }

  slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return slots;
}

// ─── Appointments ─────────────────────────────────────────────────────────────

function getAppointmentsForDate(date) {
  return getDb().prepare(`
    SELECT * FROM appointments WHERE date = ? ORDER BY start_time
  `).all(date);
}

function getAppointmentsForRange(startDate, endDate) {
  return getDb().prepare(`
    SELECT * FROM appointments
    WHERE date BETWEEN ? AND ?
    ORDER BY date, start_time
  `).all(startDate, endDate);
}

function getAppointmentsForPatient(npub) {
  return getDb().prepare(`
    SELECT * FROM appointments
    WHERE patient_npub = ? AND date >= date('now')
    ORDER BY date, start_time
  `).all(npub);
}

function getAppointmentById(id) {
  return getDb().prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
}

function createAppointment(data) {
  return getDb().prepare(`
    INSERT INTO appointments
      (patient_npub, patient_name, patient_phone, date, start_time, end_time,
       appt_type, status, notes, video_url, is_auto_booked, visit_color, schedule_comment)
    VALUES
      (@patient_npub, @patient_name, @patient_phone, @date, @start_time, @end_time,
       @appt_type, @status, @notes, @video_url, @is_auto_booked, @visit_color, @schedule_comment)
  `).run(data);
}

function updateAppointmentStatus(id, status) {
  return getDb().prepare(`
    UPDATE appointments SET status = ? WHERE id = ?
  `).run(status, id);
}

function updateAppointment(id, data) {
  return getDb().prepare(`
    UPDATE appointments SET
      date = @date, start_time = @start_time, end_time = @end_time,
      appt_type = @appt_type, notes = @notes, video_url = @video_url,
      status = @status, visit_color = @visit_color, schedule_comment = @schedule_comment
    WHERE id = @id
  `).run({ ...data, id });
}

function deleteAppointment(id) {
  return getDb().prepare(`DELETE FROM appointments WHERE id = ?`).run(id);
}

function getPendingReminders() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  const dateStr = tomorrow.toISOString().split("T")[0];
  return getDb().prepare(`
    SELECT * FROM appointments
    WHERE date = ? AND status = 'confirmed' AND reminder_sent = 0 AND patient_phone IS NOT NULL
  `).all(dateStr);
}

function markReminderSent(id) {
  return getDb().prepare(`UPDATE appointments SET reminder_sent = 1 WHERE id = ?`).run(id);
}

function updateVisitTracking(id, data) {
  const fields = [];
  const values = {};
  if (data.visit_color !== undefined) { fields.push('visit_color = @visit_color'); values.visit_color = data.visit_color; }
  if (data.schedule_comment !== undefined) { fields.push('schedule_comment = @schedule_comment'); values.schedule_comment = data.schedule_comment; }
  if (fields.length === 0) return;
  values.id = id;
  return getDb().prepare(`UPDATE appointments SET ${fields.join(', ')} WHERE id = @id`).run(values);
}

module.exports = {
  getDb,
  getTemplates,
  upsertTemplate,
  deleteTemplate,
  getOverridesForRange,
  addOverride,
  deleteOverride,
  getAvailableSlotsForDate,
  getAppointmentsForDate,
  getAppointmentsForRange,
  getAppointmentsForPatient,
  getAppointmentById,
  createAppointment,
  updateAppointmentStatus,
  updateAppointment,
  deleteAppointment,
  getPendingReminders,
  markReminderSent,
  updateVisitTracking,
};

// ─── Virtual Visit Intake (Phase 5) ──────────────────────────────────────────

function initIntakeSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS intake_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT,
      phone         TEXT,
      date_of_birth TEXT,
      state         TEXT NOT NULL,
      chief_complaint TEXT,
      preferred_date TEXT,
      preferred_time TEXT,
      npub          TEXT,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','approved','declined','expired')),
      decline_reason TEXT,
      appointment_id INTEGER,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TRIGGER IF NOT EXISTS intake_updated_at
      AFTER UPDATE ON intake_requests
      FOR EACH ROW
      BEGIN
        UPDATE intake_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
      END;
  `);
}

// Call this on startup
try { initIntakeSchema(); } catch(e) { console.error("[db] Intake schema error:", e.message); }

// ─── Intake Schema Migration (Phase 5b: Onboarding Pipeline) ────────────────

function migrateIntakeSchema() {
  const d = getDb();
  try {
    const cols = d.prepare("PRAGMA table_info(intake_requests)").all();
    const hasContactPref = cols.some(c => c.name === "contact_preference");
    if (!hasContactPref) {
      d.exec("ALTER TABLE intake_requests ADD COLUMN contact_preference TEXT DEFAULT 'email'");
      console.log("[db] Added contact_preference column to intake_requests");
    }
    const hasChildName = cols.some(c => c.name === "child_name");
    if (!hasChildName) {
      d.exec("ALTER TABLE intake_requests ADD COLUMN child_name TEXT");
      console.log("[db] Added child_name column to intake_requests");
    }
  } catch (e) {
    console.error("[db] Intake migration error:", e.message);
  }
}

try { migrateIntakeSchema(); } catch(e) { console.error("[db] Intake migration:", e.message); }

// ─── Intake Queries ─────────────────────────────────────────────────────────

function createIntakeRequest(data) {
  return getDb().prepare(`
    INSERT INTO intake_requests
      (name, email, phone, date_of_birth, state, chief_complaint,
       preferred_date, preferred_time, npub, contact_preference, child_name)
    VALUES
      (@name, @email, @phone, @date_of_birth, @state, @chief_complaint,
       @preferred_date, @preferred_time, @npub, @contact_preference, @child_name)
  `).run(data);
}

function getPendingIntake() {
  return getDb().prepare(`
    SELECT * FROM intake_requests
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all();
}

function getIntakeById(id) {
  return getDb().prepare(`SELECT * FROM intake_requests WHERE id = ?`).get(id);
}

function updateIntakeStatus(id, status, extra = {}) {
  const fields = ['status = ?'];
  const values = [status];
  if (extra.decline_reason !== undefined) {
    fields.push('decline_reason = ?');
    values.push(extra.decline_reason);
  }
  if (extra.appointment_id !== undefined) {
    fields.push('appointment_id = ?');
    values.push(extra.appointment_id);
  }
  values.push(id);
  return getDb().prepare(
    `UPDATE intake_requests SET ${fields.join(', ')} WHERE id = ?`
  ).run(...values);
}

function getAllIntake(limit = 50) {
  return getDb().prepare(`
    SELECT * FROM intake_requests
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

function updateIntakeNpub(id, npub) {
  // Transition approved → ready when patient submits their npub
  return getDb().prepare(
    "UPDATE intake_requests SET npub = ?, status = 'ready' WHERE id = ? AND status = 'approved'"
  ).run(npub, id);
}

function getIntakeByStatus(...statuses) {
  const placeholders = statuses.map(() => "?").join(",");
  return getDb().prepare(
    `SELECT * FROM intake_requests WHERE status IN (${placeholders}) ORDER BY created_at ASC`
  ).all(...statuses);
}

function expireStaleIntake(daysOld = 14) {
  return getDb().prepare(
    `UPDATE intake_requests SET status = 'expired' 
     WHERE status = 'approved' 
     AND created_at < datetime('now', '-' || ? || ' days')`
  ).run(daysOld);
}

function markIntakeScheduled(id) {
  return getDb().prepare(
    "UPDATE intake_requests SET status = 'scheduled' WHERE id = ? AND status = 'ready'"
  ).run(id);
}

module.exports = {
  ...module.exports,
  createIntakeRequest,
  getPendingIntake,
  getIntakeById,
  updateIntakeStatus,
  getAllIntake,
  updateIntakeNpub,
  getIntakeByStatus,
  expireStaleIntake,
  markIntakeScheduled,
};
