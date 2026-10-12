import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addGitLastmod,
  extractMarkdownRefs,
  formatLastmod,
  injectLastmod,
  isShallowRepository,
  lastmodFor,
  parseGitLog,
  routeOf,
  sitemapLocs,
  sourceFilesForRoute,
  unshallow,
} from './sitemap-lastmod.js';
import config, { build } from '../../bascik.config.ts';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

describe('parseGitLog', () => {
  it('keeps the newest commit time per path', () => {
    const log = [`commit ${HASH_A} 2000`, 'docs/a.md', 'docs/b.md', '', `commit ${HASH_B} 1000`, 'docs/a.md', ''].join('\n');
    expect(parseGitLog(log)).toEqual(new Map([['docs/a.md', 2000], ['docs/b.md', 2000]]));
  });

  it('is order independent', () => {
    const log = [`commit ${HASH_B} 1000`, 'x.md', '', `commit ${HASH_A} 2000`, 'x.md'].join('\n');
    expect(parseGitLog(log).get('x.md')).toBe(2000);
  });

  it('ignores shallow boundary commits, so their dates are never reported', () => {
    const log = [`commit ${HASH_A} 3000`, 'new.md', '', `commit ${HASH_C} 9999`, 'new.md', 'old.md'].join('\n');
    const latest = parseGitLog(log, new Set([HASH_C]));
    expect(latest.get('new.md')).toBe(3000);
    expect(latest.has('old.md')).toBe(false);
  });
});

describe('routeOf', () => {
  it.each([
    ['https://bascik.dev/', ''],
    ['https://bascik.dev/components', 'components'],
    ['https://bascik.dev/how-to/markdown', 'how-to/markdown'],
    ['https://bascik.dev/deployment/', 'deployment'],
    ['https://bascik.dev/a%20b', 'a b'],
    ['https://bascik.dev/q?x=1&amp;y=2', 'q'],
    ['not a url', ''],
  ])('%s -> %j', (loc, route) => {
    expect(routeOf(loc)).toBe(route);
  });
});

describe('extractMarkdownRefs', () => {
  it('finds each rendered Markdown file once, in any quote style', () => {
    const html = `renderMd('./content/a.md'); renderMd("./content/b.md"); x(\`../CHANGELOG.md\`); renderMd('./content/a.md');`;
    expect(extractMarkdownRefs(html)).toEqual(['./content/a.md', './content/b.md', '../CHANGELOG.md']);
  });

  it('ignores prose that merely mentions a Markdown path or an absolute URL', () => {
    expect(extractMarkdownRefs('see https://x.dev/guide.md and content/a.md')).toEqual([]);
  });
});

describe('lastmod formatting and selection', () => {
  it('formats unix seconds as a UTC date', () => {
    expect(formatLastmod(Date.UTC(2026, 9, 9, 23, 59) / 1000)).toBe('2026-10-09');
  });

  it('uses the newest date across a page shell and its Markdown', () => {
    const latest = new Map([['p.html', 1_000_000], ['p.md', 2_000_000_000]]);
    expect(lastmodFor(['p.html', 'p.md'], latest)).toBe(formatLastmod(2_000_000_000));
  });

  it('returns undefined when no source has a trustworthy date', () => {
    expect(lastmodFor(['p.html'], new Map())).toBeUndefined();
    expect(lastmodFor([], new Map([['p.html', 1]]))).toBeUndefined();
  });
});

describe('injectLastmod', () => {
  const xml = [
    '<urlset>',
    '  <url>\n    <loc>https://bascik.dev/a</loc>\n  </url>',
    '  <url>\n    <loc>https://bascik.dev/b</loc>\n  </url>',
    '  <url>\n    <loc>https://bascik.dev/c</loc>\n    <lastmod>2020-01-01</lastmod>\n  </url>',
    '</urlset>',
  ].join('\n');
  const dates = new Map([['https://bascik.dev/a', '2026-01-02'], ['https://bascik.dev/c', '2026-09-09']]);

  it('adds a date only to entries that have one and lack one already', () => {
    const out = injectLastmod(xml, dates);
    expect(out).toContain('<loc>https://bascik.dev/a</loc>\n    <lastmod>2026-01-02</lastmod>');
    expect(out).not.toMatch(/\/b<\/loc>\s*<lastmod>/);
    expect(out).toContain('<lastmod>2020-01-01</lastmod>');
    expect(out).not.toContain('2026-09-09');
  });

  it('is idempotent', () => {
    const once = injectLastmod(xml, dates);
    expect(injectLastmod(once, dates)).toBe(once);
  });

  it('treats a date containing replacement tokens as plain text', () => {
    const out = injectLastmod(xml, new Map([['https://bascik.dev/a', '$&$1']]));
    expect(out).toContain('<lastmod>$&$1</lastmod>');
  });

  it('lists every loc', () => {
    expect(sitemapLocs(xml)).toEqual(['https://bascik.dev/a', 'https://bascik.dev/b', 'https://bascik.dev/c']);
  });
});

