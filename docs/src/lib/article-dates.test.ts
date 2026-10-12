import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtPageFor, formatDateTime, injectArticleDates } from './article-dates.ts';

/** JSON-LD as the docs schema helpers emit it, with `<` escaped. */
const ldScript = (data: object) =>
  `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/</g, '\\u003c')}\n</script>`;

const article = { '@context': 'https://schema.org', '@type': 'TechArticle', headline: 'Slots - Bascik Docs' };
const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] };

/** Every JSON-LD body in `html`, parsed. */
const jsonLd = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

const MODIFIED = Date.parse('2026-10-12T13:21:05Z') / 1000;
const PUBLISHED = Date.parse('2026-01-10T12:00:00Z') / 1000;

describe('formatDateTime', () => {
  it('formats unix seconds as an ISO 8601 UTC date-time without milliseconds', () => {
    expect(formatDateTime(MODIFIED)).toBe('2026-10-12T13:21:05Z');
  });
});

describe('injectArticleDates', () => {
  it('dates the TechArticle and leaves other JSON-LD untouched', () => {
    const breadcrumbScript = ldScript(breadcrumb);
    const html = `<head>${breadcrumbScript}${ldScript(article)}</head>`;
    const out = injectArticleDates(html, { modified: MODIFIED, published: PUBLISHED });

    expect(out).toContain(breadcrumbScript);
    const [, dated] = jsonLd(out);
    expect(dated).toEqual({
      ...article,
      datePublished: '2026-01-10T12:00:00Z',
      dateModified: '2026-10-12T13:21:05Z',
    });
  });

  it('omits datePublished when the first commit is unknown', () => {
    const [dated] = jsonLd(injectArticleDates(ldScript(article), { modified: MODIFIED }));
    expect(dated.dateModified).toBe('2026-10-12T13:21:05Z');
    expect(dated).not.toHaveProperty('datePublished');
  });

  it('is idempotent and replaces an older date on a rerun', () => {
    const once = injectArticleDates(ldScript(article), { modified: PUBLISHED });
    const twice = injectArticleDates(once, { modified: MODIFIED });
    expect(injectArticleDates(twice, { modified: MODIFIED })).toBe(twice);
    expect(jsonLd(twice)[0].dateModified).toBe('2026-10-12T13:21:05Z');
  });

  it('keeps `<` escaped so the JSON cannot close its script element', () => {
    const out = injectArticleDates(ldScript({ ...article, headline: '</script><b>' }), { modified: MODIFIED });
    expect(out).not.toContain('</script><b>');
    expect(jsonLd(out)[0].headline).toBe('</script><b>');
  });

  it('leaves pages without a TechArticle, or with unparsable JSON-LD, byte-identical', () => {
    const noArticle = `<head>${ldScript(breadcrumb)}</head>`;
    const broken = '<script type="application/ld+json">{ not json </script>';
    expect(injectArticleDates(noArticle, { modified: MODIFIED })).toBe(noArticle);
    expect(injectArticleDates(broken, { modified: MODIFIED })).toBe(broken);
  });
});

describe('builtPageFor', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'article-dates-'));
    await mkdir(join(outDir, 'how-to'), { recursive: true });
    await mkdir(join(outDir, 'guide'), { recursive: true });
    await writeFile(join(outDir, 'index.html'), '');
    await writeFile(join(outDir, 'how-to', 'markdown.html'), '');
    await writeFile(join(outDir, 'guide', 'index.html'), '');
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('maps the home page, nested pages, and directory indexes to their built files', () => {
    expect(builtPageFor('', outDir)).toBe(join(outDir, 'index.html'));
    expect(builtPageFor('how-to/markdown', outDir)).toBe(join(outDir, 'how-to', 'markdown.html'));
    expect(builtPageFor('guide', outDir)).toBe(join(outDir, 'guide', 'index.html'));
    expect(builtPageFor('missing', outDir)).toBeNull();
  });
});
