/**
 * CSS `@import` resolution invariants that the build relies on:
 *
 * - Resolution is idempotent. Component stylesheets are resolved when they are
 *   loaded and again while scoping, so a second pass over resolved CSS must
 *   return it unchanged (a missing-import marker once swallowed the rules after it).
 * - `@import` text inside a comment or a string is not an at-rule.
 * - Every local file an import names is reported, so dev can rebuild the pages
 *   that use a component when an imported stylesheet changes.
 */
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./config.js", () => ({
  BascikConfig: {
    scoping: { deduplicateCss: true, scriptBlocks: true, inheritAttributes: true },
    minify: { identifiers: false },
    directory: { out: "dist", pages: "src/pages", components: ["src/components"] },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { resolveCssImports, resolveCssImportsSync } from "./styles.ts";
import { clearScopedCssCache, prefixElementAttribute } from "./javascript.ts";
import type { BascikComponent } from "./types.ts";

let dir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bascik-css-import-")));
  writeFileSync(join(dir, "base.css"), ".base { color: red; }\n");
  writeFileSync(join(dir, "nested.css"), '@import "./base.css";\n.nested { margin: 0; }\n');
  writeFileSync(join(dir, "loop-a.css"), '@import "./loop-b.css";\n.loop-a { padding: 0; }\n');
  writeFileSync(join(dir, "loop-b.css"), '@import "./loop-a.css";\n.loop-b { padding: 1px; }\n');
  writeFileSync(join(dir, "bare.css"), ".bare { gap: 0; }\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => {
  warnSpy.mockRestore();
});

const IMPORTS = [
  '@import "./base.css";',
  "@import url(./nested.css) screen;",
  '@import "./loop-a.css" layer(loop);',
  '@import "./bare";',
  '@import "./missing.css";',
  "@import url('./also-missing.css') supports(display: grid);",
  '@import url("https://fonts.example.com/css?family=Inter");',
];
const RULES = [".card { color: blue; }", ".x::before { content: \"a;b\"; }", "@media print { .p { display: none; } }"];

describe("resolveCssImports idempotence", () => {
  it("keeps the rules after a missing import when resolved CSS is resolved again", () => {
    const once = resolveCssImportsSync('@import "./missing.css";\n.card { color: red; }\n.x { margin: 0; }\n', join(dir, "card.css"));
    expect(once).toBe('/* @import "./missing.css" not found */\n.card { color: red; }\n.x { margin: 0; }\n');
    warnSpy.mockClear();
    expect(resolveCssImportsSync(once, join(dir, "card.html"))).toBe(once);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is a fixed point after one pass, and the async and sync passes agree", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.constantFrom(...IMPORTS), fc.constantFrom(...RULES)), { minLength: 1, maxLength: 8 }),
        async (parts) => {
          const css = parts.join("\n");
          const base = join(dir, "component.css");
          const once = resolveCssImportsSync(css, base);
          expect(await resolveCssImports(css, base)).toBe(once);
          expect(resolveCssImportsSync(once, base)).toBe(once);
          expect(await resolveCssImports(once, base)).toBe(once);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("@import text outside an at-rule", () => {
  it("leaves @import inside comments and strings untouched", () => {
    const css = [
      '/* @import "./base.css"; */',
      ".x::before { content: \"@import './base.css';\"; }",
      ".y::after { content: '@import \"./base.css\";'; }",
    ].join("\n");
    expect(resolveCssImportsSync(css, join(dir, "c.css"))).toBe(css);
  });

  it("still resolves an import after an unquoted url() that contains comment-like text", () => {
    const css = '.bg { background: url(/img/*.png); }\n@import "./base.css";';
    expect(resolveCssImportsSync(css, join(dir, "c.css"))).toBe(".bg { background: url(/img/*.png); }\n.base { color: red; }");
  });

  it("treats an escaped quote as part of the string", () => {
    const css = ".q::before { content: \"a\\\" @import './base.css'; b\"; }\n@import \"./base.css\";";
    expect(resolveCssImportsSync(css, join(dir, "c.css"))).toBe(
      ".q::before { content: \"a\\\" @import './base.css'; b\"; }\n.base { color: red; }",
    );
  });
});

describe("imported stylesheet dependencies", () => {
  it("records nested, circular, extensionless, and missing import targets", async () => {
    const css = [
      '@import "./nested.css";',
      '@import "./loop-a.css";',
      '@import "./bare";',
      '@import "./missing.css";',
      '@import "https://fonts.example.com/x.css";',
    ].join("\n");
    const expected = [
      "bare",
      "bare.css",
      "base.css",
      "loop-a.css",
      "loop-b.css",
      "missing.css",
      "nested.css",
    ].map((name) => join(dir, name));

    const asyncDeps = new Set<string>();
    await resolveCssImports(css, join(dir, "c.css"), undefined, asyncDeps);
    expect([...asyncDeps].sort()).toEqual(expected);

    const syncDeps = new Set<string>();
    resolveCssImportsSync(css, join(dir, "c.css"), undefined, syncDeps);
    expect([...syncDeps].sort()).toEqual(expected);
  });
});

describe("component scoping with resolved imports", () => {
  beforeEach(() => {
    clearScopedCssCache();
  });

  it("scopes the rules that follow a missing import exactly once", () => {
    const component: BascikComponent = {
      name: "my-card",
      fileName: join(dir, "my-card.html"),
      fileContent: '<div class="card">hi</div>',
      cssFileContent: '/* @import "./missing.css" not found */\n.card { color: red; }\n.x { margin: 0; }\n',
    };
    const result = prefixElementAttribute(component, "class", "my-card");
    expect(result.fileContent).toBe('<div class="bascik__my-card__card">hi</div>');
    expect(result.cssFileContent).toContain(".bascik__my-card__card { color: red; }");
    expect(result.cssFileContent).toContain(".bascik__my-card__x { margin: 0; }");
    expect(result.cssFileContent).toContain('/* @import "./missing.css" not found */');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reads an unresolved import's current file contents on every scoping run", () => {
    const tokens = join(dir, "tokens.css");
    const make = (): BascikComponent => ({
      name: "token-card",
      fileName: join(dir, "token-card.html"),
      fileContent: '<div class="t">hi</div>',
      cssFileContent: '@import "./tokens.css";\n.t { color: red; }',
    });
    try {
      writeFileSync(tokens, ".t { border: 1px solid blue; }");
      expect(prefixElementAttribute(make(), "class", "token-card").cssFileContent).toContain("1px solid blue");
      writeFileSync(tokens, ".t { border: 9px solid green; }");
      const second = prefixElementAttribute(make(), "class", "token-card").cssFileContent;
      expect(second).toContain("9px solid green");
      expect(second).not.toContain("1px solid blue");
    } finally {
      rmSync(tokens, { force: true });
    }
  });
});
