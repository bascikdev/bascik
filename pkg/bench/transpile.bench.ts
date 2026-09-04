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
import { minifyJs } from "../src/lib/js-minifier.ts";
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

// Component-expansion scaling inputs (prompt 63). One component repeated N
// times on a flat page, plus a nested case where each instance introduces two
// more components inside its template (3 substitutions per instance).
const FLAT_LIST: ComponentList = {
  "item-card": { fileContent: `<div class="card"><p data-bascik-prop-title></p></div>` },
};
const NESTED_LIST: ComponentList = {
  "outer-box": {
    fileContent: `<section class="o"><inner-dot></inner-dot><inner-dot></inner-dot><div data-bascik-slot></div></section>`,
  },
  "inner-dot": { fileContent: `<i class="d">.</i>` },
};
const flatPage = (n: number): string =>
  Array.from({ length: n }, (_, i) => `<item-card title="Item ${i}"></item-card>`).join("\n");
const nestedPage = (n: number): string =>
  Array.from({ length: n }, (_, i) => `<outer-box>${i}</outer-box>`).join("\n");
const FLAT_800 = flatPage(800);
const FLAT_1600 = flatPage(1600);
const FLAT_3200 = flatPage(3200);
const NESTED_800 = nestedPage(800);

// JS minifier scaling inputs (prompt 62). Slash-heavy exercises regex/division/
// comment disambiguation on every `/`; slash-light is the common case. Sizes
// double so a quadratic scan would show ~4x per step and a linear one ~2x.
const SLASH_HEAVY_UNIT = "const a = b / c / d; // note\nconst e = f / g; /* block */ x = y / z;\n";
const SLASH_LIGHT_UNIT = "const alpha = beta + gamma;\nlet delta = epsilon(zeta, eta);\n";
const JS_SIZES = [
  { label: "~52KB", reps: 750 },
  { label: "~107KB", reps: 1550 },
  { label: "~217KB", reps: 3150 },
  { label: "~437KB", reps: 6330 },
] as const;
const SLASH_HEAVY = JS_SIZES.map(({ label, reps }) => ({ label, src: SLASH_HEAVY_UNIT.repeat(reps) }));
const SLASH_LIGHT = JS_SIZES.map(({ label, reps }) => ({ label, src: SLASH_LIGHT_UNIT.repeat(reps) }));

// ── Benchmarks ────────────────────────────────────────────────────────────────────────────

describe("minifyJs: slash-heavy scaling", () => {
  for (const { label, src } of SLASH_HEAVY) {
    bench(`slash-heavy ${label} (${src.length} bytes)`, () => {
      minifyJs(src);
    });
  }
});

describe("minifyJs: slash-light scaling", () => {
  for (const { label, src } of SLASH_LIGHT) {
    bench(`slash-light ${label} (${src.length} bytes)`, () => {
      minifyJs(src);
    });
  }
});

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

describe("recursivelyTranspile: flat instance scaling", () => {
  bench(`800 flat instances (${FLAT_800.length} bytes)`, () => {
    recursivelyTranspile(FLAT_800, FLAT_LIST);
  });
  bench(`1600 flat instances (${FLAT_1600.length} bytes)`, () => {
    recursivelyTranspile(FLAT_1600, FLAT_LIST);
  });
  bench(`3200 flat instances (${FLAT_3200.length} bytes)`, () => {
    recursivelyTranspile(FLAT_3200, FLAT_LIST);
  });
  bench(`800 nested instances, 2400 substitutions (${NESTED_800.length} bytes)`, () => {
    recursivelyTranspile(NESTED_800, NESTED_LIST);
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
