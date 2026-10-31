/**
 * An invariant oracle for the expansion loop's incremental mask (round 2 of
 * the October 2026 review, R2-07-a).
 *
 * `expandComponents` keeps the page's mask current across splices without
 * re-masking the page (`spliceRawTextMask`), moves the last-close facts with
 * each splice (`CloseFacts`, `MaskFacts`), and resumes each search at a
 * cursor with a saved attribute-scan checkpoint. Every one of those is only
 * correct if it equals what a whole re-read would find. The probe
 * (`__expansionProbeForTests`) hands this test the loop's state after every
 * splice and every search, and the test compares it with:
 *
 * - `maskRawTextContent` of the page as it stands (the full mask);
 * - the last close of each component name and the last raw-text closer and
 *   comment end of each kind in that page, which the facts must bound;
 * - `getFirstComponent` on the full mask from the start of the page, which
 *   the cursor search must agree with.
 *
 * The pages come from a grammar of nested components, named and default
 * slots, raw-text elements, comments, CDATA in SVG and MathML, attribute
 * values holding `>` and quotes, Prettier-style multi-line tags, self-closing
 * and unclosed usages, empty components and unclosed elements. Any
 * difference is a defect; a shrunk counterexample is pinned below as a fixed
 * input.
 */
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { propertyBounds } from "./property-runs.test-helper.ts";
import { expandComponents } from "./component-expansion-core.ts";
import { maskRawTextContent } from "./component-masking.ts";
import {
  __expansionProbeForTests,
  type ExpansionSearchProbe,
  type ExpansionSpliceProbe,
} from "./component-scan-stats.ts";
import { getFirstComponent } from "./component-tags.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

const componentList = (): ComponentList => ({
  "x-box": {
    fileName: "src/components/x-box.html",
    fileContent: `<div class="box"><div data-bascik-slot>box fallback</div></div>`,
  },
  "x-named": {
    fileName: "src/components/x-named.html",
    fileContent:
      `<section\n  class="named"\n  title="a > b"\n>` +
      `<h2 data-bascik-slot="title">no title</h2>` +
      `<div data-bascik-slot></div></section>`,
  },
  "x-raw": {
    fileName: "src/components/x-raw.html",
    fileContent:
      `<script>if (a < b) console.log("</x-box> <x-box>", '</script', "<!--");</script>` +
      `<style>.a > b::after { content: "</x-named>" }</style>` +
      `<textarea><x-box></x-box></textarea><title><x-box></title>`,
  },
  "x-note": {
    fileName: "src/components/x-note.html",
    fileContent: `<!-- usage: <x-box></x-box> --><p data-x='"q" > r'>note</p>`,
  },
  "x-empty": { fileName: "src/components/x-empty.html", fileContent: "" },
  "x-svg": {
    fileName: "src/components/x-svg.html",
    fileContent:
      `<svg><![CDATA[ <x-box></x-box> ]]><title>t</title></svg>` +
      `<math><mi><![CDATA[x]]></mi></math>`,
  },
  "x-nest": {
    fileName: "src/components/x-nest.html",
    fileContent:
      `<div class="nest"><x-box>in <x-named><b data-bascik-slot="title">T</b></x-named></x-box>` +
      `<div data-bascik-slot></div></div>`,
  },
  "x-self": {
    fileName: "src/components/x-self.html",
    fileContent: `<span class="self"><x-empty /></span><x-note/>`,
  },
  // Templates that leave something open, which the splice must fall back on.
  "x-leak-script": {
    fileName: "src/components/x-leak-script.html",
    fileContent: `<p>a</p><script>var open = "`,
  },
  "x-leak-comment": {
    fileName: "src/components/x-leak-comment.html",
    fileContent: `<p>b</p><!-- open`,
  },
  "x-closer": {
    fileName: "src/components/x-closer.html",
    fileContent: `<p>c</p></script></style>--></textarea>`,
  },
  "x-partial": {
    fileName: "src/components/x-partial.html",
    fileContent: `<p>d</p><scr`,
  },
  "x-attr": {
    fileName: "src/components/x-attr.html",
    fileContent: `<p title="</x-box> <!-- '">e</p><input value='<script>'>`,
  },
  // Templates ending in the start of a close, which the text after the
  // usage completes (`ox>`, `ipt>`, white space then `>`).
  "x-cut-close": {
    fileName: "src/components/x-cut-close.html",
    fileContent: `<p>f</p></x-b`,
  },
  "x-cut-script": {
    fileName: "src/components/x-cut-script.html",
    fileContent: `<p>g</p></script`,
  },
  // A name that starts with another's.
  "x-box-list": {
    fileName: "src/components/x-box-list.html",
    fileContent: `<ul><li data-bascik-slot></li></ul></x-box >`,
  },
  // Scoping fails for this one (the loop strips it, re-masking the page),
  // and declines this one (the loop leaves it and moves its cursor past it).
  "x-throw": {
    fileName: "src/components/x-throw.html",
    fileContent: `<p>never</p>`,
  },
  "x-skip": {
    fileName: "src/components/x-skip.html",
    fileContent: `<p>never</p>`,
  },
});

