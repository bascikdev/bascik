import assert from 'node:assert/strict';
import { SITE_ORIGIN, published, routesOf, sitemapPaths, tagGroups } from './eleventy-blog-expected.mjs';

// Behavior checks shared by the pinned Eleventy base blog and the Bascik port. Locators use roles,
// text, and computed style, never framework class names, so one assertion runs against both.
// `dev` means the implementation's development server, which publishes drafts (the pinned source
// drops them only from production builds).

async function fetchText(site, path) {
  const response = await fetch(site.url + path);
  return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text(), response };
}

export async function withPage(browser, viewport, action) {
  const context = await browser.newContext({ viewport });
  try {
    return await action(await context.newPage());
  } finally {
    await context.close();
  }
}

const findPost = (expected, slug) => expected.posts.find((entry) => entry.slug === slug);
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

// ── structural XML helpers (no regex over markup beyond tag names the feed format defines) ──

export function atomEntries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const body = match[1];
    const value = (tag) => {
      const found = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body);
      // A literal `]]>` inside CDATA is written as `]]]]><![CDATA[>`; rejoin before unwrapping.
      return found ? found[1].replaceAll(']]]]><![CDATA[>', ']]&gt;').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replaceAll(']]&gt;', ']]>').trim() : null;
    };
    return {
      title: unescapeXml(value('title')),
      id: value('id'),
      link: /<link\b[^>]*\shref="([^"]*)"/.exec(body)?.[1] ?? null,
      updated: value('updated'),
      content: unescapeXml(value('content')),
    };
  });
}

export function unescapeXml(value) {
  if (value === null) return null;
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

// ── checks ───────────────────────────────────────────────────────────────────────────────────

export async function checkRoutesAndErrors(site, expected, label, { dev }) {
  for (const path of routesOf(expected, dev)) {
    const result = await fetchText(site, path);
    assert.equal(result.status, 200, `${label}: ${path} status`);
    assert.match(result.type, /text\/html/, `${label}: ${path} content type`);
  }
  const feed = await fetchText(site, '/feed/feed.xml');
  assert.equal(feed.status, 200, `${label}: feed status`);
  assert.match(feed.type, /xml/, `${label}: feed type`);
  const missing = await fetchText(site, '/does-not-exist/');
  assert.equal(missing.status, 404, `${label}: unknown path is 404`);
  assert.match(missing.text, /Content not found/, `${label}: unknown path shows the 404 page`);
  assert.equal(published(expected, false).some((entry) => entry.draft), false, `${label}: fixture sanity`);
  const draft = findPost(expected, 'fifthpost');
  const draftStatus = (await fetch(site.url + draft.url)).status;
  assert.equal(draftStatus, dev ? 200 : 404, `${label}: draft ${draft.url} status (${dev ? 'dev' : 'production'})`);
  // Whether `/404.html` itself answers 200 (a static host serving the file) or 404 (Bascik's server
  // serving its error page with the error status) is a server choice, so the build output is checked
  // for the file instead, in the lane.
}

export async function checkMetadata(browser, site, expected, label, { dev }) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    for (const path of routesOf(expected, dev)) {
      await page.goto(site.url + path);
      const meta = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        charset: Boolean(document.querySelector('meta[charset]')),
        viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
        feed: document.querySelector('link[rel="alternate"][type="application/atom+xml"]')?.getAttribute('href') ?? null,
      }));
      const where = `${label}: ${path}`;
      assert.equal(meta.lang, 'en', `${where} lang`);
      assert.equal(meta.charset, true, `${where} charset`);
      assert.match(meta.viewport ?? '', /width=device-width/, `${where} viewport`);
      assert.equal(meta.feed, '/feed/feed.xml', `${where} feed alternate`);
      const entry = published(expected, dev).find((candidate) => candidate.url === path);
      if (entry) {
        assert.equal(meta.title, entry.title, `${where} title`);
        assert.equal(meta.description, entry.description ?? expected.siteDescription, `${where} description`);
      } else if (path.startsWith('/tags/') && path !== '/tags/') {
        const group = tagGroups(published(expected, dev)).find((candidate) => `/tags/${candidate.slug}/` === path);
        assert.equal(meta.title, `Tagged '${group.name}'`, `${where} title`);
      } else {
        assert.equal(meta.title, expected.siteTitle, `${where} title`);
        assert.equal(meta.description, expected.siteDescription, `${where} description`);
      }
    }
  });
}

