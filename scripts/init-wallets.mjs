import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envFile = new URL('../.env', import.meta.url);
const lock = new URL('../.wallet-init.lock/', import.meta.url);
const pending = new URL('env', lock);

function initialize() {
  mkdirSync(lock, { mode: 0o700 });
  try {
    const info = lstatSync(envFile, { throwIfNoEntry: false });
    if (info && !info.isFile()) throw new Error('.env must be a regular file');
    const original = info ? readFileSync(envFile, 'utf8') : '';
    const settings = parseEnv(original);
    const walletFields = ['PAYMENT_PAYER_KEY', 'PAYMENT_RELAYER_KEY', 'MERCHANT_TEST_KEY', 'MERCHANT_RECIPIENT'];
    const configured = walletFields.filter((field) => Object.hasOwn(settings, field));
    if (configured.length > 0 && configured.length !== walletFields.length) {
      throw new Error('Partial wallet configuration in .env. Keep your existing wallets or remove the wallet fields before generating a new set.');
    }

    const [payerKey, relayerKey, merchantKey] = configured.length
      ? walletFields.slice(0, 3).map((field) => settings[field])
      : Array.from({ length: 3 }, () => generatePrivateKey());
    const address = (key) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Invalid test wallet key in .env');
      try {
        return privateKeyToAccount(key).address;
      } catch {
        throw new Error('Invalid test wallet key in .env');
      }
    };
    const addresses = { payer: address(payerKey), relayer: address(relayerKey), merchant: address(merchantKey) };
    if (new Set(Object.values(addresses)).size !== 3) throw new Error('Test accounts must have distinct addresses');
    if (configured.length && settings.MERCHANT_RECIPIENT.toLowerCase() !== addresses.merchant.toLowerCase()) {
      throw new Error('Merchant test key does not match MERCHANT_RECIPIENT');
    }

    const additions = {
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      MERCHANT_ENDPOINT: 'http://127.0.0.1:3001/market-data',
      MERCHANT_DELIVERY_SECRET: randomBytes(32).toString('hex'),
      PAYMENT_PAYER_KEY: payerKey,
      PAYMENT_RELAYER_KEY: relayerKey,
      MERCHANT_TEST_KEY: merchantKey,
      MERCHANT_RECIPIENT: addresses.merchant,
    };
    const missing = Object.entries(additions).filter(([field]) => !Object.hasOwn(settings, field));
    if (missing.length) {
      const separator = original && !original.endsWith('\n') ? '\n' : '';
      writeFileSync(pending, original + separator + missing.map(([field, value]) => `${field}=${value}\n`).join(''),
        { mode: 0o600, flag: 'wx' });
      renameSync(pending, envFile);
    }
    console.log(JSON.stringify(addresses, null, 2));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

try {
  initialize();
} catch (error) {
  if (error.code === 'EEXIST') console.error('Wallet initialization lock exists. Check for another initialization in progress.');
  else console.error(error.code ? 'Could not update the local .env file.' : error.message);
  process.exitCode = 1;
}
