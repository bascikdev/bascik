import { describe, expect, it } from "vitest";
import { FAVICON_SVG } from "../scaffold.js";
import { DOCS_TEMPLATE } from "./docs.js";

const files = new Map(
  DOCS_TEMPLATE.files({ siteName: "docs" }).map(([path, data]) => [
    path,
    String(data),
  ]),
);
const file = (path: string): string => files.get(path) ?? "";

describe("docs feedback", () => {
  it("opens the complete documentation shell at the root without a landing page", () => {
    const index = file("src/pages/index.html");
    for (const tag of [
      "docs-sidebar",
      "docs-article",
      "docs-pagination",
      "docs-toc",
    ]) {
      expect(index).toContain(`<${tag} />`);
    }
    expect(index).not.toContain("home-hero");
    expect(file("src/lib/sidebar.ts")).toContain(
      'export const DOCS_HOME: string = "/"',
    );
    expect(file("src/lib/current-doc.ts")).toContain(
      'process.env.BASCIK_PAGE_PATH === "/"',
    );
  });

  it("keeps directory reading separate from per-page context so search can build once", () => {
    expect(file("src/lib/docs.ts")).not.toContain("BASCIK_ROUTE");
    expect(file("src/lib/current-doc.ts")).toContain('from "./docs.ts"');
  });

  it("uses the compiler inlineStyles pattern and initializes a saved theme before paint", () => {
    expect(file("bascik.config.ts")).toContain(
      'inlineStyles: ["src/pages/css/styles.css"]',
    );
    expect(file("bascik.config.ts")).toContain('"src/pages/index.html"');
    expect(file("src/components/site-meta/site-meta.html")).toContain(
      'localStorage.getItem("theme")',
    );
    expect(file("src/components/site-header/site-header.html")).toContain(
      "<theme-toggle />",
    );
    const toggle = file("src/components/theme-toggle/theme-toggle.html");
    expect(toggle).toContain('aria-label="Toggle dark mode"');
    expect(toggle).toContain("<svg");
    expect(toggle).toContain('localStorage.setItem("theme"');
  });

  it("uses the canonical Bascik icon, not a recolored variant", () => {
    expect(FAVICON_SVG).toContain(
      'points="10,3 28,3 23,29 4,29" fill="#d3ff8d"',
    );
    expect(FAVICON_SVG).toContain('fill="#0e0f10"');
  });
});
