/**
 * The Output panes of the "Collapse framework grid wrappers into one section" demo on /how-to/agent-migration,
 * produced by the real compiler.
 *
 * The Markdown is the single source. This library writes the demo's source blocks into a temp site under
 * /tmp/bascik-agent-migration/ (each block whole, at the path its first-line comment names, exactly as a reader's
 * copy button pastes it), adds a bascik.config.ts that turns minification off (so the Output stays readable, as
 * every Output in these docs is), runs the real `bascik --build`, and reads dist/index.html: the press <section> from
 * <body> and the component's scoped <style> from <head>. Build only: no server, no port. The temp site is always
 * removed before this returns.
 *
 * scripts/generate-migration-demos.ts writes the result into the Markdown, and scripts/migration-demos.test.ts
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
const SCRATCH = "/tmp/bascik-agent-migration";
const BASCIK_BIN = path.join(repoRoot, "pkg/bin/bascik.js");

export const MD = "content/how-to/agent-migration.md";

/** The source blocks a reader copies into a site. */
export const SOURCE_MARKERS = [
  "migration-grid-usage",
  "migration-grid-source-html",
  "migration-grid-source-css",
] as const;

/** The generated blocks, by fence language. */
export const OUTPUT_MARKERS = {
  html: "migration-grid-output-html",
  css: "migration-grid-output-css",
} as const;

/** Minification off, so class names and whitespace stay readable in the Output. */
export const DEMO_CONFIG = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  minify: { html: false, css: false, js: false, identifiers: false },
});
`;

async function block(marker: string): Promise<string> {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  if (result.code === undefined)
    throw new Error(`${MD} ${marker}: ${result.problem}`);
  return result.code;
}

/** Removes the common leading indentation and surrounding blank lines. */
function dedent(text: string): string {
  const lines = text
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "")
    .split("\n");
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length),
  );
  return lines.map((l) => l.slice(indent)).join("\n");
}

/** The first <section> in <body>, through its closing tag. */
export function extractSection(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1];
  const section = body && /<section\b[\s\S]*?<\/section>/i.exec(body)?.[0];
  if (!section) throw new Error("the built page has no <section> in <body>");
  return section;
}

/** The text of the <style> element that holds the press-list component's scoped rules. */
export function extractComponentStyle(html: string): string {
  const style = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .find((css) => /press-list/.test(css));
  if (style === undefined)
    throw new Error("the built page has no <style> with the press-list rules");
  return dedent(style);
}

export interface MigrationDemoRun {
  /** The compiler's output: the section and the component stylesheet. */
  raw: { html: string; css: string };
  /** The same text formatted as `prettier --write` formats a fence in the page's Markdown. */
  formatted: { html: string; css: string };
  /** The temp site, already removed. */
  scratch: string;
}

export async function runMigrationDemos(): Promise<MigrationDemoRun> {
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
          { name: "migration-demos", private: true, type: "module" },
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
    const page = readFileSync(path.join(site, "dist/index.html"), "utf8");
    const raw = {
      html: extractSection(page),
      css: extractComponentStyle(page),
    };
    return {
      raw,
      formatted: {
        html: await formatAsMarkdownFence(raw.html, MD),
        css: await formatAsMarkdownFence(raw.css, MD, "css"),
      },
      scratch,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
