import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Long docs pages spend most of their main-thread time on style and layout for content far below the fold.
 * `content-visibility: auto` lets the browser skip that work until a block nears the viewport. Each block also
 * needs `contain-intrinsic-block-size: auto <estimate>`, or a skipped block counts as zero height and the
 * scrollbar jumps as blocks render.
 *
 * Chrome lays such a block out at its estimate in the first frame even when it is on screen, and its real size
 * then shifts the page. So only blocks after a page's fourth h2, which is below the fold on every docs page,
 * use it, and the footer (on screen on short pages) does not.
 */
const read = (file: string) => readFile(join(process.cwd(), file), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(
    css,
  );
  return rule ? rule[1] : "";
}

describe("below-the-fold rendering", () => {
  it.each([
    [".prose-codeblock", 200],
    ['[data-defer-render="table"]', 600],
    ['[data-defer-render="demo"]', 450],
  ])(
    "styles.css skips %s after the fourth h2 until it nears the viewport",
    async (block, estimate) => {
      const body = ruleBody(
        await read("src/css/styles.css"),
        `.docs-content > h2:nth-of-type(4) ~ ${block}`,
      );
      expect(body).toMatch(/content-visibility:\s*auto;/);
      // Block size only: the width comes from the column, and a fixed intrinsic width would squeeze a block
      // in a flex or grid parent while it is skipped.
      expect(body).toContain(
        `contain-intrinsic-block-size: auto ${estimate}px;`,
      );
    },
  );

  it("never skips a block that could be on screen when the page opens", async () => {
    const css = (await read("src/css/styles.css")).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const selectors = [
      ...css.matchAll(/([^{}]+)\{[^}]*content-visibility:\s*auto/g),
    ].map((match) => match[1].trim());
    expect(selectors.length).toBe(3);
    for (const selector of selectors)
      expect(selector).toMatch(/^\.docs-content > h2:nth-of-type\(4\) ~ /);
  });

  it.each([
    [
      "src/components/doc-table/doc-table.html",
      'class="doc-table" data-defer-render="table"',
    ],
    [
      "src/components/component-demo/component-demo.html",
      'class="demo-box" data-defer-render="demo"',
    ],
  ])("%s marks its root for the rule", async (file, root) => {
    const html = await read(file);
    expect(html).toContain(root);
    expect(html).not.toContain("content-visibility");
  });

  it("leaves the footer alone, since it is on screen on short pages", async () => {
    expect(
      await read("src/components/docs-footer/docs-footer.css"),
    ).not.toContain("content-visibility");
  });
});
