import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("alert-box component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/alert-box/alert-box.html",
  );

  it("renders title and message props with aside element", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('<aside class="alert-box">');
    expect(html).toContain("data-bascik-prop-title");
    expect(html).toContain("data-bascik-prop-message");
  });
});
