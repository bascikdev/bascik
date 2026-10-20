import { describe, expect, it, vi } from "vitest";
import { minifyScriptTagsInHtml } from "./page-minification.ts";
import { minifyJs } from "./js-minifier.ts";

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
