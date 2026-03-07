import { NextResponse } from 'next/server';
const CORS = {
  'Access-Control-Allow-Origin': process.env.PORTAL_URL || 'https://portal.example.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS });
}
export async function POST() {
  return NextResponse.json({ ok: true }, { headers: CORS });
}
