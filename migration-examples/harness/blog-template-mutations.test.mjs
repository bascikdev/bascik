import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertOutsideRepository, launch, unusedPort } from './runner.mjs';
import { ORIGIN, SAMPLE, atomEntries, listedHrefs, png } from './blog-template-checks.mjs';

// Task 06: content mutations against the blog starter. Every scenario runs in an isolated
// temporary copy outside the repository. Production scenarios use `bascik --build` and read
// dist/. Development scenarios run the real dev server and watch a real browser page update.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const templateSource = fileURLToPath(new URL('../../templates/blog/', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const BIN = 'node_modules/@bascik/bascik/bin/bascik.js';

let browser;
let root;
let base;
before(async () => {
  assert.ok(tarball, 'Set BASCIK_TARBALL to a freshly packed local source artifact');
  browser = await chromium.launch();
  root = await realpath(await mkdtemp(join(tmpdir(), 'bascik-blog-mutation-')));
  assertOutsideRepository(root, repository);
  base = join(root, 'base');
  await cp(templateSource, base, { recursive: true, filter: (path) => !/[\\/](node_modules|dist|\.bascik)$/.test(path) });
  for (const command of [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
  ]) {
    const handle = launch(command, base, { ...process.env });
    try { await handle.wait(240000); } finally { await handle.stop(); }
  }
});
after(async () => {
  await browser?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

let counter = 0;
async function workspace() {
  const directory = join(root, `work-${counter++}`);
  await cp(base, directory, { recursive: true, verbatimSymlinks: true });
  return directory;
}

const buildEnv = (extra = {}) => {
  const env = { ...process.env, BASCIK_SITE_URL: ORIGIN, ...extra };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
};

async function build(directory, extra = {}) {
  const handle = launch([process.execPath, BIN, '--build'], directory, buildEnv(extra));
  try { await handle.wait(180000); } finally { await handle.stop(); }
}

/** A build that must fail. Resolves to the combined output, and requires that it never claims success. */
async function failingBuild(directory, extra = {}) {
  let message = '';
  await assert.rejects(build(directory, extra), (error) => { message = error.message; return true; });
  assert.doesNotMatch(message, /Build complete/, 'a failed build must not report success');
  return message;
}

const dist = (directory, path) => join(directory, 'dist', path);
const read = (directory, path) => readFile(dist(directory, path), 'utf8');
const exists = async (directory, path) => access(dist(directory, path)).then(() => true, () => false);

async function walk(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(directory, relative));
    else found.push(relative);
  }
  return found.sort();
}

async function fingerprint(directory) {
  const files = (await walk(join(directory, 'dist'))).filter((file) => !file.startsWith('.bascik/'));
  const result = {};
  for (const file of files) result[file] = createHash('sha256').update(await readFile(dist(directory, file))).digest('hex');
  return result;
}

const frontMatter = (title, date, { tags, draft, description, image } = {}) => [
  '---',
  `title: ${JSON.stringify(title)}`,
  ...(description ? [`description: ${JSON.stringify(description)}`] : []),
  `date: ${date}`,
  ...(tags ? [`tags: ${JSON.stringify(tags)}`] : []),
  ...(draft === undefined ? [] : [`draft: ${draft}`]),
  ...(image ? [`image: ${JSON.stringify(image)}`] : []),
  '---',
].join('\n');

const writePost = (directory, name, title, date, options = {}, body = 'Some text.') =>
  writeFile(join(directory, 'content/blog', name), `${frontMatter(title, date, options)}\n${body}\n`);

/** Replace every sample post with `count` simple ones, dated one day apart (post-01 is oldest). */
async function onlyPosts(directory, count, options = {}) {
  for (const entry of await readdir(join(directory, 'content/blog'))) await rm(join(directory, 'content/blog', entry), { recursive: true });
  // The About page links to the welcome post; keep that link valid.
  await writeFile(join(directory, 'content/about.md'), '# About\n\nPlain about page.\n');
  for (let n = 1; n <= count; n++) {
    const day = String(n).padStart(2, '0');
    await writePost(directory, `post-${day}.md`, `Post ${n}`, `2026-01-${day}`, options);
  }
}

