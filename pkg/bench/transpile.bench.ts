/**
 * Bascik transpile pipeline benchmarks.
 *
 * Run with:   yarn bench
 * (Uses vitest's built-in bench API — no extra dependencies.)
 *
 * Each benchmark is repeatable: the same fixed component list and HTML strings
 * are used every run so results are comparable across code changes.
 */

import { bench, describe } from "vitest";
import { vi } from "vitest";

// ── Mock config so benchmarks run without a project root ─────────────────────
vi.mock("../src/lib/config.ts", () => ({
  BascikConfig: {
    scopeScriptBlocks: true,
    scopeAttribute: { class: true, id: true, name: true },
    isBuild: true,
    minify: {
      html: false,
      css: true,
      js: false,
      identifiers: false,
    },
  },
}));

vi.mock("../src/lib/names.ts", () => ({
  getUniqueId: () => "bench1234",
  minifyAttributeName: (n: string) => n,
  getAttributeNameHash: (n: string) => n,
}));

import {
  recursivelyTranspile,
} from "../src/lib/processing.ts";
import { replaceTag, getTag } from "../src/lib/components.ts";
import { minifyHtml } from "../src/lib/html-minifier.ts";
import {
  convertCssElementSelectorsToClasses,
  scopeCssCustomProperties,
  deduplicateCss,
} from "../src/lib/styles.ts";

import type { ComponentList } from "../src/lib/types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SMALL_NAV_HTML = `
<nav class="navigation header">
  <ul>
    <li class="home logo">Bascik</li>
    <li><a href="/">index</a></li>
    <li><a href="/about">about</a></li>
    <li><a href="/new">new</a></li>
    <li><a href="/sub/">sub page</a></li>
  </ul>
</nav>
`;

const LARGE_HTML = SMALL_NAV_HTML.repeat(50);

const COMPONENT_CSS = `
.navigation ul { list-style-type: none; margin: unset; padding: unset; }
.navigation ul li { display: inline-block; }
.navigation ul li a { padding: 8px; }
.home.logo { background-color: #fff; color: #18191b; padding: 4px; animation: spin 1s infinite; }
@media (max-width: 600px) { .home.logo { background-color: #d3ff8d; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`.repeat(5);

const CUSTOM_PROPS_CSS = `
:root { --brand: #d3ff8d; --size: 1rem; --weight: 700; }
.el { color: var(--brand); font-size: var(--size); font-weight: var(--weight); }
`.repeat(10);

// A realistic page body with 10 components, some nested
const makeComponentList = (count: number): ComponentList => {
  const list: ComponentList = {};
  for (let i = 0; i < count; i++) {
    list[`comp-${i}`] = {
      fileName: `components/comp-${i}.html`,
      fileContent: `<div class="c${i}"><p>Component ${i}</p><div data-bascik-slot></div></div>`,
      cssFileContent: `.c${i} { color: hsl(${i * 36}deg, 60%, 60%); }`,
    };
  }
  return list;
};

const COMPONENT_LIST_10 = makeComponentList(10);
const COMPONENT_LIST_50 = makeComponentList(50);

const PAGE_BODY_10 = Array.from(
  { length: 10 },
  (_, i) => `<comp-${i}><p>slot content ${i}</p></comp-${i}>`,
).join("");

const PAGE_BODY_50 = Array.from(
  { length: 50 },
  (_, i) => `<comp-${i}><p>slot content ${i}</p></comp-${i}>`,
).join("");

// ── Benchmarks ────────────────────────────────────────────────────────────────

describe("minifyHtml", () => {
  bench("small HTML (~200 chars)", () => {
    minifyHtml(SMALL_NAV_HTML);
  });

  bench("large HTML (~10KB, 50× repeated)", () => {
    minifyHtml(LARGE_HTML);
  });
});

describe("getTag", () => {
  bench("paired tag lookup", () => {
    getTag("<div><custom-nav>inner</custom-nav></div>", "custom-nav");
  });

  bench("self-closing tag lookup", () => {
    getTag("<div><custom-nav /></div>", "custom-nav");
  });
});

describe("replaceTag", () => {
  bench("replace paired tag", () => {
    replaceTag(
      "<div><custom-nav>inner</custom-nav><p>after</p></div>",
      "custom-nav",
      "<nav>replaced</nav>",
    );
  });
});

describe("CSS scoping — convertCssElementSelectorsToClasses", () => {
  bench("realistic component CSS (~600 chars)", () => {
    convertCssElementSelectorsToClasses(COMPONENT_CSS, "my-nav");
  });
});

describe("CSS scoping — scopeCssCustomProperties", () => {
  bench("10 custom properties", () => {
    scopeCssCustomProperties(CUSTOM_PROPS_CSS, "my-comp__bench1234");
  });
});

describe("recursivelyTranspile (full pipeline)", () => {
  bench("10 components, 1 page", () => {
    recursivelyTranspile(PAGE_BODY_10, COMPONENT_LIST_10);
  });

  bench("50 components, 1 page", () => {
    recursivelyTranspile(PAGE_BODY_50, COMPONENT_LIST_50);
  });
});

describe("deduplicateCss", () => {
  const usedComponents = Array.from({ length: 20 }, (_, i) => ({
    name: `comp-${i % 10}`, // 10 unique names, each used twice
    cssFileContent: `.c${i % 10} { color: red; }`,
  }));

  bench("20 entries, 10 unique components", () => {
    deduplicateCss(usedComponents);
  });
});

describe("multi-page transpilation simulation", () => {
  bench("20 pages × recursivelyTranspile (sequential)", () => {
    for (let p = 0; p < 20; p++) {
      recursivelyTranspile(PAGE_BODY_10, COMPONENT_LIST_10);
    }
  });

  bench("50 pages × recursivelyTranspile (sequential)", () => {
    for (let p = 0; p < 50; p++) {
      recursivelyTranspile(PAGE_BODY_10, COMPONENT_LIST_10);
    }
  });
});
