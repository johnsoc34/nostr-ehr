import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';

const bip32 = BIP32Factory(ecc);

export function deriveAddress(xpub: string, index: number): string {
  const network = bitcoin.networks.bitcoin;
  const node = bip32.fromBase58(xpub, network);
  
  const child = node.derive(0).derive(index);
  
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: child.publicKey,
    network
  });
  
  if (!address) throw new Error('Failed to generate address');
  return address;
}

export async function checkAddressBalance(address: string): Promise<{
  received: number;
  confirmations: number;
  txid?: string;
}> {
  const res = await fetch(`https://blockstream.info/api/address/${address}`);
  const data = await res.json();
  
  if (data.chain_stats.funded_txo_sum > 0) {
    const txRes = await fetch(`https://blockstream.info/api/address/${address}/txs`);
    const txs = await txRes.json();
    const latestTx = txs[0];
    
    return {
      received: data.chain_stats.funded_txo_sum,
      confirmations: latestTx.status.confirmed ? latestTx.status.block_height : 0,
      txid: latestTx.txid
    };
  }
  
  return { received: 0, confirmations: 0 };
}
