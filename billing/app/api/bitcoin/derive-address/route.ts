import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deriveAddress } from '@/lib/bitcoin';

export async function POST(req: NextRequest) {
  try {
    const { invoiceId } = await req.json();
    
    const db = await getDb();
    
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    
    if (invoice.btc_address) {
      return NextResponse.json({ address: invoice.btc_address });
    }
    
    const xpub = process.env.BITCOIN_XPUB;
    if (!xpub) {
      return NextResponse.json({ error: 'xpub not configured' }, { status: 500 });
    }
    
    const invoiceNumber = parseInt(invoiceId.split('-')[1]);
    
    const address = deriveAddress(xpub, invoiceNumber);
    
    await db.run(
      'UPDATE invoices SET btc_address = ? WHERE id = ?',
      [address, invoiceId]
    );
    
    return NextResponse.json({ address });
    
  } catch (error) {
    console.error('Error deriving address:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
