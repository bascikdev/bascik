#!/usr/bin/env node
// Write dist/llms.txt (https://llmstxt.org) from the built pages: title, URL and description of every indexable
// page, grouped by the first path segment. Copy it into your project (it imports only node: built-ins), then
// register it as a post-phase exec script so it reads the finished output:
//
//   cp <skills-dir>/bascik-refactor/scripts/llms-txt.mjs scripts/llms-txt.mjs
//   pipeline: { exec: [{ script: "scripts/llms-txt.mjs", phase: "post" }] }
//
// It reads BASCIK_OUT_DIR, BASCIK_PAGES_DIR and BASCIK_BASE, and BASCIK_SITE_URL only when it is set. It skips dot
// folders, 404.html, 500.html and noindex pages, prefers each page's <link rel="canonical">, and leaves an authored
// src/pages/llms.txt alone. Dependency-free; Node.js 22.18+. Writes only <outDir>/llms.txt.
// The starter-site example (add-example.mjs starter-site/scripts/llms-txt.ts in the bascik skill) does the same job
// without groups; use whichever you prefer.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * True when the module at `metaUrl` is the script Node was asked to run (inlined so the file copies alone). Real
 * paths on both sides: Node resolves symlinks before setting import.meta.url, so argv[1] as typed would not match
 * through a symlinked folder and the script would exit 0 without doing anything.
 */
function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const HELP = `Usage: node llms-txt.mjs [--out-dir dist] [--pages-dir src/pages] [--site-url <origin>] [--base /]

Run it from pipeline.exec with phase "post"; Bascik passes the directories in BASCIK_OUT_DIR, BASCIK_PAGES_DIR,
BASCIK_BASE and (when set) BASCIK_SITE_URL. The flags override those variables for a manual run after a build.

Options:
  --out-dir <dir>     Built site (default $BASCIK_OUT_DIR)
  --pages-dir <dir>   Page sources, checked for an authored llms.txt (default $BASCIK_PAGES_DIR)
  --site-url <url>    Origin for absolute URLs when a page has no canonical (default $BASCIK_SITE_URL)
  --base <path>       Base path (default $BASCIK_BASE or /)
  --help              Show this message`;

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decode = (text) =>
  text
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === "#")
        return String.fromCodePoint(
          name[1].toLowerCase() === "x"
            ? parseInt(name.slice(2), 16)
            : Number(name.slice(1)),
        );
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();

