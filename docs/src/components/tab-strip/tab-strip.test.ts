import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("tab-strip component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/tab-strip/tab-strip.html",
  );

  it("renders tab strip container with default slot", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="tab-strip"');
    expect(html).toContain("data-bascik-slot");
  });
});
