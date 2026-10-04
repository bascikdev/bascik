import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, copyFile, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch, runPair } from './runner.mjs';
import { port, upstream, SITE_ORIGIN, TZ } from './nextjs-blog-expected.mjs';
import * as shared from './nextjs-blog-checks.mjs';

// Task 09: behavior checks for the Next.js blog-starter example (SRC-NEXT-BLOG-STARTER @ba80ee4)
// and its Bascik port. Lanes: production (`next build` + `next start` against `bascik --build` +
// `bascik --server`), development (`next dev` against the Bascik dev server), and a control that
// proves the shared checks reject a site that is not this blog. Both sides run in isolated copies
// outside the repository. BASCIK_TARBALL installs a locally packed Bascik into the port copy.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const upstreamSource = fileURLToPath(new URL('../.upstream/nextjs-blog-starter/examples/blog-starter/', import.meta.url));
const portSource = fileURLToPath(new URL('../ports/nextjs-blog/', import.meta.url));
const lockfile = fileURLToPath(new URL('../sources/nextjs-blog-starter.package-lock.json', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const only = process.env.NEXT_LANE;
const BASCIK_BIN = 'node_modules/@bascik/bascik/bin/bascik.js';
const NEXT_BIN = 'node_modules/next/dist/bin/next';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function run(command, cwd, env, timeoutMs) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

// Upstream dependencies come from the retained lockfile with lifecycle scripts disabled. Only
// fsevents (optional, macOS) declares an install script, and Next.js does not need it.
async function prepareUpstream(site) {
  await copyFile(lockfile, join(site.cwd, 'package-lock.json'));
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 180000);
}

async function preparePort(site, notes) {
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 180000);
  if (tarball) {
    await access(tarball);
    await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], site.cwd, site.env, 180000);
  }
  const packageDirectory = await realpath(join(site.cwd, 'node_modules/@bascik/bascik'));
  assert.ok(packageDirectory.startsWith(site.cwd + '/'), 'Bascik must resolve inside the isolated copy');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  notes.push(`${tarball ? `local tarball ${tarball}` : 'registry release'}; @bascik/bascik ${manifest.version}`);
}

// The Bascik dev server answers 200 "Building site..." for every page until the first transpile
// finishes, so readiness is a real 404 for a path that cannot exist.
async function waitForFirstBuild(site, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(site.url + '/no/such/page');
    const text = await response.text();
    if (response.status === 404 && !text.includes('Building site')) return;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`${label}: the dev server never finished its first build`);
}

// `next dev` compiles each route on its first request. Warm every route once so the checks do
// not measure compile time against their timeouts.
async function warm(site, expected, label) {
  for (const path of [...shared.routesOf(expected), '/no-such-page']) {
    try {
      await (await fetch(site.url + path)).arrayBuffer();
    } catch (error) {
      throw new Error(`${label}: warming ${path} failed`, { cause: error });
    }
  }
}

async function runChecks({ site, expected, label, includePort = false, dev = false }) {
  const steps = [
    ['routes', () => shared.checkRoutes(site, expected, label)],
    ['metadata', () => shared.checkMetadata(browser, site, expected, label)],
    ['home', () => shared.checkHome(browser, site, expected, label)],
    ['posts', () => shared.checkPosts(browser, site, expected, label)],
    ['layout', () => shared.checkLayout(browser, site, expected, label)],
    ['theme switch', () => shared.checkThemeSwitch(browser, site, expected, label)],
    ...(includePort ? [['port only', () => shared.checkPortOnly(browser, site, expected, label, { dev })]] : []),
  ];
  for (const [step, check] of steps) {
    try {
      await check();
    } catch (error) {
      // A network error from fetch has no stack frame in the checks; name the step.
      if (error instanceof TypeError && error.message === 'fetch failed') {
        throw new Error(`${label}: ${step} check could not reach the server`, { cause: error });
      }
      throw error;
    }
  }
}

function lane(name, { dev = false } = {}) {
  const skip = only && only !== name ? `NEXT_LANE=${only}` : false;
  test(`nextjs blog: ${name} lane`, { skip, timeout: 900000 }, async () => {
    const notes = [];
    const observed = [];
    const common = { TZ, NEXT_TELEMETRY_DISABLED: '1' };
    await runPair({
      upstream: {
        source: upstreamSource,
        env: common,
        ...(dev
          ? { serve: [process.execPath, NEXT_BIN, 'dev', '--turbopack', '-H', '127.0.0.1', '-p', '{PORT}'] }
          : {
            build: [process.execPath, NEXT_BIN, 'build'],
            serve: [process.execPath, NEXT_BIN, 'start', '-H', '127.0.0.1', '-p', '{PORT}'],
          }),
      },
      bascik: {
        source: portSource,
        env: { ...common, BASCIK_SITE_URL: SITE_ORIGIN },
        ...(dev
          ? { serve: [process.execPath, BASCIK_BIN, '--port', '{PORT}', '--host', '127.0.0.1'] }
          : {
            build: [process.execPath, BASCIK_BIN, '--build'],
            serve: [process.execPath, BASCIK_BIN, '--server', '--port', '{PORT}', '--host', '127.0.0.1'],
          }),
      },
      timeoutMs: 900000,
      observe: (site) => observed.push(site),
      prepare: async (siteName, site) => {
        assertOutsideRepository(site.cwd, repository);
        if (siteName === 'upstream') await prepareUpstream(site);
        else await preparePort(site, notes);
      },
      check: async (sites) => {
        if (dev) {
          await warm(sites.upstream, upstream, `upstream/${name}`);
          await waitForFirstBuild(sites.bascik, `port/${name}`);
        }
        await runChecks({ site: sites.upstream, expected: upstream, label: `upstream/${name}` });
        if (!dev) notes.push(`upstream framework JavaScript ${await shared.checkUpstreamOnly(sites.upstream, upstream, `upstream/${name}`)} bytes`);
        await runChecks({ site: sites.bascik, expected: port, label: `port/${name}`, includePort: true, dev });
        if (!dev) {
          for (const file of ['index.html', 'posts/hello-world.html', '404.html', 'feed.xml', 'sitemap.xml', 'assets/styles.css', 'assets/fonts/OFL.txt']) {
            await access(join(sites.bascik.cwd, 'dist', file));
          }
        }
      },
    });
    console.log(`nextjs blog ${name}: ${notes.join('; ')}`);
    for (const site of observed) {
      await assert.rejects(access(site.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
    }
  });
}

lane('production');
lane('dev', { dev: true });

// Control: the shared checks must reject a site that is not this blog. Uses the dependency-free
// task 02 fixture for both sides, so no framework install is involved.
test('nextjs blog: shared checks reject a non-blog site', { skip: only && only !== 'control' }, async () => {
  const fixture = fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url));
  const spec = { source: fixture, build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'] };
  await assert.rejects(runPair({
    upstream: spec, bascik: spec, timeoutMs: 60000,
    check: async (sites) => { await runChecks({ site: sites.bascik, expected: port, label: 'control' }); },
  }), /control: \/posts\/dynamic-routing status/);
});
