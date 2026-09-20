import { describe, it, expect } from 'vitest';
import { matchCompatibilityRules } from './rules.js';
import { analyzeApiRouteSource } from './api-rules.js';

describe('Scoping Compatibility Rules', () => {
  describe('CSS rules', () => {
    it('detects unanchored standalone attribute selector', () => {
      const css = '[data-state] { color: red; }';
      const matches = matchCompatibilityRules(css, 'css');
      expect(matches.some((m) => m.id === 'css-attribute-selector')).toBe(true);
    });

    it('detects bare element selector in :is()', () => {
      const css = ':is(div, span) { color: blue; }';
      const matches = matchCompatibilityRules(css, 'css');
      expect(matches.some((m) => m.id === 'css-is-element-names')).toBe(true);
    });

    it('ignores class selectors inside :is()', () => {
      const css = ':is(.btn, .link) { color: blue; }';
      const matches = matchCompatibilityRules(css, 'css');
      expect(matches.some((m) => m.id === 'css-is-element-names')).toBe(false);
    });
  });

  describe('JavaScript rules', () => {
    it('detects runtime .id assignment', () => {
      const js = 'element.id = "my-id";';
      const matches = matchCompatibilityRules(js, 'js');
      expect(matches.some((m) => m.id === 'js-id-setter')).toBe(true);
    });

    it('detects attribute selector in querySelector', () => {
      const js = 'document.querySelector("[data-active]");';
      const matches = matchCompatibilityRules(js, 'js');
      expect(matches.some((m) => m.id === 'js-attribute-selector')).toBe(true);
    });

    it('detects template literal in classList.replace', () => {
      const js = 'element.classList.replace(oldName, `card-${state}`);';
      const matches = matchCompatibilityRules(js, 'js');
      expect(matches.some((m) => m.id === 'js-template-classname')).toBe(true);
    });

    it('detects dynamic custom property name in setProperty', () => {
      const js = 'el.style.setProperty("--theme-color", "red");';
      const matches = matchCompatibilityRules(js, 'js');
      expect(matches.some((m) => m.id === 'js-style-setproperty')).toBe(true);
    });
  });
});

describe('API Route Rules', () => {
  it('reports missing method export when none found', () => {
    const ts = 'export const helper = () => "not a method";';
    const diags = analyzeApiRouteSource(ts);
    expect(diags.some((d) => d.severity === 'error' && d.message.includes('does not export any recognized HTTP method'))).toBe(true);
  });

  it('passes when valid GET method is exported', () => {
    const ts = `export async function GET(request: Request) { return new Response("ok"); }`;
    const diags = analyzeApiRouteSource(ts);
    expect(diags.length).toBe(0);
  });
});
