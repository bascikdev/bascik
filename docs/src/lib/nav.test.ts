import { describe, it, expect } from 'vitest';
import { NAV } from './nav.js';
import { renderSectionLabel, renderPagination } from './render-nav.js';

describe('NAV structure', () => {
  it('contains non-empty sections and pages', () => {
    expect(NAV.length).toBeGreaterThan(0);
    for (const section of NAV) {
      expect(section.section).toBeTruthy();
      expect(section.pages.length).toBeGreaterThan(0);
      for (const page of section.pages) {
        expect(page.label).toBeTruthy();
        expect(page.href).toMatch(/^\//);
      }
    }
  });

  it('has unique hrefs across all sections', () => {
    const hrefs = NAV.flatMap(s => s.pages.map(p => p.href));
    const uniqueHrefs = new Set(hrefs);
    expect(uniqueHrefs.size).toEqual(hrefs.length);
  });
});

describe('renderSectionLabel', () => {
  it('returns section label for valid page paths', () => {
    expect(renderSectionLabel('/why-bascik')).toBe('<p class="section-label">Overview</p>');
    expect(renderSectionLabel('/components')).toBe('<p class="section-label">Features</p>');
    expect(renderSectionLabel('/testing')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/unit-testing')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/build-scripts')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/server-scripts')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/exec-scripts')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/recipes/markdown')).toBe('<p class="section-label">Recipes</p>');
  });

  it('returns empty string for unknown paths', () => {
    expect(renderSectionLabel('/nonexistent-page')).toBe('');
  });

  it('reads process.env.BASCIK_PAGE_PATH directly when no argument is provided', () => {
    const originalPath = process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGE_PATH = '/components';
    try {
      expect(renderSectionLabel()).toBe('<p class="section-label">Features</p>');
    } finally {
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });
});

describe('renderPagination', () => {
  it('returns next only on the first page', () => {
    const html = renderPagination('/why-bascik');
    expect(html).toContain('data-pg="next"');
    expect(html).not.toContain('data-pg="prev"');
    expect(html).toContain('<span data-pg-section>Overview</span>');
    expect(html).toContain('<span data-pg-label>Developer Experience</span>');
  });

  it('returns prev only on the last page', () => {
    const html = renderPagination('/switch/from-vue');
    expect(html).toContain('data-pg="prev"');
    expect(html).not.toContain('data-pg="next"');
    expect(html).toContain('<span data-pg-section>Switch to Bascik</span>');
    expect(html).toContain('<span data-pg-label>From Svelte</span>');
  });

  it('includes section names and labels for prev and next across section transitions', () => {
    const html = renderPagination('/deploying');
    expect(html).toContain('data-pg="prev"');
    expect(html).toContain('data-pg="next"');
    expect(html).toContain('<span data-pg-section>Reference</span>');
    expect(html).toContain('<span data-pg-label>Scoping Compatibility</span>');
    expect(html).toContain('<span data-pg-section>Testing & Debugging</span>');
    expect(html).toContain('<span data-pg-label>Overview</span>');
  });

  it('includes section names within the same section', () => {
    const html = renderPagination('/testing/unit-testing');
    expect(html).toContain('<span data-pg-section>Testing & Debugging</span>');
    expect(html).toContain('<span data-pg-label>Overview</span>');
    expect(html).toContain('<span data-pg-label>Component Testing</span>');
  });

  it('returns empty string for unknown paths', () => {
    expect(renderPagination('/nonexistent-page')).toBe('');
  });

  it('reads process.env.BASCIK_PAGE_PATH directly when no argument is provided', () => {
    const originalPath = process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGE_PATH = '/dynamic-routes';
    try {
      const html = renderPagination();
      expect(html).toContain('data-pg="prev"');
      expect(html).toContain('data-pg="next"');
      expect(html).toContain('href="/build-scripts"');
      expect(html).toContain('href="/server"');
    } finally {
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });

  it('auto-detects route path from process.env.BASCIK_SOURCE_FILE when no argument is provided', () => {
    const originalFile = process.env.BASCIK_SOURCE_FILE;
    const originalPageFile = process.env.BASCIK_PAGE_FILE;
    const originalDir = process.env.BASCIK_PAGES_DIR;
    const originalPath = process.env.BASCIK_PAGE_PATH;

    delete process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGES_DIR = '/abs/docs/src/pages';
    process.env.BASCIK_SOURCE_FILE = '/abs/docs/src/pages/dynamic-routes.html';

    try {
      const html = renderPagination();
      expect(html).toContain('data-pg="prev"');
      expect(html).toContain('data-pg="next"');
      expect(html).toContain('href="/build-scripts"');
      expect(html).toContain('href="/server"');
    } finally {
      process.env.BASCIK_SOURCE_FILE = originalFile;
      process.env.BASCIK_PAGE_FILE = originalPageFile;
      process.env.BASCIK_PAGES_DIR = originalDir;
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });
});
