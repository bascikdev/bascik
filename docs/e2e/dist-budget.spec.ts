// Checks the built site in docs/.e2e/dist (site.ts), which the web server command builds before the tests run. These
// are the page budgets from the docs performance work: what a visitor downloads and what each page costs to render.

import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { highlightCode } from "../src/lib/highlight.ts";
import {
  PUBLIC_SEARCH_INDEX_PATH,
  SEARCH_INDEX_FILE_PATTERN,
  SEARCH_INDEX_MAX_BYTES,
} from "../src/lib/search-index.ts";
import {
  headersForPath,
  parseHeaderRules,
  IMMUTABLE_CACHE_CONTROL,
} from "../src/lib/pages-headers.ts";
import { E2E_DIST_DIR } from "./site.ts";

const dist = E2E_DIST_DIR;

/** Most raw HTML bytes one page may have. components.html was 555 KB when every code block carried a highlighter. */
const MAX_PAGE_BYTES = 300_000;
/** Most inline script hashes in one page's Content-Security-Policy. It was 44 on components.html. */
const MAX_CSP_HASHES = 15;

function builtPages(): Array<{ path: string; html: string }> {
  return readdirSync(dist, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".html"))
    .map((file) => ({
      path: file,
      html: readFileSync(join(dist, file), "utf8"),
    }));
}

