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

  it("renders the starting count before petite-vue mounts, so the page does not shift", async () => {
    // `{{ count }}` is 11 characters wide until petite-vue replaces it with "0", which moved the buttons
    // (CLS 0.03 on /libraries). The starting value is in the markup, and v-text keeps it up to date.
    const html = await readFile(componentPath, "utf8");
    expect(html).not.toContain("{{");
    expect(html).toMatch(/<span class="count-value" v-text="count">0<\/span>/);
  });

  it("matches the source shown on /libraries", async () => {
    const md = await readFile(
      join(process.cwd(), "content/libraries.md"),
      "utf8",
    );
    expect(md).toContain('<span class="count-value" v-text="count">0</span>');
    expect(md).toContain(
      '<span class="bascik__my-counter__count-value" v-text="count">0</span>',
    );
    expect(md).not.toMatch(/count-value">\{\{ count \}\}/);
  });
});
