import { describe, it, expect } from "vitest";
import {
  findCssSelectors,
  hasClassBeforeInCompound,
} from "./css-selector-anchors.ts";

/** Each selector's text, with what the scan says anchors it. */
const read = (css: string) =>
  findCssSelectors(css).map(({ start, end, hasAnchor, anchoredFrom }) => ({
    text: css.slice(start, end).trim(),
    hasAnchor,
    anchoredAfter:
      anchoredFrom < 0 ? null : css.slice(start, anchoredFrom).trim(),
  }));

describe("findCssSelectors", () => {
  it("splits a selector list at its top-level commas only", () => {
    expect(
      read('.a:is(.b, .c), [data-x="1,2"] > p,\n:not(.d, .e) { color: red; }'),
    ).toEqual([
      { text: ".a:is(.b, .c)", hasAnchor: true, anchoredAfter: null },
      { text: '[data-x="1,2"] > p', hasAnchor: false, anchoredAfter: null },
      { text: ":not(.d, .e)", hasAnchor: false, anchoredAfter: null },
    ]);
  });

  it("reads a wrapped selector as one selector", () => {
    const [selector] = read(
      '.thread\n  :where([data-part="turn"])\n  > [data-state="running"] {\n  display: none;\n}',
    );
    expect(selector).toEqual({
      text: '.thread\n  :where([data-part="turn"])\n  > [data-state="running"]',
      hasAnchor: true,
      anchoredAfter: ".thread",
    });
  });

  it("counts a class at the top level only, not one in parentheses, brackets, or a string", () => {
    expect(
      read(
        '[data-x]:not(.a), [data-x=".a"], [href$=.pdf], :is(.a) .b { color: red; }',
      ).map((selector) => selector.hasAnchor),
    ).toEqual([false, false, false, true]);
  });

  it("starts the anchored part after the first class and a combinator", () => {
    expect(
      read(".a:hover>p, .a.b ~ p, p .a, p .a { color: red; }").map(
        (selector) => selector.anchoredAfter,
      ),
    ).toEqual([".a:hover", ".a.b", null, "p .a"]);
  });

  it("leaves out declarations and at-rule preludes, and reads the rules inside at-rule blocks", () => {
    const css = [
      '@import url(theme.css?a{b,c;d) layer(base, "x");',
      "@media (min-width: 1px), print {",
      "  @supports selector(:is(p)) {",
      "    .a { margin: 0 .5em; font-family: a, b; grid-template-columns:",
      "      [full-start] 1fr [full-end] }",
      "    [data-x] { color: red }",
      "  }",
      "}",
      "@container card (width > 1px) { .b, [data-y] { color: red } }",
    ].join("\n");
    expect(read(css).map((selector) => selector.text)).toEqual([
      ".a",
      "[data-x]",
      ".b",
      "[data-y]",
    ]);
  });

  it("keeps a brace, comma, or semicolon in a string or an unquoted url() out of the structure", () => {
    const css =
      '.a { background: url(data:x,{;}) } [data-x="{,;}"], .b::after { content: "} [data-z] {"; } [data-y] {}';
    expect(read(css).map((selector) => selector.text)).toEqual([
      ".a",
      '[data-x="{,;}"]',
      ".b::after",
      "[data-y]",
    ]);
  });

  it("anchors a nested selector by its parent rule", () => {
    const css =
      ".card { [open] { } &:has(img) { } :is(p) & { } @media print { > [data-x] { } } }";
    expect(read(css)).toEqual([
      { text: ".card", hasAnchor: true, anchoredAfter: ".card" },
      { text: "[open]", hasAnchor: true, anchoredAfter: "" },
      // `&` is the parent: an anchor, with nothing between it and `:has()`.
      { text: "&:has(img)", hasAnchor: true, anchoredAfter: "&:has(img)" },
      { text: ":is(p) &", hasAnchor: true, anchoredAfter: ":is(p) &" },
      { text: "> [data-x]", hasAnchor: true, anchoredAfter: "" },
    ]);
  });

  it("does not anchor a nested selector when a parent selector is unanchored", () => {
    expect(
      read(".a, [data-x] { [open] { } & .b { } & > p { } }").map((selector) => [
        selector.text,
        selector.hasAnchor,
      ]),
    ).toEqual([
      [".a", true],
      ["[data-x]", false],
      ["[open]", false],
      ["& .b", true],
      ["& > p", false],
    ]);
  });

  it.each([
    ['.a { color: "red }\n[data-x] { }', [".a", "[data-x]"]],
    [".a { color: rgb(1, 2 }\n[data-x] { }", [".a", "[data-x]"]],
    [".a { background: url(x }\n[data-x] { }", [".a", "[data-x]"]],
    ["} } [data-x] { }", ["[data-x]"]],
    [".a[data-x { } [data-y] { }", [".a[data-x", "[data-y]"]],
  ])("recovers after unclosed input %j", (css, expected) => {
    expect(read(css).map((selector) => selector.text)).toEqual(expected);
  });

  it("gives every selector of a list the start of the list", () => {
    const css =
      "/* x */\n\n  [data-a],\n[data-b] { color: red; }\n.c,\n.d { color: red; }";
    const masked = css.replace("/* x */", "       ");
    expect(
      findCssSelectors(masked).map(({ listStart }) =>
        masked.slice(listStart, listStart + 8),
      ),
    ).toEqual(["[data-a]", "[data-a]", ".c,\n.d {", ".c,\n.d {"]);
  });

  it("says a nested selector follows its parent unless attribute selectors lead the parent", () => {
    const follows = (css: string) =>
      findCssSelectors(css).map(({ followsParent }) => followsParent);
    expect(follows("#panel { [open] {} }")).toEqual([false, true]);
    expect(follows("section, [data-a] .b { [open] {} }")).toEqual([
      false,
      false,
      true,
    ]);
    expect(follows("[data-a] { [open] {} }")).toEqual([false, false]);
    expect(follows(".a, [data-a] { [open] {} }")).toEqual([
      false,
      false,
      false,
    ]);
    // `&` puts the parent somewhere else in the selector, so the selector does not simply follow it.
    expect(follows("#panel { [open] & {} }")).toEqual([false, false]);
    // An at-rule block is not a parent rule.
    expect(follows("@media (min-width: 1px) { [open] {} }")).toEqual([false]);
    expect(follows("[data-a] { div { [open] {} } }")).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("skips the `<!--` and `-->` that wrap a stylesheet", () => {
    const css = "<!--\n[data-x] {}\n-->\n-->[data-y] {}";
    expect(
      findCssSelectors(css).map(({ start, end }) =>
        css.slice(start, end).trim(),
      ),
    ).toEqual(["[data-x]", "[data-y]"]);
    // Inside a selector `-->` is a class ending in `--` and a child combinator.
    expect(read(".a-->.b {}")).toEqual([
      { text: ".a-->.b", hasAnchor: true, anchoredAfter: ".a--" },
    ]);
  });

  it("knows whether a class stands before an offset in the same compound", () => {
    const css = ".wrap .card:has(img) > :is(p) + p.x:is(a) &:is(b) {}";
    const [selector] = findCssSelectors(css);
    const at = (text: string) =>
      hasClassBeforeInCompound(selector, css.indexOf(text));
    expect(at(":has(img)")).toBe(true);
    expect(at(":is(p)")).toBe(false);
    expect(at(":is(a)")).toBe(true);
    expect(at(":is(b)")).toBe(true);
    expect(at(".wrap")).toBe(false);
    expect(at(".card")).toBe(false);
    expect(hasClassBeforeInCompound(findCssSelectors(":is(p) {}")[0], 0)).toBe(
      false,
    );
  });
});