const decode = (text: string) =>
  text.replace(
    /&(lt|gt|amp|quot|#39);/g,
    (_entity, name: string) =>
      ({ lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'" })[name] as string,
  );

test.describe("built pages", () => {
  const pages = builtPages();

  test("stay under the size and script budgets", () => {
    expect(pages.length).toBeGreaterThan(100);
    const over: string[] = [];
    for (const { path, html } of pages) {
      const bytes = Buffer.byteLength(html);
      const hashes = html.match(/'sha256-/g)?.length ?? 0;
      // The highlighter runs at build time; a copy in the page means a block went back to highlighting itself.
      if (html.includes("function hlHtml"))
        over.push(`${path}: carries the code highlighter`);
      if (bytes > MAX_PAGE_BYTES) over.push(`${path}: ${bytes} bytes`);
      if (hashes > MAX_CSP_HASHES) over.push(`${path}: ${hashes} CSP hashes`);
    }
    expect(over).toEqual([]);
  });

  test("highlight every code block exactly as its language says", () => {
    let blocks = 0;
    let highlighted = 0;
    const wrong: string[] = [];
    const block =
      /data-testid="code-block"><div[^>]*><span[^>]*>([^<]*)<\/span>[\s\S]*?<code[^>]*data-cblock-code[^>]*>([\s\S]*?)<\/code>/g;
    for (const { path, html } of pages) {
      for (const [, lang, inner] of html.matchAll(block)) {
        blocks++;
        // An HTML comment here is a demo block that could not be read, which renders nothing either way.
        if (inner.startsWith("<!--")) continue;
        const text = decode(
          inner.replace(/<span data-code-token="[a-z]+">|<\/span>/g, ""),
        );
        const expected = highlightCode(text, decode(lang));
        if (inner.includes("data-code-token")) highlighted++;
        // Plain blocks may keep the escaped quotes marked writes; the text is the same.
        if (
          decode(inner) !== decode(expected) ||
          (expected.includes("data-code-token") && inner !== expected)
        )
          wrong.push(`${path} [${lang}]: ${JSON.stringify(text.slice(0, 60))}`);
      }
    }
    expect(blocks).toBeGreaterThan(500);
    expect(highlighted).toBeGreaterThan(blocks / 2);
    expect(wrong).toEqual([]);
  });

  test("let the browser skip style and layout far below the fold", () => {
    const cli = pages.find((page) => page.path === "cli.html")!.html;
    expect(cli).toMatch(
      /h2:nth-of-type\(4\) ?~ ?\.prose-codeblock\{content-visibility:auto;contain-intrinsic-block-size:auto \d+px/,
    );
  });

  test("load third-party scripts by exact version", () => {
    const unpinned: string[] = [];
    for (const { path, html } of pages)
      for (const [, src] of html.matchAll(
        /<script\b[^>]*?\bsrc="(https:\/\/unpkg\.com\/[^"]*)"/g,
      ))
        if (!/@\d+\.\d+\.\d+\/[\w./-]+\.js$/.test(src))
          unpinned.push(`${path}: ${src}`);
    expect(unpinned).toEqual([]);
  });
});

test.describe("speculation rules", () => {
  const sha256 = (text: string) =>
    `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

  test("every page carries one inline rule set that its Content-Security-Policy allows", () => {
    const pages = builtPages();
    expect(pages.length).toBeGreaterThan(100);
    const wrong: string[] = [];
    for (const { path, html } of pages) {
      const blocks = [
        ...html.matchAll(
          /<script\b[^>]*\btype=["']?speculationrules["']?[^>]*>([\s\S]*?)<\/script>/gi,
        ),
      ];
      if (blocks.length !== 1) {
        wrong.push(`${path}: ${blocks.length} speculationrules scripts`);
        continue;
      }
      const body = blocks[0][1];
      const policy =
        /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(
          html,
        )?.[1] ?? "";
      if (!policy.includes(sha256(body)))
        wrong.push(`${path}: the rules' hash is not in the page's policy`);
      let parsed: { prerender?: Array<Record<string, unknown>> };
      try {
        parsed = JSON.parse(body);
      } catch {
        wrong.push(`${path}: the rules are not JSON`);
        continue;
      }
      // The policy meta must come first, or the browser checks the rules before it knows the policy.
      if (html.indexOf("Content-Security-Policy") > blocks[0].index)
        wrong.push(`${path}: the rules come before the policy`);
      if (parsed.prerender?.[0]?.eagerness !== "moderate")
        wrong.push(`${path}: the rules do not prerender on hover`);
    }
    expect(wrong).toEqual([]);
  });

  test("prerender same-site pages on hover, never assets, search, files, or links within the page", () => {
    const html = readFileSync(join(dist, "cli.html"), "utf8");
    const body =
      /<script\b[^>]*\btype=["']?speculationrules["']?[^>]*>([\s\S]*?)<\/script>/i.exec(
        html,
      )?.[1] ?? "{}";
    const speculation = JSON.parse(body);
    expect(Object.keys(speculation)).toEqual(["prerender"]);
    expect(speculation.prerender).toHaveLength(1);
    const [rule] = speculation.prerender;
    expect(rule.source).toBe("document");
    expect(rule.eagerness).toBe("moderate");
    expect(rule.where).toEqual({
      and: [
        { href_matches: "/*" },
        { not: { href_matches: "/assets/*" } },
        { not: { href_matches: "/search*" } },
        { not: { href_matches: "/*\\.*" } },
        { not: { selector_matches: "a[href^='#']" } },
      ],
    });
  });
});

test.describe("search index", () => {
  /** The one content-hashed index in dist, as a site path. */
  const hashedIndex = () => {
    const names = readdirSync(join(dist, "assets")).filter((name) =>
      SEARCH_INDEX_FILE_PATTERN.test(name),
    );
    expect(names).toHaveLength(1);
    return `/assets/${names[0]}`;
  };

  test("is within budget and fetched by a file name carrying its content hash", () => {
    const path = hashedIndex();
    const json = readFileSync(join(dist, path));
    expect(json.length).toBeLessThanOrEqual(SEARCH_INDEX_MAX_BYTES);
    const version = createHash("sha256")
      .update(json)
      .digest("hex")
      .slice(0, 10);
    expect(path).toBe(`/assets/search-index.${version}.json`);
    // Every page that can search must ask for this exact version, or browsers keep a stale index for a year.
    const pages = builtPages().filter(({ html }) =>
      html.includes("/assets/search-index."),
    );
    expect(pages.length).toBeGreaterThan(100);
    const stale = pages
      .filter(({ html }) => !html.includes(`"${path}"`))
      .map(({ path }) => path);
    expect(stale).toEqual([]);
  });

  test("serves a plain array at the unversioned path for the agent skill scripts and older pages", () => {
    const legacy = JSON.parse(
      readFileSync(join(dist, PUBLIC_SEARCH_INDEX_PATH), "utf8"),
    );
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy.length).toBeGreaterThan(500);
    expect(legacy[0]).toMatchObject({ path: "/", heading: null });
  });
});

test.describe("Cloudflare Pages headers", () => {
  const rules = parseHeaderRules(readFileSync(join(dist, "_headers"), "utf8"));

  test("cache the hashed search index for a year and never send two Cache-Control values", () => {
    const hashed = readdirSync(join(dist, "assets")).find((name) =>
      SEARCH_INDEX_FILE_PATTERN.test(name),
    );
    expect(headersForPath(rules, `/assets/${hashed}`)["cache-control"]).toEqual(
      [IMMUTABLE_CACHE_CONTROL],
    );
    // Its contents change on every deploy, so a year-long cache would pin old results.
    expect(
      headersForPath(rules, PUBLIC_SEARCH_INDEX_PATH)["cache-control"] ?? [],
    ).not.toContain(IMMUTABLE_CACHE_CONTROL);
    const urls = readdirSync(dist, { recursive: true, encoding: "utf8" })
      .filter((file) => !file.startsWith(".") && !file.endsWith("_headers"))
      .map(
        (file) => `/${relative(dist, join(dist, file)).split("\\").join("/")}`,
      )
      .map((url) => (url.endsWith(".html") ? url.slice(0, -5) : url));
    const doubled = urls.filter(
      (url) => (headersForPath(rules, url)["cache-control"]?.length ?? 0) > 1,
    );
    expect(doubled).toEqual([]);
  });

  test("send no Speculation-Rules header: the rules are inline, so they cost no request before first paint", () => {
    const named = rules.filter((rule) =>
      rule.headers.some(([name]) => name.toLowerCase() === "speculation-rules"),
    );
    expect(named.map((rule) => rule.pattern)).toEqual([]);
    expect(headersForPath(rules, "/cli")["speculation-rules"]).toBeUndefined();
    expect(existsSync(join(dist, "assets/speculation-rules.json"))).toBe(false);
  });
});
