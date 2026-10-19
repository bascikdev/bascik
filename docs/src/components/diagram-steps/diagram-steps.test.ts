import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("diagram-steps component", () => {
  const dir = join(process.cwd(), "src/components/diagram-steps");

  it("is an ordered list that resets the step counter", async () => {
    const html = await readFile(join(dir, "diagram-steps.html"), "utf8");
    const css = await readFile(join(dir, "diagram-steps.css"), "utf8");

    expect(html).toContain('<ol class="steps">');
    expect(html).toContain("data-bascik-slot");
    expect(css).toContain("counter-reset: diagram-step;");
  });
});
