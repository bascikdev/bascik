import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../bascik.config.ts";
import { HOME_SITELINKS } from "../src/lib/nav.ts";
import { stripMd } from "./generate-search-index.ts";
import {
  applySearchText,
  expandSearchIndex,
} from "../src/components/docs-search/search-logic.ts";
import {
  buildSearchEntries,
  searchIndexJson,
  searchIndexPath,
  searchTextJson,
  searchTextPath,
} from "../src/lib/search-index.ts";

const assetsDir = path.resolve(import.meta.dirname, "../dist/assets");

/** What a page has once it has fetched both hashed files: every entry, with its text. */
async function writtenEntries() {
  const built = await buildSearchEntries();
  const entries = expandSearchIndex(
    JSON.parse(await fs.readFile(await hashedIndexFile(), "utf8")),
  );
  const textFile = path.join(
    assetsDir,
    path.basename(searchTextPath(searchTextJson(built))),
  );
  if (
    !applySearchText(entries, JSON.parse(await fs.readFile(textFile, "utf8")))
  )
    throw new Error("the text file does not match the outline");
  return entries;
}

/** The outline the pages fetch first, at its content-hashed name. */
async function hashedIndexFile(): Promise<string> {
  const json = searchIndexJson(await buildSearchEntries());
  return path.join(assetsDir, path.basename(searchIndexPath(json)));
}

describe("generate-search-index", () => {
  it("drops comments without joining words into comment delimiters", () => {
    expect(
      stripMd("intro <!<!-- hidden -->-- paragraph<!-- ignored --> outro"),
    ).toContain("intro <! -- paragraph");
    expect(stripMd("before <!-- unfinished comment")).toBe("before");
  });

  it("keeps browser-only generation independent of compilation watches", () => {
    const producer = config.pipeline?.exec?.find(
      (entry) => entry.script === "scripts/generate-search-index.ts",
    );
    expect(producer).toMatchObject({
      phase: "parallel",
      watch: [
        "content/",
        "src/pages/index.html",
        "src/lib/search-index.ts",
        "src/lib/nav.ts",
        "src/lib/content-path.ts",
        "src/lib/meta-tags.ts",
        "src/lib/heading-slug.ts",
        "src/lib/html-entities.ts",
      ],
    });
    expect(producer).not.toHaveProperty("outputs");
    expect(config.pipeline?.watchPaths).not.toContain(
      "dist/assets/search-index.json",
    );
    expect(config.pipeline?.watchPaths).toContain("src/css/");
    expect(config.pipeline?.watchPaths).toContain("src/lib/");
  });

  it("generates dist/assets/search-index.json from nav pages", async () => {
    await import("./generate-search-index.js");

    const searchIndexFile = await hashedIndexFile();
    const content = await fs.readFile(searchIndexFile, "utf8");
    const entries = expandSearchIndex(JSON.parse(content));

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    const firstEntry = entries[0];
    expect(firstEntry).toHaveProperty("title");
    expect(firstEntry).toHaveProperty("navLabel");
    expect(firstEntry).toHaveProperty("section");
    expect(firstEntry).toHaveProperty("path");
    expect(firstEntry).toHaveProperty("text");
  });

  // Builds the whole search index; under coverage instrumentation on a loaded machine it passes 5 s.
  it("writes the outline and the text at their hashed names and the public array at the unversioned name, and drops stale versions", async () => {
    const stale = path.join(assetsDir, "search-index.0000000000.json");
    const staleText = path.join(assetsDir, "search-text.0000000000.json");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(stale, "{}");
    await fs.writeFile(staleText, "[]");
    vi.resetModules();
    await import("./generate-search-index.js");

    const compact = JSON.parse(
      await fs.readFile(await hashedIndexFile(), "utf8"),
    );
    expect(Array.isArray(compact.pages)).toBe(true);
    const legacy = JSON.parse(
      await fs.readFile(path.join(assetsDir, "search-index.json"), "utf8"),
    );
    expect(Array.isArray(legacy)).toBe(true);
    // The two hashed files together hold what the public array holds.
    const textFile = path.join(
      assetsDir,
      path.basename(searchTextPath(searchTextJson(await buildSearchEntries()))),
    );
    const both = expandSearchIndex(compact);
    expect(
      applySearchText(both, JSON.parse(await fs.readFile(textFile, "utf8"))),
    ).toBe(true);
    expect(legacy).toEqual(both);
    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(staleText)).rejects.toThrow();
    expect(
      (await fs.readdir(assetsDir)).filter((name) =>
        /^search-text\.[0-9a-f]{10}\.json$/.test(name),
      ),
    ).toEqual([path.basename(textFile)]);
    const versions = (await fs.readdir(assetsDir)).filter((name) =>
      /^search-index\.[0-9a-f]{10}\.json$/.test(name),
    );
    expect(versions).toEqual([path.basename(await hashedIndexFile())]);
  }, 60_000);

  it("reads the meta description whatever the attribute order or quote style", async () => {
    const { metaDescription } = await import("./generate-search-index.js");

    expect(metaDescription('<meta name="description" content="A">')).toBe("A");
    expect(metaDescription('<meta content="B" name="description">')).toBe("B");
    expect(
      metaDescription("<meta\n  name='description'\n  content='C' />"),
    ).toBe("C");
    expect(
      metaDescription(
        '<meta name="viewport" content="x"><meta content="D" NAME="Description">',
      ),
    ).toBe("D");
    expect(
      metaDescription('<meta name="viewport" content="x">'),
    ).toBeUndefined();
  });

  it("indexes the Home page first with the ordered sitelinks from nav.ts", async () => {
    await import("./generate-search-index.js");

    const entries = await writtenEntries();

    const home = entries[0];
    expect(home.path).toBe("/");
    expect(home.heading).toBeNull();
    expect(home.section).toBe("Home");
    expect(home.title).toContain("Bascik");
    expect(home.text).toContain("build tool for HTML components");
    expect(home.sitelinks).toEqual(HOME_SITELINKS);
    expect(entries.filter((e) => e.sitelinks).length).toBe(1);

    for (const href of HOME_SITELINKS) {
      expect(entries.some((e) => e.path === href && e.heading === null)).toBe(
        true,
      );
    }
  });

  it("indexes code block contents and h3 headings for deduplicateCss across pages", async () => {
    await import("./generate-search-index.js");

    const entries = await writtenEntries();

    const dedupEntries = entries.filter(
      (e) =>
        (e.heading && e.heading.toLowerCase().includes("deduplicatecss")) ||
        (e.text && e.text.toLowerCase().includes("deduplicatecss")),
    );

    // Ensure scoped-styles, configuration, scoping-system, and transpilation-pipeline are indexed
    const navLabels = new Set(dedupEntries.map((e) => e.navLabel));
    expect(navLabels.has("Scoped Styles")).toBe(true);
    expect(navLabels.has("Configuration")).toBe(true);
    expect(navLabels.has("Scoping System")).toBe(true);
    expect(navLabels.has("Transpilation Pipeline")).toBe(true);

    // Verify h3 heading indexing and anchor generation
    const scopedStylesH3 = dedupEntries.find(
      (e) =>
        e.navLabel === "Scoped Styles" &&
        e.heading === "deduplicateCss Trade-Off Comparison",
    );
    expect(scopedStylesH3).toBeDefined();
    expect(scopedStylesH3?.path).toBe(
      "/scoped-styles#deduplicatecss-trade-off-comparison",
    );

    // Verify headings do not contain unstripped backticks
    for (const e of dedupEntries) {
      if (e.heading) {
        expect(e.heading).not.toContain("`");
      }
    }
  });
});
