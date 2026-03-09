import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { npub, name, email, monthlyFee, memberSince } = await req.json();

    // Validate npub
    if (!npub || typeof npub !== 'string') {
      return NextResponse.json({ error: 'npub is required' }, { status: 400 });
    }
    const trimmedNpub = npub.trim();
    if (trimmedNpub.startsWith('nsec1')) {
      return NextResponse.json({ error: 'SECURITY: You entered a secret key (nsec). Enter the PUBLIC key (npub) instead. Never paste your nsec into web forms.' }, { status: 400 });
    }
    if (!trimmedNpub.startsWith('npub1')) {
      return NextResponse.json({ error: 'Invalid format — must start with npub1' }, { status: 400 });
    }
    if (trimmedNpub.length !== 63) {
      return NextResponse.json({ error: 'Invalid npub length — expected 63 characters' }, { status: 400 });
    }

    // Normalize name: "Jane Doe" → "Doe, Jane" if no comma present
    let normalizedName = (name || '').trim();
    if (normalizedName && !normalizedName.includes(',')) {
      const parts = normalizedName.split(/\s+/);
      if (parts.length >= 2) {
        const last = parts.pop();
        normalizedName = `${last}, ${parts.join(' ')}`;
      }
    }

    const db = await getDb();

    // Check if npub already exists
    const existing = await db.get('SELECT id FROM patients WHERE npub = ?', [trimmedNpub]);
    if (existing) {
      return NextResponse.json({ error: 'Patient with this npub already exists' }, { status: 400 });
    }

    await db.run(`
      INSERT INTO patients (npub, name, email, monthly_fee, status, member_since)
      VALUES (?, ?, ?, ?, 'active', ?)
    `, [trimmedNpub, normalizedName, email || null, monthlyFee, memberSince]);

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Error creating patient:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
