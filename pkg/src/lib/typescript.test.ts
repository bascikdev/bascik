import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  isTypeScriptDirectiveScript,
  compileDirectiveTypeScript,
  checkDirectiveModuleSyntax,
  __moduleCheckStatsForTests,
  unbundledModuleImports,
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
  const source =
    "const el = document.getElementById('x') as HTMLElement;\nlet n: number = 0;";

  it("defaults to Node strip-only mode when the key is true or absent", async () => {
    const out = await transformBrowserTypeScript(source, {
      sourcePath: "src/components/x/x.ts",
      kind: "companion",
      runtime: "browser",
    });
    expect(out).not.toContain(": number");
    expect(out).not.toContain("as HTMLElement");
    (BascikConfig.scripts as { typescript?: unknown }).typescript = undefined;
    const outDefault = await transformBrowserTypeScript(source, {
      sourcePath: "src/components/x/x.ts",
      kind: "companion",
      runtime: "browser",
    });
    expect(outDefault).toBe(out);
  });

  it("returns the input untouched when scripts.typescript is false (user compiles elsewhere)", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = false;
    const out = await transformBrowserTypeScript(source, {
      sourcePath: "src/components/x/x.ts",
      kind: "companion",
      runtime: "browser",
    });
    expect(out).toBe(source);
  });

  it("delegates to a custom compiler function with source path and kind", async () => {
    const compiler = vi.fn(
      async (code: string) =>
        code.replace(/: number/g, "").replace(/ as HTMLElement/g, "") +
        "\n// compiled",
    );
    (BascikConfig.scripts as { typescript: unknown }).typescript = compiler;
    const out = await transformBrowserTypeScript(source, {
      sourcePath: "src/components/x/x.ts",
      kind: "companion",
      runtime: "browser",
    });
    expect(compiler).toHaveBeenCalledWith(source, {
      sourcePath: "src/components/x/x.ts",
      kind: "companion",
      runtime: "browser",
    });
    expect(out).toContain("// compiled");
    expect(out).not.toContain(": number");
  });

  it("accepts a synchronous custom compiler", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = (
      code: string,
    ) => code.replace(/: number/g, "").replace(/ as HTMLElement/g, "");
    const out = await transformBrowserTypeScript(source, {
      sourcePath: "x.ts",
      kind: "inline",
      runtime: "browser",
    });
    expect(out).not.toContain(": number");
  });

  it("fails with file context when a custom compiler throws", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = async () => {
      throw new Error("esbuild: Unexpected token");
    };
    await expect(
      transformBrowserTypeScript(source, {
        sourcePath: "src/components/x/x.ts",
        kind: "companion",
        runtime: "browser",
      }),
    ).rejects.toThrow(TypeScriptTransformError);
    await expect(
      transformBrowserTypeScript(source, {
        sourcePath: "src/components/x/x.ts",
        kind: "companion",
        runtime: "browser",
      }),
    ).rejects.toThrow(
      /src\/components\/x\/x\.ts[\s\S]*esbuild: Unexpected token/,
    );
  });

  it("fails with file context when a custom compiler returns non-JavaScript", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = async (
      code: string,
    ) => code; // leaves TS in place
    await expect(
      transformBrowserTypeScript(source, {
        sourcePath: "src/components/x/x.ts",
        kind: "companion",
        runtime: "browser",
      }),
    ).rejects.toThrow(
      /src\/components\/x\/x\.ts[\s\S]*did not return valid JavaScript/,
    );
  });

  it("fails when a custom compiler returns a non-string", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript =
      async () => ({ code: "x" });
    await expect(
      transformBrowserTypeScript(source, {
        sourcePath: "x.ts",
        kind: "companion",
        runtime: "browser",
      }),
    ).rejects.toThrow(/must return a string/);
  });

  it("does not run the parse check on module-shaped output (import/export are valid there)", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = async () =>
      "import { a } from './a.js';\nexport const b = a;";
    await expect(
      transformBrowserTypeScript(
        "import { a } from './a.ts';\nexport const b: number = a;",
        { sourcePath: "x.ts", kind: "companion", runtime: "browser" },
      ),
    ).resolves.toContain("export const b = a;");
  });
});

