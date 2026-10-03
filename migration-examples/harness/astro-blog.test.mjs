import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, copyFile, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch, runPair } from './runner.mjs';
import { port, upstream, SITE_ORIGIN } from './astro-blog-expected.mjs';
import * as shared from './astro-blog-checks.mjs';

// Task 03: behavior checks for the pinned Astro blog (SRC-ASTRO-BLOG @4c1470a) and its Bascik
// port. Lanes: production HTTP/1.1 with the released package, production with a locally packed
// source tarball (BASCIK_TARBALL), and the development server. Browser tooling is reused from the
// monorepo; application dependencies are installed only inside the two isolated copies.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const upstreamSource = fileURLToPath(new URL('../.upstream/astro-blog/examples/blog/', import.meta.url));
const portSource = fileURLToPath(new URL('../ports/astro-blog/', import.meta.url));
const lockfile = fileURLToPath(new URL('../sources/astro-blog.package-lock.json', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const only = process.env.ASTRO_LANE;
const BASCIK_BIN = 'node_modules/@bascik/bascik/bin/bascik.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function run(command, cwd, env, timeoutMs) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

// Upstream dependencies are reproduced from the retained lockfile with lifecycle scripts
// disabled. Only esbuild's reviewed postinstall is run afterwards, as the install policy states.
async function prepareUpstream(site) {
  await copyFile(lockfile, join(site.cwd, 'package-lock.json'));
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 120000);
  await run(['npm', 'rebuild', 'esbuild'], site.cwd, site.env, 60000);
}

async function preparePort(site, notes, useTarball) {
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 120000);
  if (useTarball) {
    await access(tarball);
    await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], site.cwd, site.env, 120000);
  }
  const packageDirectory = await realpath(join(site.cwd, 'node_modules/@bascik/bascik'));
  assert.ok(packageDirectory.startsWith(site.cwd + '/'), 'Bascik must resolve inside the isolated copy');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  notes.push(`${useTarball ? `local tarball ${tarball}` : 'registry release'}; @bascik/bascik ${manifest.version}`);
}

async function runChecks({ site, expected, label, dev = false, includePort = false }) {
  await shared.checkRoutesAndErrors(site, expected, label);
  await shared.checkMetadata(browser, site, expected, label, { dev });
  await shared.checkBlogIndex(browser, site, expected, label);
  await shared.checkNavigation(browser, site, expected, label);
  await shared.checkChrome(browser, site, expected, label);
  await shared.checkPosts(browser, site, expected, label);
  await shared.checkMarkdownFeatures(browser, site, expected, label);
  await shared.checkEmbeddedComponent(browser, site, expected, label);
  await shared.checkMobileAndKeyboard(browser, site, expected, label);
  await shared.checkFonts(browser, site, label);
  await shared.checkFeedAndSitemap(site, expected, label, { dev });
  await shared.checkScriptWeight(site, expected, label, { dev });
  if (includePort) await shared.checkPortOnly(browser, site, expected, label, { dev });
}

function lane(name, { dev = false, useTarball = false } = {}) {
  const skip = (only && only !== name) ? `ASTRO_LANE=${only}` : (useTarball && !tarball ? 'set BASCIK_TARBALL' : false);
  test(`astro blog: ${name} lane`, { skip, timeout: 600000 }, async () => {
    const notes = [];
    const observed = [];
    const common = { env: { BASCIK_SITE_URL: SITE_ORIGIN } };
    await runPair({
      upstream: {
        source: upstreamSource,
        build: [process.execPath, 'node_modules/astro/bin/astro.mjs', 'build'],
        serve: [process.execPath, 'node_modules/astro/bin/astro.mjs', 'preview', '--ignore-lock', '--host', '127.0.0.1', '--port', '{PORT}'],
      },
      bascik: {
        source: portSource,
        ...common,
        ...(dev
          ? { serve: [process.execPath, BASCIK_BIN, '--port', '{PORT}', '--host', '127.0.0.1'] }
          : {
            build: [process.execPath, BASCIK_BIN, '--build'],
            serve: [process.execPath, BASCIK_BIN, '--server', '--port', '{PORT}', '--host', '127.0.0.1'],
          }),
      },
      timeoutMs: 600000,
      observe: (site) => observed.push(site),
      prepare: async (name, site) => {
        assertOutsideRepository(site.cwd, repository);
        if (name === 'upstream') await prepareUpstream(site);
        else await preparePort(site, notes, useTarball);
      },
      check: async (sites) => {
        await runChecks({ site: sites.upstream, expected: upstream, label: `upstream/${name}` });
        await runChecks({ site: sites.bascik, expected: port, label: `port/${name}`, dev, includePort: true });
        if (!dev) {
          const files = await Promise.all(['index.html', 'rss.xml', 'sitemap.xml', 'assets/fonts/OFL.txt']
            .map((file) => access(join(sites.bascik.cwd, 'dist', file))));
          assert.equal(files.length, 4, 'port output files exist');
        }
      },
    });
    console.log(`astro blog ${name}: ${notes.join('; ')}`);
    for (const site of observed) {
      await assert.rejects(access(site.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
    }
  });
}

lane('production');
lane('local', { useTarball: true });
lane('dev', { dev: true });

// Control: the shared checks must reject a site that is not the blog. Uses the dependency-free
// original fixture from task 02 for both sides, so no Bascik install is involved.
test('astro blog: shared checks reject a non-blog site', { skip: only && only !== 'control' }, async () => {
  const fixture = fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url));
  const spec = { source: fixture, build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'] };
  await assert.rejects(runPair({
    upstream: spec, bascik: spec, timeoutMs: 60000,
    check: async (sites) => { await runChecks({ site: sites.bascik, expected: port, label: 'control' }); },
  }), /control: \/blog\/ status/);
});
