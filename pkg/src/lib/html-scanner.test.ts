import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SEAM_SEPARATOR,
  findCommentEnd,
  readStartTagAttributes,
  removeHtmlRanges,
  scanHtml,
  type HtmlRange,
  type ScannedComment,
  type ScannedScript,
} from "./html-scanner.ts";
import {
  domSnapshot,
  parsedLocations,
} from "./html-parse-oracle.test-helper.ts";

const scan = (html: string) => {
  const scripts: ScannedScript[] = [];
  const comments: ScannedComment[] = [];
  const result = scanHtml(html, {
    script: (s) => scripts.push(s),
    comment: (c) => comments.push(c),
  });
  return { ...result, scripts, comments };
};

/** Script elements the scan reports as ordinary HTML scripts, as source text. */
const ordinaryScripts = (html: string): string[] =>
  scan(html)
    .scripts.filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
    .map((s) => html.slice(s.start, s.end));

/**
 * Markup fragments that exercise tokenizer recovery: unclosed tags, stray
 * quotes, comment and CDATA edges, raw text and RCDATA elements, `<template>`,
 * SVG/MathML with integration points and breakout tags, and character
 * references cut in half.
 */
const fragment = fc.constantFrom(
  "<script>a()</script>",
  "<script type=module>m()</script>",
  "<script>",
  "</script>",
  '</script x=">">',
  "<scr",
  "ipt>",
  "<script data-bascik-server>s()</script>",
  "<script/>",
  "<!--",
  "-->",
  "--!>",
  "<!-->",
  "<!--->",
  "<!-- c -->",
  "<!x>",
  "<?p>",
  "</ x>",
  "</>",
  "</",
  "<",
  ">",
  '"',
  "'",
  "=",
  " ",
  "x",
  "&am",
  "p;",
  "&#6",
  "0;",
  "<p>",
  "</p>",
  '<div title="',
  '">',
  "<b <",
  '<div "a>b">',
  "</div>",
  "<pre>",
  "</pre>",
  "<template>",
  "</template>",
  "<textarea>",
  "</textarea>",
  "<title>",
  "</title>",
  "<noscript>",
  "</noscript>",
  "<style>",
  "</style>",
  "<iframe>",
  "</iframe>",
  "<plaintext>",
  "<svg>",
  "</svg>",
  "<svg/>",
  "<math>",
  "</math>",
  "<foreignObject>",
  "</foreignObject>",
  "<desc>",
  "<mi>",
  "</mi>",
  '<annotation-xml encoding="text/html">',
  "<g>",
  "</g>",
  "<font color=red>",
  "<![CDATA[",
  "]]>",
  "<table>",
  "<td>",
  "<select>",
  "<span>",
  "</span>",
  // Raw-text closers with attributes or a quote after the name, and
  // breakouts from foreign content, with or without a table around it.
  '<script>a("</script")</script>',
  "<script>a('</scriptx>')</script>",
  "<script>a()</script foo>",
  "<svg><p>",
  "<math><mi><div>",
  "<svg><foreignObject><p>",
  "<table><svg><tr>",
  "<table><math><mi><td>",
  "<svg><br>",
  "<svg></p>",
  "<tr>",
  "<caption>",
  "<head>",
  "<body>",
  "<math><mi><td></math>",
  "<div>",
  "<li>",
  "<h1>",
  "<button>",
);
const soup = fc
  .array(fragment, { maxLength: 18 })
  .map((parts) => parts.join(""));

