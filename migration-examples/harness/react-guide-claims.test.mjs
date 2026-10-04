import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launch, unusedPort } from './runner.mjs';

// Task 09 (React): every example in docs/content/switch/from-react.md that makes a behavior
// claim is built here from the same snippets and checked in a real browser, in minified
// production output and in the development server. Keep the snippets in sync with the guide.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const BIN = 'node_modules/@bascik/bascik/bin/bascik.js';

let browser;
let directory;

const files = {
  'bascik.config.ts': `import { defineConfig } from '@bascik/bascik';
export default defineConfig({ generate: { sitemap: false, robots: false } });
`,
  'package.json': JSON.stringify({ name: 'react-guide-claims', private: true, type: 'module', dependencies: { '@bascik/bascik': '^1.0.0-rc.2' } }),

  // children -> default slot, with fallback.
  'src/components/info-card/info-card.html': `<div class="card">
  <div data-bascik-slot>No content provided.</div>
</div>
`,
  // Named slots written with a wrapper element.
  'src/components/page-layout/page-layout.html': `<div class="layout">
  <header><div data-bascik-slot="header"></div></header>
  <main><div data-bascik-slot></div></main>
</div>
`,
  // String props.
  'src/components/alert-box/alert-box.html': `<div class="alert">
  <strong data-bascik-prop-title></strong>
  <p data-bascik-prop-message></p>
</div>
`,
  // useState -> a script, two instances.
  'src/components/my-counter/my-counter.html': `<div>
  <span id="count">0</span>
  <button id="btn">+</button>
</div>
<script>
  const countEl = document.getElementById("count");
  document.getElementById("btn").addEventListener("click", () => {
    countEl.textContent = String(Number(countEl.textContent) + 1);
  });
</script>
`,
  // The navigation with a slot, a named slot, and a toggle.
  'src/components/site-nav/site-nav.html': `<nav class="nav">
  <div class="logo"><div data-bascik-slot="logo"></div></div>
  <button class="toggle" id="toggle" aria-expanded="false">Menu</button>
  <ul class="links" id="links">
    <div data-bascik-slot></div>
  </ul>
</nav>
<script>
  const toggle = document.getElementById("toggle");
  const links = document.getElementById("links");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    links.classList.toggle("open");
  });
</script>
`,
  'src/components/site-nav/site-nav.css': `.nav { display: flex; }
.links { display: none; }
.links.open { display: block; }
`,
  // Props with an object value cannot be passed. State in a parent, callbacks as events.
  'src/components/emit-child/emit-child.html': `<form id="form"><input id="box" type="text" aria-label="Value"></form>
<script>
  const form = document.getElementById('form');
  const box = document.getElementById('box');
  box.addEventListener('input', () => {
    form.dispatchEvent(new CustomEvent('valuechange', { bubbles: true, detail: { value: box.value } }));
  });
</script>
`,
  'src/components/emit-parent/emit-parent.html': `<div id="root">
  <emit-child></emit-child>
  <p id="echo">none</p>
</div>
<script>
  const root = document.getElementById('root');
  const echo = document.getElementById('echo');
  root.addEventListener('valuechange', (event) => { echo.textContent = event.detail.value; });
</script>
`,
  // Composition: a parent component that forwards its children to another component.
  'src/components/inner-box/inner-box.html': `<section class="inner"><div data-bascik-slot>inner fallback</div></section>
`,
  'src/components/forwarding-box/forwarding-box.html': `<div class="outer"><inner-box><div data-bascik-slot>outer fallback</div></inner-box></div>
`,

  'src/lib/escape.ts': `export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
`,
  'content/posts/hello.md': '# Hello\n',
  'content/posts/second-post.md': '# Second\n',

  'src/pages/index.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Claims</title></head>
<body>
<info-card><p>Card content here.</p></info-card>
<info-card></info-card>
<page-layout>
  <p>Main content.</p>
  <div data-bascik-slot="header"><h1>Welcome</h1></div>
</page-layout>
<alert-box data-bascik-prop-title="Success" data-bascik-prop-message="Your changes were saved."></alert-box>
<my-counter></my-counter>
<my-counter></my-counter>
<site-nav>
  <li><a href="/about">About</a></li>
  <li><a href="/blog">Blog</a></li>
  <div data-bascik-slot="logo"><a href="/">Acme</a></div>
</site-nav>
<emit-parent></emit-parent>
<ul>
  <script data-bascik-build>
    import { readdir } from 'node:fs/promises';
    import { escapeHtml } from '@/lib/escape.ts';
    const files = await readdir('./content/posts');
    console.log(files.filter((file) => file.endsWith('.md')).map((file) => {
      const slug = file.replace('.md', '');
      return '<li><a href="/blog/' + escapeHtml(slug) + '">' + escapeHtml(slug) + '</a></li>';
    }).join('\\n'));
  </script>
</ul>
</body></html>
`,
  'src/pages/composed.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Composed</title></head>
<body>
<forwarding-box><p>given-forwarded</p></forwarding-box>
<forwarding-box></forwarding-box>
</body></html>
`,
  'src/pages/blog/[slug]/index.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Post</title></head>
<body>
<script data-bascik-routes>
  console.log(JSON.stringify([{ params: { slug: 'my-first-post' }, data: { title: 'My first post' } }, { params: { slug: 'another-post' }, data: { title: 'Another post' } }]));
</script>
<script data-bascik-build>
  const route = JSON.parse(process.env.BASCIK_ROUTE || '{}');
  console.log('<h1>' + route.data.title + '</h1><p>' + route.params.slug + '</p>');
</script>
</body></html>
`,
};

before(async () => {
  browser = await chromium.launch();
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bascik-react-guide-')));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...(tarball ? [tarball] : [])]);
});

after(async () => {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
});

async function run(command) {
  const handle = launch(command, directory, { ...process.env });
  try { await handle.wait(240000); } finally { await handle.stop(); }
}

async function build() {
  const handle = launch([process.execPath, BIN, '--build'], directory, { ...process.env });
  const result = await handle.completion;
  const output = handle.output();
  await handle.stop();
  assert.equal(result.code, 0, output);
  return output;
}

async function serve({ dev }) {
  const port = await unusedPort();
  const handle = launch([process.execPath, BIN, ...(dev ? [] : ['--server']), '--port', String(port), '--host', '127.0.0.1'], directory, { ...process.env });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    handle.assertAlive();
    try {
      const response = await fetch(`${url}/`);
      const body = await response.text();
      // The dev server answers 200 with a holding page until its first build ends.
      if (response.ok && body.includes("Card content here.") && !/Building site/.test(body)) break;
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((accept) => setTimeout(accept, 50));
  }
  return { url, stop: () => handle.stop() };
}

async function checkPage({ dev }) {
  const server = await serve({ dev });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  try {
    await page.goto(`${server.url}/`);
    // children -> default slot and its fallback.
    assert.equal(await page.getByText('Card content here.').count(), 1);
    assert.equal(await page.getByText('No content provided.').count(), 1, 'fallback only where the tag is empty');
    // Named slot with a wrapper element.
    assert.equal(await page.locator('header h1').textContent(), 'Welcome');
    assert.equal(await page.locator('main').textContent(), 'Main content.');
    // String props.
    assert.equal(await page.locator('strong').textContent(), 'Success');
    assert.equal(await page.getByText('Your changes were saved.').count(), 1);
    // Two counters are independent.
    const plus = page.getByRole('button', { name: '+' });
    await plus.nth(0).click();
    await plus.nth(0).click();
    await plus.nth(1).click();
    assert.deepEqual(await page.locator('span').evaluateAll((spans) => spans.map((span) => span.textContent)), ['2', '1']);
    // The menu toggles and the slot content is a real list.
    const menu = page.getByRole('button', { name: 'Menu' });
    assert.equal(await page.getByRole('link', { name: 'About' }).isVisible(), false);
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByRole('link', { name: 'About' }).isVisible(), true);
    assert.equal(await page.getByRole('link', { name: 'Acme' }).count(), 1);
    // Callback props become events: the parent hears what the child reports.
    await page.getByLabel('Value').fill('typed');
    assert.equal(await page.locator('#echo, p:has-text("typed")').first().textContent(), 'typed');
    // useEffect for data -> build script.
    const links = await page.locator('ul li a[href^="/blog/"]').evaluateAll((anchors) => anchors.map((anchor) => [anchor.getAttribute('href'), anchor.textContent]));
    assert.deepEqual(links.sort(), [['/blog/hello', 'hello'], ['/blog/second-post', 'second-post']]);
    assert.deepEqual(problems.filter((message) => !/live-reload/.test(message)), []);
  } finally {
    await context.close();
    await server.stop();
  }
}

test('guide examples behave as documented in minified production output', async () => {
  const output = await build();
  assert.doesNotMatch(output, /is not hyphenated/, 'every tag name in the guide is hyphenated');
  const html = await readFile(join(directory, 'dist/index.html'), 'utf8');
  assert.doesNotMatch(html, /data-bascik/, 'no Bascik attribute reaches the output');
  await checkPage({ dev: false });
});

test('guide examples behave as documented in the development server', async () => {
  await checkPage({ dev: true });
});

test('a dynamic route template replaces one file per URL', async () => {
  await build();
  const first = await readFile(join(directory, 'dist/blog/my-first-post/index.html'), 'utf8');
  const other = await readFile(join(directory, 'dist/blog/another-post/index.html'), 'utf8');
  assert.match(first, /<h1>My first post<\/h1><p>my-first-post<\/p>/);
  assert.match(other, /<h1>Another post<\/h1><p>another-post<\/p>/);
});

// Needs the slot-forwarding fix (1.0.0-rc.3 or later). Registry 1.0.0-rc.2 left the marker in the
// output and dropped the content, so this is the one test here that a tarball must satisfy.
test('a slot inside another component\'s usage tag is filled by the outer usage', { skip: tarball ? false : 'needs 1.0.0-rc.3 or later (BASCIK_TARBALL)' }, async () => {
  await build();
  const html = await readFile(join(directory, 'dist/composed.html'), 'utf8');
  assert.match(html, /<section class="[^"]*"><p>given-forwarded<\/p><\/section>/, 'content given to the outer component is forwarded');
  assert.match(html, /<section class="[^"]*">outer fallback<\/section>/, 'an empty outer tag shows the marker\'s own fallback');
  assert.doesNotMatch(html, /inner fallback/, 'the inner component\'s fallback is never shown');
  assert.doesNotMatch(html, /data-bascik/, 'no slot marker reaches the output');
});
