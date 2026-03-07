#!/usr/bin/env node

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const crypto = require('crypto');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Prorated billing helper ───────────────────────────────────────────────────
// Returns a multiplier between 0 and 1.
// If member_since is in the current billing month → prorate.
// Otherwise → full month (1.0).
function getProrateMultiplier(memberSince, now) {
  if (!memberSince) return 1.0;

  const since = new Date(memberSince + 'T00:00:00');
  const sinceYear  = since.getFullYear();
  const sinceMonth = since.getMonth(); // 0-indexed

  const nowYear  = now.getFullYear();
  const nowMonth = now.getMonth();

  // Only prorate if member_since falls in the current billing month
  if (sinceYear !== nowYear || sinceMonth !== nowMonth) return 1.0;

  const daysInMonth  = new Date(nowYear, nowMonth + 1, 0).getDate();
  const enrollDay    = since.getDate(); // 1-indexed

  // Days remaining = daysInMonth - enrollDay + 1 (inclusive of enrollment day)
  const daysRemaining = daysInMonth - enrollDay + 1;

  return daysRemaining / daysInMonth;
}

// Round to nearest cent (in cents)
function proratedAmount(feeCents, multiplier) {
  return Math.round(feeCents * multiplier);
}

// ─── Email ─────────────────────────────────────────────────────────────────────
async function sendInvoiceEmail(params) {
  try {
    const { to, patientName, invoiceId, amount, dueDate, paymentUrl, familyMembers, isProrated, prorateNote } = params;

    const familyList = familyMembers && familyMembers.length > 0
      ? `<div style="margin: 16px 0; padding: 12px; background: #f9fafb; border-radius: 8px;">
           <div style="font-size: 12px; font-weight: 600; color: #6b7280; margin-bottom: 8px;">Family Members:</div>
           ${familyMembers.map(m => `<div style="font-size: 11px; color: #9ca3af;">• ${m.name} ${m.fee > 0 ? `($${(m.fee/100).toFixed(2)}/mo)` : '(account holder)'}${m.prorated ? ` — prorated: $${(m.proratedFee/100).toFixed(2)}` : ''}</div>`).join('')}
         </div>`
      : '';

    const prorateNotice = isProrated
      ? `<div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px; border-radius: 4px; margin-bottom: 20px;">
           <p style="margin: 0; font-size: 14px; color: #1e40af;">
             <strong>Prorated Invoice:</strong> ${prorateNote}
           </p>
         </div>`
      : '';

    await resend.emails.send({
      from: process.env.EMAIL_FROM || process.env.RESEND_FROM || 'billing@yourpractice.com',
      to: [to],
      subject: `Invoice ${invoiceId} - ${process.env.PRACTICE_NAME || "Your Practice"}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #f7931a, #fbb040); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
            <div style="font-size: 48px; margin-bottom: 10px;">₿</div>
            <h1 style="color: white; margin: 0; font-size: 24px;">${process.env.PRACTICE_NAME || "Your Practice"}</h1>
          </div>

          <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="font-size: 16px; color: #111827; margin-bottom: 20px;">Hi ${patientName},</p>
            <p style="font-size: 16px; color: #111827; margin-bottom: 30px;">Your monthly Direct Primary Care invoice is ready.</p>

            ${prorateNotice}
            ${familyList}

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Invoice Number:</td>
                  <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">${invoiceId}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Amount Due:</td>
                  <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">$${(amount / 100).toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Due Date:</td>
                  <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">${dueDate}</td>
                </tr>
              </table>
            </div>

            <div style="text-align: center; margin-bottom: 30px;">
              <a href="${paymentUrl}" style="display: inline-block; background: #f7931a; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                Pay Invoice
              </a>
            </div>

            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px; border-radius: 4px; margin-bottom: 20px;">
              <p style="margin: 0; font-size: 14px; color: #92400e;">
                <strong>Save 15%</strong> by paying with Bitcoin or Lightning! Little to no processing fees, faster settlement, and better for your privacy.
              </p>
            </div>

            <p style="font-size: 14px; color: #6b7280; line-height: 1.6;">
              If you have any questions about this invoice, please don't hesitate to contact us.
            </p>

            <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
              Thank you,<br>
              <strong style="color: #111827;">${process.env.PRACTICE_NAME || "Your Practice"}</strong>
            </p>
          </div>
        </div>
      `,
    });

    return true;
  } catch (error) {
    console.error('Email error:', error);
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db = await open({
    filename: process.env.DATABASE_PATH || '/var/lib/immutable-health/billing.db',
    driver: sqlite3.Database
  });

  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const dueDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const dueDateStr = dueDate.toISOString().split('T')[0];
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  // Get all families with active members
  const families = await db.all(`
    SELECT DISTINCT f.id, f.family_name, f.max_cap_enabled, f.max_cap_amount, f.max_cap_threshold
    FROM families f
    JOIN patients p ON p.family_id = f.id
    WHERE p.status = 'active' AND p.is_account_holder = 0
  `);

  // Get individual active patients (not in families)
  const individuals = await db.all(`
    SELECT * FROM patients
    WHERE status = 'active' AND (family_id IS NULL OR is_account_holder = 1)
  `);

  let invoiceNum = 0;
  const lastInvoice = await db.get('SELECT id FROM invoices ORDER BY id DESC LIMIT 1');
  if (lastInvoice) {
    invoiceNum = parseInt(lastInvoice.id.split('-')[1]);
  }

  console.log(`\nCreating invoices for ${month}...`);
  console.log(`Days in month: ${daysInMonth}\n`);

  // ─── Process families ────────────────────────────────────────────────────────
  for (const family of families) {
    invoiceNum++;
    const invoiceId = `INV-${String(invoiceNum).padStart(4, '0')}`;
    const token = crypto.randomBytes(16).toString('hex');

    // Get all family members
    const members = await db.all(`
      SELECT * FROM patients
      WHERE family_id = ?
      ORDER BY is_account_holder DESC, name
    `, [family.id]);

    const children = members.filter(m => !m.is_account_holder);

    // Calculate prorated fee for each child individually
    let totalFee = 0;
    const memberDetails = members.map(m => {
      if (m.is_account_holder) {
        return { name: m.name, fee: m.monthly_fee, prorated: false, proratedFee: 0 };
      }
      const multiplier = getProrateMultiplier(m.member_since, now);
      const prorated = proratedAmount(m.monthly_fee, multiplier);
      totalFee += prorated;
      return {
        name: m.name,
        fee: m.monthly_fee,
        prorated: multiplier < 1.0,
        proratedFee: prorated,
        multiplier,
        member_since: m.member_since
      };
    });

    // Apply family max cap AFTER proration
    // Prorate the cap too if the family enrolled this month
    // Use the earliest child enrollment date to determine family proration
    const earliestChild = children.reduce((earliest, m) => {
      if (!earliest) return m;
      return new Date(m.member_since) < new Date(earliest.member_since) ? m : earliest;
    }, null);

    let cappedFee = totalFee;
    let capWasApplied = false;
    if (family.max_cap_enabled && children.length >= family.max_cap_threshold) {
      const capMultiplier = getProrateMultiplier(earliestChild?.member_since, now);
      const proratedCap = proratedAmount(family.max_cap_amount, capMultiplier);
      if (totalFee > proratedCap) {
        cappedFee = proratedCap;
        capWasApplied = true;
      }
    }

    const isProrated = memberDetails.some(m => m.prorated);
    const prorateNote = isProrated
      ? `This invoice covers only the days of service this month (enrollment mid-month). Full monthly rate begins next billing cycle.`
      : '';

    // Get primary account holder for email
    const primaryHolder = members.find(m => m.relationship === 'primary_holder');
    if (!primaryHolder) {
      console.log(`⚠ No primary holder for ${family.family_name}, skipping`);
      continue;
    }

    // Create invoice
    await db.run(`
      INSERT INTO invoices (id, patient_id, amount, description, due_date, token, status)
      VALUES (?, ?, ?, ?, ?, ?, 'unpaid')
    `, [
      invoiceId,
      primaryHolder.id,
      cappedFee,
      `Family DPC Membership - ${month}${isProrated ? ' (prorated)' : ''}`,
      dueDateStr,
      token
    ]);

    const paymentUrl = `${process.env.NEXT_PUBLIC_APP_URL}/pay/${token}`;

    const capNote = capWasApplied ? ' (cap applied)' : '';
    const prorateLog = isProrated ? ' (prorated)' : '';
    console.log(`✓ ${invoiceId} for ${family.family_name} - $${(cappedFee/100).toFixed(2)}${prorateLog}${capNote}`);

    // Log individual child amounts if prorated
    if (isProrated) {
      memberDetails.filter(m => m.prorated).forEach(m => {
        const enrollDay = new Date(m.member_since + 'T00:00:00').getDate();
        const daysRemaining = daysInMonth - enrollDay + 1;
        console.log(`  → ${m.name}: $${(m.fee/100).toFixed(2)} × (${daysRemaining}/${daysInMonth} days) = $${(m.proratedFee/100).toFixed(2)}`);
      });
    }

    // Send email
    if (primaryHolder.email) {
      const emailSent = await sendInvoiceEmail({
        to: primaryHolder.email,
        patientName: primaryHolder.name,
        invoiceId,
        amount: cappedFee,
        dueDate: dueDateStr,
        paymentUrl,
        familyMembers: memberDetails,
        isProrated,
        prorateNote
      });

      if (emailSent) console.log(`  ✓ Email sent to ${primaryHolder.email}`);
    }
  }

  // ─── Process individuals ─────────────────────────────────────────────────────
  for (const patient of individuals) {
    // Skip account holders who are in families
    if (patient.family_id && patient.is_account_holder) continue;

    invoiceNum++;
    const invoiceId = `INV-${String(invoiceNum).padStart(4, '0')}`;
    const token = crypto.randomBytes(16).toString('hex');

    const multiplier = getProrateMultiplier(patient.member_since, now);
    const fee = proratedAmount(patient.monthly_fee, multiplier);
    const isProrated = multiplier < 1.0;

    let prorateNote = '';
    if (isProrated) {
      const enrollDay = new Date(patient.member_since + 'T00:00:00').getDate();
      const daysRemaining = daysInMonth - enrollDay + 1;
      prorateNote = `This invoice covers ${daysRemaining} of ${daysInMonth} days this month (enrolled ${patient.member_since}). Full monthly rate begins next billing cycle.`;
    }

    await db.run(`
      INSERT INTO invoices (id, patient_id, amount, description, due_date, token, status)
      VALUES (?, ?, ?, ?, ?, ?, 'unpaid')
    `, [
      invoiceId,
      patient.id,
      fee,
      `Monthly DPC Membership - ${month}${isProrated ? ' (prorated)' : ''}`,
      dueDateStr,
      token
    ]);

    const paymentUrl = `${process.env.NEXT_PUBLIC_APP_URL}/pay/${token}`;

    const prorateLog = isProrated ? ` (prorated ${Math.round(multiplier * 100)}%)` : '';
    console.log(`✓ ${invoiceId} for ${patient.name} - $${(fee/100).toFixed(2)}${prorateLog}`);

    if (patient.email) {
      const emailSent = await sendInvoiceEmail({
        to: patient.email,
        patientName: patient.name,
        invoiceId,
        amount: fee,
        dueDate: dueDateStr,
        paymentUrl,
        isProrated,
        prorateNote
      });

      if (emailSent) console.log(`  ✓ Email sent to ${patient.email}`);
    }
  }

  const individualCount = individuals.filter(p => !p.family_id || !p.is_account_holder).length;
  console.log(`\n✓ Created ${families.length} family invoices + ${individualCount} individual invoices`);

  await db.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
