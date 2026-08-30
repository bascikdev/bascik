import { describe, it, expect } from "vitest";
import { minifyCss } from "./css-minifier.ts";

describe("minifyCss", () => {
  it("strips block comments", () => {
    expect(minifyCss("/* a comment */\n.foo { color: red; }")).not.toContain("/* a comment */");
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
    const input = "/* Hero */\n.hero {\n  padding: 96px 0 80px;\n  color: red;\n}";
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
});
