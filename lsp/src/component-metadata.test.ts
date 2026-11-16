import { describe, expect, it } from "vitest";
import { analyzeComponentSource } from "./component-metadata.js";

describe("analyzeComponentSource", () => {
  it("ignores prop-like text in raw text bodies, whatever their end tag spelling", () => {
    for (const endTag of [
      "</script>",
      "</script foo>",
      "</script/>",
      "</SCRIPT\n>",
    ]) {
      const metadata = analyzeComponentSource(
        `<script>const s = "data-bascik-prop-fake";${endTag}<p data-bascik-prop-real></p>`,
      );
      expect(
        metadata.props.map((prop) => prop.name),
        endTag,
      ).toEqual(["real"]);
    }
  });

  it("declares only the named slots the build fills, as its slot parser reads them", () => {
    const componentNames = new Set(["inner-box"]);
    const slotsOf = (source: string) =>
      analyzeComponentSource(source, { componentNames }).slots.map(
        (slot) => slot.name,
      );
    // Inside a nested component's slot wrapper: the nested component's.
    expect(
      slotsOf(
        '<div><inner-box><span data-bascik-slot="tail"><i data-bascik-slot="extra">fb</i></span></inner-box><p data-bascik-slot="own"></p></div>',
      ),
    ).toEqual(["own"]);
    // Directly inside a nested component's usage: also the nested one's.
    expect(
      slotsOf(
        '<inner-box><span data-bascik-slot="tail"></span></inner-box><b data-bascik-slot="mine"></b>',
      ),
    ).toEqual(["mine"]);
    // Inside another placeholder's fallback: never filled.
    expect(
      slotsOf(
        '<div data-bascik-slot="a"><b data-bascik-slot="b">fb</b></div><img data-bascik-slot="c" /><i data-bascik-slot="d"></i>',
      ),
    ).toEqual(["a", "d"]);
    // A default slot marker in a nested usage is forwarded, so it still counts.
    expect(
      analyzeComponentSource(
        "<inner-box><div data-bascik-slot>fb</div></inner-box>",
        { componentNames },
      ).defaultSlot,
    ).toEqual({ name: "default" });
  });

  it.each([
    ["style", '<style>.a::before { content: "<!--"; }</style>'],
    ["script", '<script>const open = "<!--";</script>'],
    [
      "JSON data block",
      '<script type="application/json">{"a":"<!--"}</script>',
    ],
    ["textarea", "<textarea><!--</textarea>"],
  ])(
    "reads `<!--` inside a %s as its text: the props and slots after it are declared",
    (_where, element) => {
      const metadata = analyzeComponentSource(
        `${element}<h2 data-bascik-prop-title></h2><div data-bascik-slot="aside"></div><!-- note -->`,
      );
      expect(metadata.props.map((prop) => prop.name)).toEqual(["title"]);
      expect(metadata.slots.map((slot) => slot.name)).toEqual(["aside"]);
    },
  );

  it("does not read a marker inside a comment that holds a <script> tag", () => {
    const metadata = analyzeComponentSource(
      "<!-- <script> data-bascik-prop-ghost --><p data-bascik-prop-real></p><script>x()</script>",
    );
    expect(metadata.props.map((prop) => prop.name)).toEqual(["real"]);
  });

  it("does not count custom elements named like style or script as styles or scripts", () => {
    const metadata = analyzeComponentSource(
      "<style-guide></style-guide><script-loader></script-loader>",
    );
    expect(metadata.hasStyles).toBe(false);
    expect(metadata.hasScripts).toBe(false);
    expect(analyzeComponentSource("<style>.a{}</style>").hasStyles).toBe(true);
    expect(analyzeComponentSource("<script\n>x()</script>").hasScripts).toBe(
      true,
    );
  });

  it("infers every prop form in source order and deduplicates names", () => {
    const metadata = analyzeComponentSource(`
      <p data-bascik-prop-label></p>
      <a data-bascik-attr-href="link" data-bascik-prop-label></a>
      <div data-bascik-attr-title='content' data-bascik-prop-link></div>
      <img data-bascik-attr-src = unquotedSrc />
    `);

    expect(metadata.props).toEqual([
      { name: "label" },
      { name: "link" },
      { name: "content" },
      { name: "unquotedSrc" },
    ]);
  });

  it("does not infer props from data-bascik-text or data-bascik-html, which the compiler does not read", () => {
    const metadata = analyzeComponentSource(
      '<p data-bascik-text="title"></p><div data-bascik-html="body"></div><h2 data-bascik-prop-heading></h2>',
    );
    expect(metadata.props).toEqual([{ name: "heading" }]);
  });

  it("infers unquoted slot names on self-closing tags without trailing slash", () => {
    const metadata = analyzeComponentSource(
      "<div data-bascik-slot=heroHeader/>",
    );
    expect(metadata.slots).toEqual([{ name: "heroHeader" }]);
  });

  it("infers named and default slots and component features", () => {
    const metadata = analyzeComponentSource(
      `<style>.card {}</style>
       <div data-bascik-slot="actions"></div>
       <main data-bascik-slot></main>
       <script>console.log('ready')</script>`,
    );

    expect(metadata.slots).toEqual([{ name: "actions" }]);
    expect(metadata.defaultSlot).toEqual({ name: "default" });
    expect(metadata.hasStyles).toBe(true);
    expect(metadata.hasScripts).toBe(true);
  });

  it("recognizes companion styles", () => {
    expect(
      analyzeComponentSource("<p>Card</p>", { hasCompanionStyles: true })
        .hasStyles,
    ).toBe(true);
  });

  it("enriches inferred members from an eligible leading header", () => {
    const source = `\ufeff<!-- ordinary -->
<!-- @bascik
A documented widget.
@prop label - Visible label.
@slot actions - Action controls.
@slot default - Main widget content.
-->
<p data-bascik-prop-label></p>
<div data-bascik-slot="actions"></div>
<div data-bascik-slot></div>`;
    const metadata = analyzeComponentSource(source);

    expect(metadata.description).toBe("A documented widget.");
    expect(metadata.props).toEqual([
      { name: "label", description: "Visible label." },
    ]);
    expect(metadata.slots).toEqual([
      { name: "actions", description: "Action controls." },
    ]);
    expect(metadata.defaultSlot).toEqual({
      name: "default",
      description: "Main widget content.",
    });
    expect(metadata.diagnostics).toEqual([]);
  });

  it("ignores a metadata comment after markup", () => {
    const metadata = analyzeComponentSource(
      "<p data-bascik-prop-label></p>\n<!-- @bascik\nLate docs.\n@prop label - Ignored.\n-->",
    );
    expect(metadata.description).toBeUndefined();
    expect(metadata.props).toEqual([{ name: "label" }]);
  });

  it("warns on undeclared and duplicate annotations with exact name offsets", () => {
    const source = `<!-- @bascik
@prop label - First.
@prop label - Second.
@prop missing - Missing.
@slot default - Missing default.
-->
<p data-bascik-prop-label></p>`;
    const metadata = analyzeComponentSource(source);

    expect(metadata.props).toEqual([{ name: "label", description: "First." }]);
    expect(
      metadata.diagnostics.map(
        ({ code, message }: { code: string; message: string }) => ({
          code,
          message,
        }),
      ),
    ).toEqual([
      {
        code: "component-metadata-duplicate-annotation",
        message:
          'Duplicate @prop annotation for "label". The first annotation is used.',
      },
      {
        code: "component-metadata-undeclared-annotation",
        message:
          '@prop annotation "missing" does not match a prop declared in this component\'s markup.',
      },
      {
        code: "component-metadata-undeclared-annotation",
        message:
          '@slot annotation "default" does not match a slot declared in this component\'s markup.',
      },
    ]);
    for (const diagnostic of metadata.diagnostics) {
      expect(source.slice(diagnostic.start, diagnostic.end)).toMatch(
        /^(?:label|missing|default)$/,
      );
    }
  });

  it("ignores prop and slot text inside comments and raw-text contents", () => {
    const metadata = analyzeComponentSource(`
      <!-- <p data-bascik-prop-commented></p> -->
      <script>const fake = '<div data-bascik-slot="fake"></div>';</script>
      <style>.x::after { content: 'data-bascik-prop-style'; }</style>
      <p data-bascik-prop-real></p>
    `);

    expect(metadata.props).toEqual([{ name: "real" }]);
    expect(metadata.slots).toEqual([]);
  });
});
