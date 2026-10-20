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

const container = (name: string) =>
  getAttributeNameHash(`bascik__my-comp__container__${name}`);
const counter = (name: string) =>
  getAttributeNameHash(`bascik__my-comp__counter__${name}`);
const keyframe = (name: string) =>
  getAttributeNameHash(`bascik__my-comp__keyframe__${name}`);
const customProp = (name: string) =>
  getAttributeNameHash(`bascik__my-comp__${name}`);
const layer = (name: string) =>
  getAttributeNameHash(`bascik__my-comp__layer__${name}`);
const vtn = (name: string) =>
  getAttributeNameHash(`bascik__my-comp__vtn__${name}`);
const anchor = (name: string) =>
  getAttributeNameHash(`bascik__my-comp__anchor__${name}`);
const cls = (name: string) => getAttributeNameHash(`bascik__my-comp__${name}`);

describe("CSS name scoping replaces whole names only", () => {
  it("does not rewrite a container name inside another container's generated name", () => {
    const css =
      ".x { container-name: c; }\n.y { container-name: b; }\n@container c (min-width: 1px) { .z { color: red } }";
    const result = scopeContainerNames(css, "my-comp");
    expect(result).toBe(
      `.x { container-name: ${container("c")}; }\n.y { container-name: ${container("b")}; }\n@container ${container("c")} (min-width: 1px) { .z { color: red } }`,
    );
  });

  it("does not rewrite the start of a longer container name", () => {
    const css =
      ".x { container-name: a; }\n.y { container: a-b / inline-size; }\n@container a-b (min-width: 1px) {}";
    const result = scopeContainerNames(css, "my-comp");
    expect(result).toBe(
      `.x { container-name: ${container("a")}; }\n.y { container: ${container("a-b")} / inline-size; }\n@container ${container("a-b")} (min-width: 1px) {}`,
    );
  });

  it("does not scope CSS property names that end with container-name (e.g. --container-name or scroll-container)", () => {
    const css =
      ".x { container-name: panel; --my-container-name: panel; scroll-container: panel; }\n@container panel (min-width: 1px) {}";
    const result = scopeContainerNames(css, "my-comp");
    expect(result).toBe(
      `.x { container-name: ${container("panel")}; --my-container-name: panel; scroll-container: panel; }\n@container ${container("panel")} (min-width: 1px) {}`,
    );
  });

  it("does not mangle unquoted file extensions in CSS attribute selectors like a[href$=.pdf]", () => {
    const component = prefixElementAttribute(
      {
        name: "my-comp",
        fileContent: '<div class="card"><a href="/doc.pdf">PDF</a></div>',
        cssFileContent: ".card a[href$=.pdf] { color: red; }",
      },
      "class",
      "12345678",
    );
    expect(component.cssFileContent).toContain("[href$=.pdf]");
  });

  it("does not rewrite a counter style inside another counter style's generated name", () => {
    const css =
      "@counter-style c { system: cyclic; symbols: x; }\n@counter-style b { system: cyclic; symbols: y; }\n" +
      'li::before { content: counter(item, c) counters(item, ".", c) counter(item, b); }';
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toBe(
      `@counter-style ${counter("c")} { system: cyclic; symbols: x; }\n@counter-style ${counter("b")} { system: cyclic; symbols: y; }\n` +
        `li::before { content: counter(item, ${counter("c")}) counters(item, ".", ${counter("c")}) counter(item, ${counter("b")}); }`,
    );
  });

  it("does not rewrite the start of a longer counter style name", () => {
    const css =
      "@counter-style a { system: cyclic; symbols: x; }\n@counter-style a-b { system: cyclic; symbols: y; }\n" +
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

  it("does not rewrite CSS property names or unrelated property values when a keyframe is named color, ease, none, or flex", () => {
    const css =
      "@keyframes color { from { opacity: 0; } to { opacity: 1; } }\n" +
      "@keyframes flex { from { opacity: 0; } to { opacity: 1; } }\n" +
      ".box { display: flex; color: red; transition: color 0.2s ease; animation: color 1s ease, flex 2s; animation-name: color, flex; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toBe(
      `@keyframes ${keyframe("color")} { from { opacity: 0; } to { opacity: 1; } }\n` +
        `@keyframes ${keyframe("flex")} { from { opacity: 0; } to { opacity: 1; } }\n` +
        `.box { display: flex; color: red; transition: color 0.2s ease; animation: ${keyframe("color")} 1s ease, ${keyframe("flex")} 2s; animation-name: ${keyframe("color")}, ${keyframe("flex")}; }`,
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
    const css =
      "@layer a, b; @layer a { .b { color: red } } @layer b { .a { color: blue } }";
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
        cssFileContent:
          ".a { color: red } .b { color: blue } .a-b { color: green }",
      },
      "class",
      "12345678",
    );
    const expectedTriple = `${cls("a")} ${cls("b")} ${cls("a-b")}`;
    expect(component.fileContent).toContain(`class="${expectedTriple}"`);
    expect(component.fileContent).toContain(
      `el.className = "${expectedTriple}"`,
    );
    expect(component.fileContent).toContain(
      `el.setAttribute("class", "${expectedTriple}")`,
    );
    expect(component.fileContent).toContain(
      `document.getElementsByClassName("${cls("a")} ${cls("b")}")`,
    );
    expect(component.fileContent).toContain(
      `document.querySelector(".${cls("a")} .${cls("b")} .${cls("a-b")}")`,
    );
    expect(component.fileContent).toContain(
      `el.classList.add("${cls("a")}", "${cls("b")}", "${cls("a-b")}")`,
    );
    expect(component.fileContent).toContain(
      `el.classList.toggle("${cls("a")}", true)`,
    );
  });
});