/** Attributes of one start tag, quoted or not (minified output drops quotes). Names are lowercased. */
function attributes(tag) {
  const attrs = {};
  // An unquoted value may end in "/" (href=https://example.com/press/>), so only a "/" after a space or a quote
  // closes a void tag.
  const body = tag
    .replace(/^<[\w-]+/, "")
    .replace(/>$/, "")
    .replace(/(^|\s|["'])\/$/, "$1");
  for (const m of body.matchAll(
    /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  ))
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

/** Start tags by name, as literal patterns: only <meta> and <link> are read. */
const TAG_PATTERNS = { meta: /<meta\b[^>]*>/gi, link: /<link\b[^>]*>/gi };

const tags = (html, name) =>
  [...html.matchAll(TAG_PATTERNS[name])].map((m) => attributes(m[0]));

const title = (s) => {
  const words = s.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * One llms.txt entry for a built page, or null for an error page, a noindex page or a page without a <title>.
 * `relPath` is the file's path inside the output directory, such as "press/index.html".
 */
export function pageEntry(html, relPath, { siteUrl, base = "/" } = {}) {
  const rel = relPath.split(sep).join("/");
  if (/(^|\/)(404|500)\.html$/.test(rel)) return null;
  const metas = tags(html, "meta");
  if (
    metas.some(
      (m) =>
        /^(robots|googlebot)$/i.test(m.name ?? "") &&
        /\bnoindex\b/i.test(m.content ?? ""),
    )
  )
    return null;
  const pageTitle = decode(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "",
  );
  if (!pageTitle) return null;
  const description = decode(
    metas.find((m) => (m.name ?? "").toLowerCase() === "description")
      ?.content ?? "",
  );
  const path =
    "/" + rel.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
  const canonical = tags(html, "link").find((l) =>
    (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"),
  )?.href;
  const prefix =
    (siteUrl ? siteUrl.replace(/\/+$/, "") : "") +
    ("/" + base.replace(/^\/+|\/+$/g, "") + "/").replace(/\/+/g, "/");
  return {
    path,
    url: canonical ? decode(canonical) : prefix + path.slice(1),
    title: pageTitle,
    description,
    group: rel.includes("/") ? title(rel.split("/")[0]) : "Pages",
  };
}

// Backslashes are escaped along with the brackets: a title's own "\" before an escaped "]" would escape the escape,
// and the "]" would end the link text early.
const escapeLinkText = (s) => s.replace(/([\\[\]])/g, "\\$1");
// Whitespace or a parenthesis ends an inline link destination early, so percent-encode them. "%" is left alone so an
// already-encoded URL is not encoded twice.
const escapeLinkUrl = (s) =>
  s.replace(
    /[\s()]/g,
    // encodeURIComponent leaves "(" and ")" as they are; it gives non-ASCII spaces their UTF-8 bytes.
    (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)),
  );

/** llms.txt text: the home page title as H1 and its description as the summary, then one section per group. */
export function renderLlmsTxt(entries) {
  const home = entries.find((e) => e.path === "/");
  const lines = [`# ${home?.title ?? "Site"}`, ""];
  if (home?.description) lines.push(`> ${home.description}`, "");
  const groups = new Map();
  for (const e of entries)
    (groups.get(e.group) ?? groups.set(e.group, []).get(e.group)).push(e);
  const order = [...groups.keys()].sort((a, b) =>
    a === "Pages" ? -1 : b === "Pages" ? 1 : a.localeCompare(b),
  );
  for (const group of order) {
    lines.push(`## ${group}`, "");
    const items = groups
      .get(group)
      .sort((a, b) =>
        a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path),
      );
    for (const e of items)
      lines.push(
        `- [${escapeLinkText(e.title)}](${escapeLinkUrl(e.url)})${e.description ? `: ${e.description}` : ""}`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

function htmlFiles(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full, root));
    else if (entry.name.endsWith(".html")) out.push(relative(root, full));
  }
  return out.sort();
}

/** Crawls outDir and writes outDir/llms.txt, unless pagesDir has an authored llms.txt. */
export function writeLlmsTxt({ outDir, pagesDir, siteUrl, base = "/" }) {
  if (!outDir || !existsSync(outDir))
    throw new Error(
      `the output directory ${outDir} does not exist; run this as a post exec script after the build (BASCIK_OUT_DIR)`,
    );
  if (pagesDir && existsSync(join(pagesDir, "llms.txt")))
    return {
      written: false,
      count: 0,
      reason: `${join(pagesDir, "llms.txt")} is authored; the built copy stays as it is`,
    };
  const entries = htmlFiles(outDir)
    .map((rel) =>
      pageEntry(readFileSync(join(outDir, rel), "utf8"), rel, {
        siteUrl,
        base,
      }),
    )
    .filter(Boolean);
  const file = join(outDir, "llms.txt");
  writeFileSync(file, renderLlmsTxt(entries));
  return { written: true, count: entries.length, file };
}

/** Options from the exec script environment Bascik provides. BASCIK_SITE_URL is absent unless set. */
export function optionsFromEnv(env = process.env) {
  return {
    outDir: env.BASCIK_OUT_DIR,
    pagesDir: env.BASCIK_PAGES_DIR,
    base: env.BASCIK_BASE || "/",
    siteUrl: env.BASCIK_SITE_URL || undefined,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      "out-dir": { type: "string" },
      "pages-dir": { type: "string" },
      "site-url": { type: "string" },
      base: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  const env = optionsFromEnv();
  const options = {
    outDir: values["out-dir"] ?? env.outDir,
    pagesDir: values["pages-dir"] ?? env.pagesDir,
    siteUrl: values["site-url"] ?? env.siteUrl,
    base: values.base ?? env.base,
  };
  if (!options.outDir)
    throw new Error(
      "BASCIK_OUT_DIR is not set: run this from pipeline.exec, or pass --out-dir dist",
    );
  const result = writeLlmsTxt(options);
  console.log(
    result.written
      ? `llms-txt: wrote ${result.count} pages to ${result.file}`
      : `llms-txt: skipped, ${result.reason}`,
  );
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(`llms-txt: ${error.message}`);
  }
}
