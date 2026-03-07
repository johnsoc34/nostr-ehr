import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const db = await getDb();
    
    const invoice = await db.get(`
      SELECT 
        i.*,
        p.name as patient_name,
        p.npub as patient_npub
      FROM invoices i
      JOIN patients p ON i.patient_id = p.id
      WHERE i.token = ?
    `, [token]);
    
    if (!invoice) {
      await db.close();
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    
    await db.close();
    
    return NextResponse.json({
      id: invoice.id,
      patient: invoice.patient_name,
      patientNpub: invoice.patient_npub,
      practice: process.env.PRACTICE_NAME || 'Your Practice',
      amount: invoice.amount,
      description: invoice.description,
      due_date: invoice.due_date,
      status: invoice.status,
      btcAddress: invoice.btc_address,
      lightningInvoice: invoice.lightning_invoice,
    });
    
  } catch (error) {
    console.error('Error fetching invoice:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
