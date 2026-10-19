/**
 * DevTools line numbers for component scripts: line N of a component script's
 * sourceURL file is line N of the component's source, and each instance on a
 * page has its own sourceURL.
 *
 * The boundary tests read real component files from a temp directory, run the
 * real `listComponents` and `recursivelyTranspile`, then execute every emitted
 * script in V8 and read the line from the error stack. V8 numbers a sourceURL
 * script from the text right after `<script>`, exactly as DevTools does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const { configState } = vi.hoisted(() => ({
  configState: {
    base: "/",
    isBuild: false,
    directory: { pages: "", components: [] as string[], out: "" },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    },
    minify: { html: false, css: false, js: false, identifiers: false },
    assets: { inlineStyles: false, exclude: [] },
    pipeline: { watchPaths: [], workers: false },
    scripts: { cache: { enabled: false } },
    logging: {
      level: "info",
      requests: false,
      copies: false,
      deletes: false,
      transpiles: false,
    },
  },
}));

vi.mock("./config.js", () => ({
  BascikConfig: configState,
  shouldLog: () => false,
}));

import { invalidateComponentListCache, listComponents } from "./components.ts";
import { recursivelyTranspile } from "./processing.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import {
  numberInstanceSourceUrls,
  sourceLinePadding,
  stampScriptLines,
  stripScriptLines,
  takeScriptLine,
} from "./script-source-lines.ts";
import type { ComponentList } from "./types.ts";

describe("stampScriptLines", () => {
  it("records the line each browser script's body starts on", () => {
    const html =
      '<div></div>\n<script>\n  a();\n</script>\n\n<script type="module">b();</script>';
    expect(stampScriptLines(html)).toBe(
      '<div></div>\n<script data-bascik-script-line="2">\n  a();\n</script>\n\n' +
        '<script type="module" data-bascik-script-line="6">b();</script>',
    );
  });

  it("counts the lines of a multi-line opening tag and CRLF line endings", () => {
    const html =
      '<p>\r\n</p>\r\n<script\r\n  defer\r\n  data-x="1">\r\nrun();\r\n</script>';
    expect(
      takeScriptLine(/<script[^>]*>/i.exec(stampScriptLines(html))![0]).line,
    ).toBe(5);
  });

  it("leaves directive, external, data, and commented-out scripts alone", () => {
    const html = [
      "<script data-bascik-build>export default () => 1;</script>",
      '<script src="x.js"></script>',
      '<script type="application/ld+json">{}</script>',
      "<!-- <script>example()</script> -->",
    ].join("\n");
    expect(stampScriptLines(html)).toBe(html);
  });

  it("stamps a text/typescript script, which becomes a classic script later", () => {
    expect(
      stampScriptLines(
        '<script type="text/typescript">let a: number;</script>',
      ),
    ).toContain('data-bascik-script-line="1"');
  });

  it("does not stamp a script twice", () => {
    const once = stampScriptLines("<script>a();</script>");
    expect(stampScriptLines(once)).toBe(once);
  });
});

describe("stripScriptLines", () => {
  it("removes every stamp and nothing else", () => {
    const html =
      '<script defer data-bascik-script-line="3">a();</script><p data-bascik-script-line="3"></p>';
    expect(stripScriptLines(html)).toBe(
      '<script defer>a();</script><p data-bascik-script-line="3"></p>',
    );
  });
});

describe("sourceLinePadding", () => {
  it("pads by the lines above the body, counting the wrapper's own newline", () => {
    expect(sourceLinePadding(5, "")).toEqual({
      padding: "\n".repeat(4),
      leading: "",
    });
    expect(sourceLinePadding(5, "\n")).toEqual({
      padding: "\n".repeat(3),
      leading: "\n",
    });
  });

  it("drops the wrapper's newline when the body starts on line 1", () => {
    expect(sourceLinePadding(1, "\n")).toEqual({ padding: "", leading: "" });
  });

  it("changes nothing without a recorded line", () => {
    expect(sourceLinePadding(undefined, "\n")).toEqual({
      padding: "",
      leading: "\n",
    });
  });
});

describe("numberInstanceSourceUrls", () => {
  const html =
    "<script>(function() {\n})();\n//# sourceURL=src/components/a/a.html</script>";

  it("keeps the first instance's sourceURL as the plain file path", () => {
    expect(numberInstanceSourceUrls(html, 1)).toBe(html);
  });

  it("gives later instances their own sourceURL", () => {
    expect(numberInstanceSourceUrls(html, 3)).toContain(
      "//# sourceURL=src/components/a/a.html?instance=3</script>",
    );
  });

  it("uses a function replacement, so $ sequences in a path stay literal", () => {
    const tricky = html.replace("a/a.html", () => "$1/$&.html");
    expect(numberInstanceSourceUrls(tricky, 2)).toContain(
      "sourceURL=src/components/$1/$&.html?instance=2<",
    );
  });
});

describe("component scripts in DevTools coordinates", () => {
  let base: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const componentsDir = () => join(base, "src/components");
  const write = (path: string, content: string) => {
    mkdirSync(join(componentsDir(), path, ".."), { recursive: true });
    writeFileSync(join(componentsDir(), path), content);
  };
  /** The 1-based line of the first line of `file` that contains `needle`. */
  const lineOf = (content: string, needle: string) =>
    content.split("\n").findIndex((line) => line.includes(needle)) + 1;

  /** Runs every component script on the page and returns where each one threw. */
  const runScripts = async (pageHtml: string) => {
    const list = (await listComponents()) as ComponentList;
    const { transpiledHtmlBody } = recursivelyTranspile(
      pageHtml,
      list,
      [],
      join(base, "src/pages/index.html"),
    );
    const thrown: Array<{ url: string; line: number }> = [];
    for (const [, open, body] of transpiledHtmlBody.matchAll(
      /(<script\b[^>]*>)([\s\S]*?)<\/script[^>]*>/gi,
    )) {
      expect(open).not.toContain("data-bascik-script-line");
      if (!body.includes("//# sourceURL=")) continue;
      try {
        // Through eval, V8 itself names the script from its `//# sourceURL`, as browsers do.
        runInNewContext("eval(scriptSource)", {
          document: { getElementById: () => ({}) },
          scriptSource: body,
        });
      } catch (error) {
        const frame = /at (?:.*\()?(\S+?):(\d+):\d+\)?/.exec(
          String((error as Error).stack),
        );
        thrown.push({ url: frame![1], line: Number(frame![2]) });
        continue;
      }
      throw new Error(`A script did not throw:\n${body}`);
    }
    return thrown;
  };

  /** A component with markup and a multi-line <style> above its script, which throws on a known line. */
  const WIDGET = [
    '<div class="widget">',
    '  <p id="msg">Hello</p>',
    "</div>",
    "<style>",
    "  .widget {",
    "    padding: 8px;",
    "  }",
    "</style>",
    "<script>",
    "  const msg = document.getElementById('msg');",
    "  throw new Error('widget');",
    "</script>",
  ].join("\n");

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "bascik-script-lines-")));
    configState.directory.pages = join(base, "src/pages");
    configState.directory.out = join(base, "dist");
    configState.directory.components = [componentsDir()];
    configState.minify.html = false;
    configState.scoping.scriptBlocks = true;
    invalidateComponentListCache();
    clearScopingTemplates();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(base);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    warnSpy.mockRestore();
    invalidateComponentListCache();
    rmSync(base, { recursive: true, force: true });
  });

  it.each([
    ["unminified", false],
    ["with HTML minification, which moves scripts", true],
  ])(
    "reports the component file's own line (%s)",
    async (_label, minifyHtml) => {
      configState.minify.html = minifyHtml;
      write("my-widget/my-widget.html", WIDGET);

      const [thrown] = await runScripts("<main><my-widget></my-widget></main>");

      expect(thrown).toEqual({
        url: "src/components/my-widget/my-widget.html",
        line: lineOf(WIDGET, "throw new Error"),
      });
    },
  );

  it("gives every instance its own sourceURL with the same line", async () => {
    write("my-widget/my-widget.html", WIDGET);
    // Enough instances for scoping results to be reused by renaming (scoping-template.ts).
    const thrown = await runScripts(
      `<main>${"<my-widget></my-widget>".repeat(5)}</main>`,
    );

    const line = lineOf(WIDGET, "throw new Error");
    expect(thrown).toEqual([
      { url: "src/components/my-widget/my-widget.html", line },
      { url: "src/components/my-widget/my-widget.html?instance=2", line },
      { url: "src/components/my-widget/my-widget.html?instance=3", line },
      { url: "src/components/my-widget/my-widget.html?instance=4", line },
      { url: "src/components/my-widget/my-widget.html?instance=5", line },
    ]);
  });

  it("numbers instances per component, not per page", async () => {
    write("my-widget/my-widget.html", WIDGET);
    write("other-widget.html", WIDGET.replace("widget')", "other')"));

    const thrown = await runScripts(
      "<my-widget></my-widget><other-widget></other-widget><my-widget></my-widget>",
    );

    expect(thrown.map(({ url }) => url)).toEqual([
      "src/components/my-widget/my-widget.html",
      "src/components/other-widget.html",
      "src/components/my-widget/my-widget.html?instance=2",
    ]);
  });

  it("maps a script that starts on the opening tag's line", async () => {
    const component =
      '<p id="msg"></p>\n\n<script>throw new Error("same line");</script>';
    write("one-line.html", component);

    const [thrown] = await runScripts("<one-line></one-line>");

    expect(thrown.line).toBe(3);
  });

  it("maps every script when a component has several", async () => {
    const component = [
      '<p id="msg"></p>',
      "<script>",
      "  throw new Error('first');",
      "</script>",
      "<style>p { margin: 0; }</style>",
      "",
      "<script>",
      "",
      "  throw new Error('second');",
      "</script>",
    ].join("\n");
    write("two-scripts.html", component);

    const thrown = await runScripts("<two-scripts></two-scripts>");

    expect(thrown.map(({ line }) => line)).toEqual([3, 9]);
  });

  it("maps a companion script to its own file, from line 1", async () => {
    write(
      "my-counter/my-counter.html",
      '<p id="msg"></p>\n<style>p { color: red; }</style>\n<script src="my-counter.js"></script>',
    );
    const companion =
      "// counter\nconst msg = document.getElementById('msg');\nthrow new Error('companion');\n";
    write("my-counter/my-counter.js", companion);

    const [thrown] = await runScripts("<my-counter></my-counter>");

    expect(thrown).toEqual({
      url: "src/components/my-counter/my-counter.js",
      line: lineOf(companion, "throw new Error"),
    });
  });

  it("maps a module script, which is not wrapped", async () => {
    const component =
      '<p id="msg"></p>\n<script type="module">\n  throw new Error("module");\n</script>';
    write("mod-widget.html", component);
    const list = (await listComponents()) as ComponentList;
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<mod-widget></mod-widget>",
      list,
      [],
      join(base, "src/pages/index.html"),
    );

    const body = /<script type="module">([\s\S]*?)<\/script>/.exec(
      transpiledHtmlBody,
    )![1];

    expect(
      body.split("\n").findIndex((line) => line.includes("throw")) + 1,
    ).toBe(3);
  });

  it("leaves no stamp in the output when script scoping is off", async () => {
    configState.scoping.scriptBlocks = false;
    write("my-widget/my-widget.html", WIDGET);
    const list = (await listComponents()) as ComponentList;

    const { transpiledHtmlBody } = recursivelyTranspile(
      "<my-widget></my-widget>",
      list,
      [],
      join(base, "src/pages/index.html"),
    );

    expect(transpiledHtmlBody).toContain("throw new Error('widget')");
    expect(transpiledHtmlBody).not.toContain("data-bascik-script-line");
  });
});