const h1Of = (html) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
const titleOf = (html) => /<title>([\s\S]*?)<\/title>/.exec(html)?.[1];
const sitemapUrls = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].replace(ORIGIN, ''));

async function everyBuiltText(directory) {
  const files = (await walk(join(directory, 'dist'))).filter((file) => /\.(html|xml|txt)$/.test(file) && !file.startsWith('.bascik/'));
  return Promise.all(files.map(async (file) => [file, await read(directory, file)]));
}

// ── production scenarios ───────────────────────────────────────────────────────────────────────

test('production: a repeated build is byte-identical', async () => {
  const work = await workspace();
  await build(work);
  const first = await fingerprint(work);
  await build(work);
  assert.deepEqual(await fingerprint(work), first);
  assert.ok(Object.keys(first).length >= 25, 'the build wrote the expected files');
});

test('production: the draft and its text are in no built page, feed, or sitemap', async () => {
  const work = await workspace();
  await build(work);
  assert.equal(await exists(work, `blog/${SAMPLE.draft}/index.html`), false);
  for (const [file, text] of await everyBuiltText(work)) {
    assert.doesNotMatch(text, /\/blog\/next-up\/|It shows up while you run|>Next up</, `${file} mentions the draft`);
  }
});

test('production: archive pagination at its edges (0, 1, 5, 6, 10, 11 posts)', async () => {
  const work = await workspace();
  const expectations = [
    { count: 0, pages: [] },
    { count: 1, pages: [] },
    { count: 5, pages: [] },
    { count: 6, pages: [2] },
    { count: 10, pages: [2] },
    { count: 11, pages: [2, 3] },
  ];
  for (const { count, pages } of expectations) {
    await onlyPosts(work, count);
    await build(work);
    const generated = (await exists(work, 'blog/page')) ? (await readdir(dist(work, 'blog/page'))).sort() : [];
    assert.deepEqual(generated, pages.map(String), `${count} posts: archive pages 2 and up`);
    const first = await read(work, 'blog/index.html');
    assert.equal(listedHrefs(first).length, Math.min(count, 5), `${count} posts: first page size`);
    assert.equal(/class="pager"|<nav[^>]*Archive pages/.test(first), count > 5, `${count} posts: pager only when there is more than one page`);
    if (count === 0) assert.match(first, /No posts yet\./);
    // Every post is on exactly one archive page, newest first, with no gaps.
    const all = [];
    for (const page of [1, ...pages]) all.push(...listedHrefs(await read(work, page === 1 ? 'blog/index.html' : `blog/page/${page}/index.html`)));
    assert.deepEqual(all, Array.from({ length: count }, (_unused, index) => `/blog/post-${String(count - index).padStart(2, '0')}/`), `${count} posts: order across pages`);
    if (pages.length) {
      const last = pages.at(-1);
      assert.match(await read(work, `blog/page/${last}/index.html`), new RegExp(`Page ${last} of ${last}`));
      assert.doesNotMatch(await read(work, `blog/page/${last}/index.html`), /rel="next"/, `${count} posts: last page has no next link`);
    }
    assert.equal(await exists(work, `blog/page/${pages.length + 2}/index.html`), false, `${count} posts: no page beyond the last`);
  }
});

test('production: shrinking the archive removes the page that is no longer needed, from disk and the sitemap', async () => {
  const work = await workspace();
  await onlyPosts(work, 11);
  await build(work);
  assert.equal(await exists(work, 'blog/page/3/index.html'), true);
  assert.ok(sitemapUrls(await read(work, 'sitemap.xml')).includes('/blog/page/3/'));
  await rm(join(work, 'content/blog/post-11.md'));
  await build(work);
  assert.equal(await exists(work, 'blog/page/3'), false, 'no stale directory for page 3');
  assert.equal(await exists(work, 'blog/page/3/index.html'), false);
  assert.ok(!sitemapUrls(await read(work, 'sitemap.xml')).includes('/blog/page/3/'));
  assert.equal(await exists(work, 'blog/post-11'), false, 'the removed post has no page');
  assert.equal(listedHrefs(await read(work, 'blog/page/2/index.html')).length, 5);
});

