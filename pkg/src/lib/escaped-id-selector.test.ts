import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import { recursivelyTranspile } from "./component-expansion.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import {
  convertCssIdSelectorsToClasses,
  cssIdSelectorNames,
} from "./styles.ts";

const setMinify = (identifiers: boolean): void => {
  (BascikConfig.minify as { identifiers: boolean }).identifiers = identifiers;
};

/** CSS.escape for the characters these tests use. */
const cssEscape = (name: string): string =>
  name.replace(/[^\w\u0080-\uffff-]/g, (char) => `\\${char}`);

// Finding 26: an id holding a CSS-special character (`my.id`) is scoped in
// the attribute and in getElementById, so the correctly escaped selector
// `#my\.id` must name the same element in CSS and in querySelector.
describe("an escaped #id selector names the same element as the id attribute (finding 26)", () => {
  afterEach(() => setMinify(false));

  it("converts an escaped id selector in CSS to one generated class, both escape forms", () => {
    const { css, idsConverted } = convertCssIdSelectorsToClasses(
      "#my\\.id { color: red } #my\\2e id:hover{color:blue} #a\\:b{}",
      "c",
    );
    expect(idsConverted.map(({ idName }) => idName)).toEqual(["my.id", "a:b"]);
    expect(css).toBe(
      ".b_id_c_my\\.id { color: red } .b_id_c_my\\.id:hover{color:blue} .b_id_c_a\\:b{}",
    );
    expect(cssIdSelectorNames("#my\\.id{} #my\\2e id {}")).toEqual(["my.id"]);
  });

  it.each([false, true])(
    "rewrites the CSS rule, querySelector, closest and getElementById to agree (minify.identifiers=%s)",
    (minify) => {
      setMinify(minify);
      clearScopingTemplates();
      const list = {
        "js-edge": {
          fileName: "src/components/js-edge.html",
          fileContent:
            '<div><input id="my.id" data-testid="field"><label for="my.id">L</label>' +
            "<style>#my\\.id { color: red }</style>" +
            '<script>document.getElementById("my.id"); document.querySelector("#my\\\\.id"); ' +
            "el.closest('input#my\\\\.id'); document.querySelector(\"#plain\");</script>" +
            '<p id="plain"></p></div>',
        },
      };
      const out = recursivelyTranspile(
        "<js-edge></js-edge>",
        list as never,
        [],
        "src/pages/index.html",
        { ordinalMap: new Map(), issuedIds: new Set() },
      );
      const html = out.transpiledHtmlBody;
      const input = /<input [^>]*>/.exec(html)![0];
      const scopedId = /\bid="([^"]+)"/.exec(input)![1];
      expect(scopedId).not.toBe("my.id");
      const jsSelector = cssEscape(scopedId).replaceAll("\\", "\\\\");
      expect(html).toContain(`getElementById("${scopedId}")`);
      expect(html).toContain(`querySelector("#${jsSelector}")`);
      expect(html).toContain(`closest('input#${jsSelector}')`);
      expect(html).not.toMatch(/#my\\\\\.id/);

      // The CSS rule's class, unescaped, is a class token on the input.
      const css = out.usedComponents
        .map((c) => (c as { cssFileContent?: string }).cssFileContent ?? "")
        .join("");
      const rule = /\.((?:\\.|[\w-])+)\s*\{\s*color: red/.exec(css);
      expect(rule, css).not.toBeNull();
      const ruleClass = rule![1].replace(/\\(.)/g, "$1");
      const classes = /\bclass="([^"]*)"/.exec(input)?.[1].split(/\s+/) ?? [];
      expect(classes).toContain(ruleClass);
    },
  );
});