const NAMES = Object.keys(componentList());

const text = fc.constantFrom(
  "text",
  " ",
  "\n",
  "a > b",
  "é",
  '"',
  "'",
  ">",
  "<",
  "ipt>",
  "-->",
  "--!>",
  "</script>",
  "</script foo>",
  "</style/>",
  "</textarea >",
  "</x-box>",
  "</x-named >",
  "<!x",
  "</ ",
  "<p<style>",
  // Text that leaves a tag open, so what follows is inside it.
  "<p ",
  '<p title="',
  "<p title='",
  "<p title=",
  "<!",
  "</",
  "<?",
  "<<",
  "<!-",
  "<scr",
  "<sty",
  "<texta",
  "ox>",
  "ipt >",
  "\n\t>",
  " ".repeat(5000),
  " ".repeat(5000) + ">",
  "</x-box" + " ".repeat(4200) + ">",
);

/** An opening tag for `name`: plain, multi-line, quoted `>`, or uppercase. */
const openTag = (name: string): fc.Arbitrary<string> =>
  fc.constantFrom(
    `<${name}>`,
    `<${name.toUpperCase()}>`,
    `<${name}\n  data-bascik-prop-label="a > b"\n  class='c "d"'\n>`,
    `<${name} title="</${name}>">`,
    `<${name} data-x='<!--'>`,
  );

const usageName = fc.constantFrom(...NAMES);

const { node } = fc.letrec<{ node: string; nodes: string }>((tie) => ({
  nodes: fc.array(tie("node"), { maxLength: 4 }).map((parts) => parts.join("")),
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { arbitrary: text, weight: 6 },
    {
      arbitrary: tie("nodes").map((inner) => `<!--${inner}-->`),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom(
            "<script>",
            '<script type="module" data-a="x>y">',
            "<style>",
            "<textarea>",
            "<title>",
          ),
          tie("nodes"),
          fc.constantFrom("", '"</script"', "'</style'", "<!--", "-->"),
        )
        .map(([open, inner, extra]) => {
          const name = /^<(\w+)/.exec(open)![1];
          return `${open}${inner}${extra}</${name}>`;
        }),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom("svg", "math"), tie("nodes"))
        .map(
          ([root, inner]) =>
            `<${root}><![CDATA[${inner}]]><title>${inner}</title></${root}>`,
        ),
      weight: 1,
    },
    {
      arbitrary: tie("nodes").map(
        (inner) => `<div\n  class="d"\n  title='x > "y"'\n>${inner}</div>`,
      ),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom("title", "head", "side"),
          fc.constantFrom("div", "b", "p"),
          tie("nodes"),
        )
        .map(
          ([slot, tag, inner]) =>
            `<${tag} data-bascik-slot="${slot}">${inner}</${tag}>`,
        ),
      weight: 1,
    },
    {
      arbitrary: fc
        .tuple(usageName, tie("nodes"))
        .chain(([name, inner]) =>
          fc
            .tuple(openTag(name), fc.boolean())
            .map(
              ([open, upperClose]) =>
                `${open}${inner}</${upperClose ? name.toUpperCase() : name}>`,
            ),
        ),
      weight: 5,
    },
    {
      arbitrary: usageName.chain((name) =>
        fc.constantFrom(`<${name} />`, `<${name}/>`, `<${name}\n/>`),
      ),
      weight: 2,
    },
    // Unclosed: a usage, an element, a raw-text opener, a comment.
    {
      arbitrary: fc.oneof(
        usageName.map((name) => `<${name}>`),
        fc.constantFrom(
          "<p>",
          "<script>",
          "<style>",
          "<textarea>",
          "<!--",
          "<scr",
        ),
      ),
      weight: 1,
    },
  ),
}));

