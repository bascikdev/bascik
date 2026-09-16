import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isTypeScriptScriptTag,
  isTypeScriptFile,
  stripBrowserTypeScript,
  transformTypeScriptScriptTags,
  looksLikeTypeScript,
  TYPESCRIPT_SCRIPT_TYPE,
} from "./typescript.ts";

describe("isTypeScriptFile", () => {
  it("recognizes .ts and .mts browser script files", () => {
    expect(isTypeScriptFile("src/components/demo/demo.ts")).toBe(true);
    expect(isTypeScriptFile("src/components/demo/demo.mts")).toBe(true);
    expect(isTypeScriptFile("C:\\proj\\src\\demo.TS")).toBe(true);
  });

  it("does not match .js, .mjs, or lookalike names", () => {
    expect(isTypeScriptFile("demo.js")).toBe(false);
    expect(isTypeScriptFile("demo.mjs")).toBe(false);
    expect(isTypeScriptFile("demo.ts.js")).toBe(false);
    expect(isTypeScriptFile("demo.tsx")).toBe(false);
  });
});

describe("isTypeScriptScriptTag", () => {
  it("matches type=\"text/typescript\" in any quoting or casing", () => {
    expect(isTypeScriptScriptTag('<script type="text/typescript">')).toBe(true);
    expect(isTypeScriptScriptTag("<script type='text/typescript'>")).toBe(true);
    expect(isTypeScriptScriptTag("<script type=text/typescript>")).toBe(true);
    expect(isTypeScriptScriptTag('<script TYPE="Text/TypeScript" defer>')).toBe(true);
    expect(TYPESCRIPT_SCRIPT_TYPE).toBe("text/typescript");
  });

  it("does not match ordinary or non-TypeScript script tags", () => {
    expect(isTypeScriptScriptTag("<script>")).toBe(false);
    expect(isTypeScriptScriptTag('<script type="module">')).toBe(false);
    expect(isTypeScriptScriptTag('<script type="application/ld+json">')).toBe(false);
    expect(isTypeScriptScriptTag('<script data-bascik-build type="text/typescript">')).toBe(false);
  });
});

describe("stripBrowserTypeScript", () => {
  it("removes erasable TypeScript syntax", () => {
    const out = stripBrowserTypeScript(
      "const el = document.getElementById('x') as HTMLElement;\nlet n: number = 0;\ninterface P { a: string }\nfunction f(a: string): void {}\nconst y = el!;",
    );
    expect(out).not.toContain(": number");
    expect(out).not.toContain(": string");
    expect(out).not.toContain("as HTMLElement");
    expect(out).not.toContain("interface");
    expect(out).not.toMatch(/el!;/);
    expect(out).toContain("document.getElementById('x')");
    expect(out).toContain("let n");
  });

  it("preserves line count so sourceURL line numbers stay accurate", () => {
    const src = "let a: number = 1;\n\nfunction f(x: string): boolean {\n  return !!x;\n}\n";
    expect(stripBrowserTypeScript(src).split("\n").length).toBe(src.split("\n").length);
  });

  it("removes import type declarations", () => {
    const out = stripBrowserTypeScript("import type { A } from './a.ts';\nconsole.log(1);");
    expect(out).not.toContain("import type");
    expect(out).toContain("console.log(1);");
  });

  it("throws a descriptive error for non-erasable syntax (enum)", () => {
    expect(() => stripBrowserTypeScript("enum E { A, B }", "src/components/x/x.ts")).toThrow(
      /src\/components\/x\/x\.ts[\s\S]*enum/i,
    );
  });

  it("throws a descriptive error for invalid syntax", () => {
    expect(() => stripBrowserTypeScript("const = ;", "src/components/x/x.ts")).toThrow(/src\/components\/x\/x\.ts/);
  });
});

