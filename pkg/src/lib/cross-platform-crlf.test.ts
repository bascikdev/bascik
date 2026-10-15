import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { win32 } from "node:path";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: { pages: "src/pages", components: ["src/components"], out: "dist" },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { stampScriptLines, numberInstanceSourceUrls } from "./script-source-lines.ts";
import { stampDirectiveSources, directiveSourcePosition, trimmedStartPosition } from "./directive-source.ts";
import { runScopingPipeline } from "./scoping-template.ts";
import { getHttpPath } from "./paths.ts";
import { minifyHtml } from "./html-minifier.ts";
import { minifyCss } from "./css-minifier.ts";
import { minifyJs } from "./js-minifier.ts";
import type { BascikComponent } from "./types.ts";

const toCrlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");
const normalizeLf = (text: string): string => text.replace(/\r\n/g, "\n");

describe("Cross-platform CRLF (\\r\\n) and Windows path parity", () => {
  it("preserves identical DevTools script line stamps and directive positions under CRLF (\\r\\n) vs LF (\\n)", () => {
    const lfHtml = [
      "<!-- component header -->",
      "<style>",
      "  .card { color: red; }",
      "</style>",
      '<div id="panel" class="card">',
      '  <label for="email">Email</label>',
      '  <input id="email" name="email">',
      "</div>",
      "<script data-bascik-build>",
      "  export default () => '<p>built</p>';",
      "</script>",
      "<script>",
      '  const el = document.getElementById("panel");',
      '  el.classList.add("card");',
      "</script>",
    ].join("\n");

    const crlfHtml = toCrlf(lfHtml);

    const stampedLf = stampScriptLines(stampDirectiveSources(lfHtml, "src/components/my-card.html"));
    const stampedCrlf = stampScriptLines(stampDirectiveSources(crlfHtml, "src\\components\\my-card.html"));

    const lfLineMatch = stampedLf.match(/data-bascik-script-line="(\d+)"/);
    const crlfLineMatch = stampedCrlf.match(/data-bascik-script-line="(\d+)"/);
    expect(lfLineMatch?.[1]).toBe("12");
    expect(crlfLineMatch?.[1]).toBe("12");

    const lfOpen = stampedLf.match(/<script data-bascik-build[^>]*>/)?.[0] ?? "";
    const crlfOpen = stampedCrlf.match(/<script data-bascik-build[^>]*>/)?.[0] ?? "";
    const lfPos = directiveSourcePosition(stampedLf, stampedLf.indexOf(lfOpen), lfOpen);
    const crlfPos = directiveSourcePosition(stampedCrlf, stampedCrlf.indexOf(crlfOpen), crlfOpen);

    expect(crlfPos.tagLine).toBe(lfPos.tagLine);
    expect(crlfPos.tagColumn).toBe(lfPos.tagColumn);
    expect(crlfPos.bodyLine).toBe(lfPos.bodyLine);
    expect(crlfPos.bodyColumn).toBe(lfPos.bodyColumn);

    const lfTrimmed = trimmedStartPosition("\n  export default () => 1;", 9, 26);
    const crlfTrimmed = trimmedStartPosition("\r\n  export default () => 1;", 9, 26);
    expect(crlfTrimmed).toEqual(lfTrimmed);
  });

  it("produces equivalent scoped HTML, CSS, JS, and sourceURL numbering for CRLF and LF component inputs", () => {
    const htmlArb = fc.tuple(
      fc.constantFrom("div", "section", "article"),
      fc.constantFrom("card", "box", "panel"),
      fc.constantFrom("btn", "input-id", "hero"),
    ).map(
      ([tag, cls, id]) =>
        `<${tag} id="${id}" class="${cls}">\n` +
        `  <label for="${id}">Label</label>\n` +
        `  <p>Text</p>\n` +
        `</${tag}>\n` +
        `<script>\n` +
        `  const el = document.getElementById("${id}");\n` +
        `  el.classList.toggle("${cls}");\n` +
        `</script>\n`,
    );

    const cssArb = fc.tuple(
      fc.constantFrom("div", "section", "article", "p"),
      fc.constantFrom("card", "box", "panel"),
      fc.constantFrom("btn", "input-id", "hero"),
    ).map(
      ([tag, cls, id]) =>
        `#${id} > p {\n  margin: 0;\n}\n.${cls} ${tag} {\n  color: red;\n}\n@keyframes fade {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}\n`,
    );

    fc.assert(
      fc.property(htmlArb, cssArb, (lfHtml, lfCss) => {
        const crlfHtml = toCrlf(lfHtml);
        const crlfCss = toCrlf(lfCss);

        const lfComp: BascikComponent = {
          name: "my-card",
          fileName: "src/components/my-card/my-card.html",
          fileContent: stampScriptLines(lfHtml),
          cssFileContent: lfCss,
        };
        const crlfComp: BascikComponent = {
          name: "my-card",
          fileName: "src\\components\\my-card\\my-card.html",
          fileContent: stampScriptLines(crlfHtml),
          cssFileContent: crlfCss,
        };

        const scopedLf = runScopingPipeline(lfComp, "a1b2c3d4");
        const scopedCrlf = runScopingPipeline(crlfComp, "a1b2c3d4");

        expect(normalizeLf(scopedCrlf.fileContent)).toBe(normalizeLf(scopedLf.fileContent));
        expect(normalizeLf(scopedCrlf.cssFileContent ?? "")).toBe(normalizeLf(scopedLf.cssFileContent ?? ""));

        const numberedLf = numberInstanceSourceUrls(scopedLf.fileContent, 2);
        const numberedCrlf = numberInstanceSourceUrls(scopedCrlf.fileContent, 2);
        expect(normalizeLf(numberedCrlf)).toBe(normalizeLf(numberedLf));
      }),
      { numRuns: 100 },
    );
  });

  it("minifies CRLF and LF HTML, CSS, and JS to equivalent output", async () => {
    const lfHtml = "<div>\n  <p>Hello   <span>world</span></p>\n</div>";
    const crlfHtml = toCrlf(lfHtml);
    expect(minifyHtml(crlfHtml)).toBe(minifyHtml(lfHtml));

    const lfCss = ".card {\n  color: red;\n  margin: 0 auto;\n}\n";
    const crlfCss = toCrlf(lfCss);
    expect(minifyCss(crlfCss)).toBe(minifyCss(lfCss));

    const lfJs = "const a = 1;\n// comment\nconst b = a + 2;\nconsole.log(b);\n";
    const crlfJs = toCrlf(lfJs);
    expect(await minifyJs(crlfJs)).toBe(await minifyJs(lfJs));
  });

  it("normalizes Windows backslash paths and drive-letter paths in getHttpPath", () => {
    expect(getHttpPath("src\\pages\\index.html", "src\\pages")).toBe("/");
    expect(getHttpPath("src\\pages\\blog\\index.html", "src\\pages")).toBe("/blog/");
    expect(getHttpPath("src\\pages\\blog\\post.html", "src/pages")).toBe("/blog/post");
    expect(getHttpPath("C:\\repo\\site\\src\\pages\\docs\\guide.html", "src/pages")).toBe("/docs/guide");
    expect(getHttpPath("D:\\workspace\\app\\src\\pages\\index.html", "D:\\workspace\\app\\src\\pages")).toBe("/");

    // Verify path.win32 joined/resolved paths normalize cleanly to POSIX URLs
    const winRoot = "C:\\Users\\dev\\project";
    const winPagesDir = win32.join(winRoot, "src", "pages");
    const winNestedPage = win32.resolve(winPagesDir, "guides", "getting-started", "index.html");
    expect(getHttpPath(winNestedPage, winPagesDir)).toBe("/guides/getting-started/");
  });
});
