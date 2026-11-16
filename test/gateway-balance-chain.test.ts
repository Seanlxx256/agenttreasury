import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiItem, parseAbiParameters,
  type Address, type Hash } from 'viem';
import { gatewayBalanceChain } from '../src/gateway-balance-chain.js';
import { gatewayClient, gatewayNetworkConfig } from '../src/gateway-x402.js';
import { verifyBalanceEvidence } from '../src/gateway-balance-evidence.js';

const config=gatewayNetworkConfig('arcTestnet');
const hash=`0x${'1'.repeat(64)}` as Hash;
const wallet=`0x${'a'.repeat(40)}` as Address;
const other=`0x${'b'.repeat(40)}` as Address;

test('checksummed SDK contract addresses accept valid direct batches; conflicting duplicates fail', async () => {
  const callData=encodeAbiParameters(parseAbiParameters('(address depositor,int256 value)[] deltas,bytes32 batchId,uint32 domain,address token,address wallet'),
    [[{depositor:wallet,value:-100n},{depositor:other,value:100n}],hash,config.domainId,config.usdc,config.domain.verifyingContract]);
  const input=encodeFunctionData({abi:parseAbi(['function submitBatch(bytes calldataBytes,bytes signature)']),
    functionName:'submitBatch',args:[callData,'0x']});
  let conflict=false;
  const log={transactionHash:hash,blockHash:hash,blockNumber:50n,logIndex:0,address:config.domain.verifyingContract,
    topics:[hash],data:'0x',args:{batchId:hash,tokenAddress:config.usdc}};
  const client={getChainId:async()=>config.chainConfig.id,
    getLogs:async(params:{event:{name:string}})=>params.event.name==='BatchProcessed' ? [log,{...log,data:conflict?'0x01':'0x'}] : [],
    getTransaction:async()=>({to:config.domain.verifyingContract,blockHash:hash,input}),
  } as unknown as ReturnType<typeof gatewayClient>;
  const chain=await gatewayBalanceChain('arcTestnet',client);
  const result=await chain.movements(wallet,50n,50n);
  assert.equal(result.batches.length,1);
  assert.equal(result.batches[0]!.delta,-100n);
  assert.equal(result.batches[0]!.evidence!.transactionInput,input);
  conflict=true;
  await assert.rejects(chain.movements(wallet,50n,50n),/Conflicting duplicate RPC log/);
});

test('archived public deposit decodes to the saved payer and amount and replays offline', async () => {
  const sample=JSON.parse(await readFile(new URL('../../docs/evidence/stage-5-live-balance.json',import.meta.url),'utf8'));
  const event=parseAbiItem('event Deposited(address indexed token,address indexed depositor,address indexed sender,uint256 value)');
  for(const movement of sample.snapshot.movements.deposits) {
    const decoded=decodeEventLog({abi:[event],topics:movement.evidence.topics,data:movement.evidence.data});
    assert.equal(decoded.args.depositor.toLowerCase(),sample.snapshot.payer);
    assert.equal(decoded.args.token.toLowerCase(),config.usdc.toLowerCase());
    assert.equal(String(decoded.args.value),movement.amount);
  }
  const result=verifyBalanceEvidence('public-sample',sample);
  assert.equal(result.verified,true);
  assert.equal(result.report.balance.chainDifference,'0');
  const altered=structuredClone(sample);altered.snapshot.movements.deposits[0].amount='0';
  assert.throws(()=>verifyBalanceEvidence('public-sample',altered),/digest mismatch/);
});
