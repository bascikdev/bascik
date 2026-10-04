import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, copyFile, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch, runPair } from './runner.mjs';
import { port, upstream, SITE_ORIGIN } from './eleventy-blog-expected.mjs';
import * as shared from './eleventy-blog-checks.mjs';

// Task 04: behavior checks for the pinned Eleventy base blog (SRC-11TY-BASE-BLOG @94bd3b7) and its
// Bascik port. Lanes: production (Eleventy build + static server, `bascik --build` + `--server`)
// and development (`eleventy --serve`, `bascik`). Browser tooling is reused from the monorepo;
// application dependencies are installed only inside the two isolated copies.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const upstreamSource = fileURLToPath(new URL('../.upstream/eleventy-base-blog/', import.meta.url));
const portSource = fileURLToPath(new URL('../ports/eleventy-blog/', import.meta.url));
const staticServer = fileURLToPath(new URL('./static-site-server.mjs', import.meta.url));
const lockfile = fileURLToPath(new URL('../sources/eleventy-base-blog.package-lock.json', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const only = process.env.ELEVENTY_LANE;
const BASCIK_BIN = 'node_modules/@bascik/bascik/bin/bascik.js';
const ELEVENTY_BIN = 'node_modules/@11ty/eleventy/cmd.cjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function run(command, cwd, env, timeoutMs) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

// Upstream dependencies are reproduced from the retained lockfile with lifecycle scripts disabled.
// The lockfile review found one install script (`fsevents`, macOS file watching only), which the
// build does not need. `sharp` ships prebuilt binaries and has no install script.
async function prepareUpstream(site) {
  await copyFile(lockfile, join(site.cwd, 'package-lock.json'));
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 180000);
}

async function preparePort(site, notes, useTarball) {
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 180000);
  if (useTarball) {
    await access(tarball);
    await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], site.cwd, site.env, 180000);
  }
  const packageDirectory = await realpath(join(site.cwd, 'node_modules/@bascik/bascik'));
  assert.ok(packageDirectory.startsWith(site.cwd + '/'), 'Bascik must resolve inside the isolated copy');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  notes.push(`${useTarball ? `local tarball ${tarball}` : 'registry release'}; @bascik/bascik ${manifest.version}`);
}

async function runChecks({ site, expected, label, dev = false, includePort = false }) {
  const mode = { dev };
  await shared.checkRoutesAndErrors(site, expected, label, mode);
  await shared.checkMetadata(browser, site, expected, label, mode);
  await shared.checkNavigation(browser, site, expected, label, mode);
  await shared.checkHomeAndArchive(browser, site, expected, label, mode);
  await shared.checkPosts(browser, site, expected, label, mode);
  await shared.checkTags(browser, site, expected, label, mode);
  await shared.checkContent(browser, site, expected, label);
  await shared.checkHeadingAnchors(browser, site, expected, label);
  await shared.checkChrome(browser, site, expected, label);
  await shared.checkMobileAndKeyboard(browser, site, expected, label, mode);
  await shared.checkTheme(browser, site, label);
  await shared.checkFeed(site, expected, label, mode);
  await shared.checkSitemap(site, expected, label, mode);
  await shared.checkScripts(site, expected, label, mode);
  if (includePort) await shared.checkPortOnly(site, expected, label, mode);
}

// When BASCIK_TARBALL is set, the port installs that locally packed Bascik over the registry release.
// Unreleased fixes are only testable this way. Without it, the port uses the registry release.
function lane(name, { dev = false } = {}) {
  const useTarball = Boolean(tarball);
  const skip = (only && only !== name) ? `ELEVENTY_LANE=${only}` : false;
  test(`eleventy blog: ${name} lane`, { skip, timeout: 900000 }, async () => {
    const notes = [];
    const observed = [];
    const common = { env: { BASCIK_SITE_URL: SITE_ORIGIN } };
    await runPair({
      upstream: {
        source: upstreamSource,
        ...(dev
          ? { serve: [process.execPath, ELEVENTY_BIN, '--serve', '--quiet', '--port', '{PORT}'] }
          : {
            build: [process.execPath, ELEVENTY_BIN],
            serve: [process.execPath, staticServer, '_site'],
          }),
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
      timeoutMs: 900000,
      observe: (site) => observed.push(site),
      prepare: async (siteName, site) => {
        assertOutsideRepository(site.cwd, repository);
        if (siteName === 'upstream') await prepareUpstream(site);
        else await preparePort(site, notes, useTarball);
      },
      check: async (sites) => {
        await runChecks({ site: sites.upstream, expected: upstream, label: `upstream/${name}`, dev });
        await runChecks({ site: sites.bascik, expected: port, label: `port/${name}`, dev, includePort: true });
        if (!dev) {
          await access(join(sites.upstream.cwd, '_site', '404.html'));
          const files = await Promise.all(['index.html', 'feed/feed.xml', 'sitemap.xml', 'blog/fourthpost/lighthouse.png']
            .map((file) => access(join(sites.bascik.cwd, 'dist', file))));
          assert.equal(files.length, 4, 'port output files exist');
          // Control: a check that expects drafts must reject a production build that omits them.
          await assert.rejects(
            shared.checkRoutesAndErrors(sites.bascik, port, 'control', { dev: true }),
            /control: \/blog\/fifthpost\/ status/,
          );
        }
      },
    });
    console.log(`eleventy blog ${name}: ${notes.join('; ')}`);
    for (const site of observed) {
      await assert.rejects(access(site.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
    }
  });
}

lane('production');
lane('dev', { dev: true });

// Control: the shared checks must reject a site that is not the blog. Uses the dependency-free
// original fixture from task 02 for both sides, so no Bascik install is involved.
test('eleventy blog: shared checks reject a non-blog site', { skip: only && only !== 'control' }, async () => {
  const fixture = fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url));
  const spec = { source: fixture, build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'] };
  await assert.rejects(runPair({
    upstream: spec, bascik: spec, timeoutMs: 60000,
    check: async (sites) => { await runChecks({ site: sites.bascik, expected: port, label: 'control' }); },
  }), /control: \/blog\/ status/);
});