test('production: adding a post updates its page, lists, neighbors, tags, sitemap, and feed', async () => {
  const work = await workspace();
  await build(work);
  await writePost(work, 'harbor-notes.md', 'Harbor notes', '2026-07-01', { tags: ['basics', 'brand new'] });
  await build(work);

  assert.equal(h1Of(await read(work, 'blog/harbor-notes/index.html')), 'Harbor notes');
  const home = await read(work, 'index.html');
  assert.deepEqual(listedHrefs(home), ['/blog/harbor-notes/', '/blog/deploying/', '/blog/customizing-the-site/']);
  assert.match(home, /4 more posts in/);
  assert.match(await read(work, 'blog/deploying/index.html'), /links-nextprev-next">Next \u2192<br><a href="\/blog\/harbor-notes\/" rel="next">Harbor notes</);
  assert.equal(await exists(work, 'tags/brand-new/index.html'), true);
  assert.match(await read(work, 'tags/index.html'), /href="\/tags\/brand-new\/"/);
  assert.equal(listedHrefs(await read(work, 'tags/basics/index.html'))[0], '/blog/harbor-notes/');
  assert.ok(sitemapUrls(await read(work, 'sitemap.xml')).includes('/blog/harbor-notes/'));
  assert.equal(atomEntries(await read(work, 'feed/feed.xml'))[0].link, `${ORIGIN}/blog/harbor-notes/`);
});

test('production: editing a post updates every place it appears and leaves no stale text', async () => {
  const work = await workspace();
  await build(work);
  const before = await fingerprint(work);
  const source = await readFile(join(work, 'content/blog/deploying.md'), 'utf8');
  await writeFile(join(work, 'content/blog/deploying.md'), source.replace('title: "Deploying"', 'title: "Shipping it"').replace(/^title: Deploying$/m, 'title: Shipping it'));
  await build(work);

  assert.equal(h1Of(await read(work, 'blog/deploying/index.html')), 'Shipping it');
  assert.equal(titleOf(await read(work, 'blog/deploying/index.html')), 'Shipping it | Lantern Log');
  assert.match(await read(work, 'blog/index.html'), /class="postlist-link">Shipping it</);
  assert.match(await read(work, 'index.html'), /class="postlist-link">Shipping it</);
  assert.match(await read(work, 'tags/deploying/index.html'), /class="postlist-link">Shipping it</);
  assert.ok(atomEntries(await read(work, 'feed/feed.xml')).some((entry) => entry.title === 'Shipping it'));
  // The title comes from the front matter everywhere it is generated. (A link written by hand in
  // another post's text, such as the list in the welcome post, keeps the words its author typed.)
  for (const [file, text] of await everyBuiltText(work)) {
    assert.doesNotMatch(text, /class="postlist-link">Deploying<|rel="(?:prev|next)">Deploying<|<title>Deploying/, `${file} still shows the old title`);
  }
  const after = await fingerprint(work);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'an edit adds and removes no files');
  assert.equal(after['blog/welcome/index.html'] === before['blog/welcome/index.html'], true, 'an unrelated post is byte-identical');
});

test('production: removing a post that other posts link to fails until the link is removed', async () => {
  const work = await workspace();
  await build(work);
  await rm(join(work, 'content/blog/writing-posts.md'));
  assert.match(await failingBuild(work), /content\/blog\/welcome\.md: link "writing-posts\.md" does not point at a published page/);
  assert.equal(await exists(work, 'blog/writing-posts/index.html'), false, 'the removed page is not left behind');
  assert.equal(await exists(work, 'blog/welcome/index.html'), false, 'a failed build leaves no stale pages');
});

