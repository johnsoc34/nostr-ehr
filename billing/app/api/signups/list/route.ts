import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const db = await getDb();
    
    const signups = await db.all(`
      SELECT * FROM signups
      ORDER BY 
        CASE status 
          WHEN 'pending' THEN 1 
          WHEN 'approved' THEN 2 
          WHEN 'rejected' THEN 3 
        END,
        created_at DESC
    `);
    
    await db.close(); // Close connection after query
    
    return NextResponse.json(signups, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
    
  } catch (error) {
    console.error('Error fetching signups:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
