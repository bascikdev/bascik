import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("hello-card component", () => {
  const componentPath = join(
    process.cwd(),
    "src/components/hello-card/hello-card.html",
  );

  it("renders article card with kicker, title, and body", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain("<article>");
    expect(html).toContain('class="kicker"');
    expect(html).toContain("<h3>");
    expect(html).toContain('class="body"');
    expect(html).not.toContain("hello-card-");
  });
});
