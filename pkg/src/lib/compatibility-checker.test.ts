import { describe, it, expect } from "vitest";
import {
  compatibilityRules,
  findCompatibilityMatches,
} from "./compatibility-checker.ts";

describe("compatibility-rules contract & positive/negative probes", () => {
  const ruleVectors: Record<
    string,
    { kind: "css" | "js"; positive: string[]; negative: string[] }
  > = {
    "css-id-attribute-selector": {
      kind: "css",
      positive: [
        "[id] { color: red; }",
        '[id="hero"] { color: blue; }',
        ".card, [id^='panel'] { margin: 0; }",
      ],
      negative: [
        "#hero { color: red; }",
        ".card[data-id='hero'] { color: blue; }",
        '/* [id] { color: red; } */',
        '.card::before { content: "[id]"; }',
      ],
    },
    "css-attribute-selector": {
      kind: "css",
      positive: [
        "[data-state] { color: red; }",
        '[data-open="true"] { display: block; }',
        ".ok, [aria-expanded='true'] { opacity: 1; }",
      ],
      negative: [
        ".card[data-state] { color: red; }",
        '[data-stocked="false"] .name { color: red; }',
        "html[data-theme='dark'] .box { color: white; }",
        "/* [data-state] { color: red; } */",
        "/* bascik-ignore css-attribute-selector */\n[data-state] { color: red; }",
      ],
    },
    "css-is-element-names": {
      kind: "css",
      positive: [
        ":is(p, h2) { margin: 0; }",
        ":where(ul, ol) { padding: 0; }",
        ".card:has(img) { display: grid; }",
      ],
      negative: [
        ":is(.title, .subtitle) { margin: 0; }",
        ".card:has(.hero-img) { display: grid; }",
        ".prose :is(h2, h3) { margin: 0; }",
        ".markdown :is(p, ul, ol, blockquote) { margin-block: 1.5rem; }",
        "/* bascik-ignore css-is-element-names */\n:is(h2, h3) { margin: 0; }",
      ],
    },
    "js-id-setter": {
      kind: "js",
      positive: [
        'el.id = "new-id";',
        "node.id = 'panel';",
        "item.id = nextId;",
      ],
      negative: [
        'const el = document.getElementById("panel");',
        '// el.id = "commented";',
        'const text = "el.id = \\"literal\\"";',
        "// bascik-ignore js-id-setter\nel.id = 'allowed';",
      ],
    },
    "js-attribute-selector": {
      kind: "js",
      positive: [
        'document.querySelector("[data-active]");',
        "document.querySelectorAll('[name=\"email\"]');",
      ],
      negative: [
        'document.querySelector(".active");',
        'document.getElementById("email");',
        "// bascik-ignore js-attribute-selector\ndocument.querySelector('[data-active]');",
      ],
    },
    "js-template-classname": {
      kind: "js",
      positive: [
        "el.className = `card ${state}`;",
        "el.classList.replace('old', `btn-${variant}`);",
      ],
      negative: [
        'el.className = "card active";',
        'el.classList.add("card");',
      ],
    },
    "js-style-setproperty": {
      kind: "js",
      positive: [
        'el.style.setProperty("--brand", "#fff");',
        "el.style.setProperty('--accent', val);",
      ],
      negative: [
        'el.style.setProperty("color", "red");',
        '// el.style.setProperty("--brand", "#fff");',
      ],
    },
    "js-unsupported-dom-methods": {
      kind: "js",
      positive: [
        'el.removeAttribute("class");',
        "el.hasAttribute('id');",
        'el.toggleAttribute("name");',
      ],
      negative: [
        'el.removeAttribute("hidden");',
        'el.hasAttribute("data-open");',
        'el.toggleAttribute("disabled");',
      ],
    },
    "js-document-class-query": {
      kind: "js",
      positive: [
        'document.querySelector(".btn");',
        "document.querySelector('.card-item');",
        "document.querySelector(`.btn`);",
        'document.querySelector( ".card .title" );',
        'document.querySelector("button.btn");',
        'document.querySelector(".list > li");',
        'document.getElementsByClassName("btn")[0];',
        "document.getElementsByClassName('btn').item(0);",
      ],
      negative: [
        'document.getElementById("btn");',
        'document.querySelector("#btn");',
        'document.querySelector("#panel .title");',
        'document.querySelector(".card #title");',
        'document.querySelector("main");',
        "document.querySelector(`.${name}`);",
        'root.querySelector(".btn");',
        'document.querySelectorAll(".btn");',
        'document.getElementsByClassName("btn");',
        "// bascik-ignore js-document-class-query\ndocument.querySelector('.btn');",
      ],
    },
  };

  it("covers every rule in compatibility-rules.json with positive and negative test vectors", () => {
    const definedIds = compatibilityRules.map((r) => r.id).sort();
    const testedIds = Object.keys(ruleVectors).sort();
    expect(testedIds).toEqual(definedIds);
  });

  for (const [ruleId, { kind, positive, negative }] of Object.entries(ruleVectors)) {
    describe(`rule: ${ruleId}`, () => {
      it.each(positive)("matches positive case: %s", (sample) => {
        const matches = findCompatibilityMatches(sample, kind);
        expect(matches.map((m) => m.rule.id)).toContain(ruleId);
      });

      it.each(negative)("does not match negative/ignored case: %s", (sample) => {
        const matches = findCompatibilityMatches(sample, kind);
        expect(matches.map((m) => m.rule.id)).not.toContain(ruleId);
      });
    });
  }
});

describe("bascik-disable and bascik-ignore rule lists", () => {
  const source = "document.querySelector('.a');\nel.querySelector('[data-x]');\n";

  it("scans both rules when nothing is disabled", () => {
    const ids = findCompatibilityMatches(source, "js").map((m) => m.rule.id);
    expect(ids).toContain("js-document-class-query");
    expect(ids).toContain("js-attribute-selector");
  });

  it.each([
    "/* bascik-disable js-attribute-selector,js-document-class-query */",
    "/* bascik-disable js-attribute-selector, js-document-class-query */",
    "/* bascik-disable js-attribute-selector , js-document-class-query */",
  ])("honors a block comment that lists several rules: %s", (directive) => {
    expect(findCompatibilityMatches(`${directive}\n${source}`, "js")).toEqual([]);
  });

  it("honors a line comment that lists several rules separated by comma and space", () => {
    const text = `// bascik-disable js-attribute-selector, js-document-class-query\n${source}`;
    expect(findCompatibilityMatches(text, "js")).toEqual([]);
  });

  it("only disables the listed rules", () => {
    const ids = findCompatibilityMatches(`/* bascik-disable js-attribute-selector, js-other */\n${source}`, "js").map(
      (m) => m.rule.id,
    );
    expect(ids).toEqual(["js-document-class-query"]);
  });
});
