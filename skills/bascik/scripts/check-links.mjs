#!/usr/bin/env node
// Find broken internal links, missing assets, and dead #fragments in the built site. Dependency-free; Node 22.22+.
// Run from the project root after `bascik --build`.
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  text.replace(
    /&(?:quot|#39|lt|gt|amp);/g,
    (entity) =>
      ({ "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" })[
        entity
      ],
  );

/** Every link-like reference in a page, with the attribute it came from. Exported for tests. */
export function extractLinks(html) {
  const links = [];
  const scan = (fragment) => {
    for (const tag of fragment.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
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
  };
  // Scan disjoint visible regions. Removing markup and joining the leftovers can
  // turn <scr<script>ipt> into a new <script> on the next pass.
  const lower = html.toLowerCase();
  let from = 0;
  const ignored = /<!--|<(script|template|textarea|code|pre)\b[^>]*>/gi;
  let match;
  while ((match = ignored.exec(html))) {
    if (match.index < from) continue;
    scan(html.slice(from, match.index));
    if (!match[1]) {
      const end = html.indexOf("-->", ignored.lastIndex);
      from = end < 0 ? html.length : end + 3;
    } else {
      const name = match[1].toLowerCase();
      // External scripts have a real src link; their contents are still inert.
      if (name === "script" && /\bsrc\s*=/i.test(match[0])) scan(match[0]);
      let close = lower.indexOf(`</${name}`, ignored.lastIndex);
      while (close >= 0 && !/[\s/>]/.test(lower[close + name.length + 2] ?? ""))
        close = lower.indexOf(`</${name}`, close + name.length + 2);
      const end = close < 0 ? -1 : html.indexOf(">", close + name.length + 2);
      from = end < 0 ? html.length : end + 1;
    }
    ignored.lastIndex = from;
  }
  scan(html.slice(from));
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
 * The origin of a site URL such as https://example.com/docs/. Throws, naming the value, when it is not an absolute
 * http(s) URL: a schemeless "example.com" would otherwise make every absolute link look unparsable. Exported for tests.
 */
export function siteOriginOf(siteUrl) {
  let url;
  try {
    url = new URL(siteUrl);
  } catch {
    url = undefined;
  }
  if (!url || !/^https?:$/.test(url.protocol))
    throw new Error(
      `must be an absolute http(s) URL such as https://example.com, got "${siteUrl}"`,
    );
  return url.origin;
}

/**
 * Resolve a link to { path, fragment } inside the site, or { skip } for external and non-file links.
 * `pageUrl` is the page's own base-including path, such as "/docs/blog/post/". Exported for tests.
 */
export function resolveLink(url, pageUrl, { origin, base = "/" } = {}) {
  if (/^(mailto|tel|sms|data|javascript|blob):/i.test(url))
    return { skip: "scheme" };
  // Outside the try below: a bad site URL is the caller's mistake, not this link's.
  const siteOrigin = origin ? siteOriginOf(origin) : undefined;
  let target;
  try {
    const page = new URL(pageUrl, "http://site.invalid");
    const resolved = new URL(url, page);
    const sameOrigin =
      resolved.origin === "http://site.invalid" ||
      resolved.origin === siteOrigin;
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
  // Checked once up front, so a bad site URL throws even on a site with no absolute links.
  const siteOrigin = origin ? siteOriginOf(origin) : undefined;
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
      const result = resolveLink(link.url, pageUrl, {
        origin: siteOrigin,
        base,
      });
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
      [
        "bascik.config.js",
        "bascik.config.mjs",
        "bascik.config.ts",
        "package.json",
      ].some((f) => existsSync(join(dir, f)))
    )
      return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

async function main() {
  const { values } = parseCliArgs("check-links", {
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
  for (const file of [
    "bascik.config.js",
    "bascik.config.mjs",
    "bascik.config.ts",
  ]) {
    if (existsSync(join(root, file))) {
      try {
        config =
          (await import(pathToFileURL(join(root, file)).href)).default ?? {};
      } catch (error) {
        process.stderr.write(
          `check-links: could not load ${file}: ${error.message}\n`,
        );
        process.exit(1);
      }
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
  const siteUrlSource =
    values["site-url"] !== undefined ? "--site-url" : "BASCIK_SITE_URL";
  const siteUrl = values["site-url"] ?? process.env.BASCIK_SITE_URL;
  if (siteUrl) {
    try {
      siteOriginOf(siteUrl);
    } catch (error) {
      process.stderr.write(`check-links: ${siteUrlSource} ${error.message}\n`);
      process.exit(2);
    }
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
    origin: siteUrl,
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

// Compare real paths: Node resolves symlinks in the main module's path before it sets import.meta.url, so comparing it
// with argv[1] as typed made the script a silent no-op (exit 0, no output) whenever a folder on the path was a symlink
// or junction, such as the skills CLI's install into .claude/skills.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  }
})();
if (invokedDirectly) await main();

/**
 * `parseArgs`, with a short message naming the flag and the valid ones, and
 * exit code 2, in place of Node's stack trace on a mistyped or missing flag.
 */
function parseCliArgs(name, config) {
  try {
    return parseArgs(config);
  } catch (error) {
    if (!String(error?.code).startsWith("ERR_PARSE_ARGS_")) throw error;
    const valid = Object.entries(config.options ?? {})
      .map(
        ([long, option]) =>
          `${option.short ? `-${option.short}, ` : ""}--${long}`,
      )
      .join(", ");
    const flag = /'([^']+)'/.exec(error.message)?.[1];
    const problem =
      error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && flag
        ? `unknown option "${flag}"`
        : error.message.split(". ")[0].replace(/\.$/, "");
    process.stderr.write(
      `${name}: ${problem}. Valid options: ${valid}. Run with --help.\n`,
    );
    process.exit(2);
  }
}
