import { describe, expect, it } from "vitest";
import {
  extractDefaultSlotContent,
  extractNamedSlotContent,
  replaceDefaultSlots,
  replaceNamedSlots,
} from "./component-slots.ts";
import {
  createMatchingCloseFinder,
  findMatchingClose,
  getFirstComponent,
  getTag,
  mayContainComponent,
  replaceTag,
} from "./component-tags.ts";
import {
  extractInheritableAttributes,
  mergeAttributesOntoRoot,
} from "./component-inheritance.ts";
import {
  extractProps,
  injectPropAttributes,
  injectProps,
} from "./component-props.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { stampScriptLines, stripScriptLines } from "./script-source-lines.ts";
import {
  maskElementContents,
  shieldElementContents,
  shieldPreservedAttribute,
} from "./shielding.ts";
import {
  collectDeclaredIds,
  rewriteIdReferencesInHtml,
} from "./id-references.ts";
import {
  htmlHasServerScripts,
  planServerScripts,
  sourceHasServerScripts,
} from "./server-scripts.ts";
import {
  extractComponentScriptsToSidecar,
  extractServerScriptsToSidecar,
} from "./server-sidecar.ts";
import { __manifestScansForTests } from "./component-manifest.ts";
import {
  addElementClassesInHtml,
  addIdClassesInHtml,
  extractInlineStyles,
  scopeInlineStyleTags,
} from "./styles.ts";
import { __companionScriptTagsForTests } from "./components.ts";
import { namespaceScriptTags, prefixElementAttribute } from "./javascript.ts";
import { scriptDirectiveFinder } from "./html-patterns.ts";
import { splitDistPageIntoSegments } from "./site-graph.ts";
import { __checkScansForTests } from "./check.ts";
import {
  __cspRegexFallbackForTests,
  computePageCspHashes,
} from "./csp-hashes.ts";
import type { BascikComponent, ComponentList } from "./types.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
  repeatTo,
} from "./linear-time.test-helper.ts";

// Since request-time component rendering, a server or stream script's output
// (which can echo visitor input such as `?q=`) reaches the component
// expansion loop on every request: slot content, usage tags and the scanned
// output itself. Every open-tag scan on that path must be linear in its
// input, or a request is a denial of service. The scans replaced here were
// regexes built on the attribute chain `(?:[^>"']|"[^"]*"|'[^']*')*`, which
// retries from every opener: quadratic when openers never reach a `>` or
// leave a quote open, and cubic where two chains surround a marker
// (`data-bascik-slot`, `data-bascik-server`). Measured on HEAD at 50k
// characters: about 1 to 2.5 s for the quadratic ones, and 90 to 550 s for
// the cubic ones. Build-time scans of authored files went the same way.
//
// Each case below runs a hostile input of at least 200k characters (1M for
// the lazy `[\s\S]*?>` scans, which V8 runs fast per opener) and a quarter of
// that, and requires the time to grow linearly. A fixed wall-clock bound
// (250 ms) flaked on shared CI runners under coverage (251, 257 and 300 ms),
// and locally under CPU load, on scans that take about 100 ms when the
// machine is idle. Growth does not depend on the machine's speed: quadrupling
// the input roughly quadruples linear work, while the quadratic scans grew
// about 16 times and the cubic ones about 64. Each size is timed several
// times, interleaved, and the fastest run counts, so a run that loses the CPU
// to another process does not decide the ratio (linear-time.test-helper.ts).

const SIZE = 200_000;

const components: ComponentList = Object.freeze({
  "my-card": { fileContent: "<div></div>" } as BascikComponent,
});

const component = (fileContent: string): BascikComponent =>
  ({
    name: "cmp",
    fileContent,
    filePath: "/project/components/cmp.html",
  }) as BascikComponent;

const quiet = (): void => {};

interface HostileCase {
  /** The site, as `file: what`. */
  site: string;
  /** The hostile input at `size` characters or more. */
  input: (size: number) => string;
  /** Defaults to `SIZE`. */
  size?: number;
  run: (html: string) => unknown;
}

