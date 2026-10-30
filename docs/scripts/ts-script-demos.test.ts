/**
 * The TypeScript script demos: a build script (/build-scripts), a server script (/server-scripts), a stream script
 * (/stream-scripts), a page's own `.ts` file (/scoped-javascript), and a `scripts.typescript` esbuild compiler
 * (/configuration).
 *
 * The Markdown is the single source: the Usage and Source panes are <!-- demo:ts-* --> blocks, and each Output pane
 * is generated, never hand-written. scripts/ts-script-demos.ts writes the source blocks into temp sites under
 * /tmp/bascik-ts-script-demos/, runs the real `bascik --build` (and `bascik --server` for the server and stream
 * demos), and reads <body>. This test regenerates through it and compares with the committed blocks.
 *
 * Misuse lens: a hand-edited Output, a stale Output after a compiler change, a docs Preview that drifted from the
 * block a reader copies, a demo block a shell never shows (or shows twice, inline and in the box), a demo whose
 * Output still holds TypeScript, and a temp site left behind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import { DEMOS, type TsDemoId } from "./ts-script-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const readDocs = (rel: string) =>
  readFileSync(path.join(DOCS_ROOT, rel), "utf8");

const block = async (md: string, marker: string): Promise<string> => {
  const result = await readDemoBlock(path.join(DOCS_ROOT, md), marker);
  expect(result.problem, `${md} ${marker}`).toBeUndefined();
  return result.code!;
};

/** The page shell that renders a content file: content/x.md is shown by src/pages/x.html. */
const shellFor = (md: string) =>
  readDocs(`src/pages/${path.basename(md, ".md")}.html`);

/** The body of the first `<script ...attrs>` whose open tag contains `attrs`, with each line trimmed. */
const scriptBody = (html: string, attrs: string): string => {
  const open = html.indexOf(`<script ${attrs}`);
  expect(open, attrs).toBeGreaterThanOrEqual(0);
  const start = html.indexOf(">", open) + 1;
  return html
    .slice(start, html.indexOf("</script>", start))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
};

describe("TypeScript script demos: source blocks and the docs pages that show them", () => {
  it.each(DEMOS)(
    "$id: each source block's first line names where a reader puts the file",
    async (demo) => {
      for (const marker of demo.sources) {
        const first = (await block(demo.md, marker)).split("\n")[0];
        expect(first, marker).toMatch(
          /^(<!-- (src\/pages\/[\w-]+\.html) -->|\/\/ (bascik\.config\.ts|src\/pages\/[\w-]+\.ts))$/,
        );
      }
    },
  );

  it.each(DEMOS)(
    "$id: the page shell shows every block in a demo box and strips them from the rendered prose",
    async (demo) => {
      const shell = shellFor(demo.md);
      for (const marker of [...demo.sources, demo.output])
        expect(shell, marker).toContain(`"${marker}"`);
      const box = shell.indexOf(`"${demo.output}"`);
      const rangeBefore = shell.lastIndexOf("renderMdRange(", box);
      const call = shell.slice(
        rangeBefore,
        shell.indexOf("</script>", rangeBefore),
      );
      expect(call, "the range before the box strips demo blocks").toContain(
        "stripDemoBlocks: true",
      );
    },
  );

  it("the build demo's Preview runs the same TypeScript build script the Usage block shows", async () => {
    const usage = await block("content/build-scripts.md", "ts-build-usage");
    const shell = readDocs("src/pages/build-scripts.html");
    const attrs = 'data-bascik-build type="text/typescript"';
    expect(scriptBody(shell, attrs)).toBe(scriptBody(usage, attrs));
  });

  it("the page demo's Preview file is the Source block minus its path comment", async () => {
    const source = await block(
      "content/scoped-javascript.md",
      "ts-page-source-js",
    );
    expect(readDocs("src/pages/scoped-javascript-counter.ts")).toBe(
      source.split("\n").slice(1).join("\n") + "\n",
    );
    expect(readDocs("src/pages/scoped-javascript.html")).toContain(
      '<script src="./scoped-javascript-counter.ts"></script>',
    );
  });

  it("the build demo is a page-dependent data-bascik-build script, as the guidance says it must be", async () => {
    const usage = await block("content/build-scripts.md", "ts-build-usage");
    expect(usage).toContain("data-bascik-build ");
    expect(usage).toContain("BASCIK_PAGE_PATH");
    expect(usage).not.toMatch(/getFullYear/);
  });

  it("the generator is exposed as a docs script", () => {
    const pkg = JSON.parse(readDocs("package.json"));
    expect(pkg.scripts["generate:ts-script-demos"]).toBe(
      "node scripts/generate-ts-script-demos.ts",
    );
  });
});

describe("TypeScript script demos: generated Output", () => {
  let run: {
    raw: Record<TsDemoId, string>;
    formatted: Record<TsDemoId, string>;
    scratch: string;
  };

  beforeAll(async () => {
    const lib = await import("./ts-script-demos.ts");
    run = await lib.runTsScriptDemos();
  }, 240_000);

  afterAll(() => {
    if (run?.scratch) rmSync(run.scratch, { recursive: true, force: true });
  });

  it("builds in temp sites under /tmp/bascik-ts-script-demos and removes them", () => {
    expect(run.scratch.startsWith("/tmp/bascik-ts-script-demos/")).toBe(true);
    expect(existsSync(run.scratch)).toBe(false);
  });

  it.each(DEMOS)(
    "$id: the committed Output is what the compiler and server produce",
    async (demo) => {
      expect(await block(demo.md, demo.output)).toBe(run.formatted[demo.id]);
    },
  );

  it("no Output holds TypeScript", () => {
    for (const demo of DEMOS) {
      expect(run.raw[demo.id], demo.id).not.toMatch(
        /: (string|number|Promise<string>|Item\[\])\b|\bas HTML|\binterface |\benum /,
      );
    }
  });

  it("each Output shows what its script did", () => {
    expect(run.raw.build).toBe(
      '<nav aria-label="Breadcrumb">Home / build-scripts</nav>',
    );
    expect(run.raw.server).toContain("<p>Hello, Ada</p>");
    expect(run.raw.stream).toContain("<li>Pour-over kettle: 12 left</li>");
    expect(run.raw.page).toContain("//# sourceURL=src/pages/counter.ts");
    expect(run.raw.page).not.toContain('src="./counter.ts"');
    expect(run.raw.config).toContain('Size2["Medium"] = "M"');
  });
});
