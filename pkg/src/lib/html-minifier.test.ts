import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { minifyHtml, extractScriptTags } from "./html-minifier.ts";
import { domSnapshot } from "./html-parse-oracle.test-helper.ts";

/**
 * The browser's view of `html`: structure and text with whitespace and
 * comments set aside, plus the scripts that can run (any script outside
 * `<template>`), which the minifier may move.
 */
const parsedAsBrowser = (html: string) =>
  domSnapshot(html, {
    ignoreWhitespace: true,
    ignoreEmptyFormattingElements: true,
    collectScript: (_script, inTemplate) => !inTemplate,
  });

/** Minifying must not change what the browser builds or which scripts run. */
const expectSameParse = (html: string): string => {
  const minified = minifyHtml(html);
  expect(parsedAsBrowser(minified)).toEqual(parsedAsBrowser(html));
  return minified;
};

describe("extractScriptTags", () => {
  it("extracts all <script> tags and removes HTML comments", () => {
    const html = `
      <div>Hello</div>
      <!-- comment -->
      <script>console.log(1);</script>
      <p>World</p>
      <script src="app.js"></script>
    `;
    const extracted = extractScriptTags(html);
    expect(extracted).toBe("<script>console.log(1);</script>\n<script src=\"app.js\"></script>");
  });

  it("ignores data-bascik-build and data-bascik-server scripts", () => {
    const html = `
      <script data-bascik-server>server()</script>
      <script>client()</script>
      <script data-bascik-build>build()</script>
    `;
    const extracted = extractScriptTags(html);
    expect(extracted).toBe("<script>client()</script>");
  });

  it("ignores non-executable scripts with single or double quotes such as application/ld+json or importmap", () => {
    const html = `
      <script type='application/ld+json'>{ "name": "test" }</script>
      <script type="importmap">{ "imports": {} }</script>
      <script>client()</script>
    `;
    const extracted = extractScriptTags(html);
    expect(extracted).toBe("<script>client()</script>");
  });

  it("returns an empty string if no script tags are present", () => {
    expect(extractScriptTags("<div>No scripts here</div>")).toBe("");
  });

  it("never hoists a <script> that sits inside an unclosed tag, so removal cannot join a new script", () => {
    // The browser parses `<scr<script>` as one `scr<script` tag and runs
    // nothing. Hoisting the inner match would join `<scr` and `ipt>` into an
    // executable `<script>b()</script>`.
    const html = `<p>x</p><scr<script>a()</script>ipt>b()</script><script>c()</script>`;
    expect(extractScriptTags(html)).toBe("<script>c()</script>");
    const minified = minifyHtml(html);
    expect(minified).toBe(`<p>x</p><scr<script>a()</script>ipt>b()</script>\n<script>c()</script>`);
    expect(minified).not.toContain("<script>b()</script>");
  });

  it("leaves nested unclosed-tag scripts as authored at every depth", () => {
    let html = "<script>a()</script>";
    for (let depth = 0; depth < 3; depth++) html = `<scr${html}ipt>b${depth}()</script>`;
    expect(extractScriptTags(html)).toBe("");
    expect(minifyHtml(html)).toBe(html);
  });

  it.each([
    ["inside an unclosed tag name", "<p>x</p><scr<!-- c -->ipt>b()</script>"],
    ["an empty comment inside an unclosed tag name", "<scr<!---->ipt>b()</script>"],
  ])("keeps comment-like text %s, which is part of a tag, so nothing joins into a script", (_case, html) => {
    // The browser reads `<!--` inside a tag as part of that tag, not a comment.
    expect(extractScriptTags(html)).toBe("");
    expect(expectSameParse(html)).toBe(html);
  });

  it("removes a real comment after a lone < without joining the < to the text after it", () => {
    // `<` followed by `<` is text, then a real comment. Deleting the comment
    // outright would turn `<` + `script>` into an executable `<script>`.
    const html = "<p>x</p><<!-- c -->script>b()</script>";
    expect(expectSameParse(html)).toBe("<p>x</p><<!---->script>b()</script>");
  });

  it.each([
    ["<!<!--x-->-- y -->", "<!<!--x-->-- y -->"],
    ["<!-<!--x-->- y -->", "<!-<!--x-->- y -->"],
    ["<<!--x-->!-- y -->", "<<!---->!-- y -->"],
  ])("never joins a new <!-- at a removal seam in %s", (html, expected) => {
    // The first two are one bogus comment ending at the first `>`. In the
    // third, `<!--x-->` is a real comment after a text `<`.
    expect(expectSameParse(html)).toBe(expected);
  });

  it("removes an unterminated comment, which hides the rest of the document either way", () => {
    expect(expectSameParse("<p>a</p><!-- open <p>hidden</p>")).toBe("<p>a</p>");
  });

  it("ends comments where the browser does, including at --!>", () => {
    // A regex that waits for `-->` would also delete the <b> between them.
    expect(expectSameParse("<p><!-- a --!><b>kept</b><!-- b --></p>")).toBe("<p><b>kept</b></p>");
    expect(expectSameParse("<p><!--><b>kept</b><!-- b --></p>")).toBe("<p><b>kept</b></p>");
  });

  it("keeps comment-like text that is element text, such as in <title> and <noscript>", () => {
    for (const html of ["<title>a <!-- b --> c</title>", "<noscript><!-- n --></noscript>", "<textarea><!-- t --></textarea>"]) {
      expect(expectSameParse(html)).toBe(html);
    }
  });

  it("keeps the text around a removed comment from forming a different character reference", () => {
    expect(expectSameParse("<p>&am<!-- c -->p;</p>")).toBe("<p>&am<!---->p;</p>");
  });

  it.each([
    ["an unclosed <script>", "<script>b()"],
    ["an unclosed <template>", "<template><p>t</p>"],
    ["an unclosed <textarea>", "<textarea>typed"],
    ["an unclosed <svg>", "<svg><g>"],
    ["an unclosed start tag", '<div class="x'],
    ["a trailing </", "</"],
    ["<plaintext>", "<plaintext>raw"],
    ["<frameset>", "<frameset>"],
  ])("keeps hoisted scripts running when the document ends inside %s", (_case, tail) => {
    // Appended after this markup, a script would be text, inert, or dropped.
    const html = `<p>a</p><script>a()</script>${tail}`;
    const minified = expectSameParse(html);
    expect(minified.indexOf("<script>a()</script>")).toBeLessThan(minified.lastIndexOf(tail));
  });

  it("hoists a whole script that contains an escaped <script>, not half of it", () => {
    // Inside `<!--`, a `<script>...</script>` pair does not end the outer script.
    const html = "<p>x</p><script><!--<script>a()</script>b()--></script><p>y</p>";
    expect(expectSameParse(html)).toBe("<p>x</p><p>y</p>\n<script><!--<script>a()</script>b()--></script>");
  });

  it("leaves scripts in <template>, SVG, and <noscript> where they are", () => {
    for (const html of [
      "<template><script>t()</script></template><p>x</p>",
      "<noscript><script>n()</script></noscript><p>x</p>",
      "<math><mi><script>m()</script></mi></math><p>x</p>",
    ]) {
      expect(expectSameParse(html)).toBe(html);
    }
  });

  it("keeps execution order around a script that must run in place", () => {
    // The SVG script and the import map stay put, so scripts before them stay
    // before them; only scripts after the last such script move.
    const html =
      "<script>a()</script><svg><script>s()</script></svg><script>b()</script>" +
      '<script type="importmap">{}</script><script type="module">m()</script><p>x</p>';
    expect(expectSameParse(html)).toBe(
      '<script>a()</script><svg><script>s()</script></svg><script>b()</script><script type="importmap">{}</script><p>x</p>\n' +
      '<script type="module">m()</script>',
    );
  });

  it("classifies script types the way browsers do", () => {
    // A `type` inside another attribute's value is not the type; `language`
    // and legacy JavaScript MIME types still run.
    const html =
      '<p>x</p><script data-note=\'type="text/plain"\'>a()</script><script language="javascript">b()</script>' +
      '<script type=" text/x-javascript ">c()</script><script type="text/plain">d()</script>';
    expect(expectSameParse(html)).toBe(
      '<p>x</p><script type="text/plain">d()</script>\n' +
      '<script data-note=\'type="text/plain"\'>a()</script>\n<script language="javascript">b()</script>\n' +
      '<script type=" text/x-javascript ">c()</script>',
    );
  });

  it("stays linear on many comment openers without a close", () => {
    const started = performance.now();
    minifyHtml(`<p>a</p>${"<!--".repeat(50_000)}`);
    minifyHtml(`<p>a</p>${"<!---->".repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("still removes comments in a closed context, including next to a kept one", () => {
    const html = "<p>a</p><!-- gone --><scr<!-- kept -->ipt>b()</script><!-- gone too --><p>c</p>";
    expect(minifyHtml(html)).toBe("<p>a</p><scr<!-- kept -->ipt>b()</script><p>c</p>");
  });

  it("hoists a script after a literal < in text, which the browser runs", () => {
    const html = "<p>1 < 2</p><p>x <script>run()</script></p><p>a < b <script>two()</script></p>";
    expect(extractScriptTags(html)).toBe("<script>run()</script>\n<script>two()</script>");
    expect(expectSameParse(html)).toBe("<p>1 < 2</p><p>x </p><p>a < b </p>\n<script>run()</script>\n<script>two()</script>");
  });

  it("still hoists a script after an attribute value containing < or >", () => {
    for (const title of ["a<b", "a>b"]) {
      expect(minifyHtml(`<div title="${title}"><script>x()</script></div>`)).toBe(
        `<div title="${title}"></div>\n<script>x()</script>`,
      );
    }
  });

  it("removes exactly the scripts it hoists, once each, in document order", () => {
    const html =
      "<p>a</p><script>one()</script><script data-bascik-server>s()</script>" +
      "<script>two()</script><script type=\"application/ld+json\">{}</script><script>three()</script>";
    expect(minifyHtml(html)).toBe(
      '<p>a</p><script data-bascik-server>s()</script><script type="application/ld+json">{}</script>\n' +
      "<script>one()</script>\n<script>two()</script>\n<script>three()</script>",
    );
  });

  it("stays fast on many scripts, including many inside unclosed tags", () => {
    const started = performance.now();
    expect(extractScriptTags("<p>x</p><script>a()</script>".repeat(20_000)).split("\n")).toHaveLength(20_000);
    expect(extractScriptTags("<p x <script>a()</script>".repeat(20_000))).toBe("");
    minifyHtml(("<" + "a".repeat(100) + "<script>a()</script>").repeat(10_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("never changes what the browser builds or which scripts can run, on random malformed markup", () => {
    // parse5 is the oracle: structure, text, and the set of scripts that can
    // run must match before and after. A joined script, a script hoisted into
    // inert markup, a split script, or a changed character reference all fail.
    const fragment = fc.constantFrom(
      "<script>a()</script>", "<script type=module>m()</script>", "<script data-bascik-server>s()</script>",
      '<script type="importmap">{}</script>', "<script>", "</script>", "<scr", "ipt>", "ipt>b()</script>",
      "<script><!--<script>", "-->", "<!--", "--!>", "<!-->", "<!-- c -->", "<!x>", "</", "<", ">", '"', "'",
      "=", "x", "&am", "p;", "<p>", "</p>", '<div title="', '">', "<b <", "</div>", "<pre>", "</pre>",
      "<template>", "</template>", "<textarea>", "</textarea>", "<title>", "</title>", "<noscript>",
      "</noscript>", "<style>", "</style>", "<plaintext>", "<svg>", "</svg>", "<foreignObject>", "<math>", "<mi>",
      "<![CDATA[", "]]>", "<table>", "<td>", "<select>",
    );
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 16 }), (parts) => {
        expectSameParse(parts.join(""));
      }),
      { numRuns: 4000 },
    );
  });
});

describe("minifyHtml", () => {
  it("normalizes each full safety-mask input at most once regardless of raw-text block count", () => {
    const html = "<main>" + Array.from({ length: 40 }, (_, i) =>
      `<PRE data-note="quoted > delimiter">  item ${i}\n<!-- literal -->\n<script>example()</script></PRE>`,
    ).join("\n") + "</main>";
    const original = String.prototype.toLowerCase;
    let fullInputNormalizations = 0;
    const spy = vi.spyOn(String.prototype, "toLowerCase").mockImplementation(function (this: string) {
      const value = String(this);
      if (value === html) fullInputNormalizations++;
      return original.call(value);
    });
    let result: string;
    try {
      result = minifyHtml(html);
    } finally {
      spy.mockRestore();
    }
    expect(result).toContain("<!-- literal -->\n<script>example()</script>");
    expect(fullInputNormalizations).toBeLessThanOrEqual(1);
  });

  it("preserves sensitive content with whitespace in closing tags", () => {
    const script =
      "<div><script>const value = 1;\n// keep newline\nwindow.done = true;</script ></div>";
    expect(minifyHtml(script)).toContain(
      "// keep newline\nwindow.done = true;",
    );
    expect(minifyHtml("<pre>  a\n  b\n</pre >")).toBe(
      "<pre>  a\n  b\n</pre >",
    );
  });

  it("ends a script at an end tag with trailing whitespace, attributes, or a slash", () => {
    for (const close of ["</script\t\n foo>", "</script/>", "</SCRIPT\n>"]) {
      const html = `<script>first()</script ><p>between</p><script>second()${close}<p>after</p>`;
      expect(extractScriptTags(html)).toBe(`<script>first()</script >\n<script>second()${close}`);
      expect(minifyHtml(html)).toBe(`<p>between</p><p>after</p>\n<script>first()</script >\n<script>second()${close}`);
    }
    expect(extractScriptTags("<script>a()</scripts><p>x</p>")).toBe("");
  });

  it("does not strip the document tail when a script contains an HTML comment opener", () => {
    const html = '<div><script>const sample = "<!--";</script><p>after</p><!-- real --></div>';
    expect(minifyHtml(html)).toContain("<p>after</p>");
  });

  it("keeps a script nested inside pre in its original position", () => {
    const html = "<pre><script>const sample = 1;</script></pre><p>after</p>";
    expect(minifyHtml(html)).toBe(html);
  });

  it("does not extract a script nested inside a pre after another script", () => {
    const html = '<script type="application/ld+json">{"description":"<!-- remains data"}</script><p>after</p><pre><script data-testid="nested-script">const sample = 1;</script></pre>';

    expect(minifyHtml(html)).toBe(html);
  });

  it("preserves comments inside pre elements", () => {
    const html = "<pre><!-- example --><code>sample</code></pre>";
    expect(minifyHtml(html)).toBe(html);
  });

  it("does not relocate data-bascik-routes scripts", () => {
    const html = "<div><script data-bascik-routes>routes()</script></div>";
    expect(minifyHtml(html)).toBe(html);
  });

  it("recognizes spaced type module attributes as JavaScript", () => {
    const html = '<div><script type = "module">export default 1;</script></div>';
    expect(extractScriptTags(html)).toBe('<script type = "module">export default 1;</script>');
  });

  it("removes comments from HTML", () => {
    const htmlString = "<!-- comment --><div>content</div>";
    expect(minifyHtml(htmlString)).toEqual("<div>content</div>");
  });

  it("leaves data-bascik-server scripts untouched in their original location", () => {
    const html = `<div><script data-bascik-server>server()</script></div><script>client()</script>`;
    expect(minifyHtml(html)).toBe(`<div><script data-bascik-server>server()</script></div>\n<script>client()</script>`);
  });

  it("preserves newlines, indentation, and single-line comments inside data-bascik-server scripts", () => {
    const htmlString = [
      "<div>",
      "  <script data-bascik-server>",
      "    // Single line comment",
      "    const x = 1;",
      "    console.log(x);",
      "  </script>",
      "</div>",
    ].join("\n");
    const result = minifyHtml(htmlString);
    expect(result).toBe(
      "<div><script data-bascik-server>\n    // Single line comment\n    const x = 1;\n    console.log(x);\n  </script></div>",
    );
  });

  it("preserves multiline data scripts such as application/ld+json verbatim in place", () => {
    const htmlString = [
      "<div>",
      '  <script type="application/ld+json">',
      "    {",
      '      "@context": "https://schema.org",',
      '      "@type": "Article"',
      "    }",
      "  </script>",
      "</div>",
    ].join("\n");
    const result = minifyHtml(htmlString);
    expect(result).toBe(
      '<div><script type="application/ld+json">\n    {\n      "@context": "https://schema.org",\n      "@type": "Article"\n    }\n  </script></div>',
    );
  });

  it("removes newlines and spaces from HTML, and removes extra spaces", () => {
    const htmlString = "<div>\n    \tcontent\n   \t</div>";
    expect(minifyHtml(htmlString)).toEqual("<div> content </div>");
  });

  it("preserves content of <pre> elements verbatim", () => {
    const htmlString =
      "<div>\n  <pre><code>\n    line1\n    line2\n  </code></pre>\n</div>";
    const result = minifyHtml(htmlString);
    expect(result).toBe(
      "<div><pre><code>\n    line1\n    line2\n  </code></pre></div>",
    );
  });

  it("preserves content of <pre> elements with attributes", () => {
    const htmlString = '<div><pre class="code-block">  indented\ncode\n</pre></div>';
    const result = minifyHtml(htmlString);
    expect(result).toBe('<div><pre class="code-block">  indented\ncode\n</pre></div>');
  });

  it("preserves content in every sibling pre element", () => {
    const htmlString = "<div><pre>first\nblock</pre><pre>second\nblock</pre></div>";

    expect(minifyHtml(htmlString)).toBe(htmlString);
  });

  it("preserves content of <pre> and <textarea> elements with multiline or newline attributes", () => {
    const htmlString =
      '<div><pre\n  class="code-block"\n  id="block1">\n    line1\n    line2\n</pre></div>';
    const result = minifyHtml(htmlString);
    expect(result).toBe(
      '<div><pre\n  class="code-block"\n  id="block1">\n    line1\n    line2\n</pre></div>',
    );
  });

  it("removes comments, whitespace and newlines and puts script tags at the end of the HTML", () => {
    const htmlString = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Example</title>
        </head>
        <body>
          <h1>Hello, world!</h1>
          <p>This is an example page.</p>
          <!-- This is a comment -->
          <script>
            console.log("Hello, world!");
          </script>
          <script src="script.js"></script>
        </body>
      </html>
    `;
    const expected =
      '<!DOCTYPE html><html><head><title>Example</title></head><body><h1>Hello, world!</h1><p>This is an example page.</p></body></html>\n<script>\n            console.log("Hello, world!");\n          </script>\n<script src="script.js"></script>';

    const result = minifyHtml(htmlString);
    expect(result).toBe(expected);
  });

  it("preserves whitespace between inline tags", () => {
    const htmlString =
      "<p><strong>More on the next page.</strong> <a href=\"/scoped-styles\">Scoped Styles</a></p>";
    expect(minifyHtml(htmlString)).toBe(
      "<p><strong>More on the next page.</strong> <a href=\"/scoped-styles\">Scoped Styles</a></p>",
    );
  });

  it("preserves newlines as single space between inline tags", () => {
    const htmlString =
      "<p><strong>More on the next page.</strong>\n<a href=\"/scoped-styles\">Scoped Styles</a></p>";
    expect(minifyHtml(htmlString)).toBe(
      "<p><strong>More on the next page.</strong> <a href=\"/scoped-styles\">Scoped Styles</a></p>",
    );
  });

  it("preserves special regex tokens ($1, $&, $', $`, $$) inside <pre> and <textarea> blocks verbatim", () => {
    const htmlString = "<div><pre><code>const query = '$1' && '$&' || '$`';</code></pre></div>";
    expect(minifyHtml(htmlString)).toBe("<div><pre><code>const query = '$1' && '$&' || '$`';</code></pre></div>");
  });

  it("handles tags with long attributes and custom tag names efficiently", () => {
    const htmlString = '<div data-very-long-attribute="abcdefghijklmnopqrstuvwxyz1234567890"><span>First</span> <span>Second</span></div>';
    expect(minifyHtml(htmlString)).toBe('<div data-very-long-attribute="abcdefghijklmnopqrstuvwxyz1234567890"><span>First</span> <span>Second</span></div>');
  });

  it("collapses whitespace between non-inline block elements", () => {
    const htmlString = '<div>   <h1>Title</h1>   <p>Paragraph</p>   </div>';
    expect(minifyHtml(htmlString)).toBe('<div><h1>Title</h1><p>Paragraph</p></div>');
  });

  it("handles an empty input string", () => {
    expect(minifyHtml("")).toEqual("");
  });

  // ── Style raw-text preservation (prompt 106) ─────────────────────────

  it("preserves CSS CDO/CDC comment delimiters inside a style element (minify.html on)", () => {
    const html = "<style><!-- .x { color: red; } --></style><p>ok</p>";
    expect(minifyHtml(html)).toBe(
      "<style><!-- .x { color: red; } --></style><p>ok</p>",
    );
  });

  it("preserves a style string containing HTML-comment-looking text", () => {
    const html = '<style>.a::after { content: "<!-- -->"; }</style><p>ok</p>';
    // The CSS containing literal comment-like text must not be stripped.
    expect(minifyHtml(html)).toContain('.a::after { content: "<!-- -->"; }');
  });

  it("preserves a style string after an earlier style block", () => {
    const html = '<style><!-- .first { color: red; } --></style><p>first</p><style>.second::after { content: "<!-- not a comment -->"; }</style><p>second</p>';

    expect(minifyHtml(html)).toContain('content: "<!-- not a comment -->"');
  });

  it("preserves style raw text across multiple style blocks and script blocks", () => {
    const html =
      "<style><!-- .a { color: red; } --></style>" +
      "<script>const keep = 1;</script>" +
      "<style>/* plain */ .b { display: none; }</style>";
    const result = minifyHtml(html);
    expect(result).toContain("<style><!-- .a { color: red; } --></style>");
    expect(result).toContain("<style>/* plain */ .b { display: none; }</style>");
    expect(result).toContain("const keep = 1;");
  });

  it("handles mixed-case STYLE tags", () => {
    const html = "<STYLE><!-- .x { color: red; } --></STYLE><p>ok</p>";
    expect(minifyHtml(html)).toBe(
      "<STYLE><!-- .x { color: red; } --></STYLE><p>ok</p>",
    );
  });

  it("still removes ordinary outer HTML comments around styles", () => {
    const html = "<!-- outer --><style><!-- .x { } --></style><p>ok</p>";
    const result = minifyHtml(html);
    expect(result).not.toContain("<!-- outer -->");
    expect(result).toContain("<style><!-- .x { } --></style>");
  });

  it("preserves style raw text containing replacement tokens", () => {
    const html = '<style>.q::after { content: "$1 $&"; }</style><p>ok</p>';
    expect(minifyHtml(html)).toContain('content: "$1 $&"');
  });

  it("preserves Unicode inside style raw text", () => {
    const html = "<style>.x::after { content: 'é ま'; }</style><p>ok</p>";
    expect(minifyHtml(html)).toContain("content: 'é ま'");
  });

  it("is idempotent with respect to style raw text", () => {
    const html = "<style><!-- .x { color: red; } --></style><p>ok</p>";
    const once = minifyHtml(html);
    const twice = minifyHtml(once);
    expect(twice).toBe(once);
    expect(twice).toContain("<!-- .x { color: red; } -->");
  });

  it("leaves an unclosed style tag untouched without crashing", () => {
    // Malformed boundary: no closing </style>. The minifier must not crash and
    // must not treat the content as an ordinary comment to strip.
    const html = "<style><!-- .x { color: red; }";
    expect(() => minifyHtml(html)).not.toThrow();
  });

  it("does not corrupt a script tag when an HTML comment before it mentions <script>", () => {
    // Regression: a `<script>` reference inside <!-- --> was matched as a real
    // script opener, causing SCRIPT_TAG_PATTERN to consume everything up to the
    // real </script> as the "body", corrupting the output with a SyntaxError.
    const input =
      "<!-- The inline <script> below runs before first paint -->\n" +
      "<script>!function(){document.body.className='ready'}()</script>";
    const result = minifyHtml(input);
    expect(result).toContain("!function(){document.body.className='ready'}()");
    expect(result).not.toContain("The inline");
  });

  it("does not corrupt a script when a multi-line comment mentions <script> and <style>", () => {
    // Mirrors the exact docs-head.html pattern that triggered the production bug.
    const input = [
      "<!--",
      "  - This component carries no props or slots.",
      "  - The inline <script> below is a runtime script, not a data-bascik-build or",
      "    data-bascik-server script. It runs on the client before first paint to",
      "    apply the saved theme.",
      "  - Because it lives in <head>, keep it dependency-free and synchronous.",
      "-->",
      "<!-- Apply saved theme before first paint to prevent flash -->",
      "<script>!function(){var t=sessionStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t)}()</script>",
    ].join("\n");
    const result = minifyHtml(input);
    expect(result).toContain("sessionStorage.getItem('theme')");
    expect(result).not.toContain("This component carries");
    expect(result).not.toContain("Apply saved theme");
  });

  it("preserves arbitrary CSS raw text inside style elements while still removing outer HTML comments", () => {
    const cssArb = fc.array(
      fc.constantFrom(
        "a",
        " ",
        "\n",
        ".",
        "#",
        "{",
        "}",
        ":",
        ";",
        '"',
        "'",
        "\\",
        "<",
        ">",
        "!",
        "url(",
        "é",
        "ま",
        "$1",
        "$&",
      ),
      { minLength: 1, maxLength: 30 },
    );

    fc.assert(
      fc.property(cssArb, (tokens) => {
        const css = tokens.join("");
        const html = `<!-- outer --><style>${css}</style><p>ok</p>`;
        const result = minifyHtml(html);
        // No crash.
        expect(typeof result).toBe("string");
        // The outer HTML comment is still removed.
        expect(result).not.toContain("<!-- outer -->");
        // The style element survives with its raw text intact (whitespace too,
        // because the whole element is shielded like <pre>/<textarea>).
        expect(result).toContain(`<style>`);
        expect(result).toContain("</style>");
      }),
      { numRuns: 300 },
    );
  });
});

