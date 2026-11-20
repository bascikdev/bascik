import { describe, expect, it } from "vitest";
import { PORTFOLIO_TEMPLATE } from "./portfolio.ts";
import { FAVICON_SVG, SITE_HEADER_CSS } from "../scaffold.ts";
import { readFile } from "node:fs/promises";

const files = new Map(PORTFOLIO_TEMPLATE.files({ siteName: "portfolio" }));
const source = (path: string): string => String(files.get(path));

describe("portfolio feedback contract", () => {
  it("runs tracked checkout skills rather than machine-specific cached installs", async () => {
    const browserTest = await readFile(
      new URL("./portfolio.browser.test.ts", import.meta.url),
      "utf8",
    );
    expect(browserTest).not.toMatch(/\/(?:Users|home)\//);
    expect(browserTest).not.toMatch(/["'`][A-Za-z]:[\\/]/);
    expect(browserTest).not.toMatch(/\.(?:agents|claude)[\\/]skills/);
    expect(browserTest).toContain('const skills = join(root, "skills")');
    for (const script of [
      "bascik/scripts/verify.mjs",
      "bascik/scripts/audit-components.mjs",
      "bascik/scripts/check-links.mjs",
      "bascik-components/scripts/check-tokens.mjs",
    ]) {
      expect(browserTest).toContain(`"${script}"`);
      expect(
        await readFile(
          new URL(`../../../skills/${script}`, import.meta.url),
          "utf8",
        ),
      ).not.toBe("");
    }
  });

  it("preserves the canonical Bascik SVG geometry and colors", () => {
    expect(FAVICON_SVG).toContain(
      '<polygon points="10,3 28,3 23,29 4,29" fill="#d3ff8d" />',
    );
    expect(FAVICON_SVG).toContain(
      '<rect x="15" y="9" width="2" height="14" rx="1" fill="#0e0f10" />',
    );
  });

  it("references repository-only UI and UX skills in the design contract", async () => {
    const contract = await readFile(
      new URL("../../TEMPLATE-DESIGN.md", import.meta.url),
      "utf8",
    );
    for (const name of ["ui", "ux"]) {
      expect(contract).toContain(`.github/skills/bascik-${name}/SKILL.md`);
      expect(contract.replaceAll(".github/skills/", "")).not.toContain(
        `skills/bascik-${name}/SKILL.md`,
      );
    }
  });

  it("inlines the global stylesheet with Bascik configuration", () => {
    expect(source("bascik.config.ts")).toContain("inlineStyles: true");
  });

  it("uses an editorial masthead, not the generic navigation skin", () => {
    const header = source("src/components/site-header/site-header.html");
    expect(header).not.toContain(SITE_HEADER_CSS);
    expect(header).toContain("Practice / Index");
    expect(header).toContain("text-decoration: none");
    expect(header).toContain(".skip-link:not(:focus)");
  });

  it("provides an icon-only, named, persistent theme button and early initialization", () => {
    const header = source("src/components/site-header/site-header.html");
    expect(header).toContain('data-testid="site-header-theme-toggle"');
    expect(header).toContain('aria-label="Dark theme"');
    expect(header).toContain('aria-pressed="false"');
    expect(header).toContain('aria-hidden="true"');
    expect(header).toContain("localStorage.setItem");
    expect(source("src/components/site-meta/site-meta.html")).toContain(
      "localStorage.getItem",
    );
  });

  it("labels the collection as sample work and keeps first-paint content static", () => {
    expect(source("src/lib/site.ts")).toContain("Sample work");
    for (const component of ["featured-projects", "project-list"]) {
      expect(source(`src/components/${component}/${component}.html`)).toContain(
        "site.sampleWork",
      );
    }
    expect(source("src/components/project-detail/detail.ts")).toContain(
      "Sample project",
    );
    const styles = [...files.entries()]
      .filter(([path]) => path.endsWith(".html") || path.endsWith(".css"))
      .map(([, text]) => String(text))
      .join("\n");
    expect(styles).not.toMatch(/opacity:\s*0[;} ]|@keyframes|animation:/);
  });
});
