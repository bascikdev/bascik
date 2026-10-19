import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("state-toggle component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/state-toggle/state-toggle.html",
  );

  it("renders status label, toggle button, and toggle event script", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('id="status"');
    expect(html).toContain('id="toggle"');
    expect(html).toContain('id="panel"');
    expect(html).toContain('classList.toggle("is-open")');
  });
});
