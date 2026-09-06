import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskCssSyntax } from "./css-tokenizer.ts";

describe("maskCssSyntax – perfect round-trip", () => {
  it("restore(masked) is byte-identical to the original CSS", () => {
    const cssArb = fc.constantFrom(
      ".nav a { color: white; }",
      `content: ".foo { color: red; }"`,
      `content: "url(#local)"`,
      `a[href="#tab"] { color: red; }`,
      `a[data-x='#tab'] { color: red; }`,
      `background: url(./img.png); color: #abc;`,
      `background: url("data:image/svg+xml,%3Csvg%3E");`,
      `content: 'from { opacity: 0; }'; animation: spin 1s;`,
      `:root { --brand: #d3ff8d; } .el { color: var(--brand); }`,
      `#hero { background: #fff; } .page { color: #333; }`,
      `@media (max-width: 600px) { #btn { font-size: 0.9rem; } }`,
      `/* fill: url(#local) */ .icon { fill: url(#local); }`,
      `.cls { font-family: 'Arial', sans-serif; content: "don't break"; }`,
      `@charset "UTF-8"; .el { background: url('img.png'); }`,
      `.a::before { content: "<div class=\\"x\\">test</div>"; }`,
      `a[href="#tab"][data-v="x"] { color: red; }`,
      `.icon { fill: url("#grad"); }`,
      `.x { background: url("sprite.svg#icon"); }`,
    );

    fc.assert(
      fc.property(fc.array(cssArb, { minLength: 1, maxLength: 4 }), (parts) => {
        const original = parts.join("\n");
        const { masked, restore } = maskCssSyntax(original);
        // restore() is destructive: capture once.
        const res = restore(masked);
        expect(res).toBe(original);
        // No shield tokens may survive restore.
        expect(res).not.toContain("\x00");
      }),
      { numRuns: 300 },
    );
  });

  it("keeps genuine url() fragments live for keepUrlArguments:true", () => {
    const css = '.icon::before { content: "url(#local)"; fill: url("#local"); }';
    const { masked } = maskCssSyntax(css, { keepUrlArguments: true });
    // The content string is hidden but the real quoted url("#local") stays live,
    // so a url-fragment rewrite can still target it.
    expect(masked).toContain('url("#local")');
    expect(masked).not.toContain('content: "url(');
  });

  it("masks url() quoted arguments for keepUrlArguments:false", () => {
    const css = '.icon { fill: url("#grad"); }';
    const { masked } = maskCssSyntax(css, { keepUrlArguments: false });
    expect(masked).not.toContain('url("#grad")');
  });

  it("round-trips a bracket-heavy data-URI inside a live url() argument", () => {
    // A real quoted url() is kept live (so its fragment can scope). A data URI
    // containing brackets must still round-trip byte-identically, and any `[`
    // is consumed within the url-string rather than opening an attribute
    // region that masks the rest of the stylesheet.
    const css =
      '.a { background: url("data:image/svg+xml,%5Bx%5D#anch"); } svg[data-x="y"] { fill: red; }';
    const { masked, restore } = maskCssSyntax(css, { keepUrlArguments: true });
    expect(restore(masked)).toBe(css);
    // The real attribute selector after the url() must stay live.
    expect(masked).toContain('svg');
  });
});
