import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOutsideRepository, launch, unusedPort } from './runner.mjs';
import { SHELL, startWordPress, wpRequest } from './wordpress-upstream.mjs';
import { POSTS, bySlug } from './wordpress-blog-expected.mjs';
import * as checks from './wordpress-blog-checks.mjs';

// Task 09: the official WordPress release (SRC-WP-CORE, 7.1.2 with Twenty Twenty-Five) and its
// Bascik port. One seeded WordPress runs per test under WordPress Playground. Lanes:
//   rest-production  port reads the REST API, `bascik --build` + `bascik --server`, minified
//   rest-dev         port reads the REST API under `bascik` (dev server)
//   wxr-production   WordPress's own WXR export, converted to Markdown by the community tool,
//                    then built with no WordPress running
//   rebuild          an edit made in WordPress reaches the port after a rebuild
//   control          the shared checks reject a site that is not this blog
// The upstream site is checked with the same `checkSite` assertions as the port.

const require = createRequire(new URL('../../pkg/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const portSource = fileURLToPath(new URL('../ports/wordpress-blog/', import.meta.url));
const tarball = process.env.BASCIK_TARBALL ? resolve(process.env.BASCIK_TARBALL) : null;
const only = process.env.WORDPRESS_LANE;
const BASCIK_BIN = 'node_modules/@bascik/bascik/bin/bascik.js';
const ORIGIN = 'https://journal.example';
const CONVERTER = join(SHELL, 'node_modules/wordpress-export-to-markdown/app.js');

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function run(command, cwd, env, timeoutMs = 600000) {
  const handle = launch(command, cwd, env);
  try { await handle.wait(timeoutMs); } finally { await handle.stop(); }
  return handle.output();
}

/** An isolated copy of the port outside the repository, with Bascik resolved inside it. */
async function preparePort(notes) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bascik-wordpress-port-')));
  assertOutsideRepository(directory, repository);
  const cwd = join(directory, 'port');
  await cp(portSource, cwd, { recursive: true, filter: (path) => !/\/(node_modules|dist)(\/|$)/.test(path.slice(portSource.length - 1)) });
  const env = { ...process.env, BASCIK_SITE_URL: ORIGIN };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  delete env.WORDPRESS_URL;
  await run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd, env);
  if (tarball) {
    await access(tarball);
    await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], cwd, env);
  }
  const packageDirectory = await realpath(join(cwd, 'node_modules/@bascik/bascik'));
  assert.ok(packageDirectory.startsWith(cwd + '/'), 'Bascik must resolve inside the isolated copy');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  notes.push(`${tarball ? `local tarball ${tarball}` : 'registry release'}; @bascik/bascik ${manifest.version}`);
  return { directory, cwd, env, stop: () => rm(directory, { recursive: true, force: true }) };
}

async function serve(port, command) {
  const portNumber = await unusedPort();
  const handle = launch([...command, '--port', String(portNumber), '--host', '127.0.0.1'], port.cwd, port.env);
  const url = `http://127.0.0.1:${portNumber}`;
  // The dev server answers 200 "Building site..." for every page until its first build ends, so
  // readiness is a real 404 for a path that cannot exist.
  const deadline = Date.now() + 600000;
  for (; ;) {
    handle.assertAlive();
    try {
      const response = await fetch(`${url}/__bascik_ready_probe__/`);
      await response.arrayBuffer();
      if (response.status === 404) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`Bascik did not start:\n${handle.output()}`);
    await new Promise((accept) => setTimeout(accept, 100));
  }
  return { url, cwd: port.cwd, handle };
}

