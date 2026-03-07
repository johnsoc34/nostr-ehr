import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();

    // --- Member counts ---
    const memberCounts = await db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'head_of_household' THEN 1 ELSE 0 END) as hoh,
        SUM(CASE WHEN status = 'delinquent' THEN 1 ELSE 0 END) as delinquent,
        SUM(CASE WHEN status = 'lapsed' THEN 1 ELSE 0 END) as lapsed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN is_test_patient = 1 THEN 1 ELSE 0 END) as test_patients
      FROM patients
    `);

    // --- MRR (Monthly Recurring Revenue from active + hoh + delinquent) ---
    const mrrResult = await db.get(`
      SELECT COALESCE(SUM(monthly_fee), 0) as mrr
      FROM patients
      WHERE status IN ('active', 'head_of_household', 'delinquent')
    `);

    // --- Outstanding balance ---
    const outstandingResult = await db.get(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM invoices
      WHERE status IN ('unpaid', 'overdue')
    `);

    // --- Invoice counts ---
    const invoiceCounts = await db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) as unpaid,
        SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue
      FROM invoices
    `);

    // --- Total collected (confirmed payments) ---
    const collected = await db.get(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payments
      WHERE confirmed = 1
    `);

    // --- Revenue by month (last 6 months) ---
    const revenueByMonth = await db.all(`
      SELECT
        strftime('%Y-%m', p.created_at) as month,
        SUM(p.amount) as total
      FROM payments p
      WHERE p.confirmed = 1
        AND p.created_at >= date('now', '-6 months')
      GROUP BY strftime('%Y-%m', p.created_at)
      ORDER BY month ASC
    `);

    // --- Recent invoices (last 10) ---
    const recentInvoices = await db.all(`
      SELECT
        i.id, i.amount, i.status, i.due_date, i.created_at, i.description,
        p.name as patient_name, p.npub as patient_npub
      FROM invoices i
      JOIN patients p ON i.patient_id = p.id
      ORDER BY i.created_at DESC
      LIMIT 10
    `);

    // --- Overdue invoices ---
    const overdueInvoices = await db.all(`
      SELECT
        i.id, i.amount, i.status, i.due_date, i.created_at, i.description,
        p.name as patient_name, p.npub as patient_npub
      FROM invoices i
      JOIN patients p ON i.patient_id = p.id
      WHERE i.status IN ('unpaid', 'overdue')
      ORDER BY i.due_date ASC
    `);

    // --- Family count ---
    const familyCount = await db.get(`SELECT COUNT(*) as count FROM families`);

    // --- Pending signups ---
    const pendingSignups = await db.get(`
      SELECT COUNT(*) as count FROM signups WHERE status = 'pending'
    `);

    await db.close();

    return NextResponse.json({
      members: {
        total: memberCounts.total,
        active: memberCounts.active + memberCounts.hoh, // active + head_of_household
        delinquent: memberCounts.delinquent || 0,
        lapsed: memberCounts.lapsed || 0,
        pending: memberCounts.pending || 0,
        testPatients: memberCounts.test_patients || 0,
      },
      financials: {
        mrr: mrrResult.mrr,             // in cents
        outstanding: outstandingResult.total,  // in cents
        collected: collected.total,       // in cents
      },
      invoices: {
        total: invoiceCounts.total,
        paid: invoiceCounts.paid || 0,
        unpaid: invoiceCounts.unpaid || 0,
        overdue: invoiceCounts.overdue || 0,
      },
      revenueByMonth,
      recentInvoices,
      overdueInvoices,
      families: familyCount.count,
      pendingSignups: pendingSignups.count,
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
