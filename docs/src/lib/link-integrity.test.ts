import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Link-integrity test.
 *
 * Walks every .md file under docs/content and every .html file under
 * docs/src/pages, extracts internal links (href="/..." and Markdown
 * [text](/...)), and asserts each resolves to a real page in docs/src/pages.
 *
 * This test exists so renames (like Recipes -> How-to) and new cross-linked
 * pages (prompts 56, 57, 58) cannot leave stale links behind.
 */

const DOCS_ROOT = path.resolve(import.meta.dirname, '../..');
const CONTENT_DIR = path.join(DOCS_ROOT, 'content');
const PAGES_DIR = path.join(DOCS_ROOT, 'src', 'pages');

async function walk(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, ext)));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/** Collect the set of valid internal routes from the pages directory. */
async function collectRoutes(): Promise<Set<string>> {
  const routes = new Set<string>(['/']);
  const pages = await walk(PAGES_DIR, '.html');
  for (const page of pages) {
    const rel = path.relative(PAGES_DIR, page).replace(/\\/g, '/');
    const withoutExt = rel.replace(/\.html$/, '');
    const route = withoutExt === 'index' ? '/' : `/${withoutExt.replace(/\/index$/, '')}`;
    routes.add(route);
    // Directory-style trailing-slash variant, e.g. /testing/ for /testing/index.html
    if (withoutExt.endsWith('/index')) {
      routes.add(`/${withoutExt.replace(/\/index$/, '')}/`);
    }
  }
  return routes;
}

/** Asset extensions that are not docs pages. */
const ASSET_EXT = /\.(css|ico|svg|woff2?|jpe?g|png|gif|webp|webmanifest|xml|txt|js|mjs|json)$/i;

/**
 * Strip regions that contain illustrative code, not real site links:
 * fenced code blocks in Markdown, and script/code-block regions in HTML.
 */
function stripCode(text: string, isHtml: boolean): string {
  if (!isHtml) {
    return text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '')
      .replace(/`[^`\n]*`/g, '');
  }
  return text
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<code-block[\s\S]*?<\/code-block>/g, '');
}

/** Extract internal links from a source file's text. */
function extractLinks(text: string, isHtml: boolean): string[] {
  const links: string[] = [];
  const prose = stripCode(text, isHtml);
  // Markdown links: [label](/path) and HTML href="/path"
  const mdRe = /\]\((\/[^)\s]*)\)/g;
  const hrefRe = /href="(\/[^"#]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(prose))) links.push(m[1]);
  while ((m = hrefRe.exec(prose))) links.push(m[1]);
  return links.filter((link) => !ASSET_EXT.test(link) && !link.includes('${'));
}

describe('link integrity', () => {
  it('every internal link in content and pages resolves to a real page', async () => {
    const routes = await collectRoutes();
    const files = [
      ...(await walk(CONTENT_DIR, '.md')),
      ...(await walk(PAGES_DIR, '.html')),
    ];
    expect(files.length).toBeGreaterThan(0);

    const broken: { file: string; link: string }[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const isHtml = file.endsWith('.html');
      for (const link of extractLinks(text, isHtml)) {
        const clean = link.split('#')[0].replace(/\/$/, '') || '/';
        if (!routes.has(clean) && !routes.has(link)) {
          broken.push({ file: path.relative(DOCS_ROOT, file), link });
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
