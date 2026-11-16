import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { hashTypedData, isAddress, type Address, type Hex } from 'viem';
import { recordAudit } from './audit.js';
import { transaction } from './db.js';
import { lockGatewayGrant, type GatewayTaskCredentials } from './gateway-budget.js';
import { PaymentError, tokenDigest } from './payments.js';
import { gatewayAuthorizationTypes, gatewayNetworkConfig, gatewayTracePrice, gatewayValidity,
  recoverGatewayPayer, type GatewayAuthorization } from './gateway-x402.js';
import type { SigningRequest } from './gateway-purchase.js';

export type GatewaySignerPolicy = {
  payer: Address;
  recipients: Address[];
  maxAmountUnits: bigint;
};

function policyCheck(policy: GatewaySignerPolicy) {
  if (!isAddress(policy.payer) || !policy.recipients.length ||
      policy.recipients.some((address) => !isAddress(address) || address.toLowerCase() === policy.payer.toLowerCase()) ||
      policy.maxAmountUnits <= 0n) throw new Error('Invalid signer policy');
}

// No caller-supplied typed data is accepted. Reconstruct only this protocol's
// domain/types from local configuration and its message from the reserved row.
async function approvedRequest(client: PoolClient, requestId: string, task: GatewayTaskCredentials, policy: GatewaySignerPolicy) {
  const { rows: [terms] } = await client.query('SELECT * FROM gateway_demo_purchases WHERE request_id=$1', [requestId]);
  if (!terms || terms.task_id !== task.taskId) throw new PaymentError(403, 'SIGNING_REQUEST_NOT_ALLOWED');
  const grant = await lockGatewayGrant(client, task, { requestId, endpoint:terms.endpoint,
    payer:terms.payer, recipient:terms.recipient, network:terms.network });
  // Match the task -> purchase lock order used by submission and reconciliation.
  const { rows: [row] } = await client.query(`SELECT *,
    floor(extract(epoch FROM authorized_at))::bigint::text AS issued_seconds,
    floor(extract(epoch FROM clock_timestamp()))::bigint::text AS now_seconds
    FROM gateway_demo_purchases WHERE request_id=$1 FOR UPDATE`, [requestId]);
  if (!row || row.task_id !== terms.task_id || row.endpoint !== terms.endpoint || row.payer !== terms.payer ||
      row.recipient !== terms.recipient || row.network !== terms.network) throw new PaymentError(409, 'SIGNING_TERMS_CHANGED');
  if (row.network !== 'arcTestnet' || row.payer !== policy.payer.toLowerCase() ||
      !policy.recipients.some((address) => address.toLowerCase() === row.recipient) ||
      row.amount_units !== gatewayTracePrice || BigInt(row.amount_units) > policy.maxAmountUnits) {
    throw new PaymentError(403, 'SIGNER_POLICY_REJECTED');
  }
  if (row.budget_status !== 'reserved' || row.submitted_at !== null ||
      BigInt(grant.reserved) < BigInt(row.amount_units) || BigInt(grant.reserved)+BigInt(grant.spent)>BigInt(grant.budget)) {
    throw new PaymentError(409, 'SIGNING_RESERVATION_REQUIRED');
  }
  const { rows: [daily] } = await client.query('SELECT reserved,spent FROM daily_spend WHERE task_id=$1 AND day=$2', [task.taskId,row.budget_day]);
  if (!daily || BigInt(daily.reserved)<BigInt(row.amount_units) ||
      BigInt(daily.reserved)+BigInt(daily.spent)>BigInt(grant.daily_limit)) throw new PaymentError(409, 'SIGNING_RESERVATION_REQUIRED');
  const message = row.signing_authorization as GatewayAuthorization | null;
  if (!message || Object.keys(message).sort().join(',') !== 'from,nonce,to,validAfter,validBefore,value' ||
      message.from?.toLowerCase() !== row.payer || message.to?.toLowerCase() !== row.recipient ||
      message.nonce !== row.nonce || message.value !== row.amount_units || message.validAfter !== '0' ||
      typeof message.validBefore !== 'string' || !/^[1-9][0-9]{0,11}$/.test(message.validBefore) ||
      !/^0x[0-9a-f]{64}$/.test(message.nonce) ||
      BigInt(message.validBefore) <= BigInt(row.now_seconds) ||
      BigInt(message.validBefore) > BigInt(row.issued_seconds)+BigInt(gatewayValidity)+5n) {
    throw new PaymentError(409, 'SIGNING_AUTHORIZATION_INVALID');
  }
  const typedData: SigningRequest = { domain:gatewayNetworkConfig('arcTestnet').domain,
    types:gatewayAuthorizationTypes,primaryType:'TransferWithAuthorization',message };
  const digest = hashTypedData({ ...typedData,message:{ ...message,value:BigInt(message.value),
    validAfter:BigInt(message.validAfter),validBefore:BigInt(message.validBefore) } });
  return { typedData,digest };
}

