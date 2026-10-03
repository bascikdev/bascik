import assert from 'node:assert/strict';
import { SITE_ORIGIN } from './astro-blog-expected.mjs';

// Behavior checks shared by the pinned Astro blog and the Bascik port.
// Locators use roles, text, and computed style, never framework-specific class names
// or attributes, so the same assertions can run against both implementations.

const normalizePath = (path) => (path.length > 1 ? path.replace(/\/$/, '') : path);

// The pinned Astro blog parses `pubDate: 'Jul 08 2022'` as local midnight, so its machine-readable
// datetime shifts with the build machine's time zone. Require the same calendar day, not the
// same instant.
const sameDay = (actual, iso) => Math.abs(Date.parse(actual) - Date.parse(`${iso}T00:00:00.000Z`)) < 24 * 3600 * 1000;

export function routesOf(expected) {
  return ['/', '/about/', '/blog/', ...expected.posts.map((post) => `/blog/${post.slug}/`)];
}

async function fetchText(site, path) {
  const response = await fetch(site.url + path);
  return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
}

function xmlValue(block, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!match) return null;
  return match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
}

async function imagesLoad(page, scope) {
  const images = page.locator(`${scope} img`);
  const count = await images.count();
  for (let index = 0; index < count; index++) await images.nth(index).scrollIntoViewIfNeeded();
  await page.waitForFunction((selector) => {
    const found = [...document.querySelectorAll(`${selector} img`)];
    return found.length > 0 && found.every((image) => image.complete && image.naturalWidth > 0);
  }, scope, { timeout: 5000 });
  return count;
}

function expectedPage(expected, path) {
  if (path === '/') return { title: expected.siteTitle, description: expected.siteDescription };
  if (path === '/blog/') return { title: expected.siteTitle, description: expected.siteDescription };
  if (path === '/about/') return { title: expected.about.title, description: expected.about.description };
  const post = expected.posts.find((entry) => `/blog/${entry.slug}/` === path);
  return { title: post.title, description: post.description };
}

async function withPage(browser, viewport, action) {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    return await action(page);
  } finally {
    await context.close();
  }
}

export async function checkRoutesAndErrors(site, expected, label) {
  for (const path of routesOf(expected)) {
    const result = await fetchText(site, path);
    assert.equal(result.status, 200, `${label}: ${path} status`);
    assert.match(result.type, /text\/html/, `${label}: ${path} content type`);
  }
  for (const path of ['/missing/', '/blog/missing-post/']) {
    assert.equal((await fetch(site.url + path)).status, 404, `${label}: ${path} must be 404`);
  }
}

export async function checkMetadata(browser, site, expected, label, { dev = false } = {}) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    for (const path of routesOf(expected)) {
      await page.goto(site.url + path);
      const meta = await page.evaluate(() => {
        const attribute = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
        return {
          lang: document.documentElement.lang,
          title: document.title,
          charset: Boolean(document.querySelector('meta[charset]')),
          viewport: attribute('meta[name="viewport"]', 'content'),
          description: attribute('meta[name="description"]', 'content'),
          canonical: attribute('link[rel="canonical"]', 'href'),
          ogType: attribute('meta[property="og:type"]', 'content'),
          ogUrl: attribute('meta[property="og:url"]', 'content'),
          ogTitle: attribute('meta[property="og:title"]', 'content'),
          ogDescription: attribute('meta[property="og:description"]', 'content'),
          ogImage: attribute('meta[property="og:image"]', 'content'),
          twitter: attribute('meta[name="twitter:card"]', 'content'),
          rss: attribute('link[rel="alternate"][type="application/rss+xml"]', 'href'),
          sitemap: attribute('link[rel="sitemap"]', 'href'),
          icon: attribute('link[rel="icon"]', 'href'),
        };
      });
      const page_ = expectedPage(expected, path);
      const where = `${label}: ${path}`;
      assert.equal(meta.lang, 'en', `${where} lang`);
      assert.equal(meta.charset, true, `${where} charset`);
      assert.match(meta.viewport ?? '', /width=device-width/, `${where} viewport`);
      assert.equal(meta.title, page_.title, `${where} title`);
      assert.equal(meta.description, page_.description, `${where} description`);
      assert.equal(meta.canonical, SITE_ORIGIN + path, `${where} canonical`);
      assert.equal(meta.ogUrl, SITE_ORIGIN + path, `${where} og:url`);
      assert.equal(meta.ogType, 'website', `${where} og:type`);
      assert.equal(meta.ogTitle, page_.title, `${where} og:title`);
      assert.equal(meta.ogDescription, page_.description, `${where} og:description`);
      assert.equal(meta.twitter, 'summary_large_image', `${where} twitter:card`);
      assert.equal(meta.rss, `${SITE_ORIGIN}/rss.xml`, `${where} rss alternate`);
      assert.ok(meta.icon, `${where} icon`);
      assert.ok(meta.ogImage?.startsWith(SITE_ORIGIN + '/'), `${where} og:image must be absolute: ${meta.ogImage}`);
      const image = await fetch(site.url + new URL(meta.ogImage).pathname);
      assert.equal(image.status, 200, `${where} og:image must resolve on this server`);
      assert.match(image.headers.get('content-type') ?? '', /^image\//, `${where} og:image type`);
      // Sitemaps are generated by the build only. Bascik's dev server does not emit one.
      if (!dev) {
        const sitemap = await fetch(site.url + new URL(meta.sitemap, site.url).pathname);
        assert.equal(sitemap.status, 200, `${where} sitemap link must resolve`);
      }
    }
  });
}

