/**
 * Tests for the portable expansion loop (prompt 157).
 *
 * `expandComponents` is `recursivelyTranspile`'s loop with its host-bound
 * calls turned into parameters so the same loop can render server and stream
 * script output at request time on hosts without `node:*`. The parity oracle
 * is `__fixtures__/component-expansion-core.golden.json`: the output of
 * `recursivelyTranspile` BEFORE the loop was extracted, recorded on the shared
 * fixtures in both identifier modes. Both entry points must reproduce it byte
 * for byte, so a regression inside the loop fails here even though the build
 * wrapper now runs that same loop. Regenerate the golden only from a build
 * known to be correct, never from the code under test.
 *
 * The request-time cases pin the parameters a manifest-backed host plugs in.
 * Injecting attr-bound props after scoping is byte-identical to injecting
 * them before it, except where scoping would have rewritten the injected
 * value: id references (`href="#x"`, `for`, `form`, `aria-*`, ...). Those are
 * restored per target attribute by `rewriteIdRefs` through `scopedIdNames`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  return {
    ...original,
    BascikConfig: {
      ...original.BascikConfig,
      minify: { ...original.BascikConfig.minify, identifiers: true },
      // Own copy: the real config is frozen, and the expansionLimits tests
      // set a limit for one test.
      components: { ...original.BascikConfig.components },
      scoping: {
        scriptBlocks: true,
        inheritAttributes: true,
        attributes: { class: true, id: true, name: true },
        preserve: ["code"],
        deduplicateCss: true,
      },
    },
    shouldLog: vi.fn(() => true),
  };
});

import { BascikConfig } from "./config.ts";
import {
  expandComponents,
  stripSourceFileComments,
  type ExpandOptions,
} from "./component-expansion-core.ts";
import {
  BUILD_EXPANSION_LIMITS,
  recursivelyTranspile,
} from "./component-expansion.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
} from "./linear-time.test-helper.ts";
import { deriveInstanceId } from "./names.ts";
import { PageProcessingError } from "./page-diagnostics.ts";
import { applyScopingResult } from "./scoping-instantiate.ts";
import * as scopingTemplate from "./scoping-template.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import type {
  BascikComponent,
  ComponentList,
  TranspileResult,
} from "./types.ts";
import {
  componentList,
  ID_REFS_PAGE,
  PAGE,
  PAGE_PATH,
  type Golden,
  type GoldenEntry,
} from "./__fixtures__/component-expansion-core.fixture.ts";

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "./__fixtures__/component-expansion-core.golden.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as Golden;

const freshState = () => ({
  ordinalMap: new Map<string, number>(),
  issuedIds: new Set<string>(),
});

/** The options the build wrapper passes (component-expansion.ts). */
const buildOptions = (
  filePath: string | undefined,
  instanceState: ReturnType<typeof freshState>,
  overrides: Partial<ExpandOptions> = {},
): ExpandOptions => ({
  scope: (component, instanceId) =>
    scopingTemplate.scopeComponentInstance(component, instanceId),
  mintId: (componentName, ordinal) =>
    deriveInstanceId(
      filePath || "page",
      componentName,
      ordinal,
      instanceState.issuedIds,
    ),
  injectAttrProps: "before-scope",
  numberSourceUrls: true,
  inheritAttributes: Boolean(BascikConfig.scoping?.inheritAttributes),
  instanceState,
  limits: BUILD_EXPANSION_LIMITS,
  // The build wrapper logs and strips the failed tag, then keeps going, so the
  // loop must continue after `onError` returns; a host that wants to abort the
  // render throws from here instead.
  onError: () => {},
  flatten: (value) => {
    if (value.length > 0) Buffer.byteLength(value);
    return value;
  },
  ...overrides,
});

/** Everything downstream reads from `usedComponents`, in order. */
const instanceSummary = (result: TranspileResult) =>
  result.usedComponents.map((component: BascikComponent) => [
    component.name,
    component.cssFileContent,
    component.requiresPerInstanceCss,
    JSON.stringify(component.scopedIdNames),
  ]);

/** The golden is JSON, where `undefined` fields became `null`. */
const asGoldenEntry = (result: TranspileResult): GoldenEntry =>
  JSON.parse(
    JSON.stringify({
      html: result.transpiledHtmlBody,
      instances: instanceSummary(result),
    }),
  ) as GoldenEntry;

