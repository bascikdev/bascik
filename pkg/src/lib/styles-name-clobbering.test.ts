import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: { minify: { identifiers: true } },
}));

import {
  prefixKeyframes,
  scopeAnchorNames,
  scopeContainerNames,
  scopeCounterStyleNames,
  scopeCssCustomProperties,
  scopeLayerNames,
  scopeViewTransitionNames,
} from "./styles.ts";
import { prefixElementAttribute } from "./javascript.ts";
import { getAttributeNameHash } from "./names.ts";

// Minified names start with `b`. Scoping one declared name at a time used to
// match a later declared name inside an earlier name's generated hash (or a
// shorter declared name inside a longer one), corrupting both.

const container = (name: string) => getAttributeNameHash(`bascik__my-comp__container__${name}`);
const counter = (name: string) => getAttributeNameHash(`bascik__my-comp__counter__${name}`);
const keyframe = (name: string) => getAttributeNameHash(`bascik__my-comp__keyframe__${name}`);
const customProp = (name: string) => getAttributeNameHash(`bascik__my-comp__${name}`);
const layer = (name: string) => getAttributeNameHash(`bascik__my-comp__layer__${name}`);
const vtn = (name: string) => getAttributeNameHash(`bascik__my-comp__vtn__${name}`);
const anchor = (name: string) => getAttributeNameHash(`bascik__my-comp__anchor__${name}`);
const cls = (name: string) => getAttributeNameHash(`bascik__my-comp__${name}`);

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

  it("does not rewrite a keyframe name inside another keyframe's generated name or class selector", () => {
    const css =
      "@keyframes a { to { opacity: 1 } }\n" +
      "@keyframes b { to { opacity: 0 } }\n" +
      `.a { animation: a 1s, b 2s; content: "a b"; }`;
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toBe(
      `@keyframes ${keyframe("a")} { to { opacity: 1 } }\n` +
      `@keyframes ${keyframe("b")} { to { opacity: 0 } }\n` +
      `.a { animation: ${keyframe("a")} 1s, ${keyframe("b")} 2s; content: "a b"; }`,
    );
  });

  it("does not rewrite the start of a longer custom property or inside another generated custom property", () => {
    const css =
      ":root { --a: 1px; --a-b: 2px; --b: 3px; }\n" +
      "@property --a-b { syntax: '<length>'; inherits: false; initial-value: 0px; }\n" +
      '.x { width: var(--a-b, var(--a)); height: var(--b); content: "var(--a)"; }';
    const result = scopeCssCustomProperties(css, "my-comp");
    expect(result).toBe(
      `:root { --${customProp("a")}: 1px; --${customProp("a-b")}: 2px; --${customProp("b")}: 3px; }\n` +
      `@property --${customProp("a-b")} { syntax: '<length>'; inherits: false; initial-value: 0px; }\n` +
      `.x { width: var(--${customProp("a-b")}, var(--${customProp("a")})); height: var(--${customProp("b")}); content: "var(--a)"; }`,
    );
  });

  it("does not rewrite a layer name inside another layer's generated name or a selector on the same line", () => {
    const css = "@layer a, b; @layer a { .b { color: red } } @layer b { .a { color: blue } }";
    const result = scopeLayerNames(css, "my-comp");
    expect(result).toBe(
      `@layer ${layer("a")}, ${layer("b")}; @layer ${layer("a")} { .b { color: red } } @layer ${layer("b")} { .a { color: blue } }`,
    );
  });

  it("does not rewrite the start of a longer view-transition-name or inside another generated name", () => {
    const css =
      ".x { view-transition-name: a; }\n" +
      ".y { view-transition-name: a-b; }\n" +
      ".z { view-transition-name: b; }\n" +
      "::view-transition-old(a-b) { opacity: 0 }\n" +
      "::view-transition-new(a) { opacity: 1 }";
    const result = scopeViewTransitionNames(css, "my-comp");
    expect(result).toBe(
      `.x { view-transition-name: ${vtn("a")}; }\n` +
      `.y { view-transition-name: ${vtn("a-b")}; }\n` +
      `.z { view-transition-name: ${vtn("b")}; }\n` +
      `::view-transition-old(${vtn("a-b")}) { opacity: 0 }\n` +
      `::view-transition-new(${vtn("a")}) { opacity: 1 }`,
    );
  });

  it("does not rewrite the start of a longer anchor name or inside another generated anchor name", () => {
    const css =
      ".x { anchor-name: --a; position-anchor: --a-b; }\n" +
      ".y { anchor-name: --a-b; position-anchor: --b; }\n" +
      ".z { anchor-name: --b; }\n" +
      "@position-try --a-b { top: 0; }";
    const result = scopeAnchorNames(css, "my-comp");
    expect(result).toBe(
      `.x { anchor-name: --${anchor("a")}; position-anchor: --${anchor("a-b")}; }\n` +
      `.y { anchor-name: --${anchor("a-b")}; position-anchor: --${anchor("b")}; }\n` +
      `.z { anchor-name: --${anchor("b")}; }\n` +
      `@position-try --${anchor("a-b")} { top: 0; }`,
    );
  });

  it("does not rewrite a JS class token inside an earlier scoped class token", () => {
    const component = prefixElementAttribute(
      {
        name: "my-comp",
        fileContent:
          `<div class="a b a-b"></div>` +
          `<script>` +
          `el.className = "a b a-b"; ` +
          `el.setAttribute("class", "a b a-b"); ` +
          `document.getElementsByClassName("a b"); ` +
          `document.querySelector(".a .b .a-b"); ` +
          `el.classList.add("a", "b", "a-b"); ` +
          `el.classList.toggle("a", true);` +
          `</script>`,
        cssFileContent: ".a { color: red } .b { color: blue } .a-b { color: green }",
      },
      "class",
      "12345678",
    );
    const expectedTriple = `${cls("a")} ${cls("b")} ${cls("a-b")}`;
    expect(component.fileContent).toContain(`class="${expectedTriple}"`);
    expect(component.fileContent).toContain(`el.className = "${expectedTriple}"`);
    expect(component.fileContent).toContain(`el.setAttribute("class", "${expectedTriple}")`);
    expect(component.fileContent).toContain(`document.getElementsByClassName("${cls("a")} ${cls("b")}")`);
    expect(component.fileContent).toContain(`document.querySelector(".${cls("a")} .${cls("b")} .${cls("a-b")}")`);
    expect(component.fileContent).toContain(`el.classList.add("${cls("a")}", "${cls("b")}", "${cls("a-b")}")`);
    expect(component.fileContent).toContain(`el.classList.toggle("${cls("a")}", true)`);
  });
});
