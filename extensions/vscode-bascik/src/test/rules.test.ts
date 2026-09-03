import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchCompatibilityRules } from '../rules';
import { analyzeApiRouteSource } from '../api-rules';

suite('Bascik HTML Grammar', () => {
  test('highlights prop attribute directives with hyphenated targets', () => {
    const grammarPath = path.resolve(__dirname, '../../syntaxes/bascik-html.tmLanguage.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8')) as {
      patterns: Array<{ match: string }>;
    };
    const directivePattern = new RegExp(grammar.patterns[0].match);
    assert.ok(directivePattern.test('data-bascik-attr-aria-label'));
    assert.ok(directivePattern.test('data-bascik-attr-data-foo'));
    assert.ok(directivePattern.test('data-bascik-preserve'));
  });
});

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

  suite('API Route Diagnostics', () => {
    test('reports error when no recognized method is exported', () => {
      const code = 'export const helper = () => "not a method";';
      const diags = analyzeApiRouteSource(code);
      assert.ok(diags.some((d) => d.severity === 'error' && d.message.includes('does not export any recognized HTTP method')));
    });

    test('reports warning for lowercase or mixed-case export that looks like a method', () => {
      const code = 'export const post = async () => new Response("ok");';
      const diags = analyzeApiRouteSource(code);
      assert.ok(diags.some((d) => d.severity === 'warning' && d.message.includes('must be uppercase')));
    });

    test('reports warning when handler return type is not Response or Promise<Response>', () => {
      const code = 'export const GET = async (): Promise<string> => "hello";';
      const diags = analyzeApiRouteSource(code);
      assert.ok(diags.some((d) => d.severity === 'warning' && d.message.includes('must return a standard WHATWG Response')));
    });

    test('reports info diagnostic when request.json() is called without try/catch', () => {
      const code = 'export const POST = async (req: Request) => { const body = await req.json(); return Response.json(body); };';
      const diags = analyzeApiRouteSource(code);
      assert.ok(diags.some((d) => d.severity === 'info' && d.message.includes('try/catch')));
    });

    test('does not report info diagnostic when request.json() is within try/catch', () => {
      const code = 'export const POST = async (req: Request) => { try { const body = await req.json(); return Response.json(body); } catch { return new Response("bad json", { status: 400 }); } };';
      const diags = analyzeApiRouteSource(code);
      assert.ok(!diags.some((d) => d.severity === 'info' && d.message.includes('try/catch')));
    });
  });
});
