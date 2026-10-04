import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DRAFT, PAGES, POSTS, SITE, bySlug, listings, routes } from './wordpress-blog-expected.mjs';

// Behavior checks for task 09. `checkSite` runs against both the seeded WordPress (Twenty
// Twenty-Five) and the Bascik port. It locates content by role, heading level, link target, and
// visible text, never by theme class names, so one assertion means the same thing on both. The
// other checks are about the port only (static output, sanitizing, minified build, keyboard).

const normalize = (value) => value.replace(/\s+/g, ' ').trim();
const local = (site, href) => {
  const url = new URL(href, site.url);
  return url.origin === site.url ? url.pathname + url.search + url.hash : href;
};

export async function withPage(browser, viewport, action, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  try {
    return await action(await context.newPage(), context);
  } finally {
    await context.close();
  }
}

/** Plain-text post titles in a listing, in order: headings that link to a post permalink. */
async function listedSlugs(page) {
  return page.evaluate((paths) => [...document.querySelectorAll('main h2 a, main h3 a')]
    .map((link) => new URL(link.href).pathname)
    .filter((path) => paths.includes(path)), POSTS.map((post) => post.path))
    .then((paths) => paths.map((path) => POSTS.find((post) => post.path === path).slug));
}

/**
 * Shared checks. `title` is the expected title for this implementation; WordPress curls straight
 * quotes in titles (wptexturize), the port does not.
 */
