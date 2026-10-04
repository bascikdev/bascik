import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, unusedPort } from './runner.mjs';
import { BASCIK_BIN, portSource, preparePort, run } from './vue-grid-env.mjs';
import { waitForFirstBuild } from './blog-template-checks.mjs';
import * as shared from './vue-grid-checks.mjs';

// Task 09 (Vue): data and source mutations of the Bascik port, run in isolated copies outside the
// repository. Each scenario copies a prepared project (installed once from BASCIK_TARBALL or the
// registry), edits it, builds or serves it, and checks the result in a real browser.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

let browser;
let base;
const temporary = [];

before(async () => {
  browser = await chromium.launch();
  base = await realpath(await mkdtemp(join(tmpdir(), 'bascik-vue-base-')));
  temporary.push(base);
  await cp(portSource, base, { recursive: true, filter: (path) => !/node_modules|\/dist$/.test(path) });
  await preparePort({ cwd: base, env: process.env });
});

after(async () => {
  await browser?.close();
  await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })));
});

async function project(mutate = async () => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bascik-vue-case-')));
  temporary.push(directory);
  await cp(base, directory, { recursive: true });
  await mutate(directory);
  return directory;
}

const dataFile = (directory) => join(directory, 'src/data/grid.ts');

async function setData(directory, rows, columns = ['name', 'power']) {
  const literal = (value) => JSON.stringify(value).replace(/"(-?)Infinity"/g, '$1Infinity');
  await writeFile(dataFile(directory), `export const gridColumns = ${literal(columns)};\n` +
    `export const gridData = ${literal(rows)};\n` +
    'export const planetColumns = [\'planet\', \'moons\'];\nexport const planetData = [];\n');
}

async function build(directory) {
  const handle = launch([process.execPath, BASCIK_BIN, '--build'], directory, { ...process.env });
  const result = await handle.completion;
  const output = handle.output();
  await handle.stop();
  return { code: result.code, output };
}

async function serve(directory, { dev = false } = {}) {
  const port = await unusedPort();
  const command = dev
    ? [process.execPath, BASCIK_BIN, '--port', String(port), '--host', '127.0.0.1']
    : [process.execPath, BASCIK_BIN, '--server', '--port', String(port), '--host', '127.0.0.1'];
  const handle = launch(command, directory, { ...process.env });
  const site = { url: `http://127.0.0.1:${port}`, cwd: directory };
  const deadline = Date.now() + 30000;
  for (;;) {
    handle.assertAlive();
    try {
      const response = await fetch(`${site.url}/`);
      await response.arrayBuffer();
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((accept) => setTimeout(accept, 50));
  }
  if (dev) await waitForFirstBuild(site, 'dev');
  return { site, stop: () => handle.stop() };
}

async function withServer(directory, options, action) {
  const server = await serve(directory, options);
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  try {
    return await action(page, server.site, problems);
  } finally {
    await context.close();
    await server.stop();
  }
}

const bodyRows = (page) => page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => [...row.cells].map((cell) => cell.textContent)));

test('hostile and unusual text is rendered literally and sorts', async () => {
  const hostile = [
    { name: '</script><script>window.__pwn = 1</script>', power: 1 },
    { name: '<img src=x onerror="window.__pwn = 1">', power: 2 },
    { name: '"quotes" & \'apostrophes\' &amp; &lt;', power: 3 },
    { name: '$& $1 $\' $` ${x}', power: 4 },
    { name: 'Zoë 😀 日本語', power: 5 },
  ];
  const directory = await project((dir) => setData(dir, hostile));
  const result = await build(directory);
  assert.equal(result.code, 0, result.output);
  await withServer(directory, {}, async (page, site, problems) => {
    await page.goto(`${site.url}/`);
    await page.getByRole('columnheader', { name: 'Name' }).waitFor();
    assert.deepEqual(await bodyRows(page), hostile.map((row) => [row.name, String(row.power)]));
    assert.equal(await page.evaluate(() => window.__pwn), undefined, 'no row text ran as script');
    assert.equal(await page.locator('tbody img').count(), 0, 'no row text became an element');
    await page.getByRole('columnheader', { name: 'Power' }).click();
    assert.deepEqual((await bodyRows(page)).map((row) => row[1]), ['5', '4', '3', '2', '1']);
    await page.getByRole('textbox').fill('$&');
    assert.deepEqual(await bodyRows(page), [['$& $1 $\' $` ${x}', '4']]);
    await page.getByRole('textbox').fill('&AMP;');
    assert.deepEqual(await bodyRows(page), [['"quotes" & \'apostrophes\' &amp; &lt;', '3']]);
    assert.deepEqual(problems, []);
  });
});

