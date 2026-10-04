import assert from 'node:assert/strict';
import { STORAGE_KEY } from './nextjs-blog-expected.mjs';

// Behavior checks shared by the Next.js blog-starter example and its Bascik port. Locators use
// roles, text, and computed style, never framework class names, so one assertion runs against
// both. Port-only checks (data-testid, directive leaks, script weight) are in checkPortOnly.

const postPath = (post) => `/posts/${post.slug}`;
export const routesOf = (expected) => ['/', ...expected.posts.map(postPath)];

async function withPage(browser, options, action) {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
    // A dev server's live-reload stream (Bascik's EventSource, Next.js's HMR socket) is aborted
    // by every navigation. That is not a page failure.
    page.on('requestfailed', (request) => {
      if (/\/bascik-live-reload$|\/_next\/webpack-hmr|\/__nextjs/.test(new URL(request.url()).pathname)) return;
      problems.push(`requestfailed: ${request.url()}`);
    });
    const result = await action(page, problems);
    return result;
  } finally {
    await context.close();
  }
}

// Scrolls every visible image into view (lazy images load on approach) and waits until each one
// has decoded. Images hidden by a responsive rule are counted but not required to load.
async function imagesLoad(page, scope) {
  const images = page.locator(`${scope} img`);
  const count = await images.count();
  for (let index = 0; index < count; index++) {
    if (await images.nth(index).isVisible()) await images.nth(index).scrollIntoViewIfNeeded();
  }
  await page.waitForFunction((selector) => {
    const found = [...document.querySelectorAll(`${selector} img`)].filter((image) => image.checkVisibility());
    return found.length > 0 && found.every((image) => image.complete && image.naturalWidth > 0);
  }, scope, { timeout: 10000 });
  return count;
}

export async function checkRoutes(site, expected, label) {
  for (const path of routesOf(expected)) {
    const response = await fetch(site.url + path);
    assert.equal(response.status, 200, `${label}: ${path} status`);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/, `${label}: ${path} content type`);
  }
  const missing = await fetch(site.url + '/no-such-page');
  assert.equal(missing.status, 404, `${label}: unknown page status`);
  assert.match(await missing.text(), /This page could not be found/, `${label}: 404 text`);
  assert.equal((await fetch(site.url + '/posts/no-such-post')).status, expected.unknownPostStatus,
    `${label}: unknown post status`);
  const slash = await fetch(site.url + `${postPath(expected.posts[0])}/`, { redirect: 'manual' });
  if (expected.trailingSlash === 'redirect') {
    assert.equal(slash.status, 308, `${label}: trailing slash redirects`);
    assert.equal(new URL(slash.headers.get('location'), site.url).pathname, postPath(expected.posts[0]), `${label}: redirect target`);
  } else {
    assert.equal(slash.status, 200, `${label}: trailing slash serves the page`);
  }
  for (const path of ['/favicon/apple-touch-icon.png', '/favicon/site.webmanifest']) {
    assert.equal((await fetch(site.url + path)).status, 200, `${label}: ${path}`);
  }
  assert.equal((await fetch(site.url + '/feed.xml')).status, expected.feedStatus, `${label}: /feed.xml status`);
}

