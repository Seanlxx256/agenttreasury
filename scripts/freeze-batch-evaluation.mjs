import { writeFile } from 'node:fs/promises';
import { batchProtocolFiles, protocolRoot } from '../dist/src/evaluate-batch-investigation.js';
const names=['qwen2.5:1.5b','qwen2.5:3b'];
const response=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(5000),redirect:'error'});
if(!response.ok)throw new Error('Model metadata unavailable');
const tags=await response.json();
const models=names.map((name)=>{
  const model=tags.models.find((row)=>row.name===name);
  if(!model?.digest)throw new Error('Required installed model is missing');
  return {name,digest:model.digest,size:model.size,details:model.details};
});
const version=await fetch('http://127.0.0.1:11434/api/version',{signal:AbortSignal.timeout(5000),redirect:'error'});
if(!version.ok)throw new Error('Ollama version unavailable');
const manifest={version:1,frozenAt:new Date().toISOString(),node:process.version,ollama:await version.json(),models,files:await batchProtocolFiles()};
await writeFile(new URL('manifest.json',protocolRoot),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log('Frozen protocol, sources, compiled dependency closure, lockfile and model identities before model evaluation.');