describe('against a real git repository', () => {
  let repo: string;
  let docsDir: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
  const commit = (message: string, isoDate: string) => {
    git('add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-m', message], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
    });
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'sitemap-lastmod-'));
    docsDir = join(repo, 'docs');
    await mkdir(join(docsDir, 'src', 'pages', 'guide'), { recursive: true });
    await mkdir(join(docsDir, 'content'), { recursive: true });
    git('init', '-q');
    await writeFile(join(docsDir, 'src/pages/index.html'), '<html></html>');
    await writeFile(join(docsDir, 'src/pages/guide.html'), `renderMd('./content/guide.md')`);
    await writeFile(join(docsDir, 'content/guide.md'), '# Guide');
    await writeFile(join(docsDir, 'src/pages/guide/index.html'), '<html></html>');
    commit('first', '2026-01-10T12:00:00Z');
    await writeFile(join(docsDir, 'content/guide.md'), '# Guide\n\nUpdated.');
    commit('update content', '2026-03-20T12:00:00Z');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const sitemap = (...paths: string[]) =>
    `<urlset>${paths.map((p) => `\n  <url>\n    <loc>https://bascik.dev/${p}</loc>\n  </url>`).join('')}\n</urlset>`;

  it('resolves a route to its shell and rendered Markdown', async () => {
    expect(await sourceFilesForRoute('guide', docsDir, repo)).toEqual(['docs/src/pages/guide.html', 'docs/content/guide.md']);
    expect(await sourceFilesForRoute('', docsDir, repo)).toEqual(['docs/src/pages/index.html']);
    expect(await sourceFilesForRoute('missing', docsDir, repo)).toEqual([]);
  });

  it('dates a page from its newest source commit, and pages without a shell are left undated', async () => {
    const summary = await addGitLastmod(sitemap('', 'guide', 'missing'), docsDir, repo);
    expect(summary).not.toBeNull();
    expect(summary!.shallow).toBe(false);
    expect(summary!.dated).toBe(2);
    expect(summary!.xml).toContain('<loc>https://bascik.dev/</loc>\n    <lastmod>2026-01-10</lastmod>');
    expect(summary!.xml).toContain('<loc>https://bascik.dev/guide</loc>\n    <lastmod>2026-03-20</lastmod>');
    expect(summary!.xml).not.toMatch(/missing<\/loc>\s*<lastmod>/);
  });

  it('does not date uncommitted new files', async () => {
    await writeFile(join(docsDir, 'src/pages/fresh.html'), '<html></html>');
    const summary = await addGitLastmod(sitemap('fresh'), docsDir, repo);
    expect(summary!.dated).toBe(0);
    expect(summary!.xml).not.toContain('<lastmod>');
  });

  it('in a shallow clone, refuses dates it cannot prove', async () => {
    const clone = await mkdtemp(join(tmpdir(), 'sitemap-lastmod-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth=1', `file://${repo}`, clone]);
      const cloneDocs = join(clone, 'docs');
      const summary = await addGitLastmod(sitemap('', 'guide'), cloneDocs, clone);
      expect(summary).not.toBeNull();
      expect(summary!.shallow).toBe(true);
      expect(summary!.dated).toBe(0);
      expect(summary!.xml).not.toContain('<lastmod>');
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  it('in a clone with enough history, dates pages after the boundary and omits the rest', async () => {
    await writeFile(join(docsDir, 'content/guide.md'), '# Guide\n\nUpdated again.');
    commit('third', '2026-05-01T12:00:00Z');
    const clone = await mkdtemp(join(tmpdir(), 'sitemap-lastmod-depth2-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth=2', `file://${repo}`, clone]);
      const summary = await addGitLastmod(sitemap('', 'guide'), join(clone, 'docs'), clone);
      expect(summary!.shallow).toBe(true);
      // guide.md changed in the newest commit, so it is dated exactly. index.html did not, so it is unknown.
      expect(summary!.xml).toContain('<loc>https://bascik.dev/guide</loc>\n    <lastmod>2026-05-01</lastmod>');
      expect(summary!.xml).not.toMatch(/bascik\.dev\/<\/loc>\s*<lastmod>/);
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  it('unshallow completes a shallow clone so every page gets a date', async () => {
    const clone = await mkdtemp(join(tmpdir(), 'sitemap-lastmod-unshallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth=1', `file://${repo}`, clone]);
      expect(await isShallowRepository(clone)).toBe(true);

      expect(await unshallow(clone)).toBe(true);
      expect(await isShallowRepository(clone)).toBe(false);

      const summary = await addGitLastmod(sitemap('', 'guide'), join(clone, 'docs'), clone);
      expect(summary!.shallow).toBe(false);
      expect(summary!.dated).toBe(2);
      expect(summary!.xml).toContain('<loc>https://bascik.dev/</loc>\n    <lastmod>2026-01-10</lastmod>');
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  it('unshallow leaves a clone with no reachable remote shallow instead of throwing', async () => {
    const clone = await mkdtemp(join(tmpdir(), 'sitemap-lastmod-offline-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth=1', `file://${repo}`, clone]);
      execFileSync('git', ['remote', 'set-url', 'origin', join(clone, 'does-not-exist')], { cwd: clone });
      expect(await unshallow(clone, 10_000)).toBe(false);
      expect(await isShallowRepository(clone)).toBe(true);
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  it('reports a non-repository as not shallow', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'sitemap-lastmod-plain-'));
    try {
      expect(await isShallowRepository(plain)).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('returns null outside a git repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'sitemap-lastmod-nogit-'));
    try {
      expect(await addGitLastmod(sitemap('x'), plain, plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('docs build configuration', () => {
  const script = 'scripts/generate-sitemap-lastmod.ts';

  it('runs after the sitemap is written, in the build only', () => {
    expect(build.pipeline?.exec?.find((entry) => entry.script === script)?.phase).toBe('post');
    expect(config.pipeline?.exec?.some((entry) => entry.script === script)).toBe(false);
  });

  it('leaves Bascik mtime-based lastmod off', () => {
    expect(build.generate?.sitemapLastmod ?? config.generate?.sitemapLastmod ?? false).toBe(false);
  });
});
