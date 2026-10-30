/**
 * A build script is a `<script>` as the browser reads one (2026-10-29). The
 * tokenizer ends a tag name and separates attributes only at tag whitespace
 * (`\t\n\f\r ` and space) or `/`, so `<script data-bascik-build>` is one
 * element named `script data-bascik-build`, and
 * `<script data-bascik-build >` a script whose attribute is named
 * `data-bascik-build `. Neither is a build script, and the masker and
 * every other script scan already read them that way. The build-script
 * regexes used `<script\b` and `\s` (which takes a no-break space, a vertical
 * tab or U+2028), so a pasted no-break space ran the script at build time.
 */
import { describe, expect, it } from "vitest";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { collectAllScriptDeps, executeBuildScripts } from "./build-scripts.ts";
import { maskRawTextContent } from "./component-masking.ts";

type Element = DefaultTreeAdapterTypes.Element;

/** The script elements parse5 builds from `html` with a `data-bascik-build` attribute. */
const parsedBuildScripts = (html: string): number =>
  parseFragment(html).childNodes.filter(
    (node) =>
      "tagName" in node &&
      node.tagName === "script" &&
      (node as Element).attrs.some((attr) => attr.name === "data-bascik-build"),
  ).length;

const SCRIPT = `export default () => "RAN"`;

describe("a build script is a script with the attribute as the browser reads them", () => {
  const notBuildScripts: Array<[string, string]> = [
    ["a no-break space after <script", `<script data-bascik-build>`],
    ["a vertical tab after <script", `<script\u000bdata-bascik-build>`],
    ["a line separator after <script", `<script data-bascik-build>`],
    [
      "a no-break space between attributes",
      `<script type="module" data-bascik-build>`,
    ],
    ["a no-break space after the name", `<script data-bascik-build >`],
    ["a longer tag name", `<script-x data-bascik-build>`],
  ];

  it.each(notBuildScripts)(
    "does not run a script with %s",
    async (_label, open) => {
      const html = `<p>a</p>${open}${SCRIPT}</script><p>b</p>`;
      expect(parsedBuildScripts(html)).toBe(0);
      // Returned before anything runs: no build script matched.
      expect(await executeBuildScripts(html, "page.html")).toBe(html);
      expect(await collectAllScriptDeps(html, "page.html")).toEqual([]);
    },
  );

  it("does not report a mode conflict on an element that is no script", async () => {
    const html = `<script data-bascik-build data-bascik-build-once>${SCRIPT}</script>`;
    expect(await executeBuildScripts(html, "page.html")).toBe(html);
  });

  it.each([
    ["a space", " "],
    ["a tab", "\t"],
    ["a newline", "\n"],
    ["a form feed", "\f"],
    ["a carriage return", "\r"],
  ])(
    "still reads a script whose attributes follow %s",
    async (_label, space) => {
      const html = `<script${space}data-bascik-build${space}data-bascik-build-once>${SCRIPT}</script>`;
      // The conflict check runs before anything does: it sees the script.
      await expect(executeBuildScripts(html, "page.html")).rejects.toThrow(
        /cannot combine data-bascik-build and data-bascik-build-once/,
      );
    },
  );

  it("agrees with the masker on what is a script", () => {
    const html = `<p>a</p><script data-bascik-build><my-card></my-card></script>`;
    expect(maskRawTextContent(html)).toBe(html);
  });
});
