// CI-only smoke against an isolated API; uses read-only metrics and health routes.
import assert from 'node:assert/strict';
const mode = process.argv[2];
assert.ok(['warm', 'outage'].includes(mode), 'Use warm or outage');
const token = process.env.GATEWAY_OPERATIONS_TOKEN;
assert.ok(token, 'GATEWAY_OPERATIONS_TOKEN is required');
const base = process.env.CACHE_SMOKE_API_URL ?? 'http://127.0.0.1:3000';
async function metrics() {
  const response = await fetch(`${base}/finance/operations/metrics`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
if (mode === 'warm') {
  // Redis may still be starting; cache availability never gates API readiness.
  let source;
  for (let attempt = 0; attempt < 15; attempt++) {
    source = (await metrics()).cache.source;
    if (source === 'redis') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(source, 'redis');
} else {
  assert.equal((await metrics()).cache.source, 'database-fallback');
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
}
console.log(`Redis API ${mode} check passed`);
