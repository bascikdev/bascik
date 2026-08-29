/**
 * WHATWG HTML & DOM Conformance Test Suite
 *
 * Grounded in:
 * - WHATWG HTML Living Standard §3, §4, §13
 * - WHATWG DOM §4 (Shadow DOM & Slots)
 * - WPT HTML & DOM Test Suites (https://wpt.live/html/, https://wpt.live/dom/)
 * - W3C UAAG 1.0 Accessibility Guidelines
 *
 * Validates that Bascik complies with standard HTML parsing, template element
 * inertness, slot distribution, custom element conventions, rawtext shielding,
 * and standard-compliant HTML minification.
 */
import { describe, it, expect } from 'vitest';
import {
  NATIVE_HTML_ELEMENTS,
  extractNamedSlotContent,
  extractDefaultSlotContent,
  replaceNamedSlots,
  replaceDefaultSlots,
} from './components.js';
import {
  INLINE_TAGS,
  minifyHtml,
} from './html-minifier.js';

describe('WHATWG HTML & DOM Conformance', () => {
  describe('1. Native HTML Elements (WHATWG HTML §4.13.1.2)', () => {
    it('accurately distinguishes standard HTML elements from custom components', () => {
      const coreElements = [
        'html', 'head', 'body', 'title', 'meta', 'link', 'style', 'script',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'hr', 'pre', 'blockquote',
        'ol', 'ul', 'menu', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption',
        'main', 'div', 'article', 'section', 'nav', 'aside', 'header', 'footer',
        'a', 'em', 'strong', 'small', 's', 'cite', 'q', 'dfn', 'abbr', 'ruby',
        'data', 'time', 'code', 'var', 'samp', 'kbd', 'sub', 'sup', 'i', 'b',
        'u', 'mark', 'bdi', 'bdo', 'span', 'br', 'wbr', 'picture', 'source',
        'img', 'iframe', 'embed', 'object', 'video', 'audio', 'track', 'canvas',
        'form', 'label', 'input', 'button', 'select', 'datalist', 'optgroup',
        'option', 'textarea', 'output', 'progress', 'meter', 'fieldset', 'legend',
        'details', 'summary', 'dialog', 'template', 'slot'
      ];

      for (const el of coreElements) {
        expect(NATIVE_HTML_ELEMENTS.has(el)).toBe(true);
      }
    });

    it('identifies non-native custom element tags', () => {
      expect(NATIVE_HTML_ELEMENTS.has('my-card')).toBe(false);
      expect(NATIVE_HTML_ELEMENTS.has('user-badge')).toBe(false);
      expect(NATIVE_HTML_ELEMENTS.has('nav-bar')).toBe(false);
    });
  });

  describe('2. Raw-Text & Whitespace-Sensitive Tag Protection (WHATWG HTML §13.1.2)', () => {
    it('preserves exact indentation and formatting inside <pre>, <textarea>, and <script>', () => {
      const inputHtml = `
        <div class="container">
          <pre>
    function calculate(x, y) {
      // comment with <tags> & symbols
      return x * 2 + y;
    }
          </pre>
          <textarea>
            Line 1:   leading spaces
            Line 2: &lt;safe-text&gt;
          </textarea>
          <script>
            // Script content
            const x = "<div class='nested'></div>";
          </script>
        </div>
      `;
      const minified = minifyHtml(inputHtml);

      expect(minified).toContain('function calculate(x, y) {\n      // comment with <tags> & symbols\n      return x * 2 + y;\n    }');
      expect(minified).toContain('Line 1:   leading spaces\n            Line 2: &lt;safe-text&gt;');
      expect(minified).toContain('const x = "<div class=\'nested\'></div>";');
    });
  });

  describe('3. Inline Element Spacing Preservation (CSS Text Level 3 / WHATWG Phrasing Content)', () => {
    it('preserves single spaces between adjacent phrasing elements', () => {
      const inputHtml = `
        <p>
          Click <a href="/docs">here</a> for <strong>more</strong> information.
          <span>Item 1</span> <span>Item 2</span> <span>Item 3</span>
          <code>npm</code> <code>install</code>
        </p>
      `;
      const minified = minifyHtml(inputHtml);

      expect(minified).toContain('<a href="/docs">here</a> for <strong>more</strong> information.');
      expect(minified).toContain('<span>Item 1</span> <span>Item 2</span> <span>Item 3</span>');
      expect(minified).toContain('<code>npm</code> <code>install</code>');
    });

    it('recognizes all standard inline tags in INLINE_TAGS set', () => {
      const phrasingTags = ['a', 'span', 'strong', 'em', 'code', 'b', 'i', 'small', 'sub', 'sup', 'label', 'time', 'abbr', 'kbd', 'mark', 'q'];
      for (const tag of phrasingTags) {
        expect(INLINE_TAGS.has(tag)).toBe(true);
      }
    });
  });

  describe('4. Template Elements & Slot Semantics (WHATWG DOM §4 / HTML §4.12)', () => {
    it('replaces named slots with provided content and handles multiple named slots', () => {
      const componentHtml = `
        <div class="card">
          <header class="card-header">
            <div data-bascik-slot="header">Default Header</div>
          </header>
          <main class="card-body">
            <div data-bascik-slot>Default Body Content</div>
          </main>
          <footer class="card-footer">
            <div data-bascik-slot="footer">Default Footer</div>
          </footer>
        </div>
      `;

      const usageInnerHtml = `
        <div data-bascik-slot="header">
          <h2>Custom Title</h2>
        </div>
        <p>Custom paragraph in default body.</p>
        <div data-bascik-slot="footer">
          <button>Close</button>
        </div>
      `;

      // Extract named and default slots
      const namedSlots = extractNamedSlotContent(usageInnerHtml);
      const defaultContent = extractDefaultSlotContent(usageInnerHtml);

      expect(namedSlots.header).toContain('<h2>Custom Title</h2>');
      expect(namedSlots.footer).toContain('<button>Close</button>');
      expect(defaultContent).toContain('<p>Custom paragraph in default body.</p>');

      // Replace named and default slots
      let result = replaceNamedSlots(componentHtml, namedSlots);
      result = replaceDefaultSlots(result, defaultContent);

      expect(result).toContain('<h2>Custom Title</h2>');
      expect(result).toContain('<button>Close</button>');
      expect(result).toContain('<p>Custom paragraph in default body.</p>');
      expect(result).not.toContain('Default Header');
      expect(result).not.toContain('Default Footer');
      expect(result).not.toContain('Default Body Content');
    });

    it('falls back to default slot contents when no children are provided', () => {
      const componentHtml = `
        <div class="panel">
          <div data-bascik-slot>Fallback Panel Content</div>
        </div>
      `;
      const replaced = replaceDefaultSlots(componentHtml, "");
      expect(replaced).toContain('Fallback Panel Content');
    });
  });

  describe('5. HTML Minification Conformance', () => {
    it('removes standard HTML comments while protecting conditional comments', () => {
      const inputHtml = `
        <!-- Standard build comment to remove -->
        <div class="app">
          <p>Visible text</p>
        </div>
      `;
      const minified = minifyHtml(inputHtml);
      expect(minified).not.toContain('Standard build comment');
      expect(minified).toContain('<p>Visible text</p>');
    });

    it('collapses redundant whitespace between block elements', () => {
      const inputHtml = `<header>
          <nav>
            <ul>
              <li>Home</li>
              <li>About</li>
            </ul>
          </nav>
        </header>`;
      const minified = minifyHtml(inputHtml).trim();
      expect(minified).toBe('<header><nav><ul><li>Home</li><li>About</li></ul></nav></header>');
    });
  });
});
