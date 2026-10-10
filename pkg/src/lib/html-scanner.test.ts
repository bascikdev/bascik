import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SEAM_SEPARATOR,
  findCommentEnd,
  readStartTagAttributes,
  removeHtmlRanges,
  scanHtml,
  type ScannedComment,
  type ScannedScript,
} from "./html-scanner.ts";
import { domSnapshot, parsedLocations } from "./html-parse-oracle.test-helper.ts";

const scan = (html: string) => {
  const scripts: ScannedScript[] = [];
  const comments: ScannedComment[] = [];
  const result = scanHtml(html, { script: (s) => scripts.push(s), comment: (c) => comments.push(c) });
  return { ...result, scripts, comments };
};

/** Script elements the scan reports as ordinary HTML scripts, as source text. */
const ordinaryScripts = (html: string): string[] =>
  scan(html).scripts
    .filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
    .map((s) => html.slice(s.start, s.end));

/**
 * Markup fragments that exercise tokenizer recovery: unclosed tags, stray
 * quotes, comment and CDATA edges, raw text and RCDATA elements, `<template>`,
 * SVG/MathML with integration points and breakout tags, and character
 * references cut in half.
 */
const fragment = fc.constantFrom(
  "<script>a()</script>", "<script type=module>m()</script>", "<script>", "</script>", "</script x=\">\">",
  "<scr", "ipt>", "<script data-bascik-server>s()</script>", "<script/>",
  "<!--", "-->", "--!>", "<!-->", "<!--->", "<!-- c -->", "<!x>", "<?p>", "</ x>", "</>", "</",
  "<", ">", "\"", "'", "=", " ", "x", "&am", "p;", "&#6", "0;",
  "<p>", "</p>", "<div title=\"", "\">", "<b <", "<div \"a>b\">", "</div>",
  "<pre>", "</pre>", "<template>", "</template>", "<textarea>", "</textarea>", "<title>", "</title>",
  "<noscript>", "</noscript>", "<style>", "</style>", "<iframe>", "</iframe>", "<plaintext>",
  "<svg>", "</svg>", "<svg/>", "<math>", "</math>", "<foreignObject>", "</foreignObject>", "<desc>",
  "<mi>", "</mi>", "<annotation-xml encoding=\"text/html\">", "<g>", "</g>", "<font color=red>",
  "<![CDATA[", "]]>", "<table>", "<td>", "<select>", "<span>", "</span>",
);
const soup = fc.array(fragment, { maxLength: 18 }).map((parts) => parts.join(""));

