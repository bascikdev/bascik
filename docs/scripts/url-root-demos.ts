/**
 * The Output pane of the "Attributes That Become URLs on the Root" demo on /attribute-inheritance, produced by the
 * real compiler, and the warning the build prints for it.
 *
 * The Markdown is the single source. This library writes the demo's source blocks into a temp site under
 * /tmp/bascik-url-root/ (each block whole, at the path its first-line comment names, exactly as a reader's copy button
 * pastes it), adds a bascik.config.ts that turns minification off, runs the real `bascik --build`, and reads the
 * contents of <body> from dist/index.html and the inheritance warnings from the build's output. Build only: no
 * server, no port. The temp site is always removed before this returns.
 *
 * scripts/generate-url-root-demos.ts writes the result into the Markdown, and scripts/url-root-demos.test.ts
 * regenerates and compares, so a hand edit or a compiler change fails the docs unit tests.
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

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const SCRATCH = "/tmp/bascik-url-root";
const BASCIK_BIN = path.join(repoRoot, "pkg/bin/bascik.js");

export const MD = "content/attribute-inheritance.md";

/** The source blocks a reader copies into a site. */
export const SOURCE_MARKERS = [
  "url-root-usage",
  "url-root-source-html",
] as const;

/** Minification off, so the Output stays readable, as every Output in these docs is. */
export const DEMO_CONFIG = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  minify: { html: false, css: false, js: false, identifiers: false },
});
`;

/** The generated block. */
export const OUTPUT_MARKER = "url-root-output-html";

async function block(marker: string): Promise<string> {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  if (result.code === undefined)
    throw new Error(`${MD} ${marker}: ${result.problem}`);
  return result.code;
}

/** The contents of <body>, with the common leading indentation and surrounding blank lines removed. */
export function extractBody(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1];
  if (body === undefined) throw new Error("the built page has no <body>");
  const lines = body
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "")
    .split("\n");
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length),
  );
  return lines
    .map((l) => l.slice(Math.min(indent, /^ */.exec(l)![0].length)))
    .join("\n");
}

export interface UrlRootDemoRun {
  /** The compiler's output: the contents of <body>. */
  raw: string;
  /** The same text formatted as `prettier --write` formats a fence in the page's Markdown. */
  formatted: string;
  /** The attribute inheritance warnings the build printed, one per line, as printed. */
  warnings: string[];
  /** The temp site, already removed. */
  scratch: string;
}

export async function runUrlRootDemo(): Promise<UrlRootDemoRun> {
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
          { name: "url-root-demos", private: true, type: "module" },
          null,
          2,
        ) + "\n",
      "bascik.config.ts": DEMO_CONFIG,
    };
    for (const marker of SOURCE_MARKERS) {
      const code = await block(marker);
      files[pathComment(code)] = code + "\n";
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
    const warnings = `${built.stdout}\n${built.stderr}`
      .split("\n")
      .filter((line) => line.includes("inherited attribute"));
    const raw = extractBody(
      readFileSync(path.join(site, "dist/index.html"), "utf8"),
    );
    return {
      raw,
      formatted: await formatAsMarkdownFence(raw, MD),
      warnings,
      scratch,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
