import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../benchmarks/batch-investigation-review-v1/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
const text=await readFile(new URL('inputs.json',root),'utf8');
if(createHash('sha256').update(text).digest('hex')!==manifest.files['inputs.json'])throw new Error('Review input hash changed');
console.log(JSON.stringify({version:1,status:'unreviewed',
  instructions:'These inputs include captured and synthetically altered scenarios; do not assume every supplied field is truthful. Assess corroborated/incomplete/conflict, required read-only checks and supporting JSON pointer paths. Never infer per-nonce inclusion from a net wallet delta or authorize funds movement.',
  cases:JSON.parse(text).map(({id,input})=>({id,input,review:{status:null,requiredChecks:[],evidencePaths:[],notes:''}}))},null,2));
