import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("slot-layout-demo component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/slot-layout-demo/slot-layout-demo.html",
  );

  it("renders named slots for eyebrow, title, default, and actions", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('data-bascik-slot="eyebrow"');
    expect(html).toContain('data-bascik-slot="title"');
    expect(html).toContain("data-bascik-slot");
    expect(html).toContain('data-bascik-slot="actions"');
  });
});
