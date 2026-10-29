/**
 * The "Attributes That Become URLs on the Root" demo on /attribute-inheritance.
 *
 * The Markdown is the single source: the Usage and HTML panes are <!-- demo:url-root-* --> blocks, and the Output pane
 * is generated, never hand-written. scripts/url-root-demos.ts writes the source blocks into a temp site under
 * /tmp/bascik-url-root/ (each at the path its first-line comment names, plus a bascik.config.ts with minification
 * off), runs the real `bascik --build` (no server, no port), and reads <body> from dist/index.html and the warnings
 * from the build's output. This test regenerates through it and compares with the committed blocks.
 *
 * Misuse lens: a hand-edited Output, a stale Output after a compiler change, a quoted warning that is not what the
 * build prints, a docs Preview component that drifted from the block a reader copies, and a temp site left behind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const MD = "content/attribute-inheritance.md";
const COMPONENT = "src/components/my-embed/my-embed.html";

const readDocs = (rel: string) =>
  readFileSync(path.join(DOCS_ROOT, rel), "utf8");

const block = async (marker: string): Promise<string> => {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  expect(result.problem, marker).toBeUndefined();
  return result.code!;
};

const withoutPathComment = (code: string) =>
  code.split("\n").slice(1).join("\n");

describe("url-root demo: source blocks", () => {
  it("each source block's first line names where a reader puts the file", async () => {
    expect((await block("url-root-usage")).split("\n")[0]).toBe(
      "<!-- src/pages/index.html -->",
    );
    expect((await block("url-root-source-html")).split("\n")[0]).toBe(
      "<!-- src/components/my-embed/my-embed.html -->",
    );
  });

  it("the docs Preview component is byte-identical to the HTML block minus the path comment", async () => {
    expect(readDocs(COMPONENT).replace(/\n$/, "")).toBe(
      withoutPathComment(await block("url-root-source-html")),
    );
  });

  it("the page's example slot uses the same <my-embed> tags as the Usage block", async () => {
    const shell = readDocs("src/pages/attribute-inheritance.html");
    const box = shell.slice(
      shell.indexOf('data-bascik-prop-file="src/components/my-embed/"'),
    );
    const example =
      /<div data-bascik-slot="example">([\s\S]*?)<\/div>\s*<div data-bascik-slot=/.exec(
        box,
      )?.[1] ?? "";
    const tags = (html: string) =>
      [...html.matchAll(/<my-embed\b[^>]*>/g)].map((m) =>
        m[0].replace(/\s+/g, " ").replace(/ >$/, ">"),
      );
    const usage = tags(await block("url-root-usage"));
    expect(usage).toHaveLength(2);
    expect(tags(example)).toEqual(usage);
  });

  it("the generator is exposed as a docs script", () => {
    const pkg = JSON.parse(readDocs("package.json"));
    expect(pkg.scripts["generate:url-root-demos"]).toBe(
      "node scripts/generate-url-root-demos.ts",
    );
  });
});

describe("url-root demo: generated Output", () => {
  let run: {
    raw: string;
    formatted: string;
    warnings: string[];
    scratch: string;
  };

  beforeAll(async () => {
    const lib = await import("./url-root-demos.ts");
    run = await lib.runUrlRootDemo();
  }, 180_000);

  afterAll(() => {
    if (run?.scratch) rmSync(run.scratch, { recursive: true, force: true });
  });

  it("builds in a temp site under /tmp/bascik-url-root and removes it", () => {
    expect(run.scratch.startsWith("/tmp/bascik-url-root/")).toBe(true);
    expect(existsSync(run.scratch)).toBe(false);
  });

  it("the committed Output HTML is what the compiler emits", async () => {
    expect(await block("url-root-output-html")).toBe(run.formatted);
  });

  it("the https URL is kept and the javascript: URL becomes about:invalid", () => {
    expect(run.raw).toMatch(/<object\b[^>]*data="https:\/\/[^"]+"/);
    expect(run.raw).toMatch(/<object\b[^>]*data="about:invalid"/);
    expect(run.raw).not.toContain("javascript:");
    expect(run.raw).not.toMatch(/<my-embed\b/);
  });

  it("the build prints exactly one warning, and the page quotes it word for word", () => {
    expect(run.warnings).toHaveLength(1);
    const md = readDocs(MD);
    expect(md).toContain("```text\n" + run.warnings[0] + "\n```");
  });
});
