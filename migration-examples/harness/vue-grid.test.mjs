import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertOutsideRepository, runPair } from './runner.mjs';
import { waitForFirstBuild } from './blog-template-checks.mjs';
import { BASCIK_BIN, VITE_BIN, preparePort, prepareUpstream, repository, run, portSource, shellSource } from './vue-grid-env.mjs';
import * as shared from './vue-grid-checks.mjs';

// Task 09 (Vue): behavior checks for the pinned Vue "Grid with Sort and Filter" example
// (SRC-VUE-GRID, vuejs/docs @40aa88a) and its Bascik port. The upstream example is the
// Options API files run through Vite, installed from the retained lockfile. Lanes: production
// (`--build` plus `--server`) and development. With BASCIK_TARBALL set, the port installs that
// locally packed Bascik over the registry release.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const only = process.env.VUE_LANE;

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function runChecks({ site, label, port = false, dev = false }) {
  await shared.checkRoute(site, label);
  await shared.checkSorting(browser, site, label);
  await shared.checkFiltering(browser, site, label);
  await shared.checkSearchSubmit(browser, site, label, { reloads: !port });
  await shared.checkKeyboard(browser, site, label, { sortHeadersFocusable: port });
  await shared.checkLayout(browser, site, label);
  const weight = await shared.checkScriptWeight(site, label, { framework: !port });
  if (port) await shared.checkPortOnly(browser, site, label, { dev });
  return weight;
}

function lane(name, { dev = false } = {}) {
  const skip = (only && only !== name) ? `VUE_LANE=${only}` : false;
  test(`vue grid: ${name} lane`, { skip, timeout: 900000 }, async () => {
    const notes = [];
    const observed = [];
    await runPair({
      upstream: {
        source: shellSource,
        build: [process.execPath, VITE_BIN, 'build'],
        serve: [process.execPath, VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', '{PORT}', '--strictPort'],
      },
      bascik: {
        source: portSource,
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
        const upstreamWeight = await runChecks({ site: sites.upstream, label: `upstream/${name}` });
        if (dev) await waitForFirstBuild(sites.bascik, `port/${name}`);
        const portWeight = await runChecks({ site: sites.bascik, label: `port/${name}`, port: true, dev });
        notes.push(`script bytes: upstream ${upstreamWeight.external} external, port ${portWeight.inline} inline`);
        if (!dev) {
          for (const file of ['index.html', 'two-grids.html']) {
            await access(join(sites.bascik.cwd, 'dist', file));
          }
          await run([process.execPath, BASCIK_BIN, '--check', '--strict'], sites.bascik.cwd, sites.bascik.env, 120000);
          await run(['npm', 'test'], sites.bascik.cwd, sites.bascik.env, 120000);
        }
      },
    });
    console.log(`vue grid ${name}: ${notes.join('; ')}`);
    for (const site of observed) {
      await assert.rejects(access(site.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
    }
  });
}

lane('production');
lane('dev', { dev: true });

// Control: the shared checks must reject a site that is not the grid. Uses the dependency-free
// fixture for both sides, so no Bascik install is involved.
test('vue grid: shared checks reject a non-grid site', { skip: only && only !== 'control' }, async () => {
  const fixture = fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url));
  const spec = { source: fixture, build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'] };
  await assert.rejects(runPair({
    upstream: spec, bascik: spec, timeoutMs: 60000,
    check: async (sites) => { await shared.checkSorting(browser, sites.bascik, 'control'); },
  }), /columnheader/);
});