function lane(name, body) {
  test(`wordpress blog: ${name}`, { skip: only && only !== name ? `WORDPRESS_LANE=${only}` : false, timeout: 1800000 }, async () => {
    const notes = [];
    const cleanups = [];
    try {
      await body({ notes, cleanups });
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
    console.log(`wordpress blog ${name}: ${notes.join('; ')}`);
  });
}

lane('rest-production', async ({ notes, cleanups }) => {
  const wordpress = await startWordPress();
  cleanups.push(wordpress.stop);
  // Upstream baseline, with the same assertions. WordPress curls quotes in titles.
  await checks.checkSite(browser, { url: wordpress.url }, 'upstream');

  const port = await preparePort(notes);
  cleanups.push(port.stop);
  port.env.WORDPRESS_URL = wordpress.url;
  await run([process.execPath, BASCIK_BIN, '--build'], port.cwd, port.env);
  // Nothing at runtime depends on WordPress: stop it before serving the port.
  await wordpress.stop();
  const server = await serve(port, [process.execPath, BASCIK_BIN, '--server']);
  cleanups.push(() => server.handle.stop());
  const site = { url: server.url, cwd: port.cwd };
  await checks.checkSite(browser, site, 'port/rest-production');
  await checks.checkSanitized(browser, site, 'port/rest-production');
  await checks.checkBuildOutput(site, 'port/rest-production');
  await checks.checkFeed(site, 'port/rest-production', ORIGIN);
  await checks.checkSitemap(site, 'port/rest-production', ORIGIN);
  await checks.checkInteraction(browser, site, 'port/rest-production');
  await checks.checkMinified(site, 'port/rest-production');
  // Media came from WordPress's uploads folder and kept its path, including resized copies.
  const uploads = await readdir(join(port.cwd, 'dist/wp-content/uploads'), { recursive: true });
  assert.ok(uploads.some((file) => file.endsWith('raised-beds-300x188.png')), 'resized featured image copy downloaded');
  assert.ok(uploads.some((file) => file.endsWith('seed-trays.png')), 'inline image downloaded');
});

lane('rest-dev', async ({ notes, cleanups }) => {
  const wordpress = await startWordPress();
  cleanups.push(wordpress.stop);
  const port = await preparePort(notes);
  cleanups.push(port.stop);
  port.env.WORDPRESS_URL = wordpress.url;
  const server = await serve(port, [process.execPath, BASCIK_BIN]);
  cleanups.push(() => server.handle.stop());
  const site = { url: server.url, cwd: port.cwd };
  await checks.checkSite(browser, site, 'port/rest-dev', { dev: true });
  await checks.checkSanitized(browser, site, 'port/rest-dev');
  await assert.rejects(stat(join(port.cwd, 'BASCIK_CANARY')), { code: 'ENOENT' }, 'dev ran no code from content');
});

lane('wxr-production', async ({ notes, cleanups }) => {
  // WordPress produces the export with its own exporter (Tools > Export), then is stopped.
  const wordpress = await startWordPress();
  cleanups.push(wordpress.stop);
  const work = await realpath(await mkdtemp(join(tmpdir(), 'bascik-wordpress-wxr-')));
  cleanups.push(() => rm(work, { recursive: true, force: true }));
  await writeFile(join(work, 'export.xml'), wordpress.exportXml);
  // The converter downloads images from the live site, so it runs while WordPress is up.
  await run([process.execPath, CONVERTER, '--wizard=false', '--input=export.xml', '--output=out',
    '--post-folders=true', '--date-folders=none', '--save-images=all', '--include-time=true',
    '--frontmatter-fields=title,date,categories,tags,coverImage,draft', '--request-delay=0', '--write-delay=0'], work, process.env);
  await wordpress.stop();

  const port = await preparePort(notes);
  cleanups.push(port.stop);
  // Replace the committed sample content with this fresh conversion.
  await rm(join(port.cwd, 'content/posts'), { recursive: true, force: true });
  await rm(join(port.cwd, 'content/pages'), { recursive: true, force: true });
  await cp(join(work, 'out/posts'), join(port.cwd, 'content/posts'), { recursive: true });
  await cp(join(work, 'out/pages'), join(port.cwd, 'content/pages'), { recursive: true });
  // What the converter drops, restored by hand as the README explains.
  const edit = async (file, from, to) => {
    const path = join(port.cwd, 'content', file);
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes(from), `converter output ${file} contains ${from}`);
    await writeFile(path, text.replace(from, to));
  };
  await edit('pages/colophon/index.md', 'title: "Colophon"\n', 'title: "Colophon"\nparent: "about"\n');
  await edit('pages/about/index.md', 'title: "About"\n', 'title: "About"\norder: 1\n');
  await edit('posts/raised-beds/index.md', 'coverImage: "raised-beds.png"\n', 'coverImage: "raised-beds.png"\ncoverImageAlt: "Rows of raised beds drawn as green and white stripes"\n');
  // The converter keeps a link to an image it failed to download (here a deliberately broken one).
  await edit('posts/pasted-embed/index.md', '![broken](images/missing.png)', '');
  const converted = await readFile(join(port.cwd, 'content/posts/pasted-embed/index.md'), 'utf8');
  assert.match(converted, /<script data-bascik-build/, 'the converter keeps raw directive markup, so the build must neutralize it');

  await run([process.execPath, BASCIK_BIN, '--build'], port.cwd, port.env);
  const server = await serve(port, [process.execPath, BASCIK_BIN, '--server']);
  cleanups.push(() => server.handle.stop());
  const site = { url: server.url, cwd: port.cwd };
  await checks.checkSite(browser, site, 'port/wxr-production', { titleOf: (post) => post.wxrTitle ?? post.title, resizedImages: false });
  await checks.checkSanitized(browser, site, 'port/wxr-production');
  await checks.checkBuildOutput(site, 'port/wxr-production');
  await checks.checkFeed(site, 'port/wxr-production', ORIGIN);
  await checks.checkSitemap(site, 'port/wxr-production', ORIGIN);
});