describe("scripts.typescript function output validation (F040)", () => {
  const accepted = [
    // esbuild with minify: true puts `export` mid-line.
    ["minified export default", "const a=1;export default()=>1;\n"],
    [
      "minified top-level await with export",
      "const t=await fetch(url),e=await t.text();export default()=>e;\n",
    ],
    [
      "top-level await with no import or export",
      'const res = await fetch("https://example.com");\nconsole.log(await res.text());\n',
    ],
    ["minified import", 'import{a}from"./a.js";console.log(a);'],
  ] as const;

  for (const runtime of ["server", "browser"] as const) {
    it.each(accepted)(
      `accepts valid module output (${runtime}): %s`,
      async (_label, output) => {
        (BascikConfig.scripts as { typescript: unknown }).typescript = () =>
          output;
        await expect(
          transformBrowserTypeScript("const x: number = 1;", {
            sourcePath: "src/pages/index.html",
            kind: "inline",
            runtime,
          }),
        ).resolves.toBe(output);
      },
    );
  }

  it.each([
    ["TypeScript left in place", "const a: number = await f();\n"],
    [
      "an export only inside a string",
      'const s = "\nexport default 1";\nconst a: number = 1;\n',
    ],
    ["an export only inside a comment", "// export default\nlet b: string;\n"],
  ])(
    "still rejects output that is not JavaScript: %s",
    async (_label, output) => {
      (BascikConfig.scripts as { typescript: unknown }).typescript = () =>
        output;
      await expect(
        transformBrowserTypeScript("const x: number = 1;", {
          sourcePath: "src/pages/index.html",
          kind: "inline",
          runtime: "server",
        }),
      ).rejects.toThrow(
        /src\/pages\/index\.html[\s\S]*did not return valid JavaScript/,
      );
    },
  );

  it("lets compileDirectiveTypeScript return top-level-await output from a function compiler", async () => {
    const output =
      "const r = await Promise.resolve(1);\nexport default () => String(r);\n";
    (BascikConfig.scripts as { typescript: unknown }).typescript = () =>
      output.replaceAll("\n", " ");
    await expect(
      compileDirectiveTypeScript(
        "const r: number = await Promise.resolve(1);\nexport default () => String(r);",
        "src/pages/index.html",
        "inline",
      ),
    ).resolves.toBe(output.replaceAll("\n", " "));
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
  it('matches type="text/typescript" in any quoting or casing', () => {
    expect(isTypeScriptScriptTag('<script type="text/typescript">')).toBe(true);
    expect(isTypeScriptScriptTag("<script type='text/typescript'>")).toBe(true);
    expect(isTypeScriptScriptTag("<script type=text/typescript>")).toBe(true);
    expect(isTypeScriptScriptTag('<script TYPE="Text/TypeScript" defer>')).toBe(
      true,
    );
    expect(TYPESCRIPT_SCRIPT_TYPE).toBe("text/typescript");
  });

  it("does not match ordinary or non-TypeScript script tags", () => {
    expect(isTypeScriptScriptTag("<script>")).toBe(false);
    expect(isTypeScriptScriptTag('<script type="module">')).toBe(false);
    expect(isTypeScriptScriptTag('<script type="application/ld+json">')).toBe(
      false,
    );
    expect(
      isTypeScriptScriptTag(
        '<script data-bascik-build type="text/typescript">',
      ),
    ).toBe(false);
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
    const src =
      "let a: number = 1;\n\nfunction f(x: string): boolean {\n  return !!x;\n}\n";
    expect(stripBrowserTypeScript(src).split("\n").length).toBe(
      src.split("\n").length,
    );
  });

  it("removes import type declarations", () => {
    const out = stripBrowserTypeScript(
      "import type { A } from './a.ts';\nconsole.log(1);",
    );
    expect(out).not.toContain("import type");
    expect(out).toContain("console.log(1);");
  });

  it("throws a descriptive error for non-erasable syntax (enum)", () => {
    expect(() =>
      stripBrowserTypeScript("enum E { A, B }", "src/components/x/x.ts"),
    ).toThrow(/src\/components\/x\/x\.ts[\s\S]*enum/i);
  });

  it("throws a descriptive error for invalid syntax", () => {
    expect(() =>
      stripBrowserTypeScript("const = ;", "src/components/x/x.ts"),
    ).toThrow(/src\/components\/x\/x\.ts/);
  });

  const message = (run: () => unknown): string => {
    try {
      run();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected a throw");
  };

  it("names the line and column of a syntax error, with a code frame, and no enum hint", () => {
    const code =
      "const items: string[] = [];\nconst bad = 1;\n\nexport default (): string => `<p>${bad} ${items.length) }</p>`;\n";
    const text = message(() =>
      stripBrowserTypeScript(code, "src/lib/build.ts"),
    );
    const column = code.split("\n")[3].indexOf(")", 50) + 1;
    expect(text).toContain(`src/lib/build.ts:4:${column}`);
    expect(text).toContain("Unexpected token");
    expect(text).toContain("4 | export default (): string =>");
    expect(text).toMatch(new RegExp(`\\n\\s+\\| {${column}}\\^`));
    expect(text).not.toMatch(/enum|scripts\.typescript/);
  });

  it("names the line of non-erasable syntax and keeps the scripts.typescript hint for it", () => {
    const text = message(() =>
      stripBrowserTypeScript(
        "const a: number = 1;\n\nenum X { A }\n",
        "src/lib/server.ts",
      ),
    );
    expect(text).toContain("src/lib/server.ts:3:1");
    expect(text).toContain("scripts.typescript");
  });

  it("puts a syntax error at the file position given by origin", () => {
    // The code starts at line 10, column 7 of the file; its line 2 is file line 11.
    const text = message(() =>
      stripBrowserTypeScript(
        "let x = 1;\nconst oops = (;\n",
        "src/pages/a.html",
        {
          origin: { line: 10, column: 7 },
        },
      ),
    );
    expect(text).toContain("src/pages/a.html:11:15");
    const first = message(() =>
      stripBrowserTypeScript("const oops = (;", "src/pages/a.html", {
        origin: { line: 10, column: 7 },
      }),
    );
    expect(first).toContain("src/pages/a.html:10:21");
  });

  it("names the line of an inline block's own code when the file position is unknown", () => {
    const text = message(() =>
      stripBrowserTypeScript(
        "let x = 1;\nconst oops = (;",
        "src/pages/a.html",
        {
          inline: true,
        },
      ),
    );
    expect(text).toContain("line 2, column 15 of the <script> block");
    expect(text).not.toContain("src/pages/a.html:2");
  });
});

describe("unbundledModuleImports", () => {
  it("lists relative, @/ and TypeScript specifiers, which a browser cannot load from an inlined module", () => {
    expect(
      unbundledModuleImports(
        [
          `import { a } from "./util.ts";`,
          `import b from "../b.js";`,
          `import c from "@/lib/c.js";`,
          `import d from "https://cdn.example.com/d.ts";`,
          `import e from "/js/e.js";`,
          `import f from "https://cdn.example.com/f.js";`,
          `const g = await import("./g.js");`,
          `export { h } from "./h.mts";`,
        ].join("\n"),
      ),
    ).toEqual([
      "./util.ts",
      "../b.js",
      "@/lib/c.js",
      "https://cdn.example.com/d.ts",
      "./g.js",
      "./h.mts",
    ]);
  });

  it("is empty for code with no imports or only published URLs", () => {
    expect(unbundledModuleImports("console.log(1);")).toEqual([]);
    expect(unbundledModuleImports(`import x from "/js/x.js";`)).toEqual([]);
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
    expect(
      looksLikeTypeScript(
        "const el = document.getElementById('x') as HTMLElement;",
      ),
    ).toBe(true);
    expect(looksLikeTypeScript("function f(a: string): void {}")).toBe(true);
    expect(looksLikeTypeScript("interface P { a: string }")).toBe(true);
    expect(looksLikeTypeScript("const y = z!;")).toBe(true);
  });

  it("returns true for module-shaped TypeScript wherever import/export sit", () => {
    expect(looksLikeTypeScript('const z: string = "x"; export {}')).toBe(true);
    expect(looksLikeTypeScript("const r: Response = await fetch(u);")).toBe(
      true,
    );
  });

  it("does not take `export` text inside a template for module syntax", () => {
    // Invalid in both languages; only the template's text looks like an export.
    expect(
      looksLikeTypeScript("const s = `\nexport {}`; const n: number = ;"),
    ).toBe(false);
  });

  it("returns false for module-shaped JavaScript", () => {
    expect(looksLikeTypeScript('const z = "x"; export {}')).toBe(false);
    expect(looksLikeTypeScript("const r = await fetch(u);")).toBe(false);
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
    expect(
      hasStaticModuleSyntax("import { a } from './a.js';\nconsole.log(a);"),
    ).toBe(true);
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
    expect(hasStaticModuleSyntax("const s = 'export const x = 1';")).toBe(
      false,
    );
    expect(hasStaticModuleSyntax("// export const x = 1;\nconst y = 1;")).toBe(
      false,
    );
    expect(hasStaticModuleSyntax("const re = /export/;")).toBe(false);
    // `import.meta` and a member/property named `import`/`export` are not declarations.
    expect(hasStaticModuleSyntax("console.log(import.meta.url);")).toBe(false);
    expect(hasStaticModuleSyntax("obj.export();")).toBe(false);
    expect(hasStaticModuleSyntax("const o = { export: 1 };")).toBe(false);
  });

  it("does not treat dynamic import() as static module syntax", () => {
    // Dynamic import() is a valid expression in a classic script; only the
    // static declaration forms are unsupported there.
    expect(hasStaticModuleSyntax("const m = await import('./a.js');")).toBe(
      false,
    );
  });
});

describe("transformTypeScriptScriptTags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips types from inline type="text/typescript" scripts and rewrites the type', async () => {
    const html =
      '<div></div><script type="text/typescript">\n  let n: number = 1;\n  console.log(n);\n</script>';
    const out = await transformTypeScriptScriptTags(
      html,
      "src/pages/index.html",
    );
    expect(out).not.toContain("text/typescript");
    expect(out).not.toContain(": number");
    expect(out).toContain("console.log(n);");
    expect(out).toMatch(/<script>\n\s*let n\s+= 1;/);
  });

  it("keeps other attributes and orders them without the type attribute", async () => {
    const html =
      '<script defer type="text/typescript" data-foo="1">let a: string = "";</script>';
    const out = await transformTypeScriptScriptTags(
      html,
      "src/pages/index.html",
    );
    expect(out).toMatch(/<script defer data-foo="1">/);
    expect(out).not.toContain(": string");
  });

  it.each([
    [
      '<script data-x="a type=b" type="text/typescript">const a: number = 1;</script>',
      '<script data-x="a type=b">const a         = 1;</script>',
    ],
    [
      "<script data-x='a type=b' type=\"text/typescript\">const a: number = 1;</script>",
      "<script data-x='a type=b'>const a         = 1;</script>",
    ],
    [
      '<script\n  data-x="a\n  type=b"\n  type="text/typescript"\n  defer\n>const a: number = 1;</script>',
      '<script data-x="a\n  type=b"\n  defer\n>const a         = 1;</script>',
    ],
    [
      '<script type="text/typescript" data-x="a type=b">const a: number = 1;</script>',
      '<script data-x="a type=b">const a         = 1;</script>',
    ],
    [
      "<script type=text/typescript defer>const a: number = 1;</script>",
      "<script defer>const a         = 1;</script>",
    ],
  ])(
    "removes the real type attribute, not ` type=` text in another value (F044): %j",
    async (html, expected) => {
      expect(
        await transformTypeScriptScriptTags(html, "src/pages/index.html"),
      ).toBe(expected);
    },
  );

  it("does not strip data-type or treat data-src as external when transforming TypeScript scripts", async () => {
    const html =
      '<!-- <script type="text/typescript">enum Broken { A }</script> -->' +
      '<textarea><script type="text/typescript">enum Broken { A }</script></textarea>' +
      '<script data-type="custom" data-src="/lazy.js" type="text/typescript">let a: number = 1;</script>';
    const out = await transformTypeScriptScriptTags(
      html,
      "src/pages/index.html",
    );
    expect(out).toContain(
      '<script data-type="custom" data-src="/lazy.js">let a         = 1;</script>',
    );
    expect(out).toContain(
      '<!-- <script type="text/typescript">enum Broken { A }</script> -->',
    );
    expect(out).toContain(
      '<textarea><script type="text/typescript">enum Broken { A }</script></textarea>',
    );
  });

  it("compiles the original body when a TypeScript script contains HTML comment markers", async () => {
    const html =
      '<script type="text/typescript">const note: string = "<!-- note -->";</script>';
    const out = await transformTypeScriptScriptTags(
      html,
      "src/pages/index.html",
    );
    expect(out).toContain('const note         = "<!-- note -->";');
  });

  it("does not let a comment-like string hide later TypeScript scripts", async () => {
    const html =
      '<script type="text/typescript">const marker: string = "<!--";</script>' +
      '<script type="text/typescript">let after: number = 1;</script>';
    const out = await transformTypeScriptScriptTags(
      html,
      "src/pages/index.html",
    );
    expect(out).toContain('const marker         = "<!--";');
    expect(out).toContain("let after         = 1;");
  });

  it("does not transform script-like text in a plaintext element", async () => {
    const html =
      '<plaintext><script type="text/typescript">enum NotAScript { A }</script>';
    expect(
      await transformTypeScriptScriptTags(html, "src/pages/index.html"),
    ).toBe(html);
  });

  it("leaves ordinary inline scripts, module scripts, external scripts, JSON, and directive scripts untouched", async () => {
    const html = [
      "<script>let a: number = 1;</script>",
      '<script type="module">let b: number = 2;</script>',
      '<script src="x.ts"></script>',
      '<script type="application/ld+json">{"a": 1}</script>',
      '<script data-bascik-build type="text/typescript">console.log(1)</script>',
      "<script data-bascik-server>const c: number = 3;</script>",
    ].join("\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await transformTypeScriptScriptTags(
      html,
      "src/pages/index.html",
    );
    expect(out).toBe(html);
    warn.mockRestore();
  });

  it("warns once per unmarked inline script that contains TypeScript syntax and does not change it", async () => {
    const html =
      "<script>\nlet a: number = 1;\n</script>\n<script>\nconst ok = 1;\n</script>";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await transformTypeScriptScriptTags(
      html,
      "src/components/demo/demo.html",
    );
    expect(out).toBe(html);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("src/components/demo/demo.html");
    expect(message).toContain('type="text/typescript"');
    expect(message).toMatch(/TypeScript/);
  });

  it.each([
    '<script type="module">const z: string = "x";</script>',
    '<script type="module">const z: string = "x"; export {}</script>',
    '<script type="module">\nimport { a } from "/js/a.js";\nconst n: number = a;\n</script>',
    '<script type="module">const r: Response = await fetch("/x");</script>',
    '<script type="application/javascript">let a: number = 1;</script>',
    '<script type="text/ecmascript">let a: number = 1;</script>',
  ])(
    "warns for TypeScript in any JavaScript script type (F045): %s",
    async (html) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const out = await transformTypeScriptScriptTags(
        html,
        "src/pages/index.html",
      );
      expect(out).toBe(html);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain("src/pages/index.html");
      if (html.includes('type="module"')) {
        // A text/typescript block is a classic script, so a module goes to a companion.
        expect(message).toContain('<script type="module" src="name.ts">');
        expect(message).not.toContain(
          'Mark it <script type="text/typescript">',
        );
      }
      warn.mockRestore();
    },
  );

  it.each([
    '<script type="module">import { a } from "/js/a.js";\nexport const b = a < 2 ? "x" : "y";</script>',
    '<script type="module">const r = await fetch("/x"); export default r;</script>',
    '<script type="application/ld+json">{"a": 1}</script>',
    '<script type="text/template"><p>{{ a: b }}</p></script>',
  ])(
    "does not warn for valid JavaScript or non-JavaScript types: %s",
    async (html) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await transformTypeScriptScriptTags(html, "src/pages/index.html");
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it("does not warn for ordinary inline JavaScript", async () => {
    const html =
      "<script>\nconst a = b ? c : d;\nconst o = { k: 1 };\n</script>";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await transformTypeScriptScriptTags(html, "src/pages/index.html");
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws with file context when a marked TypeScript script uses non-erasable syntax", async () => {
    const html = '<script type="text/typescript">enum E { A }</script>';
    await expect(
      transformTypeScriptScriptTags(html, "src/pages/index.html"),
    ).rejects.toThrow(/src\/pages\/index\.html/);
  });

  it("throws an actionable diagnostic when a text/typescript block contains import/export, since it always becomes a classic script", async () => {
    const html =
      '<script type="text/typescript">import { helper } from "./helper.ts";\nhelper();</script>';
    await expect(
      transformTypeScriptScriptTags(html, "src/components/widget/widget.html"),
    ).rejects.toThrow(TypeScriptTransformError);
    await expect(
      transformTypeScriptScriptTags(html, "src/components/widget/widget.html"),
    ).rejects.toThrow(
      /src\/components\/widget\/widget\.html[\s\S]*import\/export/i,
    );
  });

  it("throws for a bare export declaration in a text/typescript block", async () => {
    const html =
      '<script type="text/typescript">export const n: number = 1;</script>';
    await expect(
      transformTypeScriptScriptTags(html, "src/pages/index.html"),
    ).rejects.toThrow(TypeScriptTransformError);
  });

  it("is safe against $-tokens in the script body", async () => {
    const body = "const s = 'a$1$&$`$$'; let n: number = 1; console.log(s, n);";
    const out = await transformTypeScriptScriptTags(
      `<script type="text/typescript">${body}</script>`,
      "p.html",
    );
    expect(out).toContain("'a$1$&$`$$'");
    expect(out).not.toContain(": number");
  });

  it("leaves marked TypeScript blocks untouched, including the type attribute, when scripts.typescript is false", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = false;
    const html =
      '<script type="text/typescript">let n: number = 1;</script>\n<script>let m: number = 2;</script>';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await transformTypeScriptScriptTags(
      html,
      "src/pages/index.html",
    );
    expect(out).toBe(html);
    // The unmarked-script diagnostic is independent of compiler selection.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("routes marked inline blocks through a custom compiler with kind 'inline'", async () => {
    const compiler = vi.fn(async (code: string) =>
      code.replace(/: number/g, ""),
    );
    (BascikConfig.scripts as { typescript: unknown }).typescript = compiler;
    const out = await transformTypeScriptScriptTags(
      '<script type="text/typescript">let n: number = 1;</script>',
      "src/components/demo/demo.html",
    );
    expect(compiler).toHaveBeenCalledWith("let n: number = 1;", {
      sourcePath: "src/components/demo/demo.html",
      kind: "inline",
      runtime: "browser",
    });
    expect(out).toBe("<script>let n = 1;</script>");
  });
});

