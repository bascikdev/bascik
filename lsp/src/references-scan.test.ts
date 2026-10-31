import { describe, expect, it } from "vitest";
import { findCommentEnd, scanHtmlTags } from "./references.js";
import { findComponentUsages, maskLikeCompiler } from "./component-usages.js";

/** The opening tag names the scan reports, lower-cased, in order. */
const openNames = (html: string): string[] =>
  scanHtmlTags(html)
    .filter((tag) => !tag.closing)
    .map((tag) => tag.name.toLowerCase());

describe("scanHtmlTags, the usage scan behind Find All References", () => {
  it("reports opening and closing tags with the offset of the name", () => {
    const html = '<my-card a="1"></my-card>';
    expect(scanHtmlTags(html)).toEqual([
      { name: "my-card", closing: false, start: 0, nameStart: 1, end: 15 },
      { name: "my-card", closing: true, start: 15, nameStart: 17, end: 25 },
    ]);
  });

  it.each([
    ["a comment", "<!-- <my-card></my-card> --><p></p>", ["p"]],
    ["a comment closed with --!>", "<!-- <my-card> --!><p></p>", ["p"]],
    ["the empty comment <!-->", "<!--><my-card></my-card>", ["my-card"]],
    ["the empty comment <!--->", "<!---><my-card></my-card>", ["my-card"]],
    [
      "a double-quoted attribute value",
      '<div title="<my-card></my-card>"></div>',
      ["div"],
    ],
    ["a single-quoted attribute value", "<div t='<my-card/>'></div>", ["div"]],
    [
      "a script body",
      '<script>const t = "<my-card></my-card>";</script>',
      ["script"],
    ],
    [
      "a JSON-LD script body",
      '<script type="application/ld+json">{"t":"<my-card>"}</script>',
      ["script"],
    ],
    ["a style body", "<style>/* <my-card> */</style>", ["style"]],
    [
      "a textarea body",
      "<textarea><my-card></my-card></textarea>",
      ["textarea"],
    ],
    [
      "a script closed with spaces before >",
      "<script><my-card></script  ><my-card></my-card>",
      ["script", "my-card"],
    ],
    ["escaped text", "<p>&lt;my-card&gt;</p>", ["p"]],
  ])("hides tags inside %s", (_label, html, expected) => {
    expect(openNames(html)).toEqual(expected);
  });

  it.each([
    ["<pre>", "<pre><my-card></my-card></pre>", ["pre", "my-card"]],
    ["<code>", "<code><my-card></my-card></code>", ["code", "my-card"]],
    [
      "<template>",
      "<template><my-card></my-card></template>",
      ["template", "my-card"],
    ],
    ["a self-closing tag", "<my-card/>", ["my-card"]],
    [
      "a comment with no end, which hides nothing",
      "<!-- <my-card></my-card>",
      ["my-card"],
    ],
    [
      "a <!-- inside an attribute value, which is not a comment",
      '<input value="<!--"><my-card></my-card> -->',
      ["input", "my-card"],
    ],
    [
      "a script with no closer, which hides nothing",
      "<script><my-card></my-card>",
      ["script", "my-card"],
    ],
  ])("keeps tags inside %s", (_label, html, expected) => {
    expect(openNames(html)).toEqual(expected);
  });

  it("does not read a longer name as a shorter one", () => {
    expect(
      openNames("<my-card-list></my-card-list><my-cards></my-cards>"),
    ).toEqual(["my-card-list", "my-cards"]);
  });

  it("finds where a comment ends as the HTML tokenizer does", () => {
    expect(findCommentEnd("<!-->", 0)).toBe(5);
    expect(findCommentEnd("<!--->", 0)).toBe(6);
    expect(findCommentEnd("<!-- a -- b -->", 0)).toBe(15);
    expect(findCommentEnd("<!-- a --!>", 0)).toBe(11);
    expect(findCommentEnd("<!-- a", 0)).toBe(-1);
  });
});

/**
 * The usage search mirrors the compiler's pipeline: `maskRawTextContent` (pkg/src/lib/component-masking.ts),
 * then `getFirstComponent` (pkg/src/lib/component-tags.ts) from each found usage onward. Every expected list
 * below is what the compiler returned for the same input and the same component names (Node 24, 2026-10-29),
 * so a change on either side shows up here.
 */