export async function checkSite(browser, site, label, { titleOf = (post) => post.title, dev = false, resizedImages = true } = {}) {
  // Every route answers 200 with HTML, an unknown path answers 404, a draft is not published.
  for (const path of routes()) {
    const response = await fetch(site.url + path);
    await response.arrayBuffer();
    assert.equal(response.status, 200, `${label}: ${path} status`);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/, `${label}: ${path} type`);
  }
  // An empty category (WordPress keeps "Uncategorized") is a 200 "nothing found" archive in
  // WordPress and has no page in the port; that difference is recorded, not shared.
  for (const path of ['/does-not-exist/', '/2026/01/12/no-such-post/', '/page/4/']) {
    const response = await fetch(site.url + path);
    await response.arrayBuffer();
    assert.equal(response.status, 404, `${label}: ${path} is 404`);
  }
  if (!dev) {
    for (const path of ['/2026/08/01/unfinished/', '/unfinished/']) {
      const response = await fetch(site.url + path);
      assert.equal(response.status, 404, `${label}: draft ${path} is not published`);
      assert.doesNotMatch(await response.text(), new RegExp(DRAFT.title), `${label}: draft title absent at ${path}`);
    }
  }

  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    // Listings: heading, post order, pagination links.
    for (const entry of listings()) {
      await page.goto(site.url + entry.path);
      assert.equal(normalize(await page.locator('main h1').first().innerText()), entry.heading, `${label}: ${entry.path} heading`);
      assert.deepEqual(await listedSlugs(page), entry.titles, `${label}: ${entry.path} posts`);
      const next = page.locator('main a', { hasText: /^Next Page/ });
      const previous = page.locator('main a', { hasText: /Previous Page$/ });
      const total = listings().filter((other) => other.heading === entry.heading).length;
      assert.equal(await next.count(), entry.page < total ? 1 : 0, `${label}: ${entry.path} next link`);
      assert.equal(await previous.count(), entry.page > 1 ? 1 : 0, `${label}: ${entry.path} previous link`);
      if (entry.page < total) {
        const target = listings().find((other) => other.heading === entry.heading && other.page === entry.page + 1);
        assert.equal(local(site, await next.getAttribute('href')), target.path, `${label}: ${entry.path} next target`);
      }
    }

    // Posts: title, document title, categories, tags, neighbors, content.
    for (const [index, post] of POSTS.entries()) {
      await page.goto(site.url + post.path);
      const title = titleOf(post);
      assert.equal(normalize(await page.locator('main h1').first().innerText()), title, `${label}: ${post.slug} h1`);
      assert.equal(await page.title(), `${title} – ${SITE.name}`, `${label}: ${post.slug} document title`);
      const links = await page.evaluate(() => [...document.querySelectorAll('main a[rel~="tag"]')].map((link) => new URL(link.href).pathname));
      for (const slug of post.categories) assert.ok(links.includes(`/category/${slug}/`), `${label}: ${post.slug} links category ${slug}`);
      for (const slug of post.tags) assert.ok(links.includes(`/tag/${slug}/`), `${label}: ${post.slug} links tag ${slug}`);
      const prev = page.locator('main a[rel="prev"]');
      const next = page.locator('main a[rel="next"]');
      const older = POSTS[index + 1];
      const newer = POSTS[index - 1];
      assert.equal(await prev.count(), older ? 1 : 0, `${label}: ${post.slug} previous`);
      assert.equal(await next.count(), newer ? 1 : 0, `${label}: ${post.slug} next`);
      if (older) assert.equal(local(site, await prev.getAttribute('href')), older.path, `${label}: ${post.slug} previous target`);
      if (newer) assert.equal(local(site, await next.getAttribute('href')), newer.path, `${label}: ${post.slug} next target`);
    }

    // Content that went through the editor: headings, lists, figure, code, table, quote, entities.
    await page.goto(site.url + bySlug('first-frost').path);
    assert.equal(normalize(await page.locator('main h2', { hasText: 'What we covered' }).innerText()), 'What we covered', `${label}: content heading`);
    assert.equal(await page.locator('main li', { hasText: 'The young garlic' }).count(), 1, `${label}: content list`);
    await page.goto(site.url + bySlug('tool-shed').path);
    const figure = page.locator('main figure', { has: page.locator('img[alt="Seed trays drawn as brown and white stripes"]') });
    assert.equal(normalize(await figure.locator('figcaption').innerText()), 'Trays waiting on the new shelf.', `${label}: figure caption`);
    // The browser picks a srcset candidate for the column width, so only "it loaded" is shared.
    const inline = await figure.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0);
    assert.equal(inline, true, `${label}: inline image loads`);
    assert.match(await page.locator('main pre').innerText(), /cut 4 studs at 2390 mm\nfasten with 90 mm screws/, `${label}: code block keeps lines`);
    await page.goto(site.url + bySlug('harvest-log').path);
    assert.deepEqual(await page.locator('main table td').allInnerTexts(), ['Beans', '14', 'Zucchini', '31'], `${label}: table cells`);
    await page.goto(site.url + bySlug('raised-beds').path);
    assert.equal(normalize(await page.locator('main blockquote').innerText()), 'Feed the soil, not the plant.', `${label}: quote`);
    const featured = page.locator('main img[alt="Rows of raised beds drawn as green and white stripes"]');
    assert.equal(await featured.count(), 1, `${label}: featured image`);
    assert.equal(await featured.evaluate((image) => image.complete && image.naturalWidth > 0), true, `${label}: featured image loads`);
    // The REST API lists WordPress's resized copies; the WXR converter saves only the original.
    if (resizedImages) assert.match(await featured.getAttribute('srcset') ?? '', /300w/, `${label}: featured image offers smaller sizes`);
    else assert.equal(await featured.getAttribute('srcset'), null, `${label}: no resized copies without the REST API`);
    await page.goto(site.url + bySlug('ampersands').path);
    assert.match(await page.locator('main').innerText(), /Fish & Chips, 3 < 5, \$1 and \$&\./, `${label}: entities and replacement tokens survive`);

    // Pages and the page menu: parent and child, current page.
    for (const entry of PAGES) {
      await page.goto(site.url + entry.path);
      assert.equal(normalize(await page.locator('main h1').first().innerText()), entry.title, `${label}: ${entry.slug} h1`);
      assert.match(await page.locator('main').innerText(), new RegExp(entry.text), `${label}: ${entry.slug} text`);
      const menu = await page.evaluate(() => [...document.querySelectorAll('header a')].map((link) => new URL(link.href).pathname));
      for (const other of PAGES) assert.ok(menu.includes(other.path), `${label}: header links ${other.path}`);
    }

    // Site title links home; the document title of the home page.
    await page.goto(site.url + '/');
    assert.equal(await page.title(), `${SITE.name} – ${SITE.description}`, `${label}: home document title`);
    assert.equal(await page.locator('header a[href]', { hasText: SITE.name }).count() >= 1, true, `${label}: site title link`);
  });
}

// ── Port-only checks ──────────────────────────────────────────────────────────────────────────

/** Hostile content from the editor never runs in the browser or at build time. */
export async function checkSanitized(browser, site, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(site.url + bySlug('pasted-embed').path);
    await page.waitForLoadState('load');
    const state = await page.evaluate(() => ({
      embed: window.__pastedEmbed ?? false,
      handler: window.__pastedHandler ?? false,
      scripts: document.querySelectorAll('main script').length,
      handlers: [...document.querySelectorAll('main *')].filter((element) => [...element.attributes].some((attribute) => attribute.name.startsWith('on'))).length,
      javascriptLinks: [...document.querySelectorAll('main a[href]')].filter((link) => link.getAttribute('href').trim().toLowerCase().startsWith('javascript:')).length,
      canary: document.getElementById('canary') !== null,
      text: document.querySelector('main').innerText,
    }));
    assert.deepEqual(
      { embed: state.embed, handler: state.handler, scripts: state.scripts, handlers: state.handlers, javascriptLinks: state.javascriptLinks, canary: state.canary },
      { embed: false, handler: false, scripts: 0, handlers: 0, javascriptLinks: 0, canary: false },
      `${label}: pasted markup is inert`,
    );
    assert.match(state.text, /Below is markup pasted from a third-party widget\./, `${label}: the safe part of the post remains`);
    assert.match(state.text, /a javascript link/, `${label}: link text remains`);
    assert.deepEqual(errors, [], `${label}: no page errors`);
  });
}

