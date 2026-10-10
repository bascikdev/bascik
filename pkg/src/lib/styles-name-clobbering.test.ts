import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: { minify: { identifiers: true } },
}));

import { scopeContainerNames, scopeCounterStyleNames } from "./styles.ts";
import { getAttributeNameHash } from "./names.ts";

// Minified names start with `b`. Scoping one declared name at a time used to
// match a later declared name inside an earlier name's generated hash (or a
// shorter declared name inside a longer one), corrupting both.

const container = (name: string) => getAttributeNameHash(`bascik__my-comp__container__${name}`);
const counter = (name: string) => getAttributeNameHash(`bascik__my-comp__counter__${name}`);

describe("CSS name scoping replaces whole names only", () => {
  it("does not rewrite a container name inside another container's generated name", () => {
    const css = ".x { container-name: c; }\n.y { container-name: b; }\n@container c (min-width: 1px) { .z { color: red } }";
    const result = scopeContainerNames(css, "my-comp");
    expect(result).toBe(
      `.x { container-name: ${container("c")}; }\n.y { container-name: ${container("b")}; }\n@container ${container("c")} (min-width: 1px) { .z { color: red } }`,
    );
  });

  it("does not rewrite the start of a longer container name", () => {
    const css = ".x { container-name: a; }\n.y { container: a-b / inline-size; }\n@container a-b (min-width: 1px) {}";
    const result = scopeContainerNames(css, "my-comp");
    expect(result).toBe(
      `.x { container-name: ${container("a")}; }\n.y { container: ${container("a-b")} / inline-size; }\n@container ${container("a-b")} (min-width: 1px) {}`,
    );
  });

  it("does not rewrite a counter style inside another counter style's generated name", () => {
    const css = "@counter-style c { system: cyclic; symbols: x; }\n@counter-style b { system: cyclic; symbols: y; }\n" +
      "li::before { content: counter(item, c) counters(item, \".\", c) counter(item, b); }";
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toBe(
      `@counter-style ${counter("c")} { system: cyclic; symbols: x; }\n@counter-style ${counter("b")} { system: cyclic; symbols: y; }\n` +
      `li::before { content: counter(item, ${counter("c")}) counters(item, ".", ${counter("c")}) counter(item, ${counter("b")}); }`,
    );
  });

  it("does not rewrite the start of a longer counter style name", () => {
    const css = "@counter-style a { system: cyclic; symbols: x; }\n@counter-style a-b { system: cyclic; symbols: y; }\n" +
      "li::before { content: counter(item, a-b); }";
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toContain(`counter(item, ${counter("a-b")})`);
  });
});
