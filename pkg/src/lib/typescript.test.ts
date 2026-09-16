import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { BascikConfig } from "./config.ts";
import {
  isTypeScriptScriptTag,
  isTypeScriptFile,
  stripBrowserTypeScript,
  transformTypeScriptScriptTags,
  transformBrowserTypeScript,
  looksLikeTypeScript,
  hasStaticModuleSyntax,
  TYPESCRIPT_SCRIPT_TYPE,
  TypeScriptTransformError,
} from "./typescript.ts";

vi.mock("./config.js", () => ({
  BascikConfig: {
    scripts: { typescript: true },
  },
}));

beforeEach(() => {
  (BascikConfig.scripts as { typescript: unknown }).typescript = true;
});

describe("scripts.typescript compiler selection (transformBrowserTypeScript)", () => {
  const source = "const el = document.getElementById('x') as HTMLElement;\nlet n: number = 0;";

  it("defaults to Node strip-only mode when the key is true or absent", async () => {
    const out = await transformBrowserTypeScript(source, { sourcePath: "src/components/x/x.ts", kind: "companion" });
    expect(out).not.toContain(": number");
    expect(out).not.toContain("as HTMLElement");
    (BascikConfig.scripts as { typescript?: unknown }).typescript = undefined;
    const outDefault = await transformBrowserTypeScript(source, { sourcePath: "src/components/x/x.ts", kind: "companion" });
    expect(outDefault).toBe(out);
  });

  it("returns the input untouched when scripts.typescript is false (user compiles elsewhere)", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = false;
    const out = await transformBrowserTypeScript(source, { sourcePath: "src/components/x/x.ts", kind: "companion" });
    expect(out).toBe(source);
  });

  it("delegates to a custom compiler function with source path and kind", async () => {
    const compiler = vi.fn(async (code: string) => code.replace(/: number/g, "").replace(/ as HTMLElement/g, "") + "\n// compiled");
    (BascikConfig.scripts as { typescript: unknown }).typescript = compiler;
    const out = await transformBrowserTypeScript(source, { sourcePath: "src/components/x/x.ts", kind: "companion" });
    expect(compiler).toHaveBeenCalledWith(source, { sourcePath: "src/components/x/x.ts", kind: "companion" });
    expect(out).toContain("// compiled");
    expect(out).not.toContain(": number");
  });

  it("accepts a synchronous custom compiler", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = (code: string) => code.replace(/: number/g, "").replace(/ as HTMLElement/g, "");
    const out = await transformBrowserTypeScript(source, { sourcePath: "x.ts", kind: "inline" });
    expect(out).not.toContain(": number");
  });

  it("fails with file context when a custom compiler throws", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = async () => {
      throw new Error("esbuild: Unexpected token");
    };
    await expect(
      transformBrowserTypeScript(source, { sourcePath: "src/components/x/x.ts", kind: "companion" }),
    ).rejects.toThrow(TypeScriptTransformError);
    await expect(
      transformBrowserTypeScript(source, { sourcePath: "src/components/x/x.ts", kind: "companion" }),
    ).rejects.toThrow(/src\/components\/x\/x\.ts[\s\S]*esbuild: Unexpected token/);
  });

  it("fails with file context when a custom compiler returns non-JavaScript", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = async (code: string) => code; // leaves TS in place
    await expect(
      transformBrowserTypeScript(source, { sourcePath: "src/components/x/x.ts", kind: "companion" }),
    ).rejects.toThrow(/src\/components\/x\/x\.ts[\s\S]*did not return valid JavaScript/);
  });

  it("fails when a custom compiler returns a non-string", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = async () => ({ code: "x" });
    await expect(
      transformBrowserTypeScript(source, { sourcePath: "x.ts", kind: "companion" }),
    ).rejects.toThrow(/must return a string/);
  });

  it("does not run the parse check on module-shaped output (import/export are valid there)", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = async () => "import { a } from './a.js';\nexport const b = a;";
    await expect(
      transformBrowserTypeScript("import { a } from './a.ts';\nexport const b: number = a;", { sourcePath: "x.ts", kind: "companion" }),
    ).resolves.toContain("export const b = a;");
  });
});

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

describe("hasStaticModuleSyntax", () => {
  it("detects top-level import declarations", () => {
    expect(hasStaticModuleSyntax("import { a } from './a.js';\nconsole.log(a);")).toBe(true);
    expect(hasStaticModuleSyntax("import * as ns from './a.js';")).toBe(true);
    expect(hasStaticModuleSyntax("import def from './a.js';")).toBe(true);
    expect(hasStaticModuleSyntax("import './side-effect.js';")).toBe(true);
  });

  it("detects export declarations of every shape", () => {
    expect(hasStaticModuleSyntax("export const x = 1;")).toBe(true);
    expect(hasStaticModuleSyntax("export function f() {}")).toBe(true);
    expect(hasStaticModuleSyntax("export default 1;")).toBe(true);
    expect(hasStaticModuleSyntax("const x = 1;\nexport { x };")).toBe(true);
  });

  it("returns false for ordinary classic script code, including tricky lookalikes", () => {
    expect(hasStaticModuleSyntax("const a = 1; console.log(a);")).toBe(false);
    expect(hasStaticModuleSyntax("")).toBe(false);
    // `import`/`export` inside a string, comment, or regex literal are not syntax.
    expect(hasStaticModuleSyntax("const s = 'export const x = 1';")).toBe(false);
    expect(hasStaticModuleSyntax("// export const x = 1;\nconst y = 1;")).toBe(false);
    expect(hasStaticModuleSyntax("const re = /export/;")).toBe(false);
    // `import.meta` and a member/property named `import`/`export` are not declarations.
    expect(hasStaticModuleSyntax("console.log(import.meta.url);")).toBe(false);
    expect(hasStaticModuleSyntax("obj.export();")).toBe(false);
    expect(hasStaticModuleSyntax("const o = { export: 1 };")).toBe(false);
  });

  it("does not treat dynamic import() as static module syntax", () => {
    // Dynamic import() is a valid expression in a classic script; only the
    // static declaration forms are unsupported there.
    expect(hasStaticModuleSyntax("const m = await import('./a.js');")).toBe(false);
  });
});

