import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { checkAddressBalance } from '@/lib/bitcoin';

export async function POST(req: NextRequest) {
  try {
    const { invoiceId } = await req.json();
    
    const db = await getDb();
    
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice || !invoice.btc_address) {
      return NextResponse.json({ error: 'Invalid invoice' }, { status: 400 });
    }
    
    const { received, confirmations, txid } = await checkAddressBalance(invoice.btc_address);
    
    const BTC_PRICE = 97420;
    const expectedSats = Math.round((invoice.amount / 100 / BTC_PRICE) * 100000000);
    
    const isPaid = received >= expectedSats * 0.99;
    
    if (isPaid && invoice.status === 'unpaid') {
      await db.run(
        'UPDATE invoices SET status = ? WHERE id = ?',
        [confirmations >= 1 ? 'paid' : 'pending', invoiceId]
      );
      
      const existingPayment = await db.get(
        'SELECT * FROM payments WHERE invoice_id = ? AND method = ?',
        [invoiceId, 'bitcoin']
      );
      
      if (!existingPayment) {
        await db.run(`
          INSERT INTO payments (invoice_id, amount, method, tx_reference, confirmed, confirmations)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [invoiceId, invoice.amount, 'bitcoin', txid, confirmations >= 1, confirmations]);
      } else {
        await db.run(
          'UPDATE payments SET confirmations = ?, confirmed = ? WHERE id = ?',
          [confirmations, confirmations >= 1, existingPayment.id]
        );
      }
    }
    
    return NextResponse.json({
      paid: isPaid,
      confirmations,
      txid,
      receivedSats: received
    });
    
  } catch (error) {
    console.error('Error checking payment:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
