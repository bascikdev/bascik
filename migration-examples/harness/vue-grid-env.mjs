import assert from 'node:assert/strict';
import { access, copyFile, cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch } from './runner.mjs';

// Paths and setup steps shared by the Vue grid lane test and its mutation test.

export const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
export const shellSource = fileURLToPath(new URL('./vue-shell/', import.meta.url));
export const portSource = fileURLToPath(new URL('../ports/vue-grid/', import.meta.url));
const cache = fileURLToPath(new URL('../.upstream/vue-grid/src/examples/src/grid/', import.meta.url));
const lockfile = fileURLToPath(new URL('../sources/vue-grid.package-lock.json', import.meta.url));
export const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
export const BASCIK_BIN = 'node_modules/@bascik/bascik/bin/bascik.js';
export const VITE_BIN = 'node_modules/vite/bin/vite.js';

export async function run(command, cwd, env, timeoutMs = 240000) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

// Upstream files come from the gitignored cache (`npm --prefix migration-examples run fetch -- vue-grid`).
export async function prepareUpstream(site) {
  await access(cache).catch(() => { throw new Error('Run: npm --prefix migration-examples run fetch -- vue-grid'); });
  await mkdir(join(site.cwd, 'upstream'));
  await cp(join(cache, 'App'), join(site.cwd, 'upstream/App'), { recursive: true });
  await cp(join(cache, 'Grid'), join(site.cwd, 'upstream/Grid'), { recursive: true });
  await copyFile(lockfile, join(site.cwd, 'package-lock.json'));
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env);
  await run([process.execPath, 'compose.mjs'], site.cwd, site.env, 60000);
}

export async function preparePort(site, notes) {
  assertOutsideRepository(site.cwd, repository);
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env);
  if (tarball) {
    await access(tarball);
    await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], site.cwd, site.env);
  }
  const packageDirectory = await realpath(join(site.cwd, 'node_modules/@bascik/bascik'));
  assert.ok(packageDirectory.startsWith(site.cwd + '/'), 'Bascik must resolve inside the isolated copy');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  notes?.push(`${tarball ? `local tarball ${tarball}` : 'registry release'}; @bascik/bascik ${manifest.version}`);
}
