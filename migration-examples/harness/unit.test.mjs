import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateManifest, verifyArchive } from './fetch-source.mjs';

test('approved manifests use immutable safe pins', async () => {
  for (const id of ['astro-blog', 'eleventy-base-blog']) {
    const manifest = JSON.parse(await readFile(new URL(`../sources/${id}.json`, import.meta.url)));
    assert.equal(validateManifest(manifest).id, id);
    assert.throws(() => validateManifest({ ...manifest, subdirectory: '../escape' }), /Unsafe/);
    assert.throws(() => validateManifest({ ...manifest, commit: 'main' }), /Invalid/);
  }
});

test('checksum oracle accepts exact bytes and rejects changed bytes', () => {
  const bytes = Buffer.from('pinned source');
  const hash = createHash('sha256').update(bytes).digest('hex');
  verifyArchive(bytes, hash);
  assert.throws(() => verifyArchive(Buffer.from('changed source'), hash), /SHA-256 mismatch/);
});