export async function checkMetadata(browser, site, expected, label) {
  await withPage(browser, { viewport: { width: 1280, height: 900 } }, async (page) => {
    for (const path of routesOf(expected)) {
      await page.goto(site.url + path);
      const post = expected.posts.find((entry) => postPath(entry) === path);
      const title = post ? `${post.title} | ${expected.siteTitle}` : expected.siteTitle;
      const meta = await page.evaluate(() => {
        const read = (selector, name = 'content') => document.querySelector(selector)?.getAttribute(name) ?? null;
        return {
          lang: document.documentElement.lang,
          title: document.title,
          charset: Boolean(document.querySelector('meta[charset]')),
          viewport: read('meta[name="viewport"]'),
          description: read('meta[name="description"]'),
          ogTitle: read('meta[property="og:title"]'),
          ogDescription: read('meta[property="og:description"]'),
          ogImage: read('meta[property="og:image"]'),
          twitterCard: read('meta[name="twitter:card"]'),
          twitterTitle: read('meta[name="twitter:title"]'),
          twitterImage: read('meta[name="twitter:image"]'),
          themeColor: read('meta[name="theme-color"]'),
          feed: read('link[rel="alternate"][type="application/rss+xml"]', 'href'),
          appleIcon: read('link[rel="apple-touch-icon"]', 'href'),
          manifest: read('link[rel="manifest"]', 'href'),
        };
      });
      const where = `${label}: ${path}`;
      assert.equal(meta.lang, 'en', `${where} lang`);
      assert.ok(meta.charset, `${where} charset`);
      assert.match(meta.viewport ?? '', /width=device-width/, `${where} viewport`);
      assert.equal(meta.title, title, `${where} title`);
      assert.equal(meta.description, expected.siteDescription, `${where} description`);
      assert.equal(meta.ogTitle, title, `${where} og:title`);
      assert.equal(meta.ogDescription, expected.siteDescription, `${where} og:description`);
      assert.equal(meta.twitterCard, 'summary_large_image', `${where} twitter:card`);
      assert.equal(meta.twitterTitle, title, `${where} twitter:title`);
      assert.equal(meta.twitterImage, meta.ogImage, `${where} twitter:image matches og:image`);
      assert.equal(meta.themeColor, '#000', `${where} theme-color`);
      assert.equal(new URL(meta.feed, site.url).pathname, '/feed.xml', `${where} feed link`);
      assert.equal(meta.appleIcon, '/favicon/apple-touch-icon.png', `${where} apple-touch-icon`);
      assert.equal(meta.manifest, '/favicon/site.webmanifest', `${where} manifest`);
      if (post) {
        // A post's social image is its own cover, on the configured origin.
        const url = new URL(meta.ogImage);
        if (expected.socialOrigin instanceof RegExp) assert.match(url.origin, expected.socialOrigin, `${where} og:image origin`);
        else assert.equal(url.origin, expected.socialOrigin, `${where} og:image origin`);
        assert.equal(url.pathname, `/assets/blog/${post.slug}/cover.jpg`, `${where} og:image path`);
        const image = await fetch(site.url + url.pathname);
        assert.equal(image.status, 200, `${where} og:image resolves on this server`);
        assert.match(image.headers.get('content-type') ?? '', /^image\/jpeg/, `${where} og:image type`);
      } else {
        assert.ok(/^https?:\/\//.test(meta.ogImage ?? ''), `${where} og:image is absolute: ${meta.ogImage}`);
      }
    }
  });
}

export async function checkHome(browser, site, expected, label) {
  const [hero, ...more] = expected.posts;
  await withPage(browser, { viewport: { width: 1280, height: 900 } }, async (page, problems) => {
    await page.goto(site.url + '/');
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Blog.', `${label}: home h1`);
    assert.match(await page.getByRole('heading', { level: 4 }).innerText(), /A statically generated blog example using .+ and Markdown\./, `${label}: intro`);
    assert.equal(await page.getByRole('heading', { level: 2, name: 'More Stories' }).count(), 1, `${label}: More Stories heading`);
    // Hero first, then every other post, newest first.
    const titles = await page.getByRole('heading', { level: 3 }).allInnerTexts();
    assert.deepEqual(titles.slice(0, expected.posts.length), expected.posts.map((post) => post.title), `${label}: post order`);
    assert.equal(titles.at(-1), expected.footerHeading, `${label}: footer heading`);
    const links = await page.getByRole('heading', { level: 3 }).getByRole('link').evaluateAll((nodes) => nodes.map((node) => new URL(node.href).pathname));
    assert.deepEqual(links, expected.posts.map(postPath), `${label}: title links`);
    // Each cover image links to its post, labelled with the post title.
    for (const post of expected.posts) {
      const cover = page.getByRole('link', { name: post.title, exact: true }).filter({ has: page.locator('img') });
      assert.equal(await cover.count(), 1, `${label}: cover link for ${post.slug}`);
      assert.equal(new URL(await cover.evaluate((node) => node.href)).pathname, postPath(post), `${label}: cover link target ${post.slug}`);
      assert.equal(await cover.locator('img').getAttribute('alt'), `Cover Image for ${post.title}`, `${label}: cover alt ${post.slug}`);
    }
    const times = page.locator('main time');
    assert.deepEqual((await times.allInnerTexts()).map((text) => text.trim()), expected.posts.map((post) => post.label), `${label}: date labels`);
    assert.deepEqual(await times.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime'))), expected.posts.map((post) => post.iso), `${label}: datetime`);
    for (const post of expected.posts) {
      const avatar = page.getByRole('img', { name: post.author, exact: true });
      assert.equal(await avatar.count(), 1, `${label}: avatar for ${post.author}`);
      const box = await avatar.boundingBox();
      assert.ok(Math.abs(box.width - 48) < 1 && Math.abs(box.height - 48) < 1, `${label}: avatar size ${box.width}x${box.height}`);
      assert.equal(await avatar.evaluate((node) => getComputedStyle(node).borderTopLeftRadius), '9999px', `${label}: avatar is round`);
    }
    assert.equal(await imagesLoad(page, 'main'), expected.posts.length * 2, `${label}: covers and avatars load`);
    // Layout: the hero splits into two columns on desktop; other stories form a two-column grid.
    const heroTitle = await page.getByRole('heading', { level: 3, name: hero.title }).boundingBox();
    const heroExcerpt = await page.getByRole('img', { name: hero.author, exact: true }).boundingBox();
    assert.ok(heroExcerpt.x > heroTitle.x + 300, `${label}: hero excerpt sits in the right column`);
    const tops = [];
    for (const post of more) tops.push((await page.getByRole('heading', { level: 3, name: post.title }).boundingBox()).y);
    assert.ok(Math.abs(tops[0] - tops[1]) < 2, `${label}: more stories share a row on desktop`);
    const h1Size = await page.getByRole('heading', { level: 1 }).evaluate((node) => getComputedStyle(node).fontSize);
    assert.equal(h1Size, '100px', `${label}: md:text-8xl is 6.25rem`);
    assert.deepEqual(problems, [], `${label}: home has no browser errors`);
  });
  await withPage(browser, { viewport: { width: 390, height: 844 } }, async (page) => {
    await page.goto(site.url + '/');
    const tops = [];
    for (const post of more) tops.push((await page.getByRole('heading', { level: 3, name: post.title }).boundingBox()).y);
    assert.ok(tops[1] > tops[0] + 100, `${label}: more stories stack on mobile`);
    assert.equal(await page.getByRole('heading', { level: 1 }).evaluate((node) => getComputedStyle(node).fontSize), '40px', `${label}: text-5xl on mobile is 2.5rem`);
  });
}

export async function checkPosts(browser, site, expected, label) {
  await withPage(browser, { viewport: { width: 1280, height: 900 } }, async (page, problems) => {
    for (const post of expected.posts) {
      await page.goto(site.url + postPath(post));
      const where = `${label}: ${post.slug}`;
      assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), post.title, `${where} h1`);
      // The header link back to the home page, and the source banner above it.
      const home = page.getByRole('heading', { level: 2 }).filter({ hasText: /^\s*Blog\.\s*$/ }).getByRole('link', { name: 'Blog', exact: true });
      assert.equal(new URL(await home.evaluate((node) => node.href)).pathname, '/', `${where} header link`);
      assert.match(await page.locator('main').first().innerText(), /blog/i, `${where} banner`);
      const time = page.locator('article time');
      assert.equal(await time.count(), 1, `${where} one date`);
      assert.equal((await time.innerText()).trim(), post.label, `${where} date label`);
      assert.equal(await time.getAttribute('datetime'), post.iso, `${where} datetime`);
      // The cover is not a link on the post page.
      const cover = page.getByRole('img', { name: `Cover Image for ${post.title}`, exact: true });
      assert.equal(await cover.count(), 1, `${where} cover image`);
      assert.equal(await cover.evaluate((node) => node.closest('a')), null, `${where} cover is not a link`);
      // Avatar: shown above the cover on desktop, below it on mobile (two copies, one visible).
      const avatars = page.locator(`article img[alt="${post.author}"]`);
      assert.equal(await avatars.count(), 2, `${where} two avatar copies`);
      assert.deepEqual(await avatars.evaluateAll((nodes) => nodes.map((node) => node.checkVisibility())), [true, false], `${where} desktop avatar visibility`);
      // Rendered Markdown and the CSS module rules that style it.
      assert.ok((await page.locator('article').getByRole('heading', { level: 2 }).count()) >= 1, `${where} section heading`);
      const styles = await page.locator('article').evaluate((article) => {
        const h2 = article.querySelector('h2');
        const paragraph = h2.closest('div').querySelector('p');
        const body = paragraph.parentElement;
        return {
          h2Size: getComputedStyle(h2).fontSize,
          h2Margin: getComputedStyle(h2).marginTop,
          pMargin: getComputedStyle(paragraph).marginTop,
          bodySize: getComputedStyle(body).fontSize,
          bodyWidth: body.getBoundingClientRect().width,
        };
      });
      assert.deepEqual(
        { h2Size: styles.h2Size, h2Margin: styles.h2Margin, pMargin: styles.pMargin, bodySize: styles.bodySize },
        { h2Size: '30px', h2Margin: '48px', pMargin: '24px', bodySize: '18px' },
        `${where} markdown styles`,
      );
      assert.ok(styles.bodyWidth <= 672, `${where} body is max-w-2xl (${styles.bodyWidth})`);
      await imagesLoad(page, 'article');
      await home.click();
      await page.waitForURL((url) => url.pathname === '/');
    }
    assert.deepEqual(problems, [], `${label}: posts have no browser errors`);
  });
  await withPage(browser, { viewport: { width: 390, height: 844 } }, async (page) => {
    const post = expected.posts[0];
    await page.goto(site.url + postPath(post));
    const avatars = page.locator(`article img[alt="${post.author}"]`);
    assert.deepEqual(await avatars.evaluateAll((nodes) => nodes.map((node) => node.checkVisibility())), [false, true], `${label}: mobile avatar visibility`);
  });
}

