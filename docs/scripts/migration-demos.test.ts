/**
 * The "Collapse framework grid wrappers into one section" demo on /how-to/agent-migration.
 *
 * The Markdown is the single source: the Usage, HTML and CSS panes are <!-- demo:migration-grid-* --> blocks, and
 * the Output panes are generated, never hand-written. scripts/migration-demos.ts writes the source blocks into a temp
 * site under /tmp/bascik-agent-migration/ (each at the path its first-line comment names, plus a bascik.config.ts
 * with minification off), runs the real `bascik --build` (no server, no port), reads dist/index.html, and takes the
 * press section from <body> and the component's scoped <style>. This test regenerates through it and compares with
 * the committed blocks after formatting the raw text exactly as `prettier --write` formats a fence in Markdown.
 *
 * Misuse lens: a hand-edited Output, a stale Output after a source change, a docs Preview component that drifted
 * from the block a reader copies, a Preview that shows other text than the Output, a temp site left behind, and an
 * Output that still carries the framework grid wrappers the demo says are gone.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const MD = "content/how-to/agent-migration.md";
const COMPONENT_DIR = "src/components/press-list";

const readDocs = (rel: string) =>
  readFileSync(path.join(DOCS_ROOT, rel), "utf8");

const block = async (marker: string): Promise<string> => {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  expect(result.problem, marker).toBeUndefined();
  return result.code!;
};

/** What `prettier --write` makes of a ```lang fence holding `raw` in the page's Markdown. */
const prettierFence = async (
  raw: string,
  lang: "html" | "css",
): Promise<string> => {
  const prettier = await import("prettier");
  const options =
    (await prettier.resolveConfig(path.join(DOCS_ROOT, MD))) ?? {};
  const md = "```" + lang + "\n" + raw.replace(/\n+$/, "") + "\n```\n";
  const out = await prettier.format(md, { ...options, parser: "markdown" });
  return new RegExp("^```" + lang + "\\n([\\s\\S]*?)\\n?```", "m")
    .exec(out)![1]
    .replace(/\n$/, "");
};

/**
 * The text a reader sees: comments, tags, scripts and styles dropped, whitespace collapsed. Each is ended where the HTML
 * tokenizer ends it: a comment at `-->` or `--!>` (or `<!-->` at once, or the end of input), a script or style at an
 * end tag in any case that may carry whitespace or junk before its ">".
 */
