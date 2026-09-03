import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NAV } from './nav.js';

/**
 * Naming-convention regression guard.
 *
 * A page's h1 must equal its sidebar (nav) label exactly, with one explicit
 * exception: /compatibility (label "Compatibility", h1
 * "Web Standards & Scoping Compatibility") because the full title is too
 * long for a sidebar link.
 *
 * Also asserts each page's <title> derives from the h1 with the
 * " - Bascik Docs" suffix for non-homepage pages.
 */

const DOCS_ROOT = path.resolve(import.meta.dirname, '../..');

/** Explicit exceptions where the sidebar label and h1 intentionally differ. */
const LABEL_H1_EXCEPTIONS: Record<string, { label: string; h1: string }> = {
  '/compatibility': { label: 'Compatibility', h1: 'Web Standards & Scoping Compatibility' },
};

/** The homepage is exempt from the title-suffix convention. */
const HOMEPAGE_HREF = '/';

async function readContentH1(href: string): Promise<string | null> {
  // Map route to content MD file
  const rel = href.replace(/^\//, '');
  const candidates = rel
    ? [path.join(DOCS_ROOT, 'content', `${rel}.md`), path.join(DOCS_ROOT, 'content', rel, 'index.md')]
    : [path.join(DOCS_ROOT, 'content', 'index.md')];
  for (const file of candidates) {
    try {
      const md = await readFile(file, 'utf8');
      const h1 = md.match(/^# (.+)$/m);
      if (h1) return h1[1].trim();
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function readPageTitle(href: string): Promise<string | null> {
  const rel = href.replace(/^\//, '');
  const candidates = rel
    ? [
      path.join(DOCS_ROOT, 'src', 'pages', `${rel}.html`),
      path.join(DOCS_ROOT, 'src', 'pages', rel, 'index.html'),
    ]
    : [path.join(DOCS_ROOT, 'src', 'pages', 'index.html')];
  for (const file of candidates) {
    try {
      const html = await readFile(file, 'utf8');
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/);
      if (title) return title[1].trim();
    } catch {
      // try next candidate
    }
  }
  return null;
}

describe('nav label / h1 naming convention', () => {
  it('every page h1 equals its nav label (with the defined exceptions)', async () => {
    const mismatches: { href: string; label: string; h1: string | null }[] = [];
    const missing: { href: string; label: string }[] = [];

    for (const section of NAV) {
      for (const page of section.pages) {
        const h1 = await readContentH1(page.href);
        if (h1 === null) {
          missing.push({ href: page.href, label: page.label });
          continue;
        }
        const exception = LABEL_H1_EXCEPTIONS[page.href];
        if (exception) {
          if (page.label !== exception.label || h1 !== exception.h1) {
            mismatches.push({ href: page.href, label: page.label, h1 });
          }
        } else if (h1 !== page.label) {
          mismatches.push({ href: page.href, label: page.label, h1 });
        }
      }
    }

    expect(missing, `pages with no content MD or no h1: ${JSON.stringify(missing)}`).toEqual([]);
    expect(mismatches, `label/h1 mismatches: ${JSON.stringify(mismatches, null, 2)}`).toEqual([]);
  });

  it('every page <title> derives from its h1 with the Bascik Docs suffix', async () => {
    const mismatches: { href: string; title: string; expected: string }[] = [];
    const missing: { href: string }[] = [];

    for (const section of NAV) {
      for (const page of section.pages) {
        const title = await readPageTitle(page.href);
        if (title === null) {
          missing.push({ href: page.href });
          continue;
        }
        const h1 = await readContentH1(page.href);
        const expectedH1 = LABEL_H1_EXCEPTIONS[page.href]?.h1 ?? h1 ?? page.label;
        const expected = page.href === HOMEPAGE_HREF
          ? 'Bascik'
          : `${expectedH1} - Bascik Docs`;
        if (title !== expected) {
          mismatches.push({ href: page.href, title, expected });
        }
      }
    }

    expect(missing, `pages with no <title>: ${JSON.stringify(missing)}`).toEqual([]);
    expect(mismatches, `title mismatches: ${JSON.stringify(mismatches, null, 2)}`).toEqual([]);
  });
});