describe("animation shorthand timing-function keyword vs animation-name disambiguation", () => {
  // CSS Animations Level 1: timing-function keywords (ease, linear, ease-in,
  // ease-out, ease-in-out, step-start, step-end) are never treated as the
  // animation-name when they appear in their grammar-defined token slot.
  // The animation-name must be a <custom-ident> that is not consumed by any
  // other single-animation component value.

  it("does not scope the timing-function keyword 'ease' when only the animation-name 'spin' is declared", () => {
    const css =
      "@keyframes ease { to { opacity: 0 } }\n" +
      "@keyframes spin { to { opacity: 1 } }\n" +
      ".card { animation: spin 1s ease; }";
    const result = prefixKeyframes(css, "my-comp");
    // spin IS declared as a keyframe, ease IS declared as a keyframe but
    // acts as a timing function in `spin 1s ease` — only spin should be scoped.
    expect(result).toContain(`animation: ${keyframe("spin")} 1s ease`);
    expect(result).not.toContain(
      `animation: ${keyframe("spin")} 1s ${keyframe("ease")}`,
    );
    // @keyframes ease declaration should still be scoped
    expect(result).toContain(`@keyframes ${keyframe("ease")}`);
    // @keyframes spin declaration should be scoped
    expect(result).toContain(`@keyframes ${keyframe("spin")}`);
  });

  it("scopes the animation-name token when disambiguating from timing-function keywords in animation shorthand", () => {
    const css =
      "@keyframes ease { to { opacity: 0 } }\n" +
      "@keyframes linear { to { opacity: 0 } }\n" +
      "@keyframes ease-in { to { opacity: 0 } }\n" +
      "@keyframes ease-out { to { opacity: 0 } }\n" +
      "@keyframes ease-in-out { to { opacity: 0 } }\n" +
      "@keyframes step-start { to { opacity: 0 } }\n" +
      "@keyframes step-end { to { opacity: 0 } }\n" +
      ".a { animation: ease 1s linear; }\n" +
      ".b { animation: linear 1s ease-in; }\n" +
      ".c { animation: ease-in 1s ease-out; }\n" +
      ".d { animation: ease-out 1s ease-in-out; }\n" +
      ".e { animation: ease-in-out 1s step-start; }\n" +
      ".f { animation: step-start 1s step-end; }\n" +
      ".g { animation: step-end 1s ease; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toContain(`animation: ease 1s ${keyframe("linear")}`);
    expect(result).toContain(`animation: linear 1s ${keyframe("ease-in")}`);
    expect(result).toContain(`animation: ease-in 1s ${keyframe("ease-out")}`);
    expect(result).toContain(
      `animation: ease-out 1s ${keyframe("ease-in-out")}`,
    );
    expect(result).toContain(
      `animation: ease-in-out 1s ${keyframe("step-start")}`,
    );
    expect(result).toContain(
      `animation: step-start 1s ${keyframe("step-end")}`,
    );
    expect(result).toContain(`animation: step-end 1s ${keyframe("ease")}`);
  });

  it("assigns timing slot to function easing and does not rewrite commas or function args", () => {
    const css =
      "@keyframes end { to { opacity: 0 } }\n" +
      "@keyframes start { to { opacity: 0 } }\n" +
      "@keyframes ease { to { opacity: 0 } }\n" +
      "@keyframes spin { to { opacity: 1 } }\n" +
      ".s1 { animation: steps(2, end) 1s ease; }\n" +
      ".s2 { animation: steps(2, start) 1s spin; }\n" +
      ".s3 { animation: steps(2, end) 1s end; }\n" +
      ".s4 { animation: steps(2, end) 1s ease, steps(3, start) 2s linear; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toContain(
      `.s1 { animation: steps(2, end) 1s ${keyframe("ease")}; }`,
    );
    expect(result).toContain(
      `.s2 { animation: steps(2, start) 1s ${keyframe("spin")}; }`,
    );
    expect(result).toContain(
      `.s3 { animation: steps(2, end) 1s ${keyframe("end")}; }`,
    );
    expect(result).toContain(
      `.s4 { animation: steps(2, end) 1s ${keyframe("ease")}, steps(3, start) 2s linear; }`,
    );
  });

  it.each([
    "calc(1s + 1s)",
    "min(1s, 2s)",
    "max(1s, 2s)",
    "clamp(1s, calc(1s + 1s), 3s)",
  ])(
    "does not consume the easing slot for a calculated duration: %s",
    (duration) => {
      const css = `@keyframes spin { to { opacity: 1 } } @keyframes ease { to { opacity: 0 } } .card { animation: spin ${duration} ease; }`;
      expect(prefixKeyframes(css, "my-comp")).toContain(
        `animation: ${keyframe("spin")} ${duration} ease;`,
      );
    },
  );

  it.each([
    "steps(2, end)",
    "cubic-bezier(0, 0, 1, 1)",
    "linear(0, 1)",
    "STEPS(2, end)",
  ])(
    "consumes the easing slot for a recognized easing function: %s",
    (easing) => {
      const css = `@keyframes ease { to { opacity: 0 } } .card { animation: 1s ${easing} ease; }`;
      expect(prefixKeyframes(css, "my-comp")).toContain(
        `animation: 1s ${easing} ${keyframe("ease")};`,
      );
    },
  );

  it.each(["2", ".5", "0", "+2", "1e2", "2.5e-1"])(
    "consumes a unitless iteration count before an infinite-named animation: %s",
    (count) => {
      const css = `@keyframes infinite { to { opacity: 0 } } .card { animation: 1s ${count} infinite; }`;
      expect(prefixKeyframes(css, "my-comp")).toContain(
        `animation: 1s ${count} ${keyframe("infinite")};`,
      );
    },
  );

  it("resets shorthand slots for each animation and does not treat time units as counts", () => {
    const css =
      "@keyframes infinite { to { opacity: 0 } } .card { animation: 1s 2 infinite, infinite 2s 100ms; }";
    expect(prefixKeyframes(css, "my-comp")).toContain(
      `animation: 1s 2 ${keyframe("infinite")}, infinite 2s 100ms;`,
    );
  });

  it("does not split numeric/dimension token so keyframe 's' does not match unit in '1s'", () => {
    const css =
      "@keyframes s { to { opacity: 0; } }\n" +
      "@keyframes spin { to { opacity: 1; } }\n" +
      ".spin { animation: spin 1s ease; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toContain(`animation: ${keyframe("spin")} 1s ease`);
    expect(result).not.toContain(`1${keyframe("s")}`);
  });

  it("recognizes whole leading-hyphen keyframe names like '-spin' and '--spin'", () => {
    const css =
      "@keyframes -spin { to { transform: rotate(360deg); } }\n" +
      "@keyframes --spin { to { transform: rotate(360deg); } }\n" +
      ".spin1 { animation: -spin 1s ease; }\n" +
      ".spin2 { animation: --spin 2s ease; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toContain(`@keyframes ${keyframe("-spin")}`);
    expect(result).toContain(`@keyframes ${keyframe("--spin")}`);
    expect(result).toContain(
      `.spin1 { animation: ${keyframe("-spin")} 1s ease; }`,
    );
    expect(result).toContain(
      `.spin2 { animation: ${keyframe("--spin")} 2s ease; }`,
    );
  });

  it("handles case-insensitive CSS keywords while keeping keyframe names case-sensitive", () => {
    const css =
      "@keyframes LINEAR { to { opacity: 0 } }\n" +
      "@keyframes EASE { to { opacity: 0 } }\n" +
      ".c1 { animation: EASE 2s LINEAR; }\n" +
      ".c2 { animation: LINEAR 1s EASE; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toContain(
      `.c1 { animation: EASE 2s ${keyframe("LINEAR")}; }`,
    );
    expect(result).toContain(
      `.c2 { animation: LINEAR 1s ${keyframe("EASE")}; }`,
    );
  });

  it("does not scope the timing-function keyword 'ease' in animation shorthand even when it is the only word token (CSS spec: timing keywords take priority over name slot)", () => {
    // CSS Animations Level 1: `ease` is a valid <easing-function> keyword, so
    // it is consumed by the timing-function slot.  With `animation: ease 1s`
    // the animation-name defaults to `none` and the animation does not play.
    // The correct fix for a user who wants to play an `@keyframes ease` is to
    // use `animation-name: ease` or `animation: ease 1s linear` (explicit timing).
    // Bascik must NOT scope `ease` in the timing slot; doing so produces
    // `animation: <scoped-hash> 1s` where the hash is treated as the name —
    // valid CSS but the intended `ease` timing function is lost.
    const css =
      "@keyframes ease { to { opacity: 0 } }\n" +
      ".card { animation: ease 1s; }";
    const result = prefixKeyframes(css, "my-comp");
    // `ease 1s`: per spec, ease fills the timing slot; the name defaults to none.
    // Bascik must leave `ease` unscoped in the shorthand value.
    expect(result).toContain("animation: ease 1s");
    // But the @keyframes ease declaration IS still scoped (for use with animation-name)
    expect(result).toContain(`@keyframes ${keyframe("ease")}`);
  });

  it("scopes the animation-name 'ease' when animation-name is explicit (no shorthand ambiguity)", () => {
    const css =
      "@keyframes ease { to { opacity: 0 } }\n" +
      ".card { animation-name: ease; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toContain(`animation-name: ${keyframe("ease")}`);
  });

  it("handles multiple animations: timing function vs name disambiguation per single animation", () => {
    const css =
      "@keyframes ease { to { opacity: 0 } }\n" +
      "@keyframes spin { to { opacity: 1 } }\n" +
      ".card { animation: spin 1s ease, linear 2s ease; }";
    const result = prefixKeyframes(css, "my-comp");
    expect(result).toContain(
      `animation: ${keyframe("spin")} 1s ease, linear 2s ${keyframe("ease")}`,
    );
  });

  it("does not scope 'ease' appearing as a timing keyword in transition shorthand (non-animation property)", () => {
    // `transition` is not `animation` — prefixKeyframes should not touch it at all
    const css =
      "@keyframes ease { to { opacity: 0 } }\n" +
      ".card { transition: color 0.2s ease; }";
    const result = prefixKeyframes(css, "my-comp");
    // transition is not scoped by prefixKeyframes
    expect(result).toContain("transition: color 0.2s ease");
  });

  it("scopes the keyframe name in vendor-prefixed animation shorthand", () => {
    const css =
      "@keyframes ease { to { opacity: 0 } }\n" +
      "@keyframes spin { to { opacity: 1 } }\n" +
      ".card { -webkit-animation: spin 1s ease; }";
    const result = prefixKeyframes(css, "my-comp");
    // spin should be scoped; ease (timing) should not
    expect(result).toContain(`-webkit-animation: ${keyframe("spin")} 1s ease`);
  });
});
