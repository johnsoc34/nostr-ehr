import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16'
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature')!;
    
    const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    
    const db = await getDb();
    
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const invoiceId = paymentIntent.metadata.invoice_id;
        
        if (!invoiceId) break;
        
        await db.run('UPDATE invoices SET status = ? WHERE id = ?', ['paid', invoiceId]);
        
        const method = paymentIntent.payment_method_types.includes('us_bank_account') ? 'ach' : 'stripe';
        
        await db.run(`
          INSERT INTO payments (invoice_id, amount, method, tx_reference, confirmed, confirmations)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          invoiceId,
          paymentIntent.amount,
          method,
          paymentIntent.id,
          true,
          1
        ]);
        
        break;
      }
      
      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const invoiceId = paymentIntent.metadata.invoice_id;
        
        if (invoiceId) {
          await db.run('UPDATE invoices SET status = ? WHERE id = ?', ['unpaid', invoiceId]);
        }
        
        break;
      }
    }
    
    return NextResponse.json({ received: true });
    
  } catch (error) {
    console.error('Stripe webhook error:', error);
    return NextResponse.json({ error: 'Webhook failed' }, { status: 400 });
  }
}
