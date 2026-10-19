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
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/assets/favicon-32x32.png"');
    expect(html).toContain('href="/assets/favicon.svg"');
    expect(html).toContain('href="/assets/apple-touch-icon.png"');
    expect(html).toContain('sessionStorage.getItem("theme")');
  });
});
