import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  compatibilityRules,
  findCompatibilityMatches,
  maskComments,
} from "./compatibility-checker.ts";
import { propertyBounds } from "./property-runs.test-helper.ts";

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
        // Every form the compiler strips is reported, not only a leading one.
        ".a:not([id]) { color: red; }",
        ".a:is([id]) { color: red; }",
        '.a:where([id="x"]) { color: red; }',
        ".a:has([id]) { color: red; }",
        ".a[id] { color: red; }",
        'div[id="x"] { color: red; }',
        "[ID] { color: red; }",
        "[ id ] { color: red; }",
      ],
      negative: [
        "#hero { color: red; }",
        ".card[id-ref] { color: red; }",
        ".card[idx] { color: red; }",
        ".card { content: '[id]'; }",
        ".card[data-id='hero'] { color: blue; }",
        "/* [id] { color: red; } */",
        '.card::before { content: "[id]"; }',
        // The compiler keeps an @supports selector() test, so lint does too.
        "@supports selector([id]) { .a { color: red; } }",
        "@supports not SELECTOR( [id] ) { .a { color: red; } }",
      ],
    },
    "css-reserved-class-prefix": {
      kind: "css",
      positive: [
        ".b_el_p { color: blue; }",
        ".card .b_id_btn { color: blue; }",
        ".card, .b_el_item:hover { color: blue; }",
        ".b_el_card_p { color: blue; }",
        ".b_id_card_btn > span { color: blue; }",
      ],
      negative: [
        ".block__el { color: blue; }",
        ".model__p { color: blue; }",
        ".el-p, .id-btn, .el_p { color: blue; }",
        // The generated names start with b_el_ and b_id_, so the double
        // underscore forms an authored class compiles to stay distinct.
        ".el__p, .id__btn { color: blue; }",
        ".b-el-p, .bel_p, .b_elx, .ab_el_x, .B_EL_p { color: blue; }",
        '.card::before { content: ".b_el_p"; }',
        "/* .b_el_p { color: blue; } */",
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
        '[id-test="x"] { color: red; }',
        // A flag or a namespace does not make an attribute selector scoped.
        "[href$=x i] { color: red; }",
        '[href$=".pdf" s] { color: red; }',
        "[ type = checkbox I ] { color: red; }",
        "[xlink|href] { color: red; }",
        "[*|href=x] { color: red; }",
        "[|lang|=en] { color: red; }",
        // A rule on the same line as the one before it is still its own selector.
        ".a { color: blue; } [data-state] { color: red; }",
        "@media (min-width: 40em) { [data-state] { color: red; } }",
        "@supports (display: grid) {\n  [data-state] { color: red; }\n}",
        "@container card (width > 20em) { .a, [data-state] { color: red; } }",
        // Wrapped or not, nothing here is a scoped class.
        "[data-state]\n  > [data-part] { color: red; }",
        "[data-state]\n  :not(.off) { color: red; }",
        '[data-label="{, .card"] { color: red; }',
        // The parent rule is not anchored, so its nested rule is not either.
        "[data-state] { [data-part] { color: red; } }",
        "#panel { [open] & { color: red; } }",
        // A stylesheet wrapped in an HTML comment: CSS skips the `<!--` and `-->`.
        "<!--\n[data-state] { color: red; }\n-->",
        ".a { color: blue; }\n-->\n[data-state] { color: red; }",
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
        // A class that starts with a hyphen is scoped like any other.
        "[data-state].-on { color: red; }",
        "[data-state] .--open { color: red; }",
        "[href$=x i].card { color: red; }",
        // A selector Prettier wraps is still anchored on its first line.
        ".thread\n  [data-part] { color: red; }",
        '.thread\n  :where([data-chat-part="turn"][data-role="assistant"])\n  > [data-part][data-state="running"]:has(~ [data-part]:not([data-state="running"])) {\n  display: none;\n}',
        ".thread [data-a],\n.thread\n  [data-b] { color: red; }",
        ".thread /* the turn */\n  [data-part] { color: red; }",
        '.thread[data-label="{, "]\n  [data-part] { color: red; }',
        "[data-state]\n  .card { color: red; }",
        "[data-state]:not(:is(.a)) .card { color: red; }",
        ".card:is(.a, [data-state]) { color: red; }",
        // A nested rule is a descendant of its anchored parent.
        ".card {\n  [data-part] { color: red; }\n}",
        ".card { @media (min-width: 40em) { [data-part] { color: red; } } }",
        // Nested in a rule that an element or #id leads: the same as `#panel [open]`, which is not standalone.
        "#panel {\n  [open] { color: red; }\n}",
        "#panel\n  [open] { color: red; }",
        "section { [open] { color: red; } }",
        "div { .x { color: blue; } [data-y] { color: red; } }",
        ":is(.a, .b) {\n  [open] { color: red; }\n}",
        "#panel { &[open] { color: red; } }",
        // An ignore comment above a selector list covers the list, one selector per line too.
        "/* bascik-ignore css-attribute-selector */\n[data-a],\n[data-b] { color: red; }",
        "/* bascik-ignore */\n.card,\n[data-b],\n[data-c] { color: red; }",
        // A declaration is not a selector.
        ".grid {\n  grid-template-columns:\n    [full-start] 1fr\n    [full-end];\n}",
      ],
    },
    "css-is-element-names": {
      kind: "css",
      positive: [
        ":is(p, h2) { margin: 0; }",
        ":where(ul, ol) { padding: 0; }",
        ".card:has(img) { display: grid; }",
        ".card\n  .title:has(img)\n  ~ p,\n:is(p) .card { display: grid; }",
        ":where([data-part])\n  > :is(h3, h4) { margin: 0; }",
        "@media (min-width: 40em) { p > :is(h3, h4) { margin: 0; } }",
        // `&` is the parent itself, so this is .card:has(img).
        ".card { &:has(img) { display: grid; } }",
        "[data-state] { :is(p) { margin: 0; } }",
        // A class in the pseudo-class's own compound: an earlier class does not change what it is.
        ".wrap .card:has(img) { display: grid; }",
        ".wrap\n  .card:has(> img) { display: grid; }",
        ".wrap > .card:hover:has(img) { display: grid; }",
        ".card {\n  .x:has(img) { display: grid; }\n}",
        ".card {\n  & > .y:has(img) { display: grid; }\n}",
        ".wrap .card:not(:is(p)) { display: grid; }",
      ],
      negative: [
        ":is(.title, .subtitle) { margin: 0; }",
        ".card:has(.hero-img) { display: grid; }",
        ".prose :is(h2, h3) { margin: 0; }",
        ".markdown :is(p, ul, ol, blockquote) { margin-block: 1.5rem; }",
        ".-prose :is(h2, h3) { margin: 0; }",
        ".--open :where(p) { margin: 0; }",
        // Anchored on a scoped class earlier in the selector, with anything in between.
        ".thread :where([data-chat-part='turn']) > :is(h3, h4):not(:first-child) { margin: 0; }",
        '.thread\n  :where([data-chat-part="turn"][data-role="assistant"])\n  > :is(h3, h4):not(:first-child) {\n  margin: 0;\n}',
        '.thread\n  :where([data-chat-part="turn"])\n  :is(th)[aria-sort="ascending"]\n  :is(button)::after { margin: 0; }',
        ".thread > :is(div):empty:has(+ [data-testid='ask-button']) { margin: 0; }",
        ".thread /* headings */ > p ~ :is(h3, h4) { margin: 0; }",
        ".card { :is(p, ul) { margin: 0; } }",
        ".card { & > :is(p, ul) { margin: 0; } }",
        ".card { @media (min-width: 40em) { > :is(p, ul) { margin: 0; } } }",
        '.card::after { content: ":is(p)"; }',
        "/* bascik-ignore css-is-element-names */\n:is(h2, h3) { margin: 0; }",
        ".wrap .card :is(p) { margin: 0; }",
        ".wrap :is(p).card { margin: 0; }",
        "/* bascik-ignore css-is-element-names */\n.wrap\n  .card:has(img) { margin: 0; }",
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
        'document.querySelector(".-mt-4");',
        'document.querySelector(".--open");',
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
        // `href` reads back with its `#`, which getElementById never matches.
        'document.getElementById(link.getAttribute("href"));',
        'document.getElementById(btn.getAttribute("popovertarget") + "-x");',
        "document.getElementById(btn.getAttribute(name));",
        'document.getElementById(btn.getAttribute("aria-controlsx"));',
        'document.getElementById(btn.getAttribute("data-popovertarget"));',
      ],
      negative: [
        // The value of an ID-reference attribute Bascik rewrites is already
        // the scoped id, so reading it is the lookup the rule recommends.
        'document.getElementById(button.getAttribute("popovertarget"));',
        "document.getElementById(btn.getAttribute('aria-controls'));",
        "document.getElementById(this.getAttribute(`commandfor`));",
        'document.getElementById(event.currentTarget.getAttribute("aria-controls"));',
        'document.getElementById(btn?.getAttribute("popovertarget"));',
        'document.getElementById( label.getAttribute("for") );',
        'document.getElementById(input.getAttribute("list"));',
        'document.getElementById(el.getAttribute("aria-describedby"));',
        'document.getElementById(link.getAttribute("href").slice(1));',
        'document.getElementById(link.getAttribute("href").substring(1));',
        "document.getElementById(label.htmlFor);",
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

describe("selectors read whole, not a line at a time", () => {
  const lineOf = (css: string, index: number) =>
    css.slice(0, index).split("\n").length;
  const report = (css: string) =>
    findCompatibilityMatches(css, "css").map(
      (m) => `${m.rule.id}@${lineOf(css, m.index)}`,
    );

  it("reports nothing in the wrapped selectors of a real component", () => {
    // From the chat-thread component of the ai package, as Prettier writes them.
    const css = `
.thread :where([data-chat-part="turn"][data-role="assistant"]) > * + :not(br),
.thread
  :where([data-chat-part="turn"][data-role="assistant"])
  > :is([data-part], [data-view])
  > *
  + :not(br) {
  margin-block-start: 0.75rem;
}
.thread
  :where([data-chat-part="turn"][data-role="assistant"])
  > :is(div):empty:has(+ [data-testid="ask-button"]) {
  display: none;
}
.thread
  :where([data-chat-part="turn"][data-role="assistant"])
  > :is(h3, h4)
  + * {
  margin-block-start: 0.25rem;
}
.thread
  :where([data-chat-part="turn"][data-role="assistant"])
  [data-diagram]
  :is(svg) {
  max-inline-size: 100%;
}
.thread
  :where([data-chat-part="turn"][data-role="assistant"])
  :is(th)[aria-sort="descending"]
  :is(button)::after {
  content: "\\2193";
}
.thread
  :where([data-chat-part="turn"][data-role="assistant"])
  [data-chat-part="failed"] {
  color: red;
}
`;
    expect(report(css)).toEqual([]);
  });

  it("reports an unanchored selector on its own line, among wrapped anchored ones", () => {
    const css = [
      ".thread", // 1
      "  [data-a],", // 2
      "[data-b]", // 3
      "  > [data-c],", // 4
      ".thread", // 5
      "  > :is(h3, h4) {", // 6
      "  color: red;", // 7
      "}", // 8
      "@media (min-width: 40em) {", // 9
      "  .thread", // 10
      "    [data-d] {", // 11
      "    color: red;", // 12
      "  }", // 13
      "  :where([data-e])", // 14
      "    > :is(p) {", // 15
      "    color: red;", // 16
      "  }", // 17
      "}", // 18
    ].join("\n");
    expect(report(css)).toEqual([
      "css-attribute-selector@3",
      "css-is-element-names@15",
    ]);
  });

  it("starts a report at the selector, not at the comma or blank lines before it", () => {
    const css = ".a,\n\n\n  [data-x] { color: red; }";
    const [match] = findCompatibilityMatches(css, "css");
    expect(css.slice(match.index, match.index + match.length)).toBe("[data-x]");
  });

  it("honors an ignore comment on the line before a wrapped selector's reported line", () => {
    const css =
      "/* bascik-ignore css-is-element-names */\n:is(p)\n  > [data-x] { color: red; }";
    expect(report(css)).toEqual([]);
  });

  it("lets an ignore comment above a selector list cover that list only", () => {
    const css = [
      "/* bascik-ignore css-attribute-selector */", // 1
      "[data-a],", // 2
      "[data-b],", // 3
      "[data-c] {", // 4
      "  color: red;", // 5
      "}", // 6
      "[data-d],", // 7
      "[data-e] {", // 8
      "  color: red;", // 9
      "}", // 10
    ].join("\n");
    expect(report(css)).toEqual([
      "css-attribute-selector@7",
      "css-attribute-selector@8",
    ]);
  });

  it("reports a nested attribute selector only when attribute selectors lead it all the way up", () => {
    const css = [
      "[data-a] {", // 1
      "  [data-b] {", // 2
      "    color: red;", // 3
      "  }", // 4
      "  div {", // 5
      "    [data-c] {", // 6
      "      color: red;", // 7
      "    }", // 8
      "  }", // 9
      "}", // 10
      "#panel {", // 11
      "  [data-d] {", // 12
      "    [data-e] {", // 13
      "      color: red;", // 14
      "    }", // 15
      "  }", // 16
      "}", // 17
    ].join("\n");
    expect(report(css)).toEqual([
      "css-attribute-selector@1",
      "css-attribute-selector@2",
    ]);
  });

  it("reads a rule after the `<!--` of a wrapped stylesheet on its own line", () => {
    expect(report("<!--\n[data-x] { color: red; }\n-->")).toEqual([
      "css-attribute-selector@2",
    ]);
  });

  // One compound of a selector, with what a reader of the whole selector knows about it.
  const compounds = [
    { text: ".thread", hasClass: true },
    { text: ".card[data-open]", hasClass: true },
    { text: "[data-a]", startsWithAttribute: true },
    { text: '[data-b="{, .x; }"]', startsWithAttribute: true },
    { text: "[data-c]:is(.x)", startsWithAttribute: true },
    { text: ":is(h3, h4)", elementNames: 1 },
    { text: ".card:has(img)", hasClass: true, elementNames: 1 },
    { text: ':where([data-part="turn"])' },
    { text: ":not(.off)" },
    { text: "p" },
  ] as const;
  type Compound = (typeof compounds)[number];

  const complexSelector = fc.array(fc.constantFrom<Compound>(...compounds), {
    minLength: 1,
    maxLength: 5,
  });
  const selectorList = fc.array(complexSelector, {
    minLength: 1,
    maxLength: 3,
  });
  const expectedOf = (list: Compound[][]) => {
    const expected: string[] = [];
    for (const selector of list) {
      const anchored = selector.some((c) => "hasClass" in c);
      if ("startsWithAttribute" in selector[0] && !anchored) {
        expected.push("css-attribute-selector");
      }
      let classBefore = false;
      for (const compound of selector) {
        // Reported unless a class and a combinator come first and the compound itself has no class.
        if (
          "elementNames" in compound &&
          (!classBefore || "hasClass" in compound)
        ) {
          expected.push("css-is-element-names");
        }
        classBefore ||= "hasClass" in compound;
      }
    }
    return expected.sort();
  };
  const render = (
    list: Compound[][],
    gaps: readonly string[],
    wrapAtRule: boolean,
  ) => {
    let gap = 0;
    const next = () => gaps[gap++ % gaps.length];
    const rule = `${list
      .map((selector) =>
        selector
          .map((compound): string => compound.text)
          .reduce((left, right) => `${left}${next()}${right}`),
      )
      // Between two selectors of the list a combinator would be a syntax error, so only its line breaks stay.
      .join(`,${next().replace(/[>+~]/g, "")}`)} { color: red; }`;
    return wrapAtRule ? `@media (min-width: 40em) {\n${rule}\n}` : rule;
  };
  const ONE_LINE = [" "] as const;
  const WRAPS = fc.array(
    fc.constantFrom(
      " ",
      "\n",
      "\n  ",
      "\r\n    ",
      " > ",
      "\n  > ",
      "\n  + ",
      " ~\n  ",
      " /* a, [data-z] { */ ",
      "\n  /* .card */\n  ",
    ),
    { minLength: 1, maxLength: 8 },
  );
  const BOUNDS = propertyBounds(300);

  it(
    "gives a selector the same verdict however it is wrapped",
    () => {
      fc.assert(
        fc.property(
          selectorList,
          WRAPS,
          fc.boolean(),
          (list, gaps, wrapAtRule) => {
            const ids = (css: string) =>
              findCompatibilityMatches(css, "css")
                .map((m) => m.rule.id)
                .sort();
            const expected = expectedOf(list);
            expect(ids(render(list, ONE_LINE, false))).toEqual(expected);
            expect(ids(render(list, gaps, wrapAtRule))).toEqual(expected);
          },
        ),
        BOUNDS.options,
      );
    },
    BOUNDS.timeoutMs,
  );
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
});
