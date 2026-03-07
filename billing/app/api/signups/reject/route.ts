import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { signupId } = await req.json();
    
    const db = await getDb();
    
    await db.run(`
      UPDATE signups 
      SET status = 'rejected'
      WHERE id = ?
    `, [signupId]);
    
    return NextResponse.json({ success: true });
    
  } catch (error) {
    console.error('Error rejecting signup:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
