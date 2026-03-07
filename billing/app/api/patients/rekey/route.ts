import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { exec } from 'child_process';

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
    const { oldNpub, newNpub } = await req.json();

    if (!oldNpub || !newNpub) {
      return NextResponse.json(
        { error: 'oldNpub and newNpub required' },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!oldNpub.startsWith('npub1') || !newNpub.startsWith('npub1')) {
      return NextResponse.json(
        { error: 'Invalid npub format' },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await getDb();

    const patient = await db.get('SELECT * FROM patients WHERE npub = ?', [oldNpub]);

    if (!patient) {
      await db.close();
      return NextResponse.json(
        { error: 'Patient not found with old npub' },
        { status: 404, headers: corsHeaders }
      );
    }

    // Check new npub isn't already in use
    const conflict = await db.get('SELECT id FROM patients WHERE npub = ?', [newNpub]);
    if (conflict) {
      await db.close();
      return NextResponse.json(
        { error: 'New npub already exists in billing' },
        { status: 409, headers: corsHeaders }
      );
    }

    await db.run('UPDATE patients SET npub = ? WHERE id = ?', [newNpub, patient.id]);
    await db.close();

    console.log(`✓ Re-key: ${patient.name} npub updated from ${oldNpub.slice(0,20)}… to ${newNpub.slice(0,20)}…`);

    // Trigger whitelist sync in background
    exec('/home/nostr/sync-whitelist.sh', (err, stdout, stderr) => {
      if (err) console.error('Whitelist sync failed:', stderr);
      else console.log('✓ Whitelist synced after re-key');
    });

    return NextResponse.json({
      success: true,
      message: `Patient ${patient.name} re-keyed`,
      patient: patient.name,
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Error re-keying patient:', error);
    return NextResponse.json(
      { error: 'Server error' },
      { status: 500, headers: corsHeaders }
    );
  }
}
