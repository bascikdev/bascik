/**
 * The semantic HTML demos on /component-best-practices (Use HTML's Elements).
 *
 * The Markdown is the single source: the Usage and HTML panes are <!-- demo:semantic-* --> blocks, and each Output
 * pane is generated, never hand-written. scripts/semantic-html-demos.ts writes each demo's source blocks into its own
 * temp site under /tmp/bascik-semantic/ (with minification off), runs the real `bascik --build` (no server, no port),
 * and reads <body> from dist/index.html. It also runs the bascik skill's audit-components.mjs on the clickable <div>
 * the page shows, and the page quotes that finding. This test regenerates through it and compares.
 *
 * Misuse lens: a hand-edited Output, a stale Output after a compiler change, a quoted audit finding the audit no
 * longer prints, a docs Preview component that drifted from the block a reader copies, a demo box missing from the
 * page shell, and a temp site left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import {
  AUDIT_MARKER,
  BAD_BUTTON_MARKER,
  DEMOS,
  MD,
  instanceHashesMasked,
  markedBlock,
  type SemanticDemoRun,
} from "./semantic-html-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const readDocs = (rel: string) =>
  readFileSync(path.join(DOCS_ROOT, rel), "utf8");

const block = async (marker: string): Promise<string> => {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  expect(result.problem, marker).toBeUndefined();
  return result.code!;
};

const withoutPathComment = (code: string) =>
  code.split("\n").slice(1).join("\n");

describe("semantic-html demos: source blocks", () => {
  it("each source block's first line names where a reader puts the file", async () => {
    for (const demo of DEMOS) {
      const [usage, html] = demo.sources;
      expect((await block(usage)).split("\n")[0], usage).toBe(
        "<!-- src/pages/index.html -->",
      );
      expect((await block(html)).split("\n")[0], html).toMatch(
        /^<!-- src\/components\/([a-z-]+)\/\1\.html -->$/,
      );
    }
  });

  it("each docs Preview component is byte-identical to its HTML block minus the path comment", async () => {
    for (const demo of DEMOS.filter((d) => d.preview)) {
      expect(readDocs(demo.preview!).replace(/\n$/, ""), demo.preview).toBe(
        withoutPathComment(await block(demo.sources[1])),
      );
    }
  });

  it("the page shell has one demo box per demo, each reading its own blocks, and no Preview for the bad nav", () => {
    const shell = readDocs("src/pages/component-best-practices.html");
    expect(shell.match(/<component-demo\b/g)!.length).toBeGreaterThanOrEqual(
      DEMOS.length,
    );
    for (const demo of DEMOS)
      for (const marker of [...demo.sources, demo.output])
        expect(shell, marker).toContain(`"${marker}"`);
    const bad = shell.slice(
      shell.indexOf("<component-demo"),
      shell.indexOf("</component-demo>"),
    );
    expect(bad).toContain("semantic-nav-bad-usage");
    expect(bad).toContain("data-bascik-prop-no-preview");
    expect(bad).not.toContain('data-bascik-slot="example"');
  });

  it("the generator is exposed as a docs script", () => {
    const pkg = JSON.parse(readDocs("package.json"));
    expect(pkg.scripts["generate:semantic-html-demos"]).toBe(
      "node scripts/generate-semantic-html-demos.ts",
    );
  });
});

describe("semantic-html demos: generated Output", () => {
  let run: SemanticDemoRun;

  beforeAll(async () => {
    const lib = await import("./semantic-html-demos.ts");
    run = await lib.runSemanticHtmlDemos();
  }, 240_000);

  afterAll(() => {
    if (run?.scratch) rmSync(run.scratch, { recursive: true, force: true });
  });

  it("builds in temp sites under /tmp/bascik-semantic and removes them", () => {
    expect(run.scratch.startsWith("/tmp/bascik-semantic/")).toBe(true);
    expect(existsSync(run.scratch)).toBe(false);
  });

  it("every committed Output is what the compiler emits (instance hashes, which depend on the build path, masked)", async () => {
    for (const demo of DEMOS)
      expect(instanceHashesMasked(await block(demo.output)), demo.output).toBe(
        instanceHashesMasked(run.formatted[demo.id]),
      );
    // The mask covers only the hash: the button demo has one, and nothing else differs.
    expect(run.formatted.button).toMatch(
      /bascik__like-button__[0-9a-f]{8}__like/,
    );
  });

  it("ships the element that was written: a <div> for the bad nav, a <nav> for the good one, aria-label on each root", () => {
    expect(run.raw["nav-bad"]).toMatch(
      /<div class="[^"]*nav"[^>]*aria-label="Demo site"/,
    );
    expect(run.raw["nav-bad"]).not.toContain("<nav");
    expect(run.raw["nav-good"]).toMatch(
      /<nav class="[^"]*nav"[^>]*aria-label="Demo site"/,
    );
    expect(run.raw["nav-good"]).not.toMatch(/<div\b/);
    for (const raw of Object.values(run.raw))
      expect(raw).not.toMatch(/<(site-nav|like-button|faq-item)\b/);
  });

  it("the button is a <button type=button> and the FAQ item has no script", () => {
    expect(run.raw.button).toMatch(/<button\b[^>]*type="button"/);
    expect(run.raw.details).toMatch(/<details\b/);
    expect(run.raw.details).toMatch(/<summary\b/);
    expect(run.raw.details).not.toContain("<script");
  });

  it("the page quotes the audit's clickable-element finding for its clickable <div>, word for word", () => {
    const md = readDocs(MD);
    expect(markedBlock(md, "example", AUDIT_MARKER)).toBe(run.audit);
    expect(run.audit).toMatch(
      /^warn {2}clickable-element {2}src\/components\/like-button\/like-button\.html:2 /,
    );
    expect(markedBlock(md, "example", BAD_BUTTON_MARKER)).toContain(
      'addEventListener("click"',
    );
  });
});