export async function checkNavigation(browser, site, expected, label, { dev }) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/');
    const nav = page.getByRole('navigation');
    assert.deepEqual(await nav.getByRole('link').allInnerTexts(), ['Home', 'Archive', 'About', 'Feed'], `${label}: nav order`);
    const targets = await nav.getByRole('link').evaluateAll((nodes) => nodes.map((node) => new URL(node.href).pathname));
    assert.deepEqual(targets, ['/', '/blog/', '/about/', '/feed/feed.xml'], `${label}: nav targets`);
    for (const [path, current] of [['/', 'Home'], ['/blog/', 'Archive'], ['/about/', 'About']]) {
      await page.goto(site.url + path);
      const marked = await page.getByRole('navigation').locator('a[aria-current="page"]').allInnerTexts();
      assert.deepEqual(marked, [current], `${label}: ${path} marks ${current} current`);
    }
    await page.goto(site.url + findPost(expected, 'firstpost').url);
    assert.equal(await page.getByRole('navigation').locator('a[aria-current]').count(), 0, `${label}: a post page marks no nav item current`);
    await page.getByRole('link', { name: expected.siteTitle, exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/', `${label}: site title links home`);
    await page.getByRole('navigation').getByRole('link', { name: 'Archive' }).click();
    await page.waitForURL((url) => url.pathname === '/blog/');
    await page.getByRole('navigation').getByRole('link', { name: 'About' }).click();
    await page.waitForURL((url) => url.pathname === '/about/');
  });
}

export async function checkHomeAndArchive(browser, site, expected, label, { dev }) {
  const posts = published(expected, dev);
  const newestFirst = [...posts].reverse();
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/');
    const latest = newestFirst.slice(0, 3);
    assert.equal(await textOf(page.getByRole('heading', { level: 1 })), `Latest ${latest.length} Posts`, `${label}: home heading`);
    const hrefs = await page.locator('main ol[reversed] li a').evaluateAll((nodes) => nodes.map((node) => new URL(node.href).pathname));
    assert.deepEqual(hrefs, latest.map((entry) => entry.url), `${label}: home lists the newest three, newest first`);
    const more = posts.length - 3;
    const note = page.getByText(/more posts? can be found in/);
    if (more > 0) {
      assert.equal(await textOf(note), `${more} more post${more === 1 ? '' : 's'} can be found in the archive.`, `${label}: more-posts note`);
      assert.equal(new URL(await note.getByRole('link', { name: 'the archive' }).evaluate((node) => node.href)).pathname, '/blog/', `${label}: archive link`);
    } else {
      assert.equal(await note.count(), 0, `${label}: no more-posts note`);
    }
    const times = await page.locator('main ol[reversed] li time').evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('datetime'), node.textContent.trim()]));
    assert.deepEqual(times, latest.map((entry) => [entry.iso, entry.monthYear]), `${label}: home dates`);

    await page.goto(site.url + '/blog/');
    assert.equal(await textOf(page.getByRole('heading', { level: 1 })), 'Archive', `${label}: archive heading`);
    const archiveLinks = await page.locator('main ol[reversed] li a').evaluateAll((nodes) => nodes.map((node) => [new URL(node.href).pathname, node.textContent.trim()]));
    assert.deepEqual(archiveLinks, newestFirst.map((entry) => [entry.url, entry.title]), `${label}: archive order and titles`);
    // The list is a reversed ordered list; its first item is numbered with the total.
    assert.equal(await page.locator('main ol[reversed]').count(), 1, `${label}: exactly one reversed post list`);
    assert.equal(await page.locator('main ol[reversed]').first().evaluate((node) => node.reversed), true, `${label}: archive list is reversed`);
    const counter = await page.locator('main ol[reversed]').first().evaluate((node) => getComputedStyle(node).getPropertyValue('--postlist-index').trim());
    assert.equal(counter, String(posts.length + 1), `${label}: --postlist-index`);
    // The rendered digits come from a CSS counter, which getComputedStyle cannot resolve. The values
    // that drive it can be read: the list resets the counter to the total + 1 and each item steps it down.
    const reset = await page.locator('main ol[reversed]').first().evaluate((node) => getComputedStyle(node).counterReset);
    assert.equal(reset, `start-from ${posts.length + 1}`, `${label}: list counter starts at the total + 1`);
    const step = await page.locator('main ol[reversed] li').first().evaluate((node) => getComputedStyle(node).counterIncrement);
    assert.equal(step, 'start-from -1', `${label}: each item counts down`);
  });
}

