// Task 09: run the pinned WordPress release (SRC-WP-CORE) locally with WordPress Playground.
// WordPress is booted from the official release zip, verified against its pinned SHA-256 and
// extracted into a temporary directory, never downloaded by Playground. The seed Blueprint adds
// original sample content and writes `seed.json` plus a WordPress-generated WXR export.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, unusedPort } from './runner.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
export const SHELL = here('./wordpress-shell/');
export const SEED = here('../sources/wordpress-seed/');
const MANIFEST = here('../sources/wordpress-core.json');
const CACHE = here('../.upstream/wordpress-core/');

export async function manifest() {
  return JSON.parse(await readFile(MANIFEST, 'utf8'));
}

async function run(command, cwd, env, timeoutMs) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
  return handle.output();
}

/** Install the Playground shell from its committed lockfile, without lifecycle scripts. */
export async function installShell(env = process.env) {
  try {
    await access(join(SHELL, 'node_modules/@wp-playground/cli/package.json'));
    return;
  } catch { /* install below */ }
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], SHELL, env, 300000);
}

/** The release zip, fetched once into the gitignored cache and verified on every use. */
export async function releaseZip() {
  const pin = await manifest();
  const zip = join(CACHE, pin.archive);
  let bytes;
  try {
    bytes = await readFile(zip);
  } catch {
    const response = await fetch(pin.archiveUrl, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${pin.archiveUrl}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(CACHE, { recursive: true });
    await writeFile(zip, bytes);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== pin.archiveSha256) throw new Error(`WordPress archive SHA-256 mismatch: ${actual}`);
  return zip;
}

/**
 * Start a seeded WordPress. Returns `{ url, seed, exportXml, directory, stop }`. The site,
 * its database, and its uploads live in a fresh temporary directory removed by `stop()`.
 */
export async function startWordPress({ env = process.env, timeoutMs = 300000 } = {}) {
  await installShell(env);
  const zip = await releaseZip();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bascik-wordpress-')));
  const site = join(directory, 'site');
  const out = join(directory, 'out');
  await mkdir(out);
  await run(['unzip', '-q', zip, '-d', directory], directory, env, 120000);
  await run(['mv', join(directory, 'wordpress'), site], directory, env, 10000);
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const server = launch([
    process.execPath, join(SHELL, 'node_modules/@wp-playground/cli/wp-playground.js'), 'server',
    '--php=8.3', `--port=${port}`, `--site-url=${url}`, '--workers=2',
    `--mount-before-install=${site}:/wordpress`, '--wordpress-install-mode=install-from-existing-files',
    `--mount=${SEED}:/seed`, `--mount=${out}:/out`,
    `--blueprint=${join(SEED, 'blueprint.json')}`, '--blueprint-may-read-adjacent-files',
    '--define-bool', 'WP_DEBUG', 'false',
    '--define', 'WP_ENVIRONMENT_TYPE', 'local',
  ], directory, env);
  const stop = async () => {
    try { await server.stop(); } finally { await rm(directory, { recursive: true, force: true }); }
  };
  try {
    const deadline = Date.now() + timeoutMs;
    for (; ;) {
      server.assertAlive();
      if (/Ready! WordPress is running/.test(server.output())) break;
      if (Date.now() > deadline) throw new Error(`WordPress did not start:\n${server.output()}`);
      await new Promise((accept) => setTimeout(accept, 200));
    }
    const seed = JSON.parse(await readFile(join(out, 'seed.json'), 'utf8'));
    const exportXml = await readFile(join(out, 'export.xml'), 'utf8');
    return { url, port, seed, exportXml, directory, server, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Authenticated REST request using the seeded application password (loopback only). */
export async function wpRequest(wordpress, path, { method = 'GET', body } = {}) {
  const auth = Buffer.from(`${wordpress.seed.user}:${wordpress.seed.applicationPassword}`).toString('base64');
  const response = await fetch(`${wordpress.url}/wp-json${path}`, {
    method,
    headers: { authorization: `Basic ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
