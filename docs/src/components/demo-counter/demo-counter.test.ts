import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("demo-counter component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/demo-counter/demo-counter.html",
  );

  it("renders counter display and decrement/increment buttons", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="ctr-count"');
    expect(html).toContain('class="ctr-dec"');
    expect(html).toContain('class="ctr-inc"');
  });
});