test('numbers keep their JavaScript meaning: Infinity, large, fractional, and ties', async () => {
  const rows = [
    { name: 'a', power: 1e21 },
    { name: 'b', power: -Infinity },
    { name: 'c', power: 0.1 + 0.2 },
    { name: 'd', power: 9007199254740991 },
    { name: 'e', power: Infinity },
    { name: 'f', power: 5 },
    { name: 'g', power: 5 },
  ];
  const directory = await project((dir) => setData(dir, rows.map((row) => ({ ...row, power: Number.isFinite(row.power) ? row.power : `${row.power < 0 ? '-' : ''}Infinity` }))));
  assert.equal((await build(directory)).code, 0);
  await withServer(directory, {}, async (page, site, problems) => {
    await page.goto(`${site.url}/`);
    await page.getByRole('columnheader', { name: 'Name' }).waitFor();
    assert.deepEqual((await bodyRows(page)).map((row) => row[1]),
      ['1e+21', '-Infinity', '0.30000000000000004', '9007199254740991', 'Infinity', '5', '5']);
    await page.getByRole('columnheader', { name: 'Power' }).click();
    await page.getByRole('columnheader', { name: 'Power' }).click();
    // Ascending by number, ties in source order (f before g).
    assert.deepEqual((await bodyRows(page)).map((row) => row[0]), ['b', 'c', 'f', 'g', 'd', 'a', 'e']);
    assert.deepEqual(problems, []);
  });
});

test('no rows and a row without a key leave the page working', async () => {
  const empty = await project((dir) => setData(dir, []));
  assert.equal((await build(empty)).code, 0);
  await withServer(empty, {}, async (page, site, problems) => {
    await page.goto(`${site.url}/`);
    await page.getByText('No matches found.').waitFor();
    assert.equal(await page.locator('table').isVisible(), false);
    await page.getByRole('textbox').fill('x');
    await page.getByText('No matches found.').waitFor();
    assert.deepEqual(problems, []);
  });
  const partial = await project((dir) => setData(dir, [{ name: 'only name' }, { name: 'both', power: 3 }]));
  assert.equal((await build(partial)).code, 0);
  await withServer(partial, {}, async (page, site, problems) => {
    await page.goto(`${site.url}/`);
    await page.getByRole('columnheader', { name: 'Power' }).waitFor();
    assert.deepEqual(await bodyRows(page), [['only name', ''], ['both', '3']]);
    await page.getByRole('columnheader', { name: 'Power' }).click();
    assert.equal((await bodyRows(page)).length, 2);
    assert.deepEqual(problems, []);
  });
});

test('data the grid cannot carry fails the build and names the cause', async () => {
  const directory = await project(async (dir) => {
    await writeFile(dataFile(dir), 'export const gridColumns = [\'name\', \'power\'];\n' +
      'export const gridData = [{ name: \'bad\', power: NaN }];\nexport const planetColumns = [];\nexport const planetData = [];\n');
  });
  const result = await build(directory);
  assert.notEqual(result.code, 0, 'build must fail');
  assert.match(result.output, /NaN cannot be passed to a grid/);
  assert.doesNotMatch(result.output, /Build complete/);
});