export async function checkLayout(browser, site, expected, label) {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await withPage(browser, { viewport }, async (page) => {
      for (const path of [...routesOf(expected), '/no-such-page']) {
        await page.goto(site.url + path);
        const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
        assert.ok(size.content <= size.viewport, `${label}: ${path} overflows at ${viewport.width} (${size.content})`);
        const footer = page.getByRole('contentinfo');
        assert.equal(await footer.getByRole('heading', { level: 3 }).innerText(), expected.footerHeading, `${label}: ${path} footer`);
        assert.equal(await footer.getByRole('link').count(), 2, `${label}: ${path} footer links`);
      }
      await page.goto(site.url + '/');
      const font = await page.evaluate(async () => {
        await document.fonts.ready;
        return { family: getComputedStyle(document.body).fontFamily, loaded: [...document.fonts].some((face) => /Inter/.test(face.family) && face.status === 'loaded') };
      });
      assert.match(font.family, /Inter/, `${label}: body font is Inter`);
      assert.ok(font.loaded, `${label}: an Inter face loaded`);
    });
  }
}

// The color scheme switch: system -> dark -> light -> system, stored in localStorage, applied
// before first paint on the next load, and synced to other tabs through the storage event.
export async function checkThemeSwitch(browser, site, expected, label) {
  const state = (page) => page.evaluate(() => ({
    mode: document.documentElement.getAttribute('data-mode'),
    dark: document.documentElement.classList.contains('dark'),
    background: getComputedStyle(document.body).backgroundColor,
  }));
  await withPage(browser, { viewport: { width: 1280, height: 900 }, colorScheme: 'light' }, async (page, problems) => {
    await page.goto(site.url + '/');
    const button = page.locator('body button').first();
    assert.equal(await button.count(), 1, `${label}: one switch button`);
    const box = await button.boundingBox();
    // 24px plus a 1px border on each side: `all: unset` resets box-sizing to content-box.
    assert.ok(Math.abs(box.width - 26) < 1 && Math.abs(box.height - 26) < 1, `${label}: switch is 26px (${box.width})`);
    assert.ok(box.x > 1280 - 60 && Math.abs(box.y - 70) < 2, `${label}: switch top right (${box.x}, ${box.y})`);
    assert.deepEqual(await state(page), { mode: 'system', dark: false, background: 'rgba(0, 0, 0, 0)' }, `${label}: initial system light`);
    assert.equal(await button.evaluate((node) => getComputedStyle(node, '::after').content), '"A"', `${label}: system mode shows A`);
    await button.click();
    assert.deepEqual(await state(page), { mode: 'dark', dark: true, background: 'rgb(15, 23, 42)' }, `${label}: dark after one press`);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY), 'dark', `${label}: stored dark`);
    // The dark-mode switch plays the wobble keyframes. Every stop must have reached the browser:
    // the CSS parser drops a stop whose selector is invalid.
    const stops = await button.evaluate((node) => {
      const name = getComputedStyle(node).animationName;
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSKeyframesRule && rule.name === name) return [...rule.cssRules].map((stop) => stop.keyText);
        }
      }
      return null;
    });
    assert.deepEqual(stops, ['40%', '80%', '0%, 100%'], `${label}: dark switch animation keeps every keyframe stop`);
    await button.click();
    const light = await state(page);
    assert.deepEqual({ mode: light.mode, dark: light.dark }, { mode: 'light', dark: false }, `${label}: light after two presses`);
    // The switch transitions for 0.3s; wait for the final color.
    await button.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    assert.equal(await button.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 0)', `${label}: light switch is yellow`);
    await button.click();
    assert.equal((await state(page)).mode, 'system', `${label}: back to system`);
    // Keyboard: the switch is a real button.
    await button.focus();
    await page.keyboard.press('Enter');
    assert.equal((await state(page)).mode, 'dark', `${label}: Enter toggles`);
    // Applied before first paint: the very first frame of a reload is already dark.
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') window.__darkAtInteractive = document.documentElement.classList.contains('dark');
      });
      requestAnimationFrame(() => { window.__darkAtFirstFrame = document.documentElement.classList.contains('dark'); });
    });
    await page.reload();
    const early = await page.evaluate(() => ({ interactive: window.__darkAtInteractive, frame: window.__darkAtFirstFrame }));
    assert.deepEqual(early, { interactive: true, frame: true }, `${label}: stored scheme applied before first paint`);
    // Another tab follows the change.
    const other = await page.context().newPage();
    await other.goto(site.url + postPath(expected.posts[0]));
    assert.equal((await state(other)).dark, true, `${label}: second tab starts dark`);
    await page.locator('body button').first().click();
    await other.waitForFunction(() => document.documentElement.getAttribute('data-mode') === 'light');
    assert.equal((await state(other)).dark, false, `${label}: second tab synced to light`);
    await other.close();
    assert.deepEqual(problems, [], `${label}: theme switch has no browser errors`);
  });
  await withPage(browser, { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }, async (page) => {
    await page.goto(site.url + '/');
    assert.deepEqual(await state(page), { mode: 'system', dark: true, background: 'rgb(15, 23, 42)' }, `${label}: system dark follows the OS`);
  });
}

