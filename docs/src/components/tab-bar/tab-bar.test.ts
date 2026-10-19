import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("tab-bar component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/tab-bar/tab-bar.html",
  );

  it("renders tab bar container with default slot", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="tab-bar"');
    expect(html).toContain("data-bascik-slot");
  });
});