describe("findComponentUsages, the compiler's own reading of component tags", () => {
  const names = new Set(["my-card", "x-a", "style-guide", "script-loader"]);
  const usages = (html: string): [number, string][] =>
    findComponentUsages(html, names).map((found) => [found.start, found.name]);

  it.each<[string, string, [number, string][]]>([
    [
      "a legacy escaped script body, which the inner </script> does not end",
      `<script><!-- document.write("<script>x</script>"); <my-card></my-card> --></script><x-a></x-a>`,
      [[83, "x-a"]],
    ],
    // A browser reads a tag name up to tag whitespace, `/` or `>`: these are
    // the tags `my-card:foo`, `my-card.foo` and `my-card<`, not `my-card`.
    ["a name followed by a colon", "<my-card:foo></my-card:foo>", []],
    ["a name followed by a dot", "<my-card.foo></my-card.foo>", []],
    [
      "a name followed by another tag's <",
      "<p>a <my-card</p><x-a></x-a>",
      [[17, "x-a"]],
    ],
    [
      "a name followed by tag whitespace or /",
      "<my-card\tclass=a></my-card><x-a/>",
      [
        [0, "my-card"],
        [27, "x-a"],
      ],
    ],
    [
      "text after an attribute quote that never closes",
      '<div data-x="foo><my-card></my-card>',
      [],
    ],
    [
      "a component named style-guide, which is no style element even with a </style> after it",
      "<style-guide>a</style-guide><my-card></my-card><p></style></p>",
      [
        [0, "style-guide"],
        [28, "my-card"],
      ],
    ],
    [
      "a component named script-loader, which is no script element even with a </script> after it",
      "<script-loader></script-loader><my-card></my-card><script>x</script><x-a></x-a>",
      [
        [0, "script-loader"],
        [31, "my-card"],
        [68, "x-a"],
      ],
    ],
    [
      "a style opener followed by tag whitespace, which does open a style body",
      "<style\n><my-card></my-card></style><x-a></x-a>",
      [[35, "x-a"]],
    ],
    [
      "a style-guide with no </style> after it, which hides nothing",
      "<style-guide><my-card></my-card></style-guide>",
      [
        [0, "style-guide"],
        [13, "my-card"],
      ],
    ],
    [
      "a self-closing <script/>, whose body still runs to </script>",
      "<script/><my-card></my-card></script><x-a></x-a>",
      [[37, "x-a"]],
    ],
    [
      "a quote that does not follow =, which starts no value",
      '<div "x><my-card></my-card>',
      [[8, "my-card"]],
    ],
    [
      "a <!-- inside an attribute value, which is not a comment",
      '<div title="<!--"><my-card></my-card> --><x-a></x-a>',
      [
        [18, "my-card"],
        [41, "x-a"],
      ],
    ],
    ["a name with no > after it", "<my-card", []],
    ["a last name with no > after it", "<x-a></x-a><my-card", [[0, "x-a"]]],
    [
      "a comment, attribute value and script body",
      `<!-- <my-card> --><div title="<my-card>"></div><script>"<my-card>"</script><x-a/>`,
      [[75, "x-a"]],
    ],
    ["upper case", "<MY-CARD></MY-CARD>", [[0, "my-card"]]],
    // A raw-text opener inside another tag opens nothing, so the tag's own
    // quote is not blanked up to a later real closer.
    [
      "a script opener inside an attribute value, with a real script after it",
      `<p title="<script>">tip</p><my-card></my-card><script>x()</script>`,
      [[27, "my-card"]],
    ],
    [
      "a style opener in another tag's name",
      "<p<style><my-card></my-card></style>",
      [[9, "my-card"]],
    ],
    // A raw-text element ends at `</name` and tag whitespace, `/` or `>`.
    [
      "a closer with a slash",
      "<style></style/><my-card></my-card></style>",
      [[16, "my-card"]],
    ],
    [
      "a closer with an attribute",
      "<script></script x=1><x-a></x-a></script>",
      [[21, "x-a"]],
    ],
    [
      "a closer followed by a vertical tab, which ends nothing",
      "<style></style\u000b><my-card></my-card></style>",
      [],
    ],
    // A name inside another tag or a bogus comment is part of it.
    ["a name in another tag's name", "<p<my-card></my-card>", []],
    ["a name in a bogus comment", "<!x<my-card><?<x-a></x-a>", []],
    [
      "a name in an end tag's attribute",
      "</p <my-card><x-a></x-a>",
      [[13, "x-a"]],
    ],
    [
      "a longer name that only starts with a component name",
      "<my-card-list></my-card-list><my-cards></my-cards>",
      [],
    ],
  ])("reads %s as the compiler does", (_label, html, expected) => {
    expect(usages(html)).toEqual(expected);
  });

  it("reports where the name starts and ends", () => {
    expect(findComponentUsages('<p><x-a b="1"/></p>', names)).toEqual([
      { name: "x-a", start: 3, nameStart: 4, nameEnd: 7 },
    ]);
  });

  it("masks comment bodies and raw-text bodies like maskRawTextContent", () => {
    expect(maskLikeCompiler("<!-- <a> --><style>b</style>")).toBe(
      "<!--     --><style> </style>",
    );
    expect(maskLikeCompiler("<p>plain</p>")).toBe("<p>plain</p>");
  });
});
