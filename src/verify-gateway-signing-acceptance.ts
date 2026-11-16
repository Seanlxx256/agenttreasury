import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hashTypedData } from 'viem';
import { evidenceDigest } from './gateway-balance-evidence.js';
import { verifyProjectBatchEvidence } from './gateway-project-batch-evidence.js';
import { gatewayAuthorizationTypes, gatewayNetworkConfig } from './gateway-x402.js';
import type { collectSigningAcceptance } from './gateway-signing-acceptance.js';

type Archive={version:number;scope:string;capturedAt:string;digest:string;
  signing:Awaited<ReturnType<typeof collectSigningAcceptance>>;
  batch:Parameters<typeof verifyProjectBatchEvidence>[0];
  execution:{buyerExecutable:string;separateSigner:boolean;maxAmountUnits:string;merchant:string}};

export function verifyModernSigningAcceptance(saved:Archive) {
  const {digest,...payload}=saved;
  if(saved.version!==1||saved.scope!=='modern-signing-testnet-acceptance'||evidenceDigest(payload)!==digest)
    throw new Error('Signing acceptance envelope is invalid');
  const s=saved.signing;
  const auth=s.authorization;
  if(s.network!=='arcTestnet'||s.amountUnits!=='1000'||!auth||!s.signingVerified||!s.signatureMatches||
    !s.digestMatches||!s.termsMatch||s.signatureRows!==1||s.journalRows!==1||s.budget.limit!=='1000'||
    s.budget.spent!=='1000'||s.budget.reserved!=='0'||s.budget.status!=='spent'||
    !s.delivery.buyer||!s.delivery.seller||s.delivery.commitmentSatisfied!==true||
    saved.execution.maxAmountUnits!=='1000'||!saved.execution.separateSigner||
    saved.execution.buyerExecutable!=='buy-gateway-trace.js')throw new Error('Signing acceptance requirements are incomplete');
  const hash=hashTypedData({domain:gatewayNetworkConfig('arcTestnet').domain,types:gatewayAuthorizationTypes,
    primaryType:'TransferWithAuthorization',message:{...auth,value:BigInt(auth.value),
      validAfter:BigInt(auth.validAfter),validBefore:BigInt(auth.validBefore)}});
  if(hash!==s.authorizationHash)throw new Error('Authorization digest differs');
  const started=Date.parse(String(s.signingStartedAt)),issued=Date.parse(String(s.signatureIssuedAt)),submitted=Date.parse(String(s.submittedAt));
  if(![started,issued,submitted].every(Number.isFinite)||started>issued||issued>submitted||
    BigInt(auth.validAfter)>BigInt(Math.floor(issued/1000))||BigInt(auth.validBefore)<=BigInt(Math.floor(issued/1000)))
    throw new Error('Signing timeline or validity interval is inconsistent');
  const p=saved.batch.purchase;
  if(s.requestId!==p.id||auth.nonce!==p.nonce||auth.from.toLowerCase()!==p.payer.toLowerCase()||
    auth.to.toLowerCase()!==p.recipient.toLowerCase()||auth.value!==p.amountUnits)
    throw new Error('Authorization is not bound to the captured purchase');
  const batch=verifyProjectBatchEvidence(saved.batch);
  if(batch.report.status!=='MATCHED'||batch.linkage[0]?.status!=='corroborated')throw new Error('Batch acceptance incomplete');
  return {verified:true,requestId:s.requestId,authorizationHash:hash,amountUnits:s.amountUnits,
    batchHash:batch.linkage[0].batchHash,linkage:'corroborated',
    limitation:'Offline verification checks report integrity, authorization hash and batch linkage. Signature recovery is a recorded local check; no bearer signature or nonce inclusion proof is exported.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [file,...extra]=process.argv.slice(2);
  if(!file||extra.length)throw new Error('Usage: verify:gateway-signing -- <acceptance-file>');
  console.log(JSON.stringify(verifyModernSigningAcceptance(JSON.parse(await readFile(file,'utf8'))),null,2));
}
