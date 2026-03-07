import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { patientId } = await req.json();
    
    const db = await getDb();
    
    // Delete patient (this will also cascade delete invoices/payments if foreign keys are set)
    await db.run('DELETE FROM patients WHERE id = ?', [patientId]);
    
    return NextResponse.json({ success: true });
    
  } catch (error) {
    console.error('Error deleting patient:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