export async function checkBlogIndex(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/blog/');
    const titles = await page.getByRole('heading', { level: 4 }).allTextContents();
    assert.deepEqual(titles, expected.posts.map((post) => post.title), `${label}: newest-first order`);
    const dates = await page.locator('main time').allTextContents();
    assert.deepEqual(dates.map((text) => text.trim()), expected.posts.map((post) => post.label), `${label}: date labels`);
    const datetimes = await page.locator('main time').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime')));
    expected.posts.forEach((post, index) => assert.ok(sameDay(datetimes[index], post.iso), `${label}: datetime ${datetimes[index]} for ${post.slug}`));
    const hrefs = await page.locator('main li a').evaluateAll((nodes) => nodes.map((node) => new URL(node.href).pathname));
    assert.deepEqual(hrefs, expected.posts.map((post) => `/blog/${post.slug}/`), `${label}: card links`);
    assert.equal(await imagesLoad(page, 'main'), expected.posts.length, `${label}: one hero image per card`);
    const boxes = await page.locator('main li').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    assert.ok(boxes[0] > boxes[1] * 1.6, `${label}: first card spans the row (${boxes[0]} vs ${boxes[1]})`);
    assert.ok(Math.abs(boxes[1] - boxes[2]) < 2, `${label}: remaining cards share a width`);
  });
  await withPage(browser, { width: 390, height: 844 }, async (page) => {
    await page.goto(site.url + '/blog/');
    const boxes = await page.locator('main li').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
    assert.equal(new Set(boxes).size, 1, `${label}: cards stack at one width on mobile ${boxes}`);
  });
}

export async function checkNavigation(browser, site, expected, label) {
  const cases = [['/', 'Home'], ['/blog/', 'Blog'], ['/blog/first-post/', 'Blog'], ['/about/', 'About']];
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    for (const [path, active] of cases) {
      await page.goto(site.url + path);
      const nav = page.getByRole('navigation');
      for (const name of ['Home', 'Blog', 'About']) {
        const style = await nav.getByRole('link', { name, exact: true }).evaluate((node) => {
          const computed = getComputedStyle(node);
          return {
            weight: Number(computed.fontWeight),
            underline: computed.textDecorationLine.includes('underline'),
            border: computed.borderBottomColor,
            // The header's own box-shadow and background must not leak onto link elements.
            shadow: computed.boxShadow,
            background: computed.backgroundColor,
          };
        });
        assert.equal(style.shadow, 'none', `${label}: ${path} ${name} box-shadow`);
        assert.equal(style.background, 'rgba(0, 0, 0, 0)', `${label}: ${path} ${name} background`);
        const isActive = name === active;
        // The pinned header stylesheet wins the cascade over the link's own underline rule, so the
        // active link is bold with an accent border and is not underlined.
        assert.equal(style.weight >= 700, isActive, `${label}: ${path} ${name} weight`);
        assert.equal(style.underline, false, `${label}: ${path} ${name} underline`);
        assert.equal(style.border, isActive ? 'rgb(35, 55, 255)' : 'rgba(0, 0, 0, 0)', `${label}: ${path} ${name} border`);
      }
    }
    await page.goto(site.url + '/');
    const nav = page.getByRole('navigation');
    const targets = {};
    for (const name of ['Home', 'Blog', 'About']) {
      targets[name] = normalizePath(await nav.getByRole('link', { name, exact: true }).evaluate((node) => new URL(node.href).pathname));
    }
    assert.deepEqual(targets, { Home: '/', Blog: '/blog', About: '/about' }, `${label}: nav targets`);
    await nav.getByRole('link', { name: expected.siteTitle, exact: true }).click();
    assert.equal(normalizePath(new URL(page.url()).pathname), '/', `${label}: title link goes home`);
    for (const [name, destination] of [['Blog', '/blog'], ['About', '/about']]) {
      await nav.getByRole('link', { name, exact: true }).click();
      await page.waitForURL((url) => normalizePath(url.pathname) === destination);
    }
  });
}

