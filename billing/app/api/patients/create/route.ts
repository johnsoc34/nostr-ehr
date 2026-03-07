import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { npub, name, email, monthlyFee, memberSince } = await req.json();
    
    const db = await getDb();
    
    // Check if npub already exists
    const existing = await db.get('SELECT id FROM patients WHERE npub = ?', [npub]);
    if (existing) {
      return NextResponse.json({ error: 'Patient with this npub already exists' }, { status: 400 });
    }
    
    await db.run(`
      INSERT INTO patients (npub, name, email, monthly_fee, status, member_since)
      VALUES (?, ?, ?, ?, 'active', ?)
    `, [npub, name, email || null, monthlyFee, memberSince]);
    
    return NextResponse.json({ success: true });
    
  } catch (error) {
    console.error('Error creating patient:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
