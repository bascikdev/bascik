/**
 * Pipeline-level regression tests for browser TypeScript handling and the
 * `//# sourceURL` boundary (prompt 148).
 *
 * Order under test: TypeScript strip -> scoping (IIFE + sourceURL) ->
 * optional JS minification -> sourceURL re-attached on its own line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { transform } from "esbuild";
import { BascikConfig } from "./config.ts";
import { transpilePage } from "./processing.ts";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(async () => { }),
  mkdir: vi.fn(async () => { }),
}));

vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => true),
  BascikConfig: {
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    },
    isBuild: true,
    minify: { html: false, css: false, js: false, identifiers: false },
    assets: { inlineStyles: false, exclude: [] },
    directory: { pages: "src/pages", components: ["src/components"], out: "dist" },
    scripts: { typescript: true },
  },
}));

/** Every inline script body in the emitted HTML must parse as JavaScript. */
const assertAllInlineScriptsParse = (html: string): string[] => {
  const bodies: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    if (/\btype\s*=/.test(m[1]) && !/text\/javascript|module/i.test(m[1])) continue;
    bodies.push(m[2]);
    expect(() => new Function(m[2]), m[2]).not.toThrow();
  }
  return bodies;
};

const componentList = {
  "ts-widget": {
    fileName: "src/components/ts-widget/ts-widget.html",
    // What listComponents produces for `<script src="ts-widget.ts">` after
    // the TypeScript pass: plain JavaScript tagged with its source path.
    fileContent:
      '<span id="out">0</span>\n' +
      '<script data-bascik-source="src/components/ts-widget/ts-widget.ts">\n' +
      "const out = document.getElementById('out');\n" +
      "let n = 0;\n" +
      "out.textContent = String(++n);\n" +
      "</script>",
  },
};

