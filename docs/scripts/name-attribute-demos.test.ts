/**
 * The two demos on /component-best-practices (Name Form Controls and Groups): a radio group per component copy, and an exclusive `<details>` accordion
 * across copies.
 *
 * The Markdown is the single source: the Usage and HTML panes are <!-- demo:name-* --> blocks, and the Output panes
 * are generated, never hand-written. scripts/name-attribute-demos.ts writes the source blocks into a temp site under
 * /tmp/bascik-name-attribute/ (each at the path its first-line comment names, plus a bascik.config.ts with
 * minification off), runs the real `bascik --build` (no server, no port), and reads <body> from the built pages.
 * This test regenerates through it and compares with the committed blocks.
 *
 * Misuse lens: a hand-edited Output, a stale Output after a compiler change (such as `name` scoping coming back), a
 * docs Preview component that drifted from the block a reader copies, a page whose example slot uses other tags than
 * the Usage block, and a temp site left behind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import type { NameAttributeDemoRun } from "./name-attribute-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const MD = "content/component-best-practices.md";
const PAGE = "src/pages/component-best-practices.html";

const readDocs = (rel: string) =>
  readFileSync(path.join(DOCS_ROOT, rel), "utf8");

const block = async (marker: string): Promise<string> => {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  expect(result.problem, marker).toBeUndefined();
  return result.code!;
};

const withoutPathComment = (code: string) =>
  code.split("\n").slice(1).join("\n");

const DEMOS = [
  {
    tag: "froth-picker",
    usage: "name-radio-usage",
    usagePath: "src/pages/index.html",
    source: "name-radio-source-html",
    output: "name-radio-output-html",
    copies: 2,
  },
  {
    tag: "frother-question",
    usage: "name-details-usage",
    usagePath: "src/pages/faq.html",
    source: "name-details-source-html",
    output: "name-details-output-html",
    copies: 3,
  },
] as const;

/** The demo box on the page whose meta bar names `tag`'s folder, and its example slot. */
const exampleSlot = (tag: string): string => {
  const shell = readDocs(PAGE);
  const box = shell.slice(
    shell.indexOf(`data-bascik-prop-file="src/components/${tag}/"`),
  );
  return (
    /<div data-bascik-slot="example">([\s\S]*?)<\/div>\s*<div data-bascik-slot=/.exec(
      box,
    )?.[1] ?? ""
  );
};

/** Whitespace a formatter may move: runs collapse, and none inside a tag's edges or between tags. */
const normalize = (html: string) =>
  html
    .replace(/\s+/g, " ")
    .replace(/ ?(<\/?[\w-]+)/g, "$1")
    .replace(/ >/g, ">")
    .replace(/> /g, ">")
    .trim();

describe.each(DEMOS)("name-attribute demo <$tag>: source blocks", (demo) => {
  it("each source block's first line names where a reader puts the file", async () => {
    expect((await block(demo.usage)).split("\n")[0]).toBe(
      `<!-- ${demo.usagePath} -->`,
    );
    expect((await block(demo.source)).split("\n")[0]).toBe(
      `<!-- src/components/${demo.tag}/${demo.tag}.html -->`,
    );
  });

  it("the docs Preview component is byte-identical to the HTML block minus the path comment", async () => {
    expect(
      readDocs(`src/components/${demo.tag}/${demo.tag}.html`).replace(
        /\n$/,
        "",
      ),
    ).toBe(withoutPathComment(await block(demo.source)));
  });

  it("the page's example slot renders the same usages as the Usage block's <body>", async () => {
    const usage = await block(demo.usage);
    const body = /<body>([\s\S]*?)<\/body>/.exec(usage)?.[1] ?? "";
    expect(body.match(new RegExp(`<${demo.tag}\\b`, "g"))).toHaveLength(
      demo.copies,
    );
    expect(normalize(exampleSlot(demo.tag))).toBe(normalize(body));
  });
});

describe("name-attribute demos: wiring", () => {
  it("the generator is exposed as a docs script", () => {
    const pkg = JSON.parse(readDocs("package.json"));
    expect(pkg.scripts["generate:name-attribute-demos"]).toBe(
      "node scripts/generate-name-attribute-demos.ts",
    );
  });

  it("the page renders every demo block through extractDemoBlock", () => {
    const shell = readDocs(PAGE);
    for (const demo of DEMOS)
      for (const marker of [demo.usage, demo.source, demo.output])
        expect(shell).toContain(`"${marker}"`);
  });
});

describe("name-attribute demos: generated Output", () => {
  let run: NameAttributeDemoRun;

  beforeAll(async () => {
    const lib = await import("./name-attribute-demos.ts");
    run = await lib.runNameAttributeDemos();
  }, 180_000);

  afterAll(() => {
    if (run?.scratch) rmSync(run.scratch, { recursive: true, force: true });
  });

  const outputOf = (marker: string) =>
    run.outputs.find((output) => output.marker === marker)!;

  it("builds in a temp site under /tmp/bascik-name-attribute and removes it", () => {
    expect(run.scratch.startsWith("/tmp/bascik-name-attribute/")).toBe(true);
    expect(existsSync(run.scratch)).toBe(false);
  });

  it.each(DEMOS)(
    "the committed Output for <$tag> is what the compiler emits",
    async (demo) => {
      expect(await block(demo.output)).toBe(outputOf(demo.output).formatted);
    },
  );

  it("ships name as written: each froth-picker keeps name=froth inside a form of its own", () => {
    const raw = outputOf("name-radio-output-html").raw;
    expect(raw.match(/name="froth"/g)).toHaveLength(4);
    expect(raw.match(/<form\b/g)).toHaveLength(2);
    expect(raw).not.toContain("bascik__");
  });

  it("ships name as written: every frother-question is one details name=faq group", () => {
    const raw = outputOf("name-details-output-html").raw;
    expect(raw.match(/<details name="faq"/g)).toHaveLength(3);
    expect(raw).not.toContain("bascik__");
  });

  it("the build prints no warnings for the demos", () => {
    expect(run.log).not.toMatch(/warn/i);
  });
});
