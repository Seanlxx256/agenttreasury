export interface QuoteTarget {
  endpoint: string;
  network: string;
  asset: string;
  payee: string;
  amount: string;
}

export interface Quote {
  scheme: 'exact';
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
}

export class QuoteError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) {
    super(code);
  }
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export async function requestQuote(target: QuoteTarget, fetcher = fetch): Promise<Quote> {
  let response: Response;
  try {
    response = await fetcher(target.endpoint, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new QuoteError('MERCHANT_UNREACHABLE', true);
  }
  await response.body?.cancel().catch(() => {});
  if (response.status >= 500 || response.status === 429) throw new QuoteError('MERCHANT_UNAVAILABLE', true);
  if (response.status !== 402) throw new QuoteError('PAYMENT_REQUIRED_EXPECTED');

  const header = response.headers.get('payment-required');
  if (!header || header.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) {
    throw new QuoteError('INVALID_QUOTE');
  }
  let required: Record<string, unknown>;
  try {
    required = fields(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
  } catch {
    throw new QuoteError('INVALID_QUOTE');
  }
  if (required.x402Version !== 2 || fields(required.resource).url !== target.endpoint ||
      !Array.isArray(required.accepts)) throw new QuoteError('INVALID_QUOTE');

  for (const entry of required.accepts) {
    const option = fields(entry);
    const method = fields(option.extra).assetTransferMethod;
    if (option.scheme === 'exact' && (method === undefined || method === 'eip3009') &&
        option.network === target.network && option.amount === target.amount &&
        typeof option.asset === 'string' && option.asset.toLowerCase() === target.asset &&
        typeof option.payTo === 'string' && option.payTo.toLowerCase() === target.payee &&
        typeof option.maxTimeoutSeconds === 'number' && Number.isInteger(option.maxTimeoutSeconds) &&
        option.maxTimeoutSeconds > 0 && option.maxTimeoutSeconds <= 300) {
      return {
        scheme: 'exact', network: target.network, asset: target.asset, payTo: target.payee,
        amount: target.amount, maxTimeoutSeconds: option.maxTimeoutSeconds,
      };
    }
  }
  throw new QuoteError('QUOTE_MISMATCH');
}