describe("scanHtml", () => {
  describe("follows the browser's parse", () => {
    it.each([
      [
        "a literal < in text",
        "<p>1 < 2 <script>a()</script></p>",
        ["<script>a()</script>"],
      ],
      ["< after < in text", "<<script>a()</script>", ["<script>a()</script>"]],
      [
        "a script inside an unclosed tag name",
        "<scr<script>a()</script>ipt>b()</script>",
        [],
      ],
      [
        "a script opener inside a tag's attributes",
        "<b <script>a()</script>",
        [],
      ],
      [
        "a quote before = is part of an attribute name",
        '<div "a>b"><script>a()</script>',
        ["<script>a()</script>"],
      ],
      [
        "a quoted > inside an attribute value",
        '<div title="a>b"><script>a()</script>',
        ["<script>a()</script>"],
      ],
      [
        "an end tag with a quoted > in an attribute",
        '<script>a()</script x=">">',
        ['<script>a()</script x=">">'],
      ],
      [
        "a self-closing script still opens script data",
        "<script/>a()</script>",
        ["<script/>a()</script>"],
      ],
      [
        "a script after a bogus comment",
        "<?x <script>a()</script> ?><script>b()</script>",
        ["<script>b()</script>"],
      ],
      [
        "a no-break space after </script, which does not end it",
        "<script>a()</script\u00a0>b()</script>",
        ["<script>a()</script\u00a0>b()</script>"],
      ],
    ])("finds scripts with %s", (_case, html, expected) => {
      expect(ordinaryScripts(html)).toEqual(expected);
      expect(
        parsedLocations(html).scripts.map((r) => html.slice(r.start, r.end)),
      ).toEqual(expected);
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
        ["<!-->x", 5],
        ["<!--->x", 6],
        ["<!---->x", 7],
        ["<!-- a --!>x", 11],
        ["<!-- a --->x", 11],
        ["<!-- a -- b -->x", 15],
        ["<!-- a --!->x-->", 16],
        ["<!-- open", -1],
      ] as const) {
        expect(findCommentEnd(html, 0), html).toBe(end);
      }
      const html = "<p><!-- a --!><b>kept</b><!-- b --></p>";
      expect(
        scan(html).comments.map((c) => html.slice(c.start, c.end)),
      ).toEqual(["<!-- a --!>", "<!-- b -->"]);
    });

    it("marks scripts in <template> and in SVG or MathML, which are not ordinary page scripts", () => {
      const html =
        "<template><script>t()</script></template>" +
        "<svg><script>s()</script></svg>" +
        "<math><mi><script>m()</script></mi></math>" +
        "<script>page()</script>";
      expect(
        scan(html).scripts.map((s) => [
          html.slice(s.start, s.end),
          s.inTemplate,
          s.inForeign,
        ]),
      ).toEqual([
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
      expect(
        scan(html).comments.map((c) => html.slice(c.start, c.end)),
      ).toEqual(["<!-- svg comment -->", "<!-- after -->"]);
    });

    it("leaves foreign content at breakout tags", () => {
      const html = "<svg><g><p><script>a()</script>";
      expect(ordinaryScripts(html)).toEqual(["<script>a()</script>"]);
    });

    it("reads attributes the way the tokenizer does", () => {
      expect(
        readStartTagAttributes(
          '<script a"b x="c>d" data-bascik-live-reload>',
          0,
        ),
      ).toEqual([
        { name: 'a"b', value: "" },
        { name: "x", value: "c>d" },
        { name: "data-bascik-live-reload", value: "" },
      ]);
      expect(
        readStartTagAttributes('<p title=" data-x" DATA-Y=1 =z>', 0).map(
          (a) => a.name,
        ),
      ).toEqual(["title", "data-y", "=z"]);
    });
  });

  describe("insertionPoint", () => {
    it.each([
      ["ordinary content", "<p>a</p>", 8],
      ["a trailing < that is text", "<p>a</p><", 9],
      ["an unclosed script", "<p>a</p><script>b()", 8],
      ["an unclosed start tag", '<p>a</p><div class="x', 8],
      ["an unclosed comment", "<p>a</p><!-- c", 8],
      ["an unclosed textarea", "<p>a</p><textarea>x", 8],
      ["an unclosed template", "<p>a</p><template><p>x</p>", 8],
      ["an unclosed svg", "<p>a</p><svg><g></g>", 8],
      ["plaintext", "<p>a</p><plaintext>x", 8],
      ["a trailing </", "<p>a</p></", 8],
      ["a trailing <!", "<p>a</p><!", 8],
      ["a closed template and svg", "<template></template><svg></svg>", 32],
      // A breakout start tag (p, div, span, b, ...) pops an unclosed <svg> or
      // <math> off the stack, so what follows is ordinary content again.
      ["svg left by a breakout tag", "<svg><p>x</p><script>a()</script>", 33],
      [
        "math left by a breakout tag",
        "<math><mi>x</mi><div>y</div><script>a()</script>",
        48,
      ],
      ["svg left by a void breakout tag", "<p>a</p><svg><path/><br>b", 25],
      ["svg reopened after a breakout tag", "<svg><p>x</p><svg><g>", 13],
      ["a breakout tag inside a template's svg", "<template><svg><p>x", 0],
    ])(
      "is the start of trailing markup an appended script would not run after: %s",
      (_case, html, point) => {
        expect(scanHtml(html).insertionPoint).toBe(point);
      },
    );
  });

  describe("table-structure tags in foreign content opened inside a table", () => {
    // In a table's insertion modes, these tags (and </table>) can pop the parser out of SVG or MathML, back past
    // the table; whether they do depends on the insertion mode (a <table> in a cell does not), which the scan does
    // not track. So the scan stops at the tag instead of guessing whether what follows is foreign.
    const script = "<script>a()</script>";
    it.each([
      "<table><math><mi><table>",
      "<table><math><mi><tr>",
      "<table><math><mi><td>",
      "<table><math><mi><caption>",
      "<table><math><mi><tbody>",
      "<table><math><mi></table>",
      "<table><svg><foreignObject><table>",
      "<table><svg><foreignObject><tr>",
      "<table><svg><foreignObject></table>",
      "<table><td><math><mi><tr>",
      "<table><td><svg><foreignObject><td>",
    ])("stops at the tag, and agrees with parse5 before it: %s", (prefix) => {
      const html = `${prefix}${script}`;
      const { scripts, stoppedAt } = scan(html);
      const tagStart = prefix.lastIndexOf("<");
      expect(stoppedAt).toBe(tagStart);
      const reported = scripts
        .filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
        .filter((s) => s.start < stoppedAt);
      expect(reported).toEqual([]);
      expect(
        parsedLocations(html).scripts.filter((r) => r.start < stoppedAt),
      ).toEqual([]);
    });

    it("keeps scanning foreign content that has no table around it", () => {
      const html = `<div><svg><foreignObject><table><tr>${script}`;
      expect(scan(html).stoppedAt).toBe(html.length);
    });
  });

  describe("start tags that close an open <p> in an integration point", () => {
    const script = "<script>a()</script>";
    // "In body", these start tags close a <p> open in button scope first.
    // Left open, the <p> let a later `</p>` pop the element after it, and
    // the end tag of the SVG or MathML then closed it, where the browser
    // ignores that end tag at the still-open element (shrunk by fast-check
    // from the insertion-point property, R2-07-b).
    it.each(["div", "section", "ul", "h2", "hr", "form", "p", "pre"])(
      "<%s> closes the <p>, as in parse5",
      (name) => {
        for (const html of [
          `<svg><foreignObject><p><${name}><svg></p></svg>${script}`,
          `<math><mi><p><${name}><svg></p></math>${script}`,
          `<svg><foreignObject><p><div "a>b"><svg></p></svg>${script}`,
        ]) {
          const { scripts, stoppedAt, insertionPoint } = scan(html);
          const expected = parsedLocations(html).scripts.filter(
            (r) => r.start < stoppedAt,
          );
          expect(
            scripts
              .filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
              .map((s) => ({ start: s.start, end: s.end })),
            html,
          ).toEqual(expected);
          const inserted = "<script>inserted()</script>";
          const page =
            html.slice(0, insertionPoint) +
            inserted +
            html.slice(insertionPoint);
          expect(
            parsedLocations(page).scripts.some(
              (r) => r.start === insertionPoint,
            ),
            html,
          ).toBe(true);
        }
      },
    );

    it("misuse: a <p> behind a <button> stays open, as in parse5", () => {
      // Button scope stops at <button>, so the <div> closes no <p> there.
      const html = `<svg><foreignObject><p><button><div></div></button></p></svg>${script}`;
      expect(ordinaryScripts(html)).toEqual(
        parsedLocations(html).scripts.map((r) => html.slice(r.start, r.end)),
      );
    });
  });

  describe("end tags inside a <select> in foreign content", () => {
    // Parsers that read `<select>` content with the "in select" mode ignore
    // every end tag there but the select's and its options'; the newer
    // customizable `<select>` parses more. Inside SVG or MathML, where the
    // end tag decides whether the foreign content closes, the scan stops at
    // one instead of guessing (shrunk by fast-check, R2-07-b).
    it.each([
      "<svg><foreignObject><p><select></p></foreignObject><p>",
      "<math><mi><select></mi></math><script>a()</script>",
      "<svg><desc><div><select></div></desc></svg><script>a()</script>",
    ])("stops at it, and agrees with parse5 before it: %s", (html) => {
      const { scripts, stoppedAt, insertionPoint } = scan(html);
      expect(stoppedAt).toBe(html.indexOf("</", html.indexOf("<select>")));
      expect(
        scripts
          .filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
          .filter((s) => s.start < stoppedAt),
      ).toEqual([]);
      const inserted = "<script>inserted()</script>";
      const page =
        html.slice(0, insertionPoint) + inserted + html.slice(insertionPoint);
      expect(
        parsedLocations(page).scripts.some((r) => r.start === insertionPoint),
      ).toBe(true);
    });

    it("misuse: options and the select's own end tag are still followed", () => {
      const html =
        "<svg><foreignObject><select><option>a</option><optgroup></optgroup></select></foreignObject></svg><script>a()</script>";
      expect(scan(html).stoppedAt).toBe(html.length);
      expect(ordinaryScripts(html)).toEqual(["<script>a()</script>"]);
    });
  });

  describe("ignored start tags in an integration point", () => {
    const script = "<script>a()</script>";
    // "In body" ignores these start tags, so they open nothing inside an
    // integration point, and the end tag of the SVG or MathML after them
    // still closes it. Counted as open, they kept everything after in
    // foreign content: its scripts stayed in place and the insertion point
    // moved back to the <svg> or <math> (R2-07-b).
    it.each([
      "td",
      "th",
      "tr",
      "tbody",
      "thead",
      "tfoot",
      "caption",
      "colgroup",
      "head",
      "html",
      "body",
    ])(
      "an ignored <%s> in an integration point with no table opens nothing, as in parse5",
      (name) => {
        for (const html of [
          `<math><mi><${name}></math>${script}`,
          `<svg><foreignObject><${name}></svg>${script}`,
          `<svg><desc><${name}></desc></svg>${script}`,
        ]) {
          const expected = parsedLocations(html).scripts.map((r) =>
            html.slice(r.start, r.end),
          );
          expect(expected, html).toEqual([script]);
          expect(ordinaryScripts(html), html).toEqual(expected);
          expect(scanHtml(html).insertionPoint, html).toBe(html.length);
        }
      },
    );

    it("misuse: the same tags after a <table> opened in the integration point still count, as in parse5", () => {
      for (const html of [
        `<math><mi><table><td></math>${script}`,
        `<svg><foreignObject><table><tr></svg>${script}`,
      ]) {
        const { scripts, stoppedAt } = scan(html);
        const expected = parsedLocations(html).scripts.filter(
          (r) => r.start < stoppedAt,
        );
        expect(
          scripts
            .filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
            .map((s) => ({ start: s.start, end: s.end })),
          html,
        ).toEqual(expected);
      }
    });
  });

  it("places an inserted script where parse5 runs it, in random malformed markup", () => {
    // The insertion point (R2-07-b): a script written there is an ordinary
    // HTML script, outside <template> and SVG/MathML, with exactly the
    // inserted source range, whatever the page leaves open after it. It may
    // be earlier than it has to be where the scan errs toward foreign
    // content (`<math><mi><td></math>`: the ignored `<td>` is counted as
    // open, so `</math>` is not known to close the math), never later.
    const inserted = "<script>inserted()</script>";
    let inside = 0;
    fc.assert(
      fc.property(soup, (html) => {
        const { insertionPoint } = scanHtml(html);
        if (insertionPoint > 0 && insertionPoint < html.length) inside++;
        expect(insertionPoint).toBeGreaterThanOrEqual(0);
        expect(insertionPoint).toBeLessThanOrEqual(html.length);
        const page =
          html.slice(0, insertionPoint) + inserted + html.slice(insertionPoint);
        expect(
          parsedLocations(page).scripts.filter(
            (r) => r.start === insertionPoint,
          ),
        ).toEqual([
          { start: insertionPoint, end: insertionPoint + inserted.length },
        ]);
      }),
      { numRuns: Number(process.env.SCAN_ORACLE_RUNS ?? 4000) },
    );
    // Not only appends: many pages end inside markup.
    expect(inside).toBeGreaterThan(200);
  }, 60_000);

  it("matches parse5 on every script and comment range in random malformed markup", () => {
    fc.assert(
      fc.property(soup, (html) => {
        const { scripts, comments, stoppedAt } = scan(html);
        const expected = parsedLocations(html);
        const reportedScripts = scripts
          .filter((s) => !s.inTemplate && !s.inForeign && s.terminated)
          .map((s) => [s.start, s.end]);
        const reportedComments = comments
          .filter((c) => c.terminated)
          .map((c) => [c.start, c.end]);
        const before = (range: { start: number }) => range.start < stoppedAt;
        expect(reportedScripts).toEqual(
          expected.scripts.filter(before).map((r) => [r.start, r.end]),
        );
        expect(reportedComments).toEqual(
          expected.comments
            .filter(before)
            .filter(
              (r) =>
                r.end <= html.length && findCommentEnd(html, r.start) !== -1,
            )
            .map((r) => [r.start, r.end]),
        );
      }),
      { numRuns: Number(process.env.SCAN_ORACLE_RUNS ?? 4000) },
    );
  }, 60_000);
});

