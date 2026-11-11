import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("docs-nav component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/docs-nav/docs-nav.html",
  );
  const cssPath = join(process.cwd(), "src/components/docs-nav/docs-nav.css");

  it("renders site navigation, search component, and mobile nav build script", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain(
      '<a href="#main-content" class="skip-link">Skip to main content</a>',
    );
    expect(html).toContain('<nav aria-label="Main">');
    expect(html).toContain("<docs-logo />");
    expect(html).toContain("<docs-search />");
    expect(html).toContain('<a href="/getting-started">Docs</a>');
    expect(html).toContain('from "@/lib/nav.ts"');
  });

  it("updates the theme button labels when a prerendered page is shown", async () => {
    const html = await readFile(componentPath, "utf8");
    expect(html).toMatch(
      /addEventListener\(\s*"prerenderingchange",\s*syncThemeLabels/,
    );
  });

  it("does not link Sponsor directly from the top navigation", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).not.toContain('<a href="/sponsor">Sponsor</a>');
  });

  it("excludes /sponsor and /press from activating the Docs link", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('path !== "/sponsor"');
    expect(html).toContain('path !== "/press"');
  });

  it("uses rewriteable selectors to mark the main navigation links", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain(
      'document.querySelectorAll(".logo, .links-wrapper a")',
    );
    expect(html).not.toContain('nav[aria-label="Main"] a');
  });

  it("constrains the navigation container to max-width", async () => {
    const css = await readFile(cssPath, "utf8");

    expect(css).toContain(
      ".container {\n  max-width: var(--site-max-width);\n  margin: 0 auto;",
    );
  });

  it("contains skip-link styles placed off-screen by default in global styles.css", async () => {
    const globalCssPath = join(process.cwd(), "src/css/styles.css");
    const css = await readFile(globalCssPath, "utf8");

    expect(css).toContain(".skip-link {");
    expect(css).toContain("top: -100px;");
    expect(css).toContain(".skip-link:focus");
  });
});