export async function checkChrome(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/');
    const header = page.getByRole('banner');
    const social = header.locator('a[target="_blank"]');
    assert.equal(await social.count(), 3, `${label}: header social links`);
    for (let index = 0; index < 3; index++) assert.ok(await social.nth(index).isVisible(), `${label}: header link ${index} visible on desktop`);
    const footer = page.getByRole('contentinfo');
    assert.match(await footer.innerText(), /© \d{4} Your name here\. All rights reserved\./, `${label}: footer text`);
    assert.equal(await footer.locator('a[target="_blank"]').count(), 3, `${label}: footer social links`);
    assert.match(await page.getByRole('heading', { level: 1 }).innerText(), expected.homeHeading, `${label}: home heading`);
  });
  await withPage(browser, { width: 390, height: 844 }, async (page) => {
    await page.goto(site.url + '/');
    const social = page.getByRole('banner').locator('a[target="_blank"]');
    for (let index = 0; index < 3; index++) assert.equal(await social.nth(index).isVisible(), false, `${label}: header social link ${index} hidden on mobile`);
    const footerLinks = page.getByRole('contentinfo').locator('a[target="_blank"]');
    for (let index = 0; index < 3; index++) assert.ok(await footerLinks.nth(index).isVisible(), `${label}: footer link ${index} visible on mobile`);
  });
}

export async function checkPosts(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    for (const post of expected.posts) {
      await page.goto(site.url + `/blog/${post.slug}/`);
      assert.equal(await page.getByRole('heading', { level: 1 }).first().innerText(), post.title, `${label}: ${post.slug} h1`);
      const time = page.locator('article time').first();
      assert.equal((await time.innerText()).trim(), post.label, `${label}: ${post.slug} date`);
      assert.ok(sameDay(await time.getAttribute('datetime'), post.iso), `${label}: ${post.slug} datetime`);
      const hero = page.locator('article img').first();
      assert.equal(await hero.getAttribute('width'), '1020', `${label}: ${post.slug} hero width`);
      assert.equal(await hero.getAttribute('height'), '510', `${label}: ${post.slug} hero height`);
      await imagesLoad(page, 'article');
    }
    await page.goto(site.url + '/about/');
    assert.equal(await page.getByRole('heading', { level: 1 }).first().innerText(), expected.about.title, `${label}: about h1`);
    assert.equal((await page.locator('article time').first().innerText()).trim(), expected.about.label, `${label}: about date`);
    await imagesLoad(page, 'article');
  });
}

