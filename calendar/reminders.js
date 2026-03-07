/**
 * reminders.js — Pluggable SMS reminder module
 * Currently logs to console. Wire in Twilio/Telnyx by setting env vars.
 *
 * To enable Twilio:
 *   SMS_PROVIDER=twilio
 *   TWILIO_ACCOUNT_SID=ACxxxxx
 *   TWILIO_AUTH_TOKEN=xxxxx
 *   TWILIO_FROM_NUMBER=+15551234567
 *
 * To enable Telnyx:
 *   SMS_PROVIDER=telnyx
 *   TELNYX_API_KEY=KEYxxxxx
 *   TELNYX_FROM_NUMBER=+15551234567
 */

const { getPendingReminders, markReminderSent } = require("./db");

function formatPhone(phone) {
  // Normalize to E.164 format
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return `+${digits}`;
}

function formatMessage(appt) {
  const typeLabel = {
    in_person: "in-person visit",
    phone: "phone call",
    video: "video visit",
  }[appt.appt_type] || "appointment";

  const dateStr = new Date(appt.date + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric"
  });

  let msg = `Reminder: ${appt.patient_name}, you have a ${typeLabel} at NostrEHR on ${dateStr} at ${formatTime(appt.start_time)}.`;

  if (appt.appt_type === "video" && appt.video_url) {
    msg += ` Join at: ${appt.video_url}`;
  }

  msg += ` Reply CANCEL to cancel. Questions? Reply or call us.`;
  return msg;
}

function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ─── Provider implementations ─────────────────────────────────────────────────

async function sendViaTwilio(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;

  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      },
      body,
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio error: ${data.message}`);
  return data.sid;
}

async function sendViaTelnyx(to, message) {
  const apiKey = process.env.TELNYX_API_KEY;
  const from   = process.env.TELNYX_FROM_NUMBER;

  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from, to, text: message }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Telnyx error: ${JSON.stringify(data)}`);
  return data.data?.id;
}

async function sendSms(to, message) {
  const provider = process.env.SMS_PROVIDER || "console";

  if (provider === "twilio") {
    return sendViaTwilio(to, message);
  } else if (provider === "telnyx") {
    return sendViaTelnyx(to, message);
  } else {
    // Console fallback — logs the message without sending
    console.log(`[SMS] TO: ${to}`);
    console.log(`[SMS] MSG: ${message}`);
    return "console-mock-id";
  }
}

// ─── Main reminder job ────────────────────────────────────────────────────────

async function sendReminders() {
  const pending = getPendingReminders();
  console.log(`[reminders] Found ${pending.length} reminders to send`);

  for (const appt of pending) {
    try {
      const to = formatPhone(appt.patient_phone);
      const message = formatMessage(appt);
      const id = await sendSms(to, message);
      markReminderSent(appt.id);
      console.log(`[reminders] Sent reminder for appt ${appt.id} to ${to} (${id})`);
    } catch (err) {
      console.error(`[reminders] Failed to send reminder for appt ${appt.id}:`, err.message);
    }
  }
}

module.exports = { sendReminders };