export async function checkPosts(browser, site, expected, label, { dev }) {
  const posts = published(expected, dev);
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    for (const [index, entry] of posts.entries()) {
      await page.goto(site.url + entry.url);
      assert.equal(await textOf(page.getByRole('heading', { level: 1 })), entry.title, `${label}: ${entry.slug} h1`);
      const time = page.locator('main ul li time').first();
      assert.equal(await time.getAttribute('datetime'), entry.iso, `${label}: ${entry.slug} datetime`);
      assert.equal(await textOf(time), entry.longDate, `${label}: ${entry.slug} date`);
      const tags = await page.locator('main ul a.post-tag, main ul a[href^="/tags/"]').evaluateAll((nodes) => nodes.map((node) => [node.textContent.trim(), new URL(node.href).pathname]));
      assert.deepEqual(tags, entry.tags.map((name) => [name, `/tags/${tagSlug(name)}/`]), `${label}: ${entry.slug} tag links`);

      const previous = posts[index - 1];
      const next = posts[index + 1];
      const nextPrev = await page.locator('ul').filter({ hasText: /Previous|Next/ }).locator('a').evaluateAll((nodes) => nodes.map((node) => [node.parentElement.textContent.includes('Previous') ? 'prev' : 'next', new URL(node.href).pathname, node.textContent.trim()]));
      const wanted = [];
      if (previous) wanted.push(['prev', previous.url, previous.title]);
      if (next) wanted.push(['next', next.url, next.title]);
      assert.deepEqual(nextPrev, wanted, `${label}: ${entry.slug} previous/next`);
    }
    // Following a next link reaches the neighbor.
    await page.goto(site.url + posts[0].url);
    await page.getByRole('link', { name: posts[1].title, exact: true }).click();
    assert.equal(new URL(page.url()).pathname, posts[1].url, `${label}: next link navigates`);
  });
}

const tagSlug = (name) => name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

export async function checkTags(browser, site, expected, label, { dev }) {
  const groups = tagGroups(published(expected, dev));
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/tags/');
    assert.equal(await textOf(page.getByRole('heading', { level: 1 })), 'Tags', `${label}: tags heading`);
    const listed = await page.locator('main ul a').evaluateAll((nodes) => nodes.map((node) => [node.textContent.trim(), new URL(node.href).pathname]));
    assert.deepEqual(listed, groups.map((tag) => [tag.name, `/tags/${tag.slug}/`]), `${label}: tags index is alphabetical`);
    for (const tag of groups) {
      await page.goto(site.url + `/tags/${tag.slug}/`);
      assert.equal(await textOf(page.getByRole('heading', { level: 1 })), `Tagged \u201c${tag.name}\u201d`, `${label}: ${tag.slug} heading`);
      const items = await page.locator('main ol[reversed] li a').evaluateAll((nodes) => nodes.map((node) => new URL(node.href).pathname));
      assert.deepEqual(items, [...tag.posts].reverse().map((entry) => entry.url), `${label}: ${tag.slug} posts, newest first`);
      assert.equal(new URL(await page.getByRole('link', { name: 'all tags' }).evaluate((node) => node.href)).pathname, '/tags/', `${label}: ${tag.slug} back link`);
    }
  });
}

