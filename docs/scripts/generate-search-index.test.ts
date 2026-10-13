import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../bascik.config.ts';
import { HOME_SITELINKS } from '../src/lib/nav.ts';

describe('generate-search-index', () => {
  it('keeps browser-only generation independent of compilation watches', () => {
    const producer = config.pipeline?.exec?.find(entry => entry.script === 'scripts/generate-search-index.ts');
    expect(producer).toMatchObject({
      phase: 'parallel',
      watch: ['content/'],
    });
    expect(producer).not.toHaveProperty('outputs');
    expect(config.pipeline?.watchPaths).not.toContain('dist/assets/search-index.json');
    expect(config.pipeline?.watchPaths).toContain('src/css/');
    expect(config.pipeline?.watchPaths).toContain('src/lib/');
  });

  it('generates dist/assets/search-index.json from nav pages', async () => {
    await import('./generate-search-index.js');

    const searchIndexFile = path.resolve(import.meta.dirname, '../dist/assets/search-index.json');
    const content = await fs.readFile(searchIndexFile, 'utf8');
    const entries = JSON.parse(content);

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    const firstEntry = entries[0];
    expect(firstEntry).toHaveProperty('title');
    expect(firstEntry).toHaveProperty('navLabel');
    expect(firstEntry).toHaveProperty('section');
    expect(firstEntry).toHaveProperty('path');
    expect(firstEntry).toHaveProperty('text');
  });

  it('reads the meta description whatever the attribute order or quote style', async () => {
    const { metaDescription } = await import('./generate-search-index.js');

    expect(metaDescription('<meta name="description" content="A">')).toBe('A');
    expect(metaDescription('<meta content="B" name="description">')).toBe('B');
    expect(metaDescription("<meta\n  name='description'\n  content='C' />")).toBe('C');
    expect(metaDescription('<meta name="viewport" content="x"><meta content="D" NAME="Description">')).toBe('D');
    expect(metaDescription('<meta name="viewport" content="x">')).toBeUndefined();
  });

  it('indexes the Home page first with the ordered sitelinks from nav.ts', async () => {
    await import('./generate-search-index.js');

    const searchIndexFile = path.resolve(import.meta.dirname, '../dist/assets/search-index.json');
    const entries: Array<{ title: string; navLabel: string; section: string; path: string; heading: string | null; text: string; sitelinks?: string[] }> =
      JSON.parse(await fs.readFile(searchIndexFile, 'utf8'));

    const home = entries[0];
    expect(home.path).toBe('/');
    expect(home.heading).toBeNull();
    expect(home.section).toBe('Home');
    expect(home.title).toContain('Bascik');
    expect(home.text).toContain('build tool for HTML components');
    expect(home.sitelinks).toEqual(HOME_SITELINKS);
    expect(entries.filter(e => e.sitelinks).length).toBe(1);

    for (const href of HOME_SITELINKS) {
      expect(entries.some(e => e.path === href && e.heading === null)).toBe(true);
    }
  });

  it('indexes code block contents and h3 headings for deduplicateCss across pages', async () => {
    await import('./generate-search-index.js');

    const searchIndexFile = path.resolve(import.meta.dirname, '../dist/assets/search-index.json');
    const content = await fs.readFile(searchIndexFile, 'utf8');
    const entries: Array<{ navLabel: string; heading: string | null; text: string; path: string }> = JSON.parse(content);

    const dedupEntries = entries.filter(e =>
      (e.heading && e.heading.toLowerCase().includes('deduplicatecss')) ||
      (e.text && e.text.toLowerCase().includes('deduplicatecss'))
    );

    // Ensure scoped-styles, configuration, scoping-system, and transpilation-pipeline are indexed
    const navLabels = new Set(dedupEntries.map(e => e.navLabel));
    expect(navLabels.has('Scoped Styles')).toBe(true);
    expect(navLabels.has('Configuration')).toBe(true);
    expect(navLabels.has('Scoping System')).toBe(true);
    expect(navLabels.has('Transpilation Pipeline')).toBe(true);

    // Verify h3 heading indexing and anchor generation
    const scopedStylesH3 = dedupEntries.find(e => e.navLabel === 'Scoped Styles' && e.heading === 'deduplicateCss Trade-Off Comparison');
    expect(scopedStylesH3).toBeDefined();
    expect(scopedStylesH3?.path).toBe('/scoped-styles#deduplicatecss-trade-off-comparison');

    // Verify headings do not contain unstripped backticks
    for (const e of dedupEntries) {
      if (e.heading) {
        expect(e.heading).not.toContain('`');
      }
    }
  });
});
