import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createStrikeInvoice } from '@/lib/strike';

export async function POST(req: NextRequest) {
  try {
    const { invoiceId } = await req.json();
    
    const db = await getDb();
    
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    
    if (invoice.lightning_invoice) {
      return NextResponse.json({ invoice: invoice.lightning_invoice });
    }
    
    const strikeInvoice = await createStrikeInvoice({
      amount: invoice.amount,
      description: `${invoice.id} - ${invoice.description}`,
      correlationId: invoiceId
    });
    
    await db.run(
      'UPDATE invoices SET lightning_invoice = ? WHERE id = ?',
      [strikeInvoice.lnInvoice, invoiceId]
    );
    
    return NextResponse.json({
      invoice: strikeInvoice.lnInvoice,
      strikeInvoiceId: strikeInvoice.invoiceId
    });
    
  } catch (error) {
    console.error('Error creating Lightning invoice:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
