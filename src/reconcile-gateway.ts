import { isAddress } from 'viem';
import { observeGatewayPayment } from './gateway-reconciliation.js';
import type { GatewayNetworkName } from './gateway-x402.js';

const [nonce, payer, recipient, amountUnits, network = 'arcTestnet'] = process.argv.slice(2);
if (!nonce || !/^0x[\da-f]{64}$/i.test(nonce) || !payer || !isAddress(payer) ||
    !recipient || !isAddress(recipient) || !amountUnits || !/^[1-9]\d*$/.test(amountUnits) ||
    (network !== 'arc' && network !== 'arcTestnet')) {
  throw new Error('Usage: npm run reconcile:gateway -- <nonce> <payer> <recipient> <amount-in-USDC-base-units> [arc|arcTestnet]');
}

const observation = await observeGatewayPayment({ nonce, payer, recipient, amountUnits, network: network as GatewayNetworkName });
console.log(JSON.stringify(observation, null, 2));
if (observation.status === 'conflict') process.exitCode = 2;