const visibleText = (html: string) =>
  html
    .replace(/<!--(?:-?>|[\s\S]*?(?:--!?>|$))/g, " ")
    .replace(/<script\b[\s\S]*?<\/script(?:[\t\n\f\r /][^>]*)?>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style(?:[\t\n\f\r /][^>]*)?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const withoutPathComment = (code: string) =>
  code.split("\n").slice(1).join("\n");

describe("migration grid demo: source blocks", () => {
  it("each source block's first line names where a reader puts the file", async () => {
    expect((await block("migration-grid-usage")).split("\n")[0]).toBe(
      "<!-- src/pages/index.html -->",
    );
    expect((await block("migration-grid-source-html")).split("\n")[0]).toBe(
      "<!-- src/components/press-list/press-list.html -->",
    );
    expect((await block("migration-grid-source-css")).split("\n")[0]).toBe(
      "/* src/components/press-list/press-list.css */",
    );
  });

  it("the docs Preview component is byte-identical to the blocks minus the path comment", async () => {
    expect(
      readDocs(`${COMPONENT_DIR}/press-list.html`).replace(/\n$/, ""),
    ).toBe(withoutPathComment(await block("migration-grid-source-html")));
    expect(readDocs(`${COMPONENT_DIR}/press-list.css`).replace(/\n$/, "")).toBe(
      withoutPathComment(await block("migration-grid-source-css")),
    );
  });

  it("the component replaces the 24-column span 20 offset 2 wrappers with one measured section", async () => {
    const css = await block("migration-grid-source-css");
    expect(css).toMatch(/width:\s*min\(100%,\s*1200px\)/);
    expect(css).toMatch(/margin:\s*0 auto/);
    const html = await block("migration-grid-source-html");
    expect(html).toMatch(/<section\b[^>]*class="press"/);
    // No framework grid classes survive into the Bascik component.
    expect(html).not.toMatch(/\b(row|col|ant-row|ant-col)[-"\s]/);
  });

  it("the generator is exposed as a docs script", () => {
    const pkg = JSON.parse(readDocs("package.json"));
    expect(pkg.scripts["generate:migration-demos"]).toBe(
      "node scripts/generate-migration-demos.ts",
    );
    expect(
      existsSync(path.join(DOCS_ROOT, "scripts/generate-migration-demos.ts")),
    ).toBe(true);
  });
});

describe("migration grid demo: replaceDemoFence", () => {
  it("replaces an html or a css fence after its marker and nothing else", async () => {
    const { replaceDemoFence } = await import("./generate-rtc-demos.ts");
    const md = [
      "<!-- demo:a -->",
      "```html",
      "<p>old</p>",
      "```",
      "",
      "<!-- demo:b -->",
      "```css",
      ".old {}",
      "```",
      "",
    ].join("\n");
    const html = replaceDemoFence(md, "a", "<p>new</p>");
    expect(html).toContain("<p>new</p>");
    expect(html).toContain(".old {}");
    const css = replaceDemoFence(md, "b", ".new {}", "css");
    expect(css).toContain(".new {}");
    expect(css).toContain("<p>old</p>");
    expect(() => replaceDemoFence(md, "b", "x")).toThrow(/demo:b/);
    expect(() => replaceDemoFence(md, "missing", "x", "css")).toThrow(
      /demo:missing/,
    );
  });
});

describe("migration grid demo: generated Output", () => {
  let run: {
    raw: { html: string; css: string };
    formatted: { html: string; css: string };
    scratch: string;
  };

  beforeAll(async () => {
    const lib = await import("./migration-demos.ts");
    run = await lib.runMigrationDemos();
  }, 180_000);

  afterAll(() => {
    if (run?.scratch) rmSync(run.scratch, { recursive: true, force: true });
  });

  it("builds in a temp site under /tmp/bascik-agent-migration and removes it", () => {
    expect(run.scratch.startsWith("/tmp/bascik-agent-migration/")).toBe(true);
    expect(existsSync(run.scratch)).toBe(false);
  });

  it("the generator formats as prettier does", async () => {
    expect(run.formatted.html).toBe(await prettierFence(run.raw.html, "html"));
    expect(run.formatted.css).toBe(await prettierFence(run.raw.css, "css"));
  });

  it("the committed Output HTML is what the compiler emits", async () => {
    expect(await block("migration-grid-output-html")).toBe(run.formatted.html);
  });

  it("the committed Output CSS is what the compiler emits", async () => {
    expect(await block("migration-grid-output-css")).toBe(run.formatted.css);
  });

  it("the Output is one scoped section, without the framework wrappers", () => {
    const html = run.raw.html;
    expect(html).toMatch(/^\s*<section\b/);
    expect((html.match(/<section\b/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/<press-list\b/);
    // The class is scoped: it is no longer the bare authored name.
    expect(html).not.toMatch(/class="press"/);
    expect(html).toMatch(/class="[^"]*press[^"]*"/);
    expect(run.raw.css).toMatch(/min\(100%,\s*1200px\)/);
  });

  it("the Output shows the same text as the Preview", async () => {
    const usage = withoutPathComment(await block("migration-grid-usage"));
    const component = readDocs(`${COMPONENT_DIR}/press-list.html`);
    const output = visibleText(run.raw.html);
    // Every list entry and the heading a reader sees in the Preview reach the Output.
    const shown = [
      ...`${usage}\n${component}`.matchAll(/<(li|h2)\b[^>]*>([\s\S]*?)<\/\1>/g),
    ]
      .map((m) => visibleText(m[2]))
      .filter(Boolean);
    expect(shown.length).toBeGreaterThan(1);
    for (const text of shown) expect(output, text).toContain(text);
  });

  it("the page's example slot uses the same <press-list> tag as the Usage block", async () => {
    const shell = readDocs("src/pages/how-to/agent-migration.html");
    const example =
      /<div data-bascik-slot="example">([\s\S]*?)<\/div>\s*<div data-bascik-slot=/.exec(
        shell,
      )?.[1] ?? "";
    const tag = (html: string) =>
      /<press-list\b[\s\S]*?(?:\/>|<\/press-list\s*>)/.exec(html)?.[0] ?? "";
    const usage = tag(await block("migration-grid-usage"));
    expect(usage, "usage <press-list>").not.toBe("");
    expect(visibleText(tag(example))).toBe(visibleText(usage));
    expect(tag(example).replace(/\s+/g, " ")).toBe(usage.replace(/\s+/g, " "));
  });
});