export async function checkContent(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    // Code blocks: highlighted, keyboard reachable, and diff lines marked.
    await page.goto(site.url + `/blog/${expected.codePosts.highlighted}/`);
    const blocks = await page.locator('main pre').evaluateAll((nodes) => nodes.map((node) => ({
      tabindex: node.getAttribute('tabindex'),
      tokens: node.querySelectorAll('.token').length,
      text: node.textContent,
    })));
    assert.equal(blocks.length, 2, `${label}: two code blocks`);
    assert.equal(blocks[0].tabindex, '0', `${label}: a highlighted block is keyboard-scrollable`);
    assert.equal(blocks[1].tabindex, expected.unmarkedBlockFocusable ? '0' : null, `${label}: an unmarked block's tabindex`);
    assert.ok(blocks[0].tokens > 0, `${label}: the js block is highlighted`);
    assert.equal(blocks[1].tokens, 0, `${label}: the unmarked block is not highlighted`);
    assert.match(blocks[0].text, /function \w+\(/, `${label}: code text survives highlighting`);

    await page.goto(site.url + `/blog/${expected.codePosts.diff}/`);
    const diff = await page.locator('main pre').first().evaluate((node) => ({
      inserted: node.querySelectorAll('.token.inserted').length,
      deleted: node.querySelectorAll('.token.deleted').length,
      insertedBackground: getComputedStyle(node.querySelector('.token.inserted:not(.prefix)') ?? node).backgroundColor,
      deletedBackground: getComputedStyle(node.querySelector('.token.deleted:not(.prefix)') ?? node).backgroundColor,
    }));
    assert.ok(diff.inserted >= 1 && diff.deleted >= 1, `${label}: diff block has inserted and deleted lines (${JSON.stringify(diff)})`);
    assert.notEqual(diff.insertedBackground, diff.deletedBackground, `${label}: inserted and deleted lines are colored differently`);
    assert.notEqual(diff.insertedBackground, 'rgba(0, 0, 0, 0)', `${label}: inserted lines have a background`);

    // Links written as file paths become page addresses.
    await page.goto(site.url + findPost(expected, expected.linkPost).url);
    const links = await page.locator('main p a').evaluateAll((nodes) => nodes.map((node) => [node.textContent.trim(), new URL(node.href).pathname]));
    assert.deepEqual(links, [['First post', '/blog/firstpost/'], ['Third post', '/blog/thirdpost/']], `${label}: file-path links are rewritten`);

    // The image beside the post is published, sized, and lazy.
    await page.goto(site.url + findPost(expected, expected.imagePost).url);
    const image = page.locator('main img').first();
    assert.ok((await image.getAttribute('alt')).length > 10, `${label}: image has alt text`);
    assert.ok(Number(await image.getAttribute('width')) > 0 && Number(await image.getAttribute('height')) > 0, `${label}: image has intrinsic size`);
    assert.equal(await image.getAttribute('loading'), 'lazy', `${label}: image loads lazily`);
    assert.equal(await image.getAttribute('decoding'), 'async', `${label}: image decodes async`);
    await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('main img')].every((node) => node.complete && node.naturalWidth > 0));
  });
}

export async function checkHeadingAnchors(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + `/blog/${expected.codePosts.highlighted}/`);
    // The pinned source upgrades a custom element in the browser; the port writes the links at
    // build time. Wait for either to be in place before asserting the same observable result.
    await page.waitForFunction(() => document.querySelectorAll('main a[href^="#"]').length >= 3);
    const ids = await page.locator('main h2[id], main h3[id]').evaluateAll((nodes) => nodes.map((node) => node.id));
    assert.equal(new Set(ids).size, ids.length, `${label}: heading ids are unique (${ids})`);
    assert.ok(ids.includes('code') && ids.includes('section-header'), `${label}: expected heading ids (${ids})`);
    const anchors = await page.locator('main a[href^="#"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href').slice(1)));
    for (const id of ['code', 'section-header']) {
      assert.ok(anchors.includes(id), `${label}: an anchor link points at #${id} (${anchors})`);
    }
    // The link's accessible name says which section it jumps to.
    const link = page.locator('main a[href="#section-header"]').first();
    assert.match(await link.evaluate((node) => node.textContent), /Jump to section titled:?\s*Section header/i, `${label}: anchor link is labelled`);
    await link.focus();
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, '#section-header', `${label}: anchor link moves to its heading`);
    // The in-heading link that the post wrote itself still works.
    const heading = page.locator('h3#heading-with-a-link a[href="#code"]');
    assert.equal(await heading.count(), 1, `${label}: author link inside a heading is kept`);
  });
}

