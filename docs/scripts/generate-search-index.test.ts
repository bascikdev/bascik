import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../bascik.config.ts";
import { HOME_SITELINKS } from "../src/lib/nav.ts";
import { stripMd } from "./generate-search-index.ts";
import { expandSearchIndex } from "../src/components/docs-search/search-logic.ts";
import {
  buildSearchEntries,
  searchIndexJson,
  searchIndexPath,
} from "../src/lib/search-index.ts";

const assetsDir = path.resolve(import.meta.dirname, "../dist/assets");

/** The compact index the pages fetch, at its content-hashed name. */
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

  it("writes the compact index at its hashed name and the public array at the unversioned name, and drops stale versions", async () => {
    const stale = path.join(assetsDir, "search-index.0000000000.json");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(stale, "{}");
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
    expect(legacy).toEqual(expandSearchIndex(compact));
    await expect(fs.access(stale)).rejects.toThrow();
    const versions = (await fs.readdir(assetsDir)).filter((name) =>
      /^search-index\.[0-9a-f]{10}\.json$/.test(name),
    );
    expect(versions).toEqual([path.basename(await hashedIndexFile())]);
  });

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

    const searchIndexFile = await hashedIndexFile();
    const entries: Array<{
      title?: string;
      navLabel: string;
      section?: string;
      path: string;
      heading: string | null;
      text: string;
      sitelinks?: string[];
    }> = expandSearchIndex(
      JSON.parse(await fs.readFile(searchIndexFile, "utf8")),
    );

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

    const searchIndexFile = await hashedIndexFile();
    const content = await fs.readFile(searchIndexFile, "utf8");
    const entries: Array<{
      navLabel: string;
      heading: string | null;
      text: string;
      path: string;
    }> = expandSearchIndex(JSON.parse(content));

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
