import { describe, expect, it, vi } from "vitest";

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
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { runScopingPipeline } from "./scoping-template.ts";
import { addElementClassesInHtml } from "./styles.ts";
import {
  collectDeclaredIds,
  rewriteIdReferencesInHtml,
} from "./id-references.ts";
import { scanHtmlCommentsAndCdata } from "./html-scanner.ts";
import type { BascikComponent } from "./types.ts";

// A CDATA section in SVG or MathML content is text: the browser builds no
// element from the markup-looking text inside it, so scoping must leave every
// byte of it alone.
const CDATA = `<![CDATA[<p class="note" id="lead">in cdata</p> <a href="#lead">x</a>]]>`;
const svgWithCdata = `<svg viewBox="0 0 10 10"><text>${CDATA}</text></svg>`;

describe("CDATA in SVG and MathML content", () => {
  it("gets no element classes", () => {
    const html = `<figure>${svgWithCdata}<p>real</p></figure>`;
    const out = addElementClassesInHtml(html, "my-art", ["p"]);
    expect(out).toContain(`<text>${CDATA}</text>`);
    expect(out).toMatch(/<p class="[^"]+">real<\/p>/);
  });

  it("gets no class, id, or id reference rewrites", () => {
    const component: BascikComponent = {
      name: "my-art",
      fileName: "/project/src/components/my-art.html",
      fileContent: `<figure>${svgWithCdata}<p class="note" id="lead">real</p><a href="#lead">l</a></figure>`,
      cssFileContent: ".note { color: blue } #lead { color: green }",
    };
    const out = runScopingPipeline({ ...component }, "1a2b3c4d").fileContent;
    expect(out).toContain(`<text>${CDATA}</text>`);
    // The live markup is still scoped.
    expect(out).not.toContain(`<p class="note" id="lead">real`);
    expect(out).not.toContain(`<a href="#lead">l</a>`);
  });

  it("declares no id and rewrites no reference inside a MathML CDATA section", () => {
    const html = `<math><![CDATA[<b id="ghost"></b><label for="ghost">]]></math><label for="ghost">x</label>`;
    expect(collectDeclaredIds(html)).toEqual(new Set());
    const out = rewriteIdReferencesInHtml(html, (id) => `s-${id}`);
    expect(out).toContain(`<![CDATA[<b id="ghost"></b><label for="ghost">]]>`);
  });

  it("still rewrites markup after `<![CDATA[` in HTML content, a bogus comment that ends at the first >", () => {
    // Outside SVG and MathML, `<![CDATA[x>` is a comment ending at its first
    // `>`; the `<p>` after it is a real element.
    const html = `<div><![CDATA[x]]><p>real</p></div>`;
    expect(scanHtmlCommentsAndCdata(html)).toEqual([]);
    expect(addElementClassesInHtml(html, "my-art", ["p"])).toMatch(
      /<p class="[^"]+">real<\/p>/,
    );
  });

  it("keeps reading after `<![CDATA[` directly in an SVG <title>, where browsers start a bogus comment", () => {
    // Blink, Gecko and parse5 allow no CDATA section directly inside an
    // integration point (<title>, <desc>, <foreignObject>, MathML <mi>), so
    // the scan must not stop there and leave later CDATA sections unshielded.
    const later = `<![CDATA[<p class="note">]]>`;
    const html = `<svg><title><![CDATA[a]]></title></svg><svg><text>${later}</text></svg>`;
    expect(
      scanHtmlCommentsAndCdata(html).map(({ start, end }) =>
        html.slice(start, end),
      ),
    ).toEqual(["<![CDATA[a]]>", later]);
    expect(addElementClassesInHtml(html, "my-art", ["p"])).toContain(later);
  });

  it("hides a CDATA section the component ends inside, as the browser reads it as text to the end", () => {
    const html = `<p>real</p><svg><text><![CDATA[<p class="note">`;
    const out = addElementClassesInHtml(html, "my-art", ["p"]);
    expect(out).toMatch(/^<p class="[^"]+">real<\/p>/);
    expect(out.endsWith(`<![CDATA[<p class="note">`)).toBe(true);
  });

  it("leaves CDATA inside an SVG <style> or <script> visible as code", () => {
    const html = `<svg><style><![CDATA[ .a{} ]]></style><text><![CDATA[t]]></text></svg>`;
    const ranges = scanHtmlCommentsAndCdata(html);
    expect(ranges.map(({ start, end }) => html.slice(start, end))).toEqual([
      "<![CDATA[t]]>",
    ]);
  });
});
