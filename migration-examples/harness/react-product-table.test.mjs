import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, copyFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch, runPair } from './runner.mjs';
import { port, upstream } from './react-product-table-expected.mjs';
import * as shared from './react-product-table-checks.mjs';

// Task 09: the final code of react.dev's "Thinking in React" (SRC-REACT-THINKING @8c68ae8) and
// its Bascik port. Lanes: production (`vite build` plus a static server, `bascik --build` plus
// `--server`) and development (`vite`, `bascik`). The upstream App.jsx and stylesheet are cut out
// of the pinned tutorial text at run time, not copied into the repository.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const tutorialFile = fileURLToPath(new URL('../.upstream/react-thinking-in-react/src/content/learn/thinking-in-react.md', import.meta.url));
const shellSource = fileURLToPath(new URL('./react-shell/', import.meta.url));
const portSource = fileURLToPath(new URL('../ports/react-product-table/', import.meta.url));
const staticServer = fileURLToPath(new URL('./static-site-server.mjs', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const only = process.env.REACT_LANE;
const BASCIK_BIN = 'node_modules/@bascik/bascik/bin/bascik.js';
const VITE_BIN = 'node_modules/vite/bin/vite.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function run(command, cwd, env, timeoutMs) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

/** The last `src/App.js` plus stylesheet in the tutorial is its finished app (step 5). */
export function extractFinalApp(markdown) {
  const pattern = /```jsx src\/App\.js\n([\s\S]*?)\n```\n\n```css\n([\s\S]*?)\n```/g;
  const blocks = [...markdown.matchAll(pattern)];
  assert.equal(blocks.length, 3, 'the tutorial has three complete App.js examples');
  const [, app, css] = blocks.at(-1);
  assert.match(app, /onFilterTextChange/, 'the last example is the one with inverse data flow');
  return { app, css };
}

async function prepareUpstream(site) {
  const { app, css } = extractFinalApp(await readFile(tutorialFile, 'utf8'));
  await writeFile(join(site.cwd, 'src/App.jsx'), `${app}\n`);
  await writeFile(join(site.cwd, 'src/styles.css'), `${css}\n`);
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 180000);
}

async function preparePort(site, notes) {
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], site.cwd, site.env, 180000);
  if (tarball) {
    await access(tarball);
    await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], site.cwd, site.env, 180000);
  }
  const packageDirectory = await realpath(join(site.cwd, 'node_modules/@bascik/bascik'));
  assert.ok(packageDirectory.startsWith(site.cwd + '/'), 'Bascik must resolve inside the isolated copy');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  notes.push(`${tarball ? `local tarball ${tarball}` : 'registry release'}; @bascik/bascik ${manifest.version}`);
}

async function runChecks({ site, expected, label, dev = false, includePort = false }) {
  await shared.checkStaticTable(browser, site, label);
  await shared.checkStyles(browser, site, label);
  await shared.checkFiltering(browser, site, label);
  await shared.checkKeyboard(browser, site, label, expected);
  await shared.checkHistory(browser, site, label);
  await shared.checkAccessibleNames(browser, site, label, expected);
  await shared.checkMobile(browser, site, label);
  // Vite's dev server answers every unknown path with index.html (single-page fallback), so a
  // client-routed app has no server-side 404 in development. Recorded, not a claim about React.
  await shared.checkErrors(site, label, dev && expected.name === 'upstream' ? 200 : 404);
  // Development builds ship the React dev runtime and a live-reload client, so byte budgets
  // apply to production only.
  await shared.checkScripts(browser, site, label, dev ? { ...expected, productionScripts: false } : expected);
  if (includePort) await shared.checkInstances(browser, site, label);
}

function lane(name, { dev = false } = {}) {
  const skip = (only && only !== name) ? `REACT_LANE=${only}` : false;
  test(`react product table: ${name} lane`, { skip, timeout: 900000 }, async () => {
    const notes = [];
    const observed = [];
    await runPair({
      upstream: {
        source: shellSource,
        ...(dev
          ? { serve: [process.execPath, VITE_BIN, '--host', '127.0.0.1', '--port', '{PORT}', '--strictPort'] }
          : { build: [process.execPath, VITE_BIN, 'build'], serve: [process.execPath, staticServer, 'dist'] }),
      },
      bascik: {
        source: portSource,
        env: { BASCIK_SITE_URL: 'https://example.com' },
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
        await runChecks({ site: sites.upstream, expected: upstream, label: `upstream/${name}`, dev });
        await runChecks({ site: sites.bascik, expected: port, label: `port/${name}`, dev, includePort: true });
        if (!dev) {
          const { upstream: u, bascik: b } = sites;
          console.log(`react product table ${name}: upstream scripts ${u.measured.scripts} / ${u.measured.bytes} bytes; port scripts ${b.measured.scripts} / ${b.measured.bytes} bytes`);
          // Control: a check that expects Enter to stay put must reject the upstream.
          await assert.rejects(
            shared.checkKeyboard(browser, sites.upstream, 'control', { ...upstream, enterNavigates: false }),
            /control: Enter stays/,
          );
        }
      },
    });
    console.log(`react product table ${name}: ${notes.join('; ')}`);
    for (const site of observed) {
      await assert.rejects(access(site.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
    }
  });
}

lane('production');
lane('dev', { dev: true });

// Control: the shared checks must reject a site that is not the product table.
test('react product table: shared checks reject a non-table site', { skip: only && only !== 'control' }, async () => {
  const fixture = fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url));
  const spec = { source: fixture, build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'] };
  await assert.rejects(runPair({
    upstream: spec, bascik: spec, timeoutMs: 180000,
    check: async (sites) => { await runChecks({ site: sites.bascik, expected: port, label: 'control' }); },
  }), /control/);
});

test('the tutorial extractor takes the finished app and refuses a changed text', () => {
  const block = (marker) => `\`\`\`jsx src/App.js\n${marker}\n\`\`\`\n\n\`\`\`css\nbody {}\n\`\`\`\n`;
  const text = [block('a'), block('b'), block('c onFilterTextChange')].join('\n');
  assert.equal(extractFinalApp(text).app, 'c onFilterTextChange');
  assert.throws(() => extractFinalApp(block('a')), /three complete/);
});