describe("browser TypeScript pipeline", () => {
  beforeEach(() => {
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).minify = { html: false, css: false, js: false, identifiers: false };
    (BascikConfig as any).onMinifyError = "error";
    (BascikConfig as any).scripts = { typescript: true };
  });

  it("compiles a page-level marked block with esbuild via scripts.typescript, downleveling and handling enum", async () => {
    (BascikConfig as any).scripts.typescript = async (code: string, { sourcePath }: { sourcePath: string }) =>
      (await transform(code, { loader: "ts", target: "es2017", sourcefile: sourcePath })).code;
    (BascikConfig as any).minify = { html: true, css: true, js: true, identifiers: false };
    vi.mocked(readFile).mockResolvedValue(`<!DOCTYPE html><html><head></head><body>
      <p>hi</p>
      <script type="text/typescript">
        enum Mode { Fast, Slow }
        const pick = (m: Mode): string => m === Mode.Fast ? 'fast' : 'slow';
        const v = document.querySelector('p')?.textContent ?? pick(Mode.Fast);
        console.log(v);
      </script>
    </body></html>`);

    const result = await transpilePage("src/pages/index.html", {});
    const html = result!.distHtml;

    expect(html).not.toContain("text/typescript");
    expect(html).not.toContain("enum Mode");
    expect(html).not.toContain("?."); // downleveled by target es2017
    expect(html).not.toContain("??");
    expect(html).toContain("console.log(");
    assertAllInlineScriptsParse(html);
  });

  it("ships a marked block untouched when scripts.typescript is false", async () => {
    (BascikConfig as any).scripts.typescript = false;
    vi.mocked(readFile).mockResolvedValue(`<!DOCTYPE html><html><head></head><body>
      <script type="text/typescript">let n: number = 1;</script>
    </body></html>`);

    const result = await transpilePage("src/pages/index.html", {});
    expect(result!.distHtml).toContain('<script type="text/typescript">let n: number = 1;</script>');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips a page-level <script type=\"text/typescript\"> and leaves an ordinary inline script on the JavaScript path", async () => {
    vi.mocked(readFile).mockResolvedValue(`<!DOCTYPE html><html><head></head><body>
      <p>hi</p>
      <script type="text/typescript">
        const el = document.querySelector('p') as HTMLParagraphElement;
        let n: number = 1;
        el.textContent = String(n);
      </script>
      <script>
        const plain = { a: 1 };
        console.log(plain.a < 2 ? 'x' : 'y');
      </script>
    </body></html>`);

    const result = await transpilePage("src/pages/index.html", {});
    const html = result!.distHtml;

    expect(html).not.toContain("text/typescript");
    expect(html).not.toContain("as HTMLParagraphElement");
    expect(html).not.toContain(": number");
    expect(html).toContain("const plain = { a: 1 };");
    assertAllInlineScriptsParse(html);
  });

  it("warns about TypeScript syntax in an unmarked ordinary inline script and does not rewrite it", async () => {
    vi.mocked(readFile).mockResolvedValue(`<!DOCTYPE html><html><head></head><body>
      <script>
        let n: number = 1;
        console.log(n);
      </script>
    </body></html>`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await transpilePage("src/pages/index.html", {});
    const html = result!.distHtml;

    expect(html).toContain("let n: number = 1;");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/TypeScript[\s\S]*src\/pages\/index\.html[\s\S]*text\/typescript/));
  });

  it("emits a stripped .ts companion as a scoped IIFE followed by sourceURL on its own line (no minifier)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      "<!DOCTYPE html><html><head></head><body><ts-widget></ts-widget></body></html>",
    );

    const result = await transpilePage("src/pages/index.html", componentList);
    const html = result!.distHtml;

    expect(html).toContain("(function() {");
    expect(html).toMatch(/\}\)\(\);\n\/\/# sourceURL=src\/components\/ts-widget\/ts-widget\.ts/);
    expect(html).not.toContain("})(); //# sourceURL");
    assertAllInlineScriptsParse(html);
  });

  it.each([
    ["built-in minify.js: true", true],
    ["stripTypeScriptTypes as minify.js", (code: string) => stripTypeScriptTypes(code)],
    ["esbuild as minify.js", async (code: string) => (await transform(code, { loader: "js", minify: true })).code],
  ])("keeps sourceURL on its own line after the final IIFE with %s and HTML minification", async (_label, js) => {
    (BascikConfig as any).minify = { html: true, css: true, js, identifiers: false };
    vi.mocked(readFile).mockResolvedValue(
      "<!DOCTYPE html><html><head><ts-widget></ts-widget></head><body><ts-widget></ts-widget></body></html>",
    );

    const result = await transpilePage("src/pages/index.html", componentList);
    const html = result!.distHtml;

    const directives = [...html.matchAll(/\/\/# sourceURL=src\/components\/ts-widget\/ts-widget\.ts/g)];
    expect(directives.length).toBe(2);
    expect(html).not.toContain("})(); //# sourceURL");
    // Same-line glue in any spacing variant is a parse-breaking bug.
    expect(html).not.toMatch(/\)[ \t]*;?[ \t]*\/\/# sourceURL/);
    // Every directive sits at the start of its own line and is the last thing before </script>.
    expect(html).toMatch(/\n\/\/# sourceURL=src\/components\/ts-widget\/ts-widget\.ts<\/script>/);
    expect(html).not.toContain("String(++n) //#");
    const bodies = assertAllInlineScriptsParse(html);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      // sourceURL never appears mid-body, only as the final line.
      const idx = body.indexOf("//# sourceURL");
      if (idx !== -1) expect(body.slice(idx)).not.toContain("\n");
    }
  });

  it("runs the TypeScript strip before the built-in minifier receives the code", async () => {
    (BascikConfig as any).minify = { html: false, css: false, js: true, identifiers: false };
    vi.mocked(readFile).mockResolvedValue(`<!DOCTYPE html><html><head></head><body>
      <script type="text/typescript">
        // comment to be minified away
        let counter: number = 0;
        function bump(by: number): number { return counter += by; }
        console.log(bump(1));
      </script>
    </body></html>`);

    const result = await transpilePage("src/pages/index.html", {});
    const html = result!.distHtml;

    expect(html).not.toContain(": number");
    expect(html).not.toContain("comment to be minified");
    expect(html).toContain("console.log(bump(1))");
    assertAllInlineScriptsParse(html);
  });

  it("does not emit a sourceURL line when the minified body is empty", async () => {
    (BascikConfig as any).minify = { html: false, css: false, js: true, identifiers: false };
    vi.mocked(readFile).mockResolvedValue(
      "<!DOCTYPE html><html><head></head><body><empty-comp></empty-comp></body></html>",
    );
    const result = await transpilePage("src/pages/index.html", {
      "empty-comp": {
        fileName: "src/components/empty-comp.html",
        fileContent: "<div></div><script>\n// only a comment\n</script>",
      },
    });
    const html = result!.distHtml;
    // The built-in minifier collapses the IIFE to `(function(){})();` and the
    // directive must still be separated by a newline, never glued or lost.
    expect(html).not.toContain("})(); //# sourceURL");
    assertAllInlineScriptsParse(html);
  });

  it("runs the same TypeScript pass in dev mode (isBuild false)", async () => {
    (BascikConfig as any).isBuild = false;
    vi.mocked(readFile).mockResolvedValue(`<!DOCTYPE html><html><head></head><body>
      <script type="text/typescript">let x: number = 1; console.log(x);</script>
    </body></html>`);

    const result = await transpilePage("src/pages/index.html", {});
    const html = result!.distHtml;
    expect(html).not.toContain(": number");
    expect(html).not.toContain("text/typescript");
    assertAllInlineScriptsParse(html);
  });
});
