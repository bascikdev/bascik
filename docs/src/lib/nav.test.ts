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
});