export async function checkChrome(browser, site, expected, label) {
  await withPage(browser, { width: 1280, height: 900 }, async (page) => {
    await page.goto(site.url + '/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    assert.equal(await skip.evaluate((node) => document.activeElement === node), true, `${label}: skip link is the first tab stop`);
    assert.equal(await skip.evaluate((node) => getComputedStyle(node).clip !== 'auto' || node.getBoundingClientRect().width > 1), true, `${label}: skip link becomes visible on focus`);
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, '#main', `${label}: skip link moves to main`);
    assert.equal(await page.evaluate(() => document.activeElement?.id || document.location.hash), '#main', `${label}: skip link target exists`);
    assert.equal(await page.locator('main#main').count(), 1, `${label}: main landmark`);
    assert.match(await textOf(page.getByRole('contentinfo')), expected.footerPattern, `${label}: footer`);
    const hidden = page.locator('nav h2');
    assert.equal(await hidden.count(), 1, `${label}: nav has a hidden heading`);
    // The visually-hidden pattern keeps the element in the accessibility tree as a clipped 1px box,
    // which Playwright still reports as visible, so measure the box instead.
    const box = await hidden.boundingBox();
    assert.ok(box && box.width <= 1 && box.height <= 1, `${label}: nav heading is visually hidden (${JSON.stringify(box)})`);
    assert.match(await hidden.evaluate((node) => node.textContent), /navigation/i, `${label}: nav heading text`);
  });
}

export async function checkMobileAndKeyboard(browser, site, expected, label, { dev }) {
  await withPage(browser, { width: 390, height: 844 }, async (page) => {
    for (const path of routesOf(expected, dev)) {
      await page.goto(site.url + path);
      const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      assert.ok(width.content <= width.viewport, `${label}: ${path} overflows horizontally (${width.content} > ${width.viewport})`);
    }
    await page.goto(site.url + '/');
    let reached = false;
    for (let press = 0; press < 8 && !reached; press++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.tagName === 'A' && document.activeElement.textContent.trim() === 'Archive');
    }
    assert.ok(reached, `${label}: keyboard Tab reaches the Archive link`);
    await Promise.all([page.waitForURL((url) => url.pathname === '/blog/'), page.keyboard.press('Enter')]);
  });
}

export async function checkTheme(browser, site, label) {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: scheme });
    try {
      const page = await context.newPage();
      await page.goto(site.url + '/');
      const colors = await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, link: getComputedStyle(document.querySelector('main a')).color }));
      assert.equal(colors.background, scheme === 'dark' ? 'rgb(21, 32, 43)' : 'rgb(255, 255, 255)', `${label}: ${scheme} background`);
      assert.equal(colors.text, scheme === 'dark' ? 'rgb(218, 216, 216)' : 'rgb(51, 51, 51)', `${label}: ${scheme} text`);
    } finally {
      await context.close();
    }
  }
}

