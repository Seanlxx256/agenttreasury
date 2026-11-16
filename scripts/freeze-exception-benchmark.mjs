import { writeFile } from 'node:fs/promises';
import { benchmarkRoot, frozenFileHashes } from '../dist/src/evaluate-gateway-exceptions.js';

// Exclusive creation: a measured dataset/protocol must not be silently refrozen.
const manifest={version:1,dataset:'evidence-exceptions-v2',cases:36,frozenAt:new Date().toISOString(),
  provenance:{source:'project-authored synthetic stress cases',annotation:'single-author; no independent human adjudication',
    relation:'new strings disjoint from existing development and test texts',
    scope:'Current asserted failures only; negated, resolved, hypothetical and instructional text is not an active failure.',
    unknownError:'abstention, not a concrete diagnosis',productionClaims:false},files:await frozenFileHashes()};
await writeFile(new URL('manifest.json',benchmarkRoot),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log('Created immutable benchmark manifest. Future changes require a new version.');