describe("scanHtml", () => {
  describe("follows the browser's parse", () => {
    it.each([
      ["a literal < in text", "<p>1 < 2 <script>a()</script></p>", ["<script>a()</script>"]],
      ["< after < in text", "<<script>a()</script>", ["<script>a()</script>"]],
      ["a script inside an unclosed tag name", "<scr<script>a()</script>ipt>b()</script>", []],
      ["a script opener inside a tag's attributes", "<b <script>a()</script>", []],
      ["a quote before = is part of an attribute name", "<div \"a>b\"><script>a()</script>", ["<script>a()</script>"]],
      ["a quoted > inside an attribute value", '<div title="a>b"><script>a()</script>', ["<script>a()</script>"]],
      ["an end tag with a quoted > in an attribute", '<script>a()</script x=">">', ['<script>a()</script x=">">']],
      ["a self-closing script still opens script data", "<script/>a()</script>", ["<script/>a()</script>"]],
      ["a script after a bogus comment", "<?x <script>a()</script> ?><script>b()</script>", ["<script>b()</script>"]],
    ])("finds scripts with %s", (_case, html, expected) => {
      expect(ordinaryScripts(html)).toEqual(expected);
      expect(parsedLocations(html).scripts.map((r) => html.slice(r.start, r.end))).toEqual(expected);
    });

    it.each([
      ["textarea", "<textarea><script>a()</script><!-- c --></textarea>"],
      ["title", "<title><script>a()</script><!-- c --></title>"],
      ["noscript", "<noscript><script>a()</script><!-- c --></noscript>"],
      ["style", "<style>/*<script>a()</script><!-- c -->*/</style>"],
      ["iframe", "<iframe><script>a()</script><!-- c --></iframe>"],
      ["plaintext", "<plaintext><script>a()</script><!-- c -->"],
    ])("treats %s contents as text", (_name, html) => {
      const { scripts, comments } = scan(html);
      expect(scripts).toEqual([]);
      expect(comments).toEqual([]);
    });

    it("ends comments where the browser does", () => {
      for (const [html, end] of [
        ["<!-->x", 5], ["<!--->x", 6], ["<!---->x", 7], ["<!-- a --!>x", 11], ["<!-- a --->x", 11],
        ["<!-- a -- b -->x", 15], ["<!-- a --!->x-->", 16], ["<!-- open", -1],
      ] as const) {
        expect(findCommentEnd(html, 0), html).toBe(end);
      }
      const html = "<p><!-- a --!><b>kept</b><!-- b --></p>";
      expect(scan(html).comments.map((c) => html.slice(c.start, c.end))).toEqual(["<!-- a --!>", "<!-- b -->"]);
    });

    it("marks scripts in <template> and in SVG or MathML, which are not ordinary page scripts", () => {
      const html =
        "<template><script>t()</script></template>" +
        "<svg><script>s()</script></svg>" +
        "<math><mi><script>m()</script></mi></math>" +
        "<script>page()</script>";
      expect(scan(html).scripts.map((s) => [html.slice(s.start, s.end), s.inTemplate, s.inForeign])).toEqual([
        ["<script>t()</script>", true, false],
        ["<script>s()</script>", false, true],
        ["<script>m()</script>", false, true],
        ["<script>page()</script>", false, false],
      ]);
    });

    it("parses SVG content as markup, with CDATA sections and integration points", () => {
      // In SVG, <style> is not raw text and CDATA is text; inside
      // <foreignObject>, HTML rules apply again.
      const html =
        "<svg><style><!-- svg comment --></style><![CDATA[ <!-- not a comment --> ]]>" +
        "<foreignObject><textarea><!-- text --></textarea></foreignObject></svg><!-- after -->";
      expect(scan(html).comments.map((c) => html.slice(c.start, c.end))).toEqual(["<!-- svg comment -->", "<!-- after -->"]);
    });

    it("leaves foreign content at breakout tags", () => {
      const html = "<svg><g><p><script>a()</script>";
      expect(ordinaryScripts(html)).toEqual(["<script>a()</script>"]);
    });

    it("reads attributes the way the tokenizer does", () => {
      expect(readStartTagAttributes('<script a"b x="c>d" data-bascik-live-reload>', 0)).toEqual([
        { name: 'a"b', value: "" },
        { name: "x", value: "c>d" },
        { name: "data-bascik-live-reload", value: "" },
      ]);
      expect(readStartTagAttributes('<p title=" data-x" DATA-Y=1 =z>', 0).map((a) => a.name)).toEqual(["title", "data-y", "=z"]);
    });
  });

  describe("insertionPoint", () => {
    it.each([
      ["ordinary content", "<p>a</p>", 8],
      ["a trailing < that is text", "<p>a</p><", 9],
      ["an unclosed script", "<p>a</p><script>b()", 8],
      ["an unclosed start tag", "<p>a</p><div class=\"x", 8],
      ["an unclosed comment", "<p>a</p><!-- c", 8],
      ["an unclosed textarea", "<p>a</p><textarea>x", 8],
      ["an unclosed template", "<p>a</p><template><p>x</p>", 8],
      ["an unclosed svg", "<p>a</p><svg><g></g>", 8],
      ["plaintext", "<p>a</p><plaintext>x", 8],
      ["a trailing </", "<p>a</p></", 8],
      ["a trailing <!", "<p>a</p><!", 8],
      ["a closed template and svg", "<template></template><svg></svg>", 32],
    ])("is the start of trailing markup an appended script would not run after: %s", (_case, html, point) => {
      expect(scanHtml(html).insertionPoint).toBe(point);
    });
  });

  it("matches parse5 on every script and comment range in random malformed markup", () => {
    fc.assert(
      fc.property(soup, (html) => {
        const { scripts, comments, stoppedAt } = scan(html);
        const expected = parsedLocations(html);
        const reportedScripts = scripts
          .filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
          .map((s) => [s.start, s.end]);
        const reportedComments = comments.filter((c) => c.terminated).map((c) => [c.start, c.end]);
        const before = (range: { start: number }) => range.start < stoppedAt;
        expect(reportedScripts).toEqual(expected.scripts.filter(before).map((r) => [r.start, r.end]));
        expect(reportedComments).toEqual(
          expected.comments.filter(before).filter((r) => r.end <= html.length && findCommentEnd(html, r.start) !== -1)
            .map((r) => [r.start, r.end]),
        );
      }),
      { numRuns: 4000 },
    );
  });

  it("stays linear on hostile input", () => {
    const started = performance.now();
    scanHtml(`<svg>${"<g>".repeat(20_000)}${"</x>".repeat(20_000)}`);
    scanHtml(`<svg><foreignObject>${"<div>".repeat(20_000)}${"</g>".repeat(20_000)}`);
    scanHtml(`<p ${'a="b" '.repeat(50_000)}`);
    scanHtml(`<script>${"</scripts".repeat(50_000)}`);
    scanHtml("<!--".repeat(50_000));
    scanHtml("<".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("removeHtmlRanges", () => {
  const rangeOf = (html: string, part: string) => {
    const start = html.indexOf(part);
    return { start, end: start + part.length };
  };

  it("removes ranges and maps an index past them", () => {
    const html = "<p>a</p><!-- x --><p>b</p><!-- y --><p>c</p>";
    const result = removeHtmlRanges(html, [rangeOf(html, "<!-- y -->"), rangeOf(html, "<!-- x -->")], html.indexOf("<p>c"));
    expect(result.html).toBe("<p>a</p><p>b</p><p>c</p>");
    expect(result.html.slice(result.index)).toBe("<p>c</p>");
  });

  it.each([
    ["a text <", "<p><<!-- c -->script>b()</script></p>", "<!-- c -->"],
    ["an unfinished named reference", "<p>&am<!-- c -->p;</p>", "<!-- c -->"],
    ["an unfinished numeric reference", "<p>&#6<!-- c -->0;</p>", "<!-- c -->"],
  ])("keeps the text around a removal from joining after %s", (_case, html, removed) => {
    const result = removeHtmlRanges(html, [rangeOf(html, removed)]).html;
    expect(result).toContain(SEAM_SEPARATOR);
    expect(domSnapshot(result)).toEqual(domSnapshot(html));
  });

  it("drops ranges inside or overlapping an earlier one", () => {
    const html = "<a>0123456789</a>";
    expect(removeHtmlRanges(html, [{ start: 5, end: 9 }, { start: 3, end: 13 }, { start: 8, end: 14 }]).html).toBe("<a></a>");
  });
});
