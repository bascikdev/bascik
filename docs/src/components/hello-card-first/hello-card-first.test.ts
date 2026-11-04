import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("hello-card-first component", () => {
  it("matches the HTML-only hello-card shown first on the components page", async () => {
    const html = await readFile(
      join(
        process.cwd(),
        "src/components/hello-card-first/hello-card-first.html",
      ),
      "utf8",
    );
    const markdown = await readFile(
      join(process.cwd(), "content/components.md"),
      "utf8",
    );

    expect(html).toContain("<article>");
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("class=");
    expect(markdown).toContain(html);
  });
});