test('dev server picks up a data edit and a bad edit does not stop it', async () => {
  const directory = await project();
  await withServer(directory, { dev: true }, async (page, site) => {
    await page.goto(`${site.url}/`);
    await page.getByRole('columnheader', { name: 'Name' }).waitFor();
    assert.equal((await bodyRows(page)).length, 4);
    await setData(directory, [{ name: 'Edited Row', power: 1 }]);
    await page.getByRole('cell', { name: 'Edited Row' }).waitFor({ timeout: 20000 });
    assert.equal((await bodyRows(page)).length, 1);
    // A bad edit is reported and the server keeps serving the last good page.
    await writeFile(dataFile(directory), 'export const gridColumns = [;\n');
    await new Promise((accept) => setTimeout(accept, 1500));
    assert.equal((await fetch(`${site.url}/`)).status, 200);
    await setData(directory, [{ name: 'Recovered', power: 2 }]);
    await page.getByRole('cell', { name: 'Recovered' }).waitFor({ timeout: 20000 });
  });
});

test('the shared checks catch a port with the wrong first sort direction', async () => {
  const directory = await project(async (dir) => {
    const file = join(dir, 'src/components/demo-grid/demo-grid.html');
    const source = await readFile(file, 'utf8');
    assert.ok(source.includes('sortOrders[key] *= -1;'));
    await writeFile(file, source.replace('sortOrders[key] *= -1;', () => '/* flip removed */'));
  });
  assert.equal((await build(directory)).code, 0);
  const server = await serve(directory);
  try {
    await assert.rejects(shared.checkSorting(browser, server.site, 'broken'), /broken click 1 on Name/);
  } finally {
    await server.stop();
  }
});

test('element selectors do not style cells a script creates without a template', async () => {
  const directory = await project(async (dir) => {
    const file = join(dir, 'src/components/demo-grid/demo-grid.html');
    const source = await readFile(file, 'utf8');
    const replaced = source.replace(
      'const cell = cellTemplate.content.firstElementChild.cloneNode(true);',
      () => 'const cell = document.createElement(\'td\');');
    assert.notEqual(replaced, source);
    await writeFile(file, replaced);
  });
  assert.equal((await build(directory)).code, 0);
  await withServer(directory, {}, async (page, site) => {
    await page.goto(`${site.url}/`);
    await page.getByRole('cell', { name: 'Bruce Lee' }).waitFor();
    const padding = await page.getByRole('cell', { name: 'Bruce Lee' }).evaluate((cell) => getComputedStyle(cell).paddingLeft);
    assert.equal(padding, '1px', 'the td rule did not reach the created cell');
  });
  // With the template, the same cell gets the rule.
  const original = await project();
  assert.equal((await build(original)).code, 0);
  await withServer(original, {}, async (page, site) => {
    await page.goto(`${site.url}/`);
    await page.getByRole('cell', { name: 'Bruce Lee' }).waitFor();
    assert.equal(await page.getByRole('cell', { name: 'Bruce Lee' }).evaluate((cell) => getComputedStyle(cell).paddingLeft), '20px');
  });
});

test('the port builds and passes the strict check with identifier minification off', async () => {
  const directory = await project(async (dir) => {
    await writeFile(join(dir, 'bascik.config.ts'), (await readFile(join(dir, 'bascik.config.ts'), 'utf8'))
      .replace('generate:', () => 'minify: { identifiers: false },\n  generate:'));
  });
  assert.equal((await build(directory)).code, 0);
  await run([process.execPath, BASCIK_BIN, '--check', '--strict'], directory, { ...process.env }, 120000);
  const html = await readFile(join(directory, 'dist/index.html'), 'utf8');
  assert.match(html, /bascik__demo-grid__/, 'readable scoped names');
  await withServer(directory, {}, async (page, site) => {
    await shared.checkSorting(browser, site, 'unminified');
    await shared.checkFiltering(browser, site, 'unminified');
  });
});
