import { describe, expect, it, vi } from "vitest";
import { parse } from "parse5";
import { minifyScriptTagsInHtml } from "./page-minification.ts";
import { minifyJs } from "./js-minifier.ts";

/** The tag names of `<body>`'s children, and each `<script>`'s text, as a browser parses it. */
const bodyAsParsed = (html: string): string[] => {
  type Node = {
    nodeName: string;
    childNodes?: Node[];
    value?: string;
  };
  const document = parse(html) as unknown as Node;
  const htmlElement = document.childNodes?.find((n) => n.nodeName === "html");
  const body = htmlElement?.childNodes?.find((n) => n.nodeName === "body");
  return (body?.childNodes ?? []).map((n) =>
    n.nodeName === "script"
      ? `script:${(n.childNodes ?? []).map((t) => t.value ?? "").join("").length > 0}`
      : n.nodeName,
  );
};

describe("inline script minification keeps where the browser ends the script", () => {
  // Inside `<!--`, the HTML parser tracks `<script` and `-->` in the script text to find the
  // real `</script>`. A comment holding one of them must not be removed.
  it.each([
    [
      "a //--> line closing a <!-- wrapper",
      '<script><!--\ndocument.write("<script>x<\\/script>")\n//--></script><p>after</p>',
    ],
    [
      "a --> line closing a <!-- wrapper",
      '<script><!--\ndocument.write("<script>x<\\/script>")\n--></script><p>after</p>',
    ],
    [
      "a block comment holding -->",
      '<script><!--\nvar s = "<script>"\n/* --> */\n</script><p>after</p>',
    ],
    [
      "a line comment holding <script",
      '<script>var s = "<!--"\n// <script>\nvar t = "-->"\n</script><p>after</p>',
    ],
    [
      "a line comment holding <script, with no --> after it",
      '<script>var s = "<!--"\n// <script>\n</script><p>after</p>',
    ],
  ])("%s", async (_name, body) => {
    const html = `<!doctype html><html><body>${body}</body></html>`;
    const minified = await minifyScriptTagsInHtml(html, minifyJs);
    expect(bodyAsParsed(minified), minified).toEqual(bodyAsParsed(html));
  });

  it("still drops comments in a script that never writes <!--", async () => {
    const html = "<script>a()\n// --> <script> note\nb()</script>";
    expect(await minifyScriptTagsInHtml(html, minifyJs)).toBe(
      "<script>a();b()</script>",
    );
  });
});

describe("inline script minification uses original source spans", () => {
  it.each(
    [
      "<!--keep-->",
      "<textarea>keep</textarea>",
      "<title>keep</title>",
      "<noscript>keep</noscript>",
      "<xmp>keep</xmp>",
      "<!-- an unclosed comment",
    ].flatMap((literal) =>
      ["script", "SCRIPT", "ScRiPt"].map((tag) => ({ literal, tag })),
    ),
  )(
    "preserves literal markup inside <$tag> JavaScript strings: $literal",
    async ({ literal, tag }) => {
      const source = `const marker = ${JSON.stringify(literal)}; return marker;`;
      const html = `<${tag}>${source}</${tag}>`;
      const minifier = vi.fn(minifyJs);
      const output = await minifyScriptTagsInHtml(html, minifier);
      expect(minifier).toHaveBeenCalledExactlyOnceWith(source);
      const open = `<${tag}>`;
      const close = `</${tag}>`;
      expect(output.startsWith(open)).toBe(true);
      expect(output.endsWith(close)).toBe(true);
      const script = output.slice(open.length, -close.length);
      expect(new Function(script)()).toBe(literal);
    },
  );

  it.each(["</SCRIPT >", "</script/>", '</script data-note="</fake>">'])(
    "preserves the original script end-tag span: %s",
    async (close) => {
      const source = 'return "<!--keep-->";';
      const minifier = vi.fn((code: string) => code);
      const html = `<script>${source}${close}`;
      expect(await minifyScriptTagsInHtml(html, minifier)).toBe(html);
      expect(minifier).toHaveBeenCalledExactlyOnceWith(source);
    },
  );

  it("does not minify script-looking content inside a comment or raw-text wrapper", async () => {
    const minifier = vi.fn((code: string) => code.trim());
    const html =
      "<!-- <script>comment()</script> --><textarea><script>text()</script></textarea><script> real() </script>";
    expect(await minifyScriptTagsInHtml(html, minifier)).toBe(
      "<!-- <script>comment()</script> --><textarea><script>text()</script></textarea><script>real()</script>",
    );
    expect(minifier).toHaveBeenCalledExactlyOnceWith(" real() ");
  });
});
