import { isAddress } from 'viem';
import { observeGatewayPayment } from './gateway-reconciliation.js';

const [nonce, payer, recipient, amountUnits] = process.argv.slice(2);
if (!nonce || !/^0x[\da-f]{64}$/i.test(nonce) || !payer || !isAddress(payer) ||
    !recipient || !isAddress(recipient) || !amountUnits || !/^[1-9]\d*$/.test(amountUnits)) {
  throw new Error('Usage: npm run reconcile:gateway -- <nonce> <payer> <recipient> <amount-in-USDC-base-units>');
}

const observation = await observeGatewayPayment({ nonce, payer, recipient, amountUnits });
console.log(JSON.stringify(observation, null, 2));
if (observation.status === 'conflict') process.exitCode = 2;
