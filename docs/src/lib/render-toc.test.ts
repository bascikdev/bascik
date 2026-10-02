import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPageTableOfContents } from './render-nav.ts';
import { renderMd } from './md-renderer.ts';

let dir: string;
let previousPageFile: string | undefined;
let previousSourceFile: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bascik-toc-'));
  previousPageFile = process.env.BASCIK_PAGE_FILE;
  previousSourceFile = process.env.BASCIK_SOURCE_FILE;
  delete process.env.BASCIK_PAGE_FILE;
  delete process.env.BASCIK_SOURCE_FILE;
});

afterEach(async () => {
  if (previousPageFile === undefined) delete process.env.BASCIK_PAGE_FILE;
  else process.env.BASCIK_PAGE_FILE = previousPageFile;
  if (previousSourceFile === undefined) delete process.env.BASCIK_SOURCE_FILE;
  else process.env.BASCIK_SOURCE_FILE = previousSourceFile;
  await rm(dir, { recursive: true, force: true });
});

async function toc(markdown: string): Promise<string> {
  const file = join(dir, 'page.md');
  await writeFile(file, markdown);
  return renderPageTableOfContents(file);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="#([^"]*)"/g)].map((match) => match[1]);
}

describe('renderPageTableOfContents', () => {
  it('nests h3 headings under their h2 and skips h1 and h4', async () => {
    const html = await toc('# Title\n\n## One\n\n### One A\n\n#### Too deep\n\n## Two\n');
    expect(html).toBe(
      '<li><a href="#one" data-toc-level="2">One</a><ol class="docs-toc-subsections">' +
      '<li><a href="#one-a" data-toc-level="3">One A</a></li></ol></li>' +
      '<li><a href="#two" data-toc-level="2">Two</a></li>',
    );
  });

  it('keeps an h3 that precedes any h2 as a flat item', async () => {
    const html = await toc('### Early\n\n## Later\n');
    expect(html).toBe('<li><a href="#early" data-toc-level="3">Early</a></li><li><a href="#later" data-toc-level="2">Later</a></li>');
  });

  it('resolves a relative content path against the working directory', async () => {
    await writeFile(join(dir, 'rel.md'), '## Relative\n');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(hrefs(await renderPageTableOfContents('rel.md'))).toEqual(['relative']);
    } finally {
      process.chdir(cwd);
    }
  });

  it('ignores heading-like lines inside fenced code blocks', async () => {
    const html = await toc('## Real\n\n```md\n## A practical heading\n### Also fake\n```\n\n~~~\n## Tilde fake\n~~~\n\n## After\n');
    expect(hrefs(html)).toEqual(['real', 'after']);
  });

  it('returns an empty string when the page has no h2 or h3 headings', async () => {
    expect(await toc('# Only a title\n\nBody text.\n')).toBe('');
  });

  it('returns an empty string when the Markdown file is missing', async () => {
    expect(await renderPageTableOfContents(join(dir, 'missing.md'))).toBe('');
  });

  it('escapes heading text in link markup', async () => {
    const html = await toc('## Use `<script>` & "quotes"\n');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('uses the same ids as the Markdown renderer, including inline code, links, and punctuation', async () => {
    const markdown = [
      '# Title',
      '',
      '## Why `data-*`?',
      '### 1. Document-Level Metadata Hints (`meta-*`)',
      '## [Linked](/x) heading',
      '## Template Tags → data-bascik-prop-* and attrs',
      '## Tom & Jerry\'s "Show"',
      '### When `run_worker_first` Applies',
      '',
    ].join('\n');
    const file = join(dir, 'ids.md');
    await writeFile(file, markdown);

    const tocIds = hrefs(await renderPageTableOfContents(file));
    const rendered = await renderMd(file);
    const pageIds = [...rendered.matchAll(/<h[23] id="([^"]*)"/g)].map((match) => match[1]);

    expect(tocIds.length).toBe(6);
    expect(tocIds).toEqual(pageIds);
  });

  it('mirrors duplicate heading ids exactly as the page emits them', async () => {
    const markdown = '## Same\n\n## Same\n';
    const file = join(dir, 'dup.md');
    await writeFile(file, markdown);
    const rendered = await renderMd(file);
    const pageIds = [...rendered.matchAll(/<h[23] id="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs(await renderPageTableOfContents(file))).toEqual(pageIds);
  });
});
