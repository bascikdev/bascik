/**
 * Links to the live Cloudflare demo (cloudflare-adapter.bascik.dev) for returning component tags.
 *
 * The demo is the Cloudflare adapter's e2e fixture (adapters/cloudflare/e2e/fixture), deployed when the branch is
 * merged. Until then its pages 404, so this test NEVER fetches a URL: it only maps each URL to a page in the
 * fixture's src/pages.
 *
 * 1. Every cloudflare-adapter.bascik.dev URL in the docs, the skills, and the adapter's npm README names a page
 *    that exists in the fixture (the query string and hash are ignored).
 * 2. Each place a reader learns about returning component tags points at the live /catalog or /catalog-stream page.
 * 3. No paragraph links the same URL twice, and the top callouts use the "See it live" style.
 * 4. The retired demo product word (RETIRED_WORD below) appears nowhere a reader or the demo can see it: it
 *    reads as the name of a dating app. The example product is the "Milk frother" and the query is ?q=frother.
 *
 * Misuse lens: a typo'd demo path, a renamed fixture page, a pointer dropped in an edit, and the old product name
 * left behind in one copy.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DOCS_ROOT = path.resolve(import.meta.dirname, "../..");
const REPO_ROOT = path.resolve(DOCS_ROOT, "..");
const FIXTURE = path.join(REPO_ROOT, "adapters/cloudflare/e2e/fixture");
const FIXTURE_PAGES = path.join(FIXTURE, "src/pages");
const DEMO_ORIGIN = "https://cloudflare-adapter.bascik.dev";
const README = "adapters/cloudflare/README.md";
const CALLOUT = "> **See it live on Cloudflare Workers.**";

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Every file under `rel` (repo-relative), skipping build output and dependencies. */
const walk = (rel: string): string[] => {
  const abs = path.join(REPO_ROOT, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "node_modules", ".wrangler", ".bascik"].includes(entry.name))
      return [];
    const child = path.join(rel, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
};

const isText = (rel: string) =>
  /\.(md|html|css|js|mjs|cjs|ts|json|txt|toml|jsonc|yaml|yml)$/i.test(rel);