export async function checkMarkdownFeatures(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/blog/markdown-style-guide/');
    const levels = await page.evaluate(() => {
      const count = {};
      for (let level = 2; level <= 6; level++) count[level] = document.querySelectorAll(`article h${level}`).length;
      return count;
    });
    assert.ok(levels[2] >= 8 && levels[3] >= 5 && levels[6] >= 1, `${label}: heading levels ${JSON.stringify(levels)}`);
    const ids = await page.locator('article h2').evaluateAll((nodes) => nodes.map((node) => node.id));
    for (const id of ['headings', 'paragraph', 'images', 'blockquotes', 'tables', 'code-blocks', 'list-types']) {
      assert.ok(ids.includes(id), `${label}: heading id "${id}" in ${ids}`);
    }
    assert.equal(await page.locator('article table').count(), 1, `${label}: one table`);
    assert.equal(await page.locator('article table th').count(), 3, `${label}: table columns`);
    assert.equal(await page.locator('article blockquote').count(), 2, `${label}: blockquotes`);
    assert.ok(await page.locator('article ol').count() >= 1 && await page.locator('article ul ul').count() >= 1, `${label}: ordered and nested lists`);
    for (const tag of ['abbr[title]', 'sub', 'sup', 'kbd', 'mark']) {
      assert.ok(await page.locator(`article ${tag}`).count() >= 1, `${label}: <${tag}> rendered`);
    }
    const blocks = await page.locator('article pre').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('tabindex')));
    assert.ok(blocks.length >= 3 && blocks.every((value) => value === '0'), `${label}: code blocks keyboard-scrollable ${blocks}`);
    assert.ok(await page.locator('article pre code').first().innerText().then((text) => text.length > 0), `${label}: code content`);
    assert.equal(await page.locator('article img').count(), 2, `${label}: hero plus one inline image`);
    await imagesLoad(page, 'article');
    const reference = page.locator('article sup a[href^="#"]').first();
    const referenceHref = await reference.getAttribute('href');
    await reference.click();
    assert.equal(new URL(page.url()).hash, referenceHref, `${label}: footnote reference moves to its target`);
    assert.ok(await page.locator(`[id="${referenceHref.slice(1)}"]`).isVisible(), `${label}: footnote target is visible`);
  });
}

export async function checkEmbeddedComponent(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/blog/using-mdx/');
    const link = page.getByRole('link', { name: expected.mdxComponentText, exact: true });
    assert.equal(await link.count(), 1, `${label}: embedded component renders`);
    const order = await page.evaluate((text) => {
      const link = [...document.querySelectorAll('article a')].find((node) => node.textContent.trim() === text);
      const find = (name) => [...document.querySelectorAll('article h2')].find((node) => node.textContent.trim() === name);
      const before = find('Example');
      const after = find('More Links');
      return {
        afterExample: Boolean(before && (before.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)),
        beforeLinks: Boolean(after && (after.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING)),
      };
    }, expected.mdxComponentText);
    assert.deepEqual(order, { afterExample: true, beforeLinks: true }, `${label}: component sits mid-document`);
    const dialog = new Promise((resolve) => page.once('dialog', async (event) => { const message = event.message(); await event.dismiss(); resolve(message); }));
    await link.click();
    assert.equal(await dialog, 'clicked!', `${label}: inline click handler runs`);
  });
}

export async function checkMobileAndKeyboard(browser, site, expected, label) {
  await withPage(browser, { width: 390, height: 844 }, async (page) => {
    for (const path of routesOf(expected)) {
      await page.goto(site.url + path);
      const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      assert.ok(width.content <= width.viewport, `${label}: ${path} overflows horizontally (${width.content} > ${width.viewport})`);
    }
    await page.goto(site.url + '/');
    let reached = false;
    for (let press = 0; press < 12 && !reached; press++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.tagName === 'A' && document.activeElement.textContent.trim() === 'Blog');
    }
    assert.ok(reached, `${label}: keyboard Tab reaches the Blog link`);
    await Promise.all([page.waitForURL((url) => normalizePath(url.pathname) === '/blog'), page.keyboard.press('Enter')]);
    assert.equal(await page.getByRole('heading', { level: 4 }).count(), expected.posts.length, `${label}: blog index after keyboard navigation`);
  });
}

export async function checkFonts(browser, site, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/');
    const preloads = await page.locator('link[rel="preload"][as="font"]').evaluateAll((nodes) => nodes.map((node) => ({ href: node.href, crossorigin: node.hasAttribute('crossorigin') })));
    assert.equal(preloads.length, 2, `${label}: two font preloads`);
    for (const preload of preloads) {
      assert.ok(preload.crossorigin, `${label}: font preload needs crossorigin`);
      assert.equal((await fetch(site.url + new URL(preload.href).pathname)).status, 200, `${label}: font preload resolves`);
    }
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family);
    });
    assert.ok(loaded.some((family) => /Atkinson/i.test(family)), `${label}: Atkinson face loaded (${loaded})`);
    assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /Atkinson/i, `${label}: body font`);
  });
}

