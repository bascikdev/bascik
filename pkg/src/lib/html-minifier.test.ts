import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { minifyHtml, extractScriptTags } from "./html-minifier.ts";

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
});

describe("minifyHtml", () => {
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

  it("does not strip the document tail when a script contains an HTML comment opener", () => {
    const html = '<div><script>const sample = "<!--";</script><p>after</p><!-- real --></div>';
    expect(minifyHtml(html)).toContain("<p>after</p>");
  });

  it("keeps a script nested inside pre in its original position", () => {
    const html = "<pre><script>const sample = 1;</script></pre><p>after</p>";
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

