import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("hello-card-styled component", () => {
  it("matches the hello-card with a style block shown on the components page", async () => {
    const html = await readFile(
      join(
        process.cwd(),
        "src/components/hello-card-styled/hello-card-styled.html",
      ),
      "utf8",
    );
    const markdown = await readFile(
      join(process.cwd(), "content/components.md"),
      "utf8",
    );

    expect(html).toContain("<article>");
    expect(html.indexOf("<style>")).toBe(0);
    expect(html).toContain('class="kicker"');
    expect(markdown).toContain(html);
  });
});
