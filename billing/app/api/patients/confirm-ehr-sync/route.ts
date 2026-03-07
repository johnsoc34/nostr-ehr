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
    const { npub } = await req.json();
    
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
    
    // Mark as synced AND activate (unless they're an account holder)
    const newStatus = patient.is_account_holder ? 'active' : 'active';
    
    await db.run(`
      UPDATE patients 
      SET ehr_synced = 1, 
          ehr_synced_at = CURRENT_TIMESTAMP,
          status = ?
      WHERE npub = ?
    `, [newStatus, npub]);
    
    await db.close();
    
    console.log(`✓ Patient ${patient.name} synced to EHR and activated`);
    
    return NextResponse.json({
      success: true,
      message: 'Patient synced to EHR and activated',
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