const viaWrapper = (
  html: string,
  list: ComponentList,
  filePath?: string,
  instanceState = freshState(),
) => {
  clearScopingTemplates();
  return recursivelyTranspile(html, list, [], filePath, instanceState);
};

const viaCore = (
  html: string,
  list: ComponentList,
  filePath?: string,
  instanceState = freshState(),
  overrides: Partial<ExpandOptions> = {},
) => {
  clearScopingTemplates();
  return expandComponents(
    html,
    list,
    buildOptions(filePath, instanceState, overrides),
    [],
    filePath,
  );
};

/**
 * The request-time rewrite of D3/D4: a fragment `href` and the bare-id
 * reference attributes map through the instance's scoped id names; every
 * other target is plain text even when its value equals an id.
 */
const BARE_ID_TARGET =
  /^(?:for|form|list|popovertarget|commandfor|aria-[\w-]+|itemref|headers)$/i;
const requestRewriteIdRefs = (
  target: string,
  value: string,
  scopedIdNames: Record<string, string>,
): string => {
  if (/^(?:xlink:)?href$/i.test(target)) {
    return value.startsWith("#") && scopedIdNames[value.slice(1)]
      ? `#${scopedIdNames[value.slice(1)]}`
      : value;
  }
  if (BARE_ID_TARGET.test(target)) {
    return value
      .split(/(\s+)/)
      .map((part) => scopedIdNames[part] ?? part)
      .join("");
  }
  return value;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([true, false])(
  "matches the pre-extraction golden (identifiers %s)",
  (identifiers) => {
    const expected = golden[`identifiers:${identifiers}`];

    beforeEach(() => {
      (BascikConfig.minify as { identifiers: boolean }).identifiers =
        identifiers;
      clearScopingTemplates();
    });

    it("the golden exercises what it claims to", () => {
      const html = expected.page.html;
      expect(expected.page.instances.map(([name]) => name)).toEqual([
        "outer-box",
        "mid-box",
        "inner-box",
        "outer-box",
        "mid-box",
        "inner-box",
        "mid-box",
        "inner-box",
        "inner-box",
        "v-card",
        "glow-card",
        "glow-card",
        "mid-box",
        "inner-box",
        "inner-box",
        "inner-box",
      ]);
      // Injected prop, forwarded prop (attr-bound onto the nested usage tag),
      // default and named slot content, the forwarded default slot.
      expect(html).toMatch(
        /<h2 class="[^"]*">T &amp; &lt;b&gt; &quot;q&quot;<\/h2>/,
      );
      expect(html).toContain("<em>T &amp; &lt;b&gt; &quot;q&quot;</em>");
      expect(html).toContain("<span>from outer</span>");
      expect(html).toMatch(/<article class="[^"]*">Hello <i>slot<\/i>/);
      expect(html).toContain("outer head");
      expect(html).toMatch(/<\/a>F<\/section>/);
      expect(html).toMatch(/<article class="[^"]*">second</);
      // Inherited attributes, entity-escaped bound attribute.
      expect(html).toMatch(
        /^<section class="[^"]* user" id="[^"]+" aria-label="L">/,
      );
      expect(html).toContain('class="cta" href="/x?a=1&amp;b=2"');
      // The fragment href was scoped with the id it points at.
      const scopedX = JSON.parse(expected.page.instances[9][3]!).x as string;
      expect(html).toContain(`href="#${scopedX}"`);
      expect(html).toContain(`<label for="${scopedX}">L</label>`);
      // Masking: comment, textarea, script text, JSON-LD and escaped text.
      expect(html).toContain("<!-- <outer-box> in a comment -->");
      expect(html).toContain("<textarea><outer-box></outer-box></textarea>");
      expect(html).toContain(`<script>var s = "<v-card/>";</script>`);
      expect(html).toContain(`{"t":"<mid-box>"}`);
      expect(html).toContain("<pre><code>&lt;outer-box&gt;</code></pre>");
      // Per-instance CSS, second-instance sourceURL numbering, unclosed usage.
      expect(expected.page.instances[10][2]).toBe(true);
      expect(html).toContain(
        "//# sourceURL=src/components/inner-box.html?instance=2",
      );
      expect(html).toMatch(/<article class="[^"]*">inner fallback/);
      // No source-file markers survive.
      expect(html).not.toContain("bascik-source-file");
    });

    it("recursivelyTranspile reproduces the golden", () => {
      expect(
        asGoldenEntry(viaWrapper(PAGE, componentList(), PAGE_PATH)),
      ).toEqual(expected.page);
      expect(asGoldenEntry(viaWrapper(PAGE, componentList()))).toEqual(
        expected.noPath,
      );
      expect(
        asGoldenEntry(viaWrapper(ID_REFS_PAGE, componentList(), PAGE_PATH)),
      ).toEqual(expected.idRefs);
    });

    it("expandComponents with the build options reproduces the golden", () => {
      expect(asGoldenEntry(viaCore(PAGE, componentList(), PAGE_PATH))).toEqual(
        expected.page,
      );
      expect(asGoldenEntry(viaCore(PAGE, componentList()))).toEqual(
        expected.noPath,
      );
      expect(
        asGoldenEntry(viaCore(ID_REFS_PAGE, componentList(), PAGE_PATH)),
      ).toEqual(expected.idRefs);
    });

    it("threads instanceState across passes exactly like the wrapper", () => {
      // page-transpile.ts runs the loop more than once per page with one shared
      // state, so ordinals and issued ids must continue, not restart.
      const first = `<inner-box>one</inner-box><glow-card></glow-card>`;
      const second = `<inner-box>two</inner-box><glow-card></glow-card>`;
      const wrapperState = freshState();
      const coreState = freshState();
      const expectedPasses = [
        viaWrapper(first, componentList(), PAGE_PATH, wrapperState),
        viaWrapper(second, componentList(), PAGE_PATH, wrapperState),
      ];
      const actual = [
        viaCore(first, componentList(), PAGE_PATH, coreState),
        viaCore(second, componentList(), PAGE_PATH, coreState),
      ];
      expect(actual.map((r) => r.transpiledHtmlBody)).toEqual(
        expectedPasses.map((r) => r.transpiledHtmlBody),
      );
      expect(actual.map(instanceSummary)).toEqual(
        expectedPasses.map(instanceSummary),
      );
      expect([...coreState.issuedIds]).toEqual([...wrapperState.issuedIds]);
      expect([...coreState.ordinalMap]).toEqual([...wrapperState.ordinalMap]);
      // The second pass really did continue the sequence.
      expect(actual[1].transpiledHtmlBody).toContain("?instance=2");
    });

    it("leaves an unknown tag and a component without content alone, like the wrapper", () => {
      const list: ComponentList = {
        ...componentList(),
        "empty-box": {
          fileName: "src/components/empty-box.html",
          fileContent: "",
        },
      };
      const html = `<unknown-tag>x</unknown-tag><empty-box>gone</empty-box><inner-box>kept</inner-box>`;
      const viaW = viaWrapper(html, list, PAGE_PATH);
      const viaC = viaCore(html, list, PAGE_PATH);
      expect(viaC.transpiledHtmlBody).toBe(viaW.transpiledHtmlBody);
      expect(instanceSummary(viaC)).toEqual(instanceSummary(viaW));
      // A component without content ends the pass after its usage is
      // stripped; what follows it on the page is left for a later pass.
      expect(viaW.transpiledHtmlBody).toBe(
        "<unknown-tag>x</unknown-tag><inner-box>kept</inner-box>",
      );
    });

    it("reports a failed stage through onError, strips the tag and continues, like the wrapper logs and strips", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const boom = new Error("scope exploded");
      vi.spyOn(scopingTemplate, "scopeComponentInstance").mockImplementation(
        (component, instanceId) => {
          if (component.name === "v-card") throw boom;
          return scopingTemplate.runScopingPipeline(component, instanceId);
        },
      );
      const html = `<inner-box>before</inner-box><v-card data-bascik-prop-t="T"></v-card><inner-box>after</inner-box>`;
      const viaW = viaWrapper(html, componentList(), PAGE_PATH);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatch(
        /Transpilation failed for component <v-card> during attribute scoping/,
      );
      expect(viaW.transpiledHtmlBody).not.toContain("v-card");
      errorSpy.mockClear();

      const onError = vi.fn();
      const actual = viaCore(html, componentList(), PAGE_PATH, freshState(), {
        onError,
      });
      expect(actual.transpiledHtmlBody).toBe(viaW.transpiledHtmlBody);
      expect(instanceSummary(actual)).toEqual(instanceSummary(viaW));
      expect(onError).toHaveBeenCalledTimes(1);
      const [component, stage, error] = onError.mock.calls[0];
      expect(component.name).toBe("v-card");
      expect(stage).toBe("attribute scoping");
      expect(error).toBe(boom);
      // The core never writes to the console: that is the host's decision.
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("throws from the loop when a host throws from onError", () => {
      vi.spyOn(scopingTemplate, "scopeComponentInstance").mockImplementation(
        () => {
          throw new Error("scope exploded");
        },
      );
      expect(() =>
        viaCore(
          `<inner-box>x</inner-box>`,
          componentList(),
          PAGE_PATH,
          freshState(),
          {
            onError: (component, stage, error) => {
              throw new Error(
                `${component.name}/${stage}: ${(error as Error).message}`,
              );
            },
          },
        ),
      ).toThrow("inner-box/attribute scoping: scope exploded");
    });
  },
);

describe("stripSourceFileComments", () => {
  it("removes start and end markers, leaving everything else", () => {
    expect(
      stripSourceFileComments(
        "<!--bascik-source-file:src/pages/a.html--><p>a</p><!-- kept -->" +
          "<!--bascik-source-file-end:src/pages/a.html-->",
      ),
    ).toBe("<p>a</p><!-- kept -->");
  });

  it("leaves an unclosed marker as written", () => {
    expect(
      stripSourceFileComments(
        "<p>a</p><!--bascik-source-file:x--><!--bascik-source-file:y",
      ),
    ).toBe("<p>a</p><!--bascik-source-file:y");
  });

  it(
    "runs in linear time on many unclosed markers",
    () => {
      // Request-time expansion runs it on server-script output, which can
      // carry visitor text. `/<!--bascik-source-file:[\s\S]*?-->/g` rescanned
      // to the end from every opener: 40k openers took 4 s (CodeQL
      // js/polynomial-redos).
      for (const opener of [
        "<!--bascik-source-file:",
        "<!--bascik-source-file-end:",
      ]) {
        const html = (count: number) => `<p>a</p>${opener.repeat(count)}`;
        expect(stripSourceFileComments(html(40_000))).toBe(html(40_000));
        expectLinearTime(html, 40_000, stripSourceFileComments, {
          label: opener,
        });
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("expandComponents limits", () => {
  beforeEach(() => {
    (BascikConfig.minify as { identifiers: boolean }).identifiers = false;
  });

  it("the build wrapper exports the limits it passes", () => {
    expect(BUILD_EXPANSION_LIMITS).toEqual({
      maxSubstitutions: 10_000,
      maxOutputBytes: 50 * 1024 * 1024,
    });
  });

  it("stops at limits.maxSubstitutions with the wrapper's message, naming the next tag", () => {
    const html = Array.from(
      { length: 4 },
      () => `<inner-box></inner-box>`,
    ).join("");
    expect(() =>
      viaCore(html, componentList(), PAGE_PATH, freshState(), {
        limits: {
          maxSubstitutions: 3,
          maxOutputBytes: BUILD_EXPANSION_LIMITS.maxOutputBytes,
        },
      }),
    ).toThrow(
      /component expansion exceeded safety limits \(3 substitutions\)\. This usually means a component recursively includes itself \(e\.g\. <inner-box> contains its own tag/,
    );
  });

  it("stops at limits.maxOutputBytes", () => {
    // The limit is checked before each substitution against the whole page,
    // source-file markers included: with a page path the 46-byte input is
    // already 148 bytes, so 200 lets the first instance in (one `<article>`
    // template is well over 200 bytes more) and trips before the second.
    expect(() =>
      viaCore(
        `<inner-box></inner-box><inner-box></inner-box>`,
        componentList(),
        PAGE_PATH,
        freshState(),
        {
          limits: {
            maxSubstitutions: BUILD_EXPANSION_LIMITS.maxSubstitutions,
            maxOutputBytes: 200,
          },
        },
      ),
    ).toThrow(/exceeded safety limits \(1 substitutions\)/);
  });

  it("the wrapper reads components.expansionLimits and the error names the setting", () => {
    const components = BascikConfig.components as unknown as Record<
      string,
      unknown
    >;
    const previous = components.expansionLimits;
    components.expansionLimits = {
      maxInstances: 3,
      maxPageLength: BUILD_EXPANSION_LIMITS.maxOutputBytes,
    };
    try {
      let caught: unknown;
      try {
        viaWrapper(
          `<inner-box></inner-box>`.repeat(4),
          componentList(),
          PAGE_PATH,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PageProcessingError);
      expect((caught as Error).message).toMatch(/\(3 substitutions\)/);
      expect((caught as Error).message).toContain("components.expansionLimits");
    } finally {
      components.expansionLimits = previous;
    }
  });

  it("the wrapper reads components.expansionLimits.maxPageLength", () => {
    const components = BascikConfig.components as unknown as Record<
      string,
      unknown
    >;
    const previous = components.expansionLimits;
    components.expansionLimits = {
      maxInstances: BUILD_EXPANSION_LIMITS.maxSubstitutions,
      maxPageLength: 200,
    };
    try {
      expect(() =>
        viaWrapper(
          `<inner-box></inner-box><inner-box></inner-box>`,
          componentList(),
          PAGE_PATH,
        ),
      ).toThrow(PageProcessingError);
    } finally {
      components.expansionLimits = previous;
    }
  });

  it("the wrapper still raises a PageProcessingError for the page at the build limits", () => {
    const list: ComponentList = {
      "recursive-card": {
        fileName: "src/components/recursive-card.html",
        fileContent: `${"x".repeat(BUILD_EXPANSION_LIMITS.maxOutputBytes + 1)}<recursive-card></recursive-card>`,
      },
    };
    let caught: unknown;
    try {
      viaWrapper(`<recursive-card></recursive-card>`, list, PAGE_PATH);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PageProcessingError);
    expect((caught as PageProcessingError).stage).toBe("component expansion");
    expect((caught as PageProcessingError).pagePath).toBe(PAGE_PATH);
    expect((caught as Error).message).toMatch(
      /safety limits \(1 substitutions\).*<recursive-card>/,
    );
  });
});

describe.each([true, false])(
  "request-time parameters (identifiers %s)",
  (identifiers) => {
    const expected = golden[`identifiers:${identifiers}`];

    beforeEach(() => {
      (BascikConfig.minify as { identifiers: boolean }).identifiers =
        identifiers;
      clearScopingTemplates();
    });

    // Scoping rewrites attribute values only where they reference an id, so
    // for title, src, alt, data-* and a non-fragment href the injection order
    // cannot change a byte.
    it('injectAttrProps "after-scope" is byte-identical for non-fragment attr bindings', () => {
      const html =
        `<v-card data-bascik-prop-link="/pricing" data-bascik-prop-t="T" data-bascik-prop-dx="1" data-bascik-prop-img="/a.png" data-bascik-prop-alt="pic"></v-card>` +
        `<outer-box data-bascik-prop-title="fwd" data-bascik-prop-link="/x">s</outer-box>`;
      const viaW = viaWrapper(html, componentList(), PAGE_PATH);
      const actual = viaCore(html, componentList(), PAGE_PATH, freshState(), {
        injectAttrProps: "after-scope",
      });
      expect(viaW.transpiledHtmlBody).toContain('href="/pricing"');
      expect(actual.transpiledHtmlBody).toBe(viaW.transpiledHtmlBody);
      expect(instanceSummary(actual)).toEqual(instanceSummary(viaW));
    });

    it("a fragment href diverges after scoping and rewriteIdRefs restores it through scopedIdNames", () => {
      const html = `<v-card data-bascik-prop-link="#x" data-bascik-prop-t="T"></v-card>`;
      const viaW = viaWrapper(html, componentList(), PAGE_PATH);
      const scopedId = viaW.usedComponents[0].scopedIdNames?.x;
      expect(scopedId).toBeTruthy();
      expect(viaW.transpiledHtmlBody).toContain(`href="#${scopedId}"`);

      const divergent = viaCore(
        html,
        componentList(),
        PAGE_PATH,
        freshState(),
        {
          injectAttrProps: "after-scope",
        },
      );
      expect(divergent.transpiledHtmlBody).toContain('href="#x"');

      const rewriteIdRefs = vi.fn(requestRewriteIdRefs);
      const restored = viaCore(html, componentList(), PAGE_PATH, freshState(), {
        injectAttrProps: "after-scope",
        rewriteIdRefs,
      });
      expect(restored.transpiledHtmlBody).toBe(viaW.transpiledHtmlBody);
      expect(rewriteIdRefs).toHaveBeenCalledWith("href", "#x", { x: scopedId });
    });

    it("rewriteIdRefs sees the target attribute: one prop bound to `for` and `title` is rewritten for `for` only", () => {
      // The golden shows the build scoping `for`, `form`, `aria-describedby`
      // and the fragment `href`, and leaving `title="p"` and `/docs#hint`
      // alone. A rewriter keyed on the value alone could not tell `for="p"`
      // from `title="p"`, so the target name is part of the call.
      const rewriteIdRefs = vi.fn(requestRewriteIdRefs);
      const actual = viaCore(
        ID_REFS_PAGE,
        componentList(),
        PAGE_PATH,
        freshState(),
        { injectAttrProps: "after-scope", rewriteIdRefs },
      );
      expect(asGoldenEntry(actual)).toEqual(expected.idRefs);
      const scoped = JSON.parse(expected.idRefs.instances[0][3]!) as Record<
        string,
        string
      >;
      const firstInstanceCalls = rewriteIdRefs.mock.calls.slice(0, 5);
      expect(firstInstanceCalls).toEqual([
        ["for", "p", scoped],
        ["title", "p", scoped],
        ["form", "f", scoped],
        ["aria-describedby", "hint", scoped],
        ["href", "#hint", scoped],
      ]);
      expect(rewriteIdRefs).toHaveBeenCalledTimes(10);
    });

    it("numberSourceUrls false leaves every instance's sourceURL unnumbered", () => {
      // Request-time instances are not numbered (design D4): the manifest's
      // first-instance script hashes assume identical script text per instance.
      const html = `<inner-box>a</inner-box><inner-box>b</inner-box>`;
      const numbered = viaCore(html, componentList(), PAGE_PATH);
      expect(numbered.transpiledHtmlBody).toContain(
        "//# sourceURL=src/components/inner-box.html?instance=2",
      );
      const plain = viaCore(html, componentList(), PAGE_PATH, freshState(), {
        numberSourceUrls: false,
      });
      expect(plain.transpiledHtmlBody).not.toContain("?instance=");
      expect(
        plain.transpiledHtmlBody.match(
          /\/\/# sourceURL=src\/components\/inner-box\.html<\/script>/g,
        ),
      ).toHaveLength(2);
      // The only difference is the suffix.
      expect(numbered.transpiledHtmlBody.replace("?instance=2", "")).toBe(
        plain.transpiledHtmlBody,
      );
    });

    it("applies finalizeInstance to each filled instance (after inheritance) and never to author text", () => {
      const finalizeInstance = vi.fn(
        (html: string) => `<!--fi-->${html}<!--/fi-->`,
      );
      const html = `<p>author</p><outer-box class="user">s</outer-box><!-- <mid-box> --><inner-box>x</inner-box>`;
      const result = viaCore(html, componentList(), PAGE_PATH, freshState(), {
        finalizeInstance,
      });
      // outer-box, its nested mid-box and inner-box, plus the top-level inner-box.
      expect(result.usedComponents.map((c) => c.name)).toEqual([
        "outer-box",
        "mid-box",
        "inner-box",
        "inner-box",
      ]);
      expect(finalizeInstance).toHaveBeenCalledTimes(4);
      expect(result.transpiledHtmlBody.match(/<!--fi-->/g)).toHaveLength(4);
      expect(
        result.transpiledHtmlBody.startsWith("<p>author</p><!--fi--><section "),
      ).toBe(true);
      expect(result.transpiledHtmlBody).toContain("<!-- <mid-box> -->");
      // The instance handed to finalizeInstance already carries inherited attributes.
      expect(finalizeInstance.mock.calls[0][0]).toMatch(
        /^<section class="[^"]* user" id="[^"]+">/,
      );
    });

    it("mints ids through mintId with the page ordinal of each component", () => {
      const mintId = vi.fn(
        (name: string, ordinal: number) =>
          `r${ordinal}${name.length.toString(16).padStart(6, "0")}`,
      );
      const result = viaCore(
        `<inner-box>a</inner-box><inner-box>b</inner-box><glow-card></glow-card>`,
        componentList(),
        PAGE_PATH,
        freshState(),
        { mintId },
      );
      expect(mintId.mock.calls).toEqual([
        ["inner-box", 1],
        ["inner-box", 2],
        ["glow-card", 1],
      ]);
      // The minted id is what scoping saw.
      expect(result.usedComponents[2].scopedIdNames).toEqual(
        identifiers
          ? { glow: expect.stringMatching(/^b[0-9a-zA-Z]{11}$/) }
          : { glow: "bascik__glow-card__r1000009__glow" },
      );
    });

    it("returns the flattened body when a flattener is given and the plain body otherwise", () => {
      const flatten = vi.fn((value: string) => value);
      const html = `<inner-box>x</inner-box>`;
      const withFlatten = viaCore(
        html,
        componentList(),
        PAGE_PATH,
        freshState(),
        { flatten },
      );
      expect(flatten).toHaveBeenCalled();
      expect(flatten.mock.lastCall?.[0]).toBe(withFlatten.transpiledHtmlBody);
      const withoutFlatten = viaCore(
        html,
        componentList(),
        PAGE_PATH,
        freshState(),
        {
          flatten: undefined,
        },
      );
      expect(withoutFlatten.transpiledHtmlBody).toBe(
        withFlatten.transpiledHtmlBody,
      );
    });

    it("skips attribute inheritance when inheritAttributes is false", () => {
      const html = `<inner-box class="user" aria-label="L">x</inner-box>`;
      const inherited = viaCore(html, componentList(), PAGE_PATH);
      const plain = viaCore(html, componentList(), PAGE_PATH, freshState(), {
        inheritAttributes: false,
      });
      expect(inherited.transpiledHtmlBody).toMatch(
        /^<article class="[^"]* user" aria-label="L">/,
      );
      expect(plain.transpiledHtmlBody).toMatch(/^<article class="[^"]*">/);
      expect(plain.transpiledHtmlBody).not.toContain("aria-label");
    });

    it("leaves the tag unexpanded when scope returns null", () => {
      const html = `<inner-box>kept</inner-box><glow-card></glow-card>`;
      const result = viaCore(html, componentList(), PAGE_PATH, freshState(), {
        scope: (component, instanceId) =>
          component.name === "glow-card"
            ? null
            : scopingTemplate.scopeComponentInstance(component, instanceId),
      });
      expect(result.transpiledHtmlBody).toContain("<glow-card></glow-card>");
      // The inner-box template's own script logs the literal "<inner-box>",
      // so only the usage tag must be gone.
      expect(result.transpiledHtmlBody).not.toContain(
        "<inner-box>kept</inner-box>",
      );
      expect(result.transpiledHtmlBody).toMatch(/^<article class="[^"]*">kept/);
      expect(result.usedComponents.map((c) => c.name)).toEqual(["inner-box"]);
    });

    it("reads the usage fields from the object scope returns, so a fresh copy built from a ScopingResult works", () => {
      // A manifest-backed scope has only a ScopingResult (the template's
      // output), not the build's mutate-and-return object. Applying it onto a
      // spread copy of the usage keeps content, inner content and the splice
      // offsets, and the page comes out exactly as the build's.
      const inputs: BascikComponent[] = [];
      const returned: BascikComponent[] = [];
      const scope = (component: BascikComponent, instanceId: string) => {
        inputs.push(component);
        const real = scopingTemplate.runScopingPipeline(
          { ...component },
          instanceId,
        );
        const copy = applyScopingResult(
          { ...component },
          {
            fileContent: real.fileContent,
            cssFileContent: real.cssFileContent,
            scopedIdNames:
              real.scopedIdNames === undefined
                ? undefined
                : JSON.stringify(real.scopedIdNames),
            requiresPerInstanceCss: real.requiresPerInstanceCss,
          },
        );
        returned.push(copy);
        return copy;
      };
      const result = viaCore(PAGE, componentList(), PAGE_PATH, freshState(), {
        scope,
      });
      expect(asGoldenEntry(result)).toEqual(expected.page);
      expect(returned.length).toBe(expected.page.instances.length);
      for (let index = 0; index < returned.length; index++) {
        expect(returned[index]).not.toBe(inputs[index]);
      }
      expect(result.usedComponents).toEqual(returned);
    });

    it("routes per-instance warnings through `warn` and defaults to console.warn", () => {
      const list: ComponentList = {
        "noisy-card": {
          fileName: "src/components/noisy-card.html",
          fileContent: `<div data-bascik-preserve="bogus" title="old" data-bascik-attr-title="u" data-bascik-attr-id><span data-bascik-prop-t>fallback</span></div>`,
        },
      };
      // A prop value with an unescaped delimiting quote, a conflicting
      // binding, a directive without a target and an unknown preserve token.
      const html = `<noisy-card data-bascik-prop-t="say "hello"" data-bascik-prop-u="new"></noisy-card>`;
      // Scoping would strip the preserve directive itself (and warn from the
      // scoping run); an identity scope leaves it to the loop.
      const identityScope = (component: BascikComponent) => component;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const warn = vi.fn();
      const hooked = viaCore(html, list, PAGE_PATH, freshState(), {
        scope: identityScope,
        warn,
      });
      expect(warnSpy).not.toHaveBeenCalled();
      const messages = warn.mock.calls.map(([message]) => message as string);
      expect(messages).toEqual([
        expect.stringMatching(/Ignoring malformed data-bascik-prop-t/),
        expect.stringMatching(/Attribute binding conflict: attribute "title"/),
        expect.stringMatching(/Ignoring malformed data-bascik-attr-id/),
        expect.stringMatching(
          /data-bascik-preserve ignores unknown token "bogus"/,
        ),
      ]);
      expect(hooked.transpiledHtmlBody).toBe(
        `<div title="new"><span>fallback</span></div>`,
      );

      const defaulted = viaCore(html, list, PAGE_PATH, freshState(), {
        scope: identityScope,
      });
      expect(defaulted.transpiledHtmlBody).toBe(hooked.transpiledHtmlBody);
      expect(warnSpy.mock.calls.map(([message]) => message)).toEqual(messages);
    });
  },
);

// `security.blockScriptUrls` / `security.blockCodeBindings` at build time
// (Collin 2026-10-29): recursivelyTranspile reads them from the config and
// passes them to the loop as `bindings`; the loop takes the same option.
describe("binding toggles at build time", () => {
  const list = (): ComponentList => ({
    "link-box": {
      fileName: "src/components/link-box.html",
      fileContent: `<a class="l" data-bascik-attr-href="u" data-bascik-attr-onclick="c">go</a>`,
    },
  });
  const USAGE = `<link-box data-bascik-prop-u="javascript:x" data-bascik-prop-c="go()"></link-box>`;
  const security = () => BascikConfig as unknown as { security?: unknown };

  beforeEach(() => {
    (BascikConfig.minify as { identifiers: boolean }).identifiers = false;
  });
  afterEach(() => {
    delete security().security;
  });

  it("default: the href is blocked and onclick is not bound", () => {
    const html = viaWrapper(USAGE, list(), PAGE_PATH).transpiledHtmlBody;
    expect(html).toContain(`href="about:invalid"`);
    expect(html).not.toContain("onclick");
  });

  it("security.blockScriptUrls: false in the config binds the href as written", () => {
    security().security = { blockScriptUrls: false, blockCodeBindings: true };
    const html = viaWrapper(USAGE, list(), PAGE_PATH).transpiledHtmlBody;
    expect(html).toContain(`href="javascript:x"`);
    expect(html).not.toContain("onclick");
  });

  it("security.blockCodeBindings: false in the config binds onclick", () => {
    security().security = { blockScriptUrls: true, blockCodeBindings: false };
    const html = viaWrapper(USAGE, list(), PAGE_PATH).transpiledHtmlBody;
    expect(html).toContain(`onclick="go()"`);
    expect(html).toContain(`href="about:invalid"`);
  });

  it("expandComponents takes a bindings option", () => {
    clearScopingTemplates();
    const html = viaCore(USAGE, list(), PAGE_PATH, freshState(), {
      bindings: { blockScriptUrls: false, blockCodeBindings: false },
    } as Partial<ExpandOptions>).transpiledHtmlBody;
    expect(html).toContain(`href="javascript:x"`);
    expect(html).toContain(`onclick="go()"`);
  });
});
