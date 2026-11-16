import type { Pool } from 'pg';
import { hashTypedData, type Hex } from 'viem';
import { gatewayAuthorizationTypes, gatewayNetworkConfig, recoverGatewayPayer, type GatewayAuthorization } from './gateway-x402.js';

// Read signatures locally for verification, but never return bearer signatures.
export async function collectSigningAcceptance(pool: Pool, requestId: string) {
  const {rows:[row]}=await pool.query(`SELECT p.request_id AS id,p.network,p.payer,p.recipient,p.nonce,
    p.amount_units::text AS amount,p.signing_authorization AS authorization,p.signing_started_at AS "signingStartedAt",
    p.submitted_at AS "submittedAt",p.budget_status AS "budgetStatus",p.delivery IS NOT NULL AS "buyerDelivered",
    EXISTS(SELECT 1 FROM gateway_demo_deliveries d WHERE d.request_id=p.request_id AND d.nonce=p.nonce) AS "sellerDelivered",
    p.commitment_satisfied AS "commitmentSatisfied",s.authorization_hash AS "authorizationHash",s.signature,
    s.issued_at AS "signatureIssuedAt",t.budget::text,t.reserved::text,t.spent::text,
    (SELECT count(*)::int FROM gateway_signatures WHERE request_id=p.request_id) AS "signatureRows",
    (SELECT count(*)::int FROM gateway_payment_journal WHERE request_id=p.request_id) AS "journalRows"
    FROM gateway_demo_purchases p JOIN research_tasks t ON t.id=p.task_id
    LEFT JOIN gateway_signatures s ON s.request_id=p.request_id WHERE p.request_id=$1`,[requestId]);
  if(!row)throw new Error('Acceptance purchase not found');
  const auth=row.authorization as GatewayAuthorization|null;
  let digestMatches=false,signatureMatches=false;
  if(row.network==='arcTestnet' && auth && row.signature) {
    try {
      const digest=hashTypedData({domain:gatewayNetworkConfig('arcTestnet').domain,types:gatewayAuthorizationTypes,
        primaryType:'TransferWithAuthorization',message:{...auth,value:BigInt(auth.value),
          validAfter:BigInt(auth.validAfter),validBefore:BigInt(auth.validBefore)}});
      digestMatches=digest===row.authorizationHash;
      signatureMatches=(await recoverGatewayPayer(auth,row.signature as Hex,'arcTestnet')).toLowerCase()===row.payer;
    } catch { /* Malformed/missing evidence remains false. */ }
  }
  const termsMatch=!!auth && typeof auth.from==='string' && typeof auth.to==='string' &&
    auth.from.toLowerCase()===row.payer && auth.to.toLowerCase()===row.recipient &&
    auth.nonce===row.nonce && auth.value===row.amount;
  const signingVerified=row.network==='arcTestnet' && termsMatch && digestMatches && signatureMatches &&
    !!row.signingStartedAt && !!row.signatureIssuedAt && row.signatureRows===1;
  return {version:1,requestId,network:row.network,amountUnits:row.amount,authorization:auth?{from:auth.from,to:auth.to,value:auth.value,nonce:auth.nonce,
      validAfter:auth.validAfter,validBefore:auth.validBefore}:null,
    authorizationHash:row.authorizationHash,termsMatch,digestMatches,signatureMatches,signingVerified,
    signingStartedAt:row.signingStartedAt,signatureIssuedAt:row.signatureIssuedAt,submittedAt:row.submittedAt,
    signatureRows:row.signatureRows,journalRows:row.journalRows,
    budget:{limit:row.budget,reserved:row.reserved,spent:row.spent,status:row.budgetStatus},
    delivery:{buyer:row.buyerDelivered,seller:row.sellerDelivered,commitmentSatisfied:row.commitmentSatisfied},
    limitation:'Signature verification ran locally against the stored authorization. Bearer signatures are intentionally omitted; this report is not a public signature or batch inclusion proof.'};
}
