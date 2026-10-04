import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch, unusedPort } from './runner.mjs';
import { visibleRows } from './react-product-table-checks.mjs';

// Task 09: edits to the product data in an isolated copy of the port. Covers hostile text,
// replacement tokens, an empty list, a single category, and dev reload after a data edit.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const portSource = fileURLToPath(new URL('../ports/react-product-table/', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const BIN = 'node_modules/@bascik/bascik/bin/bascik.js';

let browser;
let root;
let project;
let env;

async function run(command, cwd, timeoutMs = 240000) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

const dataFile = () => join(project, 'src/data/products.ts');
const original = async () => readFile(join(portSource, 'src/data/products.ts'), 'utf8');

function dataModule(products) {
  return `export interface Product { category: string; price: string; stocked: boolean; name: string; }\n` +
    `export const PRODUCTS: Product[] = ${JSON.stringify(products, null, 2)};\n`;
}

before(async () => {
  assert.ok(tarball, 'Set BASCIK_TARBALL to a freshly packed local source artifact');
  await access(tarball);
  browser = await chromium.launch();
  root = await realpath(await mkdtemp(join(tmpdir(), 'bascik-react-mutations-')));
  assertOutsideRepository(root, repository);
  project = join(root, 'project');
  await cp(portSource, project, { recursive: true, filter: (path) => !/[\\/](node_modules|dist|\.bascik)$/.test(path) });
  env = { ...process.env, BASCIK_SITE_URL: 'https://example.com' };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], project);
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], project);
  const real = await realpath(join(project, 'node_modules/@bascik/bascik'));
  assert.ok(real.startsWith(project + '/'), 'Bascik must resolve inside the isolated copy');
});

after(async () => {
  await browser?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function build() {
  await rm(join(project, 'dist'), { recursive: true, force: true });
  await run([process.execPath, BIN, '--build'], project);
  return readFile(join(project, 'dist/index.html'), 'utf8');
}

async function served(body) {
  const port = await unusedPort();
  const server = launch([process.execPath, BIN, '--server', '--port', String(port), '--host', '127.0.0.1'], project, env);
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      server.assertAlive();
      try { if ((await fetch(`${url}/`)).ok) break; } catch { /* not listening yet */ }
      await new Promise((accept) => setTimeout(accept, 50));
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}/`);
    try { await body(page); } finally { await context.close(); }
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await server.stop(); }
}

const row = (category, name, price, stocked) => ({ category, name, price, stocked });

test('hostile text is shown as text and cannot add elements, attributes, or scripts', async () => {
  const hostile = [
    row('<b>Fruits</b>', '<img src=x onerror=alert(1)>', '$1 & more', true),
    row('<b>Fruits</b>', '"quoted" \'single\'', '$2', false),
    row('Tokens', '$& $1 $` $\' $$', '$3', true),
    row('Tokens', '</td></tr><script>window.pwned=1</script>', '$4', true),
  ];
  await writeFile(dataFile(), dataModule(hostile));
  const html = await build();
  assert.doesNotMatch(html, /<img src=x/, 'no injected image');
  assert.doesNotMatch(html, /<script>window\.pwned/, 'no injected script element');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the tag text is escaped');
  await served(async (page) => {
    assert.deepEqual(await visibleRows(page), [
      '<b>Fruits</b>', '<img src=x onerror=alert(1)> $1 & more', '"quoted" \'single\' $2',
      'Tokens', '$& $1 $` $\' $$ $3', '</td></tr><script>window.pwned=1</script> $4',
    ]);
    assert.equal(await page.evaluate(() => window.pwned), undefined, 'the script text never ran');
    assert.equal(await page.locator('img').count(), 0, 'no image element exists');
    // Filtering works on the literal text, including characters that matter to regular expressions.
    await page.getByPlaceholder('Search...').fill('$&');
    assert.deepEqual(await visibleRows(page), ['Tokens', '$& $1 $` $\' $$ $3']);
    await page.getByPlaceholder('Search...').fill('<b>');
    assert.deepEqual(await visibleRows(page), [], 'a category name is not searched, as in the tutorial');
    await page.getByPlaceholder('Search...').fill('(');
    // A character that is special in a regular expression is matched literally.
    assert.deepEqual(await visibleRows(page), ['<b>Fruits</b>', '<img src=x onerror=alert(1)> $1 & more']);
  });
});

