import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("state-tab component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/state-tab/state-tab.html",
  );

  it("renders interactive tab with state binding directives", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain("v-scope");
    expect(html).toContain(":data-state");
  });
});
