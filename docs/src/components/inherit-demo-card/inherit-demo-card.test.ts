import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("inherit-demo-card component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/inherit-demo-card/inherit-demo-card.html",
  );

  it("renders article container demonstrating attribute inheritance", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="inherit-card"');
    expect(html).toContain("Attribute inheritance");
  });
});
