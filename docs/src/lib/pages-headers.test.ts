import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  pagesHeaders,
  pageFolders,
  parseHeaderRules,
  headersForPath,
  speculationRules,
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  PAGES_DEV_NOINDEX_RULE,
  SECURITY_HEADERS_RULE,
  SPECULATION_RULES_PATH,
} from "./pages-headers.ts";
import { VERSIONED_IMAGE_FOLDERS } from "./md-renderer.ts";
import {
  buildSearchEntries,
  searchIndexJson,
  searchIndexPath,
  PUBLIC_SEARCH_INDEX_PATH,
} from "./search-index.ts";
import config, { build } from "../../bascik.config.ts";

const SEARCH_INDEX_PATH = searchIndexPath(
  searchIndexJson(await buildSearchEntries()),
);

const siteHeaders = () =>
  pagesHeaders(VERSIONED_IMAGE_FOLDERS, {
    pageFolders: pageFolders(join(process.cwd(), "src/pages")),
    versionedFiles: [SEARCH_INDEX_PATH],
  });

/** Every URL the site serves: each page by its clean URL and each other file by its path. */
function siteUrls(): string[] {
  const pagesDir = join(process.cwd(), "src/pages");
  const urls = [
    "/",
    SEARCH_INDEX_PATH,
    PUBLIC_SEARCH_INDEX_PATH,
    SPECULATION_RULES_PATH,
  ];
  for (const entry of readdirSync(pagesDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = `/${relative(pagesDir, join(entry.parentPath, entry.name)).split(sep).join("/")}`;
    urls.push(path.endsWith(".html") ? path.slice(0, -5) : path);
  }
  return urls;
}

describe("pages-headers", () => {
  it("writes one immutable rule per versioned folder and file", () => {
    const headers = pagesHeaders(["/assets/demos/", "/assets/vscode/"], {
      versionedFiles: ["/assets/search-index.0123456789.json"],
    });
    expect(headers).toContain(
      `/assets/demos/*\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`,
    );
    expect(headers).toContain(
      `/assets/vscode/*\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`,
    );
    expect(headers).toContain(
      `/assets/search-index.0123456789.json\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`,
    );
    expect(
      headers.startsWith(
        `${SECURITY_HEADERS_RULE}\n${PAGES_DEV_NOINDEX_RULE}\n`,
      ),
    ).toBe(true);
  });

  it("caches the search index for a year, since its file name changes with its content", () => {
    expect(
      headersForPath(parseHeaderRules(siteHeaders()), SEARCH_INDEX_PATH),
    ).toMatchObject({
      "cache-control": [IMMUTABLE_CACHE_CONTROL],
    });
  });

  it("never caches the unversioned search index for a year, since its contents change on every deploy", () => {
    const rules = parseHeaderRules(siteHeaders());
    expect(
      headersForPath(rules, PUBLIC_SEARCH_INDEX_PATH)["cache-control"] ?? [],
    ).not.toContain(IMMUTABLE_CACHE_CONTROL);
    expect(
      headersForPath(rules, `${PUBLIC_SEARCH_INDEX_PATH}?v=0123456789`)[
        "cache-control"
      ] ?? [],
    ).not.toContain(IMMUTABLE_CACHE_CONTROL);
  });

  it("adds framing protection and safe response headers to every Pages response", () => {
    const headers = pagesHeaders([]);
    expect(headers).toContain(
      "/*\n  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
    expect(headers).toContain("  X-Frame-Options: DENY");
    expect(headers).toContain("  X-Content-Type-Options: nosniff");
    expect(headers).toContain(
      "  Referrer-Policy: strict-origin-when-cross-origin",
    );
  });

  it("keeps the pages.dev alias out of search results without touching the custom domain", () => {
    const headers = pagesHeaders([]);
    expect(headers).toContain(
      "https://:project.pages.dev/*\n  X-Robots-Tag: noindex",
    );
    // Path-only rules apply to every host, including bascik.dev, so noindex must never be path-only.
    const pathOnlyBlocks = headers
      .split("\n\n")
      .filter((block) => block.startsWith("/"));
    expect(pathOnlyBlocks.some((block) => block.includes("X-Robots-Tag"))).toBe(
      false,
    );
  });

  it("covers exactly the folders whose image URLs are versioned", () => {
    const immutable = parseHeaderRules(siteHeaders())
      .filter((rule) =>
        rule.headers.some(
          ([name, value]) =>
            name.toLowerCase() === "cache-control" &&
            value === IMMUTABLE_CACHE_CONTROL,
        ),
      )
      .map((rule) => rule.pattern);
    expect(immutable).toEqual([
      ...VERSIONED_IMAGE_FOLDERS.map((folder) => `${folder}*`),
      SEARCH_INDEX_PATH,
    ]);
  });

  it("matches rules the way Pages does: a placeholder is one path segment, a splat is the rest", () => {
    const rules = parseHeaderRules(
      "/:page\n  A: 1\n\n/docs/:page\n  B: 2\n\n/assets/*\n  C: 3\n\n/\n  D: 4\n",
    );
    expect(headersForPath(rules, "/cli")).toEqual({ a: ["1"] });
    expect(headersForPath(rules, "/docs/x")).toEqual({ b: ["2"] });
    expect(headersForPath(rules, "/docs/x/y")).toEqual({});
    expect(headersForPath(rules, "/assets/demos/x.webp")).toEqual({ c: ["3"] });
    expect(headersForPath(rules, "/")).toEqual({ d: ["4"] });
    // Pages joins a header set by two rules with a comma, so two values here is one broken header there.
    expect(
      headersForPath(parseHeaderRules("/*\n  A: 1\n\n/x\n  A: 2\n"), "/x"),
    ).toEqual({ a: ["1", "2"] });
  });

  it("lets pages be served from the browser cache while it checks for a new version, without keeping them stale", () => {
    // max-age=0 keeps every visit checking for a new deploy. stale-while-revalidate lets a repeat visit show the
    // cached page at once while that check runs. must-revalidate would forbid exactly that, so it is gone.
    expect(HTML_CACHE_CONTROL).toMatch(/\bmax-age=0\b/);
    expect(HTML_CACHE_CONTROL).toMatch(/\bstale-while-revalidate=\d+\b/);
    expect(HTML_CACHE_CONTROL).not.toContain("must-revalidate");
    const rules = parseHeaderRules(siteHeaders());
    for (const page of [
      "/",
      "/cli",
      "/deployment/cloudflare",
      "/how-to/content-security-policy",
    ]) {
      expect(headersForPath(rules, page)["cache-control"], page).toEqual([
        HTML_CACHE_CONTROL,
      ]);
    }
  });

  it("never gives a URL two Cache-Control values", () => {
    const rules = parseHeaderRules(siteHeaders());
    const urls = siteUrls();
    expect(urls.length).toBeGreaterThan(100);
    expect(urls).toContain("/assets/demos/lint@2x.webp");
    const doubled = urls.filter(
      (url) => (headersForPath(rules, url)["cache-control"]?.length ?? 0) > 1,
    );
    expect(doubled).toEqual([]);
  });

  it("names one rule for each folder of pages, and none for asset folders", () => {
    const folders = pageFolders(join(process.cwd(), "src/pages"));
    expect(folders).toContain("/deployment/");
    expect(folders).toContain("/how-to/");
    expect(folders.some((folder) => folder.startsWith("/assets"))).toBe(false);
  });

  it("points every page at the speculation rules, and serves them with the type browsers require", () => {
    const rules = parseHeaderRules(siteHeaders());
    for (const page of ["/", "/cli", "/deployment/cloudflare"])
      expect(headersForPath(rules, page)["speculation-rules"], page).toEqual([
        `"${SPECULATION_RULES_PATH}"`,
      ]);
    expect(
      headersForPath(rules, SPECULATION_RULES_PATH)["content-type"],
    ).toEqual(["application/speculationrules+json"]);
    // Images and other files are not documents, so they carry no rules.
    expect(
      headersForPath(rules, "/assets/demos/lint@2x.webp")["speculation-rules"],
    ).toBeUndefined();
  });

  it("prerenders same-site pages on hover, never assets, search, files, or links within the page", () => {
    const rules = speculationRules();
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules);
    expect(Object.keys(rules)).toEqual(["prerender"]);
    const [rule] = rules.prerender;
    expect(rule.source).toBe("document");
    expect(rule.eagerness).toBe("moderate");
    const text = JSON.stringify(rule.where);
    expect(text).toContain('{"href_matches":"/*"}');
    expect(text).toContain('{"not":{"href_matches":"/assets/*"}}');
    expect(text).toContain('{"not":{"href_matches":"/search*"}}');
    expect(text).toContain('{"not":{"href_matches":"/*\\\\.*"}}');
    expect(text).toContain('{"not":{"selector_matches":"a[href^=\'#\']"}}');
  });

  it("is generated by the build only, since dev has no CDN", () => {
    const script = "scripts/generate-pages-headers.ts";
    expect(build.pipeline?.exec?.some((entry) => entry.script === script)).toBe(
      true,
    );
    expect(
      config.pipeline?.exec?.some((entry) => entry.script === script),
    ).toBe(false);
  });
});
