import { describe, it, expect, vi } from "vitest";
import { NAV } from "./nav.ts";
import { isExternalNavPage } from "./nav-helpers.ts";
import {
  buildSearchEntries,
  compactSearchIndex,
  publicSearchIndexJson,
  compressedSize,
  searchIndexJson,
  searchIndexPath,
  searchTextJson,
  searchTextPath,
  PUBLIC_SEARCH_INDEX_PATH,
  SEARCH_INDEX_MAX_COMPRESSED_BYTES,
  SEARCH_TEXT_MAX_COMPRESSED_BYTES,
} from "./search-index.ts";
import {
  applySearchText,
  buildResults,
  expandSearchIndex,
  snippet,
  tokens,
  type SearchEntry,
} from "../components/docs-search/search-logic.ts";

const entries = await buildSearchEntries();

/** What a browser has once both files have arrived. */
function loaded(): SearchEntry[] {
  const index = expandSearchIndex(JSON.parse(searchIndexJson(entries)));
  expect(applySearchText(index, JSON.parse(searchTextJson(entries)))).toBe(
    true,
  );
  return index;
}

describe("search index", () => {
  it("expands back to exactly the entries it was built from, once the text is applied", () => {
    expect(loaded()).toEqual(entries);
  });

  it("holds no text in the outline, which is what a first search waits for", () => {
    const outline = expandSearchIndex(JSON.parse(searchIndexJson(entries)));
    expect(outline).toHaveLength(entries.length);
    for (const entry of outline) expect(entry.text).toBe("");
    expect(outline.map((entry) => entry.path)).toEqual(
      entries.map((entry) => entry.path),
    );
  });

  it("finds a page by its title or a heading with the outline alone", () => {
    const outline = expandSearchIndex(JSON.parse(searchIndexJson(entries)));
    for (const query of ["scoped styles", "stream scripts", "props"]) {
      const top = buildResults(outline, query, tokens(query), 13);
      expect(top.length, query).toBeGreaterThan(0);
    }
  });

  it("refuses a text file that is not this outline's", () => {
    const outline = expandSearchIndex(JSON.parse(searchIndexJson(entries)));
    const texts = JSON.parse(searchTextJson(entries)) as string[];
    expect(applySearchText(outline, texts.slice(1))).toBe(false);
    expect(applySearchText(outline, { pages: [] })).toBe(false);
    expect(
      applySearchText(
        outline,
        texts.map(() => 1),
      ),
    ).toBe(false);
    // Nothing was half applied.
    for (const entry of outline) expect(entry.text).toBe("");
  });

  it("stores each page's title, label, section and path once, not once per heading", () => {
    const compact = compactSearchIndex(entries);
    expect(compact.pages.length).toBeLessThan(entries.length / 3);
    expect(compact.entries).toHaveLength(entries.length);
    // A page listed under two sections stays two pages, so nothing is merged that differs.
    const keys = compact.pages.map((page) => JSON.stringify(page.slice(0, 4)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps text searchable as single spaces, since the results show it as one line", () => {
    for (const entry of entries) expect(entry.text).not.toMatch(/\s{2}|\n|\t/);
  });

  it(`has an outline of at most ${SEARCH_INDEX_MAX_COMPRESSED_BYTES} compressed bytes, which every first search waits for`, () => {
    expect(compressedSize(searchIndexJson(entries))).toBeLessThanOrEqual(
      SEARCH_INDEX_MAX_COMPRESSED_BYTES,
    );
  });

  it(`has at most ${SEARCH_TEXT_MAX_COMPRESSED_BYTES} compressed bytes of text, which loads in the background`, () => {
    expect(compressedSize(searchTextJson(entries))).toBeLessThanOrEqual(
      SEARCH_TEXT_MAX_COMPRESSED_BYTES,
    );
  });

  it("is fetched from a file name that changes with its content, so it can be cached for a year", () => {
    const path = searchIndexPath(searchIndexJson(entries));
    expect(path).toMatch(/^\/assets\/search-index\.[0-9a-f]{10}\.json$/);
    expect(path).not.toBe(PUBLIC_SEARCH_INDEX_PATH);
    expect(searchIndexPath(searchIndexJson(entries))).toBe(path);
    const renamed = [
      { ...entries[0], title: `${entries[0].title} more` },
      ...entries.slice(1),
    ];
    expect(searchIndexPath(searchIndexJson(renamed))).not.toBe(path);
  });

  it("keeps the outline's file name when only the text of a section changes", () => {
    const edited = [
      { ...entries[0], text: `${entries[0].text} more` },
      ...entries.slice(1),
    ];
    // A reader who has the outline cached keeps it; only the text is downloaded again.
    expect(searchIndexPath(searchIndexJson(edited))).toBe(
      searchIndexPath(searchIndexJson(entries)),
    );
    const textPath = searchTextPath(searchTextJson(entries));
    expect(textPath).toMatch(/^\/assets\/search-text\.[0-9a-f]{10}\.json$/);
    expect(searchTextPath(searchTextJson(edited))).not.toBe(textPath);
  });

  // The installed bascik agent skill scripts and pages loaded before a deploy (an open tab, a bfcache restore)
  // fetch /assets/search-index.json and read it as a plain array of entries. It keeps that shape, or the skill
  // scripts throw and old pages find nothing.
  it("keeps the unversioned file as a plain array of entries for the skill scripts and older pages", () => {
    const legacy = JSON.parse(publicSearchIndexJson(entries));
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy).toEqual(entries);
    for (const entry of legacy.slice(0, 50)) {
      expect(typeof entry.navLabel).toBe("string");
      expect(typeof entry.path).toBe("string");
      expect(typeof entry.text).toBe("string");
      expect(entry.heading === null || typeof entry.heading === "string").toBe(
        true,
      );
    }
  });

  it("expands an index in either shape, so a page never misreads the other format", () => {
    expect(
      expandSearchIndex(JSON.parse(publicSearchIndexJson(entries))),
    ).toEqual(entries);
    expect(loaded()).toEqual(entries);
  });

  it("finds a term deep in a section and shows it in the snippet", () => {
    const index: SearchEntry[] = loaded();
    // Terms that appear well past the start of their section, so a shortened index would lose them.
    const deep = entries
      .filter((entry) => entry.heading !== null && entry.text.length > 1500)
      .slice(0, 25);
    expect(deep.length).toBeGreaterThan(10);
    for (const entry of deep) {
      const word = entry.text
        .slice(1200)
        .split(" ")
        .find((candidate) => /^[a-zA-Z]{9,}$/.test(candidate));
      if (!word) continue;
      const query = word.toLowerCase();
      const results = buildResults(index, query, tokens(query), 1000);
      const hit = results.find((result) => result.path === entry.path);
      expect(hit, `${query} in ${entry.path}`).toBeDefined();
      expect(snippet(hit!.text, query, tokens(query)).toLowerCase()).toContain(
        query,
      );
    }
  });

  it("indexes every sidebar page with searchable text", () => {
    const unsearchable = NAV.flatMap((section) => section.pages)
      .filter((page) => !isExternalNavPage(page))
      .filter(
        (page) =>
          !entries.some(
            (entry) =>
              entry.text.length > 0 &&
              (entry.path === page.href ||
                entry.path.startsWith(`${page.href}#`)),
          ),
      )
      .map((page) => page.href);
    expect(unsearchable).toEqual([]);
  });

  // /deployment's Markdown is content/deployment/index.md, not content/deployment.md.
  it("indexes a page whose Markdown is a folder's index.md, with its title and sections", () => {
    const deployment = entries.filter(
      (entry) =>
        entry.path === "/deployment" || entry.path.startsWith("/deployment#"),
    );
    expect(deployment[0]).toMatchObject({
      title: "Deployment Overview",
      heading: null,
    });
    expect(deployment[0].text.length).toBeGreaterThan(0);
    expect(deployment.length).toBeGreaterThan(5);
  });

  it("warns, naming the files it tried, when a sidebar page has no Markdown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const typoed = await buildSearchEntries([
        {
          section: "Overview",
          pages: [{ href: "/getting-startd", label: "Getting Started" }],
        },
      ]);
      expect(typoed.at(-1)).toMatchObject({
        path: "/getting-startd",
        text: "",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "content/getting-startd.md or content/getting-startd/index.md",
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
