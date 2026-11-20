import { describe, expect, it } from "vitest";
import { BLOG_TEMPLATE } from "./blog.ts";
import { SAMPLE_POSTS } from "./blog/content.ts";
import { FAVICON_SVG } from "../scaffold.ts";
import { readFileSync } from "node:fs";

const files = new Map(BLOG_TEMPLATE.files({ siteName: "my-blog" }));
const file = (path: string): string => String(files.get(path));

describe("blog editorial feedback", () => {
  it("retains the canonical Bascik SVG geometry and colors", () => {
    expect(FAVICON_SVG).toContain(
      'points="10,3 28,3 23,29 4,29" fill="#d3ff8d"',
    );
    expect(FAVICON_SVG).toContain(
      '<rect x="15" y="9" width="2" height="14" rx="1" fill="#0e0f10"',
    );
  });

  it("references repository-only UI and UX skills in the design contract", () => {
    const contract = readFileSync(
      new URL("../../TEMPLATE-DESIGN.md", import.meta.url),
      "utf8",
    );
    for (const skill of ["bascik-ui", "bascik-ux"]) {
      expect(contract).toContain(`.github/skills/${skill}/SKILL.md`);
      expect(contract).not.toMatch(
        new RegExp(`(?<!\\.github/)skills/${skill}/SKILL\\.md`),
      );
    }
  });

  it("inlines global styles with an explicit asset pattern", () => {
    expect(file("bascik.config.ts")).toContain(
      'inlineStyles: ["src/pages/css/styles.css", "src/pages/css/blog.css"]',
    );
  });

  it("has an icon-only, progressively enhanced theme control and early theme initialization", () => {
    const header = file("src/components/site-header/site-header.html");
    expect(header).toMatch(
      /<button[^>]*aria-label="Dark mode"[^>]*aria-pressed="false"[^>]*data-testid="theme-toggle"[^>]*hidden/,
    );
    expect(header).toContain('aria-hidden="true"');
    expect(header).toContain('localStorage.setItem("theme"');
    expect(file("src/components/site-meta/site-meta.html")).toContain(
      'localStorage.getItem("theme")',
    );
  });

  it("replaces the full-width masthead with author context beside the reading column", () => {
    expect(file("src/components/site-header/site-header.html")).toContain(
      'data-testid="author-sidebar"',
    );
    expect(file("src/lib/site.ts")).toContain('name: "John Doe"');
    expect(file("src/components/post-article/article-body.ts")).toContain(
      'data-testid="post-author-context"',
    );
    const css = file("src/pages/css/blog.css");
    expect(css).toContain("grid-template-columns: 240px minmax(0, 800px)");
    expect(css).toContain("nav a { text-decoration: none; }");
    expect(css).not.toMatch(/editorial-enter|opacity:\s*0|animation:/);
  });

  it("uses explanatory samples without invented attribution to real people", () => {
    const posts = SAMPLE_POSTS.map(([, text]) => text).join("\n");
    expect(posts).not.toMatch(
      /Hurley Haywood|Paul Newman|Jordan Taylor|Ross Bentley|Apex Racing Desk/,
    );
    for (const [, text] of SAMPLE_POSTS) {
      expect(text).toContain("author: John Doe");
      expect(text).toContain("illustrative");
    }
  });
});
