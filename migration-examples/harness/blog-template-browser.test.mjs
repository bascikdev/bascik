import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, launch, unusedPort } from './runner.mjs';
import { ORIGIN } from './blog-template-checks.mjs';

// Task 06: the blog starter in a real browser, against minified production output served by
// `bascik --server`. Production hashes class names and ids, so every element a check needs is
// found by what a reader sees (roles, link text, headings) or by tag, never by a class name.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const templateSource = fileURLToPath(new URL('../../templates/blog/', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const BIN = 'node_modules/@bascik/bascik/bin/bascik.js';

let browser;
let root;
let project;
let server;
let url;

async function run(command, cwd, env, timeoutMs = 240000) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
}

before(async () => {
  assert.ok(tarball, 'Set BASCIK_TARBALL to a freshly packed local source artifact');
  await access(tarball);
  browser = await chromium.launch();
  root = await realpath(await mkdtemp(join(tmpdir(), 'bascik-blog-browser-')));
  assertOutsideRepository(root, repository);
  project = join(root, 'project');
  await cp(templateSource, project, { recursive: true, filter: (path) => !/[\\/](node_modules|dist|\.bascik)$/.test(path) });
  const env = { ...process.env, BASCIK_SITE_URL: ORIGIN };
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], project, env);
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], project, env);
  await run([process.execPath, BIN, '--build'], project, env);
  const html = await readFile(join(project, 'dist/blog/welcome/index.html'), 'utf8');
  // Classes that no component stylesheet defines stay global, so they are not hashed. What
  // production changes here is the HTML whitespace and the inlined stylesheet.
  assert.doesNotMatch(html, /Global stylesheet, inlined into every page/, 'the inlined CSS comment is stripped, so the build under test is minified');
  assert.doesNotMatch(html, /<\/li>\s+<li/, 'whitespace between tags in the body is minified');
  const port = await unusedPort();
  server = launch([process.execPath, BIN, '--server', '--port', String(port), '--host', '127.0.0.1'], project, env);
  url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    server.assertAlive();
    try { if ((await fetch(`${url}/`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error('production server never answered');
});

after(async () => {
  await browser?.close();
  await server?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function open(viewport, path, { scheme = 'light', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
  page.on('response', (response) => { if (response.status() >= 400 && response.url().startsWith(url)) problems.push(`${response.status()}: ${response.url()}`); });
  const response = await page.goto(url + path, { waitUntil: 'load' });
  return { context, page, response, problems };
}

const overflow = (page) => page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));

for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name}: every page lays out without horizontal overflow, console errors, or failed requests`, async () => {
    for (const path of ['/', '/blog/', '/blog/page/2/', '/tags/', '/tags/basics/', '/about/', '/blog/writing-posts/', '/blog/images-and-figures/', '/blog/customizing-the-site/']) {
      const { context, page, problems } = await open(viewport, path);
      try {
        const size = await overflow(page);
        assert.ok(size.content <= size.viewport, `${name} ${path}: scrollWidth ${size.content} exceeds ${size.viewport}`);
        assert.deepEqual(problems, [], `${name} ${path}`);
        assert.equal(await page.locator('h1').count(), 1, `${name} ${path}: exactly one h1`);
      } finally { await context.close(); }
    }
  });
}

test('mobile: images load at the right size and a phone is not sent the largest file', async () => {
  const { context, page } = await open({ width: 390, height: 844 }, '/blog/images-and-figures/');
  try {
    await page.getByRole('img', { name: /sunset over a small harbor/i }).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('main img')].every((image) => image.complete && image.naturalWidth > 0));
    const image = await page.getByRole('img', { name: /sunset over a small harbor/i }).evaluate((node) => ({
      current: node.currentSrc, natural: node.naturalWidth, shown: node.clientWidth, height: node.clientHeight,
    }));
    assert.match(image.current, /harbor-(480|960)w\.png$/, `currentSrc is a smaller copy, got ${image.current}`);
    assert.ok(image.shown <= 390, 'the image fits the viewport');
    assert.ok(Math.abs(image.height / image.shown - 675 / 1200) < 0.01, 'the width and height attributes keep the picture\'s shape');
  } finally { await context.close(); }
});

test('desktop: a wide window picks a larger copy than a phone does', async () => {
  const { context, page } = await open({ width: 1280, height: 900 }, '/blog/images-and-figures/');
  try {
    await page.getByRole('img', { name: /sunset over a small harbor/i }).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('main img')].every((image) => image.complete && image.naturalWidth > 0));
    const current = await page.getByRole('img', { name: /sunset over a small harbor/i }).evaluate((node) => node.currentSrc);
    assert.match(current, /harbor(-960w)?\.png$/, `got ${current}`);
  } finally { await context.close(); }
});

test('keyboard: the first Tab reaches the skip link, which moves focus to main content', async () => {
  const { context, page } = await open({ width: 390, height: 844 }, '/blog/writing-posts/');
  try {
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await skip.waitFor({ state: 'visible' });
    assert.equal(await skip.evaluate((node) => node === document.activeElement), true, 'skip link has focus');
    const box = await skip.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.width > 40, 'the focused skip link is visible on screen');
    await page.keyboard.press('Enter');
    assert.match(page.url(), /#main$/);
    // Following a fragment moves the sequential focus starting point to the target without making
    // it the active element, so the proof that the header was skipped is where the next Tab lands.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('main')?.contains(document.activeElement)), true, 'the next Tab lands inside the main content, not in the header');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('header, nav') === null), true, 'and not in the header');
  } finally { await context.close(); }
});

test('keyboard: header navigation is reachable in order and marks the current page', async () => {
  const { context, page } = await open({ width: 1280, height: 900 }, '/blog/');
  try {
    const names = [];
    await page.keyboard.press('Tab'); // skip link
    for (let n = 0; n < 6; n++) {
      await page.keyboard.press('Tab');
      names.push(await page.evaluate(() => document.activeElement?.textContent?.trim()));
    }
    assert.deepEqual(names, ['Lantern Log', 'Home', 'Archive', 'Tags', 'About', 'Feed']);
    const current = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Archive' });
    assert.equal(await current.getAttribute('aria-current'), 'page');
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).locator('[aria-current]').count(), 1, 'exactly one entry is current');
    await page.getByRole('link', { name: 'Tags', exact: true }).focus();
    await Promise.all([page.waitForURL('**/tags/'), page.keyboard.press('Enter')]);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Tags');
  } finally { await context.close(); }
});

test('keyboard: the archive pager and post neighbors work without a mouse', async () => {
  const { context, page } = await open({ width: 390, height: 844 }, '/blog/');
  try {
    const older = page.getByRole('link', { name: /Older posts/ });
    await older.focus();
    await Promise.all([page.waitForURL('**/blog/page/2/'), page.keyboard.press('Enter')]);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Archive, page 2');
    const newer = page.getByRole('link', { name: /Newer posts/ });
    await newer.focus();
    await Promise.all([page.waitForURL((address) => address.pathname === '/blog/'), page.keyboard.press('Enter')]);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Archive');

    await page.goto(`${url}/blog/writing-posts/`);
    const next = page.getByRole('link', { name: 'Images and figures' });
    await next.focus();
    await Promise.all([page.waitForURL('**/blog/images-and-figures/'), page.keyboard.press('Enter')]);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Images and figures');
  } finally { await context.close(); }
});

test('keyboard: a heading anchor can be reached, shows on focus, and jumps to its section', async () => {
  const { context, page } = await open({ width: 1280, height: 900 }, '/blog/writing-posts/');
  try {
    const anchor = page.getByRole('link', { name: 'Jump to section titled: Headings get anchors' });
    await anchor.focus();
    assert.equal(await anchor.evaluate((node) => getComputedStyle(node).opacity), '1', 'a focused anchor is fully visible');
    await page.keyboard.press('Enter');
    assert.match(page.url(), /#headings-get-anchors$/);
    const heading = page.getByRole('heading', { name: 'Headings get anchors', level: 2 });
    assert.equal(await heading.getAttribute('id'), 'headings-get-anchors');
    // The heading's accessible name is its text only; the decorative "#" placeholder is hidden.
    assert.equal(await page.getByRole('heading', { name: 'Headings get anchors', exact: true, level: 2 }).count(), 1);
  } finally { await context.close(); }
});

test('keyboard: a code block that scrolls sideways can be focused and scrolled', async () => {
  const { context, page } = await open({ width: 390, height: 844 }, '/blog/writing-posts/');
  try {
    const block = page.locator('pre').first();
    await block.focus();
    assert.equal(await block.evaluate((node) => node === document.activeElement), true);
    const scrolls = await block.evaluate((node) => node.scrollWidth > node.clientWidth);
    assert.equal(scrolls, true, 'at 390 px the sample block is wider than the screen, so it must scroll inside itself');
    await page.keyboard.press('ArrowRight');
    // Smooth scrolling (the default without a reduced-motion preference) animates the move.
    await page.waitForFunction(() => document.querySelector('pre').scrollLeft > 0, null, { timeout: 5000 });
    assert.ok(await block.evaluate((node) => node.scrollLeft) > 0, 'ArrowRight scrolls the focused block');
    const size = await overflow(page);
    assert.ok(size.content <= size.viewport, 'the page itself does not overflow');
  } finally { await context.close(); }
});

test('the dark color scheme changes the page colors and keeps text readable', async () => {
  const light = await open({ width: 1280, height: 900 }, '/blog/writing-posts/', { scheme: 'light' });
  const dark = await open({ width: 1280, height: 900 }, '/blog/writing-posts/', { scheme: 'dark' });
  try {
    const colors = (page) => page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const link = getComputedStyle(document.querySelector('main a[href]'));
      return { background: body.backgroundColor, text: body.color, link: link.color };
    });
    const a = await colors(light.page);
    const b = await colors(dark.page);
    assert.notEqual(a.background, b.background);
    const luminance = (rgb) => {
      const [r, g, bl] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const ratio = (x, y) => { const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m); return (hi + 0.05) / (lo + 0.05); };
    for (const [scheme, c] of [['light', a], ['dark', b]]) {
      assert.ok(ratio(c.text, c.background) >= 7, `${scheme} body text contrast ${ratio(c.text, c.background).toFixed(2)}`);
      assert.ok(ratio(c.link, c.background) >= 4.5, `${scheme} link contrast ${ratio(c.link, c.background).toFixed(2)}`);
    }
  } finally { await light.context.close(); await dark.context.close(); }
});

test('the 404 page is a real page for a visitor, with a status of 404 and a way home', async () => {
  const { context, page, response } = await open({ width: 390, height: 844 }, '/blog/does-not-exist/');
  try {
    assert.equal(response.status(), 404);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Page not found');
    await Promise.all([page.waitForURL(`${url}/`), page.getByRole('link', { name: 'home', exact: true }).click()]);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Latest posts');
  } finally { await context.close(); }
});

test('no JavaScript ships to the browser, and the page works with scripting disabled', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${url}/blog/writing-posts/`);
    assert.equal(await page.locator('script').count(), 0, 'no script elements');
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Writing posts');
    await Promise.all([page.waitForURL('**/blog/welcome/'), page.getByRole('link', { name: 'the welcome post' }).click()]);
  } finally { await context.close(); }
});

test('print hides navigation and keeps the article', async () => {
  const { context, page } = await open({ width: 1280, height: 900 }, '/blog/writing-posts/');
  try {
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).isVisible(), false);
    assert.equal(await page.getByRole('heading', { level: 1 }).isVisible(), true);
  } finally { await context.close(); }
});