test('production: removing a post removes its page, links, tags, sitemap entry, and feed entry', async () => {
  const work = await workspace();
  await build(work);
  await rm(join(work, 'content/blog/deploying.md'));
  const welcome = await readFile(join(work, 'content/blog/welcome.md'), 'utf8');
  await writeFile(join(work, 'content/blog/welcome.md'), welcome.replace('- [Deploying](deploying.md) covers the production build.\n', ''));
  await build(work);

  assert.equal(await exists(work, 'blog/deploying/index.html'), false, 'no stale route');
  assert.equal(await exists(work, 'blog/deploying'), false, 'no stale directory');
  assert.equal(await exists(work, 'tags/deploying/index.html'), false, 'no stale tag page');
  assert.doesNotMatch(await read(work, 'tags/index.html'), /\/tags\/deploying\//);
  assert.ok(!sitemapUrls(await read(work, 'sitemap.xml')).includes('/blog/deploying/'));
  assert.ok(!atomEntries(await read(work, 'feed/feed.xml')).some((entry) => entry.link.endsWith('/deploying/')));
  assert.match(await read(work, 'blog/customizing-the-site/index.html'), /<ul class="links-nextprev"><li class="links-nextprev-prev">/);
  // (The inlined stylesheet names this class, so match the attribute on an element.)
  assert.doesNotMatch(await read(work, 'blog/customizing-the-site/index.html'), /<li class="links-nextprev-next">/, 'the newest post has no next link now');
  assert.match(await read(work, 'index.html'), /2 more posts in/);
  for (const [file, text] of await everyBuiltText(work)) {
    assert.doesNotMatch(text, /\/blog\/deploying\/|>Deploying</, `${file} still mentions the removed post`);
  }
});

test('production: removing a post folder removes its page and every image beside it', async () => {
  const work = await workspace();
  await build(work);
  assert.equal(await exists(work, 'blog/images-and-figures/harbor-480w.png'), true);
  // The hero image of another post lives in this folder, so point it elsewhere first.
  await mkdir(join(work, 'content/blog/shared'), { recursive: true });
  await cp(join(work, 'content/blog/images-and-figures/harbor.png'), join(work, 'content/blog/shared/harbor.png'));
  const customizing = await readFile(join(work, 'content/blog/customizing-the-site.md'), 'utf8');
  await writeFile(join(work, 'content/blog/customizing-the-site.md'), customizing.replace('/blog/images-and-figures/harbor.png', '/blog/shared/harbor.png'));
  const welcome = await readFile(join(work, 'content/blog/welcome.md'), 'utf8');
  await writeFile(join(work, 'content/blog/welcome.md'), welcome.replace(/- \[Images and figures\].*\n/, ''));
  await rm(join(work, 'content/blog/images-and-figures'), { recursive: true });
  await build(work);
  assert.equal(await exists(work, 'blog/images-and-figures'), false, 'neither page nor images remain');
  assert.equal(await exists(work, 'blog/shared/harbor.png'), true, 'an image that is still used is published');
});

test('production: moving a post into a folder of the same name keeps its URL and output', async () => {
  const work = await workspace();
  await build(work);
  const before = await read(work, 'blog/deploying/index.html');
  await mkdir(join(work, 'content/blog/deploying'));
  await rename(join(work, 'content/blog/deploying.md'), join(work, 'content/blog/deploying/deploying.md'));
  const welcome = await readFile(join(work, 'content/blog/welcome.md'), 'utf8');
  await writeFile(join(work, 'content/blog/welcome.md'), welcome.replace('(deploying.md)', '(deploying/deploying.md)'));
  await build(work);
  assert.equal(await read(work, 'blog/deploying/index.html'), before);
  assert.equal(await exists(work, 'blog/deploying/deploying/index.html'), false);
});

test('production: a draft turns into a published post, and its images follow', async () => {
  const work = await workspace();
  await mkdir(join(work, 'content/blog/secret'));
  await cp(join(work, 'content/blog/images-and-figures/harbor-480w.png'), join(work, 'content/blog/secret/pic.png'));
  await writePost(work, 'secret/secret.md', 'Secret', '2026-08-01', { draft: true }, '![pic](pic.png)');
  await build(work);
  assert.equal(await exists(work, 'blog/secret/index.html'), false);
  assert.equal(await exists(work, 'blog/secret/pic.png'), false, 'a draft\'s image is not published before its text');
  await writePost(work, 'secret/secret.md', 'Secret', '2026-08-01', { draft: false }, '![pic](pic.png)');
  await build(work);
  assert.equal(await exists(work, 'blog/secret/index.html'), true);
  assert.equal(await exists(work, 'blog/secret/pic.png'), true);
  assert.equal(listedHrefs(await read(work, 'index.html'))[0], '/blog/secret/');
});

test('production: an empty blog builds, and every list and the feed say so', async () => {
  const work = await workspace();
  await onlyPosts(work, 0);
  await build(work);
  assert.match(await read(work, 'index.html'), /No posts yet\./);
  assert.match(await read(work, 'blog/index.html'), /No posts yet\./);
  assert.match(await read(work, 'tags/index.html'), /No tags yet\./);
  assert.deepEqual(atomEntries(await read(work, 'feed/feed.xml')), []);
  assert.equal(await exists(work, 'blog/page'), false);
  assert.equal(await exists(work, '404.html'), true);
  assert.equal(await exists(work, 'about/index.html'), true);
});

test('production: a site with no content/blog directory still builds', async () => {
  const work = await workspace();
  await rm(join(work, 'content/blog'), { recursive: true });
  await writeFile(join(work, 'content/about.md'), '# About\n\nText.\n');
  await build(work);
  assert.match(await read(work, 'index.html'), /No posts yet\./);
});

test('production: titles, descriptions, tags, and alt text are escaped, and replacement tokens stay literal', async () => {
  const work = await workspace();
  const title = `<b>x</b> & "q" 'z' costs $& and $1 and $\``;
  const description = 'a "quoted" <i>note</i> & $& more';
  await writePost(work, 'tricky.md', title, '2026-09-09', { tags: ['C++ & Rust'], description }, 'Price is $1.50, $& stays, and $$ too. Use `$1` and `$&` in code.\n\n```js\nconst a = "$&" + \'$1\';\n```');
  await build(work);

  const page = await read(work, 'blog/tricky/index.html');
  const escaped = '&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot; &#39;z&#39; costs $&amp; and $1 and $`';
  assert.equal(h1Of(page), escaped);
  assert.equal(titleOf(page), `${escaped} | Lantern Log`);
  assert.doesNotMatch(page, /<b>x<\/b>/);
  const metaDescription = /<meta name="description" content="([^"]*)"/.exec(page)?.[1];
  assert.equal(metaDescription, 'a &quot;quoted&quot; &lt;i&gt;note&lt;/i&gt; &amp; $&amp; more', 'a description cannot break out of its attribute');
  assert.equal(await exists(work, 'tags/c-rust/index.html'), true);
  assert.match(page, /Price is \$1\.50, \$&amp; stays, and \$\$ too\./);
  assert.match(page, /<code>\$1<\/code> and <code>\$&amp;<\/code> in code\./);
  assert.match(page, /<span class="token string">"\$&amp;"<\/span>/, 'highlighting keeps $& literal');
  const entry = atomEntries(await read(work, 'feed/feed.xml')).find((candidate) => candidate.link === `${ORIGIN}/blog/tricky/`);
  assert.equal(entry.title, title, 'the feed carries the original text');
});

