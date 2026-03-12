import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { npub, billing_model } = body;

    if (!npub) {
      return NextResponse.json(
        { error: 'npub required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await getDb();
    const patient = await db.get('SELECT * FROM patients WHERE npub = ?', [npub]);

    if (!patient) {
      await db.close();
      return NextResponse.json(
        { error: 'Patient not found' },
        { status: 404, headers: corsHeaders }
      );
    }

    const isPerVisit = billing_model === 'per-visit';

    // Mark as synced AND activate
    // Per-visit patients: set patient_type, zero out monthly fee
    await db.run(`
      UPDATE patients
      SET ehr_synced = 1,
          ehr_synced_at = CURRENT_TIMESTAMP,
          status = 'active',
          patient_type = ?,
          monthly_fee = CASE WHEN ? = 'per-visit' THEN 0 ELSE monthly_fee END
      WHERE npub = ?
    `, [isPerVisit ? 'per-visit' : 'monthly', isPerVisit ? 'per-visit' : 'monthly', npub]);

    await db.close();

    console.log(`✓ Patient ${patient.name} synced to EHR and activated (${isPerVisit ? 'per-visit' : 'monthly'})`);

    return NextResponse.json({
      success: true,
      message: `Patient synced to EHR and activated (${isPerVisit ? 'per-visit' : 'monthly'})`,
      patient: patient.name
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Error confirming EHR sync:', error);
    return NextResponse.json(
      { error: 'Server error' },
      { status: 500, headers: corsHeaders }
    );
  }
}
