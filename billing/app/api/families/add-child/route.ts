import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { nip19 } from 'nostr-tools';

export async function POST(req: NextRequest) {
  try {
    const { familyId, name, dateOfBirth, monthlyFee } = await req.json();
    
    if (!familyId || !name || !dateOfBirth) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }
    
    const db = await getDb();
    
    // Verify family exists
    const family = await db.get('SELECT * FROM families WHERE id = ?', [familyId]);
    if (!family) {
      await db.close();
      return NextResponse.json(
        { error: 'Family not found' },
        { status: 404 }
      );
    }
    
    // Generate keys for child
    const secretKey = generateSecretKey();
    const publicKey = getPublicKey(secretKey);
    const nsec = nip19.nsecEncode(secretKey);
    const npub = nip19.npubEncode(publicKey);
    
    // Insert child
    await db.run(`
      INSERT INTO patients (
        npub, name, date_of_birth, monthly_fee, status,
        family_id, is_account_holder, relationship, member_since
      )
      VALUES (?, ?, ?, ?, 'pending_onboarding', ?, 0, 'child', ?)
    `, [
      npub,
      name,
      dateOfBirth,
      monthlyFee || 15000,
      familyId,
      new Date().toISOString().split('T')[0]
    ]);
    
    await db.close();
    
    return NextResponse.json({
      success: true,
      child: {
        name,
        dateOfBirth,
        nsec,
        npub
      }
    });
    
  } catch (error) {
    console.error('Error adding child:', error);
    return NextResponse.json(
      { error: 'Server error' },
      { status: 500 }
    );
  }
}
