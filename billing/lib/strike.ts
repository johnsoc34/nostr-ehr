const STRIKE_API = 'https://api.strike.me/v1';

interface StrikeInvoice {
  invoiceId: string;
  amount: { amount: string; currency: string };
  state: 'UNPAID' | 'PENDING' | 'PAID';
  description: string;
  created: string;
  correlationId: string;
  lnInvoice: string;
}

export async function createStrikeInvoice(params: {
  amount: number;
  description: string;
  correlationId: string;
}): Promise<StrikeInvoice> {
  const res = await fetch(`${STRIKE_API}/invoices`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.STRIKE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      correlationId: params.correlationId,
      description: params.description,
      amount: {
        amount: (params.amount / 100).toFixed(2),
        currency: 'USD'
      }
    })
  });
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Strike API error: ${error}`);
  }
  
  return res.json();
}

export async function getStrikeInvoice(invoiceId: string): Promise<StrikeInvoice> {
  const res = await fetch(`${STRIKE_API}/invoices/${invoiceId}`, {
    headers: { 'Authorization': `Bearer ${process.env.STRIKE_API_KEY}` }
  });
  
  if (!res.ok) throw new Error('Invoice not found');
  return res.json();
}
