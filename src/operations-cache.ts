import { createClient } from 'redis';

export interface MetricsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<unknown>;
  close(): void;
}

// Advisory dashboard data only. Never inject this into payment or policy execution.
export class OperationsCache {
  private pending?: Promise<Record<string, unknown>>;
  constructor(private store: MetricsStore, private namespace: string,
    private ttlMs = 5000, private now = Date.now) {}

  read(load: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    // Coalesce refreshes within this API process, including during a Redis outage.
    this.pending ??= this.readOnce(load).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async readOnce(load: () => Promise<Record<string, unknown>>) {
    const key = `agenttreasury:${this.namespace}:operations-metrics:v1`;
    let unavailable = false;
    try {
      const raw = await this.store.get(key);
      if (raw && Buffer.byteLength(raw) <= 1_048_576) {
        try {
          const entry = JSON.parse(raw);
          const ageMs = this.now() - entry.createdAt;
          if (entry.version === 1 && Number.isFinite(entry.createdAt) && ageMs >= 0 && ageMs < this.ttlMs
            && validMetrics(entry.data)) {
            return { ...entry.data, cache: { source: 'redis', ageMs, ttlMs: this.ttlMs } };
          }
        } catch { /* Invalid cache data is a miss; replace it with a database snapshot. */ }
      }
    } catch { unavailable = true; }
    // Timestamp before SQL: a slow query must not extend the snapshot's lifetime.
    const createdAt = this.now();
    const data = await load(); // Database failures propagate; never serve expired data.
    const ageMs = this.now() - createdAt;
    if (!unavailable && ageMs < this.ttlMs) {
      try {
        const raw = JSON.stringify({ version: 1, createdAt, data });
        if (Buffer.byteLength(raw) <= 1_048_576) await this.store.set(key, raw, this.ttlMs - ageMs);
      } catch { unavailable = true; }
    }
    return { ...data, cache: { source: unavailable ? 'database-fallback' : 'database',
      ageMs: this.now() - createdAt, ttlMs: this.ttlMs } };
  }

  close() { this.store.close(); }
}

function validMetrics(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt))
    && ['cases', 'recovery', 'scans', 'latestRecoveryEvidence'].every((key) => {
      const counters = row[key];
      return counters && typeof counters === 'object' && !Array.isArray(counters)
        && Object.values(counters).every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)));
    }) && Array.isArray(row.wallets) && Array.isArray(row.workers);
}

export function operationsCacheFromEnv(env: NodeJS.ProcessEnv = process.env): OperationsCache | undefined {
  if (!env.REDIS_URL) return undefined;
  const namespace = env.REDIS_CACHE_NAMESPACE;
  if (!namespace || !/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) {
    throw new Error('REDIS_CACHE_NAMESPACE must identify this database/deployment (1-64 letters, digits, _ or -)');
  }
  let url: URL;
  try { url = new URL(env.REDIS_URL); }
  catch { throw new Error('REDIS_URL must be a valid Redis connection URL'); }
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://');
  return new OperationsCache(new RedisMetricsStore(env.REDIS_URL), namespace);
}

// A total deadline also covers commands already written to the socket; command
// queue timeouts alone do not cover a server that accepts but never replies.
export class RedisMetricsStore implements MetricsStore {
  private client?: ReturnType<typeof createClient>;
  private retryAfter = 0;
  private closed = false;
  constructor(private url: string, private timeoutMs = 150) {}

  private async run<T>(operation: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
    if (this.closed || Date.now() < this.retryAfter) throw new Error('Metrics cache unavailable');
    const client = this.client ??= createClient({ url: this.url, disableOfflineQueue: true,
      commandsQueueMaxLength: 8, socket: { connectTimeout: this.timeoutMs, reconnectStrategy: false } });
    // Do not log URLs, credentials, or raw connection errors.
    if (client.listenerCount('error') === 0) client.on('error', () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => { if (!client.isOpen) await client.connect(); return operation(client); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Metrics cache timeout')), this.timeoutMs); }),
      ]);
    } catch {
      this.retryAfter = Date.now() + 5000;
      if (client.isOpen) client.destroy();
      this.client = undefined;
      throw new Error('Metrics cache unavailable');
    } finally { clearTimeout(timer); }
  }
  get(key: string) { return this.run((client) => client.get(key)); }
  set(key: string, value: string, ttlMs: number) { return this.run((client) => client.set(key, value, { PX: ttlMs })); }
  close() { this.closed = true; if (this.client?.isOpen) this.client.destroy(); }
}