export function buildGatewaySigner(pool: Pool, policy: GatewaySignerPolicy, serviceToken: string,
  sign: (request: SigningRequest) => Promise<Hex>, logger = false) {
  policyCheck(policy);
  if (serviceToken.length < 32 || !/^[A-Za-z0-9_-]+$/.test(serviceToken)) throw new Error('Use a strong signer service token');
  const app = Fastify({ logger,logController:new LogController({disableRequestLogging:true}),genReqId:()=>randomUUID(),bodyLimit:1024,
    ajv:{ customOptions:{ removeAdditional:false,coerceTypes:false } } });
  app.setErrorHandler((error,request,reply) => {
    if (error instanceof PaymentError) return reply.code(error.statusCode).send({ code:error.code });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode==='number' && error.statusCode<500) {
      return reply.code(error.statusCode).send({ code:'INVALID_SIGNING_REQUEST' });
    }
    request.log.error({ event:'gateway_signing_failed',errorType:error instanceof Error ? error.name : 'unknown' });
    return reply.code(503).send({ code:'SIGNER_UNAVAILABLE' });
  });
  const uuid = { type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
  app.post<{ Body:{ requestId:string; taskId:string } }>('/sign-gateway-request', {
    onRequest:async (request,reply) => {
      reply.header('cache-control','no-store');
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (!token || !timingSafeEqual(tokenDigest(token),tokenDigest(serviceToken))) throw new PaymentError(401,'SIGNER_UNAUTHORIZED');
    },
    schema:{ body:{ type:'object',additionalProperties:false,required:['requestId','taskId'],properties:{ requestId:uuid,taskId:uuid } } },
  }, async (request) => {
    const agentToken = request.headers['x-agent-token'];
    if (typeof agentToken!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(agentToken)) throw new PaymentError(403,'SIGNING_REQUEST_NOT_ALLOWED');
    const { requestId,taskId }=request.body;
    const credentials={ taskId,agentToken };
    const prepared=await transaction(pool,async (client) => {
      const approved=await approvedRequest(client,requestId,credentials,policy);
      const { rows:[saved] }=await client.query('SELECT * FROM gateway_signatures WHERE request_id=$1',[requestId]);
      if (saved && saved.authorization_hash!==approved.digest) throw new PaymentError(409,'SIGNING_TERMS_CHANGED');
      if (!saved) {
        await client.query('INSERT INTO gateway_signatures(request_id,authorization_hash) VALUES($1,$2)',[requestId,approved.digest]);
        await client.query('UPDATE gateway_demo_purchases SET signing_started_at=now() WHERE request_id=$1',[requestId]);
        await recordAudit(client,{ actor:'gateway-signer',action:'gateway.signing.started',entity:`gateway_purchase:${requestId}`,stateAfter:approved.digest });
      }
      return { ...approved,signature:saved?.signature as Hex | undefined };
    });
    if (prepared.signature) return { signature:prepared.signature,authorizationHash:prepared.digest };
    // The durable marker precedes all private-key use. If this call or response
    // fails, cleanup/recovery must retain the reservation for the SAME nonce.
    const signature=await sign(prepared.typedData);
    if ((await recoverGatewayPayer(prepared.typedData.message,signature,'arcTestnet')).toLowerCase()!==policy.payer.toLowerCase()) {
      throw new Error('Signer returned an unexpected address');
    }
    const result=await transaction(pool,async (client) => {
      const approved=await approvedRequest(client,requestId,credentials,policy);
      if (approved.digest!==prepared.digest) throw new PaymentError(409,'SIGNING_TERMS_CHANGED');
      const saved=await client.query(`UPDATE gateway_signatures SET signature=$2,issued_at=now()
        WHERE request_id=$1 AND signature IS NULL RETURNING signature`,[requestId,signature]);
      if (saved.rowCount) await recordAudit(client,{ actor:'gateway-signer',action:'gateway.signing.issued',
        entity:`gateway_purchase:${requestId}`,stateAfter:approved.digest });
      return saved.rows[0]?.signature ?? (await client.query('SELECT signature FROM gateway_signatures WHERE request_id=$1',[requestId])).rows[0].signature;
    });
    request.log.info({ event:'gateway_signature_issued',requestId,authorizationHash:prepared.digest });
    return { signature:result,authorizationHash:prepared.digest };
  });
  return app;
}
