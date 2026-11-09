import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Regression guards for pre-launch fixes to the guides, testing, tools, and Lighthouse pages. */
const docsDir = process.cwd();
const read = (rel: string) => readFileSync(join(docsDir, rel), "utf8");

describe("guides docs", () => {
  it("tools/linter links to anchors that exist", () => {
    expect(read("content/tools/linter.md")).not.toContain(
      "(#compatibility-rules)",
    );
  });

  it("performance page links srcset and sizes to MDN pages that exist", () => {
    const md = read("content/lighthouse/performance.md");
    expect(md).not.toMatch(/Attributes\/(srcset|sizes)/);
    expect(md).toContain("/HTML/Reference/Elements/img#srcset");
    expect(md).toContain("/HTML/Reference/Elements/img#sizes");
  });

  it("build breakdown cards use h3 under the page's h2", () => {
    expect(read("src/lib/build-breakdown.ts")).not.toMatch(/<h4/);
  });

  it("libraries page renders the Reactive Counter section it lists in the sidebar", () => {
    const html = read("src/pages/libraries.html");
    expect(html).not.toMatch(/to:\s*"Reactive Counter"/);
  });

  it("the how-to and tools sections have landing pages", () => {
    for (const route of ["how-to", "tools"]) {
      expect(existsSync(join(docsDir, `content/${route}/index.md`))).toBe(true);
      expect(existsSync(join(docsDir, `src/pages/${route}.html`))).toBe(true);
    }
  });

  it("developer experience samples match real tooling", () => {
    const md = read("content/developer-experience.md");
    expect(md).not.toContain('page.locator(".bascik__');
    expect(md).toContain('getByTestId("user-card")');
    expect(md).not.toContain("modified component");
    expect(md).not.toContain("Checked 4 pages");
    // component-structure-order: <style> above the markup.
    const sample = md.slice(md.indexOf("### Clean Component Authoring"));
    expect(sample.indexOf("<style>")).toBeLessThan(
      sample.indexOf('<article class="card"'),
    );
  });

  it("the Lighthouse overview does not claim a build writes Brotli files unconditionally", () => {
    expect(read("content/lighthouse.md")).not.toContain(
      "Under `bascik --server` and `bascik --build`, pages are compressed",
    );
  });

  it("the accessibility dialog sample does not refer to onclick handlers", () => {
    expect(read("content/lighthouse/accessibility.md")).not.toContain(
      "`onclick` inline handlers",
    );
  });

  it("the API route unit test calls the one-parameter handler with one argument", () => {
    expect(read("content/testing/unit-testing.md")).not.toContain(
      "POST(request, {",
    );
  });

  it("the docs e2e web server silences the experimental warning like the docs build", () => {
    expect(read("e2e/playwright.config.ts")).toContain(
      "NODE_OPTIONS=--disable-warning=ExperimentalWarning",
    );
  });
});
