// Builds the repo-root examples with the real compiler and runs the agent skill scripts against the output:
//  - the starter site, at the root and under a base path
//  - a fresh project that copies every example with add-example.mjs, the way an assistant would
// The browser half is e2e/examples.spec.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SITE_URL,
  buildStarterSite,
  copyExamples,
  createWorkspace,
  examplesDir,
  output,
  skillsDir,
  writeExamplesBundle,
  type Workspace,
} from './example-fixtures.ts';

const script = (path: string) => join(skillsDir, path);
const canonicalOf = (html: string) => /<link rel="?canonical"? href="?([^"\s>]+)/.exec(html)?.[1];
const componentNames = readdirSync(join(examplesDir, 'components')).sort();

describe('starter site at the site root', () => {
  let ws: Workspace;
  const read = (path: string) => readFileSync(join(ws.dir, 'starter-site/dist', path), 'utf8');

  beforeAll(() => {
    ws = copyExamples();
    // A post written with the skill's script, and a draft that must never reach the build.
    const created = ws.node('starter-site', [script('bascik-scripts/scripts/new-post.mjs'), 'Shipping the redesign', '--tags', 'news,design', '--date', '2026-04-01', '--description', 'What changed in the redesign and why we made each change.']);
    if (created.status !== 0) throw new Error(output(created));
    ws.write('starter-site/content/posts/secret-plans.md', '---\ntitle: Secret plans\ndescription: Not ready yet.\ndate: 2026-05-01\ndraft: true\n---\nHidden.\n');
    buildStarterSite(ws);
  }, 180_000);

  afterAll(() => ws?.remove());

  it('passes bascik --check and the linter, including the shared ../components folder', () => {
    const verified = ws.node('starter-site', [script('bascik/scripts/verify.mjs')], { BASCIK_SITE_URL: SITE_URL });
    expect(verified.status, output(verified)).toBe(0);
    expect(verified.stdout).toContain('== PASS  bascik-language-server --check ../components');
  }, 120_000);

  it('passes the SEO audit with warnings treated as failures', () => {
    const audited = ws.node('starter-site', [script('bascik-seo/scripts/audit-seo.mjs'), '--strict', '--json'], { BASCIK_SITE_URL: SITE_URL });
    expect(audited.status, output(audited)).toBe(0);
    expect(JSON.parse(audited.stdout).findings.filter((f: { level: string }) => f.level !== 'info')).toEqual([]);
  });

  it('has no broken internal links and uses only declared tokens', () => {
    const links = ws.node('starter-site', [script('bascik/scripts/check-links.mjs'), '--json'], { BASCIK_SITE_URL: SITE_URL });
    expect(links.status, output(links)).toBe(0);
    expect(JSON.parse(links.stdout).checked).toBeGreaterThan(50);
    const tokens = ws.node('starter-site', [script('bascik-components/scripts/check-tokens.mjs')]);
    expect(tokens.status, output(tokens)).toBe(0);
  });

  it('gives every sitemap URL a page whose canonical is that URL', () => {
    const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toContain(`${SITE_URL}/blog/shipping-the-redesign/`);
    expect(locs).toContain(`${SITE_URL}/contact`);
    for (const loc of locs) {
      const path = loc.slice(SITE_URL.length);
      const file = path === '/' ? 'index.html' : path.endsWith('/') ? `${path.slice(1)}index.html` : `${path.slice(1)}.html`;
      expect(canonicalOf(read(file)), file).toBe(loc);
    }
  });

  it('marks the current page in the shared header on every page', () => {
    expect(read('about.html')).toMatch(/href="?\/about"? aria-current="?page"?/);
    expect(read('blog/hello-world/index.html')).toMatch(/href="?\/blog\/"? aria-current="?true"?/);
    expect(read('index.html')).not.toMatch(/href="?\/about"? aria-current/);
  });

  it('leaves drafts out of pages, the feed, llms.txt, and the sitemap', () => {
    expect(existsSync(join(ws.dir, 'starter-site/dist/blog/secret-plans/index.html'))).toBe(false);
    for (const file of ['blog/index.html', 'feed.xml', 'llms.txt', 'sitemap.xml']) expect(read(file), file).not.toContain('secret-plans');
  });

  it('writes an Atom feed and llms.txt with absolute URLs', () => {
    const feed = read('feed.xml');
    expect(feed.match(/<entry>/g)).toHaveLength(3);
    expect(feed).toContain(`<link href="${SITE_URL}/blog/shipping-the-redesign/" />`);
    const llms = read('llms.txt');
    expect(llms).toMatch(/^# Example Site/);
    expect(llms).toContain(`(${SITE_URL}/about)`);
    expect(llms).not.toContain('Page not found');
  });

  it('keeps the theme script in <head> and the contact form field names literal', () => {
    const home = read('index.html');
    const themeScript = home.indexOf("localStorage.getItem('theme')");
    expect(themeScript).toBeGreaterThan(0);
    expect(themeScript).toBeLessThan(home.indexOf('</head>'));
    expect(read('contact.html')).toMatch(/name="?email"?[\s>]/);
  });
});

describe('starter site under a base path', () => {
  let ws: Workspace;
  const read = (path: string) => readFileSync(join(ws.dir, 'starter-site/dist', path), 'utf8');

  beforeAll(() => {
    ws = copyExamples();
    const config = join(ws.dir, 'starter-site/bascik.config.ts');
    writeFileSync(config, readFileSync(config, 'utf8').replace('export default defineConfig({', "export default defineConfig({\n  base: '/sub/',"));
    buildStarterSite(ws);
  }, 180_000);

  afterAll(() => ws?.remove());

  it('has no broken links and passes the SEO audit with base-aware canonical URLs', () => {
    const links = ws.node('starter-site', [script('bascik/scripts/check-links.mjs')], { BASCIK_SITE_URL: SITE_URL });
    expect(links.status, output(links)).toBe(0);
    const audited = ws.node('starter-site', [script('bascik-seo/scripts/audit-seo.mjs'), '--strict'], { BASCIK_SITE_URL: SITE_URL });
    expect(audited.status, output(audited)).toBe(0);
    expect(canonicalOf(read('about.html'))).toBe(`${SITE_URL}/sub/about`);
    expect(read('feed.xml')).toContain(`${SITE_URL}/sub/blog/hello-world/`);
  });
});

describe('add-example.mjs into a fresh project', () => {
  let ws: Workspace;
  let bundle: string;
  const addExample = (args: string[]) => ws.node('site', [script('bascik/scripts/add-example.mjs'), '--source', bundle, ...args]);

  beforeAll(async () => {
    ws = createWorkspace();
    bundle = await writeExamplesBundle(ws.dir);
    ws.write('site/package.json', JSON.stringify({ type: 'module', dependencies: { '@bascik/bascik': '*' } }));
    ws.write('site/.env', `BASCIK_SITE_URL=${SITE_URL}\n`);
  }, 60_000);

  afterAll(() => ws?.remove());

  it('lists every example', () => {
    const listed = addExample(['--list']);
    expect(listed.status, output(listed)).toBe(0);
    for (const name of [...componentNames, 'starter-site']) expect(listed.stdout).toContain(name);
  });

  it('copies the whole starter site and every component it uses, then builds and verifies', () => {
    const copied = addExample(['starter-site']);
    expect(copied.status, output(copied)).toBe(0);
    for (const used of ['site-header', 'site-footer', 'theme-init', 'theme-toggle', 'contact-form']) {
      expect(readFileSync(join(ws.dir, 'site/src/components', used, `${used}.html`), 'utf8')).toBe(
        readFileSync(join(examplesDir, 'components', used, `${used}.html`), 'utf8'),
      );
    }
    expect(existsSync(join(ws.dir, 'site/bascik.config.ts'))).toBe(false);
    expect(copied.stdout).toContain('--- starter-site/bascik.config.ts (not copied');
    expect(copied.stdout).toContain('npm install');

    // The merge an assistant does by hand: the starter's settings without the repository-only ../components root.
    const starterConfig = readFileSync(join(examplesDir, 'starter-site/bascik.config.ts'), 'utf8');
    ws.write('site/bascik.config.ts', starterConfig.replace(/  directory: \{[\s\S]*?\n  \},\n/, ''));
    const built = ws.bascik('site', ['--build']);
    expect(built.status, output(built)).toBe(0);
    const verified = ws.node('site', [script('bascik/scripts/verify.mjs')]);
    expect(verified.status, output(verified)).toBe(0);
  }, 180_000);

  it('copies every component, and two instances of each pass the checks', () => {
    const copied = addExample(componentNames);
    expect(copied.status, output(copied)).toBe(0);
    const usage = [
      '<tab-group data-bascik-prop-label="A"><section data-tab="One"><p>1</p></section><section data-tab="Two"><p>2</p></section></tab-group>',
      '<modal-dialog data-bascik-prop-trigger="Open" data-bascik-prop-title="Title"><p>Body</p></modal-dialog>',
      '<popover-menu data-bascik-prop-label="Menu"><a href="/">Home</a></popover-menu>',
      '<copy-button data-bascik-prop-text="copied text" />',
      '<filter-list data-bascik-prop-label="Filter"><li>One</li><li>Two</li></filter-list>',
      '<contact-form />',
      '<theme-toggle />',
      '<site-header><theme-toggle /></site-header>',
      '<site-footer />',
    ].join('\n');
    ws.write(
      'site/src/pages/widgets.html',
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <site-head />\n  <title>Every example widget, twice</title>\n  <meta name="description" content="Two instances of every Bascik example component on one page, used to check that each copy is independent." />\n</head>\n<body>\n  <main id="main">\n    <h1>Widgets</h1>\n${usage}\n${usage}\n  </main>\n</body>\n</html>\n`,
    );
    const built = ws.bascik('site', ['--build']);
    expect(built.status, output(built)).toBe(0);
    const verified = ws.node('site', [script('bascik/scripts/verify.mjs')]);
    expect(verified.status, output(verified)).toBe(0);
    const html = readFileSync(join(ws.dir, 'site/dist/widgets.html'), 'utf8');
    const ids = [...html.matchAll(/\sid="?([^"\s>]+)/g)].map((m) => m[1]);
    expect(new Set(ids).size, 'every id on the page is unique').toBe(ids.length);
  }, 180_000);

  it('refuses to overwrite an edited file and writes nothing', () => {
    const navFile = join(ws.dir, 'site/src/components/site-header/links.ts');
    writeFileSync(navFile, '// edited by the user\n');
    const again = addExample(['site-header']);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('src/components/site-header/links.ts');
    expect(again.stderr).toContain('nothing was written');
    expect(readFileSync(navFile, 'utf8')).toBe('// edited by the user\n');
  });

  it('rejects unknown examples and paths', () => {
    expect(output(addExample(['no-such-example']))).toContain('no example named "no-such-example"');
    expect(output(addExample(['starter-site/src/nope']))).toContain('has no file or folder "src/nope"');
  });
});
