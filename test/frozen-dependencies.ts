import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url);
const archived = new URL('docs/evidence/pre-redis-package-lock.json', root);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// Preserve historical source/compiled hashes AND the exact original dependency
// graph. Only the explicit Redis dependency addition is allowed in current CI.
export async function assertFrozenSources(current: Record<string, string>, frozen: Record<string, string>) {
  const oldBytes = await readFile(archived);
  assert.equal(digest(oldBytes), frozen['package-lock.json']);
  assert.deepEqual({ ...current, 'package-lock.json': digest(oldBytes) }, frozen);
  const old = JSON.parse(oldBytes.toString());
  const live = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  for (const [path, metadata] of Object.entries(old.packages)) {
    // npm reclassifies peer-install bookkeeping on an additive install; this
    // flag does not change package content, versions, integrity or dependency edges.
    if (path) {
      const { peer: _oldPeer, ...previous } = metadata as Record<string, unknown>;
      const { peer: _newPeer, ...currentPackage } = live.packages[path];
      assert.deepEqual(currentPackage, previous, `Frozen dependency changed: ${path}`);
    }
  }
  const { redis, ...dependencies } = live.packages[''].dependencies;
  assert.equal(redis, '^5.12.4');
  assert.deepEqual({ ...live.packages[''], dependencies }, old.packages['']);
  assert.deepEqual(Object.keys(live.packages).filter((path) => !(path in old.packages)).sort(), [
    'node_modules/@redis/bloom', 'node_modules/@redis/client', 'node_modules/@redis/json',
    'node_modules/@redis/search', 'node_modules/@redis/time-series', 'node_modules/cluster-key-slot', 'node_modules/redis',
  ]);
}

// Run historical entrypoints against their archived lock, without changing the
// working tree or disabling the entrypoints' strict drift detection.
export async function withFrozenDependencies<T>(run: (root: URL) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ag-frozen-'));
  const target = pathToFileURL(directory + '/');
  try {
    for (const path of ['src', 'dist/src', 'benchmarks', 'scripts']) {
      await cp(new URL(path, root), new URL(path, target), { recursive: true });
    }
    await writeFile(new URL('package.json', target), '{"type":"module"}');
    await cp(archived, new URL('package-lock.json', target));
    await symlink(fileURLToPath(new URL('node_modules', root)), join(directory, 'node_modules'), 'dir');
    return await run(target);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