lane('rebuild', async ({ notes, cleanups }) => {
  const wordpress = await startWordPress();
  cleanups.push(wordpress.stop);
  const port = await preparePort(notes);
  cleanups.push(port.stop);
  port.env.WORDPRESS_URL = wordpress.url;
  await run([process.execPath, BASCIK_BIN, '--build'], port.cwd, port.env);
  const before = await readFile(join(port.cwd, 'dist/index.html'), 'utf8');
  assert.match(before, /Harvest log, July/);

  // An editor retitles a post, publishes the draft, and trashes another post.
  const harvest = wordpress.seed.posts['harvest-log'];
  await wpRequest(wordpress, `/wp/v2/posts/${harvest}`, { method: 'POST', body: { title: 'Harvest log, July & August' } });
  await wpRequest(wordpress, `/wp/v2/posts/${wordpress.seed.posts.unfinished}`, { method: 'POST', body: { status: 'publish', date: '2026-08-01T08:00:00' } });
  await wpRequest(wordpress, `/wp/v2/posts/${wordpress.seed.posts['first-frost']}`, { method: 'DELETE' });

  // Same project, same cache: the rebuild must not reuse output from before the edit.
  await run([process.execPath, BASCIK_BIN, '--build'], port.cwd, port.env);
  const home = await readFile(join(port.cwd, 'dist/index.html'), 'utf8');
  assert.match(home, /Harvest log, July &amp; August/, 'retitled post on the home page');
  assert.match(home, /An unfinished draft/, 'newly published post on the home page');
  const post = await readFile(join(port.cwd, 'dist/2026/07/30/harvest-log/index.html'), 'utf8');
  assert.match(post, /<title>Harvest log, July &amp; August – Fieldwork Journal<\/title>/, 'retitled post page');
  const published = await wpRequest(wordpress, `/wp/v2/posts/${wordpress.seed.posts.unfinished}?_fields=slug,date,link`);
  await stat(join(port.cwd, 'dist', new URL(published.link).pathname, 'index.html')).catch((error) => {
    throw new Error(`published draft ${JSON.stringify(published)} missing: ${error.message}`);
  });
  await assert.rejects(stat(join(port.cwd, 'dist', bySlug('first-frost').path, 'index.html')), { code: 'ENOENT' }, 'trashed post page removed');
  const sitemap = await readFile(join(port.cwd, 'dist/sitemap.xml'), 'utf8');
  assert.doesNotMatch(sitemap, /first-frost/, 'trashed post left the sitemap');
  const feed = await readFile(join(port.cwd, 'dist/feed.xml'), 'utf8');
  assert.match(feed, /Harvest log, July &amp; August/, 'feed updated');
  assert.equal(POSTS.length, 7, 'fixture sanity');
});

// Control: the shared checks must reject a site that is not this blog, and the sanitizing check
// must reject a page that runs pasted script.
lane('control', async ({ cleanups }) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bascik-wordpress-control-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const page = (body) => `<!doctype html><html lang="en"><head><title>x</title></head><body><main>${body}</main></body></html>`;
  await writeFile(join(directory, 'index.html'), page('<h1>Blog</h1>'));
  const slug = bySlug('pasted-embed').path;
  await cp(fileURLToPath(new URL('./static-site-server.mjs', import.meta.url)), join(directory, 'server.mjs'));
  await mkdir(join(directory, slug), { recursive: true });
  await writeFile(join(directory, slug, 'index.html'), page('<p>Below is markup pasted from a third-party widget.</p><p>a javascript link</p><script>window.__pastedEmbed = true</script>'));
  await writeFile(join(directory, '404.html'), page('<h1>Not found</h1>'));
  const portNumber = await unusedPort();
  const server = launch([process.execPath, 'server.mjs', '.'], directory, { ...process.env, PORT: String(portNumber), HOST: '127.0.0.1' });
  cleanups.push(() => server.stop());
  const url = `http://127.0.0.1:${portNumber}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(url + '/'); break; } catch { await new Promise((accept) => setTimeout(accept, 50)); }
  }
  await assert.rejects(checks.checkSite(browser, { url }, 'control'), /control: \/page\/2\/ status/);
  await assert.rejects(checks.checkSanitized(browser, { url }, 'control'), /control: pasted markup is inert/);
});
