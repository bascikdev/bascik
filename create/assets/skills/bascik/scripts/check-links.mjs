#!/usr/bin/env node
// Find broken internal links, missing assets, and dead #fragments in the built site. Dependency-free; Node 22.18+.
// Run from the project root after `bascik --build`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Usage: node check-links.mjs [--dist dist] [--ignore /api/] [--site-url https://example.com] [--json]

Checks every href, src, srcset, and poster in dist/**/*.html that points inside the site:
  - the target page or file exists in the build output (/about -> about.html or about/index.html)
  - a #fragment exists as an id (or name) on the target page
External links are not fetched. Links under /api/ are skipped by default (API routes are not files).
The deployment base comes from bascik.config; links outside it are reported.

Options:
  --dist <dir>       Build output directory (default: directory.out, else dist)
  --ignore <prefix>  Skip internal paths starting with this prefix (repeatable; /api/ is always skipped)
  --site-url <url>   Treat absolute links to this origin as internal (default: BASCIK_SITE_URL)
  --json             Print JSON
  --help             Show this message`;

const ATTRS = ["href", "src", "srcset", "poster", "data"];
const decode = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Every link-like reference in a page, with the attribute it came from. Exported for tests. */
export function extractLinks(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<(template|textarea|code|pre)\b[\s\S]*?<\/\1>/gi, "");
  const links = [];
  for (const tag of cleaned.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    for (const attr of tag[2].matchAll(
      /([^\s=/"'>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    )) {
      const name = attr[1].toLowerCase();
      if (!ATTRS.includes(name)) continue;
      const value = decode(attr[2] ?? attr[3] ?? attr[4] ?? "").trim();
      if (!value) continue;
      if (name === "srcset") {
        for (const candidate of value.split(",")) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) links.push({ tag: tag[1].toLowerCase(), attr: name, url });
        }
      } else {
        links.push({ tag: tag[1].toLowerCase(), attr: name, url: value });
      }
    }
  }
  return links;
}

/** Every id and name in a page, for fragment checks. Exported for tests. */
export function extractAnchors(html) {
  const anchors = new Set();
  for (const m of html.matchAll(
    /\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
  ))
    anchors.add(decode(m[1] ?? m[2] ?? m[3]));
  return anchors;
}

/**
 * Resolve a link to { path, fragment } inside the site, or { skip } for external and non-file links.
 * `pageUrl` is the page's own base-including path, such as "/docs/blog/post/". Exported for tests.
 */
export function resolveLink(url, pageUrl, { origin, base = "/" } = {}) {
  if (/^(mailto|tel|sms|data|javascript|blob):/i.test(url))
    return { skip: "scheme" };
  let target;
  try {
    const page = new URL(pageUrl, "http://site.invalid");
    const resolved = new URL(url, page);
    const sameOrigin =
      resolved.origin === "http://site.invalid" ||
      (origin && resolved.origin === new URL(origin).origin);
    if (!sameOrigin) return { skip: "external" };
    target = resolved;
  } catch {
    return { error: `unparsable URL ${url}` };
  }
  let path;
  try {
    path = decodeURIComponent(target.pathname);
  } catch {
    return { error: `malformed percent-encoding in ${url}` };
  }
  const prefix = base.replace(/\/$/, "");
  if (prefix && path !== prefix && !path.startsWith(`${prefix}/`))
    return { error: `outside the deployment base ${base}` };
  return {
    path: path.slice(prefix.length) || "/",
    fragment: target.hash ? decodeURIComponent(target.hash.slice(1)) : "",
  };
}

/** The dist file a site path is served from, or undefined. Mirrors Bascik's page and asset lookup. Exported for tests. */
export function fileFor(path, exists) {
  const clean = path.replace(/^\/+/, "");
  const candidates =
    path.endsWith("/") || clean === ""
      ? [`${clean}index.html`]
      : [clean, `${clean}.html`, `${clean}/index.html`];
  return candidates.find((candidate) => exists(candidate));
}

/** Check a set of { file, html } pages. Exported for tests. */
export function checkSite(
  pages,
  { exists, origin, base = "/", ignore = [] } = {},
) {
  const byFile = new Map(pages.map((page) => [page.file, page]));
  const anchors = new Map();
  const anchorsOf = (file) => {
    if (!anchors.has(file))
      anchors.set(file, extractAnchors(byFile.get(file)?.html ?? ""));
    return anchors.get(file);
  };
  const prefixes = ["/api/", ...ignore];
  const problems = [];
  let checked = 0;
  for (const page of pages) {
    const pageUrl = `${base.replace(/\/$/, "")}${pageUrlOf(page.file)}`;
    for (const link of extractLinks(page.html)) {
      const result = resolveLink(link.url, pageUrl, { origin, base });
      if (result.skip) continue;
      checked++;
      if (result.error) {
        problems.push({
          page: page.file,
          url: link.url,
          message: result.error,
        });
        continue;
      }
      if (prefixes.some((prefix) => result.path.startsWith(prefix))) continue;
      const file = fileFor(result.path, exists);
      if (!file) {
        problems.push({
          page: page.file,
          url: link.url,
          message: `no page or file at ${result.path}`,
        });
        continue;
      }
      if (
        result.fragment &&
        file.endsWith(".html") &&
        !anchorsOf(file).has(result.fragment)
      ) {
        problems.push({
          page: page.file,
          url: link.url,
          message: `${file} has no element with id "${result.fragment}"`,
        });
      }
    }
  }
  return { checked, problems };
}

/** The URL path a dist-relative HTML file is served at (without the base). */
function pageUrlOf(file) {
  if (file === "index.html") return "/";
  if (file.endsWith("/index.html"))
    return `/${file.slice(0, -"index.html".length)}`;
  return `/${file.replace(/\.html$/, "")}`;
}

function htmlFiles(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, root, out);
    else if (entry.name.endsWith(".html"))
      out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

function findRoot(start) {
  let dir = resolve(start);
  while (true) {
    if (
      ["bascik.config.js", "bascik.config.ts", "package.json"].some((f) =>
        existsSync(join(dir, f)),
      )
    )
      return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      dist: { type: "string" },
      ignore: { type: "string", multiple: true, default: [] },
      "site-url": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const root = findRoot(process.cwd());
  let config = {};
  for (const file of ["bascik.config.js", "bascik.config.ts"]) {
    if (existsSync(join(root, file))) {
      config =
        (await import(pathToFileURL(join(root, file)).href)).default ?? {};
      break;
    }
  }
  const dist = resolve(root, values.dist ?? config.directory?.out ?? "dist");
  if (!existsSync(dist)) {
    process.stderr.write(
      `check-links: ${relative(root, dist) || dist} does not exist. Run \`bascik --build\` first.\n`,
    );
    process.exit(1);
  }
  const rawBase = typeof config.base === "string" ? config.base : "/";
  const base = `/${rawBase.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
  const pages = htmlFiles(dist).map((file) => ({
    file,
    html: readFileSync(join(dist, file), "utf8"),
  }));
  const exists = (rel) => {
    const full = join(dist, rel);
    return full.startsWith(dist) && existsSync(full) && statSync(full).isFile();
  };
  const { checked, problems } = checkSite(pages, {
    exists,
    origin: values["site-url"] ?? process.env.BASCIK_SITE_URL,
    base,
    ignore: values.ignore,
  });

  if (values.json) {
    console.log(
      JSON.stringify({ dist, pages: pages.length, checked, problems }, null, 2),
    );
  } else {
    console.log(`Checked ${checked} internal links in ${pages.length} pages.`);
    for (const p of problems)
      console.log(`  ${p.page}  ${p.url}  ${p.message}`);
    console.log(
      problems.length
        ? `\n${problems.length} broken link${problems.length === 1 ? "" : "s"}.`
        : "No broken links.",
    );
  }
  process.exitCode = problems.length ? 1 : 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