export async function checkFeed(site, expected, label, { dev }) {
  const { text, type } = await fetchText(site, '/feed/feed.xml');
  assert.match(type, /xml/, `${label}: feed type`);
  assert.match(text, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/, `${label}: Atom feed`);
  const header = text.slice(0, text.indexOf('<entry>'));
  assert.equal(unescapeXml(/<title[^>]*>([^<]*)<\/title>/.exec(header)?.[1]), expected.feedTitle, `${label}: feed title`);
  assert.ok(header.includes(`<link href="${SITE_ORIGIN}/"`) || header.includes(`<link rel="alternate" href="${SITE_ORIGIN}/"`), `${label}: feed site link`);
  const entries = atomEntries(text);
  const wanted = [...published(expected, dev)].reverse().slice(0, 10);
  assert.deepEqual(entries.map((entry) => entry.link), wanted.map((entry) => SITE_ORIGIN + entry.url), `${label}: feed entries, newest first`);
  for (const [index, entry] of entries.entries()) {
    const post = wanted[index];
    assert.equal(entry.id, SITE_ORIGIN + post.url, `${label}: ${post.slug} id`);
    assert.equal(entry.title, post.title, `${label}: ${post.slug} title`);
    assert.equal(entry.updated?.slice(0, 10), post.iso, `${label}: ${post.slug} updated`);
    assert.ok(entry.content && entry.content.length > 20, `${label}: ${post.slug} has content`);
    // Relative URLs in feed content would break in a reader.
    assert.doesNotMatch(entry.content, /\s(?:href|src)="(?!https?:\/\/|mailto:)[^"]*"/, `${label}: ${post.slug} content has only absolute URLs`);
  }
  const image = entries.find((entry) => entry.link.endsWith(`/${expected.imagePost}/`));
  const imageUrl = dev && expected.devImageEndpoint
    ? new RegExp(`src="${SITE_ORIGIN}/\\.11ty/image/\\?src=[^"]+format=png[^"]*"`)
    : new RegExp(`src="${SITE_ORIGIN}/blog/${expected.imagePost}/[^"]+\\.png"`);
  assert.match(image.content, imageUrl, `${label}: feed image URL is absolute`);
  const links = entries.find((entry) => entry.link.endsWith(`/${expected.linkPost}/`));
  assert.ok(links.content.includes(`href="${SITE_ORIGIN}/blog/firstpost/"`), `${label}: feed file-path links are absolute pages`);
}

export async function checkSitemap(site, expected, label, { dev }) {
  if (dev && !expected.sitemapInDev) {
    assert.equal((await fetch(site.url + '/sitemap.xml')).status, 404, `${label}: the dev server serves no sitemap`);
    return;
  }
  const { status, text } = await fetchText(site, '/sitemap.xml');
  assert.equal(status, 200, `${label}: sitemap status`);
  const urls = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual([...urls].sort(), sitemapPaths(expected, dev).map((path) => SITE_ORIGIN + path).sort(), `${label}: sitemap URLs`);
  assert.ok(!urls.some((url) => url.endsWith('/404.html') || url.endsWith('/404/')), `${label}: sitemap omits the 404 page`);
}

export async function checkScripts(site, expected, label, { dev }) {
  for (const path of routesOf(expected, dev)) {
    const { text } = await fetchText(site, path);
    const scripts = [...text.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1].trim());
    const unexpected = scripts.filter((attributes) => !/data-bascik-live-reload/.test(attributes));
    if (expected.scripts === 'none') {
      assert.deepEqual(unexpected, [], `${label}: ${path} ships no scripts`);
    } else {
      assert.equal(unexpected.length, 1, `${label}: ${path} ships one module script (${unexpected})`);
      assert.match(unexpected[0], /type="module"/, `${label}: ${path} script is a module`);
    }
  }
}

export async function checkPortOnly(site, expected, label, { dev }) {
  for (const path of routesOf(expected, dev)) {
    const { text } = await fetchText(site, path);
    const directives = text.replace(/data-bascik-live-reload/g, '').match(/data-bascik-[a-z-]+/g) ?? [];
    assert.deepEqual(directives, [], `${label}: ${path} leaks Bascik directives`);
    for (const tag of ['site-head', 'site-header', 'site-footer']) {
      assert.ok(!new RegExp(`<${tag}[\\s>/]`).test(text), `${label}: ${path} left <${tag}> unexpanded`);
    }
    if (!dev) assert.ok(!text.includes('bascik__'), `${label}: ${path} identifiers are minified`);
  }
}
