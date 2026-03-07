import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();
    const expected = process.env.DASHBOARD_PASSWORD_HASH;
    if (!expected || !password) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    const inputHash = createHash('sha256').update(password).digest('hex');
    if (inputHash === expected) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false }, { status: 401 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
