import { buildGatewayMerchant } from './gateway-merchant.js';
import { gatewayDemoConfig } from './gateway-x402.js';

const { origin, port, recipient } = gatewayDemoConfig();
const app = buildGatewayMerchant(origin, recipient);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
const address = await app.listen({ host: '127.0.0.1', port });
console.log(`Arc testnet trace merchant listening at ${address}`);
