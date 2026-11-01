import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("docs-search component template", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/docs-search/docs-search.html",
  );
  const cssPath = join(
    process.cwd(),
    "src/components/docs-search/docs-search.css",
  );

  it("renders search button, modal dialog, and build script for search logic and DOM", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="button"');
    expect(html).toContain('id="docs-search-input"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="docs-search-results"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('id="docs-search-status"');
    expect(html).toMatch(/role="status"\s+aria-live="polite"/);
    expect(html).toContain("search-logic.ts");
    expect(html).toContain("docs-search-dom.js");
  });

  it("styles the nested Home sitelinks", async () => {
    const css = await readFile(cssPath, "utf8");

    expect(css).toContain(".sitelinks");
    expect(css).toContain(".sitelink");
  });

  it("wires Home sitelink rendering in the DOM script", async () => {
    const dom = await readFile(
      join(process.cwd(), "src/components/docs-search/docs-search-dom.js"),
      "utf8",
    );

    expect(dom).toContain("buildSitelinks(");
    expect(dom).toContain("search-home-result");
    expect(dom).toContain("search-sitelink");
  });

  it("builds result elements and sets their text, so no index value is parsed as HTML", async () => {
    const dom = await readFile(
      join(process.cwd(), "src/components/docs-search/docs-search-dom.js"),
      "utf8",
    );
    // A browser script cannot import @bascik/bascik/html, so the rule is textContent, not a hand-written escaper.
    expect(dom).toContain("document.createElement(");
    expect(dom).not.toMatch(/function esc\b/);
    expect(dom).not.toMatch(/innerHTML\s*=\s*(?!"")\S/);
  });

  it("fetches the versioned index URL, warms it on intent, and waits for load on /search", async () => {
    const html = await readFile(componentPath, "utf8");
    const dom = await readFile(
      join(process.cwd(), "src/components/docs-search/docs-search-dom.js"),
      "utf8",
    );
    // The build puts the content-hashed file name in front of the DOM script, so `_headers` can cache it for a year.
    expect(html).toContain("searchIndexPath(");
    expect(html).toContain("var SEARCH_INDEX_URL = ");
    expect(dom).toContain("fetch(SEARCH_INDEX_URL)");
    expect(dom).not.toContain('fetch("/assets/search-index.json")');
    expect(dom).toContain("expandSearchIndex(");
    // Hovering or focusing the search button starts the download before the click.
    expect(dom).toMatch(
      /btn\.addEventListener\(\s*"pointerenter",\s*warmIndex/,
    );
    expect(dom).toMatch(/btn\.addEventListener\(\s*"focus",\s*warmIndex/);
    // On /search the 1 MB index must not compete with the page's own resources.
    expect(dom).toContain('document.readyState === "complete"');
    expect(dom).toContain('window.addEventListener("load"');
  });

  it("contains visually-hidden styles for the search status live region", async () => {
    const css = await readFile(cssPath, "utf8");

    expect(css).toContain(".visually-hidden");
    expect(css).toContain("clip: rect(0, 0, 0, 0);");
  });
});
