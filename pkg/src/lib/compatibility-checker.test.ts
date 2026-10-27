import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  compatibilityRules,
  findCompatibilityMatches,
  maskComments,
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
        "/* [id] { color: red; } */",
        '.card::before { content: "[id]"; }',
      ],
    },
    "css-attribute-selector": {
      kind: "css",
      positive: [
        "[data-state] { color: red; }",
        "[data-state]:hover { color: red; }",
        "[data-state][hidden] { color: red; }",
        "[data-state]:not(.disabled) { color: red; }",
        "[data-state]:is(.disabled, button) { color: red; }",
        '[data-open="true"] { display: block; }',
        ".ok, [aria-expanded='true'] { opacity: 1; }",
      ],
      negative: [
        ".card[data-state] { color: red; }",
        '[data-stocked="false"] .name { color: red; }',
        "[data-state] .scoped-class { color: red; }",
        "[data-state] > .scoped-class { color: red; }",
        "[data-state]:not(.disabled) .card { color: red; }",
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
      negative: ['el.className = "card active";', 'el.classList.add("card");'],
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
    "js-dynamic-id-lookup": {
      kind: "js",
      positive: [
        "document.getElementById(targetId);",
        "document.getElementById(btn.dataset.target);",
        "document.getElementById(`item-${i}`);",
        // javascript.ts only rewrites "/' quoted literals, so a backtick
        // literal and a concatenation ship unscoped even without a variable.
        "document.getElementById(`panel`);",
        'document.getElementById("pre-" + n);',
        'document.getElementById("a"+b);',
        "document.getElementById( id );",
        "document.getElementById(ids[0]);",
        'document.getElementById(el.getAttribute("data-target"));',
      ],
      negative: [
        'document.getElementById("panel");',
        "document.getElementById('panel');",
        'document.getElementById( "panel" );',
        'document.getElementById("panel").focus();',
        'document.getElementById(\n  "panel"\n);',
        "document.getElementById();",
        "document.getElementById( );",
        "// document.getElementById(targetId);",
        "// bascik-ignore js-dynamic-id-lookup\ndocument.getElementById(targetId);",
      ],
    },
  };

  it("covers every rule in compatibility-rules.json with positive and negative test vectors", () => {
    const definedIds = compatibilityRules.map((r) => r.id).sort();
    const testedIds = Object.keys(ruleVectors).sort();
    expect(testedIds).toEqual(definedIds);
  });

  for (const [ruleId, { kind, positive, negative }] of Object.entries(
    ruleVectors,
  )) {
    describe(`rule: ${ruleId}`, () => {
      it.each(positive)("matches positive case: %s", (sample) => {
        const matches = findCompatibilityMatches(sample, kind);
        expect(matches.map((m) => m.rule.id)).toContain(ruleId);
      });

      it.each(negative)(
        "does not match negative/ignored case: %s",
        (sample) => {
          const matches = findCompatibilityMatches(sample, kind);
          expect(matches.map((m) => m.rule.id)).not.toContain(ruleId);
        },
      );
    });
  }
});

describe("bascik-disable and bascik-ignore rule lists", () => {
  const source =
    "document.querySelector('.a');\nel.querySelector('[data-x]');\n";

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
    expect(findCompatibilityMatches(`${directive}\n${source}`, "js")).toEqual(
      [],
    );
  });

  it("honors a line comment that lists several rules separated by comma and space", () => {
    const text = `// bascik-disable js-attribute-selector, js-document-class-query\n${source}`;
    expect(findCompatibilityMatches(text, "js")).toEqual([]);
  });

  it("only disables the listed rules", () => {
    const ids = findCompatibilityMatches(
      `/* bascik-disable js-attribute-selector, js-other */\n${source}`,
      "js",
    ).map((m) => m.rule.id);
    expect(ids).toEqual(["js-document-class-query"]);
  });
});

describe("maskComments", () => {
  // The single regex the scanner replaced. It is the reference for what the output should be, and quadratic on
  // unclosed quotes and comments, which is why it is no longer used.
  const reference = (text: string, kind: "css" | "js") =>
    kind === "css"
      ? text.replace(
          /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\(\s*(?:[^)"']|"[^"]*"|'[^']*')*\s*\))|\/\*[\s\S]*?\*\//g,
          (m, kept?: string) => kept ?? m.replace(/[^\n]/g, " "),
        )
      : text.replace(
          /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
          (m, kept?: string) => kept ?? m.replace(/[^\n]/g, " "),
        );

  const tricky = fc
    .array(
      fc.constantFrom(
        '"',
        "'",
        "`",
        "\\",
        "/",
        "*",
        "(",
        ")",
        "url(",
        "u",
        " ",
        "\n",
        "a",
        "[id]",
      ),
      { maxLength: 60 },
    )
    .map((parts) => parts.join(""));

  it.each(["css", "js"] as const)(
    "gives the same %s output as the regex it replaced",
    (kind) => {
      fc.assert(
        fc.property(tricky, (text) => {
          expect(maskComments(text, kind)).toBe(reference(text, kind));
        }),
        { numRuns: 2000 },
      );
    },
  );

  it.each([
    ["css", '"' + '\\"'.repeat(100_000)],
    ["css", "'" + "\\'".repeat(100_000)],
    ["css", "url( ".repeat(60_000)],
    ["css", 'url("'.repeat(60_000)],
    ["css", "/*a".repeat(60_000)],
    ["js", "`" + "\\`".repeat(100_000)],
    ["js", "/*a".repeat(60_000)],
  ] as const)("stays linear on unclosed %s input (%#)", (kind, text) => {
    // The replaced regex took tens of seconds on each of these. A linear scan takes milliseconds, so the bound
    // only has to tell the two apart.
    const start = performance.now();
    expect(maskComments(text, kind)).toBe(text);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
