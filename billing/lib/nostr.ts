import { getPublicKey, nip19 } from 'nostr-tools';
import { wrapEvent } from 'nostr-tools/nip17';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'wss://relay.example.com';

export async function sendInvoiceDM(params: {
  recipientNpub: string;
  invoiceId: string;
  amount: number;
  paymentUrl: string;
}) {
  const PRACTICE_NSEC = process.env.NOSTR_NSEC;
  if (!PRACTICE_NSEC) throw new Error('NOSTR_NSEC not configured');

  const { data: practiceSeckey } = nip19.decode(PRACTICE_NSEC);
  const { data: patientPubkey } = nip19.decode(params.recipientNpub);

  const message = `📋 New Invoice: ${params.invoiceId}
💰 Amount: $${(params.amount / 100).toFixed(2)}

Pay securely here:
${params.paymentUrl}

This invoice was sent via your ${process.env.PRACTICE_NAME || "practice"} billing portal.`;

  // NIP-17: create gift-wrapped DM (kind 1059)
  // Inner rumor (kind 14) → seal (kind 13) → gift wrap (kind 1059, throwaway key)
  const giftWrap = wrapEvent(
    practiceSeckey as Uint8Array,
    { publicKey: patientPubkey as string },
    message
  );

  // Publish via raw WebSocket — gift wraps are signed by a throwaway key
  // that won't be on the relay whitelist. The relay's nip42_dms setting
  // accepts kind 1059 and delivers only to the authenticated recipient.
  await publishEvent(giftWrap);
  return giftWrap;
}

function publishEvent(event: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Relay publish timeout'));
    }, 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });

    ws.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'OK') {
          clearTimeout(timeout);
          ws.close();
          if (msg[2] === true) {
            resolve();
          } else {
            reject(new Error(`Relay rejected event: ${msg[3] || 'unknown reason'}`));
          }
        }
      } catch {}
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