describe("directive scripts written in TypeScript", () => {
  it.each([
    ['<script data-bascik-build type="text/typescript">', undefined, true],
    ['<script data-bascik-server type="TEXT/TypeScript">', undefined, true],
    ["<script data-bascik-build>", "./build.ts", true],
    ["<script data-bascik-routes>", "@/lib/routes.mts?v=1", true],
    ["<script data-bascik-stream>", "./stream.js", false],
    ["<script data-bascik-build>", undefined, false],
    ['<script data-bascik-build type="module">', "./x.tsx", false],
  ])("%s src=%s is TypeScript: %s", (openTag, src, expected) => {
    expect(isTypeScriptDirectiveScript(openTag, src)).toBe(expected);
  });

  it("strips types and keeps every line and column", async () => {
    const code =
      "\n\n  const n: number = 1;\n  export default (): number => n;\n";
    const out = await compileDirectiveTypeScript(
      code,
      "src/pages/a.html",
      "inline",
    );
    expect(out.split("\n").length).toBe(code.split("\n").length);
    expect(out.indexOf("const n")).toBe(code.indexOf("const n"));
    expect(out.indexOf("export default")).toBe(code.indexOf("export default"));
    expect(out).not.toMatch(/: number/);
  });

  it("still strips with scripts.typescript: false, since nothing else compiles a directive script", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = false;
    await expect(
      compileDirectiveTypeScript(
        "export default (): string => 'x';",
        "a.ts",
        "companion",
      ),
    ).resolves.not.toContain(": string");
  });

  it("calls a scripts.typescript function with runtime: server, keeping export", async () => {
    const compiler = vi.fn((code: string) => code.replace(": string", ""));
    (BascikConfig.scripts as { typescript: unknown }).typescript = compiler;
    const out = await compileDirectiveTypeScript(
      "export default (): string => 'x';",
      "src/lib/a.ts",
      "companion",
    );
    expect(compiler).toHaveBeenCalledWith("export default (): string => 'x';", {
      sourcePath: "src/lib/a.ts",
      kind: "companion",
      runtime: "server",
    });
    expect(out).toBe("export default () => 'x';");
  });

  it("names where an inline block's enum is when the strip refuses it, and how to compile it", async () => {
    const failure = compileDirectiveTypeScript(
      "enum A { B }\nexport default () => A.B;",
      "src/pages/a.html",
      "inline",
      { line: 12, column: 5 },
      { line: 13, column: 7 },
    );
    await expect(failure).rejects.toThrow(TypeScriptTransformError);
    await expect(failure).rejects.toThrow(/src\/pages\/a\.html:13:7/);
    await expect(failure).rejects.toThrow(/scripts\.typescript/);
  });

  it("names the exact file line of a syntax error in an inline block from its origin, not only where the tag starts", async () => {
    const failure = compileDirectiveTypeScript(
      "const n: number = 1;\nconst oops = (;\nexport default () => n;",
      "src/pages/a.html",
      "inline",
      { line: 12, column: 5 },
      { line: 13, column: 1 },
    );
    await expect(failure).rejects.toThrow(/src\/pages\/a\.html:14:15/);
    await expect(failure).rejects.not.toThrow(/starts at|scripts\.typescript/);
  });

  it("still names where the tag starts when a scripts.typescript function fails without a position", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = () => {
      throw new Error("compiler broke");
    };
    await expect(
      compileDirectiveTypeScript(
        "export default () => 1;",
        "src/pages/a.html",
        "inline",
        { line: 12, column: 5 },
      ),
    ).rejects.toThrow(/compiler broke[\s\S]*src\/pages\/a\.html:12:5/);
  });
});