const pageArb = fc.array(node, { maxLength: 6 }).map((parts) => parts.join(""));

/** Where the last `</name` before tag whitespace, `/` or `>` starts, any case. */
const lastCloseIn = (masked: string, name: string): number => {
  const pattern = new RegExp(
    `</${name.replace(/[\\^$.*+?()[\]{}|-]/g, (char) => `\\${char}`)}(?=[\\t\\n\\f\\r />])`,
    "gi",
  );
  let last = -1;
  for (let match = pattern.exec(masked); match; match = pattern.exec(masked))
    last = match.index;
  return last;
};

/** `lastClosers` in component-masking.ts, written out independently. */
const lastCloserTokens = (html: string): Record<string, number> => {
  const last: Record<string, number> = {
    script: -1,
    style: -1,
    textarea: -1,
    comment: -1,
  };
  const pattern = /<\/(script|style|textarea)(?=[\t\n\f\r />])|--!?>/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const kind = match[1]?.toLowerCase() ?? "comment";
    last[kind] = Math.max(last[kind], match.index);
    pattern.lastIndex = match.index + 1;
  }
  return last;
};

/** Splices the oracle checked, by path, so a run can show it read both. */
const splicesSeen = { incremental: 0, whole: 0, closeFacts: 0, closerFacts: 0 };

interface Violation {
  kind: string;
  html: string;
  detail: string;
}

/**
 * Expand `page` with the probe set, and return the first broken invariant
 * (or null). Scoping is the identity: the oracle is about the mask, the
 * facts and the search, which do not depend on how an instance is scoped.
 */
