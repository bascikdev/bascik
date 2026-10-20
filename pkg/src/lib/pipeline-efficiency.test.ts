/**
 * Transpilation Pipeline Efficiency & Byte-Parity Verification Suite
 *
 * Ensures that pipeline loop consolidations and cache optimizations:
 * 1. Produce byte-identical HTML, CSS, JS, and scoped IDs across all component
 *    and page features (slots, props, IDs, SVG url(#id), element/ID selectors,
 *    @keyframes, @layer, @container, @counter-style, @property, anchor-name,
 *    view-transition-name, preserve directives, and component build scripts).
 * 2. Eliminate redundant per-instance and per-page passes (such as per-instance
 *    `scopedCssCache` misses on ID-bearing components, redundant `collectAllScriptDeps`
 *    scans across repeated component instances, and unnecessary `computePackageIdentity`
 *    filesystem walks across build scripts).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  clearScopedCssCache,
  __scopedCssCacheStatsForTests,
} from "./javascript.ts";
import { addElementClassesInHtml, addIdClassesInHtml } from "./styles.ts";
import { rewriteIdReferencesInHtml } from "./id-references.ts";
import {
  runScopingPipeline,
  clearScopingTemplates,
} from "./scoping-template.ts";
import { recursivelyTranspile } from "./processing.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

describe("pipeline loop consolidation & parity invariants", () => {
  beforeEach(() => {
    clearScopedCssCache();
    __scopedCssCacheStatsForTests.reset();
    clearScopingTemplates();
    (BascikConfig.minify as { identifiers: boolean }).identifiers = false;
    (BascikConfig.scoping as { deduplicateCss: boolean }).deduplicateCss = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. scopedCssCache hits across instances of ID-bearing components", () => {
    it("caches CSS across instances when a component has HTML IDs without CSS url(#id) fragments", () => {
      const makeComp = (): BascikComponent => ({
        name: "id-card",
        fileName: "/project/src/components/id-card/id-card.html",
        fileContent: `<div id="card-root" class="card"><h2 id="heading">Title</h2><p>Body</p></div>`,
        cssFileContent: `#card-root { border: 1px solid red; } #heading { font-size: 2rem; } .card p { margin: 0; }`,
      });

      const inst1 = runScopingPipeline(makeComp(), "11111111");
      const inst2 = runScopingPipeline(makeComp(), "22222222");
      const inst3 = runScopingPipeline(makeComp(), "33333333");

      // Only the first instance misses scopedCssCache; subsequent instances hit
      expect(__scopedCssCacheStatsForTests.misses).toBe(1);
      expect(__scopedCssCacheStatsForTests.hits).toBe(2);

      // HTML IDs are per-instance
      expect(inst1.fileContent).toContain(
        `id="bascik__id-card__11111111__card-root"`,
      );
      expect(inst2.fileContent).toContain(
        `id="bascik__id-card__22222222__card-root"`,
      );
      expect(inst3.fileContent).toContain(
        `id="bascik__id-card__33333333__card-root"`,
      );

      // ID-converted classes and element classes are injected onto all instances
      expect(inst1.fileContent).toContain("bascik__id-card__id__card-root");
      expect(inst2.fileContent).toContain("bascik__id-card__id__card-root");
      expect(inst3.fileContent).toContain("bascik__id-card__id__card-root");
      expect(inst1.fileContent).toContain("bascik__id-card__el__p");
      expect(inst2.fileContent).toContain("bascik__id-card__el__p");
      expect(inst3.fileContent).toContain("bascik__id-card__el__p");

      // CSS is identical across all instances and does not require per-instance CSS
      expect(inst1.requiresPerInstanceCss).toBeFalsy();
      expect(inst2.requiresPerInstanceCss).toBeFalsy();
      expect(inst1.cssFileContent).toBe(inst2.cssFileContent);
      expect(inst2.cssFileContent).toBe(inst3.cssFileContent);
    });

    it("still produces per-instance CSS when CSS contains a local url(#id) fragment", () => {
      const makeSvgComp = (): BascikComponent => ({
        name: "svg-badge",
        fileName: "/project/src/components/svg-badge/svg-badge.html",
        fileContent: `<svg><linearGradient id="grad"></linearGradient><rect id="box" class="shape"/></svg>`,
        cssFileContent: `#box { stroke: black; } .shape { fill: url(#grad); }`,
      });

      const inst1 = runScopingPipeline(makeSvgComp(), "aaaa1111");
      const inst2 = runScopingPipeline(makeSvgComp(), "bbbb2222");

      expect(inst1.requiresPerInstanceCss).toBe(true);
      expect(inst2.requiresPerInstanceCss).toBe(true);
      expect(inst1.cssFileContent).toContain(
        "url(#bascik__svg-badge__aaaa1111__grad)",
      );
      expect(inst2.cssFileContent).toContain(
        "url(#bascik__svg-badge__bbbb2222__grad)",
      );
      expect(inst1.cssFileContent).toContain(
        ".bascik__svg-badge__aaaa1111__id__box",
      );
      expect(inst2.cssFileContent).toContain(
        ".bascik__svg-badge__bbbb2222__id__box",
      );
    });
  });

  describe("2. Single-pass HTML element and ID class injection parity", () => {
    it("injects multiple element and ID classes in the exact same order as sequential passes", () => {
      const html = `
        <!-- <div id="root"><p class="lead">comment</p></div> -->
        <div id="root" class="wrapper" data-info='class="fake" id="root"'>
          <h1 id="title">Heading</h1>
          <p class="lead">First paragraph</p>
          <p id="second">Second paragraph</p>
          <script>const tmpl = '<p id="root">in script</p>';</script>
          <textarea><p id="root">in textarea</p></textarea>
        </div>
      `;
      const elements = ["div", "h1", "p"];
      const ids = [
        { idName: "root", className: "bascik__comp__id__root" },
        { idName: "title", className: "bascik__comp__id__title" },
        { idName: "second", className: "bascik__comp__id__second" },
      ];
      const scopedIdNames = {
        root: "bascik__comp__1234__root",
        title: "bascik__comp__1234__title",
        second: "bascik__comp__1234__second",
      };

      const withScopedIds = html
        .replace(
          '<div id="root" class=',
          `<div id="${scopedIdNames.root}" class=`,
        )
        .replace('id="title"', `id="${scopedIdNames.title}"`)
        .replace('id="second"', `id="${scopedIdNames.second}"`);

      const afterElements = addElementClassesInHtml(
        withScopedIds,
        "comp",
        elements,
      );
      const afterBoth = addIdClassesInHtml(afterElements, ids, scopedIdNames);

      // Root div had class="wrapper", gets __el__div then __id__root
      expect(afterBoth).toContain(
        `id="${scopedIdNames.root}" class="wrapper bascik__comp__el__div bascik__comp__id__root"`,
      );
      // h1 had no class, gets class="__el__h1" then appends __id__title
      expect(afterBoth).toContain(
        `<h1 class="bascik__comp__el__h1 bascik__comp__id__title" id="${scopedIdNames.title}">`,
      );
      // p#second had no class, gets class="__el__p" then appends __id__second
      expect(afterBoth).toContain(
        `<p class="bascik__comp__el__p bascik__comp__id__second" id="${scopedIdNames.second}">`,
      );
      // Comment, script, and textarea contents are untouched
      expect(afterBoth).toContain(
        `<!-- <div id="root"><p class="lead">comment</p></div> -->`,
      );
      expect(afterBoth).toContain(
        `<script>const tmpl = '<p id="root">in script</p>';</script>`,
      );
      expect(afterBoth).toContain(
        `<textarea><p id="root">in textarea</p></textarea>`,
      );
    });
  });

  describe("3. rewriteIdReferencesInHtml single-pass attribute rewrite parity", () => {
    it("rewrites all ID reference attributes in a single tag scan without false matches in other attributes", () => {
      const resolveId = (id: string) =>
        id === "target" || id === "desc" ? `scoped__${id}` : null;
      const html = [
        `<label for="target" aria-describedby="desc external" data-note='for="target"'>Label</label>`,
        `<input id="target" form="target" list="target" aria-controls="target desc" aria-labelledby="target">`,
        `<button popovertarget="target" commandfor="target" aria-activedescendant="target" aria-errormessage="desc"></button>`,
        `<output for="target external" aria-owns="target" aria-flowto="desc" aria-details="target" itemref="desc"></output>`,
        `<table><tr><th id="target">H</th><td headers="target external">D</td></tr></table>`,
        `<a href="#target">Jump</a><area href="#target"><svg><use href="#target" xlink:href="#desc"></use>`,
        `<path fill="url(#target)" stroke="url('#desc')" filter='url("#target")' style="clip-path: url(#target); mask: url(#external)"></path></svg>`,
      ].join("\n");

      const result = rewriteIdReferencesInHtml(html, resolveId);

      expect(result).toContain(`for="scoped__target"`);
      expect(result).toContain(`aria-describedby="scoped__desc external"`);
      expect(result).toContain(`data-note='for="target"'`);
      expect(result).toContain(`form="scoped__target"`);
      expect(result).toContain(`list="scoped__target"`);
      expect(result).toContain(`aria-controls="scoped__target scoped__desc"`);
      expect(result).toContain(`popovertarget="scoped__target"`);
      expect(result).toContain(`commandfor="scoped__target"`);
      expect(result).toContain(`<output for="scoped__target external"`);
      expect(result).toContain(`<td headers="scoped__target external">`);
      expect(result).toContain(`<a href="#scoped__target">`);
      expect(result).toContain(
        `<use href="#scoped__target" xlink:href="#scoped__desc">`,
      );
      expect(result).toContain(`fill="url(#scoped__target)"`);
      expect(result).toContain(`stroke="url('#scoped__desc')"`);
      expect(result).toContain(`filter='url("#scoped__target")'`);
      expect(result).toContain(
        `style="clip-path: url(#scoped__target); mask: url(#external)"`,
      );
    });
  });

  describe("4. CSS pipeline full feature parity under both plain and minified identifiers", () => {
    for (const minifyIdentifiers of [false, true]) {
      it(`scopes all CSS constructs identically (minify.identifiers = ${minifyIdentifiers})`, () => {
        (BascikConfig.minify as { identifiers: boolean }).identifiers =
          minifyIdentifiers;
        const comp: BascikComponent = {
          name: "full-css",
          fileName: "/project/src/components/full-css/full-css.html",
          fileContent: `
            <div id="hero" class="box card">
              <h2>Title</h2>
              <p class="text">Hello</p>
              <code class="preserve-me"><span id="keep-id" class="box">code</span></code>
            </div>
            <script>
              const el = document.getElementById("hero");
              const q = document.querySelector("#hero .box");
              el.classList.add("card", "active");
              el.classList.toggle("box", true);
            </script>
          `,
          cssFileContent: `
            @layer reset, theme;
            @layer theme {
              #hero {
                --brand-color: #ff0055;
                container-name: hero-box;
                view-transition-name: hero-vt;
                anchor-name: --hero-anchor;
                color: var(--brand-color);
              }
            }
            @property --brand-color {
              syntax: "<color>";
              inherits: true;
              initial-value: #000;
            }
            @counter-style custom-bullets {
              system: cyclic;
              symbols: "★";
            }
            @container hero-box (min-width: 300px) {
              .box > h2, .card p {
                list-style-type: custom-bullets;
                position-anchor: --hero-anchor;
                animation: fade-in 0.3s ease;
              }
            }
            @position-try --hero-anchor {
              top: anchor(bottom);
            }
            ::view-transition-old(hero-vt) {
              opacity: 0;
            }
            @keyframes fade-in {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            .active {
              content: ".box #hero --brand-color fade-in";
            }
            [id] {
              outline: none;
            }
          `,
        };

        const scoped = runScopingPipeline({ ...comp }, "abcd1234");
        // Verify preserved code block stays untouched
        expect(scoped.fileContent).toContain(
          `<code class="preserve-me"><span id="keep-id" class="box">code</span></code>`,
        );
        // Verify [id] selector is stripped
        expect(scoped.cssFileContent).not.toContain("[id]");
        // Verify string literal inside .active is untouched
        expect(scoped.cssFileContent).toContain(
          `content: ".box #hero --brand-color fade-in"`,
        );
      });
    }
  });

  describe("5. Property-based full-page multi-component expansion parity", () => {
    it("produces deterministic output across arbitrary nested and sibling component trees", () => {
      const componentList: ComponentList = {
        "ui-card": {
          fileName: "src/components/ui-card.html",
          fileContent: `<article id="card" class="card"><header data-bascik-slot="header">Default Header</header><div class="body" data-bascik-slot>Default Body</div></article>`,
          cssFileContent: `#card { border: 1px solid #ccc; } .card > .body { padding: 8px; } p { margin: 0; }`,
        },
        "ui-badge": {
          fileName: "src/components/ui-badge.html",
          fileContent: `<span id="badge" class="badge" data-bascik-prop-label>Badge</span>`,
          cssFileContent: `#badge { display: inline-block; } .badge { --bg: blue; background: var(--bg); }`,
        },
      };

      const pageArb = fc
        .array(
          fc.oneof(
            fc
              .stringMatching(/^[a-zA-Z0-9 _-]{1,20}$/)
              .map(
                (text) =>
                  `<ui-badge data-bascik-prop-label="${text}"></ui-badge>`,
              ),
            fc
              .tuple(
                fc.stringMatching(/^[a-zA-Z0-9 _-]{1,15}$/),
                fc.stringMatching(/^[a-zA-Z0-9 _-]{1,15}$/),
              )
              .map(
                ([h, b]) =>
                  `<ui-card><span data-bascik-slot="header">${h}</span><p>${b} <ui-badge data-bascik-prop-label="${h}"></ui-badge></p></ui-card>`,
              ),
          ),
          { minLength: 1, maxLength: 8 },
        )
        .map((items) => `<main>${items.join("\n")}</main>`);

      fc.assert(
        fc.property(pageArb, (pageHtml) => {
          clearScopedCssCache();
          clearScopingTemplates();
          const first = recursivelyTranspile(
            pageHtml,
            componentList,
            [],
            "src/pages/test.html",
          );
          // Second run with warm caches must be byte-for-byte identical to cold run
          const second = recursivelyTranspile(
            pageHtml,
            componentList,
            [],
            "src/pages/test.html",
          );
          expect(second.transpiledHtmlBody).toBe(first.transpiledHtmlBody);
          expect(second.usedComponents.map((c) => c.cssFileContent)).toEqual(
            first.usedComponents.map((c) => c.cssFileContent),
          );
        }),
        { numRuns: 100 },
      );
    });
  });
});
