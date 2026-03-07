import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { nip19 } from 'nostr-tools';

export async function POST(req: NextRequest) {
  try {
    const { 
      signupId, 
      familyName,
      householdAddress,
      primaryHolder,
      secondaryHolder,
      children 
    } = await req.json();
    
    const db = await getDb();
    
    // Create family record
    const familyResult = await db.run(`
      INSERT INTO families (family_name, household_address)
      VALUES (?, ?)
    `, [familyName, householdAddress || null]);
    
    const familyId = familyResult.lastID;
    
    const generatedKeys: any[] = [];
    
    // Generate keys for primary holder
    const primarySecretKey = generateSecretKey();
    const primaryPublicKey = getPublicKey(primarySecretKey);
    const primaryNsec = nip19.nsecEncode(primarySecretKey);
    const primaryNpub = nip19.npubEncode(primaryPublicKey);
    
    await db.run(`
      INSERT INTO patients (
        npub, name, email, phone, monthly_fee, status, 
        family_id, is_account_holder, relationship, member_since
      )
      VALUES (?, ?, ?, ?, 0, 'Head_of_Household', ?, 1, 'primary_holder', ?)
    `, [
      primaryNpub, 
      primaryHolder.name, 
      primaryHolder.email, 
      primaryHolder.phone || null,
      familyId,
      new Date().toISOString().split('T')[0]
    ]);
    
    generatedKeys.push({
      name: primaryHolder.name,
      relationship: 'Primary Account Holder',
      nsec: primaryNsec,
      npub: primaryNpub
    });
    
    // Generate keys for secondary holder if provided
    if (secondaryHolder?.name) {
      const secondarySecretKey = generateSecretKey();
      const secondaryPublicKey = getPublicKey(secondarySecretKey);
      const secondaryNsec = nip19.nsecEncode(secondarySecretKey);
      const secondaryNpub = nip19.npubEncode(secondaryPublicKey);
      
      await db.run(`
        INSERT INTO patients (
          npub, name, email, phone, monthly_fee, status, 
          family_id, is_account_holder, relationship, member_since
        )
        VALUES (?, ?, ?, ?, 0, 'Head_of_Household', ?, 1, 'secondary_holder', ?)
      `, [
        secondaryNpub,
        secondaryHolder.name,
        secondaryHolder.email || null,
        secondaryHolder.phone || null,
        familyId,
        new Date().toISOString().split('T')[0]
      ]);
      
      generatedKeys.push({
        name: secondaryHolder.name,
        relationship: 'Secondary Account Holder',
        nsec: secondaryNsec,
        npub: secondaryNpub
      });
    }
    
    // Generate keys for children
    for (const child of children) {
      const childSecretKey = generateSecretKey();
      const childPublicKey = getPublicKey(childSecretKey);
      const childNsec = nip19.nsecEncode(childSecretKey);
      const childNpub = nip19.npubEncode(childPublicKey);
      
      await db.run(`
        INSERT INTO patients (
          npub, name, date_of_birth, monthly_fee, status, 
          family_id, is_account_holder, relationship, member_since
        )
        VALUES (?, ?, ?, ?, 'pending_onboarding', ?, 0, 'child', ?)
      `, [
        childNpub,
        child.name,
        child.dateOfBirth,
        child.monthlyFee || 15000,
        familyId,
        new Date().toISOString().split('T')[0]
      ]);
      
      generatedKeys.push({
        name: child.name,
        relationship: 'Child',
        dateOfBirth: child.dateOfBirth,
        nsec: childNsec,
        npub: childNpub
      });
    }
    
    // Update signup status to approved
    if (signupId) {
      await db.run(`
        UPDATE signups 
        SET status = 'approved', approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [signupId]);
    }
    
    await db.close();
    
    return NextResponse.json({
      success: true,
      familyId,
      familyName,
      generatedKeys
    });
    
  } catch (error) {
    console.error('Error creating household:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
