import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
export const dynamic = 'force-dynamic';
const PORTAL_ORIGIN = process.env.PORTAL_URL || 'https://portal.example.com';
const corsHeaders = {
  'Access-Control-Allow-Origin': PORTAL_ORIGIN,
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
      'SELECT name FROM patients WHERE npub = ?',
      [npub]
    );
    if (!patient) {
      return NextResponse.json({ error: 'Patient not found' }, { status: 404, headers: corsHeaders });
    }
    return NextResponse.json({ name: patient.name }, { headers: corsHeaders });
  } catch (error) {
    console.error('Error fetching patient:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500, headers: corsHeaders });
  }
}
