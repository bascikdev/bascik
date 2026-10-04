// Behavior checks for templates/blog, shared by the lane test and the mutation test. They assert
// what a reader gets (status, content type, a non-empty body, real images, links that resolve,
// layout in a browser), not just that a build exited 0.
import assert from 'node:assert/strict';

import { crc32, deflateSync } from 'node:zlib';

export const ORIGIN = 'https://example.com';

/** A valid solid-color PNG of the given size, for scenarios that need an image of a chosen shape. */
export function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Sample content shipped in templates/blog/content. Oldest first. The draft is last in date.
export const SAMPLE = {
  siteTitle: 'Lantern Log',
  perPage: 5,
  published: ['welcome', 'writing-posts', 'images-and-figures', 'tags-and-drafts', 'customizing-the-site', 'deploying'],
  titles: {
    welcome: 'Welcome to the lantern log',
    'writing-posts': 'Writing posts',
    'images-and-figures': 'Images and figures',
    'tags-and-drafts': 'Tags and drafts',
    'customizing-the-site': 'Customizing the site',
    deploying: 'Deploying',
  },
  draft: 'next-up',
  tags: ['basics', 'customizing', 'deploying', 'drafts', 'images', 'markdown', 'welcome'],
};

export const newestFirst = [...SAMPLE.published].reverse();

const failure = (label, what, detail) => new Error(`${label}: ${what}${detail === undefined ? '' : ` (${detail})`}`);

export async function get(site, path, init) {
  return fetch(site.url + path, { redirect: 'manual', ...init });
}

/** Fetch a path and require a status, a content type, and a non-empty body. */
export async function fetchOk(site, path, { status = 200, type, label }) {
  const response = await get(site, path);
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status !== status) {
    const snippet = body.toString('utf8').replace(/<style>[\s\S]*?<\/style>/g, '<style>…</style>').replace(/\s+/g, ' ').slice(0, 300);
    throw failure(label, `${path} status`, `${response.status}, expected ${status}; body starts: ${snippet}`);
  }
  if (type && !(response.headers.get('content-type') ?? '').startsWith(type)) {
    throw failure(label, `${path} content type`, response.headers.get('content-type'));
  }
  if (body.length === 0) throw failure(label, `${path} body is empty`);
  return { response, body, text: body.toString('utf8') };
}

export const html = (site, path, label, status = 200) => fetchOk(site, path, { status, type: 'text/html', label });

