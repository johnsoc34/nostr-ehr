import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sendInvoiceDM } from '@/lib/nostr';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const { patientId, amount, description, dueDate, deliveryMethods } = await req.json();
    
    const db = await getDb();
    
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', [patientId]);
    if (!patient) {
      return NextResponse.json({ error: 'Patient not found' }, { status: 404 });
    }
    
    const lastInvoice = await db.get('SELECT id FROM invoices ORDER BY id DESC LIMIT 1');
    const lastNum = lastInvoice ? parseInt(lastInvoice.id.split('-')[1]) : 0;
    const invoiceId = `INV-${String(lastNum + 1).padStart(4, '0')}`;
    
    const token = crypto.randomBytes(16).toString('hex');
    
    await db.run(`
      INSERT INTO invoices (id, patient_id, amount, description, due_date, token)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [invoiceId, patientId, amount, description, dueDate, token]);
    
    const paymentUrl = `${process.env.NEXT_PUBLIC_APP_URL}/pay/${token}`;
    
    if (deliveryMethods.includes('nostr')) {
      await sendInvoiceDM({
        recipientNpub: patient.npub,
        invoiceId,
        amount,
        paymentUrl
      });
    }
    
    return NextResponse.json({
      invoiceId,
      token,
      paymentUrl
    });
    
  } catch (error) {
    console.error('Error creating invoice:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