const requestTimeCases: HostileCase[] = [
  {
    site: "component-slots: named slot wrapper (cubic)",
    input: (size) => repeatTo("<a data-bascik-slot=a ", size),
    run: (html) => extractNamedSlotContent(html),
  },
  {
    site: "component-slots: named slot wrapper with a quoted marker",
    input: (size) => repeatTo(`<a data-bascik-slot="s" x='`, size),
    run: (html) => [
      extractDefaultSlotContent(html),
      replaceNamedSlots(html, { s: "S" }),
    ],
  },
  {
    site: "component-slots: default slot marker (cubic)",
    input: (size) =>
      `<b data-bascik-slot="side">${repeatTo("<a data-bascik-slot ", size)}'</b>`,
    run: (html) => replaceDefaultSlots(html, "x"),
  },
  {
    site: "component-tags: matching close finder",
    input: (size) => `<b data-bascik-slot="side">${repeatTo("<b ", size)}'</b>`,
    run: (html) => [
      extractNamedSlotContent(html),
      createMatchingCloseFinder(html, html)("b", 0),
    ],
  },
  {
    site: "component-tags: findMatchingClose",
    input: (size) => `<my-card>${repeatTo("<my-card ", size)}'</my-card>`,
    run: (html) => [
      getFirstComponent(html, components),
      findMatchingClose(html, "my-card", 9),
    ],
  },
  {
    site: "component-tags: open tag search",
    input: (size) => `${repeatTo("<my-card ", size)}'>`,
    run: (html) => getFirstComponent(html, components),
  },
  {
    site: "component-tags: component list search (lazy)",
    size: 1_000_000,
    input: (size) => repeatTo("<my-card x", size),
    run: (html) => [
      mayContainComponent(html, components),
      getFirstComponent(html, components),
    ],
  },
  {
    site: "component-tags: self-closing fallback (lazy)",
    size: 1_000_000,
    input: (size) => repeatTo("<my-card x", size),
    run: (html) => getTag(html, "my-card"),
  },
  {
    site: "component-tags: replaceTag self-closing fallback",
    input: (size) => repeatTo("<my-card x", size),
    run: (html) => replaceTag(html, "my-card", "T"),
  },
  {
    site: "component-inheritance: root tag of slot content",
    input: (size) => repeatTo("<a x", size),
    run: (html) => mergeAttributesOntoRoot(html, { class: "k" }),
  },
  {
    site: "component-inheritance: a root tag holding a run of spaces",
    input: (size) => `<div${" ".repeat(size)}>`,
    run: (html) => [
      mergeAttributesOntoRoot(html, { class: "k", title: "t" }),
      extractInheritableAttributes(html),
    ],
  },
  {
    site: "component-props: injectProps receivers",
    input: (size) => `${repeatTo("<a x", size)} data-bascik-prop-t`,
    run: (html) => injectProps(html, { t: "v" }),
  },
  {
    site: "component-props: unfilled markers, no whitespace and no >",
    input: (size) => `${repeatTo("<a/", size)}data-bascik-prop-`,
    run: (html) => injectProps(html, {}),
  },
  {
    site: "component-props: unfilled markers, quoted and no whitespace",
    input: (size) => `${repeatTo("<a'x'", size)}data-bascik-prop-`,
    run: (html) => injectProps(html, {}),
  },
  {
    site: "component-props: injectPropAttributes",
    input: (size) => `${repeatTo("<a '", size)}data-bascik-attr-`,
    run: (html) => injectPropAttributes(html, { t: "v" }, undefined, quiet),
  },
  {
    // A second binding on the tag appends before the close: a visitor value
    // with a long whitespace run already in the tag made that close-of-tag
    // regex quadratic.
    site: "component-props: a second binding after a visitor whitespace run",
    input: (size) => "a" + " ".repeat(size) + "a",
    // Smaller than SIZE so a quadratic regression fails in seconds, not minutes.
    size: 40_000,
    run: (value) =>
      injectPropAttributes(
        `<p data-bascik-attr-title="a" data-bascik-attr-lang="b">x</p>`,
        { a: value, b: "en" },
        undefined,
        quiet,
      ),
  },
  {
    site: "component-props: one prop bound to two attributes, newline run",
    input: (size) => "a" + "\n".repeat(size) + "a",
    size: 40_000,
    run: (value) =>
      injectPropAttributes(
        `<p data-bascik-attr-title="a" data-bascik-attr-lang="a">x</p>`,
        { a: value },
        undefined,
        quiet,
      ),
  },
  {
    site: "component-props: extractProps (anchored, linear before too)",
    input: (size) => `${repeatTo("<a '", size)} data-bascik-prop-`,
    run: (html) => extractProps(html, quiet),
  },
];

