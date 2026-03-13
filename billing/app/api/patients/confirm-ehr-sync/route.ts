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
    const { npub, billing_model, name } = body;

    if (!npub) {
      return NextResponse.json(
        { error: 'npub required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await getDb();
    const patient = await db.get('SELECT * FROM patients WHERE npub = ?', [npub]);

    const isPerVisit = billing_model === 'per-visit';

    if (!patient) {
      // Patient not in billing DB yet — INSERT a new record
      // This happens for per-visit patients created directly from the EHR
      await db.run(`
        INSERT INTO patients (name, npub, status, patient_type, monthly_fee, ehr_synced, ehr_synced_at)
        VALUES (?, ?, 'active', ?, ?, 1, CURRENT_TIMESTAMP)
      `, [
        name || 'Unknown',
        npub,
        isPerVisit ? 'per-visit' : 'monthly',
        isPerVisit ? 0 : 15000, // default monthly fee for new monthly members
      ]);

      await db.close();
      console.log(`✓ New patient ${name || 'Unknown'} created in billing and activated (${isPerVisit ? 'per-visit' : 'monthly'})`);

      return NextResponse.json({
        success: true,
        message: `New patient created and activated (${isPerVisit ? 'per-visit' : 'monthly'})`,
        patient: name || 'Unknown',
        created: true,
      }, { headers: corsHeaders });
    }

    // Patient exists — UPDATE as before
    await db.run(`
      UPDATE patients
      SET ehr_synced = 1,
          ehr_synced_at = CURRENT_TIMESTAMP,
          status = 'active',
          patient_type = ?,
          monthly_fee = CASE WHEN ? = 'per-visit' THEN 0 ELSE monthly_fee END
      WHERE npub = ?
    `, [isPerVisit ? 'per-visit' : 'monthly', isPerVisit ? 'per-visit' : 'monthly', npub]);

    // Update name if provided and current name is placeholder
    if (name && (!patient.name || patient.name === 'Unknown')) {
      await db.run('UPDATE patients SET name = ? WHERE npub = ?', [name, npub]);
    }

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
