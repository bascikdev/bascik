import * as assert from 'node:assert';
import { matchCompatibilityRules } from '../rules';

suite('Compatibility Rules Suite', () => {
  suite('CSS Rules', () => {
    test('detects standalone attribute selectors', () => {
      const css = '[data-state] { color: red; }';
      const matches = matchCompatibilityRules(css, 'css');
      assert.ok(matches.some((r) => r.id === 'css-attribute-selector'));
    });

    test('detects element names inside :is, :where, or :has', () => {
      const css = ':is(div, span) { color: blue; }';
      const matches = matchCompatibilityRules(css, 'css');
      assert.ok(matches.some((r) => r.id === 'css-is-element-names'));
    });

    test('does not report warning for @import statements', () => {
      const css = '@import "styles.css";';
      const matches = matchCompatibilityRules(css, 'css');
      assert.ok(!matches.some((r) => r.id === 'css-import'));
    });

    test('returns empty array for clean CSS', () => {
      const css = '.card { font-size: 16px; color: #333; }';
      const matches = matchCompatibilityRules(css, 'css');
      assert.strictEqual(matches.length, 0);
    });
  });

  suite('JS Rules', () => {
    test('detects runtime .id assignment', () => {
      const js = 'element.id = "my-id";';
      const matches = matchCompatibilityRules(js, 'js');
      assert.ok(matches.some((r) => r.id === 'js-id-setter'));
    });

    test('detects attribute selector querySelector', () => {
      const js = 'document.querySelector("[data-active]");';
      const matches = matchCompatibilityRules(js, 'js');
      assert.ok(matches.some((r) => r.id === 'js-attribute-selector'));
    });

    test('detects template-literal class names', () => {
      const js = 'el.className = `btn ${active ? "active" : ""}`;';
      const matches = matchCompatibilityRules(js, 'js');
      assert.ok(matches.some((r) => r.id === 'js-template-classname'));
    });

    test('detects runtime CSS custom property setProperty', () => {
      const js = 'el.style.setProperty("--theme-color", "red");';
      const matches = matchCompatibilityRules(js, 'js');
      assert.ok(matches.some((r) => r.id === 'js-style-setproperty'));
    });

    test('returns empty array for clean JS', () => {
      const js = 'const btn = document.getElementById("submit"); btn.classList.add("active");';
      const matches = matchCompatibilityRules(js, 'js');
      assert.strictEqual(matches.length, 0);
    });
  });
});
