import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
export const dynamic = 'force-dynamic';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ npub: string }> }
) {
  try {
    const { npub } = await params;
    const db = await getDb();
    const patient = await db.get(
      'SELECT * FROM patients WHERE npub = ?',
      [npub]
    );
    if (!patient) {
      await db.close();
      return NextResponse.json({ error: 'Patient not found' }, { status: 404, headers: corsHeaders });
    }
    const lastPayment = await db.get(`
      SELECT p.created_at, p.amount
      FROM payments p
      JOIN invoices i ON p.invoice_id = i.id
      WHERE i.patient_id = ? AND p.confirmed = 1
      ORDER BY p.created_at DESC
      LIMIT 1
    `, [patient.id]);
    const outstandingResult = await db.get(`
      SELECT COALESCE(SUM(amount), 0) as balance
      FROM invoices
      WHERE patient_id = ? AND status IN ('unpaid', 'overdue')
    `, [patient.id]);
    await db.close();
    return NextResponse.json({
      name: patient.name,
      status: patient.status,
      balance: (outstandingResult.balance / 100).toFixed(2),
      lastPayment: lastPayment ? lastPayment.created_at.split('T')[0] : null,
      memberSince: patient.member_since,
      monthlyFee: (patient.monthly_fee / 100).toFixed(2)
    }, { headers: corsHeaders });
  } catch (error) {
    console.error('Error fetching patient:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500, headers: corsHeaders });
  }
}
