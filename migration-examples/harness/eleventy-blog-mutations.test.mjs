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
import { atomEntries, unescapeXml } from './eleventy-blog-checks.mjs';

// Task 04: content mutations against the Bascik port of the Eleventy base blog. Every scenario runs in
// an isolated temporary copy outside the repository, never in the committed source. Production
// scenarios use `bascik --build` and read dist/. Development scenarios run the real dev server and
// watch a real browser page update through the live-reload channel.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const portSource = fileURLToPath(new URL('../ports/eleventy-blog/', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const BIN = 'node_modules/@bascik/bascik/bin/bascik.js';
const ORIGIN = 'https://example.com';

let browser;
let root;
let base;
before(async () => {
  browser = await chromium.launch();
  root = await realpath(await mkdtemp(join(tmpdir(), 'bascik-mutation-')));
  assertOutsideRepository(root, repository);
  base = join(root, 'base');
  await cp(portSource, base, { recursive: true, filter: (path) => !/[\\/](node_modules|dist)$/.test(path) });
  const env = { ...process.env };
  for (const command of [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ...(tarball ? [['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]] : []),
  ]) {
    const handle = launch(command, base, env);
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

const frontMatter = (title, date, { tags, draft, description } = {}) => [
  '---',
  `title: ${JSON.stringify(title)}`,
  ...(description ? [`description: ${JSON.stringify(description)}`] : []),
  `date: ${date}`,
  ...(tags ? [`tags: ${JSON.stringify(tags)}`] : []),
  ...(draft === undefined ? [] : [`draft: ${draft}`]),
  '---',
].join('\n');

const writePost = (directory, name, title, date, options = {}, body = 'Some text.') =>
  writeFile(join(directory, 'content/blog', name), `${frontMatter(title, date, options)}\n${body}\n`);

/** `[href, text]` pairs for the post list inside a built page. */
function listed(html) {
  return [...html.matchAll(/<a href="([^"]+)" class="postlist-link">([\s\S]*?)<\/a>/g)].map((match) => [match[1], match[2]]);
}
const titleOf = (html) => /<title>([\s\S]*?)<\/title>/.exec(html)?.[1];
const h1Of = (html) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
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
  assert.ok(Object.keys(first).length >= 14, 'the build wrote the expected files');
});

test('production: drafts are not written, so nothing can link to them', async () => {
  const work = await workspace();
  await build(work);
  assert.equal(await exists(work, 'blog/fifthpost/index.html'), false);
  for (const [file, text] of await everyBuiltText(work)) {
    assert.doesNotMatch(text, /fifthpost|Notes still being written/, `${file} mentions the draft`);
  }
});

test('production: adding a post updates its page, lists, neighbors, tags, sitemap, and feed', async () => {
  const work = await workspace();
  await build(work);
  await writePost(work, 'sixthpost.md', 'Sixth entry', '2019-02-02', { tags: ['second tag', 'brand new'] });
  await build(work);

  assert.equal(h1Of(await read(work, 'blog/sixthpost/index.html')), 'Sixth entry');
  const home = await read(work, 'index.html');
  assert.deepEqual(listed(home).map(([href]) => href), ['/blog/sixthpost/', '/blog/fourthpost/', '/blog/thirdpost/']);
  assert.match(home, /2 more posts can be found in/);
  assert.equal(listed(await read(work, 'blog/index.html')).length, 5);
  // The previous newest post now has a next link, and the new post links back.
  assert.match(await read(work, 'blog/fourthpost/index.html'), /links-nextprev-next">Next \u2192<br><a href="\/blog\/sixthpost\/">Sixth entry</);
  assert.match(await read(work, 'blog/sixthpost/index.html'), /links-nextprev-prev">\u2190 Previous<br> <a href="\/blog\/fourthpost\/"/);
  assert.equal(await exists(work, 'tags/brand-new/index.html'), true);
  assert.match(await read(work, 'tags/index.html'), /href="\/tags\/brand-new\/"/);
  assert.deepEqual(listed(await read(work, 'tags/second-tag/index.html')).map(([href]) => href), ['/blog/sixthpost/', '/blog/fourthpost/', '/blog/thirdpost/']);
  assert.ok(sitemapUrls(await read(work, 'sitemap.xml')).includes('/blog/sixthpost/'));
  assert.ok(sitemapUrls(await read(work, 'sitemap.xml')).includes('/tags/brand-new/'));
  assert.equal(atomEntries(await read(work, 'feed/feed.xml'))[0].link, `${ORIGIN}/blog/sixthpost/`);
});

test('production: editing a post updates every place it appears and leaves no stale text', async () => {
  const work = await workspace();
  await build(work);
  const before = await fingerprint(work);
  const source = await readFile(join(work, 'content/blog/thirdpost.md'), 'utf8');
  await writeFile(join(work, 'content/blog/thirdpost.md'), source.replace('title: This is a stale marker', '').replace(/^title: .*$/m, 'title: "Renamed tide table"'));
  await build(work);

  assert.equal(h1Of(await read(work, 'blog/thirdpost/index.html')), 'Renamed tide table');
  assert.equal(titleOf(await read(work, 'blog/thirdpost/index.html')), 'Renamed tide table');
  assert.ok(listed(await read(work, 'blog/index.html')).some(([, text]) => text === 'Renamed tide table'));
  assert.match(await read(work, 'blog/secondpost/index.html'), /<a href="\/blog\/thirdpost\/">Renamed tide table</);
  assert.match(await read(work, 'blog/fourthpost/index.html'), /<a href="\/blog\/thirdpost\/">Renamed tide table</);
  assert.ok(listed(await read(work, 'tags/second-tag/index.html')).some(([, text]) => text === 'Renamed tide table'));
  assert.ok(atomEntries(await read(work, 'feed/feed.xml')).some((entry) => entry.title === 'Renamed tide table'));
  for (const [file, text] of await everyBuiltText(work)) {
    assert.doesNotMatch(text, /Measuring a tide table/, `${file} still has the old title`);
  }
  const after = await fingerprint(work);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'an edit adds and removes no files');
  assert.equal(after['blog/firstpost/index.html'] === before['blog/firstpost/index.html'], true, 'an unrelated post is byte-identical');
});

test('production: removing a post that other posts link to fails until the link is removed', async () => {
  const work = await workspace();
  await build(work);
  await rm(join(work, 'content/blog/thirdpost.md'));
  // secondpost links to thirdpost by file path, so the build must say so instead of shipping a dead link.
  assert.match(await failingBuild(work), /content\/blog\/secondpost\.md: link "blog\/thirdpost\.md" does not point at a published page/);
  // A failed build also clears the previous pages, so a broken site never ships a stale mix.
  assert.equal(await exists(work, 'blog/thirdpost/index.html'), false, 'the removed page is not left behind');
  assert.equal(await exists(work, 'blog/secondpost/index.html'), false, 'a failed build leaves no stale pages');
});

test('production: removing a post removes its page, links, tags, sitemap entry, and feed entry', async () => {
  const work = await workspace();
  await build(work);
  assert.equal(await exists(work, 'blog/thirdpost/index.html'), true);
  await rm(join(work, 'content/blog/thirdpost.md'));
  const second = await readFile(join(work, 'content/blog/secondpost.md'), 'utf8');
  await writeFile(join(work, 'content/blog/secondpost.md'), second.replace('<a href="blog/thirdpost.md">Third post</a>\n', ''));
  await build(work);

  assert.equal(await exists(work, 'blog/thirdpost/index.html'), false, 'no stale route');
  assert.equal(await exists(work, 'blog/thirdpost'), false, 'no stale directory');
  // The tag only that post used is gone, and the shared tag lost one entry.
  assert.equal(await exists(work, 'tags/posts-with-two-tags/index.html'), false, 'no stale tag page');
  assert.doesNotMatch(await read(work, 'tags/index.html'), /posts-with-two-tags/);
  assert.deepEqual(listed(await read(work, 'tags/second-tag/index.html')).map(([href]) => href), ['/blog/fourthpost/']);
  assert.match(await read(work, 'blog/secondpost/index.html'), /links-nextprev-next">Next \u2192<br><a href="\/blog\/fourthpost\/"/);
  assert.match(await read(work, 'blog/fourthpost/index.html'), /links-nextprev-prev">\u2190 Previous<br> <a href="\/blog\/secondpost\/"/);
  const home = await read(work, 'index.html');
  assert.equal(h1Of(home), 'Latest 3 Posts');
  assert.doesNotMatch(home, /more posts? can be found/);
  for (const [file, text] of await everyBuiltText(work)) {
    assert.doesNotMatch(text, /thirdpost|tide table/i, `${file} still mentions the removed post`);
  }
});

test('production: removing a post folder removes its page and its image', async () => {
  const work = await workspace();
  await build(work);
  assert.equal(await exists(work, 'blog/fourthpost/lighthouse.png'), true);
  await rm(join(work, 'content/blog/fourthpost'), { recursive: true });
  await build(work);
  assert.equal(await exists(work, 'blog/fourthpost'), false, 'neither page nor image remain');
  assert.equal(await exists(work, 'tags/second-tag/index.html'), true, 'the other post keeps the shared tag');
});

test('production: moving a post to a folder of the same name keeps its URL', async () => {
  const work = await workspace();
  await build(work);
  const before = await read(work, 'blog/firstpost/index.html');
  await mkdir(join(work, 'content/blog/firstpost'));
  await rename(join(work, 'content/blog/firstpost.md'), join(work, 'content/blog/firstpost/firstpost.md'));
  // secondpost links to `/blog/firstpost.md`. Eleventy rewrites that path to the page; the port does
  // too, but the source file moved, so the link must follow it.
  const second = await readFile(join(work, 'content/blog/secondpost.md'), 'utf8');
  await writeFile(join(work, 'content/blog/secondpost.md'), second.replace('/blog/firstpost.md', '/blog/firstpost/firstpost.md'));
  await build(work);
  assert.equal(await read(work, 'blog/firstpost/index.html'), before);
  assert.equal(await exists(work, 'blog/firstpost/firstpost/index.html'), false);
});

test('production: an empty collection builds and every list says so', async () => {
  const work = await workspace();
  await build(work);
  for (const entry of await readdir(join(work, 'content/blog'))) await rm(join(work, 'content/blog', entry), { recursive: true });
  await build(work);

  const home = await read(work, 'index.html');
  assert.equal(h1Of(home), 'Latest 0 Posts');
  assert.deepEqual(listed(home), []);
  assert.doesNotMatch(home, /more posts? can be found/);
  assert.deepEqual(listed(await read(work, 'blog/index.html')), []);
  assert.doesNotMatch(await read(work, 'tags/index.html'), /<li>/);
  assert.deepEqual(atomEntries(await read(work, 'feed/feed.xml')), []);
  for (const route of ['blog/firstpost', 'blog/thirdpost', 'tags/second-tag']) assert.equal(await exists(work, route), false, `${route} is gone`);
  assert.equal(await exists(work, '404.html'), true);
  assert.equal(await exists(work, 'about/index.html'), true);
});

test('production: a site with no content/blog directory at all still builds', async () => {
  const work = await workspace();
  await rm(join(work, 'content/blog'), { recursive: true });
  await build(work);
  assert.equal(h1Of(await read(work, 'index.html')), 'Latest 0 Posts');
});

test('production: titles, descriptions, and tags are escaped, and replacement tokens stay literal', async () => {
  const work = await workspace();
  const title = `<b>x</b> & "q" 'z' costs $& and $1 and $\``;
  const description = 'a "quoted" <i>note</i> & $& more';
  await writePost(work, 'tricky.md', title, '2020-01-01', { tags: ['C++ & Rust'], description });
  await build(work);

  const page = await read(work, 'blog/tricky/index.html');
  const escaped = '&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot; &#39;z&#39; costs $&amp; and $1 and $`';
  assert.equal(h1Of(page), escaped);
  assert.equal(titleOf(page), escaped);
  assert.doesNotMatch(page, /<b>x<\/b>/);
  const metaDescription = /<meta name="description" content="([^"]*)"/.exec(page)?.[1];
  assert.equal(unescapeXml(metaDescription), description, 'a description with quotes cannot break out of its attribute');
  assert.equal(await exists(work, 'tags/c-rust/index.html'), true);
  assert.match(page, /<a href="\/tags\/c-rust\/" class="post-tag">C\+\+ &amp; Rust<\/a>/);
  const archive = listed(await read(work, 'blog/index.html')).find(([href]) => href === '/blog/tricky/');
  assert.equal(archive[1], escaped);
  const entry = atomEntries(await read(work, 'feed/feed.xml')).find((candidate) => candidate.link === `${ORIGIN}/blog/tricky/`);
  assert.equal(entry.title, title, 'the feed carries the original text');
});

test('production: a Markdown body keeps characters that look like regular-expression replacements', async () => {
  const work = await workspace();
  await writePost(work, 'tokens.md', 'Tokens', '2020-02-02', {}, 'Price is $1.50, $& stays, and $$ too. Use `$1` and `$&` in code.\n\n```js\nconst a = "$&" + \'$1\' + `$\x60`;\n```');
  await build(work);
  const page = await read(work, 'blog/tokens/index.html');
  assert.match(page, /Price is \$1\.50, \$&amp; stays, and \$\$ too\./);
  assert.match(page, /<code>\$1<\/code> and <code>\$&amp;<\/code> in code\./);
  assert.match(page, /<span class="token string">"\$&amp;"<\/span>/, 'highlighting keeps $& literal');
});

for (const [name, setup, pattern] of [
  ['front matter without a date', (work) => writeFile(join(work, 'content/blog/nodate.md'), '---\ntitle: No date\n---\nbody\n'), /Invalid front matter in content\/blog\/nodate\.md/],
  ['a non-boolean draft flag', (work) => writePost(work, 'baddraft.md', 'Bad', '2020-01-01', { draft: '"yes"' }), /Invalid front matter in content\/blog\/baddraft\.md/],
  ['two files that publish one URL', async (work) => { await mkdir(join(work, 'content/blog/dup')); await writePost(work, 'dup.md', 'A', '2020-01-01'); await writePost(work, 'dup/dup.md', 'B', '2020-01-02'); }, /both publish \/blog\/dup\//],
  ['tags that collide on one URL', async (work) => { await writePost(work, 'a.md', 'A', '2020-01-01', { tags: ['Foo'] }); await writePost(work, 'b.md', 'B', '2020-01-02', { tags: ['foo'] }); }, /would both publish \/tags\/foo\//],
  ['a tag with no letters or digits', (work) => writePost(work, 'sym.md', 'S', '2020-01-01', { tags: ['***'] }), /has no letters or digits/],
  ['nesting deeper than one folder', async (work) => { await mkdir(join(work, 'content/blog/a/b'), { recursive: true }); await writePost(work, 'a/b/c.md', 'C', '2020-01-01'); }, /only content\/blog\/name\.md/],
  ['a link to a file that does not exist', (work) => writePost(work, 'broken.md', 'Broken', '2020-01-01', {}, 'See [it](nowhere.md).'), /does not point at a published page/],
  ['a link to a draft', (work) => writePost(work, 'linker.md', 'Linker', '2020-01-01', {}, 'See [draft](fifthpost.md).'), /does not point at a published page/],
  ['an image that does not exist', (work) => writePost(work, 'noimg.md', 'No image', '2020-01-01', {}, '![x](./missing.png)'), /image "\.\/missing\.png" does not exist/],
  ['a Markdown link that leaves the content folder', (work) => writePost(work, 'escape.md', 'Escape', '2020-01-01', {}, '[x](../../package.json.md)'), /points outside content\//],
]) {
  test(`production: ${name} fails the build with a message naming the cause`, async () => {
    const work = await workspace();
    await setup(work);
    assert.match(await failingBuild(work), pattern);
  });
}

test('production: a missing site URL fails the build instead of writing relative feed URLs', async () => {
  const work = await workspace();
  const message = await failingBuild(work, { BASCIK_SITE_URL: undefined });
  assert.match(message, /BASCIK_SITE_URL/);
});

test('production: fixing a failed build recovers without leftovers', async () => {
  const work = await workspace();
  await writeFile(join(work, 'content/blog/nodate.md'), '---\ntitle: No date\n---\nbody\n');
  await failingBuild(work);
  await rm(join(work, 'content/blog/nodate.md'));
  await build(work);
  assert.equal(await exists(work, 'blog/nodate/index.html'), false);
  assert.equal(await exists(work, 'blog/firstpost/index.html'), true);
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
  // The dev server binds before the first compile and answers early requests with a boot page. It
  // also runs the startup `post` script (the feed) after compiling, and a startup script failure is
  // fatal by design, so wait for the "Server running" line before any scenario edits content.
  await waitFor(async () => {
    handle.assertAlive();
    if (!handle.output().includes('Server running at')) return false;
    const response = await fetch(`${url}/blog/`);
    return response.ok && (await response.text()).includes('<h1 id="archive">');
  }, 'the dev server to finish booting', 60000);
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
    const titles = () => page.locator('main ol[reversed] li a').allInnerTexts();
    assert.equal((await titles()).length, 5, 'the dev server lists the draft too');
    assert.ok((await titles())[0].includes('Notes still being written (draft)'));

    // Add a post.
    await writePost(work, 'sixthpost.md', 'Sixth entry', '2024-05-05');
    await page.waitForFunction(() => document.body.innerText.includes('Sixth entry'), null, { timeout: 25000 });
    assert.equal((await fetch(`${url}/blog/sixthpost/`)).status, 200);

    // Edit a post.
    const source = await readFile(join(work, 'content/blog/sixthpost.md'), 'utf8');
    await writeFile(join(work, 'content/blog/sixthpost.md'), source.replace('Sixth entry', 'Sixth entry, revised'));
    await page.waitForFunction(() => document.body.innerText.includes('Sixth entry, revised'), null, { timeout: 25000 });

    // Remove a post.
    // (secondpost, because nothing links to it; removing a linked post is a build error by design.)
    await rm(join(work, 'content/blog/secondpost.md'));
    await page.waitForFunction(() => !document.body.innerText.includes('Why the second entry'), null, { timeout: 25000 });
    await waitFor(async () => (await fetch(`${url}/blog/secondpost/`)).status === 404, 'the removed route to return 404');

    // The draft flag takes effect in development without a restart.
    const draft = await readFile(join(work, 'content/blog/fifthpost.md'), 'utf8');
    await writeFile(join(work, 'content/blog/fifthpost.md'), draft.replace('draft: true', 'draft: false'));
    await page.waitForFunction(() => !document.body.innerText.includes('(draft)'), null, { timeout: 25000 });
    assert.deepEqual(errors, []);
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
    await writePost(work, 'recovered.md', 'Recovered entry', '2024-06-06');
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
    await cp(join(work, 'content/blog/fourthpost/lighthouse.png'), join(work, 'content/blog/withimage/pic.png'));
    await writePost(work, 'withimage/withimage.md', 'With image', '2024-07-07', {}, '<img src="./pic.png" alt="a picture of a lighthouse at dusk">');
    await waitFor(async () => (await fetch(`${url}/blog/withimage/`)).status === 200, 'the new post page');
    const page = await (await fetch(`${url}/blog/withimage/`)).text();
    const src = /<img[^>]*\ssrc="([^"]+)"/.exec(page)?.[1];
    assert.equal(src, '/blog/withimage/pic.png');
    await waitFor(async () => (await fetch(`${url}${src}`)).headers.get('content-type')?.startsWith('image/'), 'the image to be served');
  } finally {
    await handle.stop();
  }
});
