import { describe, it, expect } from "vitest";
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
});