export async function checkFeedAndSitemap(site, expected, label, { dev = false } = {}) {
  const feed = await fetchText(site, '/rss.xml');
  assert.equal(feed.status, 200, `${label}: rss status`);
  assert.match(feed.type, /xml/, `${label}: rss type`);
  assert.match(feed.text, /<rss[^>]*version="2\.0"/, `${label}: rss 2.0`);
  const items = [...feed.text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
  const channel = feed.text.slice(0, feed.text.indexOf('<item>'));
  assert.equal(xmlValue(channel, 'title'), expected.siteTitle, `${label}: feed title`);
  assert.equal(xmlValue(channel, 'description'), expected.siteDescription, `${label}: feed description`);
  assert.equal(items.length, expected.posts.length, `${label}: feed item count`);
  const byLink = new Map(items.map((item) => [xmlValue(item, 'link'), item]));
  for (const post of expected.posts) {
    const item = byLink.get(`${SITE_ORIGIN}/blog/${post.slug}/`);
    assert.ok(item, `${label}: feed item for ${post.slug}`);
    assert.equal(xmlValue(item, 'title'), post.title, `${label}: feed title for ${post.slug}`);
    assert.equal(xmlValue(item, 'description'), post.description, `${label}: feed description for ${post.slug}`);
    assert.ok(sameDay(new Date(xmlValue(item, 'pubDate')).toISOString(), post.iso), `${label}: feed date for ${post.slug}`);
  }
  if (dev) return;
  const entry = await (await fetch(site.url + '/')).text();
  const sitemapHref = /<link rel="sitemap" href="([^"]+)"/.exec(entry)?.[1];
  assert.ok(sitemapHref, `${label}: sitemap link in head`);
  let document = await fetchText(site, new URL(sitemapHref, site.url).pathname);
  let urls = [];
  if (document.text.includes('<sitemapindex')) {
    for (const loc of document.text.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const child = await fetchText(site, new URL(loc[1]).pathname);
      urls.push(...[...child.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]));
    }
  } else {
    urls = [...document.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  }
  assert.deepEqual([...urls].sort(), expected.sitemapPaths.map((path) => SITE_ORIGIN + path).sort(), `${label}: sitemap URLs`);
}

export async function checkScriptWeight(site, expected, label, { dev }) {
  for (const path of routesOf(expected)) {
    const { text } = await fetchText(site, path);
    const scripts = [...text.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1]);
    const unexpected = scripts.filter((attributes) => !(dev && /data-bascik-live-reload/.test(attributes)));
    assert.deepEqual(unexpected, [], `${label}: ${path} ships no scripts`);
  }
}

export async function checkPortOnly(browser, site, expected, label, { dev }) {
  for (const path of routesOf(expected)) {
    const { text } = await fetchText(site, path);
    const directives = text.replace(/data-bascik-live-reload/g, '').match(/data-bascik-[a-z-]+/g) ?? [];
    assert.deepEqual(directives, [], `${label}: ${path} leaks Bascik directives`);
    for (const tag of ['header-link', 'base-head', 'site-header', 'site-footer', 'post-layout', 'post-list', 'formatted-date', 'social-links']) {
      assert.ok(!new RegExp(`<${tag}[\\s>/]`).test(text), `${label}: ${path} left <${tag}> unexpanded`);
    }
    if (!dev) assert.ok(!text.includes('bascik__'), `${label}: ${path} identifiers are minified`);
  }
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/blog/');
    assert.equal(await page.getByTestId('post-card').count(), expected.posts.length, `${label}: post cards`);
    assert.equal(await page.getByTestId('nav-blog').getAttribute('aria-current'), 'page', `${label}: nav-blog current`);
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), null, `${label}: nav-home not current`);
    await page.goto(site.url + '/blog/first-post/');
    assert.equal(await page.getByTestId('post-title').innerText(), 'First post', `${label}: post title testid`);
    assert.equal(await page.getByTestId('nav-blog').getAttribute('aria-current'), 'page', `${label}: nested post keeps Blog current`);
    assert.equal(await page.getByTestId('site-title').innerText(), expected.siteTitle, `${label}: site title testid`);
  });
}