const expandUnderOracle = (
  page: string,
  list: ComponentList = componentList(),
): Violation | null => {
  let violation: Violation | null = null;
  // Each declined usage's [start, end) when the loop declined it.
  const declined: Array<[number, number]> = [];
  const fail = (kind: string, html: string, detail: string): void => {
    violation ??= { kind, html, detail };
  };
  __expansionProbeForTests.afterSplice = (probe: ExpansionSpliceProbe) => {
    splicesSeen[probe.incremental ? "incremental" : "whole"]++;
    if (probe.lastCloseAt) splicesSeen.closeFacts++;
    if (probe.closerFacts) splicesSeen.closerFacts++;
    const full = maskRawTextContent(probe.html);
    if (probe.masked !== full) {
      let at = 0;
      while (probe.masked[at] === full[at]) at++;
      fail("mask", probe.html, `masks differ from ${at}`);
      return;
    }
    if (probe.lastCloseAt) {
      for (const name of NAMES) {
        const actual = lastCloseIn(full, name);
        const bound = probe.lastCloseAt(name);
        if (bound < actual)
          fail("close facts", probe.html, `${name}: ${bound} < ${actual}`);
      }
    }
    if (probe.closerFacts) {
      const actual = lastCloserTokens(probe.html);
      for (const kind of Object.keys(actual))
        if ((probe.closerFacts[kind] ?? -1) < actual[kind])
          fail(
            "closer facts",
            probe.html,
            `${kind}: ${probe.closerFacts[kind]} < ${actual[kind]}`,
          );
    }
  };
  __expansionProbeForTests.afterSearch = (probe: ExpansionSearchProbe) => {
    const full = maskRawTextContent(probe.html);
    if (probe.masked !== full) {
      fail("mask before search", probe.html, "masks differ");
      return;
    }
    type Found = {
      name?: string;
      startIndex?: number;
      endIndex?: number;
      closeIndex?: number;
    };
    // From the start of the page, past the declined usages before the
    // cursor, as they were when the loop declined them: a later template's
    // stray closer can end a raw-text element opened inside one, which
    // changes where it ends, but not that the loop left all of it alone.
    // Splices are at or after the cursor, so their offsets still hold.
    let reference: Found;
    for (let from = 0; ;) {
      reference = getFirstComponent(probe.html, list, full, from) as Found;
      const at = reference.startIndex;
      const span =
        typeof at === "number" && at < probe.searchFrom
          ? declined.find(([start, end]) => start <= at && at < end)
          : undefined;
      if (!span) break;
      from = span[1];
    }
    const found = probe.found as Found;
    if (found.name === "x-skip" && typeof found.endIndex === "number")
      declined.push([found.startIndex!, found.endIndex]);
    const shape = (result: Found) =>
      `${result.name}@${result.startIndex}-${result.endIndex}/${result.closeIndex}`;
    if (shape(found) !== shape(reference))
      fail(
        "search",
        probe.html,
        `cursor ${probe.searchFrom}: ${shape(found)} vs ${shape(reference)}`,
      );
  };
  try {
    expandComponents(
      page,
      list,
      {
        scope: (component: BascikComponent) => {
          if (component.name === "x-throw") throw new Error("scoping failed");
          return component.name === "x-skip" ? null : component;
        },
        mintId: (name, ordinal) => `${name}-${ordinal}`,
        injectAttrProps: "before-scope",
        numberSourceUrls: false,
        inheritAttributes: true,
        instanceState: { ordinalMap: new Map(), issuedIds: new Set() },
        limits: { maxSubstitutions: 400, maxOutputBytes: 1_000_000 },
        onError: () => {},
        warn: () => {},
      },
      [],
      "src/pages/oracle.html",
    );
  } catch (error) {
    // The limits are only a tripwire for the generator; the oracle has run
    // on every splice before it.
    if ((error as Error).name !== "ComponentExpansionLimitError") throw error;
  }
  return violation;
};

afterEach(() => {
  delete __expansionProbeForTests.afterSplice;
  delete __expansionProbeForTests.afterSearch;
});

