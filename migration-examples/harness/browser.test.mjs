import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { launch, runPair, assertOutsideRepository } from './runner.mjs';

// Reuse the monorepo's browser tool explicitly, never its application dependencies.
const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

test('packed local Bascik: isolated production build, browser routes and keyboard navigation', async () => {
  assert.ok(process.env.BASCIK_TARBALL, 'Set BASCIK_TARBALL to a freshly packed local source artifact');
  const tarball = resolve(process.env.BASCIK_TARBALL);
  await access(tarball);
  const observed = [];
  const browser = await chromium.launch();
  try {
    await runPair({
      upstream: {
        source: fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url)),
        build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'],
      },
      bascik: {
        source: fileURLToPath(new URL('../fixtures/tiny-bascik/', import.meta.url)),
        env: { BASCIK_SITE_URL: 'https://example.com' },
        build: ['npm', 'run', 'build'], serve: ['npm', 'run', 'serve'],
      },
      timeoutMs: 30000,
      observe: (site) => observed.push(site),
      prepare: async (name, site) => {
        assertOutsideRepository(site.cwd, repository);
        if (name !== 'bascik') return;
        const install = launch(['npm', 'install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', tarball], site.cwd, site.env);
        try { await install.wait(30000); } finally { await install.stop(); }
        const packageDirectory = await realpath(join(site.cwd, 'node_modules/@bascik/bascik'));
        assert.ok(packageDirectory.startsWith(site.cwd + '/'), 'Bascik must resolve within the isolated project');
        const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
        // The installed artifact must be the local source package, whatever its current version.
        const source = JSON.parse(await readFile(fileURLToPath(new URL('../../pkg/package.json', import.meta.url)), 'utf8'));
        assert.equal(manifest.version, source.version, 'tarball must be a fresh pack of pkg/');
        console.log(`Local-source artifact: ${tarball}; Bascik ${manifest.version}; no registry-release validation`);
      },
      check: async (sites) => {
        for (const name of ['upstream', 'bascik']) {
          const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
          try {
            const page = await context.newPage();
            const response = await page.goto(sites[name].url);
            assert.equal(response.status(), 200);
            assert.equal(await page.getByTestId('title').textContent(), 'Original fixture');
            if (name === 'bascik') {
              assert.equal(await page.getByTestId('title').evaluate((element) => getComputedStyle(element).color), 'rgb(18, 52, 86)');
            }
            await page.getByTestId('about-link').focus();
            await Promise.all([page.waitForURL('**/about/'), page.keyboard.press('Enter')]);
            assert.equal(await page.getByTestId('title').textContent(), 'About this fixture');
            const missing = await page.goto(sites[name].url + '/missing/');
            assert.equal(missing.status(), 404);
            const width = await page.evaluate(() => ({
              content: document.documentElement.scrollWidth,
              viewport: document.documentElement.clientWidth,
            }));
            assert.ok(width.content <= width.viewport, 'No horizontal overflow');
          } finally { await context.close(); }
        }
        assert.notEqual(sites.upstream.port, sites.bascik.port);
        await access(join(sites.upstream.cwd, 'dist/index.html'));
        await access(join(sites.bascik.cwd, 'dist/index.html'));
        await assert.rejects(access(join(sites.upstream.cwd, 'node_modules/@bascik/bascik')), { code: 'ENOENT' });
      },
    });
  } finally {
    await browser.close();
    for (const site of observed) {
      await assert.rejects(access(site.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
      await assert.rejects(fetch(site.url), /fetch failed/);
    }
  }
});