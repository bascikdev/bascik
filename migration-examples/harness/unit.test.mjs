import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateManifest, verifyArchive } from './fetch-source.mjs';
import { expandCommand } from './runner.mjs';

test('command tokens expand per site without a shell', () => {
  assert.deepEqual(expandCommand(['x', '--port', '{PORT}', '--host={HOST}'], 4321), ['x', '--port', '4321', '--host=127.0.0.1']);
  assert.deepEqual(expandCommand(['plain'], 1), ['plain']);
});

test('approved manifests use immutable safe pins', async () => {
  for (const id of ['astro-blog', 'eleventy-base-blog', 'react-thinking-in-react']) {
    const manifest = JSON.parse(await readFile(new URL(`../sources/${id}.json`, import.meta.url)));
    assert.equal(validateManifest(manifest).id, id);
    assert.throws(() => validateManifest({ ...manifest, subdirectory: '../escape' }), /Unsafe/);
    assert.throws(() => validateManifest({ ...manifest, commit: 'main' }), /Invalid/);
  }
});

test('a manifest for a non-MIT license must list marker text', async () => {
  const manifest = JSON.parse(await readFile(new URL('../sources/react-thinking-in-react.json', import.meta.url)));
  assert.equal(validateManifest(manifest).license, 'CC-BY-4.0');
  assert.throws(() => validateManifest({ ...manifest, licenseMarkers: [] }), /license markers/);
  assert.throws(() => validateManifest({ ...manifest, licenseMarkers: [''] }), /license markers/);
  assert.throws(() => validateManifest({ ...manifest, licenseMarkers: 'MIT' }), /license markers/);
});

test('checksum oracle accepts exact bytes and rejects changed bytes', () => {
  const bytes = Buffer.from('pinned source');
  const hash = createHash('sha256').update(bytes).digest('hex');
  verifyArchive(bytes, hash);
  assert.throws(() => verifyArchive(Buffer.from('changed source'), hash), /SHA-256 mismatch/);
});