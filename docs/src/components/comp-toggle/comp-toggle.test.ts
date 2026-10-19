import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("comp-toggle component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/comp-toggle/comp-toggle.html",
  );

  it("renders expandable panel and toggle button script", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('id="detail"');
    expect(html).toContain("hidden");
    expect(html).toContain('id="btn"');
    expect(html).toContain("Read more");
  });
});
