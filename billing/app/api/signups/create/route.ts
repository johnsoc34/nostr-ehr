import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { name, email, phone, message, website } = await req.json();
    
    // Honeypot check - if website field is filled, reject silently
    if (website) {
      console.log('Bot detected via honeypot:', email);
      // Return success to fool the bot (but don't save to DB)
      return NextResponse.json({ success: true, message: 'Application submitted successfully' });
    }
    
    const db = await getDb();
    
    // Check if email already exists
    const existing = await db.get('SELECT id FROM signups WHERE email = ?', [email]);
    if (existing) {
      await db.close();
      return NextResponse.json({ error: 'Email already submitted' }, { status: 400 });
    }
    
    // Create signup request
    await db.run(`
      INSERT INTO signups (name, email, phone, message, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [name, email, phone || null, message || null]);
    
    await db.close();
    
    return NextResponse.json({ success: true, message: 'Application submitted successfully' });
    
  } catch (error) {
    console.error('Error creating signup:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
