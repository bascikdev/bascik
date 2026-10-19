import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("feature-card component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/feature-card/feature-card.html",
  );

  it("renders title and desc props inside fcard container", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="fcard"');
    expect(html).toContain("data-bascik-prop-title");
    expect(html).toContain("data-bascik-prop-desc");
  });
});
