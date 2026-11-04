import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("docs-head component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/docs-head/docs-head.html",
  );

  it("renders charset, viewport, favicon link, and theme restoration script", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('href="/site.webmanifest"');
    expect(html).toContain('href="/favicon.ico" sizes="16x16 32x32"');
    expect(html).toContain('href="/assets/favicon-32x32.png"');
    expect(html).toContain('href="/assets/favicon.svg" sizes="any"');
    expect(html).toContain('href="/assets/apple-touch-icon.png"');
    expect(html).toContain('sessionStorage.getItem("theme")');
  });

  it("keeps the tab favicon static while preserving the original mark", async () => {
    const favicon = await readFile(
      join(process.cwd(), "src/pages/assets/favicon.svg"),
      "utf8",
    );

    expect(favicon).toContain('points="9,2 30,2 23,30 2,30"');
    expect(favicon).toContain('x="15" y="9" width="2" height="14"');
    expect(favicon).not.toContain("<animate");
  });

  it("applies the theme again when a prerendered page is shown", async () => {
    // A page prerendered on hover runs this script before the visitor arrives. If they switch the theme in
    // between, the page must not open in the old one.
    const html = await readFile(componentPath, "utf8");
    expect(html).toContain("document.prerendering");
    expect(html).toContain('"prerenderingchange"');
  });

  it("prerenders same-site pages on hover with inline rules, never assets, search, files, or links within the page", async () => {
    const html = await readFile(componentPath, "utf8");
    const blocks = [
      ...html.matchAll(/<script type="speculationrules">([\s\S]*?)<\/script>/g),
    ];
    expect(blocks).toHaveLength(1);
    const rules = JSON.parse(blocks[0][1]);
    expect(Object.keys(rules)).toEqual(["prerender"]);
    expect(rules.prerender).toHaveLength(1);
    const [rule] = rules.prerender;
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