/** Static output: no client scripts on any page, no build-time side effects, expected files. */
export async function checkBuildOutput(site, label) {
  const dist = join(site.cwd, 'dist');
  await assert.rejects(stat(join(site.cwd, 'BASCIK_CANARY')), { code: 'ENOENT' }, `${label}: no build-time code from content ran`);
  const html = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.bascik') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.html')) html.push(path);
    }
  };
  await walk(dist);
  for (const file of html) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /<script\b/i, `${label}: ${file.slice(dist.length)} ships no script`);
    assert.doesNotMatch(text, /data-bascik-/, `${label}: ${file.slice(dist.length)} has no directive left`);
    assert.doesNotMatch(text, /127\.0\.0\.1/, `${label}: ${file.slice(dist.length)} has no link to the old WordPress host`);
  }
  for (const file of ['feed.xml', 'sitemap.xml', 'robots.txt', '404.html']) {
    await stat(join(dist, file));
  }
}

export async function checkFeed(site, label, origin) {
  const response = await fetch(site.url + '/feed.xml');
  assert.equal(response.status, 200, `${label}: feed status`);
  assert.match(response.headers.get('content-type') ?? '', /xml/, `${label}: feed type`);
  const xml = await response.text();
  const links = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]*)<\/link>/g)].map((match) => match[1]);
  assert.deepEqual(links, POSTS.map((post) => origin + post.path), `${label}: feed items in order with absolute links`);
  assert.doesNotMatch(xml, /<script|onerror|javascript:/i, `${label}: feed content is sanitized`);
  assert.match(xml, /src="https:\/\/[^"]+\/2026\/02\/03\/tool-shed\/|src="https:\/\/[^"]+\/wp-content\/uploads\//, `${label}: feed image URLs are absolute`);
}

export async function checkSitemap(site, label, origin) {
  const xml = await (await fetch(site.url + '/sitemap.xml')).text();
  const listed = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => new URL(match[1]).pathname).sort();
  assert.deepEqual(listed, routes().sort(), `${label}: sitemap lists every route once`);
  assert.ok(xml.includes(origin), `${label}: sitemap uses the site URL`);
}

/** Keyboard, mobile layout, current page, and dark-mode contrast on minified production output. */
export async function checkInteraction(browser, site, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/about/colophon/');
    await page.keyboard.press('Tab');
    const skip = page.getByTestId('skip-link');
    assert.equal(await skip.evaluate((element) => element === document.activeElement), true, `${label}: first Tab reaches the skip link`);
    assert.equal(await skip.isVisible(), true, `${label}: focused skip link is visible`);
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, '#main', `${label}: skip link targets main`);
    assert.equal(await page.getByTestId('site-menu').getByRole('link', { name: 'Colophon' }).getAttribute('aria-current'), 'page', `${label}: current page marked`);

    await page.goto(site.url + '/');
    const next = page.getByTestId('pagination-next');
    await next.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/page\/2\/$/);
    assert.deepEqual(await listedSlugs(page), listings()[1].titles, `${label}: keyboard pagination reaches page 2`);
  });
  for (const scheme of ['light', 'dark']) {
    await withPage(browser, { width: 390, height: 800 }, async (page) => {
      for (const path of ['/', bySlug('tool-shed').path, bySlug('harvest-log').path, '/about/colophon/', '/does-not-exist/']) {
        await page.goto(site.url + path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `${label}: ${path} has no sideways scroll at 390px (${scheme}, ${overflow}px)`);
      }
      const contrast = await page.evaluate(() => {
        const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = ([r, g, b]) => {
          const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const background = parse(getComputedStyle(document.body).backgroundColor);
        const text = parse(getComputedStyle(document.body).color);
        const link = parse(getComputedStyle(document.querySelector('main a')).color);
        return { text: ratio(text, background), link: ratio(link, background) };
      });
      assert.ok(contrast.text >= 7, `${label}: ${scheme} text contrast ${contrast.text.toFixed(2)}`);
      assert.ok(contrast.link >= 4.5, `${label}: ${scheme} link contrast ${contrast.link.toFixed(2)}`);
    }, { colorScheme: scheme });
  }
}

/** Production output is minified: scoped class names are hashed, not readable. */
export async function checkMinified(site, label) {
  const html = await (await fetch(site.url + '/')).text();
  assert.doesNotMatch(html, /\n\s{2,}</, `${label}: HTML is minified`);
  assert.doesNotMatch(html, /class="site-header"/, `${label}: component classes are hashed`);
}
