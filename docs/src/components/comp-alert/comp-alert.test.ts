import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("comp-alert component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/comp-alert/comp-alert.html",
  );

  it("renders dismissable alert box with click event listener", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('class="alert"');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain("hidden = true");
  });
});
