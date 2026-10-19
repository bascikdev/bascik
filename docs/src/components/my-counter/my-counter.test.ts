import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("my-counter component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/my-counter/my-counter.html",
  );

  it("renders counter with decrement and increment buttons", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="counter"');
    expect(html).toContain("count--");
    expect(html).toContain("count++");
  });
});
