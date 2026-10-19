import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("simple-slot-card component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/simple-slot-card/simple-slot-card.html",
  );

  it("renders default slot with fallback content", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="simple-slot-card"');
    expect(html).toContain("data-bascik-slot");
    expect(html).toContain("simple-slot-fallback");
  });
});