describe("transformTypeScriptScriptTags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips types from inline type=\"text/typescript\" scripts and rewrites the type", async () => {
    const html = '<div></div><script type="text/typescript">\n  let n: number = 1;\n  console.log(n);\n</script>';
    const out = await transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(out).not.toContain("text/typescript");
    expect(out).not.toContain(": number");
    expect(out).toContain("console.log(n);");
    expect(out).toMatch(/<script>\n\s*let n\s+= 1;/);
  });

  it("keeps other attributes and orders them without the type attribute", async () => {
    const html = '<script defer type="text/typescript" data-foo="1">let a: string = "";</script>';
    const out = await transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(out).toMatch(/<script defer data-foo="1">/);
    expect(out).not.toContain(": string");
  });

  it("leaves ordinary inline scripts, module scripts, external scripts, JSON, and directive scripts untouched", async () => {
    const html = [
      "<script>let a: number = 1;</script>",
      '<script type="module">let b: number = 2;</script>',
      '<script src="x.ts"></script>',
      '<script type="application/ld+json">{"a": 1}</script>',
      '<script data-bascik-build type="text/typescript">console.log(1)</script>',
      '<script data-bascik-server>const c: number = 3;</script>',
    ].join("\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(out).toBe(html);
    warn.mockRestore();
  });

  it("warns once per unmarked inline script that contains TypeScript syntax and does not change it", async () => {
    const html = "<script>\nlet a: number = 1;\n</script>\n<script>\nconst ok = 1;\n</script>";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await transformTypeScriptScriptTags(html, "src/components/demo/demo.html");
    expect(out).toBe(html);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("src/components/demo/demo.html");
    expect(message).toContain('type="text/typescript"');
    expect(message).toMatch(/TypeScript/);
  });

  it("does not warn for ordinary inline JavaScript", async () => {
    const html = "<script>\nconst a = b ? c : d;\nconst o = { k: 1 };\n</script>";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws with file context when a marked TypeScript script uses non-erasable syntax", async () => {
    const html = '<script type="text/typescript">enum E { A }</script>';
    await expect(transformTypeScriptScriptTags(html, "src/pages/index.html")).rejects.toThrow(/src\/pages\/index\.html/);
  });

  it("throws an actionable diagnostic when a text/typescript block contains import/export, since it always becomes a classic script", async () => {
    const html = '<script type="text/typescript">import { helper } from "./helper.ts";\nhelper();</script>';
    await expect(transformTypeScriptScriptTags(html, "src/components/widget/widget.html")).rejects.toThrow(
      TypeScriptTransformError,
    );
    await expect(transformTypeScriptScriptTags(html, "src/components/widget/widget.html")).rejects.toThrow(
      /src\/components\/widget\/widget\.html[\s\S]*import\/export/i,
    );
  });

  it("throws for a bare export declaration in a text/typescript block", async () => {
    const html = '<script type="text/typescript">export const n: number = 1;</script>';
    await expect(transformTypeScriptScriptTags(html, "src/pages/index.html")).rejects.toThrow(TypeScriptTransformError);
  });

  it("is safe against $-tokens in the script body", async () => {
    const body = "const s = 'a$1$&$`$$'; let n: number = 1; console.log(s, n);";
    const out = await transformTypeScriptScriptTags(`<script type="text/typescript">${body}</script>`, "p.html");
    expect(out).toContain("'a$1$&$`$$'");
    expect(out).not.toContain(": number");
  });

  it("leaves marked TypeScript blocks untouched, including the type attribute, when scripts.typescript is false", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = false;
    const html = '<script type="text/typescript">let n: number = 1;</script>\n<script>let m: number = 2;</script>';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(out).toBe(html);
    // The unmarked-script diagnostic is independent of compiler selection.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("routes marked inline blocks through a custom compiler with kind 'inline'", async () => {
    const compiler = vi.fn(async (code: string) => code.replace(/: number/g, ""));
    (BascikConfig.scripts as { typescript: unknown }).typescript = compiler;
    const out = await transformTypeScriptScriptTags(
      '<script type="text/typescript">let n: number = 1;</script>',
      "src/components/demo/demo.html",
    );
    expect(compiler).toHaveBeenCalledWith("let n: number = 1;", { sourcePath: "src/components/demo/demo.html", kind: "inline" });
    expect(out).toBe("<script>let n = 1;</script>");
  });
});
