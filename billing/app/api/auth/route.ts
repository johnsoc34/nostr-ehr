import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import bcrypt from 'bcryptjs';

const COOKIE_NAME = 'billing_session';
const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours in seconds

function getSecret(): string {
  return process.env.BILLING_SESSION_SECRET || process.env.DASHBOARD_PASSWORD_HASH || 'fallback-change-me';
}

function signToken(data: string): string {
  const hmac = createHmac('sha256', getSecret());
  hmac.update(data);
  return hmac.digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();
    const expected = process.env.DASHBOARD_PASSWORD_HASH;
    if (!expected || !password) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    const match = await bcrypt.compare(password, expected);
    if (!match) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    // Create signed session cookie
    const payload = Buffer.from(JSON.stringify({
      auth: true,
      exp: Date.now() + SESSION_MAX_AGE * 1000,
    })).toString('base64');
    const token = payload + '.' + signToken(payload);

    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
    return res;
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
