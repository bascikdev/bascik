// `@bascik/bascik` and `@bascik/language-server` each carry a copy of the scoping-compatibility matcher: the
// compiler warns with one when it builds a component, and the language server reports with the other in the editor
// and in `bascik --check`. Neither package can import the other (the language server is an optional peer of the
// compiler), so this test, which sees both, is what keeps them saying the same thing.
//
// The rules themselves (`compatibility-rules.json`) are kept identical by generate-compatibility-rules.test.ts.
import { describe, expect, it } from 'vitest';

interface Matchers {
  findCompatibilityMatches: (text: string, kind: 'css' | 'js') => Array<{ rule: { id: string }; index: number }>;
}

// Loaded at run time, not imported: `docs` type-checks only its own sources, and these live in other packages.
const compiler = (await import(new URL('../../pkg/src/lib/compatibility-checker.ts', import.meta.url).href)) as Matchers;
const languageServer = (await import(new URL('../../lsp/src/rules.ts', import.meta.url).href)) as Matchers;

const summarize = (matches: Array<{ rule: { id: string }; index: number }>) =>
  matches.map(({ rule, index }) => `${rule.id}@${index}`).sort();

const css = [
  '[id="a"] { color: red; }',
  '/* [id="commented"] { color: red; } */',
  '.card::before { content: "[id]"; }',
  '[data-state] { color: blue; }',
  '[data-state]:hover { color: blue; }',
  '[data-state][hidden] { color: blue; }',
  '[data-state] .scoped-class { color: blue; }',
  ':is(div, span) { margin: 0; }',
  '#ok, .fine > p { color: #fff; }',
  '',
].join('\n');

const js = [
  'el.id = "x";',
  '// el.id = "commented";',
  'const note = "el.id = nope";',
  'document.querySelector("[data-open]");',
  'document.querySelector(".card");',
  'el.removeAttribute("class");',
  '/* document.querySelector("[hidden]"); */',
  '',
].join('\n');

describe('compatibility matcher parity', () => {
  it.each([
    ['css', css],
    ['js', js],
  ] as const)('finds the same %s problems at the same places', (kind, source) => {
    const fromCompiler = summarize(compiler.findCompatibilityMatches(source, kind));
    expect(fromCompiler.length).toBeGreaterThan(0);
    expect(summarize(languageServer.findCompatibilityMatches(source, kind))).toEqual(fromCompiler);
  });

  it('agrees that a commented-out problem is not a problem', () => {
    const commented = '/* [id] { x: y } */\n';
    const commentedJs = '// el.id = "x";\n/* document.querySelector("[hidden]"); */\n';
    for (const engine of [compiler, languageServer]) {
      expect(engine.findCompatibilityMatches(commented, 'css')).toEqual([]);
      expect(engine.findCompatibilityMatches(commentedJs, 'js')).toEqual([]);
    }
  });

  it('agrees on text inside a string, whatever the answer is', () => {
    // Strings are kept on purpose: a rule may need to read one. So a pattern can match inside a string, and what
    // matters here is only that the two engines make the same call.
    const source = 'const s = "el.id = 1";\n.a::before { content: "[data-x]"; }\n';
    for (const kind of ['css', 'js'] as const) {
      expect(summarize(languageServer.findCompatibilityMatches(source, kind))).toEqual(
        summarize(compiler.findCompatibilityMatches(source, kind)),
      );
    }
  });
});
