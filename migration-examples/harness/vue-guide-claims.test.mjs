import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launch, unusedPort } from './runner.mjs';
import { BASCIK_BIN, run, tarball } from './vue-grid-env.mjs';
import { waitForFirstBuild } from './blog-template-checks.mjs';

// Task 09 (Vue): every example in docs/content/switch/from-vue.md and the Vue grid tutorial that
// makes a behavior claim is built here from the same snippets and checked in a real browser, in
// minified production output and in the development server. Keep the snippets in sync with the
// guide when either changes.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

let browser;
let directory;

const files = {
  'bascik.config.ts': `import { defineConfig } from '@bascik/bascik';
export default defineConfig({ generate: { sitemap: false, robots: false } });
`,
  'package.json': JSON.stringify({ name: 'vue-guide-claims', private: true, type: 'module', dependencies: { '@bascik/bascik': '^1.0.0-rc.2' } }),

  // Default slot and props: a Vue component with a default slot and defineProps.
  'src/components/info-card/info-card.html': `<div class="card">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-description></p>
  <div data-bascik-slot>No content provided.</div>
</div>
`,
  'src/components/info-card/info-card.css': `.card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; }
.card h3 { margin: 0 0 8px; font-size: 1.1rem; }
`,

  // Named slots, written the way the guide shows them: a wrapper element names the zone and is removed.
  'src/components/page-layout/page-layout.html': `<div class="layout">
  <header><div data-bascik-slot="header"></div></header>
  <main><div data-bascik-slot></div></main>
</div>
`,

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

  'src/components/site-nav/site-nav.html': `<nav class="nav">
  <div class="logo" data-bascik-prop-logo></div>
  <button id="toggle" class="toggle" aria-expanded="false">Menu</button>
  <ul id="links" class="links">
    <div data-bascik-slot></div>
  </ul>
</nav>
<script>
  const toggle = document.getElementById("toggle");
  const links = document.getElementById("links");
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(next));
    links.classList.toggle("open", next);
  });
</script>
`,
  'src/components/site-nav/site-nav.css': `.nav { display: flex; align-items: center; gap: 16px; }
.links { display: none; }
.links.open { display: flex; }
`,

  // A component that is only printed by a build script, and a component that reads the document.
  'src/components/post-link/post-link.html': `<li class="post-link"><a data-bascik-attr-href="href" data-bascik-prop-title></a></li>
`,
  'src/components/early-reader/early-reader.html': `<p id="out">pending</p>
<script>
  const out = document.getElementById('out');
  const early = Boolean(document.getElementById('late'));
  document.addEventListener('DOMContentLoaded', () => {
    out.textContent = 'early:' + early + ' loaded:' + Boolean(document.getElementById('late'));
  });
</script>
`,

  'src/lib/escape.ts': `export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
`,

  // Arrays and objects: JSON in a slot, as in the guide's "Arrays and objects" section.
  'src/data/rows.ts': `export const rows = [{ name: '</script><b>bold</b> & "quoted"', n: 1 }, { name: 'plain', n: 2 }];
`,
  'src/lib/json-script.ts': `// Escape \`<\` so no value can end the script early.
export const jsonScript = (value: unknown) =>
  \`<script type="application/json">\${JSON.stringify(value).replaceAll('<', () => '\\\\u003c')}</script>\`;
`,
  'src/components/data-grid/data-grid.html': `<div hidden id="input"><div data-bascik-slot></div></div>
<p id="out"></p>
<script>
  const { rows } = JSON.parse(document.getElementById('input').firstElementChild.textContent);
  document.getElementById('out').textContent = rows.map((row) => row.name + '=' + row.n).join(';');
</script>
`,
  'src/pages/data.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Data</title></head>
<body>
<data-grid>
  <script data-bascik-build>
    import { rows } from '@/data/rows.ts';
    import { jsonScript } from '@/lib/json-script.ts';
    console.log(jsonScript({ rows }));
  </script>
</data-grid>
</body></html>
`,

  'content/posts/hello.md': '# Hello\n',
  'content/posts/second-post.md': '# Second\n',
  'content/posts/Bad Name&.md': '# Skipped\n',

  'src/pages/index.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Claims</title></head>
<body>
<info-card data-bascik-prop-title="Use &lt;b&gt; &amp; &quot;quotes&quot;" data-bascik-prop-description="Up and running in minutes."><p>Card content here.</p></info-card>
<info-card data-bascik-prop-title="Empty" data-bascik-prop-description="No children."></info-card>
<page-layout>
  <div data-bascik-slot="header"><h1>My Page</h1></div>
  <p>Body content here.</p>
</page-layout>
<my-counter></my-counter>
<my-counter></my-counter>
<site-nav data-bascik-prop-logo="Acme"><li><a href="/">Home</a></li><li><a href="/about">About</a></li></site-nav>
<site-nav data-bascik-prop-logo="Two"><li><a href="/">Home</a></li></site-nav>
<early-reader></early-reader>
<p id="late">late element</p>
<ul>
  <script data-bascik-build>
    import { readdir } from 'node:fs/promises';
    import { escapeHtml } from '@/lib/escape.ts';
    const files = await readdir('./content/posts');
    const slugs = files.filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3)).filter((slug) => /^[a-z0-9-]+$/.test(slug));
    console.log(slugs.map((slug) => '<post-link data-bascik-prop-href="/blog/' + escapeHtml(slug) + '" data-bascik-prop-title="' + escapeHtml(slug) + '"></post-link>').join('\\n'));
  </script>
</ul>
<script data-bascik-build>
  console.log(process.env.BASCIK_BUILD === '1' ? '<p>built for production</p>' : '<p>development server</p>');
</script>
</body></html>
`,
  // The guide's old form: the usage element is the wrapper, so it is removed with its tag.
  'src/pages/pitfall.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pitfall</title></head>
<body>
<page-layout>
  <h1 data-bascik-slot="header">My Page</h1>
  <p>Body content here.</p>
</page-layout>
</body></html>
`,
  'src/pages/blog/[slug].html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Post</title></head>
<body>
<script data-bascik-routes>
  console.log(JSON.stringify([{ params: { slug: 'hello' }, data: { title: 'Hello' } }, { params: { slug: 'second-post' }, data: { title: 'Second' } }]));
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
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bascik-vue-guide-')));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...(tarball ? [tarball] : [])], directory, process.env);
});

after(async () => {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
});

async function build() {
  const handle = launch([process.execPath, BASCIK_BIN, '--build'], directory, { ...process.env });
  const result = await handle.completion;
  const output = handle.output();
  await handle.stop();
  assert.equal(result.code, 0, output);
  return output;
}

async function serve({ dev }) {
  const port = await unusedPort();
  const handle = launch([process.execPath, BASCIK_BIN, ...(dev ? [] : ['--server']), '--port', String(port), '--host', '127.0.0.1'], directory, { ...process.env });
  const site = { url: `http://127.0.0.1:${port}` };
  const deadline = Date.now() + 30000;
  for (;;) {
    handle.assertAlive();
    try { if ((await fetch(site.url + '/')).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((accept) => setTimeout(accept, 50));
  }
  if (dev) await waitForFirstBuild(site, 'dev');
  return { site, stop: () => handle.stop() };
}

// `early` is what a component script sees of a later element: the dev server and `minify.html: false`
// leave scripts where the component is, production minification moves them to the end of the document.
async function checkPage({ dev, early }) {
  const server = await serve({ dev });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  try {
    await page.goto(`${server.site.url}/`);

    // Default slot, fallback, and text props with escaped markup.
    assert.equal(await page.locator('h3').count(), 2);
    assert.equal(await page.locator('h3').first().textContent(), 'Use <b> & "quotes"');
    assert.equal(await page.getByText('Card content here.').count(), 1);
    assert.equal(await page.getByText('No content provided.').count(), 1, 'fallback only where the tag is empty');
    assert.equal(await page.locator('h3').first().evaluate((h) => getComputedStyle(h).fontSize), '17.6px', 'scoped style applies');
    assert.equal(await page.locator('h3').first().evaluate((h) => getComputedStyle(h.parentElement).paddingTop), '24px');

    // Named slot written with a wrapper element.
    assert.equal(await page.locator('header h1').textContent(), 'My Page');

    // Counters are independent.
    const buttons = page.getByRole('button', { name: '+' });
    await buttons.nth(0).click();
    await buttons.nth(0).click();
    await buttons.nth(0).click();
    await buttons.nth(1).click();
    const counts = await page.locator('span').evaluateAll((spans) => spans.map((span) => span.textContent));
    assert.deepEqual(counts, ['3', '1']);

    // The navigation toggles per instance and the slot content is a real list.
    const menus = page.getByRole('button', { name: 'Menu' });
    assert.equal(await page.getByRole('link', { name: 'About' }).isVisible(), false);
    await menus.nth(0).click();
    assert.equal(await menus.nth(0).getAttribute('aria-expanded'), 'true');
    assert.equal(await menus.nth(1).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('link', { name: 'About' }).isVisible(), true);
    assert.equal(await page.getByRole('link', { name: 'Home' }).nth(1).isVisible(), false, 'the second menu stays closed');
    await menus.nth(0).click();
    assert.equal(await page.getByRole('link', { name: 'About' }).isVisible(), false);
    assert.equal(await page.locator('nav ul > li').count(), 3, 'the slot wrapper in the list is gone');

    // Lifecycle: where a component script runs decides whether a later element exists yet.
    assert.deepEqual(await page.getByText(/^early:/).allTextContents(), [`early:${early} loaded:true`]);

    // A build script prints component tags, escaped values, and a build-time branch.
    const links = await page.locator('li a[href^="/blog/"]').evaluateAll((anchors) => anchors.map((anchor) => [anchor.getAttribute('href'), anchor.textContent]));
    assert.deepEqual(links.sort(), [['/blog/hello', 'hello'], ['/blog/second-post', 'second-post']]);
    assert.ok(await page.getByText(dev ? 'development server' : 'built for production').isVisible());
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
  await checkPage({ dev: false, early: true });
});

test('guide examples behave as documented in the development server', async () => {
  await checkPage({ dev: true, early: false });
});

test('a named-slot wrapper is removed together with its tag', async () => {
  await build();
  const html = await readFile(join(directory, 'dist/pitfall.html'), 'utf8');
  assert.match(html, /<header>My Page<\/header>/, 'the h1 written as the wrapper is gone');
  assert.doesNotMatch(html, /<h1/);
});

test('dynamic routes replace one file per URL', async () => {
  await build();
  const hello = await readFile(join(directory, 'dist/blog/hello.html'), 'utf8');
  const second = await readFile(join(directory, 'dist/blog/second-post.html'), 'utf8');
  assert.match(hello, /<h1>Hello<\/h1><p>hello<\/p>/);
  assert.match(second, /<h1>Second<\/h1><p>second-post<\/p>/);
});

test('a tag name without a hyphen warns', async () => {
  await mkdir(join(directory, 'src/components/card'), { recursive: true });
  await writeFile(join(directory, 'src/components/card/card.html'), '<div class="card"><div data-bascik-slot>No content provided.</div></div>\n');
  await writeFile(join(directory, 'src/pages/plain-card.html'), '<!doctype html>\n<html lang="en"><head><title>x</title></head><body><card><p>hi</p></card></body></html>\n');
  try {
    assert.match(await build(), /Component "card" is not hyphenated/);
  } finally {
    await rm(join(directory, 'src/components/card'), { recursive: true, force: true });
    await rm(join(directory, 'src/pages/plain-card.html'), { force: true });
  }
});

test('with minify.html off, production keeps component scripts where they are written', async () => {
  const configPath = join(directory, 'bascik.config.ts');
  const original = await readFile(configPath, 'utf8');
  await writeFile(configPath, original.replace('generate:', () => 'minify: { html: false }, generate:'));
  try {
    await build();
    await checkPage({ dev: false, early: false });
  } finally {
    await writeFile(configPath, original);
  }
});

test('arrays and objects reach a component as JSON in a slot', async () => {
  await build();
  const server = await serve({ dev: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${server.site.url}/data.html`);
    assert.equal(await page.getByText(/^<\/script>/).textContent(), '</script><b>bold</b> & "quoted"=1;plain=2');
    assert.equal(await page.locator('b').count(), 0, 'the value did not become markup');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await server.stop();
  }
});