/** Every demo URL in a text, without trailing Markdown punctuation. */
const demoUrls = (text: string): string[] =>
  [
    ...text.matchAll(
      /https:\/\/cloudflare-adapter\.bascik\.dev(?:\/[^\s)"'<>\]`]*)?/g,
    ),
  ].map((m) => m[0].replace(/[.,;:]+$/, ""));

/** The fixture page a demo URL names, or null when none exists. */
const fixturePageFor = (url: string): string | null => {
  const { pathname } = new URL(url);
  const clean = decodeURIComponent(pathname).replace(/\/+$/, "");
  const candidates =
    clean === ""
      ? ["index.html"]
      : [
          `${clean.slice(1)}.html`,
          `${clean.slice(1)}/index.html`,
          clean.slice(1),
        ];
  for (const candidate of candidates) {
    const abs = path.join(FIXTURE_PAGES, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  // An API route: /api/ping is src/api/ping.ts (the api-routes page links one directly).
  if (clean.startsWith("/api/")) {
    const route = path.join(FIXTURE, "src", `${clean.slice(1)}.ts`);
    if (existsSync(route)) return path.relative(FIXTURE_PAGES, route);
  }
  return null;
};

/** The part of `markdown` under the first heading whose text is `heading`, up to the next heading at its level or above. */
const section = (markdown: string, heading: RegExp): string => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    return m !== null && heading.test(m[2]);
  });
  expect(start, `a heading matching ${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    const m = !inFence && /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
};

/** The text of a section from its heading up to its first sub-heading. */
const sectionTop = (text: string): string => {
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    if (!inFence && /^#{1,6}\s/.test(lines[i]))
      return lines.slice(0, i).join("\n");
  }
  return text;
};

/** Removes every demo block (marker, an optional prettier-ignore line, and its fence). */
const stripDemoBlocks = (md: string): string =>
  md.replace(
    /<!--\s*demo:[\w-]+\s*-->\s*\n(?:\s*<!--\s*prettier-ignore\s*-->\s*\n)?\s*```[\w-]*\n[\s\S]*?\n```/g,
    "",
  );

/** The last paragraph of a section once its demo blocks are removed: the line printed right before the demo box. */
const lastParagraph = (text: string): string => {
  const paragraphs = stripDemoBlocks(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs[paragraphs.length - 1] ?? "";
};

/** Demo URLs in `text` whose path is `pathname` (any query). */
const linksTo = (text: string, pathname: string): string[] =>
  demoUrls(text).filter((url) => new URL(url).pathname === pathname);

/**
 * Splits Markdown into the units a reader sees as one paragraph: blocks separated by blank lines (a lone `>` in a
 * blockquote counts as blank), with each list item on its own.
 */
const paragraphs = (md: string): string[] => {
  const units: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length) units.push(current.join("\n"));
    current = [];
  };
  for (const line of md.split("\n")) {
    if (/^\s*(?:>\s*)?```/.test(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (/^\s*>?\s*$/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*(?:>\s*)?(?:[-*+]|\d+\.)\s/.test(line)) flush();
    current.push(line);
  }
  flush();
  return units;
};

const DOC_FILES = walk("docs/content").filter((f) => f.endsWith(".md"));
const SKILL_FILES = walk("skills").filter(isText);
const LINK_FILES = [...DOC_FILES, ...SKILL_FILES, README];

describe("live Cloudflare demo URLs name pages that exist in the fixture", () => {
  it("the fixture's pages folder is where the test looks", () => {
    expect(existsSync(path.join(FIXTURE_PAGES, "catalog.html"))).toBe(true);
    expect(existsSync(path.join(FIXTURE_PAGES, "catalog-stream.html"))).toBe(
      true,
    );
  });

  it("every cloudflare-adapter.bascik.dev URL maps to a fixture page (never fetched)", () => {
    const missing: string[] = [];
    let count = 0;
    for (const rel of LINK_FILES) {
      for (const url of demoUrls(read(rel))) {
        count++;
        if (fixturePageFor(url) === null) missing.push(`${rel}: ${url}`);
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("misuse: a typo'd demo path maps to no page", () => {
    expect(fixturePageFor(`${DEMO_ORIGIN}/catalogs?q=frother`)).toBeNull();
    expect(fixturePageFor(`${DEMO_ORIGIN}/catalog?q=frother#x`)).toBe(
      "catalog.html",
    );
    expect(fixturePageFor(`${DEMO_ORIGIN}/`)).toBe("index.html");
    expect(fixturePageFor(`${DEMO_ORIGIN}/api/ping`)).not.toBeNull();
    expect(fixturePageFor(`${DEMO_ORIGIN}/api/pong`)).toBeNull();
  });
});

describe("each place about returning component tags points at the live demo", () => {
  const serverMd = read("docs/content/server-scripts.md");
  const streamMd = read("docs/content/stream-scripts.md");

  it("server-scripts.md: a See it live callout at the top of Returning component tags links /catalog and /catalog-stream", () => {
    const top = sectionTop(section(serverMd, /^Returning component tags$/));
    expect(top).toContain(CALLOUT);
    expect(linksTo(top, "/catalog").length).toBeGreaterThan(0);
    expect(linksTo(top, "/catalog-stream").length).toBeGreaterThan(0);
    expect(
      linksTo(top, "/catalog").some(
        (url) => new URL(url).searchParams.get("q") === "frother",
      ),
      "the top callout shows a search with ?q=frother",
    ).toBe(true);
  });

  it("server-scripts.md: the line before the search demo box points at /catalog?q=frother", () => {
    const last = lastParagraph(
      section(serverMd, /^Render a card per search result$/),
    );
    expect(last).toMatch(/^Run this on Cloudflare Workers:/);
    expect(
      linksTo(last, "/catalog").map((u) => new URL(u).searchParams.get("q")),
    ).toEqual(["frother"]);
  });

  it("server-scripts.md: the line before the nested-script demo box points at the live card on /catalog", () => {
    const last = lastParagraph(
      section(serverMd, /^A card with its own server script$/),
    );
    expect(last).toMatch(/^Run this on Cloudflare Workers:/);
    expect(linksTo(last, "/catalog")).toHaveLength(1);
  });

  it("server-scripts.md: the closing paragraph keeps its catalog links, with ?q=frother", () => {
    const rules = section(serverMd, /^Rules for returned tags$/);
    const catalog = linksTo(rules, "/catalog");
    expect(catalog.map((u) => new URL(u).searchParams.get("q"))).toContain(
      "frother",
    );
    expect(linksTo(rules, "/catalog-stream").length).toBeGreaterThan(0);
  });

  it("stream-scripts.md: a See it live callout at the top of Returning component tags links /catalog-stream", () => {
    const top = sectionTop(section(streamMd, /^Returning component tags$/));
    expect(top).toContain(CALLOUT);
    expect(linksTo(top, "/catalog-stream").length).toBeGreaterThan(0);
  });

  it("stream-scripts.md: the line before the streaming demo box points at /catalog-stream", () => {
    const last = lastParagraph(section(streamMd, /^Stream cards in batches$/));
    expect(last).toMatch(/^Run this on Cloudflare Workers:/);
    expect(linksTo(last, "/catalog-stream")).toHaveLength(1);
  });

  it("stream-scripts.md: the closing paragraph keeps its catalog-stream link", () => {
    const rules = section(streamMd, /^Rules when streaming$/);
    expect(linksTo(rules, "/catalog-stream").length).toBeGreaterThan(0);
  });

  it("faq.md: the answer to Can a server script return a component? links the live catalog", () => {
    const answer = section(
      read("docs/content/faq.md"),
      /^Can a server script return a component\?$/,
    );
    expect(
      linksTo(answer, "/catalog").length +
        linksTo(answer, "/catalog-stream").length,
    ).toBeGreaterThan(0);
  });

  it("compatibility.md: the Request-Time Component Rendering section links /catalog, /catalog-stream and the pass-through demo", () => {
    const rtc = section(
      read("docs/content/compatibility.md"),
      /^Request-Time Component Rendering$/,
    );
    expect(linksTo(rtc, "/catalog").length).toBeGreaterThan(0);
    expect(linksTo(rtc, "/catalog-stream").length).toBeGreaterThan(0);
    expect(rtc).toContain(
      "/testing/troubleshooting#a-component-tag-in-script-output-reaches-the-browser-as-written",
    );
  });

  it("adapters/cloudflare/README.md (the npm page) has a See it live line with the demo home, /catalog and /catalog-stream", () => {
    const readme = read(README);
    expect(readme).toMatch(/See it live/);
    const urls = demoUrls(readme);
    expect(urls.some((u) => new URL(u).pathname === "/")).toBe(true);
    expect(linksTo(readme, "/catalog").length).toBeGreaterThan(0);
    expect(linksTo(readme, "/catalog-stream").length).toBeGreaterThan(0);
  });
});

describe("live demo links read cleanly", () => {
  it("no paragraph links the same demo URL twice", () => {
    const repeats: string[] = [];
    for (const rel of LINK_FILES) {
      for (const unit of paragraphs(read(rel))) {
        const urls = demoUrls(unit);
        const seen = new Set<string>();
        for (const url of urls) {
          if (seen.has(url)) repeats.push(`${rel}: ${url}`);
          seen.add(url);
        }
      }
    }
    expect(repeats).toEqual([]);
  });

  it("misuse: the paragraph splitter sees a repeated link in one paragraph and not across two", () => {
    const one = `See [a](${DEMO_ORIGIN}/catalog) and [b](${DEMO_ORIGIN}/catalog).`;
    const two = `See [a](${DEMO_ORIGIN}/catalog).\n\nThen [b](${DEMO_ORIGIN}/catalog).`;
    expect(paragraphs(one)).toHaveLength(1);
    expect(paragraphs(two)).toHaveLength(2);
  });
});

// Spelled in pieces so this guard file does not carry the word itself.
const RETIRED_WORD = ["gri", "nder"].join("");

describe("the retired demo product word appears nowhere", () => {
  const ROOTS = [
    "docs/content",
    "skills",
    "create/assets",
    README,
    "adapters/cloudflare/e2e/fixture",
  ];

  it.each(ROOTS)("%s", (root) => {
    const files = walk(root).filter(isText);
    expect(files.length, `files under ${root}`).toBeGreaterThan(0);
    const hits = files.flatMap((rel) =>
      read(rel)
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.toLowerCase().includes(RETIRED_WORD))
        .map(({ line, i }) => `${rel}:${i + 1}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
