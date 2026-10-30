import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("docs-sidebar component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/docs-sidebar/docs-sidebar.html",
  );

  it("renders sidebar navigation build script and preloading script", async () => {
    const html = await readFile(componentPath, "utf8");

    // A navigation landmark, named "Documentation" (screen readers add "navigation"), not a complementary <aside>.
    expect(html).toContain(
      '<nav class="docs-sidebar-nav" aria-label="Documentation">',
    );
    expect(html).not.toContain("<aside");
    expect(html).toContain('from "@/lib/nav.ts"');
    expect(html).toContain('link.rel = "prefetch"');
  });

  it("scrolls the active link from a ResizeObserver, not a layout read before first paint", async () => {
    const html = await readFile(componentPath, "utf8");
    const script = html.slice(html.indexOf("<script>"));
    // requestAnimationFrame runs before the first layout, so reading sizes there forces one. It is only the
    // fallback for browsers without ResizeObserver.
    expect(script).toContain(
      "new ResizeObserver(scrollActiveIntoView).observe(sidebar)",
    );
    const fallback = script.indexOf("} else {");
    expect(
      script.indexOf("requestAnimationFrame(scrollActiveIntoView)"),
    ).toBeGreaterThan(fallback);
  });

  it("prefetches with listeners on the sidebar, not on each link", async () => {
    const html = await readFile(componentPath, "utf8");
    const script = html.slice(
      html.indexOf("<script>"),
      html.lastIndexOf("<script>"),
    );
    expect(script).not.toContain("links.forEach");
    for (const type of ["pointerover", "pointerout", "focusin", "touchstart"])
      expect(script).toMatch(
        new RegExp(`sidebar\\.addEventListener\\(\\s*"${type}"`),
      );
  });

  it('renders an "On this page" table of contents from the page Markdown', async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain(
      '<nav class="docs-toc" aria-label="On this page" hidden>',
    );
    expect(html).toContain("<script data-bascik-build>");
    expect(html).toContain("renderPageTableOfContents");
  });
});
