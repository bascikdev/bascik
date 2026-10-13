import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NAV } from './nav.js';

/**
 * Naming-convention regression guard.
 *
 * A page's h1 must equal its sidebar (nav) label exactly, with explicit
 * exceptions listed in LABEL_H1_EXCEPTIONS: /compatibility (the full title is
 * too long for a sidebar link) and the pages whose sidebar label repeats in
 * another section ("Overview", "Build Scripts"), which need a distinct h1 so
 * their <title> is unique for search engines.
 *
 * <title> is deliberately NOT derived from the h1: it is written for search
 * results (keyword-rich, 15-65 characters, always naming Bascik) and must be
 * unique per page. The tests below enforce those rules.
 */

const DOCS_ROOT = path.resolve(import.meta.dirname, '../..');

/** Explicit exceptions where the sidebar label and h1 intentionally differ. */
const LABEL_H1_EXCEPTIONS: Record<string, { label: string; h1: string }> = {
  '/compatibility': { label: 'Compatibility', h1: 'Web Standards & Scoping Compatibility' },
  // SEO: sidebar labels repeat across sections ("Overview", "Build Scripts"),
  // but every <title> must be unique, so these pages carry a distinct h1.
  '/deployment': { label: 'Overview', h1: 'Deployment Overview' },
  '/internals': { label: 'Overview', h1: 'Internals Overview' },
  '/switch': { label: 'Overview', h1: 'Switch to Bascik' },
  '/testing': { label: 'Overview', h1: 'Testing and Debugging Overview' },
  '/lighthouse': { label: 'Overview', h1: 'Lighthouse 100s Overview' },
  '/example-components': { label: 'Overview', h1: 'Example Components' },
  '/testing/build-scripts': { label: 'Build Scripts', h1: 'Testing Build Scripts' },
  '/testing/exec-scripts': { label: 'Exec Scripts', h1: 'Testing Exec Scripts' },
  '/testing/server-scripts': { label: 'Server Scripts', h1: 'Testing Server Scripts' },
};

/** Search engines truncate titles around 60 characters; leave a little headroom. */
const TITLE_MIN_LENGTH = 15;
const TITLE_MAX_LENGTH = 65;

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
        // External nav entries (e.g. Merch) are off-site with no local content
        // MD or page shell, so the h1/title convention does not apply to them.
        if (page.external) continue;
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

  it('every page <title> names Bascik and fits a search result', async () => {
    const invalid: { href: string; title: string; reason: string }[] = [];
    const missing: { href: string }[] = [];

    for (const section of NAV) {
      for (const page of section.pages) {
        // External nav entries have no local page shell, so there is no <title>.
        if (page.external) continue;
        const title = await readPageTitle(page.href);
        if (title === null) {
          missing.push({ href: page.href });
          continue;
        }
        if (!title.includes('Bascik')) invalid.push({ href: page.href, title, reason: 'must contain "Bascik"' });
        if (title.length < TITLE_MIN_LENGTH || title.length > TITLE_MAX_LENGTH) {
          invalid.push({ href: page.href, title, reason: `length ${title.length} outside ${TITLE_MIN_LENGTH}-${TITLE_MAX_LENGTH}` });
        }
      }
    }

    expect(missing, `pages with no <title>: ${JSON.stringify(missing)}`).toEqual([]);
    expect(invalid, `invalid titles: ${JSON.stringify(invalid, null, 2)}`).toEqual([]);
  });

  it('every page <title> is unique so search engines can tell pages apart', async () => {
    const hrefsByTitle = new Map<string, string[]>();

    for (const section of NAV) {
      for (const page of section.pages) {
        if (page.external) continue;
        const title = await readPageTitle(page.href);
        if (title === null) continue;
        hrefsByTitle.set(title, [...(hrefsByTitle.get(title) ?? []), page.href]);
      }
    }

    const duplicates = [...hrefsByTitle].filter(([, hrefs]) => hrefs.length > 1);
    expect(duplicates, `duplicate <title> values: ${JSON.stringify(duplicates)}`).toEqual([]);
  });
});
