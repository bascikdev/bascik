import { describe, expect, it } from "vitest";
import {
  collectDeclaredIds,
  rewriteIdReferencesInHtml,
  rewriteIdReferencesInCss,
} from "./id-references.ts";

describe("collectDeclaredIds", () => {
  it("collects single- and double-quoted ids from HTML and SVG", () => {
    expect(
      collectDeclaredIds(
        `<div id="first"></div><span id='second'></span><svg><path id="icon"></path></svg>`,
      ),
    ).toEqual(new Set(["first", "second", "icon"]));
  });

  it("returns an empty set when no ids are declared", () => {
    expect(collectDeclaredIds("<div><span></span></div>")).toEqual(new Set());
  });

  it("deduplicates ids and accepts malformed unclosed tags", () => {
    expect(collectDeclaredIds('<div id="same"><span id="same"><p id="open">')).toEqual(
      new Set(["same", "open"]),
    );
  });

  it("collects ids inside code elements", () => {
    expect(collectDeclaredIds('<code><span id="example"></span></code>')).toEqual(
      new Set(["example"]),
    );
  });

  it("ignores id-like markup inside comments", () => {
    expect(collectDeclaredIds('<!-- <div id="commented"></div> --><div id="real"></div>')).toEqual(
      new Set(["real"]),
    );
  });
});

describe("rewriteIdReferencesInHtml", () => {
  const rewrite = (html: string): string =>
    rewriteIdReferencesInHtml(html, (id) =>
      id === "local" || id === "$&" || id === "$1" ? `scoped-${id}` : null,
    );

  it.each([
    ["label for", '<label for="local"></label>', '<label for="scoped-local"></label>'],
    ["form", '<input form="local">', '<input form="scoped-local">'],
    ["list", '<input list="local">', '<input list="scoped-local">'],
    ["popovertarget", '<button popovertarget="local"></button>', '<button popovertarget="scoped-local"></button>'],
    ["commandfor", '<button commandfor="local"></button>', '<button commandfor="scoped-local"></button>'],
    ["aria-activedescendant", '<div aria-activedescendant="local"></div>', '<div aria-activedescendant="scoped-local"></div>'],
    ["aria-details", '<div aria-details="local"></div>', '<div aria-details="scoped-local"></div>'],
    ["aria-errormessage", '<div aria-errormessage="local"></div>', '<div aria-errormessage="scoped-local"></div>'],
  ])("rewrites the resolvable %s single-ID reference", (_name, source, expected) => {
    expect(rewrite(source)).toBe(expected);
  });

  it.each([
    "aria-labelledby",
    "aria-describedby",
    "aria-controls",
    "aria-owns",
    "aria-flowto",
  ])("rewrites local tokens independently in %s", (attribute) => {
    expect(rewrite(`<div ${attribute}="external  local\texternal"></div>`)).toBe(
      `<div ${attribute}="external  scoped-local\texternal"></div>`,
    );
  });

  it("rewrites headers on table cells and for on output as token lists", () => {
    expect(rewrite('<td headers="external local"></td><th headers="local"></th><output for="external local"></output>')).toBe(
      '<td headers="external scoped-local"></td><th headers="scoped-local"></th><output for="external scoped-local"></output>',
    );
  });

  it("keeps label for as a single ID rather than a token list", () => {
    expect(rewrite('<label for="local external"></label>')).toBe(
      '<label for="local external"></label>',
    );
  });

  it.each([
    ["anchor href", '<a href="#local"></a>', '<a href="#scoped-local"></a>'],
    ["area href", '<area href="#local">', '<area href="#scoped-local">'],
    ["SVG use href", '<use href="#local"></use>', '<use href="#scoped-local"></use>'],
    ["SVG use xlink:href", '<use xlink:href="#local"></use>', '<use xlink:href="#scoped-local"></use>'],
  ])("rewrites a resolvable %s fragment", (_name, source, expected) => {
    expect(rewrite(source)).toBe(expected);
  });

  it.each([
    "fill",
    "stroke",
    "mask",
    "clip-path",
    "filter",
    "marker-start",
    "marker-mid",
    "marker-end",
  ])("rewrites url fragments in the %s presentation attribute", (attribute) => {
    expect(rewrite(`<path ${attribute}="url(#local)"></path>`)).toBe(
      `<path ${attribute}="url(#scoped-local)"></path>`,
    );
  });

  it("rewrites every local url fragment in an inline style attribute", () => {
    expect(rewrite('<path style="fill: url(#local); filter: url(#external)"></path>')).toBe(
      '<path style="fill: url(#scoped-local); filter: url(#external)"></path>',
    );
  });

  it.each([
    '<a href="#"></a>',
    '<a href="#external"></a>',
    '<a href="/page#local"></a>',
    '<div aria-labelledby=""></div>',
    '<div aria-labelledby="external"></div>',
    '<path fill="url(#external)"></path>',
    '<div data-example=\'for="local"\'></div>',
  ])("leaves an unresolvable or inapplicable value byte-identical", (source) => {
    expect(rewrite(source)).toBe(source);
  });

  it.each([
    '<label for="external"></label>',
    '<input form="external">',
    '<input list="external">',
    '<button popovertarget="external"></button>',
    '<button commandfor="external"></button>',
    '<div aria-activedescendant="external"></div>',
    '<div aria-details="external"></div>',
    '<div aria-errormessage="external"></div>',
    '<div aria-labelledby="external"></div>',
    '<div aria-describedby="external"></div>',
    '<div aria-controls="external"></div>',
    '<div aria-owns="external"></div>',
    '<div aria-flowto="external"></div>',
    '<td headers="external"></td>',
    '<th headers="external"></th>',
    '<output for="external"></output>',
    '<a href="#external"></a>',
    '<area href="#external">',
    '<use href="#external"></use>',
    '<use xlink:href="#external"></use>',
    '<path fill="url(#external)"></path>',
    '<path stroke="url(#external)"></path>',
    '<path mask="url(#external)"></path>',
    '<path clip-path="url(#external)"></path>',
    '<path filter="url(#external)"></path>',
    '<path marker-start="url(#external)"></path>',
    '<path marker-mid="url(#external)"></path>',
    '<path marker-end="url(#external)"></path>',
    '<path style="fill: url(#external)"></path>',
  ])("keeps each unsupported cross-boundary reference unchanged: %s", (source) => {
    expect(rewrite(source)).toBe(source);
  });

  it("preserves replacement tokens in resolved IDs", () => {
    expect(rewrite('<label for="$&"></label><div aria-labelledby="$1 $&"></div>')).toBe(
      '<label for="scoped-$&"></label><div aria-labelledby="scoped-$1 scoped-$&"></div>',
    );
  });

  it("does not rewrite references inside comments", () => {
    const source = '<!-- <label for="local"></label> --><label for="local"></label>';
    expect(rewrite(source)).toBe(
      '<!-- <label for="local"></label> --><label for="scoped-local"></label>',
    );
  });
});