function xmlValue(block, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim() : null;
}

/** Checks that only make sense for the Bascik port. */
export async function checkPortOnly(browser, site, expected, label, { dev = false } = {}) {
  for (const path of [...routesOf(expected), '/no-such-page']) {
    const raw = await (await fetch(site.url + path)).text();
    // The dev server keeps HTML comments, and the port's comments name component tags. Check
    // markup only; a tag inside a comment is text.
    const text = raw.replace(/<!--[\s\S]*?-->/g, '');
    if (!dev) assert.equal(text, raw, `${label}: ${path} production output has no HTML comments`);
    const directives = text.replace(/data-bascik-live-reload/g, '').match(/data-bascik-[a-z-]+/g) ?? [];
    assert.deepEqual(directives, [], `${label}: ${path} leaks Bascik directives`);
    for (const tag of ['site-head', 'theme-init', 'theme-switcher', 'page-container', 'site-footer', 'intro-section',
      'post-alert', 'site-header', 'author-avatar', 'date-formatter', 'post-body']) {
      assert.ok(!new RegExp(`<${tag}[\\s>/]`).test(text), `${label}: ${path} left <${tag}> unexpanded`);
    }
    if (!dev) assert.ok(!text.includes('bascik__'), `${label}: ${path} identifiers are minified`);
    // Two inline component scripts (theme init and the switch), plus live reload in dev. No
    // framework runtime, no external script files.
    const scripts = [...text.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1])
      .filter((attributes) => !(dev && /data-bascik-live-reload/.test(attributes)));
    assert.equal(scripts.length, 2, `${label}: ${path} script count`);
    assert.ok(scripts.every((attributes) => !/\bsrc=/.test(attributes)), `${label}: ${path} only inline scripts`);
    // The theme init script stays in <head> in every mode, so it runs before the body paints.
    const head = text.slice(0, text.indexOf('</head>'));
    assert.match(head, /<script>[\s\S]*?updateDOM/, `${label}: ${path} theme init runs in <head>`);
  }
  await withPage(browser, { viewport: { width: 1280, height: 900 } }, async (page) => {
    await page.goto(site.url + '/');
    assert.equal(await page.getByTestId('hero-post').count(), 1, `${label}: hero testid`);
    assert.equal(await page.getByTestId('post-preview').count(), expected.posts.length - 1, `${label}: preview testids`);
    assert.equal(await page.getByTestId('theme-switch').getAttribute('aria-label'), 'Color scheme: system', `${label}: switch accessible name`);
    await page.getByTestId('theme-switch').click();
    assert.equal(await page.getByTestId('theme-switch').getAttribute('aria-label'), 'Color scheme: dark', `${label}: switch name follows the mode`);
    // Keyboard focus is visible even though the upstream rule resets every property.
    await page.getByTestId('theme-switch').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.notEqual(await page.getByTestId('theme-switch').evaluate((node) => getComputedStyle(node).outlineStyle), 'none', `${label}: focus ring`);
    await page.goto(site.url + postPath(expected.posts[0]));
    assert.equal(await page.getByTestId('post').count(), 1, `${label}: post testid`);
    assert.equal(await page.getByTestId('post-alert').count(), 1, `${label}: alert testid`);
    await page.getByTestId('home-link').click();
    await page.waitForURL((url) => url.pathname === '/');
  });
  // Markup in a title is escaped, never parsed.
  const feed = await fetch(site.url + '/feed.xml');
  assert.equal(feed.status, 200, `${label}: feed status`);
  const xml = await feed.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
  assert.deepEqual(items.map((item) => xmlValue(item, 'title')), expected.posts.map((post) => post.title), `${label}: feed items newest first`);
  assert.deepEqual(items.map((item) => xmlValue(item, 'link')), expected.posts.map((post) => `${expected.socialOrigin}${postPath(post)}`), `${label}: feed links`);
  if (dev) {
    assert.equal((await fetch(site.url + '/sitemap.xml')).status, 404, `${label}: no sitemap in dev`);
    return;
  }
  const sitemap = await (await fetch(site.url + '/sitemap.xml')).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).sort();
  assert.deepEqual(urls, expected.sitemapPaths.map((path) => expected.socialOrigin + path).sort(), `${label}: sitemap URLs (404 excluded)`);
  const robots = await (await fetch(site.url + '/robots.txt')).text();
  assert.match(robots, new RegExp(`Sitemap: ${expected.socialOrigin}/sitemap.xml`), `${label}: robots.txt`);
}

/** Facts about the upstream build that the port intentionally does differently. */
export async function checkUpstreamOnly(site, expected, label) {
  assert.equal((await fetch(site.url + '/sitemap.xml')).status, expected.sitemapStatus, `${label}: no sitemap`);
  const home = await (await fetch(site.url + '/')).text();
  const scripts = [...home.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 5, `${label}: ships framework script files (${scripts.length})`);
  let bytes = 0;
  for (const src of scripts) bytes += (await (await fetch(new URL(src, site.url))).arrayBuffer()).byteLength;
  assert.ok(bytes > 100000, `${label}: framework JavaScript is over 100 kB (${bytes})`);
  return bytes;
}