describe("removeHtmlRanges", () => {
  const rangeOf = (html: string, part: string) => {
    const start = html.indexOf(part);
    return { start, end: start + part.length };
  };

  it("removes ranges and maps an index past them", () => {
    const html = "<p>a</p><!-- x --><p>b</p><!-- y --><p>c</p>";
    const result = removeHtmlRanges(
      html,
      [rangeOf(html, "<!-- y -->"), rangeOf(html, "<!-- x -->")],
      html.indexOf("<p>c"),
    );
    expect(result.html).toBe("<p>a</p><p>b</p><p>c</p>");
    expect(result.html.slice(result.index)).toBe("<p>c</p>");
  });

  it.each([
    ["a text <", "<p><<!-- c -->script>b()</script></p>", "<!-- c -->"],
    ["an unfinished named reference", "<p>&am<!-- c -->p;</p>", "<!-- c -->"],
    ["an unfinished numeric reference", "<p>&#6<!-- c -->0;</p>", "<!-- c -->"],
    // The tokenizer keeps reading digits however many leading zeros come first.
    [
      "a numeric reference with 70 leading zeros",
      `<p>&#${"0".repeat(70)}<!-- c -->60;</p>`,
      "<!-- c -->",
    ],
    [
      "a hex reference with 70 leading zeros",
      `<p>&#x${"0".repeat(70)}<!-- c -->3c;</p>`,
      "<!-- c -->",
    ],
  ])(
    "keeps the text around a removal from joining after %s",
    (_case, html, removed) => {
      const result = removeHtmlRanges(html, [rangeOf(html, removed)]).html;
      expect(result).toContain(SEAM_SEPARATOR);
      expect(domSnapshot(result)).toEqual(domSnapshot(html));
    },
  );

  it("writes the separator exactly where the output before a removal ends in < or an unfinished reference", () => {
    // The reference model: the regex on everything written so far.
    const pendingRe = /(?:<|&[#0-9A-Za-z]*)$/;
    // Long reference runs reach past any fixed look-back window.
    const longReference = fc
      .string({
        unit: fc.constantFrom("0", "1", "a", "x"),
        minLength: 60,
        maxLength: 100,
      })
      .map((run) => `&#${run}`);
    const piece = fc.oneof(
      {
        weight: 9,
        arbitrary: fc.constantFrom("&", "#", "x", "0", "a", ";", "<", ">", " "),
      },
      { weight: 1, arbitrary: longReference },
    );
    fc.assert(
      fc.property(
        fc.array(fc.array(piece, { maxLength: 80 }), {
          minLength: 1,
          maxLength: 5,
        }),
        (texts) => {
          const removed = "<!-- c -->";
          const html = texts.map((t) => t.join("")).join(removed);
          const ranges: HtmlRange[] = [];
          let expected = "";
          let at = 0;
          texts.forEach((t, k) => {
            const text = t.join("");
            expected += text;
            at += text.length;
            if (k === texts.length - 1) return;
            ranges.push({ start: at, end: at + removed.length });
            if (pendingRe.test(expected)) expected += SEAM_SEPARATOR;
            at += removed.length;
          });
          expect(removeHtmlRanges(html, ranges).html).toBe(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("adds no separator after a long run of letters and digits with no & before it", () => {
    const html = `<p>${"a1".repeat(100)}<!-- c -->b</p>`;
    expect(removeHtmlRanges(html, [rangeOf(html, "<!-- c -->")]).html).toBe(
      `<p>${"a1".repeat(100)}b</p>`,
    );
  });

  it("drops ranges inside or overlapping an earlier one", () => {
    const html = "<a>0123456789</a>";
    expect(
      removeHtmlRanges(html, [
        { start: 5, end: 9 },
        { start: 3, end: 13 },
        { start: 8, end: 14 },
      ]).html,
    ).toBe("<a></a>");
  });
});
