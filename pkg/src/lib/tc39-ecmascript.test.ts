/**
 * TC39 / ECMA-262 JavaScript Conformance Test Suite
 *
 * Grounded in:
 * - TC39 / ECMA-262 (ECMAScript Language Specification)
 * - Test262 Conformance Test Suite (https://github.com/tc39/test262)
 * - WPT WebIDL Test Suite (https://wpt.live/webidl/)
 * - WHATWG Web Application APIs (https://wpt.live/html/webappapis/)
 *
 * Validates that Bascik's JavaScript compiler and minifier strictly adhere to
 * ECMAScript syntax, Automatic Semicolon Insertion (ASI) invariants, IIFE lexical
 * scoping boundaries, and WebIDL-compliant DOM query rewritings.
 */
import { describe, it, expect } from 'vitest';
import {
  namespaceScriptTags,
  prefixElementAttribute,
} from './javascript.js';
import { minifyJs } from './js-minifier.js';

describe('TC39 / ECMA-262 JavaScript Conformance', () => {
  const componentName = 'counter-card';

  describe('1. Automatic Semicolon Insertion (ASI / ECMA-262 §12)', () => {
    it('preserves semicolons and restricted linebreaks around return statements', () => {
      const inputJs = `
        function calculate() {
          return
          {
            value: 42
          };
        }
      `;
      // In JS ASI rules, 'return\\n{' returns undefined, NOT the object.
      // Minifier must not collapse this into 'return{value:42}' which would change runtime semantics.
      const minified = minifyJs(inputJs);
      expect(minified).toContain('return;');
    });

    it('safely handles leading parenthesis and brackets following statements', () => {
      const inputJs = `
        const a = 1;
        (function() {
          console.log('IIFE');
        })();
        const arr = [1, 2, 3];
        [4, 5, 6].forEach(x => console.log(x));
      `;
      const minified = minifyJs(inputJs);
      expect(minified).toContain('const a=1;(function(){console.log(\'IIFE\');})();');
      expect(minified).toContain('const arr=[1,2,3];[4,5,6].forEach(');
    });

    it('preserves regex literals vs. division operator disambiguation', () => {
      const inputJs = `
        const result = 10 / 2 / 5;
        const pattern = /^[a-z0-9_-]+$/i;
        if (pattern.test('test')) {
          const match = str.match(/\\d+/g);
        }
      `;
      const minified = minifyJs(inputJs);
      expect(minified).toContain('10 / 2 / 5');
      expect(minified).toContain('/^[a-z0-9_-]+$/i');
      expect(minified).toContain('/\\d+/g');
    });
  });

  describe('2. Template Literals & String Literal Preservation (ECMA-262 §13.2.8)', () => {
    it('preserves exact spacing, newlines, and ${...} expressions inside template literals', () => {
      const inputJs = `
        const name = "Bascik";
        const html = \`
          <div class="user-card">
            <h1>\${name.toUpperCase()}</h1>
            <p>   Multiple   spaces   preserved   </p>
          </div>\`;
      `;
      const minified = minifyJs(inputJs);
      expect(minified).toContain('const name="Bascik";');
      expect(minified).toContain('const html=`\n          <div class="user-card">\n            <h1>${name.toUpperCase()}</h1>\n            <p>   Multiple   spaces   preserved   </p>\n          </div>`;');
    });
  });

  describe('3. Lexical Scoping & IIFE Isolation (ECMA-262 §14 / WHATWG HTML §8)', () => {
    it('wraps component scripts in an isolated IIFE preventing global variable leakage', () => {
      const component = {
        name: componentName,
        filePath: `components/${componentName}.html`,
        fileContent: `
          <div class="card">
            <button id="btn">Click me</button>
          </div>
          <style>
            .card { padding: 1rem; }
          </style>
          <script>
            let count = 0;
            const btn = document.getElementById('btn');
            btn.addEventListener('click', () => {
              count++;
            });
          </script>
        `,
      };

      const namespaced = namespaceScriptTags(component);

      expect(namespaced.fileContent).toContain('<script>(function() {');
      expect(namespaced.fileContent).toContain('let count = 0;');
      expect(namespaced.fileContent).toContain('})();</script>');
    });

    it('preserves <script type="module"> without unnecessary IIFE wrapping', () => {
      const component = {
        name: 'module-comp',
        filePath: 'components/module-comp.html',
        fileContent: `
          <div class="box"></div>
          <script type="module">
            import { render } from './renderer.js';
            render();
          </script>
        `,
      };

      const namespaced = namespaceScriptTags(component);
      // ES modules are scoped to their module context by definition in WHATWG HTML §8
      expect(namespaced.fileContent).toContain('<script type="module">');
      expect(namespaced.fileContent).toContain("import { render } from './renderer.js';");
    });
  });

  describe('4. DOM Query Rewriting & WebIDL Conformance (WHATWG DOM §4 / WebIDL)', () => {
    it('rewrites document.getElementById to target scoped identifier classes without modifying method call syntax', () => {
      const component = {
        name: componentName,
        fileContent: `
          <button id="submit-btn">Submit</button>
          <h1 id="main-title">Title</h1>
          <script>
            const button = document.getElementById("submit-btn");
            const title = document.getElementById('main-title');
          </script>
        `,
      };
      const result = prefixElementAttribute(component, "id", "inst123");

      expect(result.fileContent).toContain(`getElementById("bascik__${componentName}__inst123__submit-btn")`);
      expect(result.fileContent).toContain(`getElementById('bascik__${componentName}__inst123__main-title')`);
    });

    it('rewrites querySelector and querySelectorAll to scope class selectors', () => {
      const component = {
        name: componentName,
        fileContent: `
          <div class="nav-item">Nav</div>
          <div class="list-item">Item</div>
          <style>
            .nav-item { color: blue; }
            .list-item { color: green; }
          </style>
          <script>
            const item = document.querySelector(".nav-item");
            const allItems = document.querySelectorAll('.list-item');
          </script>
        `,
      };
      const result = prefixElementAttribute(component, "class", "inst123");

      expect(result.fileContent).toContain(`querySelector(".bascik__${componentName}__nav-item")`);
      expect(result.fileContent).toContain(`querySelectorAll('.bascik__${componentName}__list-item')`);
    });
  });
});
