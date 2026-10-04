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
    expect(renderSectionLabel('/environment-variables')).toBe('<p class="section-label">Reference</p>');
    expect(renderSectionLabel('/testing')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/unit-testing')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/build-scripts')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/server-scripts')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/testing/exec-scripts')).toBe('<p class="section-label">Testing & Debugging</p>');
    expect(renderSectionLabel('/how-to/markdown')).toBe('<p class="section-label">How-to</p>');
  });

  it('escapes labels and sections as attribute values, and never emits the old inline spans', () => {
    const html = renderPagination('/testing/unit-testing');
    expect(html).toContain('data-bascik-prop-section="Testing &amp; Debugging"');
    expect(html).not.toContain('<span');
    expect(html).not.toMatch(/data-pg-(dir|section|label)/);
  });

  it('passes the direction text as a prop so each link component can render it', () => {
    const html = renderPagination('/components');
    expect(html).toContain('data-bascik-prop-dir="\u2190 Previous"');
    expect(html).toContain('data-bascik-prop-dir="Next \u2192"');
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
    expect(html).toContain('data-bascik-prop-section="Overview"');
    expect(html).toContain('data-bascik-prop-label="Developer Experience"');
  });

  it('returns prev only on the last page', () => {
    const html = renderPagination('/sponsor');
    expect(html).toContain('data-pg="prev"');
    expect(html).not.toContain('data-pg="next"');
    expect(html).toContain('data-bascik-prop-section="Community"');
    expect(html).toContain('data-bascik-prop-label="Press Resources"');
  });

  it('links releases to the previous section and to press', () => {
    const html = renderPagination('/releases');
    expect(html).toContain('data-bascik-prop-section="Switch to Bascik"');
    expect(html).toContain('data-bascik-prop-label="From WordPress"');
    expect(html).toContain('href="/press"');
  });

  it('places each migration tutorial right after its switch guide', () => {
    const astro = renderPagination('/switch/astro-blog-tutorial');
    expect(astro).toContain('href="/switch/from-astro"');
    expect(astro).toContain('href="/switch/from-eleventy"');
    const eleventy = renderPagination('/switch/eleventy-blog-tutorial');
    expect(eleventy).toContain('href="/switch/from-eleventy"');
    expect(eleventy).toContain('href="/switch/from-hugo"');
    expect(renderSectionLabel('/switch/eleventy-blog-tutorial')).toBe('<p class="section-label">Switch to Bascik</p>');
  });

  it('places the React product table tutorial right after From React', () => {
    const react = renderPagination('/switch/react-product-table-tutorial');
    expect(react).toContain('href="/switch/from-react"');
    expect(react).toContain('href="/switch/from-svelte"');
    expect(renderSectionLabel('/switch/react-product-table-tutorial')).toBe('<p class="section-label">Switch to Bascik</p>');
  });

  it('places the Vue grid tutorial right after From Vue', () => {
    const vue = renderPagination('/switch/vue-grid-tutorial');
    expect(vue).toContain('href="/switch/from-vue"');
    expect(vue).toContain('href="/switch/from-wordpress"');
    expect(renderSectionLabel('/switch/vue-grid-tutorial')).toBe('<p class="section-label">Switch to Bascik</p>');
  });

  it('places Use Cases between Getting Started and Features, with the blog guide before the catalog', () => {
    const sections = NAV.map(s => s.section);
    expect(sections.indexOf('Use Cases')).toBe(sections.indexOf('Overview') + 1);
    expect(sections.indexOf('Features')).toBe(sections.indexOf('Use Cases') + 1);
    const useCases = NAV.find(s => s.section === 'Use Cases')!;
    expect(useCases.pages.map(p => p.href)).toEqual(['/use-cases', '/use-cases/blog', '/use-cases/templates']);

    const first = renderPagination('/use-cases');
    expect(first).toContain('href="/getting-started"');
    expect(first).toContain('href="/use-cases/blog"');
    const last = renderPagination('/use-cases/templates');
    expect(last).toContain('href="/use-cases/blog"');
    expect(last).toContain('href="/components"');
    expect(renderSectionLabel('/use-cases/blog')).toBe('<p class="section-label">Use Cases</p>');
  });

  it('links press to releases and to sponsor', () => {
    const html = renderPagination('/press');
    expect(html).toContain('data-bascik-prop-section="Community"');
    expect(html).toContain('data-bascik-prop-label="Releases"');
    expect(html).toContain('href="/sponsor"');
  });

  it('keeps social profile links out of the nav data', () => {
    const hrefs = NAV.flatMap(s => s.pages.map(p => p.href));
    expect(hrefs.filter(h => /^https?:\/\//.test(h))).toEqual([]);
    expect(hrefs).toContain('/press');
    expect(hrefs).toContain('/sponsor');
  });

  it('includes section names and labels for prev and next across section transitions', () => {
    const html = renderPagination('/production-server');
    expect(html).toContain('data-pg="prev"');
    expect(html).toContain('data-pg="next"');
    expect(html).toContain('data-bascik-prop-section="Reference"');
    expect(html).toContain('data-bascik-prop-label="Development Server"');
    expect(html).toContain('data-bascik-prop-section="Tooling"');
    expect(html).toContain('data-bascik-prop-label="Linter"');
  });

  it('includes section names within the same section', () => {
    const html = renderPagination('/testing/unit-testing');
    expect(html).toContain('data-bascik-prop-section="Testing &amp; Debugging"');
    expect(html).toContain('data-bascik-prop-label="Overview"');
    expect(html).toContain('data-bascik-prop-label="Component Testing"');
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
      expect(html).toContain('href="/stream-scripts"');
      expect(html).toContain('href="/api-routes"');
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
      expect(html).toContain('href="/stream-scripts"');
      expect(html).toContain('href="/api-routes"');
    } finally {
      process.env.BASCIK_SOURCE_FILE = originalFile;
      process.env.BASCIK_PAGE_FILE = originalPageFile;
      process.env.BASCIK_PAGES_DIR = originalDir;
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });

  it('handles process.env.BASCIK_PAGE_PATH = "/components" correctly', () => {
    const originalPath = process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGE_PATH = '/components';
    try {
      const html = renderPagination();
      // The <nav> and its styles belong to the docs-pagination component; the
      // script only emits the link components, whose styles are scoped too.
      expect(html).not.toContain('<nav');
      expect(html).toContain('<pagination-link href="/use-cases/templates" data-pg="prev"');
      expect(html).toContain('href="/use-cases/templates"');
      expect(html).toContain('href="/scoped-styles"');
    } finally {
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });

  it('handles first item in NAV correctly via BASCIK_PAGE_PATH', () => {
    const originalPath = process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGE_PATH = '/why-bascik';
    try {
      const html = renderPagination();
      expect(html).toContain('data-pg="next"');
      expect(html).not.toContain('data-pg="prev"');
      expect(html).toContain('href="/developer-experience"');
    } finally {
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });

  it('handles last item in NAV correctly via BASCIK_PAGE_PATH', () => {
    const originalPath = process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGE_PATH = '/sponsor';
    try {
      const html = renderPagination();
      expect(html).toContain('data-pg="prev"');
      expect(html).not.toContain('data-pg="next"');
      expect(html).toContain('href="/press"');
    } finally {
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });

  it('returns empty string for unknown path via BASCIK_PAGE_PATH', () => {
    const originalPath = process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGE_PATH = '/nonexistent-page';
    try {
      const html = renderPagination();
      expect(html).toBe('');
    } finally {
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });

  it('handles renderSectionLabel with process.env.BASCIK_PAGE_PATH', () => {
    const originalPath = process.env.BASCIK_PAGE_PATH;
    process.env.BASCIK_PAGE_PATH = '/components';
    try {
      expect(renderSectionLabel()).toBe('<p class="section-label">Features</p>');
    } finally {
      process.env.BASCIK_PAGE_PATH = originalPath;
    }
  });
});
