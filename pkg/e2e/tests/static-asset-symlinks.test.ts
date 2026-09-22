import { test, expect } from '@playwright/test';
import { lstat, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const fixtureDir = join(import.meta.dirname, '..', 'symlink-fixture');
const sourceAsset = join(fixtureDir, 'src/pages/assets/logo.svg');
const outputAsset = join(fixtureDir, 'dist/assets/logo.svg');

test.describe('Development static-asset symlinks', () => {
  test.skip(process.platform === 'win32', 'Windows may fall back to copying when symlinks are not permitted.');

  test('links an unchanged asset, serves it, and reflects a source edit without relinking', async ({ request }) => {
    expect((await lstat(outputAsset)).isSymbolicLink()).toBe(true);
    expect(await readlink(outputAsset)).toBe(relative(join(fixtureDir, 'dist/assets'), sourceAsset));

    const original = await readFile(sourceAsset, 'utf8');
    const updated = original.replace('green', 'purple');
    try {
      await writeFile(sourceAsset, updated, 'utf8');
      await expect.poll(async () => (await request.get('/assets/logo.svg')).text()).toContain('purple');
      expect((await lstat(outputAsset)).isSymbolicLink()).toBe(true);
    } finally {
      await writeFile(sourceAsset, original, 'utf8');
    }
  });

  test('recovers HTTP delivery after the symlink target is recreated without restarting', async ({ request }) => {
    const original = await readFile(sourceAsset, 'utf8');

    try {
      expect((await request.get('/assets/logo.svg')).status()).toBe(200);
      await rm(sourceAsset);
      expect((await request.get('/assets/logo.svg')).status()).toBe(404);

      await writeFile(sourceAsset, original.replace('green', 'orange'), 'utf8');
      await expect.poll(async () => (await request.get('/assets/logo.svg')).text()).toContain('orange');
      expect((await lstat(outputAsset)).isSymbolicLink()).toBe(true);
    } finally {
      await writeFile(sourceAsset, original, 'utf8');
    }
  });
});