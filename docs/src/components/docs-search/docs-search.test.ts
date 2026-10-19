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

    expect(html).toContain('class="dnav-search-btn"');
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

    expect(css).toContain(".sr-sitelinks");
    expect(css).toContain(".sr-sitelink");
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

  it("contains sr-only styles for search status live region", async () => {
    const css = await readFile(cssPath, "utf8");

    expect(css).toContain(".sr-only");
    expect(css).toContain("clip: rect(0, 0, 0, 0);");
  });
});