for (const [name, setup, pattern, env = {}] of [
  ['front matter without a date', (work) => writeFile(join(work, 'content/blog/nodate.md'), '---\ntitle: No date\n---\nbody\n'), /Invalid front matter in content\/blog\/nodate\.md/],
  ['front matter without a title', (work) => writeFile(join(work, 'content/blog/notitle.md'), '---\ndate: 2026-01-01\n---\nbody\n'), /Invalid front matter in content\/blog\/notitle\.md[\s\S]*title/],
  ['a misspelled front matter key', (work) => writeFile(join(work, 'content/blog/typo.md'), '---\ntitle: T\ndate: 2026-01-01\ntag: oops\n---\nbody\n'), /Invalid front matter in content\/blog\/typo\.md[\s\S]*tag/],
  ['a non-boolean draft flag', (work) => writePost(work, 'baddraft.md', 'Bad', '2026-01-01', { draft: '"yes"' }), /Invalid front matter in content\/blog\/baddraft\.md/],
  ['a broken draft, which is still validated in production', (work) => writeFile(join(work, 'content/blog/halfdone.md'), '---\ntitle: Half\ndraft: true\n---\nbody\n'), /Invalid front matter in content\/blog\/halfdone\.md/],
  ['two files that publish one URL', async (work) => { await mkdir(join(work, 'content/blog/dup')); await writePost(work, 'dup.md', 'A', '2026-01-01'); await writePost(work, 'dup/dup.md', 'B', '2026-01-02'); }, /both publish \/blog\/dup\//],
  ['a file name that is not a safe URL', (work) => writePost(work, 'My Post.md', 'X', '2026-01-01'), /lowercase letters, digits, and single hyphens/],
  ['a post named "page", which would collide with the archive', (work) => writePost(work, 'page.md', 'X', '2026-01-01'), /"page" is reserved/],
  ['tags that collide on one URL', async (work) => { await writePost(work, 'a.md', 'A', '2026-01-01', { tags: ['Foo'] }); await writePost(work, 'b.md', 'B', '2026-01-02', { tags: ['foo'] }); }, /would both publish \/tags\/foo\//],
  ['a tag with no letters or digits', (work) => writePost(work, 'sym.md', 'S', '2026-01-01', { tags: ['***'] }), /has no letters or digits/],
  ['nesting deeper than one folder', async (work) => { await mkdir(join(work, 'content/blog/a/b'), { recursive: true }); await writePost(work, 'a/b/c.md', 'C', '2026-01-01'); }, /use content\/blog\/name\.md or content\/blog\/name\/name\.md/],
  ['a link to a file that does not exist', (work) => writePost(work, 'broken.md', 'Broken', '2026-01-01', {}, 'See [it](nowhere.md).'), /does not point at a published page/],
  ['a link to a draft', (work) => writePost(work, 'linker.md', 'Linker', '2026-01-01', {}, 'See [draft](next-up.md).'), /does not point at a published page/],
  ['an image that does not exist', (work) => writePost(work, 'noimg.md', 'No image', '2026-01-01', {}, '![x](./missing.png)'), /image "\.\/missing\.png" does not exist/],
  ['a hero image that does not exist', (work) => writePost(work, 'nohero.md', 'No hero', '2026-01-01', { image: 'gone.png' }), /content\/blog\/nohero\.md: image "gone\.png" does not exist/],
  ['a resized copy with the wrong width', async (work) => { await cp(join(work, 'content/blog/images-and-figures/harbor-960w.png'), join(work, 'content/blog/images-and-figures/harbor-700w.png')); }, /harbor-700w\.png: the name says 700w but the image is 960px wide/],
  ['a resized copy that was cropped', (work) => writeFile(join(work, 'content/blog/images-and-figures/harbor-300w.png'), png(300, 300)), /harbor-300w\.png: 300x300 does not have the same shape as harbor\.png \(1200x675\)/],
  ['a Markdown link that leaves the content folder', (work) => writePost(work, 'escape.md', 'Escape', '2026-01-01', {}, '[x](../../package.json.md)'), /points outside content\//],
  ['a missing About page', (work) => rm(join(work, 'content/about.md')), /about\.md/],
  ['a site URL with a path', () => {}, /no path/, { BASCIK_SITE_URL: 'https://example.com/blog' }],
  // Bascik validates the URL itself before the template's helpers run, and a build with a sitemap
  // and robots.txt refuses to finish without one.
  ['a site URL that is not a URL', () => {}, /BASCIK_SITE_URL\s+"example\.com"\s+expected an absolute http or https URL/, { BASCIK_SITE_URL: 'example.com' }],
  ['no site URL at all', () => {}, /BASCIK_SITE_URL is not set, but generate\.sitemap and generate\.robots are enabled/, { BASCIK_SITE_URL: undefined }],
]) {
  test(`production: ${name} fails the build with a message naming the cause`, async () => {
    const work = await workspace();
    await setup(work);
    assert.match(await failingBuild(work, env), pattern);
  });
}

test('production: fixing a failed build recovers without leftovers', async () => {
  const work = await workspace();
  await writeFile(join(work, 'content/blog/nodate.md'), '---\ntitle: No date\n---\nbody\n');
  await failingBuild(work);
  await rm(join(work, 'content/blog/nodate.md'));
  await build(work);
  assert.equal(await exists(work, 'blog/nodate/index.html'), false);
  assert.equal(await exists(work, 'blog/welcome/index.html'), true);
});

test('production: the sample is not hard-wired, so a different site name reaches every page and the feed', async () => {
  const work = await workspace();
  const site = await readFile(join(work, 'src/data/site.ts'), 'utf8');
  await writeFile(join(work, 'src/data/site.ts'), site.replace("title: 'Lantern Log'", "title: 'Tide Table'").replace("name: 'Your Name'", "name: 'A. Writer'").replace('postsPerPage: 5', 'postsPerPage: 2'));
  await build(work);
  // Everything generated from the settings changes. (The About page is text its author wrote, and
  // the sample's mentions the sample name, so check the generated parts, not every word.)
  for (const [file, text] of await everyBuiltText(work)) {
    if (!file.endsWith('.html')) { assert.doesNotMatch(text, /Lantern Log/, `${file} still has the old site name`); continue; }
    assert.doesNotMatch(text, /<title>[^<]*Lantern Log|og:site_name" content="Lantern Log|class="home-link"[^>]*>Lantern Log|alternate"[^>]*title="Lantern Log/, `${file} still has the old site name`);
  }
  assert.equal(titleOf(await read(work, 'index.html')), 'Tide Table');
  assert.match(await read(work, 'feed/feed.xml'), /Tide Table/);
  assert.match(await read(work, 'index.html'), /A\. Writer/);
  assert.equal(listedHrefs(await read(work, 'blog/index.html')).length, 2, 'postsPerPage is honored');
  assert.equal(await exists(work, 'blog/page/3/index.html'), true);
});

// ── development scenarios ──────────────────────────────────────────────────────────────────────

async function waitFor(check, message, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${message}${last ? `: ${last.message}` : ''}`);
}

async function devServer(work) {
  const port = await unusedPort();
  const handle = launch([process.execPath, BIN, '--port', String(port), '--host', '127.0.0.1'], work, buildEnv());
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    handle.assertAlive();
    if (!handle.output().includes('Server running at')) return false;
    // The first transpile is done when a page that cannot exist stops getting the boot page.
    const response = await fetch(`${url}/no/such/page/`);
    return response.status === 404 && !(await response.text()).includes('Building site');
  }, 'the dev server to finish its first build', 60000);
  return { handle, url };
}

test('development: edits to content reach an open browser page through live reload', async () => {
  const work = await workspace();
  const { handle, url } = await devServer(work);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}/blog/`);
    const links = () => page.locator('main ol li a').allInnerTexts();
    assert.equal((await links()).length, 5);
    assert.ok((await links())[0].includes('Next up (draft)'), 'the dev server lists the draft, newest first');

    // Add a post.
    await writePost(work, 'harbor-notes.md', 'Harbor notes', '2026-09-01');
    await page.waitForFunction(() => document.body.innerText.includes('Harbor notes'), null, { timeout: 25000 });
    assert.equal((await fetch(`${url}/blog/harbor-notes/`)).status, 200);

    // Edit a post.
    const source = await readFile(join(work, 'content/blog/harbor-notes.md'), 'utf8');
    await writeFile(join(work, 'content/blog/harbor-notes.md'), source.replace('Harbor notes', 'Harbor notes, revised'));
    await page.waitForFunction(() => document.body.innerText.includes('Harbor notes, revised'), null, { timeout: 25000 });

    // Remove a post nothing links to.
    await rm(join(work, 'content/blog/harbor-notes.md'));
    await page.waitForFunction(() => !document.body.innerText.includes('Harbor notes'), null, { timeout: 25000 });
    await waitFor(async () => (await fetch(`${url}/blog/harbor-notes/`)).status === 404, 'the removed route to return 404');

    // The draft flag takes effect without a restart.
    const draft = await readFile(join(work, 'content/blog/next-up.md'), 'utf8');
    await writeFile(join(work, 'content/blog/next-up.md'), draft.replace('draft: true', 'draft: false'));
    await page.waitForFunction(() => !document.body.innerText.includes('(draft)'), null, { timeout: 25000 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await handle.stop();
  }
});

test('development: a site setting change reaches the page without a restart', async () => {
  const work = await workspace();
  const { handle, url } = await devServer(work);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${url}/about/`);
    const site = await readFile(join(work, 'src/data/site.ts'), 'utf8');
    await writeFile(join(work, 'src/data/site.ts'), site.replace("title: 'Lantern Log'", "title: 'Tide Table'"));
    await page.waitForFunction(() => document.querySelector('header a')?.textContent === 'Tide Table' || document.body.innerText.includes('Tide Table'), null, { timeout: 25000 });
  } finally {
    await context.close();
    await handle.stop();
  }
});

test('development: invalid content does not stop the server, and fixing it recovers', async () => {
  const work = await workspace();
  const { handle, url } = await devServer(work);
  try {
    await writeFile(join(work, 'content/blog/nodate.md'), '---\ntitle: No date\n---\nbody\n');
    await delay(1500);
    handle.assertAlive();
    assert.equal((await fetch(`${url}/about/`)).status, 200, 'the server keeps answering');
    await rm(join(work, 'content/blog/nodate.md'));
    await writePost(work, 'recovered.md', 'Recovered entry', '2026-09-02');
    await waitFor(async () => (await fetch(`${url}/blog/`).then((response) => response.text())).includes('Recovered entry'), 'the page to show the new post after the fix');
  } finally {
    await handle.stop();
  }
});

test('development: a post image added beside its post is served', async () => {
  const work = await workspace();
  const { handle, url } = await devServer(work);
  try {
    await mkdir(join(work, 'content/blog/withimage'));
    await cp(join(work, 'content/blog/images-and-figures/harbor-480w.png'), join(work, 'content/blog/withimage/pic.png'));
    await writePost(work, 'withimage/withimage.md', 'With image', '2026-09-03', {}, '![a small harbor](pic.png)');
    await waitFor(async () => (await fetch(`${url}/blog/withimage/`)).status === 200, 'the new post page');
    const page = await (await fetch(`${url}/blog/withimage/`)).text();
    const src = /<img src="([^"]+)"/.exec(page)?.[1];
    assert.equal(src, '/blog/withimage/pic.png');
    await waitFor(async () => (await fetch(`${url}${src}`)).headers.get('content-type')?.startsWith('image/'), 'the image to be served');
  } finally {
    await handle.stop();
  }
});

test('development: without a site URL the pages still build and leave out absolute URLs', async () => {
  const work = await workspace();
  const port = await unusedPort();
  const handle = launch([process.execPath, BIN, '--port', String(port), '--host', '127.0.0.1'], work, buildEnv({ BASCIK_SITE_URL: undefined }));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      handle.assertAlive();
      const response = await fetch(`${url}/no/such/page/`);
      return response.status === 404 && !(await response.text()).includes('Building site');
    }, 'the first build', 60000);
    const post = await (await fetch(`${url}/blog/welcome/`)).text();
    assert.doesNotMatch(post, /canonical|og:url|og:image/, 'no relative stand-ins for absolute URLs');
    assert.match(post, /<title>Welcome to the lantern log \| Lantern Log<\/title>/);
    assert.match(handle.output(), /skipped feed: set BASCIK_SITE_URL/);
    handle.assertAlive();
  } finally {
    await handle.stop();
  }
});