describe("expandComponents incremental mask oracle", () => {
  it("the probe sees every splice and every search", () => {
    let splices = 0;
    let searches = 0;
    __expansionProbeForTests.afterSplice = () => void splices++;
    __expansionProbeForTests.afterSearch = () => void searches++;
    expandComponents(
      "<x-box>a</x-box><x-empty></x-empty><x-nest>b</x-nest>",
      componentList(),
      {
        scope: (component) => component,
        mintId: (name, ordinal) => `${name}-${ordinal}`,
        injectAttrProps: "before-scope",
        numberSourceUrls: false,
        inheritAttributes: true,
        instanceState: { ordinalMap: new Map(), issuedIds: new Set() },
        limits: { maxSubstitutions: 100, maxOutputBytes: 100_000 },
        onError: () => {},
      },
    );
    // x-box, x-empty, x-nest, and x-nest's x-box and x-named.
    expect(splices).toBe(5);
    // One search per splice, and the last one that finds nothing.
    expect(searches).toBe(6);
  });

  const ORACLE_BOUNDS = propertyBounds(100, "MASK_ORACLE_RUNS");
  it(
    "keeps the mask, the close facts and the search equal to a whole re-read after every splice",
    () => {
      fc.assert(
        fc.property(pageArb, (page) => {
          const violation = expandUnderOracle(page);
          expect(violation, JSON.stringify(violation)).toBeNull();
        }),
        ORACLE_BOUNDS.options,
      );
      // The grammar reaches both paths and both kinds of facts, so the oracle
      // is not vacuous.
      const total = splicesSeen.incremental + splicesSeen.whole;
      expect(splicesSeen.incremental / total).toBeGreaterThan(0.3);
      expect(splicesSeen.whole).toBeGreaterThan(0);
      expect(splicesSeen.closeFacts).toBeGreaterThan(0);
      expect(splicesSeen.closerFacts).toBeGreaterThan(0);
    },
    ORACLE_BOUNDS.timeoutMs,
  );

  it("misuse: a page of only unclosed openers and stray closers expands without breaking an invariant", () => {
    for (const page of [
      "<x-box><x-box><x-named><script>",
      "</x-box></x-box><x-box>",
      "<!--<x-box>",
      "<x-leak-comment></x-leak-comment><x-box>after</x-box>",
      "<x-leak-script></x-leak-script><x-box>after</x-box></script><x-box>x</x-box>",
      "<x-partial></x-partial>ipt><x-box>y</x-box></script>",
      "<script><x-closer></x-closer></script><x-box>z</x-box>",
      "<X-BOX\n  title='</x-box>'\n>q</X-BOX >",
    ]) {
      expect(expandUnderOracle(page), page).toBeNull();
    }
  });
});

describe("a failed instance after a declined one (oracle counterexample)", () => {
  const optionsFor = (minted: string[]) => ({
    scope: (component: BascikComponent) => {
      if (component.name === "x-throw") throw new Error("scoping failed");
      return component.name === "x-skip" ? null : component;
    },
    mintId: (name: string, ordinal: number) => {
      minted.push(`${name}-${ordinal}`);
      return `${name}-${ordinal}`;
    },
    injectAttrProps: "before-scope" as const,
    numberSourceUrls: false,
    inheritAttributes: true,
    instanceState: { ordinalMap: new Map(), issuedIds: new Set<string>() },
    limits: { maxSubstitutions: 100, maxOutputBytes: 100_000 },
    onError: () => {},
    warn: () => {},
  });

  it("strips the instance that failed, not a same-name usage inside the declined one", () => {
    // Shrunk by fast-check from the oracle property above.
    const page = "<x-skip><x-throw></x-throw></x-skip><x-throw />";
    expect(expandUnderOracle(page)).toBeNull();
    const result = expandComponents(page, componentList(), optionsFor([]));
    // A declined usage stays as written, inside and out.
    expect(result.transpiledHtmlBody).toBe(
      "<x-skip><x-throw></x-throw></x-skip>",
    );
  });

  it("does not search the declined usage again, so it mints one id per usage", () => {
    const minted: string[] = [];
    const result = expandComponents(
      "<x-skip>s</x-skip><x-throw>t</x-throw><x-box>b</x-box>",
      componentList(),
      optionsFor(minted),
    );
    expect(minted).toEqual(["x-skip-1", "x-throw-1", "x-box-1"]);
    expect(result.transpiledHtmlBody).toBe(
      `<x-skip>s</x-skip><div class="box">b</div>`,
    );
  });

  it("misuse: a failing usage cut by a quote inside a declined one is still left alone", () => {
    const page = `<x-skip><x-throw title="</x-throw>"></x-throw></x-skip><x-throw />`;
    expect(expandUnderOracle(page)).toBeNull();
    expect(
      expandComponents(page, componentList(), optionsFor([]))
        .transpiledHtmlBody,
    ).toBe(`<x-skip><x-throw title="</x-throw>"></x-throw></x-skip>`);
  });
});
