import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("test-comp component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/test-comp/test-comp.html",
  );

  it("renders test markup and scoped DOM manipulation scripts", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain('id="my-div-id"');
    expect(html).toContain('name="my-name"');
    expect(html).toContain('id="btn"');
    expect(html).toContain("getElementsByName");
    expect(html).toContain("querySelector");
    expect(html).toContain("getElementsByClassName");
  });
});
