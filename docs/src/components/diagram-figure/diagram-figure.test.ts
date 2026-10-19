import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("diagram-figure component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/diagram-figure/diagram-figure.html",
  );

  it("captions a figure and takes an optional footer prop", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('<figure class="diagram">');
    expect(html).toContain(
      '<figcaption class="diagram-title" data-bascik-prop-title>',
    );
    expect(html).toContain("data-bascik-prop-footer");
    expect(html).toContain("data-bascik-slot");
  });
});