/** The link targets in `href=""` attributes of a page. */
export const hrefs = (text) => [...text.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1]);
export const h1 = (text) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(text)?.[1]?.replace(/<[^>]+>/g, '').trim();
export const titleTag = (text) => /<title>([\s\S]*?)<\/title>/.exec(text)?.[1];
export const listedHrefs = (text) => [...text.matchAll(/<a href="([^"]+)" class="postlist-link">/g)].map((match) => match[1]);
export const meta = (text, attribute, name) =>
  new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`).exec(text)?.[1];
export const decode = (value) => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

// The feed library wraps text in CDATA. Unwrap it first so the value compared is what a feed
// reader would show, with or without escaping.
const cdata = (value) => value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');

export function atomEntries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const text = (tag) => {
      const raw = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(match[1])?.[1] ?? '';
      return /^<!\[CDATA\[/.test(raw) ? cdata(raw) : decode(raw);
    };
    return { title: text('title'), link: /<link href="([^"]+)"/.exec(match[1])?.[1], content: text('content') };
  });
}

const sitemapPaths = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].replace(ORIGIN, ''));

/**
 * Until the dev server's whole first transpile is done it answers every page it has not built yet
 * with a 200 "Building site…" page, so a built home page does not mean the other pages exist.
 * A path that cannot exist returns a real 404 only after that first transpile, which makes it the
 * readiness signal.
 */
export async function waitForFirstBuild(site, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await get(site, '/no/such/page/');
    const text = await response.text();
    if (response.status === 404 && !text.includes('Building site')) return;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`${label}: the dev server never finished its first build`);
}

/**
 * Routes, status codes, drafts, metadata, tags, pagination, feed, sitemap, and images for the sample
 * content. `dev` expects the draft to be present and the deployment-only files to be absent.
 */
export async function checkSite(site, label, { dev = false } = {}) {
  const posts = dev ? [...SAMPLE.published, SAMPLE.draft] : SAMPLE.published;

  // ── pages and status codes (the `drafts` tag page exists because a published post uses it too)
  for (const path of ['/', '/blog/', '/blog/page/2/', '/tags/', '/about/', ...SAMPLE.tags.map((tag) => `/tags/${tag}/`)]) {
    await html(site, path, label);
  }
  for (const slug of SAMPLE.published) await html(site, `/blog/${slug}/`, label);
  const missing = await html(site, '/blog/page/3/', label, 404);
  assert.match(missing.text, /Page not found/, `${label}: the 404 page body`);
  await html(site, '/this/does/not/exist/', label, 404);

  // ── drafts
  const draft = await get(site, `/blog/${SAMPLE.draft}/`);
  assert.equal(draft.status, dev ? 200 : 404, `${label}: draft status`);
  await draft.arrayBuffer();

  // ── home and archive
  const home = await html(site, '/', label);
  assert.equal(h1(home.text), 'Latest posts', `${label}: home heading`);
  // The sample draft is dated after every published post, so in development it leads the list.
  const homeOrder = dev ? [SAMPLE.draft, ...newestFirst] : newestFirst;
  assert.deepEqual(listedHrefs(home.text), homeOrder.slice(0, 3).map((slug) => `/blog/${slug}/`), `${label}: home list`);
  const archive = await html(site, '/blog/', label);
  assert.equal(listedHrefs(archive.text).length, SAMPLE.perPage, `${label}: archive page 1 size`);
  assert.match(archive.text, /Page 1 of 2/, `${label}: pager status`);
  assert.match(archive.text, /<a href="\/blog\/page\/2\/" rel="next">/, `${label}: pager next`);
  const second = await html(site, '/blog/page/2/', label);
  assert.equal(h1(second.text), 'Archive, page 2', `${label}: page 2 heading`);
  assert.equal(listedHrefs(second.text).length, posts.length - SAMPLE.perPage, `${label}: archive page 2 size`);
  assert.match(second.text, /<a href="\/blog\/" rel="prev">/, `${label}: pager previous`);
  assert.equal(listedHrefs(archive.text).concat(listedHrefs(second.text)).length, posts.length, `${label}: every post is on exactly one archive page`);
  assert.equal(new Set(listedHrefs(archive.text).concat(listedHrefs(second.text))).size, posts.length, `${label}: no post repeats across pages`);

  // ── a post: title, metadata, neighbors, tags
  const post = await html(site, '/blog/writing-posts/', label);
  assert.equal(h1(post.text), 'Writing posts', `${label}: post heading`);
  assert.equal(titleTag(post.text), `Writing posts | ${SAMPLE.siteTitle}`, `${label}: post title tag`);
  assert.match(post.text, /<time datetime="2026-02-02">February 2, 2026<\/time>/, `${label}: post date`);
  assert.match(post.text, /rel="prev">Welcome to the lantern log<\/a>/, `${label}: previous link`);
  assert.match(post.text, /rel="next">Images and figures<\/a>/, `${label}: next link`);
  assert.match(post.text, /<a href="\/blog\/welcome\/#the-one-rule">/, `${label}: link to a post with a fragment`);
  assert.match(post.text, /<pre class="language-javascript" tabindex="0">/, `${label}: highlighted block is focusable`);
  const oldest = await html(site, '/blog/welcome/', label);
  assert.doesNotMatch(oldest.text, /links-nextprev-prev/, `${label}: oldest post has no previous link`);

  // ── metadata (production has the site URL; dev run here also has it)
  assert.match(post.text, /<link rel="canonical" href="https:\/\/example\.com\/blog\/writing-posts\/">/, `${label}: canonical`);
  assert.equal(meta(post.text, 'property', 'og:url'), `${ORIGIN}/blog/writing-posts/`, `${label}: og:url`);
  assert.equal(meta(post.text, 'property', 'og:type'), 'article', `${label}: og:type`);
  assert.equal(meta(post.text, 'name', 'description'), 'Headings, links between posts, and highlighted code.', `${label}: description`);
  assert.equal(meta(post.text, 'property', 'og:image'), `${ORIGIN}/assets/social-card.png`, `${label}: default og:image`);
  const hero = await html(site, '/blog/customizing-the-site/', label);
  assert.equal(meta(hero.text, 'property', 'og:image'), `${ORIGIN}/blog/images-and-figures/harbor.png`, `${label}: post og:image`);
  assert.equal(meta(hero.text, 'name', 'twitter:card'), 'summary_large_image', `${label}: twitter card`);
  assert.match(missing.text, /<meta name="robots" content="noindex">/, `${label}: 404 noindex`);
  assert.doesNotMatch(missing.text, /canonical/, `${label}: 404 has no canonical`);
  assert.match(home.text, /<link rel="alternate" href="\/feed\/feed\.xml" type="application\/atom\+xml"/, `${label}: feed discovery link`);

  // ── tags
  const tags = await html(site, '/tags/', label);
  for (const tag of SAMPLE.tags) {
    if (!dev && tag === 'drafts') continue;
    assert.ok(hrefs(tags.text).includes(`/tags/${tag}/`), `${label}: tags page lists ${tag}`);
  }
  const basics = await html(site, '/tags/basics/', label);
  assert.deepEqual(listedHrefs(basics.text), ['/blog/tags-and-drafts/', '/blog/images-and-figures/', '/blog/writing-posts/', '/blog/welcome/'], `${label}: tag page order`);

  // ── images
  const figure = await html(site, '/blog/images-and-figures/', label);
  const img = /<img src="(\/blog\/images-and-figures\/harbor\.png)" srcset="([^"]+)" sizes="[^"]+" alt="[^"]+" width="1200" height="675" loading="lazy" decoding="async">/.exec(figure.text);
  assert.ok(img, `${label}: figure image has src, srcset, sizes, alt, dimensions, lazy loading`);
  assert.match(figure.text, /<figcaption>A harbor at dusk\./, `${label}: figure caption`);
  for (const candidate of img[2].split(',').map((entry) => entry.trim().split(/\s+/))) {
    const { body } = await fetchOk(site, candidate[0], { type: 'image/png', label });
    assert.deepEqual([...body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${label}: ${candidate[0]} is a PNG`);
    assert.equal(body.readUInt32BE(16), Number.parseInt(candidate[1], 10), `${label}: ${candidate[0]} is ${candidate[1]} wide`);
  }
  assert.match(hero.text, /<div class="hero"><img [^>]*fetchpriority="high"/, `${label}: hero image is high priority`);
  await fetchOk(site, '/assets/social-card.png', { type: 'image/png', label });
  const icon = await fetchOk(site, '/assets/favicon.svg', { type: 'image/svg+xml', label });
  assert.match(icon.text, /<svg\b/, `${label}: favicon is an SVG`);

  // ── no link on any page leads to a missing page or file
  const pages = ['/', '/blog/', '/blog/page/2/', '/tags/', '/about/', ...posts.filter((slug) => dev || slug !== SAMPLE.draft).map((slug) => `/blog/${slug}/`)];
  const checked = new Set();
  for (const path of pages) {
    const page = await html(site, path, label);
    for (const target of hrefs(page.text)) {
      if (!target.startsWith('/') || target.startsWith('//')) continue;
      const clean = target.split('#')[0];
      if (checked.has(clean)) continue;
      checked.add(clean);
      const response = await get(site, clean);
      await response.arrayBuffer();
      assert.ok(response.status < 400, `${label}: ${path} links to ${target}, which answers ${response.status}`);
    }
  }

  // ── about
  const about = await html(site, '/about/', label);
  assert.equal(h1(about.text), 'About', `${label}: about heading`);
  assert.match(about.text, /<a href="\/blog\/welcome\/">read the first post<\/a>/, `${label}: .md link in about is rewritten`);

  // ── feed, sitemap, robots
  const feed = await fetchOk(site, '/feed/feed.xml', { type: 'application/atom+xml', label }).catch(async (error) => {
    // The production server answers text/xml for .xml files; accept either spelling of a feed type.
    if (!/content type/.test(error.message)) throw error;
    return fetchOk(site, '/feed/feed.xml', { type: 'text/xml', label });
  });
  const entries = atomEntries(feed.text);
  assert.deepEqual(entries.map((entry) => entry.link), newestFirst.map((slug) => `${ORIGIN}/blog/${slug}/`), `${label}: feed entries`);
  assert.equal(entries[0].title, SAMPLE.titles[newestFirst[0]], `${label}: feed title`);
  const withImage = entries.find((entry) => entry.link.endsWith('/images-and-figures/'));
  assert.match(withImage.content, /src="https:\/\/example\.com\/blog\/images-and-figures\/harbor\.png"/, `${label}: feed image URL is absolute`);
  assert.match(withImage.content, /srcset="https:\/\/example\.com\/blog\/images-and-figures\/harbor-480w\.png 480w, /, `${label}: feed srcset is absolute`);
  assert.doesNotMatch(feed.text, /class="ha"/, `${label}: feed has no heading anchors`);
  // The published "Tags and drafts" post talks about the draft by file name, so match the draft's
  // address and entry title, not the words.
  assert.ok(!entries.some((entry) => entry.link.includes(SAMPLE.draft) || /^Next up/.test(entry.title)), `${label}: feed has no draft entry`);
  assert.ok(!feed.text.includes(`${ORIGIN}/blog/${SAMPLE.draft}/`), `${label}: feed never links to the draft`);
  if (!dev) {
    const sitemap = await fetchOk(site, '/sitemap.xml', { type: 'text/xml', label });
    const urls = sitemapPaths(sitemap.text);
    assert.ok(urls.includes('/blog/page/2/') && urls.includes('/tags/basics/') && urls.includes('/blog/welcome/'), `${label}: sitemap lists pages, archive pages, and tags`);
    assert.ok(!urls.some((url) => url.includes(SAMPLE.draft)), `${label}: sitemap has no draft`);
    assert.ok(!urls.includes('/404.html'), `${label}: sitemap has no 404 page`);
    const robots = await fetchOk(site, '/robots.txt', { type: 'text/plain', label });
    assert.match(robots.text, /Sitemap: https:\/\/example\.com\/sitemap\.xml/, `${label}: robots points at the sitemap`);
  }
}

/** A draft must not appear in any built page, feed, or sitemap of a production build. */
export function assertNoDraft(entries, label, slug = SAMPLE.draft) {
  const pattern = new RegExp(`/blog/${slug}/|>${SAMPLE.titles[slug] ?? 'Next up'}<`);
  for (const [file, text] of entries) {
    assert.doesNotMatch(text, pattern, `${label}: ${file} mentions the draft`);
  }
}
