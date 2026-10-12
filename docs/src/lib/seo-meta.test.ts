import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NAV } from './nav.ts';

/**
 * SEO regression guard for page shells in the nav.
 *
 * Titles are covered by nav-label-h1.test.ts. This file covers the meta description (search engines show
 * it as the result snippet and truncate around 160 characters) and the structured data every docs article
 * is expected to carry.
 */

const DOCS_ROOT = path.resolve(import.meta.dirname, '../..');

const DESCRIPTION_MIN_LENGTH = 70;
const DESCRIPTION_MAX_LENGTH = 160;

/** Nav pages that are not documentation articles, so they carry no TechArticle JSON-LD. */
const NO_ARTICLE_SCHEMA = new Set([
  '/faq', // FAQPage JSON-LD instead
  '/releases',
  '/press',
  '/sponsor',
]);

async function readPageShell(href: string): Promise<string | null> {
  const rel = href.replace(/^\//, '');
  const candidates = [
    path.join(DOCS_ROOT, 'src', 'pages', `${rel}.html`),
    path.join(DOCS_ROOT, 'src', 'pages', rel, 'index.html'),
  ];
  for (const file of candidates) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      // try next candidate
    }
  }
  return null;
}

function extractDescription(html: string): string | null {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    if (!/\bname\s*=\s*["']description["']/i.test(attrs)) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\bcontent\s*=\s*'([^']*)'/i.exec(attrs);
    return content ? content[1].replace(/\s+/g, ' ').trim() : null;
  }
  return null;
}

const localPages = NAV.flatMap((section) => section.pages).filter((page) => !page.external);

describe('page meta descriptions', () => {
  it(`every nav page has a description of ${DESCRIPTION_MIN_LENGTH}-${DESCRIPTION_MAX_LENGTH} characters`, async () => {
    const invalid: { href: string; reason: string }[] = [];
    for (const page of localPages) {
      const html = await readPageShell(page.href);
      const description = html === null ? null : extractDescription(html);
      if (description === null) {
        invalid.push({ href: page.href, reason: 'missing' });
      } else if (description.length < DESCRIPTION_MIN_LENGTH || description.length > DESCRIPTION_MAX_LENGTH) {
        invalid.push({ href: page.href, reason: `length ${description.length}` });
      }
    }
    expect(invalid, `invalid descriptions: ${JSON.stringify(invalid, null, 2)}`).toEqual([]);
  });

  it('every nav page description is unique', async () => {
    const hrefsByDescription = new Map<string, string[]>();
    for (const page of localPages) {
      const html = await readPageShell(page.href);
      const description = html === null ? null : extractDescription(html);
      if (description === null) continue;
      hrefsByDescription.set(description, [...(hrefsByDescription.get(description) ?? []), page.href]);
    }
    const duplicates = [...hrefsByDescription].filter(([, hrefs]) => hrefs.length > 1);
    expect(duplicates, `duplicate descriptions: ${JSON.stringify(duplicates)}`).toEqual([]);
  });
});

describe('page structured data', () => {
  it('every docs article emits TechArticle JSON-LD', async () => {
    const missing: string[] = [];
    for (const page of localPages) {
      if (NO_ARTICLE_SCHEMA.has(page.href)) continue;
      const html = await readPageShell(page.href);
      if (html === null || !html.includes("from '@/lib/article-schema.ts'")) missing.push(page.href);
    }
    expect(missing, `pages without articleSchema(): ${JSON.stringify(missing)}`).toEqual([]);
  });

  it('every nested nav page emits breadcrumb JSON-LD', async () => {
    const missing: string[] = [];
    // breadcrumbLd() emits nothing for top-level pages, so only nested routes need it.
    for (const page of localPages.filter((p) => p.href.split('/').length > 2)) {
      const html = await readPageShell(page.href);
      if (html === null || !html.includes("from '@/lib/breadcrumb-ld.ts'")) missing.push(page.href);
    }
    expect(missing, `pages without breadcrumbLd(): ${JSON.stringify(missing)}`).toEqual([]);
  });
});
