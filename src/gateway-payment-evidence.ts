import type { Pool } from 'pg';
import { observeGatewayPayment, type ExpectedGatewayPayment, type GatewayObservation } from './gateway-reconciliation.js';

export async function checkGatewayPayment(
  pool: Pool,
  requestId: string,
  expected: ExpectedGatewayPayment,
  source: 'buyer' | 'finance',
  request: typeof fetch = fetch,
) {
  let evidence: GatewayObservation | { status: 'unavailable' };
  try {
    evidence = await observeGatewayPayment(expected, request);
  } catch {
    evidence = { status: 'unavailable' };
  }
  await pool.query(
    `INSERT INTO gateway_payment_observations (request_id, source, evidence)
     SELECT request_id, $3, $4 FROM gateway_demo_purchases WHERE request_id = $1 AND nonce = $2`,
    [requestId, expected.nonce, source, JSON.stringify(evidence)],
  );
  return evidence;
}
