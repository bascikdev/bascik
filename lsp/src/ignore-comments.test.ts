import { describe, it, expect } from 'vitest';
import { parseIgnoreDirectives, isDiagnosticIgnored } from './ignore-comments.js';

describe('ignore-comments', () => {
  it('parses HTML <!-- bascik-ignore --> for next line', () => {
    const html = `<div>\n<!-- bascik-ignore -->\n<button id="x"></button>\n</div>`;
    const ranges = parseIgnoreDirectives(html, 'html');
    expect(ranges.length).toBe(1);
    expect(isDiagnosticIgnored(2, undefined, ranges)).toBe(true);
    expect(isDiagnosticIgnored(0, undefined, ranges)).toBe(false);
  });

  it('parses HTML <!-- bascik-disable --> block', () => {
    const html = `<!-- bascik-disable -->\n<p></p>\n<div></div>\n<!-- bascik-enable -->\n<span></span>`;
    const ranges = parseIgnoreDirectives(html, 'html');
    expect(isDiagnosticIgnored(1, undefined, ranges)).toBe(true);
    expect(isDiagnosticIgnored(2, undefined, ranges)).toBe(true);
    expect(isDiagnosticIgnored(4, undefined, ranges)).toBe(false);
  });

  it('parses JS/TS // bascik-ignore', () => {
    const js = `// bascik-ignore\nbtn.id = "custom";\nconst y = 1;`;
    const ranges = parseIgnoreDirectives(js, 'javascript');
    expect(isDiagnosticIgnored(1, undefined, ranges)).toBe(true);
    expect(isDiagnosticIgnored(2, undefined, ranges)).toBe(false);
  });

  it('parses CSS /* bascik-ignore */', () => {
    const css = `/* bascik-ignore */\n[data-state] { color: red; }\np { color: blue; }`;
    const ranges = parseIgnoreDirectives(css, 'css');
    expect(isDiagnosticIgnored(1, undefined, ranges)).toBe(true);
    expect(isDiagnosticIgnored(2, undefined, ranges)).toBe(false);
  });
});
