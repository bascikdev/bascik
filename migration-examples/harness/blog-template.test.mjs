import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch, runPair } from './runner.mjs';
import { ORIGIN, assertNoDraft, checkSite, waitForFirstBuild } from './blog-template-checks.mjs';

// Task 06: the independent blog starter, templates/blog. Only the distributable folder is copied
// into a temporary directory outside the repository, installed with `npm ci` plus the local Bascik
// tarball, built, served, and checked in a real browser. The repository's node_modules and sibling
// folders are never reachable from the copy.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const templateSource = fileURLToPath(new URL('../../templates/blog/', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const BIN = 'node_modules/@bascik/bascik/bin/bascik.js';
const only = process.env.BLOG_LANE;

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function run(command, cwd, env, timeoutMs = 240000) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

async function prepare(site) {
  assertOutsideRepository(site.cwd, repository);
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env);
  if (tarball) {
    await access(tarball);
    await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], site.cwd, site.env);
  }
  const packageDirectory = await realpath(join(site.cwd, 'node_modules/@bascik/bascik'));
  assert.ok(packageDirectory.startsWith(site.cwd + '/'), 'Bascik must resolve inside the isolated copy');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  console.log(`blog template: ${tarball ? `local tarball ${tarball}` : 'registry release'}; @bascik/bascik ${manifest.version}`);
}

function lane(name, { dev = false } = {}) {
  const skip = only && only !== name ? `BLOG_LANE=${only}` : false;
  test(`blog template: ${name} lane`, { skip, timeout: 900000 }, async () => {
    const observed = [];
    const spec = {
      source: templateSource,
      env: { BASCIK_SITE_URL: ORIGIN },
      ...(dev
        ? { serve: [process.execPath, BIN, '--port', '{PORT}', '--host', '127.0.0.1'] }
        : {
          build: [process.execPath, BIN, '--build'],
          serve: [process.execPath, BIN, '--server', '--port', '{PORT}', '--host', '127.0.0.1'],
        }),
    };
    // The harness runner wants two sites; the second is a dependency-free page server that only
    // proves the control below.
    await runPair({
      upstream: {
        source: fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url)),
        build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'],
      },
      bascik: spec,
      timeoutMs: 900000,
      observe: (site) => observed.push(site),
      prepare: async (siteName, site) => { if (siteName === 'bascik') await prepare(site); },
      check: async (sites) => {
        if (dev) await waitForFirstBuild(sites.bascik, `template/${name}`);
        await checkSite(sites.bascik, `template/${name}`, { dev });
        if (!dev) {
          const files = await readdir(join(sites.bascik.cwd, 'dist'), { recursive: true });
          const text = await Promise.all(files
            .filter((file) => /\.(html|xml|txt)$/.test(file) && !file.startsWith('.bascik'))
            .map(async (file) => [file, await readFile(join(sites.bascik.cwd, 'dist', file), 'utf8')]));
          assertNoDraft(text, `template/${name}`);
          // Control: the shared checks must reject the same site when it is not the blog.
          await assert.rejects(checkSite(sites.upstream, 'control', { dev }), /control: \/ status|control: .*status/);
        }
      },
    });
    for (const site of observed) {
      await assert.rejects(access(site.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
    }
  });
}

lane('production');
lane('dev', { dev: true });
