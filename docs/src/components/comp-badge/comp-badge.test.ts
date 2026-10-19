import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("comp-badge component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/comp-badge/comp-badge.html",
  );

  it("renders badge markup with dot indicator", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="badge"');
    expect(html).toContain('class="badge-dot"');
  });
});
