import { describe, expect, it } from "vitest";
import { expandComponents } from "./component-expansion-core.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { injectPropAttributes, injectProps } from "./component-props.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

// A CDATA section in SVG or MathML content is text: a component tag written
// in it (`<![CDATA[see <b>this</b>: <book-card></book-card>]]>`) is characters the page shows,
// not a usage, so it must never be expanded.
const list = (): ComponentList => ({
  "book-card": {
    fileName: "src/components/book-card.html",
    fileContent: `<article>BOOK</article>`,
  },
  "book-art": {
    fileName: "src/components/book-art.html",
    fileContent: `<svg\n  viewBox="0 0 10 10"\n><text><![CDATA[see <b>this</b>: <book-card></book-card>]]></text></svg>`,
  },
  "book-label": {
    fileName: "src/components/book-label.html",
    fileContent: `<text><![CDATA[see <b>this</b>: <book-card></book-card>]]></text>`,
  },
});

const expand = (page: string): string =>
  expandComponents(page, list(), {
    scope: (component: BascikComponent) => component,
    mintId: (name, ordinal) => `${name}-${ordinal}`,
    injectAttrProps: "before-scope",
    numberSourceUrls: false,
    inheritAttributes: true,
    instanceState: { ordinalMap: new Map(), issuedIds: new Set() },
    limits: { maxSubstitutions: 100, maxOutputBytes: 100_000 },
    onError: () => {},
    warn: () => {},
  }).transpiledHtmlBody;

describe("component tags inside SVG and MathML CDATA sections", () => {
  it("are not expanded when the page writes them", () => {
    const cdata = `<![CDATA[see <b>this</b>: <book-card></book-card>]]>`;
    const out = expand(
      `<svg><text>${cdata}</text></svg><math><mi>x</mi><mtext>y</mtext><ms>${cdata}</ms></math><book-card></book-card>`,
    );
    expect(out).toContain(`<svg><text>${cdata}</text></svg>`);
    // <ms> is a MathML text integration point: there `<![CDATA[` is a bogus
    // comment that ends at the first `>`, so the end tag after it is markup.
    expect(out).toMatch(/<article>BOOK<\/article>$/);
  });

  it("are not expanded when a component's template writes them, at any depth", () => {
    const out = expand(`<p>a</p><book-art></book-art><book-card></book-card>`);
    expect(out).toContain(
      `<![CDATA[see <b>this</b>: <book-card></book-card>]]>`,
    );
    expect(out.match(/<article>BOOK<\/article>/g)).toHaveLength(1);
  });

  it("are not expanded when the SVG around the CDATA comes from the page", () => {
    const out = expand(`<svg><book-label></book-label></svg>`);
    expect(out).toBe(
      `<svg><text><![CDATA[see <b>this</b>: <book-card></book-card>]]></text></svg>`,
    );
  });

  it("are still expanded after `<![CDATA[` in HTML content, a bogus comment that ends at the first >", () => {
    expect(expand(`<div><![CDATA[x]]><book-card></book-card></div>`)).toBe(
      `<div><![CDATA[x]]><article>BOOK</article></div>`,
    );
  });

  it("are masked, and so are a comment opener and a script inside one", () => {
    const html = `<svg><text><![CDATA[<!-- <script> ]]></text></svg><book-card></book-card><!-- c -->`;
    const masked = maskRawTextContent(html);
    expect(masked.length).toBe(html.length);
    expect(masked).toContain("<book-card></book-card>");
    expect(masked).not.toContain("<script>");
  });

  it("are not acted on as attribute bindings", () => {
    const template = `<svg><text><![CDATA[<a data-bascik-attr-href="link">x</a>]]></text></svg><a data-bascik-attr-href="link">l</a>`;
    expect(
      injectPropAttributes(template, { link: "/dune" }, undefined, () => {}),
    ).toBe(
      `<svg><text><![CDATA[<a data-bascik-attr-href="link">x</a>]]></text></svg><a href="/dune">l</a>`,
    );
  });

  it("are not filled as prop receivers", () => {
    const template = `<svg><text><![CDATA[<b data-bascik-prop-title>x</b>]]></text></svg><h2 data-bascik-prop-title>f</h2>`;
    expect(injectProps(template, { title: "Dune" })).toBe(
      `<svg><text><![CDATA[<b data-bascik-prop-title>x</b>]]></text></svg><h2>Dune</h2>`,
    );
  });
});