describe("looksLikeTypeScript", () => {
  it("returns false for valid JavaScript, including tricky punctuation", () => {
    const samples = [
      "const a = b < c && d > e;",
      "x = y ? z : w;",
      "label: for (;;) break label;",
      "const o = { a: 1, 'b:c': 2 };",
      "const s = 'x: number'; const t = `${a}: string`;",
      "const re = /a: b/;",
      "a?.[0] ?? b; a ||= c;",
      "class A { #p = 1; static { } get x() { return 1 } }",
      "async function* g() { yield* h(); for await (const x of y) {} }",
      "function f(a = 1, ...r) { return new.target; }",
      "",
      "   \n  ",
    ];
    for (const s of samples) {
      expect(looksLikeTypeScript(s), s).toBe(false);
    }
  });

  it("returns true for erasable TypeScript syntax", () => {
    expect(looksLikeTypeScript("let n: number = 0;")).toBe(true);
    expect(looksLikeTypeScript("const el = document.getElementById('x') as HTMLElement;")).toBe(true);
    expect(looksLikeTypeScript("function f(a: string): void {}")).toBe(true);
    expect(looksLikeTypeScript("interface P { a: string }")).toBe(true);
    expect(looksLikeTypeScript("const y = z!;")).toBe(true);
  });

  it("returns false for code that is invalid in both JavaScript and TypeScript", () => {
    expect(looksLikeTypeScript("const = ;")).toBe(false);
    expect(looksLikeTypeScript("function {")).toBe(false);
  });

  it("returns false for enum (non-erasable, stripper rejects it)", () => {
    // Node's strip-only mode refuses enum; we do not claim it is TypeScript we
    // could have fixed, and the browser will report the SyntaxError itself.
    expect(looksLikeTypeScript("enum E { A }")).toBe(false);
  });
});

describe("transformTypeScriptScriptTags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips types from inline type=\"text/typescript\" scripts and rewrites the type", () => {
    const html = '<div></div><script type="text/typescript">\n  let n: number = 1;\n  console.log(n);\n</script>';
    const out = transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(out).not.toContain("text/typescript");
    expect(out).not.toContain(": number");
    expect(out).toContain("console.log(n);");
    expect(out).toMatch(/<script>\n\s*let n\s+= 1;/);
  });

  it("keeps other attributes and orders them without the type attribute", () => {
    const html = '<script defer type="text/typescript" data-foo="1">let a: string = "";</script>';
    const out = transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(out).toMatch(/<script defer data-foo="1">/);
    expect(out).not.toContain(": string");
  });

  it("leaves ordinary inline scripts, module scripts, external scripts, JSON, and directive scripts untouched", () => {
    const html = [
      "<script>let a: number = 1;</script>",
      '<script type="module">let b: number = 2;</script>',
      '<script src="x.ts"></script>',
      '<script type="application/ld+json">{"a": 1}</script>',
      '<script data-bascik-build type="text/typescript">console.log(1)</script>',
      '<script data-bascik-server>const c: number = 3;</script>',
    ].join("\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(out).toBe(html);
    warn.mockRestore();
  });

  it("warns once per unmarked inline script that contains TypeScript syntax and does not change it", () => {
    const html = "<script>\nlet a: number = 1;\n</script>\n<script>\nconst ok = 1;\n</script>";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = transformTypeScriptScriptTags(html, "src/components/demo/demo.html");
    expect(out).toBe(html);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("src/components/demo/demo.html");
    expect(message).toContain('type="text/typescript"');
    expect(message).toMatch(/TypeScript/);
  });

  it("does not warn for ordinary inline JavaScript", () => {
    const html = "<script>\nconst a = b ? c : d;\nconst o = { k: 1 };\n</script>";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws with file context when a marked TypeScript script uses non-erasable syntax", () => {
    const html = '<script type="text/typescript">enum E { A }</script>';
    expect(() => transformTypeScriptScriptTags(html, "src/pages/index.html")).toThrow(/src\/pages\/index\.html/);
  });

  it("is safe against $-tokens in the script body", () => {
    const body = "const s = 'a$1$&$`$$'; let n: number = 1; console.log(s, n);";
    const out = transformTypeScriptScriptTags(`<script type="text/typescript">${body}</script>`, "p.html");
    expect(out).toContain("'a$1$&$`$$'");
    expect(out).not.toContain(": number");
  });
});