test('an empty list builds an empty table with its header', async () => {
  await writeFile(dataFile(), dataModule([]));
  const html = await build();
  assert.match(html, /<thead>/, 'the header is still printed');
  await served(async (page) => {
    assert.equal(await page.locator('tbody tr').count(), 0);
    assert.deepEqual(await page.locator('thead th').allInnerTexts(), ['Name', 'Price']);
    await page.getByPlaceholder('Search...').fill('x');
    await page.getByLabel('Only show products in stock').check();
    assert.equal(await page.locator('tbody tr').count(), 0);
  });
});

test('products that are not grouped repeat the category heading, as the tutorial does', async () => {
  await writeFile(dataFile(), dataModule([
    row('A', 'One', '$1', true), row('B', 'Two', '$1', true), row('A', 'Three', '$1', true),
  ]));
  await build();
  await served(async (page) => {
    assert.deepEqual(await visibleRows(page), ['A', 'One $1', 'B', 'Two $1', 'A', 'Three $1']);
    await page.getByPlaceholder('Search...').fill('three');
    assert.deepEqual(await visibleRows(page), ['A', 'Three $1'], 'only the heading with a visible row stays');
  });
});

test('a product whose name has a space is found by a search with a space', async () => {
  await writeFile(dataFile(), dataModule([row('Fruits', 'Star fruit', '$5', true), row('Fruits', 'Plum', '$1', false)]));
  await build();
  await served(async (page) => {
    await page.getByPlaceholder('Search...').fill('r f');
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Star fruit $5']);
    await page.getByPlaceholder('Search...').fill('PLUM');
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Plum $1']);
    await page.getByLabel('Only show products in stock').check();
    assert.deepEqual(await visibleRows(page), [], 'the only plum is out of stock');
  });
});

test('a broken data module fails the production build and names the file', async () => {
  await writeFile(dataFile(), 'export const PRODUCTS = [ { category: "A", \n');
  await assert.rejects(build(), /products\.ts|Build pipeline failed|SyntaxError|Unexpected/i);
  assert.equal(
    await access(join(project, 'dist/index.html')).then(() => 'exists', () => 'absent'), 'absent',
    'a failed build leaves no stale index.html',
  );
  await writeFile(dataFile(), await original());
  const html = await build();
  assert.match(html, /Dragonfruit/, 'the next build recovers');
});

test('dev: editing the data reloads the open page; a broken edit does not end the session', async () => {
  await writeFile(dataFile(), await original());
  const port = await unusedPort();
  const server = launch([process.execPath, BIN, '--port', String(port), '--host', '127.0.0.1'], project, env);
  const url = `http://127.0.0.1:${port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      server.assertAlive();
      try { if ((await fetch(`${url}/`)).ok) break; } catch { /* not listening yet */ }
      await new Promise((accept) => setTimeout(accept, 50));
    }
    await page.goto(`${url}/`);
    await page.locator('tbody tr:visible').first().waitFor({ timeout: 60000 });
    assert.equal((await visibleRows(page)).length, 8);
    // Type a filter first: a rebuilt page starts fresh, as it does after a hot update in React.
    await page.getByPlaceholder('Search...').fill('apple');
    await writeFile(dataFile(), dataModule([row('Fruits', 'Kiwi', '$3', true)]));
    await page.waitForFunction(() => document.body.innerText.includes('Kiwi'), null, { timeout: 30000 });
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Kiwi $3']);
    // A syntax error must not end the dev server. The last good page stays reachable.
    await writeFile(dataFile(), 'export const PRODUCTS = [ {\n');
    await new Promise((accept) => setTimeout(accept, 1500));
    server.assertAlive();
    await writeFile(dataFile(), dataModule([row('Veg', 'Leek', '$2', true)]));
    await page.waitForFunction(() => document.body.innerText.includes('Leek'), null, { timeout: 30000 });
    assert.deepEqual(await visibleRows(page), ['Veg', 'Leek $2']);
  } finally {
    await context.close();
    await server.stop();
  }
});
