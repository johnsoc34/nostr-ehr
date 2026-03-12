import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

const CORS = {
  'Access-Control-Allow-Origin': 'https://portal.immutablehealthpediatrics.com',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS });
}

export async function GET(req: NextRequest) {
  try {
    const db = await getDb();
    const patients = await db.all(`
      SELECT
        p.*,
        COALESCE(SUM(CASE WHEN i.status IN ('unpaid', 'overdue') THEN i.amount ELSE 0 END), 0) as balance
      FROM patients p
      LEFT JOIN invoices i ON i.patient_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    return NextResponse.json(patients, { headers: CORS });
  } catch (error) {
    console.error('Error fetching patients:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500, headers: CORS });
  }
}
