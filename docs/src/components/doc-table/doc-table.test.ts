import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("doc-table component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/doc-table/doc-table.html",
  );

  it("renders doc-table wrapper with default slot", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="doc-table"');
    expect(html).toContain("data-bascik-slot");
  });
});
