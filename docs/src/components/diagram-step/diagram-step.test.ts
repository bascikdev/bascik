import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("diagram-step component", () => {
  const dir = join(process.cwd(), "src/components/diagram-step");

  it("is a list item with title and detail props", async () => {
    const html = await readFile(join(dir, "diagram-step.html"), "utf8");

    expect(html).toContain('<li class="step">');
    expect(html).toContain("data-bascik-prop-title");
    expect(html).toContain("data-bascik-prop-detail");
  });

  it("numbers itself with the counter diagram-steps resets", async () => {
    const css = await readFile(join(dir, "diagram-step.css"), "utf8");

    expect(css).toContain("counter-increment: diagram-step;");
    expect(css).toContain("content: counter(diagram-step);");
  });
});
