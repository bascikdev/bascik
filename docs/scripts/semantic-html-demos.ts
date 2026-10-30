/**
 * The Output panes of the demos on /semantic-html, produced by the real compiler, and the audit finding the page
 * quotes for its clickable <div>.
 *
 * The Markdown is the single source. For each demo this library writes the demo's source blocks into its own temp
 * site under /tmp/bascik-semantic/ (each block whole, at the path its first-line comment names, exactly as a reader's
 * copy button pastes it), adds the bascik.config.ts every docs Output is made with (minification off), runs the real
 * `bascik --build`, and reads the contents of <body> from dist/index.html. Scoped instance ids hash the
 * page's path, so they differ between runs: semantic-html-demos.test.ts compares with that hash masked
 * (instanceHashesMasked). The bad and good nav demos both define
 * <site-nav>, so each demo gets a site of its own. For the clickable <div>, it writes that block into a site with a
 * page that uses it and runs the bascik skill's audit-components.mjs, keeping the clickable-element finding.
 * Build only: no server, no port. Every temp site is removed before this returns.
 *
 * scripts/generate-semantic-html-demos.ts writes the result into the Markdown, and scripts/semantic-html-demos.test.ts
 * regenerates and compares, so a hand edit or a compiler or audit change fails the docs unit tests.
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
export const SCRATCH = "/tmp/bascik-semantic";
const BASCIK_BIN = path.join(repoRoot, "pkg/bin/bascik.js");
const AUDIT = path.join(repoRoot, "skills/bascik/scripts/audit-components.mjs");

export const MD = "content/semantic-html.md";

export interface SemanticDemo {
  id: string;
  /** The source blocks, in the order a reader sees them. */
  sources: string[];
  /** The generated block. */
  output: string;
  /** The docs component the Preview pane uses, byte-identical to the HTML block minus its path comment. */
  preview?: string;
}

export const DEMOS: SemanticDemo[] = [
  {
    id: "nav-bad",
    sources: ["semantic-nav-bad-usage", "semantic-nav-bad-html"],
    output: "semantic-nav-bad-output",
  },
  {
    id: "nav-good",
    sources: ["semantic-nav-good-usage", "semantic-nav-good-html"],
    output: "semantic-nav-good-output",
    preview: "src/components/site-nav/site-nav.html",
  },
  {
    id: "button",
    sources: ["semantic-button-usage", "semantic-button-html"],
    output: "semantic-button-output",
    preview: "src/components/like-button/like-button.html",
  },
  {
    id: "details",
    sources: ["semantic-details-usage", "semantic-details-html"],
    output: "semantic-details-output",
    preview: "src/components/faq-item/faq-item.html",
  },
];

/** The clickable <div> block (not a demo box: the page shows it as plain code) and the block quoting its finding. */
export const BAD_BUTTON_MARKER = "semantic-button-bad";
export const AUDIT_MARKER = "semantic-button-audit";

/** A page for the audit fixture, written the way the page teaches, so the only finding is the one quoted. */
const AUDIT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Likes</title>
  </head>
  <body>
    <main id="main">
      <h1>Likes</h1>
      <like-button />
    </main>
  </body>
</html>
`;

/** The fenced block after `<!-- <kind>:<marker> -->`, for both demo: and example: markers. */
export function markedBlock(md: string, kind: string, marker: string): string {
  const re = new RegExp(
    `<!--\\s*${kind}:${marker}\\s*-->\\s*\\n\\s*\`\`\`\\w*\\n([\\s\\S]*?)\\n?^\`\`\``,
    "m",
  );
  const code = re.exec(md)?.[1];
  if (code === undefined)
    throw new Error(`${MD}: no fenced block after ${kind}:${marker}`);
  return code;
}

async function block(marker: string): Promise<string> {
  const result = await readDemoBlock(path.join(DOCS_ROOT, MD), marker);
  if (result.code === undefined)
    throw new Error(`${MD} ${marker}: ${result.problem}`);
  return result.code;
}

/** A temp site under SCRATCH with node_modules/@bascik/bascik linked to the repository's pkg. */
function makeSite(
  scratch: string,
  name: string,
  files: Record<string, string>,
) {
  const site = path.join(scratch, name);
  const all: Record<string, string> = {
    "package.json":
      JSON.stringify({ name, private: true, type: "module" }, null, 2) + "\n",
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(site, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return site;
}

export interface SemanticDemoRun {
  /** The compiler's output for each demo id: the contents of <body>. */
  raw: Record<string, string>;
  /** The same text formatted as `prettier --write` formats a fence in the page's Markdown. */
  formatted: Record<string, string>;
  /** The audit's two lines for the clickable <div>: the finding and its fix, with the project path made relative. */
  audit: string;
  /** The temp directory, already removed. */
  scratch: string;
}

export async function runSemanticHtmlDemos(): Promise<SemanticDemoRun> {
  mkdirSync(SCRATCH, { recursive: true });
  const scratch = mkdtempSync(path.join(SCRATCH, "demos-"));
  try {
    // node_modules sits above the sites, as in a monorepo, so bascik.config.ts resolves @bascik/bascik.
    const scope = path.join(scratch, "node_modules/@bascik");
    mkdirSync(scope, { recursive: true });
    symlinkSync(path.join(repoRoot, "pkg"), path.join(scope, "bascik"), "dir");

    const raw: Record<string, string> = {};
    const formatted: Record<string, string> = {};
    for (const demo of DEMOS) {
      const files: Record<string, string> = { "bascik.config.ts": DEMO_CONFIG };
      for (const marker of demo.sources) {
        const code = await block(marker);
        files[pathComment(code)] = code + "\n";
      }
      const site = makeSite(scratch, demo.id, files);
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
      raw[demo.id] = extractBody(
        readFileSync(path.join(site, "dist/index.html"), "utf8"),
      );
      formatted[demo.id] = await formatAsMarkdownFence(raw[demo.id], MD);
    }

    const md = readFileSync(path.join(DOCS_ROOT, MD), "utf8");
    const bad = markedBlock(md, "example", BAD_BUTTON_MARKER);
    const auditSite = makeSite(scratch, "audit", {
      [pathComment(bad)]: bad + "\n",
      "src/pages/index.html": AUDIT_PAGE,
      "package.json":
        JSON.stringify(
          {
            name: "audit",
            private: true,
            type: "module",
            dependencies: { "@bascik/bascik": "*" },
          },
          null,
          2,
        ) + "\n",
    });
    const audited = spawnSync(process.execPath, [AUDIT, "--root", auditSite], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 60_000,
    });
    const lines = audited.stdout.split("\n");
    const at = lines.findIndex((line) => line.includes("clickable-element"));
    if (at === -1)
      throw new Error(
        `audit-components.mjs printed no clickable-element finding:\n${audited.stdout}\n${audited.stderr}`,
      );
    const audit = lines
      .slice(at, at + 2)
      .map((line) => line.trim())
      .join("\n");
    return { raw, formatted, audit, scratch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The text with each scoped instance hash (`bascik__name__1a2b3c4d__id`) replaced, since it depends on the build path. */
export function instanceHashesMasked(html: string): string {
  return html.replace(/(bascik__[a-z0-9-]+__)[0-9a-f]{8}(__)/g, "$1<hash>$2");
}
