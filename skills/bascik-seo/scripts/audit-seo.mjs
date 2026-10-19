#!/usr/bin/env node
// Audit built pages in dist/ for the head tags and structure that search engines, social cards, and Lighthouse
// SEO check. Dependency-free; Node.js 22.18+. Run from the project root after `bascik --build`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Usage: node audit-seo.mjs [--dist dist] [--site-url https://example.com] [--strict] [--json]

Checks every HTML page in the build output:
  error  missing <title>, meta description, lang, or viewport; invalid JSON-LD; relative canonical or og:image
  warn   duplicate titles or descriptions, odd lengths, not exactly one <h1>, images without alt,
         missing canonical or Open Graph tags, canonical that points at another page, missing sitemap.xml/robots.txt
  info   noindex pages (warn when one is still listed in sitemap.xml), missing og:image

404.html and 500.html are only checked for title, lang, and viewport.
The site URL comes from --site-url, BASCIK_SITE_URL, or .env. Exit code 1 on errors (or warnings with --strict).

Options:
  --dist <dir>       Build output directory (default: directory.out from bascik.config, else dist)
  --site-url <url>   Expected origin for canonical URLs
  --strict           Fail on warnings too
  --json             Print JSON
  --help             Show this message`;

const decode = (text) =>
  text
    .replace(
      /&(?:quot|#39|lt|gt|amp);/g,
      (entity) =>
        ({
          "&quot;": '"',
          "&#39;": "'",
          "&lt;": "<",
          "&gt;": ">",
          "&amp;": "&",
        })[entity],
    )
    .replace(/\s+/g, " ")
    .trim();

/** Attributes of every tag with the given name. */
function tags(html, name) {
  const out = [];
  for (const match of html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))) {
    const attrs = {};
    for (const attr of match[1].matchAll(
      /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
    )) {
      attrs[attr[1].toLowerCase()] = decode(
        attr[2] ?? attr[3] ?? attr[4] ?? "",
      );
    }
    out.push(attrs);
  }
  return out;
}

/** Facts about one page. Exported for tests. */
export function inspectPage(html) {
  const metas = tags(html, "meta");
  const metaBy = (key, value) =>
    metas.find((m) => (m[key] ?? "").toLowerCase() === value)?.content;
  // Preserve boundaries between visible regions, rather than joining text on
  // either side of a removed element into a new tag on another pass.
  const lower = html.toLowerCase();
  const visible = [];
  const opening = /<(script|style)\b[^>]*>/gi;
  let from = 0;
  let match;
  while ((match = opening.exec(html))) {
    if (match.index < from) continue;
    visible.push(html.slice(from, match.index));
    const name = match[1].toLowerCase();
    let close = lower.indexOf(`</${name}`, opening.lastIndex);
    while (close >= 0 && !/[\s/>]/.test(lower[close + name.length + 2] ?? ""))
      close = lower.indexOf(`</${name}`, close + name.length + 2);
    const end = close < 0 ? -1 : html.indexOf(">", close + name.length + 2);
    from = end < 0 ? html.length : end + 1;
    opening.lastIndex = from;
  }
  visible.push(html.slice(from));
  const body = visible.join(" ");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const jsonLd = [
    ...html.matchAll(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((m) => m[1]);
  return {
    lang: tags(html, "html")[0]?.lang,
    title: titleMatch ? decode(titleMatch[1]) : undefined,
    description: metaBy("name", "description"),
    viewport: metaBy("name", "viewport"),
    robots: metaBy("name", "robots"),
    canonical: tags(html, "link").find((l) =>
      (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"),
    )?.href,
    og: {
      title: metaBy("property", "og:title"),
      description: metaBy("property", "og:description"),
      url: metaBy("property", "og:url"),
      image: metaBy("property", "og:image"),
    },
    h1Count: (body.match(/<h1\b/gi) ?? []).length,
    imagesWithoutAlt: tags(body, "img").filter((img) => !("alt" in img)).length,
    jsonLd,
  };
}

/** Run every check over { path, file, html } pages. Exported for tests. */
export function auditPages(
  pages,
  {
    siteUrl,
    base = "/",
    hasSitemap = true,
    hasRobots = true,
    sitemapUrls = [],
  } = {},
) {
  const findings = [];
  const add = (level, page, message) => findings.push({ level, page, message });
  const facts = pages.map((page) => ({ ...page, ...inspectPage(page.html) }));
  const isErrorPage = (page) => /^(404|500)\.html$/.test(page.file);
  const origin = siteUrl?.replace(/\/+$/, "");
  const baseNoSlash = base.replace(/\/$/, "");

  for (const page of facts) {
    if (!page.lang) add("error", page.path, "<html> has no lang attribute");
    if (!page.viewport)
      add("error", page.path, 'missing <meta name="viewport">');
    if (!page.title) add("error", page.path, "missing or empty <title>");
    if (isErrorPage(page)) continue;
    if (page.robots && /noindex/i.test(page.robots)) {
      add("info", page.path, "marked noindex (kept out of search results)");
      const listed = sitemapUrls.some(
        (loc) => loc === `${origin}${baseNoSlash}${page.path}`,
      );
      if (origin && listed) {
        add(
          "warn",
          page.path,
          'noindex page is listed in sitemap.xml; add <meta name="bascik-sitemap" content="exclude" /> to the page source',
        );
      }
    }

    if (page.title && (page.title.length < 10 || page.title.length > 65)) {
      add(
        "warn",
        page.path,
        `title is ${page.title.length} characters; aim for 10 to 65: "${page.title}"`,
      );
    }
    if (!page.description)
      add("error", page.path, 'missing <meta name="description">');
    else if (page.description.length < 50 || page.description.length > 160) {
      add(
        "warn",
        page.path,
        `description is ${page.description.length} characters; aim for 50 to 160`,
      );
    }
    if (page.h1Count !== 1)
      add(
        "warn",
        page.path,
        `has ${page.h1Count} <h1> elements; use exactly one`,
      );
    if (page.imagesWithoutAlt)
      add(
        "warn",
        page.path,
        `${page.imagesWithoutAlt} <img> without alt (use alt="" for decorative images)`,
      );

    if (!page.canonical)
      add(origin ? "warn" : "info", page.path, 'no <link rel="canonical">');
    else if (!/^https?:\/\//i.test(page.canonical))
      add(
        "error",
        page.path,
        `canonical must be an absolute URL: ${page.canonical}`,
      );
    else if (origin) {
      const expected = `${origin}${baseNoSlash}${page.path}`;
      if (
        page.canonical !== expected &&
        page.canonical !== expected.replace(/\/$/, "")
      ) {
        add(
          "warn",
          page.path,
          `canonical ${page.canonical} does not point at this page (${expected})`,
        );
      }
    }

    for (const key of ["title", "description", "url"]) {
      if (!page.og[key]) add("warn", page.path, `missing og:${key}`);
    }
    if (!page.og.image)
      add("info", page.path, "no og:image; shared links get no preview image");
    else if (!/^https?:\/\//i.test(page.og.image))
      add(
        "error",
        page.path,
        `og:image must be an absolute URL: ${page.og.image}`,
      );

    page.jsonLd.forEach((block, index) => {
      try {
        const data = JSON.parse(block);
        const items = Array.isArray(data) ? data : [data];
        if (items.some((item) => !item["@context"] && !data["@context"]))
          add("warn", page.path, `JSON-LD block ${index + 1} has no @context`);
      } catch (error) {
        add(
          "error",
          page.path,
          `JSON-LD block ${index + 1} is not valid JSON: ${error.message}`,
        );
      }
    });
  }

  for (const key of ["title", "description"]) {
    const seen = new Map();
    for (const page of facts.filter((p) => !isErrorPage(p) && p[key]))
      seen.set(page[key], [...(seen.get(page[key]) ?? []), page.path]);
    for (const [value, paths] of seen) {
      if (paths.length > 1)
        add(
          "warn",
          paths.join(", "),
          `share the same ${key}: "${value.slice(0, 80)}"`,
        );
    }
  }
  if (!hasSitemap)
    add(
      "warn",
      "sitemap.xml",
      "not found; set BASCIK_SITE_URL when building so Bascik generates it",
    );
  if (!hasRobots)
    add(
      "warn",
      "robots.txt",
      "not found; set BASCIK_SITE_URL when building so Bascik generates it",
    );
  return findings;
}

function htmlFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, out);
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

/** "/", "/about", or "/blog/post/" for a dist-relative HTML file. Exported for tests. */
export function pagePathOf(rel) {
  const path = rel.split(sep).join("/");
  if (path === "index.html") return "/";
  if (path.endsWith("/index.html"))
    return `/${path.slice(0, -"index.html".length)}`;
  return `/${path.replace(/\.html$/, "")}`;
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
      "site-url": { type: "string" },
      strict: { type: "boolean", default: false },
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
      `audit-seo: ${relative(root, dist) || dist} does not exist. Run \`bascik --build\` first.\n`,
    );
    process.exit(1);
  }
  const envFile = join(root, ".env");
  const fromEnvFile = existsSync(envFile)
    ? /^BASCIK_SITE_URL=["']?([^"'\n]+)/m.exec(
        readFileSync(envFile, "utf8"),
      )?.[1]
    : undefined;
  const siteUrl =
    values["site-url"] ?? process.env.BASCIK_SITE_URL ?? fromEnvFile;
  const rawBase = typeof config.base === "string" ? config.base : "/";
  const base = `/${rawBase.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");

  const pages = htmlFiles(dist).map((file) => {
    const rel = relative(dist, file);
    return {
      file: rel.split(sep).join("/"),
      path: pagePathOf(rel),
      html: readFileSync(file, "utf8"),
    };
  });
  const sitemapFile = join(dist, "sitemap.xml");
  const sitemapUrls = existsSync(sitemapFile)
    ? [
        ...readFileSync(sitemapFile, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g),
      ].map((m) => decode(m[1]))
    : [];
  const findings = auditPages(pages, {
    siteUrl,
    base,
    sitemapUrls,
    hasSitemap: existsSync(sitemapFile),
    hasRobots: existsSync(join(dist, "robots.txt")),
  });

  if (values.json) {
    console.log(
      JSON.stringify(
        { dist, siteUrl: siteUrl ?? null, pages: pages.length, findings },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Checked ${pages.length} pages in ${relative(root, dist) || dist}${siteUrl ? ` for ${siteUrl}` : ""}.`,
    );
    for (const level of ["error", "warn", "info"]) {
      for (const f of findings.filter((x) => x.level === level))
        console.log(`  ${level.padEnd(5)}  ${f.page}  ${f.message}`);
    }
    const counts = ["error", "warn", "info"].map(
      (level) => `${findings.filter((f) => f.level === level).length} ${level}`,
    );
    console.log(
      findings.length ? `\n${counts.join(", ")}` : "No SEO problems found.",
    );
  }
  const failed = findings.some(
    (f) => f.level === "error" || (values.strict && f.level === "warn"),
  );
  process.exitCode = failed ? 1 : 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
