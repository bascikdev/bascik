import { describe, it, expect } from "vitest";
import { minifyCss } from "./css-minifier.ts";

describe("minifyCss", () => {
  it("strips block comments", () => {
    expect(minifyCss("/* a comment */\n.foo { color: red; }")).not.toContain(
      "/* a comment */",
    );
  });

  it("strips multi-line block comments", () => {
    const input = "/* line 1\n   line 2 */\n.foo { color: red; }";
    const result = minifyCss(input);
    expect(result).not.toContain("line 1");
    expect(result).not.toContain("line 2");
  });

  it("removes newlines", () => {
    expect(minifyCss(".foo {\n  color: red;\n}")).not.toContain("\n");
  });

  it("removes spaces around structural characters", () => {
    expect(minifyCss(".foo { color: red; }")).toBe(".foo{color:red;}");
  });

  it("collapses multiple spaces to one", () => {
    expect(minifyCss(".foo   .bar { color: red; }")).toContain(".foo .bar");
  });

  it("preserves meaningful spaces within property values", () => {
    // shorthand values like '96px 0 80px' have meaningful spaces that must not be removed
    const result = minifyCss(".a { padding: 96px 0 80px; }");
    expect(result).toContain("96px 0 80px");
  });

  it("handles a realistic stylesheet snippet", () => {
    const input =
      "/* Hero */\n.hero {\n  padding: 96px 0 80px;\n  color: red;\n}";
    expect(minifyCss(input)).toBe(".hero{padding:96px 0 80px;color:red;}");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(minifyCss("   \n   ")).toBe("");
  });

  it("handles media queries without mangling values", () => {
    const input = "@media (max-width: 768px) { .a { display: none; } }";
    const result = minifyCss(input);
    expect(result).toBe("@media (max-width:768px){.a{display:none;}}");
  });

  it("keeps the descendant combinator before a pseudo-class or pseudo-element", () => {
    // `.a :hover` matches hovered descendants of .a; `.a:hover` matches .a itself.
    const input = [
      ".a :is(h2, h3) { color: red; }",
      ".a :where(p) { margin: 0; }",
      ".a :hover { color: blue; }",
      ".a ::before { content: ''; }",
      ".a > :first-child { color: green; }",
      ".a { .b :focus { outline: 0; } }",
    ].join("\n");
    expect(minifyCss(input)).toBe(
      ".a :is(h2,h3){color:red;}.a :where(p){margin:0;}.a :hover{color:blue;}" +
        ".a ::before{content:'';}.a > :first-child{color:green;}.a{.b :focus{outline:0;}}",
    );
  });

  it("keeps the space after a pseudo-class before a descendant element or class selector", () => {
    // `.card:hover span` and `.list > :first-child a` have a space after `:hover` / `:first-child`
    // that is a descendant combinator, not a declaration colon!
    const input = [
      ".card:hover span { color: red; }",
      ".list > :first-child a { color: blue; }",
      ".box:focus-within .inner { opacity: 1; }",
    ].join("\n");
    expect(minifyCss(input)).toBe(
      ".card:hover span{color:red;}.list > :first-child a{color:blue;}.box:focus-within .inner{opacity:1;}",
    );
  });

  it("still removes spaces around declaration colons", () => {
    expect(minifyCss(".a { color : red ; margin :0 }")).toBe(
      ".a{color:red;margin:0}",
    );
    expect(minifyCss(".a { color: red; &:hover { color : blue } }")).toBe(
      ".a{color:red;&:hover{color:blue}}",
    );
  });

  it("preserves a space for an empty CSS custom property value (--empty: ;)", () => {
    expect(minifyCss(":root { --empty: ; --x: 1px; }")).toBe(
      ":root{--empty: ;--x:1px;}",
    );
  });

  it("keeps the whitespace that ends a hex escape apart from the combinator after it", () => {
    // `.\31  p` is the class `1` and a descendant `p`; one space would make
    // it the class `1p` (CSS Syntax: an escape consumes one whitespace).
    expect(minifyCss(".\\31  p { color: red; }")).toBe(".\\31  p{color:red;}");
    expect(minifyCss(".a\\1\n  .b { color: red; }")).toBe(
      ".a\\1  .b{color:red;}",
    );
    expect(minifyCss(".a\\00003a   :hover { color: red; }")).toBe(
      ".a\\00003a  :hover{color:red;}",
    );
  });

  it("misuse: still collapses spaces after a seven-digit hex run or a plain backslash escape", () => {
    // Six digits end an escape, so the seventh is text and the spaces after
    // it are one combinator; `\:` is not a hex escape at all.
    expect(minifyCss(".a\\1234567   p { color: red; }")).toBe(
      ".a\\1234567 p{color:red;}",
    );
    expect(minifyCss(".md\\:flex   p { color: red; }")).toBe(
      ".md\\:flex p{color:red;}",
    );
  });
});
