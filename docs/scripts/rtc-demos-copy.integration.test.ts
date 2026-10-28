/**
 * Misuse lens for the "Returning component tags" demos: a reader who copies the Source blocks into a brand-new
 * site gets exactly the Output the docs show.
 *
 * The test scaffolds a fresh project with create-bascik into /tmp/bascik-rtc-docs-demos/copy-test, writes each
 * Usage/HTML/CSS/JS block to the path named in its first-line comment (as a reader would), adds the documented
 * bascik.config.ts, links this repository's Bascik, then builds, serves with the real `bascik --server`, fetches
 * each demo URL, formats the body the way the committed Output was formatted, and compares. The generator library
 * (scripts/rtc-demos.ts) starts and always stops the server; nothing is left listening.
 *
 * Only request-time instance ids (`r` + 7 hex digits, inside a scoped id `bascik__<component>__<id>__`) are
 * normalized, bijectively by order of first appearance.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import { repoRoot } from "./example-fixtures.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const SCRATCH = "/tmp/bascik-rtc-docs-demos";
const PROJECT = "copy-test";
const PROJECT_DIR = path.join(SCRATCH, PROJECT);

/** Every source block a reader copies, by md file and marker. */
const SOURCE_BLOCKS: [string, string][] = [
  ["content/server-scripts.md", "rtc-search-source-usage"],
  ["content/server-scripts.md", "rtc-search-source-html"],
  ["content/server-scripts.md", "rtc-search-source-css"],
  ["content/server-scripts.md", "rtc-search-source-js"],
  ["content/server-scripts.md", "rtc-live-source-usage"],
  ["content/server-scripts.md", "rtc-live-source-html"],
  ["content/server-scripts.md", "rtc-live-source-css"],
  ["content/stream-scripts.md", "rtc-stream-source-usage"],
  ["content/testing/troubleshooting.md", "rtc-passthrough-source-usage"],
];

const OUTPUTS: {
  id: "search" | "live" | "stream" | "passthrough";
  md: string;
  marker: string;
}[] = [
  {
    id: "search",
    md: "content/server-scripts.md",
    marker: "rtc-search-output-html",
  },
  {
    id: "live",
    md: "content/server-scripts.md",
    marker: "rtc-live-output-html",
  },
  {
    id: "stream",
    md: "content/stream-scripts.md",
    marker: "rtc-stream-output-html",
  },
  {
    id: "passthrough",
    md: "content/testing/troubleshooting.md",
    marker: "rtc-passthrough-output-html",
  },
];

/** A request-time id (`r` + 7 hex digits) where Bascik writes one: `bascik__<component>__<id>__`. */
const REQUEST_ID = /(?<=\bbascik__[a-z][a-z0-9-]*__)r[0-9a-f]{7}(?=__)/g;
const normalizeRequestIds = (html: string): string => {
  const seen = new Map<string, string>();
  return html.replace(REQUEST_ID, (id) => {
    if (!seen.has(id)) seen.set(id, `r<ID ${seen.size + 1}>`);
    return seen.get(id)!;
  });
};

const block = async (md: string, marker: string): Promise<string> => {
  const result = await readDemoBlock(path.join(DOCS_ROOT, md), marker);
  if (result.code === undefined) throw new Error(result.problem);
  return result.code;
};

/** The path a block's first-line comment names: `<!-- p -->`, `/* p *\/` or `// p`. */
const pathComment = (code: string): string => {
  const first = code.split("\n")[0];
  const p =
    /^<!--\s*(\S+)\s*-->$/.exec(first)?.[1] ??
    /^\/\*\s*(\S+)\s*\*\/$/.exec(first)?.[1] ??
    /^\/\/\s*(\S+)$/.exec(first)?.[1];
  if (!p) throw new Error(`block has no path comment: ${first}`);
  return p;
};

describe("a reader copying the Returning component tags blocks into a new site", () => {
  let lib: typeof import("./rtc-demos.ts");
  let raw: Record<string, string>;
  let formatted: Record<string, string>;

  beforeAll(async () => {
    lib = await import("./rtc-demos.ts");
    // create-bascik's scaffolder, loaded by URL: it lives outside the docs rootDir, so tsc must not follow it.
    const { scaffold } = (await import(
      pathToFileURL(path.join(repoRoot, "create/src/scaffold.ts")).href
    )) as { scaffold: (name: string, dir: string) => Promise<void> };
    mkdirSync(SCRATCH, { recursive: true });
    rmSync(PROJECT_DIR, { recursive: true, force: true });
    await scaffold(PROJECT, SCRATCH);

    for (const [md, marker] of SOURCE_BLOCKS) {
      const code = await block(md, marker);
      const file = path.join(PROJECT_DIR, pathComment(code));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, code + "\n");
    }
    // The documented config, pasted as shown.
    const section = readFileSync(
      path.join(DOCS_ROOT, "content/server-scripts.md"),
      "utf8",
    );
    const config = /```ts\n(\/\/ bascik\.config\.ts\n[\s\S]*?)\n```/.exec(
      section,
    )?.[1];
    if (!config)
      throw new Error(
        "server-scripts.md documents no ```ts // bascik.config.ts block",
      );
    writeFileSync(path.join(PROJECT_DIR, "bascik.config.ts"), config + "\n");

    // A scaffold has no node_modules: point @bascik/bascik at this repository's package.
    const scope = path.join(PROJECT_DIR, "node_modules", "@bascik");
    mkdirSync(scope, { recursive: true });
    symlinkSync(path.join(repoRoot, "pkg"), path.join(scope, "bascik"), "dir");

    const run = await lib.runRtcDemos({ projectDir: PROJECT_DIR });
    raw = run.raw;
    formatted = run.formatted;
  }, 240_000);

  afterAll(() => {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  it.each(OUTPUTS)(
    "$id: gets exactly the committed Output",
    async ({ id, md, marker }) => {
      const committed = await block(md, marker);
      expect(raw[id]).toBeTruthy();
      expect(normalizeRequestIds(formatted[id])).toBe(
        normalizeRequestIds(committed),
      );
    },
  );
});