const buildTimeCases: HostileCase[] = [
  ...["<style x", "<textarea x", "<script x", "<!--", "<script>"].map(
    (unit): HostileCase => ({
      site: `directive-source: ${JSON.stringify(unit)}`,
      input: (size) => `${repeatTo(unit, size)} data-bascik-server`,
      run: (html) => stampDirectiveSources(html, "page.html"),
    }),
  ),
  {
    site: "script-source-lines: stamp and strip",
    input: (size) => `${repeatTo("<script x", size)} data-bascik-script-line`,
    run: (html) => [stampScriptLines(html), stripScriptLines(html)],
  },
  {
    site: "shielding: preserved attribute tag scan",
    input: (size) => `${repeatTo("<a '", size)} data-bascik-preserve`,
    run: (html) => shieldPreservedAttribute(html, "id"),
  },
  {
    site: "shielding: wildcard preserve entry",
    input: (size) => repeatTo("<vendor-a x", size),
    run: (html) => [
      shieldElementContents(html, ["vendor-*"]),
      maskElementContents(html, ["*-a"]),
    ],
  },
  {
    site: "id-references: opening tags",
    input: (size) => `${repeatTo("<a x", size)} id="i"`,
    run: (html) => [
      collectDeclaredIds(html),
      rewriteIdReferencesInHtml(html, () => "z"),
    ],
  },
  ...[
    "<script data-bascik-server ",
    "<script type='text/bascik-server' ",
    "<script type=text/bascik-server ",
    '<script TYPE = " \t text/bascik-server',
    " type \t = \t ",
    "<script data-bascik-stream>",
  ].map((unit): HostileCase => ({
    site: `server-scripts and server-sidecar: ${JSON.stringify(unit)} (cubic)`,
    input: (size) => repeatTo(unit, size),
    run: (html) => [
      htmlHasServerScripts(html),
      sourceHasServerScripts(html),
      planServerScripts(html),
      extractServerScriptsToSidecar(html, "page", {}),
      extractComponentScriptsToSidecar(html, "cmp", {}, { record: false }),
    ],
  })),
  {
    site: "component-manifest: open tags, build and request scripts",
    input: (size) =>
      repeatTo("<script data-bascik-server data-bascik-build x", size),
    run: (html) => [
      __manifestScansForTests.inheritanceRootShifted(html, html),
      __manifestScansForTests.classifyBindings(`${html} data-bascik-attr-`),
      __manifestScansForTests.countInjectionMarkers(html),
      __manifestScansForTests.requestScriptElements(html),
      __manifestScansForTests.scriptBodyRanges(html),
    ],
  },
  ...[
    ["data-bascik-build"],
    ["data-bascik-build-once"],
    ["data-bascik-build", "data-bascik-build-once"],
  ].map((names): HostileCase => ({
    site: `page-transpile, processing, components: ${names.join(" or ")} script`,
    input: (size) => repeatTo("<script x", size),
    run: (html) => [
      scriptDirectiveFinder(names)(html),
      scriptDirectiveFinder(names, true)(html),
    ],
  })),
  {
    site: "styles: id class injection (cubic)",
    input: (size) => repeatTo("<a id=main ", size),
    run: (html) =>
      addIdClassesInHtml(html, [{ idName: "main", className: "k" }]),
  },
  {
    site: "styles: element class injection",
    input: (size) => repeatTo("<div x", size),
    run: (html) => addElementClassesInHtml(html, "cmp", ["div"]),
  },
  {
    site: "styles: style blocks",
    input: (size) => repeatTo("<style x", size),
    run: (html) => [extractInlineStyles(html), scopeInlineStyleTags(html, "c")],
  },
  {
    site: "components: companion script inlining (cubic)",
    input: (size) => repeatTo("<script src='a' ", size),
    run: (html) => __companionScriptTagsForTests(html, () => ""),
  },
  ...["<a x", "<meta x", "<script x", "<style x"].map((unit): HostileCase => ({
    site: `javascript: attribute scoping on ${JSON.stringify(unit)}`,
    input: (size) => `${repeatTo(unit, size)} id="i" name="n"`,
    run: (html) => [
      prefixElementAttribute(component(html), "id", "i1"),
      prefixElementAttribute(component(html), "name", "i1"),
      namespaceScriptTags(component(html)),
    ],
  })),
  {
    // Each `<b ` in script code is a tag candidate the code lookup must reject cheaply.
    site: "javascript: attribute scoping on script code comparisons",
    input: (size) =>
      `<div id="i"></div><script>${repeatTo("a<b && id = c; '<p id=\"i\">' ", size)}</script>`,
    run: (html) => prefixElementAttribute(component(html), "id", "i1"),
  },
  {
    site: "site-graph: placeholder script tags",
    input: (size) => repeatTo("<script '", size),
    run: (html) => splitDistPageIntoSegments(html),
  },
  {
    site: "check: build scripts and preserved subtrees (cubic)",
    input: (size) => repeatTo("<a data-bascik-preserve ", size),
    run: (html) => [
      __checkScansForTests.extractDirectiveScripts(html),
      __checkScansForTests.maskPreservedSubtrees(html),
    ],
  },
  ...["<title x", "<script x", "<style x"].map((unit): HostileCase => ({
    site: `csp-hashes: regex fallback on ${JSON.stringify(unit)}`,
    input: (size) => repeatTo(unit, size),
    run: (html) => [
      __cspRegexFallbackForTests(html),
      computePageCspHashes(html),
    ],
  })),
];

const expectLinear = ({ site, input, size = SIZE, run }: HostileCase): void => {
  expect(input(size).length).toBeGreaterThanOrEqual(size);
  // The helper's assertion: a failure names the site, both times and the
  // runs per sample, and whether the growth or the ceiling failed.
  expectLinearTime(input, size, run, { label: site });
};

describe("open-tag scans take linear time on hostile input", () => {
  it.each(requestTimeCases.map((c) => [c.site, c] as const))(
    "request time: %s",
    (_site, hostile) => expectLinear(hostile),
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each(buildTimeCases.map((c) => [c.site, c] as const))(
    "build time: %s",
    (_site, hostile) => expectLinear(hostile),
    LINEAR_TIME_TIMEOUT_MS,
  );
});
