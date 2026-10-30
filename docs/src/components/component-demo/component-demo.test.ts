import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("component-demo component", () => {
  const componentPath = join(import.meta.dirname, "component-demo.html");

  it("uses CSS :has() for tab switching and contains no client-side <script>", async () => {
    const html = await readFile(componentPath, "utf8");

    // 1. Should render radio inputs for tabs
    expect(html).toContain('type="radio"');
    expect(html).toContain('value="preview"');
    expect(html).toContain('value="code"');
    expect(html).toContain('value="output"');

    // 2. Should use CSS :has() for state-driven styling and pane visibility
    expect(html).toContain(":has(");
    expect(html).toContain(".demo-tab-radio");

    // 3. Should not contain any client runtime <script> tag
    const clientScriptRegex =
      /<script(?![^>]*data-bascik-build)[^>]*>[\s\S]*?<\/script>/gi;
    expect(clientScriptRegex.test(html)).toBe(false);
  });

  it("keeps each radio group inside a form of its own, so repeated demos do not share one group", async () => {
    // `name` ships as written, and radios with one name and no form owner are
    // one group across the page: a page with two demos would have one
    // Preview/Source/Output choice between them.
    const html = await readFile(componentPath, "utf8");
    const markup = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<style>[\s\S]*?<\/style>/g, "");
    let depth = 0;
    for (const match of markup.matchAll(/<(\/?)form\b[^>]*>|<input\b[^>]*>/g)) {
      if (match[0].startsWith("<input")) {
        if (/type="radio"/.test(match[0])) expect(depth, match[0]).toBe(1);
      } else depth += match[1] ? -1 : 1;
    }
    expect(depth).toBe(0);
    expect(markup.match(/<form\b/g)?.length).toBe(3);
  });

  it("supports no-preview prop marker and CSS rules for hiding preview tab", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain("data-bascik-prop-no-preview");
    expect(html).toContain("data-bascik-prop-hide-preview");
    expect(html).toContain(".demo-no-preview-marker:not(:empty)");
  });

  it("hides language tabs when slot expansion leaves an empty pane", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toMatch(
      /\.demo-pane:not\(:has\(\.demo-language-pane\[data-language-pane="css"\] > \*\)\)\s+\.demo-language-tab\[data-language="css"\]/,
    );
    expect(html).toContain(
      ".demo-pane:not(:has(.demo-language-pane > *)) .demo-language-tabs",
    );
    // Component tags are replaced by their root markup, so a `code-block` type selector never matches.
    expect(html).not.toContain("code-block))");
    expect(html).not.toContain(
      '.demo-language-pane[data-language-pane="css"]:empty',
    );
  });

  it("hides the Output tab when no output slots have content", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain(
      '.demo-pane[data-pane="output"] .demo-language-pane > *',
    );
    expect(html).toContain(".demo-output-fallback > *");
    expect(html).toMatch(
      /\.demo-box:not\([\s\S]*?:has\(\.demo-pane\[data-pane="output"\] \.demo-language-pane > \*\)[\s\S]*?\):not\(:has\(\.demo-output-fallback > \*\)\)\s+\.demo-tab\[data-testid="demo-tab-output"\]/,
    );
  });

  it("stretches the active code pane to fill a taller demo box", async () => {
    const html = await readFile(componentPath, "utf8");

    expect(html).toContain("display: flex;\n    flex-direction: column;");
    expect(html).toContain(
      "display: flex;\n    flex: 1;\n    flex-direction: column;",
    );
    expect(html).toContain(
      ".demo-language-pane:has(> *) > * {\n    height: 100%;",
    );
  });
});
