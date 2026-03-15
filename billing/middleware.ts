import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'billing_session';

const PUBLIC_PREFIXES = [
  '/api/auth',
  '/api/invoice/',
  '/api/webhooks/',
  '/api/bitcoin/',
  '/api/lightning/',
  '/api/signups/create',
];

function getSecret(): string {
  return process.env.BILLING_SESSION_SECRET || process.env.DASHBOARD_PASSWORD_HASH || 'fallback-change-me';
}

async function hmacSha256(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifySession(cookieValue: string): Promise<boolean> {
  try {
    const [payload, sig] = cookieValue.split('.');
    if (!payload || !sig) return false;
    const expected = await hmacSha256(getSecret(), payload);
    if (sig !== expected) return false;
    const decoded = JSON.parse(atob(payload));
    if (decoded.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  if (!path.startsWith('/api/')) {
    return NextResponse.next();
  }

  if (PUBLIC_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (cookie && await verifySession(cookie)) {
    return NextResponse.next();
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export const config = {
  matcher: '/api/:path*',
};
