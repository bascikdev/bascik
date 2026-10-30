/**
 * The Output panes of the two demos on /component-best-practices (a radio group per component copy, and an exclusive
 * `<details>` accordion across copies), produced by the real compiler.
 *
 * The Markdown is the single source. This library writes the demos' source blocks into one temp site under
 * /tmp/bascik-name-attribute/ (each block whole, at the path its first-line comment names, exactly as a reader's
 * copy button pastes it), adds a bascik.config.ts that turns minification off, runs the real `bascik --build`, and
 * reads the contents of <body> from dist/index.html (the radios) and dist/faq.html (the accordion). Build only: no
 * server, no port. The temp site is always removed before this returns.
 *
 * scripts/generate-name-attribute-demos.ts writes the result into the Markdown, and
 * scripts/name-attribute-demos.test.ts regenerates and compares, so a hand edit or a compiler change fails the docs
 * unit tests.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import { repoRoot } from "./example-fixtures.ts";
import { formatAsMarkdownFence, pathComment } from "./rtc-demos.ts";
import { DEMO_CONFIG, extractBody } from "./url-root-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const SCRATCH = "/tmp/bascik-name-attribute";
const BASCIK_BIN = path.join(repoRoot, "pkg/bin/bascik.js");

export const MD = "content/component-best-practices.md";

/** Each demo: the source blocks a reader copies into a site, the page it builds, and its generated block. */
export const DEMOS = [
  {
    sources: ["name-radio-usage", "name-radio-source-html"],
    page: "index.html",
    output: "name-radio-output-html",
  },
  {
    sources: ["name-details-usage", "name-details-source-html"],
    page: "faq.html",
    output: "name-details-output-html",
  },
] as const;

async function block(marker: string): Promise<string> {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  if (result.code === undefined)
    throw new Error(`${MD} ${marker}: ${result.problem}`);
  return result.code;
}

export interface NameAttributeDemoOutput {
  marker: string;
  /** The compiler's output: the contents of <body>. */
  raw: string;
  /** The same text formatted as `prettier --write` formats a fence in the page's Markdown. */
  formatted: string;
}

export interface NameAttributeDemoRun {
  outputs: NameAttributeDemoOutput[];
  /** Everything the build printed. */
  log: string;
  /** The temp site, already removed. */
  scratch: string;
}

export async function runNameAttributeDemos(): Promise<NameAttributeDemoRun> {
  mkdirSync(SCRATCH, { recursive: true });
  const scratch = mkdtempSync(path.join(SCRATCH, "demos-"));
  try {
    // node_modules sits above the site, as in a monorepo, so bascik.config.ts resolves @bascik/bascik.
    const scope = path.join(scratch, "node_modules/@bascik");
    mkdirSync(scope, { recursive: true });
    symlinkSync(path.join(repoRoot, "pkg"), path.join(scope, "bascik"), "dir");
    const site = path.join(scratch, "site");
    const files: Record<string, string> = {
      "package.json":
        JSON.stringify(
          { name: "name-attribute-demos", private: true, type: "module" },
          null,
          2,
        ) + "\n",
      "bascik.config.ts": DEMO_CONFIG,
    };
    for (const demo of DEMOS) {
      for (const marker of demo.sources) {
        const code = await block(marker);
        files[pathComment(code)] = code + "\n";
      }
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(site, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const built = spawnSync(process.execPath, [BASCIK_BIN, "--build"], {
      cwd: site,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        BASCIK_SITE_URL: "https://example.com",
      },
      timeout: 120_000,
    });
    if (built.status !== 0)
      throw new Error(
        `bascik --build failed in ${site}:\n${built.stdout}\n${built.stderr}`,
      );
    const outputs: NameAttributeDemoOutput[] = [];
    for (const demo of DEMOS) {
      const raw = extractBody(
        readFileSync(path.join(site, "dist", demo.page), "utf8"),
      );
      outputs.push({
        marker: demo.output,
        raw,
        formatted: await formatAsMarkdownFence(raw, MD),
      });
    }
    return { outputs, log: `${built.stdout}\n${built.stderr}`, scratch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
