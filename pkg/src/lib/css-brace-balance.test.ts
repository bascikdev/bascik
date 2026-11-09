import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findCssBraceImbalance } from "./css-brace-balance.ts";

// Finding 42: one component's unbalanced `{`/`}` nests or drops every later rule in the combined
// page stylesheet, so a build must stop on it. These pin what counts as a brace.
describe("findCssBraceImbalance", () => {
  it("finds the { that a missing } leaves open", () => {
    const css = "article { color: red;\n.body { flex: 1; }\n";
    expect(findCssBraceImbalance(css)).toEqual({
      kind: "unclosed",
      offset: css.indexOf("{"),
    });
  });

  it("finds a stray } with no { to close", () => {
    const css = "article { color: red; }}\n.body { flex: 1; }\n";
    expect(findCssBraceImbalance(css)).toEqual({
      kind: "stray",
      offset: css.indexOf("}}") + 1,
    });
  });

  it("finds a } that closes nothing before any rule", () => {
    expect(findCssBraceImbalance("}\na {}")).toEqual({
      kind: "stray",
      offset: 0,
    });
  });

  it("reports the outermost open { when several are left open", () => {
    const css = "a { color: red;\nb { color: blue;\n";
    expect(findCssBraceImbalance(css)).toEqual({ kind: "unclosed", offset: 2 });
  });

  it.each([
    ["balanced rules", "a { color: red; }\n.b { flex: 1; }"],
    ["an empty stylesheet", ""],
    [
      "@media nesting",
      "@media (min-width: 40rem) {\n  .a { color: red; }\n  @supports (display: grid) { .b { display: grid; } }\n}",
    ],
    [
      "CSS nesting",
      ".card {\n  color: red;\n  & .title { font-weight: bold; }\n  &:hover { color: blue; }\n}",
    ],
    ["a } in a double-quoted string", '.a::after { content: "}"; }'],
    ["a { in a single-quoted string", ".a::after { content: '{'; }"],
    ["an escaped quote inside a string", '.a::after { content: "\\"}"; }'],
    ["a } in a comment", "/* } */ .a { color: red; } /* { */"],
    ["a { in a multi-line comment", "/*\n  {\n*/\n.a { color: red; }"],
    ["a } in an unquoted url()", ".a { background: url(img}.png); }"],
    ["a { in a quoted url()", '.a { background: url("img{.png"); }'],
    ["an escaped brace in a selector", ".a\\{b { color: red; }"],
    [
      "@font-face and @keyframes",
      "@keyframes spin { from { rotate: 0deg; } to { rotate: 360deg; } }",
    ],
  ])("accepts %s", (_label, css) => {
    expect(findCssBraceImbalance(css)).toBeUndefined();
  });

  it("does not let an unclosed comment hide a missing } after the last real {", () => {
    // The comment never closes, so the rest of the file is comment: the { before it is still open.
    const css = ".a { color: red; /* note";
    expect(findCssBraceImbalance(css)).toEqual({ kind: "unclosed", offset: 3 });
  });

  it("ends an unclosed string at its line break, as CSS does, so a } on the next line counts", () => {
    const css = '.a { content: "oops;\n}\n.b { color: red; }';
    expect(findCssBraceImbalance(css)).toBeUndefined();
  });

  it("handles a long run of open braces and unclosed quotes", () => {
    expect(findCssBraceImbalance("{".repeat(200_000))).toEqual({
      kind: "unclosed",
      offset: 0,
    });
    expect(findCssBraceImbalance(`a {}${'"'.repeat(50_000)}`)).toBeUndefined();
  });
});

describe("css-brace-balance copies", () => {
  it("keeps the language server's copy identical, so --check and the build agree on every brace", () => {
    const read = (relative: string) =>
      readFileSync(new URL(relative, import.meta.url), "utf8");
    expect(read("../../../lsp/src/css-brace-balance.ts")).toBe(
      read("./css-brace-balance.ts"),
    );
  });
});