describe("checkDirectiveModuleSyntax: compiled output that is not a valid ES module", () => {
  it("accepts a module with imports, exports and top-level await", async () => {
    await expect(
      checkDirectiveModuleSyntax(
        'import { x } from "./missing.ts";\nconst y = await Promise.resolve(x);\nexport default () => String(y);\n',
        "src/lib/ok.ts",
      ),
    ).resolves.toBeUndefined();
  });

  it("parses valid modules in one shared checker, without a process per script", async () => {
    const before = __moduleCheckStatsForTests.processes;
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        expect(
          checkDirectiveModuleSyntax(
            `import { x } from "./m${i}.ts";\nexport const v${i} = await x;\n`,
            `src/lib/many-${i}.ts`,
          ),
        ).resolves.toBeUndefined(),
      ),
    );
    expect(__moduleCheckStatsForTests.processes - before).toBe(0);
  });

  it("still names the place of an error, and still checks when the shared checker is unavailable", async () => {
    const failure = checkDirectiveModuleSyntax(
      "let q = 1;\nlet q = 2;\nexport default q;\n",
      "src/lib/q.ts",
    );
    await expect(failure).rejects.toThrow(
      /src\/lib\/q\.ts:2:5: Identifier 'q'/,
    );
    __moduleCheckStatsForTests.disableChecker = true;
    try {
      await expect(
        checkDirectiveModuleSyntax(
          "let w = 1;\nlet w = 2;\nexport default w;\n",
          "src/lib/w.ts",
        ),
      ).rejects.toThrow(/src\/lib\/w\.ts:2:5: Identifier 'w'/);
      await expect(
        checkDirectiveModuleSyntax("export default 1;\n// w\n", "src/lib/w.ts"),
      ).resolves.toBeUndefined();
    } finally {
      __moduleCheckStatsForTests.disableChecker = false;
    }
  });

  it("never runs the module it checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bascik-module-check-"));
    const marker = join(dir, "ran");
    try {
      await expect(
        checkDirectiveModuleSyntax(
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport default () => "";\n`,
          "src/lib/side-effect.ts",
        ),
      ).resolves.toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the file line and column of an early error the strip lets through, with a frame and no compiler hint", async () => {
    const code = await compileDirectiveTypeScript(
      "const a: number = 1;\nconst a = 2;\nexport default () => String(a);\n",
      "src/lib/dupe.ts",
      "companion",
    );
    const failure = checkDirectiveModuleSyntax(code, "src/lib/dupe.ts");
    await expect(failure).rejects.toBeInstanceOf(TypeScriptTransformError);
    await expect(failure).rejects.toThrow(
      /\[bascik\] Syntax error in "src\/lib\/dupe\.ts" at src\/lib\/dupe\.ts:2:7: Identifier 'a' has already been declared\n {2}2 \| const a = 2;\n {4}\| {7}\^/,
    );
    await expect(failure).rejects.not.toThrow(/scripts\.typescript/);
  });

  it("counts from the block's origin in the page for an inline block", async () => {
    await expect(
      checkDirectiveModuleSyntax(
        "let n = 1;\nlet n = 2;\nexport default () => String(n);",
        "src/pages/index.html",
        { line: 12, column: 5 },
      ),
    ).rejects.toThrow(/src\/pages\/index\.html:13:5: Identifier 'n'/);
  });

  it("names the line within the block when the block's place is unknown", async () => {
    await expect(
      checkDirectiveModuleSyntax(
        "let n = 1;\nlet n = 2;\nexport default () => String(n);",
        "src/pages/index.html",
        "unknown",
      ),
    ).rejects.toThrow(/at line 2, column 5 of the <script> block/);
  });

  it("names the scripts.typescript output when a compiler function produced it", async () => {
    (BascikConfig.scripts as { typescript: unknown }).typescript = () =>
      "let n = 1;\nlet n = 2;\nexport default () => String(n);";
    await expect(
      checkDirectiveModuleSyntax(
        "let n = 1;\nlet n = 2;\nexport default () => String(n);",
        "src/pages/index.html",
        { line: 3, column: 1 },
      ),
    ).rejects.toThrow(
      /Syntax error in the scripts\.typescript output for "src\/pages\/index\.html" at line 2, column 5 of that output: Identifier 'n'/,
    );
  });
});