describe("rewriteIdReferencesInCss", () => {
  const rewriteCss = (css: string): string =>
    rewriteIdReferencesInCss(css, (id) =>
      id === "local" || id === "$&" ? `scoped-${id}` : null,
    );

  it("rewrites url(#grad) to match a scoped svg gradient id", () => {
    expect(
      rewriteIdReferencesInCss(
        ".icon { fill: url(#grad); }",
        (id) => id === "grad" ? "bascik__icon__instance__grad" : null,
      ),
    ).toBe(".icon { fill: url(#bascik__icon__instance__grad); }");
  });

  it.each([
    "filter",
    "clip-path",
    "mask",
    "fill",
    "stroke",
    "marker-start",
    "marker-mid",
    "marker-end",
  ])("rewrites a local fragment used by %s", (property) => {
    expect(rewriteCss(`.icon { ${property}: url(#local); }`)).toBe(
      `.icon { ${property}: url(#scoped-local); }`,
    );
  });

  it.each([
    ["single quotes", "url('#local')", "url('#scoped-local')"],
    ["double quotes", 'url("#local")', 'url("#scoped-local")'],
    ["extra whitespace", "url( #local )", "url( #scoped-local )"],
  ])("preserves %s while rewriting the fragment", (_name, source, expected) => {
    expect(rewriteCss(`a { fill: ${source}; }`)).toBe(`a { fill: ${expected}; }`);
  });

  it.each([
    "url(/img/x.png)",
    "url(https://example.com/x.svg)",
    "url(data:image/svg+xml,%3Csvg%3E)",
    "url(sprite.svg#icon)",
    "url()",
  ])("leaves a non-fragment URL byte-identical: %s", (url) => {
    const source = `.icon { background: ${url}; }`;
    expect(rewriteCss(source)).toBe(source);
  });

  it("leaves unresolved fragments byte-identical", () => {
    const source = ".icon { fill: url(#external); }";
    expect(rewriteCss(source)).toBe(source);
  });

  it("does not rewrite url fragments inside CSS comments", () => {
    const source = "/* fill: url(#local) */ .icon { fill: url(#local); }";
    expect(rewriteCss(source)).toBe(
      "/* fill: url(#local) */ .icon { fill: url(#scoped-local); }",
    );
  });

  it("rewrites multiple local fragments independently", () => {
    expect(rewriteCss("a { fill: url(#local); filter: url(#external); }")).toBe(
      "a { fill: url(#scoped-local); filter: url(#external); }",
    );
  });

  it("preserves replacement tokens in resolved IDs", () => {
    expect(rewriteCss("a { fill: url(#$&); }")).toBe(
      "a { fill: url(#scoped-$&); }",
    );
  });
});