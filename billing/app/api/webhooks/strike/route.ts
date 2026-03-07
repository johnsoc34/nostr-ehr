import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    
    const { eventType, data } = payload;
    
    if (eventType === 'invoice.updated' && data.state === 'PAID') {
      const db = await getDb();
      
      const invoiceId = data.correlationId;
      
      await db.run(
        'UPDATE invoices SET status = ? WHERE id = ?',
        ['paid', invoiceId]
      );
      
      await db.run(`
        INSERT INTO payments (invoice_id, amount, method, tx_reference, confirmed, confirmations)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        invoiceId,
        parseFloat(data.amount.amount) * 100,
        'lightning',
        data.invoiceId,
        true,
        1
      ]);
    }
    
    return NextResponse.json({ received: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
