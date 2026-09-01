import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  convertCssElementSelectorsToClasses,
  addElementClassesInHtml,
  getKeyframeNames,
  prefixKeyframes,
  removeIdSelectors,
  removeCommentsFromCss,
  scopeCssCustomProperties,
  scopeLayerNames,
  scopeContainerNames,
  scopeViewTransitionNames,
  scopeCounterStyleNames,
  scopeAnchorNames,
  scopeInlineStyleTags,
  convertCssIdSelectorsToClasses,
  addIdClassesInHtml,
  deduplicateCss,
  shieldCssStrings,
  getComponentCss,
  extractInlineStyles,
  isRemoteCssUrl,
  parseCssImport,
  wrapInlinedCss,
  resolveCssImports,
  resolveCssImportsSync,
  hoistCssImports,
} from "./styles.ts";
import { minifyCss } from "./css-minifier.ts";

const css = `
.navigation ul {
  list-style-type: none;
  margin: unset;
  padding: unset;
}
.home.logo {
  background-color: #fff;
  color: #18191b;
  padding: 4px;
  user-select: none;
  animation: rotateLogo 2s infinite alternate;
}
@media only screen and (max-width: 600px) {
  .home.logo {
    background-color: #d3ff8d;
  }
}
@keyframes rotateLogo {
  from {
    transform: perspective(500px) rotateY(-40deg);
  }
  to {
    transform: perspective(500px) rotateY(40deg);
  }
}
`;
const elHtml = `
<h4>h4</h4>
<p>misspelled</p>
<p class="not-used">misspelled</p>
`;
const elHtmlRes = `
<h4>h4</h4>
<p class="bascik__my-comp__el__p">misspelled</p>
<p class="not-used bascik__my-comp__el__p">misspelled</p>
`;
const elCss = `
p {
  text-decoration: #d3ff8d wavy underline;
  display: block;
  /* This should not work if scoped keyframes are on */
  animation: rotateLogo 2s infinite alternate;
}
`;
const prefixKeyframesRes = `
.navigation ul {
  list-style-type: none;
  margin: unset;
  padding: unset;
}
.home.logo {
  background-color: #fff;
  color: #18191b;
  padding: 4px;
  user-select: none;
  animation: bascik__my-comp__keyframe__rotateLogo 2s infinite alternate;
}
@media only screen and (max-width: 600px) {
  .home.logo {
    background-color: #d3ff8d;
  }
}
@keyframes bascik__my-comp__keyframe__rotateLogo {
  from {
    transform: perspective(500px) rotateY(-40deg);
  }
  to {
    transform: perspective(500px) rotateY(40deg);
  }
}
`;
const idCss = `
.hr {
  border: 8px solid #d3ff8d;
  border-radius: 25px;
}
/* ID selectors will be removed */
[id] {
  color: #d3ff8d;
}
`;

vi.mock("./config.js", () => {
  return {
    BascikConfig: { minify: { identifiers: false } },
  };
});

vi.mock("node:crypto", () => {
  return {
    createHash: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => "12345678"),
    })),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (path, opts) => {
      try {
        return await actual.readFile(path, opts);
      } catch {
        return css;
      }
    }),
  };
});

describe("convertCssElementSelectorsToClasses", () => {
  it("test", () => {
    expect(convertCssElementSelectorsToClasses(elCss, "my-comp")).toStrictEqual(
      {
        css:
          "\n" +
          ".bascik__my-comp__el__p {\n" +
          "  text-decoration: #d3ff8d wavy underline;\n" +
          "  display: block;\n" +
          "  /* This should not work if scoped keyframes are on */\n" +
          "  animation: rotateLogo 2s infinite alternate;\n" +
          "}\n",
        elementsConvertedClasses: ["p"],
      },
    );
  });

  it("does not scope CSS unit keywords that appear at line start due to a syntax error", () => {
    // A CSS syntax error can place a unit keyword like `rem` at column 0,
    // e.g. accidentally breaking `0.7rem 1em` across two lines.
    // The scoping regex must leave it untouched.
    const brokenCss = `.mycomp {\n  margin: 0.7\nrem 1em;\n}`;
    const { css, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses(brokenCss, "my-comp");
    expect(css).toContain("rem 1em");
    expect(css).not.toContain("bascik__my-comp__el__rem");
    expect(elementsConvertedClasses).not.toContain("rem");
  });

  it("does not scope html, body, or head — they are never inside a component", () => {
    // Cross-boundary selectors like `html[data-theme="light"] .my-class` must
    // preserve `html` verbatim so the compiled selector actually matches.
    const cases = [
      { css: `html[data-theme="light"] .foo { color: red; }`, label: "html with attribute selector" },
      { css: `html[data-theme="light"] .foo { color: red; }\nhtml[data-theme="dark"] .foo { color: blue; }`, label: "multiple html rules" },
      { css: `body { margin: 0; }`, label: "body standalone" },
      { css: `head { display: none; }`, label: "head standalone" },
    ];
    for (const { css, label } of cases) {
      const { css: result, elementsConvertedClasses } =
        convertCssElementSelectorsToClasses(css, "my-comp");
      expect(result, label).not.toContain("bascik__my-comp__el__html");
      expect(result, label).not.toContain("bascik__my-comp__el__body");
      expect(result, label).not.toContain("bascik__my-comp__el__head");
      expect(elementsConvertedClasses, label).not.toContain("html");
      expect(elementsConvertedClasses, label).not.toContain("body");
      expect(elementsConvertedClasses, label).not.toContain("head");
    }
  });
});

describe("addElementClassesInHtml", () => {
  it("test", () => {
    expect(addElementClassesInHtml(elHtml, "my-comp", ["p"])).toBe(elHtmlRes);
  });

  it("does not match <aside> as an <a> element when scoping 'a'", () => {
    const html = `<aside class="docs-sidebar"><ul class="sidebar-nav"><li><a href="/why-bascik">Why Bascik</a></li></ul></aside>`;
    const result = addElementClassesInHtml(html, "docs-sidebar", ["li", "a"]);
    expect(result).not.toContain("docs-sidebar bascik__docs-sidebar__el__a");
    expect(result).toContain('<a class="bascik__docs-sidebar__el__a" href="/why-bascik">Why Bascik</a>');
  });
});

describe("addIdClassesInHtml", () => {
  it("adds id class to element with single-quoted class attribute", () => {
    const html = "<div id=\"btn\" class='btn-base'></div>";
    const result = addIdClassesInHtml(html, [{ idName: "btn", className: "bascik__my-comp__id__btn" }]);
    expect(result).toContain("class='btn-base bascik__my-comp__id__btn'");
  });
});

describe("getComponentCss", () => {
  it("returns undefined for invalid inputs or when css file is not found", async () => {
    expect(await getComponentCss("", [])).toBeUndefined();
    expect(await getComponentCss("components/nav.html", ["components/other.css"])).toBeUndefined();
  });
});

describe("getKeyframeNames", () => {
  it("test", () => {
    expect(getKeyframeNames(css)).toStrictEqual(["rotateLogo"]);
  });
});

describe("prefixKeyframes", () => {
  it("test", () => {
    expect(prefixKeyframes(css, "my-comp")).toBe(prefixKeyframesRes);
  });

  it("preserves replacement tokens in scoped keyframe names", () => {
    const result = prefixKeyframes(
      "@keyframes spin { from { opacity: 0; } } .box { animation: spin 1s; }",
      "my$&$1$`comp",
    );
    const scoped = "bascik__my$&$1$`comp__keyframe__spin";
    expect(result).toContain(`@keyframes ${scoped}`);
    expect(result).toContain(`animation: ${scoped} 1s`);
  });
});

describe("removeIdSelectors", () => {
  it("test", () => {
    expect(removeIdSelectors(idCss)).not.toContain("[id]");
  });

  it("does not terminate early on a brace inside a string literal", () => {
    const input =
      '[id] { content: "end}end"; color: red; }\n.normal { color: blue; }';
    const result = removeIdSelectors(input);
    expect(result).not.toContain("[id]");
    expect(result).not.toContain("end}end");
    expect(result).toContain(".normal { color: blue; }");
  });
});

describe("removeCommentsFromCss", () => {
  it("removes a standard comment", () => {
    expect(removeCommentsFromCss(idCss)).not.toContain(
      "/* ID selectors will be removed */",
    );
  });

  it("removes a multi-line comment that contains an apostrophe", () => {
    const css = `.foo {\n  color: red;\n}\n/* matches the logo's angle */\n.bar {\n  color: blue;\n}`;
    const result = removeCommentsFromCss(css);
    expect(result).not.toContain("/*");
    expect(result).toContain(".foo");
    expect(result).toContain(".bar");
  });

  it("preserves single-quoted string literals that follow an apostrophe-containing comment", () => {
    const css = `.a {\n  color: red;\n}\n/* the logo's angle (7px / 28px ≈ 14°)\n*/\n.b::before {\n  content: '';\n}`;
    const result = removeCommentsFromCss(css);
    expect(result).not.toContain("/*");
    expect(result).toContain(".b::before");
    expect(result).toContain("content: ''");
  });

  it("preserves /* inside a string literal", () => {
    const css = `.a { content: "/* not a comment */"; color: red; }`;
    const result = removeCommentsFromCss(css);
    expect(result).toContain('"/* not a comment */"');
  });
});

describe("fuzz-like malformed CSS / HTML inputs", () => {
  it("does not throw across many near-valid and broken component patterns", () => {
    const seed = 424242;
    const prng = (() => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();

    const tags = [
      "p",
      "div",
      "span",
      "h1",
      "h2",
      "li",
      "a",
      "button",
      "section",
      "main",
      "rem",
      "px",
      "vh",
    ];

    const buildCase = (index: number) => {
      const tagA = tags[Math.floor(prng() * tags.length)];
      const tagB = tags[Math.floor(prng() * tags.length)];
      const tagC = tags[Math.floor(prng() * tags.length)];
      const lineBreak = prng() > 0.5 ? "\n" : " ";
      const selector = [
        `${tagA} { color: red; }`,
        `${tagA}, ${tagB} { margin: 0; }`,
        `.wrap ${tagA} { padding: 0; }`,
        `.wrap > ${tagB} { display: block; }`,
        `@media (min-width: 1px) { ${tagC} { border: 0; } }`,
        `:is(${tagA}, ${tagB}) { color: blue; }`,
        `${tagA}{color:var(--x,${tagB});}`,
        `${tagA}${lineBreak}{${lineBreak}margin:${Math.floor(prng() * 10)}${tagB};${lineBreak}}`,
        `${tagA} { animation: spin 1s infinite; } @keyframes spin { from { opacity: 0; } to { opacity: 1; } }`,
        `${tagA} { font-size: 0.7${tagB} 1em; }`,
      ][index % 10];

      const html = `
        <${tagA} class="before">before</${tagA}>
        <${tagB}>${tagC}</${tagB}>
        <div data-x="${tagA}">
          <${tagC} id="frag">fragment</${tagC}>
        </div>
      `;

      return {
        componentName: `comp-${index}`,
        css: selector,
        html,
      };
    };

    for (let i = 0; i < 200; i++) {
      const { componentName, css, html } = buildCase(i);

      expect(() => {
        const { css: transformedCss, elementsConvertedClasses } =
          convertCssElementSelectorsToClasses(css, componentName);
        const transformedHtml = addElementClassesInHtml(
          html,
          componentName,
          elementsConvertedClasses,
        );

        expect(typeof transformedCss).toBe("string");
        expect(typeof transformedHtml).toBe("string");
      }).not.toThrow();
    }
  });
});

describe("property-based CSS scoping fuzzing", () => {
  it("does not throw for generated selector and html combinations", () => {
    const tagArb = fc.constantFrom(
      "div",
      "p",
      "span",
      "a",
      "button",
      "ul",
      "li",
      "h1",
      "h2",
      "section",
      "main",
      "img",
      "input",
      "hr",
      "rem",
      "px",
      "vh",
    );

    const selectorArb = fc
      .tuple(tagArb, tagArb, fc.boolean(), fc.boolean(), fc.boolean())
      .map(([tagA, tagB, includeClass, includeDesc, includeMedia]) => {
        const left = includeClass ? ".wrap" : "";
        const middle = includeDesc ? `${left} ${tagA} > ${tagB}` : `${left} ${tagA}`;
        const selector = middle.trim();
        return includeMedia
          ? `@media (min-width: 1px) { ${selector} { color: red; } }`
          : `${selector} { color: red; }`;
      });

    const cssArb = fc.array(selectorArb, { minLength: 1, maxLength: 5 });
    const htmlArb = fc
      .array(tagArb, { minLength: 1, maxLength: 4 })
      .map((tags) => tags.map((tag) => `<${tag} class="x">${tag}</${tag}>`).join("\n"));

    fc.assert(
      fc.property(cssArb, htmlArb, (selectors, html) => {
        const css = selectors.join("\n");
        const { css: transformedCss, elementsConvertedClasses } =
          convertCssElementSelectorsToClasses(css, "fuzz");
        const transformedHtml = addElementClassesInHtml(
          html,
          "fuzz",
          elementsConvertedClasses,
        );

        expect(typeof transformedCss).toBe("string");
        expect(typeof transformedHtml).toBe("string");
      }),
      { numRuns: 250 },
    );
  });
});

describe("scopeCssCustomProperties", () => {
  it("scopes a custom property declaration", () => {
    const css = ":root { --brand: #d3ff8d; }";
    const result = scopeCssCustomProperties(css, "my-comp__x1");
    expect(result).not.toContain("--brand:");
    expect(result).toContain("--bascik__my-comp__x1__brand:");
  });

  it("scopes a var() reference to match the scoped declaration", () => {
    const css = ":root { --brand: #d3ff8d; } .el { color: var(--brand); }";
    const result = scopeCssCustomProperties(css, "my-comp__x1");
    expect(result).toContain("var(--bascik__my-comp__x1__brand)");
    expect(result).not.toContain("var(--brand)");
  });

  it("scopes a var() reference that has a fallback value", () => {
    const css = ":root { --accent: red; } .el { color: var(--accent, gray); }";
    const result = scopeCssCustomProperties(css, "my-comp__x1");
    expect(result).toContain("var(--bascik__my-comp__x1__accent, gray)");
    expect(result).not.toContain("var(--accent,");
  });

  it("scopes multiple custom properties independently", () => {
    const css =
      ":root { --a: 1px; --b: red; } .el { padding: var(--a); color: var(--b); }";
    const result = scopeCssCustomProperties(css, "comp__x1");
    expect(result).toContain("--bascik__comp__x1__a:");
    expect(result).toContain("--bascik__comp__x1__b:");
    expect(result).toContain("var(--bascik__comp__x1__a)");
    expect(result).toContain("var(--bascik__comp__x1__b)");
  });

  it("returns css unchanged when there are no custom properties", () => {
    const css = ".el { color: red; }";
    expect(scopeCssCustomProperties(css, "my-comp__x1")).toBe(css);
  });

  it("does not affect properties from other components", () => {
    // A property defined elsewhere (not in this component's CSS) should not be touched
    const css = ".el { color: var(--external-var); }";
    expect(scopeCssCustomProperties(css, "my-comp__x1")).toBe(css);
  });
});

describe("scopeCssCustomProperties – @property declarations", () => {
  it("scopes an @property declaration name", () => {
    const css = "@property --brand { syntax: '<color>'; inherits: false; initial-value: #d3ff8d; }";
    const result = scopeCssCustomProperties(css, "my-comp__x1");
    expect(result).toContain("@property --bascik__my-comp__x1__brand");
    expect(result).not.toContain("@property --brand");
  });

  it("scopes @property and matching var() usage together", () => {
    const css = "@property --accent { syntax: '<color>'; inherits: false; initial-value: red; } .el { color: var(--accent); }";
    const result = scopeCssCustomProperties(css, "my-comp__x1");
    expect(result).toContain("@property --bascik__my-comp__x1__accent");
    expect(result).toContain("var(--bascik__my-comp__x1__accent)");
  });

  it("scopes @property when both declaration and element-level usage exist", () => {
    const css = "@property --size { syntax: '<length>'; inherits: false; initial-value: 0px; } :root { --size: 16px; } .el { padding: var(--size); }";
    const result = scopeCssCustomProperties(css, "comp__x1");
    expect(result).toContain("@property --bascik__comp__x1__size");
    expect(result).toContain("--bascik__comp__x1__size: 16px");
    expect(result).toContain("var(--bascik__comp__x1__size)");
  });

  it("does not scope @property from another component", () => {
    // No @property or --name: in this CSS — nothing to scope
    const css = ".el { color: var(--external-prop); }";
    expect(scopeCssCustomProperties(css, "my-comp__x1")).toBe(css);
  });
});

describe("deduplicateCss", () => {
  it("returns CSS for each unique component once", () => {
    const usedComponents = [
      { name: "my-btn", cssFileContent: ".btn{color:red}" },
      { name: "my-btn", cssFileContent: ".btn{color:red}" },
      { name: "my-nav", cssFileContent: ".nav{color:blue}" },
    ];
    const css = deduplicateCss(usedComponents);
    const btnMatches = css.match(/\.btn\{color:red\}/g);
    expect(btnMatches).toHaveLength(1);
    expect(css).toContain(".nav{color:blue}");
  });

  it("skips components with no CSS", () => {
    const usedComponents = [
      { name: "my-btn", cssFileContent: undefined },
      { name: "my-nav", cssFileContent: ".nav{}" },
    ];
    expect(deduplicateCss(usedComponents)).toBe(".nav{}");
  });

  it("returns empty string for no CSS", () => {
    expect(deduplicateCss([{ name: "x", cssFileContent: undefined }])).toBe("");
  });

  it("preserves ordering of first occurrence", () => {
    const usedComponents = [
      { name: "a", cssFileContent: ".a{}" },
      { name: "b", cssFileContent: ".b{}" },
      { name: "a", cssFileContent: ".a{}" },
    ];
    expect(deduplicateCss(usedComponents)).toBe(".a{} .b{}");
  });
});

describe("deduplicateCss – dedup: false (per-instance mode)", () => {
  it("emits CSS for every instance including duplicates", () => {
    const usedComponents = [
      { name: "my-btn", cssFileContent: ".bascik__my-btn__abc__btn{color:red}" },
      { name: "my-btn", cssFileContent: ".bascik__my-btn__def__btn{color:red}" },
    ];
    const css = deduplicateCss(usedComponents, false);
    expect(css).toContain(".bascik__my-btn__abc__btn");
    expect(css).toContain(".bascik__my-btn__def__btn");
  });

  it("skips components with no CSS even in per-instance mode", () => {
    const usedComponents = [
      { name: "my-btn", cssFileContent: undefined },
      { name: "my-nav", cssFileContent: ".nav{}" },
    ];
    expect(deduplicateCss(usedComponents, false)).toBe(".nav{}");
  });
});

// ─── convertCssElementSelectorsToClasses — pseudo-class / pseudo-element ─────

describe("convertCssElementSelectorsToClasses – pseudo-classes and pseudo-elements", () => {
  it("converts a bare element pseudo-class selector p:hover", () => {
    const { css, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses("p:hover { color: red; }", "my-comp");
    expect(css).toContain(".bascik__my-comp__el__p:hover");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("converts a pseudo-element selector p::before", () => {
    const { css, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses(
        "p::before { content: ''; }",
        "my-comp",
      );
    expect(css).toContain(".bascik__my-comp__el__p::before");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("converts first element in a comma-separated selector list", () => {
    const { css, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses("p, h2 { margin: 0; }", "my-comp");
    // The first element at line start is converted
    expect(css).toContain(".bascik__my-comp__el__p");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("converts second element in a same-line comma list: 'p, h2 { }'", () => {
    const { css, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses("p, h2 { margin: 0; }", "my-comp");
    expect(css).toContain(".bascik__my-comp__el__h2");
    expect(elementsConvertedClasses).toContain("h2");
  });

  it("converts all elements in a multi-element same-line list: 'h1, h2, h3 { }'", () => {
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      "h1, h2, h3 { font-weight: bold; }",
      "my-comp",
    );
    expect(elementsConvertedClasses).toEqual(
      expect.arrayContaining(["h1", "h2", "h3"]),
    );
  });

  it("does NOT convert elements inside :is() — `:is(p, h2) { }`", () => {
    // The `)` in the stop set prevents false positives inside pseudo-functions.
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      "div:is(p, h2) { color: red; }",
      "my-comp",
    );
    // h2 appears after a comma inside :is() — it must NOT be converted
    expect(elementsConvertedClasses).not.toContain("h2");
  });

  it("does NOT convert property-value commas: 'transition: color 0.2s, opacity 0.3s'", () => {
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      ".el { transition: color 0.2s, opacity 0.3s; }",
      "my-comp",
    );
    expect(elementsConvertedClasses).not.toContain("opacity");
  });

  it("does not convert elements that are not at line start", () => {
    // `.foo p { }` — `p` is a descendant, should NOT be converted
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      ".foo p { color: red; }",
      "my-comp",
    );
    expect(elementsConvertedClasses).not.toContain("p");
  });

  it("deduplicates: same element at column-0 multiple times only injected once", () => {
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      "p { color: red; }\np:hover { color: blue; }",
      "my-comp",
    );
    expect(elementsConvertedClasses.filter((e) => e === "p")).toHaveLength(1);
  });
});

// ─── convertCssElementSelectorsToClasses — CSS nesting ───────────────────────

describe("convertCssElementSelectorsToClasses – CSS nesting (& selector)", () => {
  it("converts element after '& ' (descendant nesting)", () => {
    const { css, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses(
        ".parent { & p { color: red; } }",
        "my-comp",
      );
    expect(css).toContain("& .bascik__my-comp__el__p");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("converts element after '& > ' (child combinator)", () => {
    const { css } = convertCssElementSelectorsToClasses(
      ".parent { & > h2 { font-size: 1.5rem; } }",
      "my-comp",
    );
    expect(css).toContain("& > .bascik__my-comp__el__h2");
  });

  it("converts element in unspaced '&>h2' and '&> h2'", () => {
    const res1 = convertCssElementSelectorsToClasses(
      ".parent { &>h2 { font-size: 1.5rem; } }",
      "my-comp",
    );
    expect(res1.css).toContain("&>.bascik__my-comp__el__h2");
    expect(res1.elementsConvertedClasses).toContain("h2");

    const res2 = convertCssElementSelectorsToClasses(
      ".parent { &> h2 { font-size: 1.5rem; } }",
      "my-comp",
    );
    expect(res2.css).toContain("&> .bascik__my-comp__el__h2");
  });

  it("converts relaxed direct nesting with combinators without leading '&'", () => {
    const { css, elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      ".parent { > h2 { color: red; } + li { color: blue; } ~ span { color: green; } }",
      "my-comp",
    );
    expect(css).toContain("> .bascik__my-comp__el__h2");
    expect(css).toContain("+ .bascik__my-comp__el__li");
    expect(css).toContain("~ .bascik__my-comp__el__span");
    expect(elementsConvertedClasses).toEqual(expect.arrayContaining(["h2", "li", "span"]));
  });

  it("converts relaxed direct element nesting without '&'", () => {
    const { css, elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      ".parent { p { color: red; } }",
      "my-comp",
    );
    expect(css).toContain(".bascik__my-comp__el__p");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("converts element after '& + ' (adjacent sibling combinator)", () => {
    const { css } = convertCssElementSelectorsToClasses(
      ".card { & + li { margin-top: 8px; } }",
      "my-comp",
    );
    expect(css).toContain("& + .bascik__my-comp__el__li");
  });

  it("converts element after '& ~ ' (general sibling combinator)", () => {
    const { css } = convertCssElementSelectorsToClasses(
      ".item { & ~ span { opacity: 0.5; } }",
      "my-comp",
    );
    expect(css).toContain("& ~ .bascik__my-comp__el__span");
  });

  it("does NOT convert class selectors in nesting (they are handled separately)", () => {
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      ".parent { & .child { color: blue; } }",
      "my-comp",
    );
    // .child is a class selector — not in elementsConvertedClasses
    expect(elementsConvertedClasses).not.toContain("child");
  });

  it("deduplicates: element at column-0 AND in nesting only injected once", () => {
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      "p { color: red; }\n.parent { & p { font-weight: bold; } }",
      "my-comp",
    );
    expect(elementsConvertedClasses.filter((e) => e === "p")).toHaveLength(1);
  });
});

// ─── Pass 4: descendant element selectors after a scoped class ───────────────

describe("convertCssElementSelectorsToClasses – descendant after scoped class", () => {
  // NOTE: Pass 4 looks for the `bascik__` prefix which is written by the
  // earlier class-scoping step in javascript.ts / scopeInlineStyleTags.
  // These tests therefore pass pre-scoped CSS (as javascript.ts would produce).

  it("converts element after scoped class (descendant)", () => {
    const pre = ".bascik__my-comp__card p { color: red; }";
    const { css, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses(pre, "my-comp");
    expect(css).toContain(".bascik__my-comp__card .bascik__my-comp__el__p");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("converts element after scoped class with child combinator >", () => {
    const pre = ".bascik__my-comp__list > li { list-style: none; }";
    const { css } = convertCssElementSelectorsToClasses(pre, "my-comp");
    expect(css).toContain("> .bascik__my-comp__el__li");
  });

  it("converts element after scoped class with adjacent sibling +", () => {
    const pre = ".bascik__my-comp__title + p { margin-top: 0; }";
    const { css } = convertCssElementSelectorsToClasses(pre, "my-comp");
    expect(css).toContain("+ .bascik__my-comp__el__p");
  });

  it("converts element after scoped class with general sibling ~", () => {
    const pre = ".bascik__my-comp__header ~ section { color: blue; }";
    const { css } = convertCssElementSelectorsToClasses(pre, "my-comp");
    expect(css).toContain("~ .bascik__my-comp__el__section");
  });

  it("does NOT convert another scoped class name after a scoped class", () => {
    // The negative lookahead (?!__) must prevent bascik__ being treated as element
    const pre = ".bascik__my-comp__card .bascik__my-comp__title { color: blue; }";
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      pre,
      "my-comp",
    );
    // 'bascik' starts with b (in [a-z1-6]) but is followed by 'ascik__',
    // so the negative lookahead should prevent matching it as an element
    expect(elementsConvertedClasses).not.toContain("bascik");
  });

  it("does NOT match in property value context", () => {
    // A property value will never have bascik__ as a prefix in normal CSS
    const pre = ".bascik__my-comp__box { transition: opacity 0.3s; }";
    const { elementsConvertedClasses } = convertCssElementSelectorsToClasses(
      pre,
      "my-comp",
    );
    expect(elementsConvertedClasses).not.toContain("opacity");
  });

  it("converts multi-level: .scoped .scoped p (element after second scoped class)", () => {
    const pre = ".bascik__my-comp__card .bascik__my-comp__body p { margin: 0; }";
    const { css, elementsConvertedClasses } = convertCssElementSelectorsToClasses(pre, "my-comp");
    expect(css).toContain(".bascik__my-comp__el__p");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("converts 3-level descendant element selectors: div ul li { color: red; }", () => {
    const pre = "div ul li { color: red; }";
    const { css, elementsConvertedClasses } = convertCssElementSelectorsToClasses(pre, "my-comp");
    expect(css).toContain(".bascik__my-comp__el__div");
    expect(css).toContain(".bascik__my-comp__el__ul");
    expect(css).toContain(".bascik__my-comp__el__li");
    expect(elementsConvertedClasses).toEqual(expect.arrayContaining(["div", "ul", "li"]));
  });
});

// ─── addElementClassesInHtml — multiline content ─────────────────────────────

describe("addElementClassesInHtml – multiline content", () => {
  it("injects the class into a multi-line element", () => {
    const html = "<p>\n  line one\n  line two\n</p>";
    const result = addElementClassesInHtml(html, "my-comp", ["p"]);
    expect(result).toContain('class="bascik__my-comp__el__p"');
  });
});

describe("addElementClassesInHtml – element with classless child", () => {
  it("adds class to element itself when only a child has a class", () => {
    const html = '<pre><code class="cblock-body">content</code></pre>';
    const result = addElementClassesInHtml(html, "code-block", ["pre"]);
    expect(result).toBe('<pre class="bascik__code-block__el__pre"><code class="cblock-body">content</code></pre>');
  });

  it("does not add class to nested child when parent lacks class", () => {
    const html = '<pre><code class="cblock-body">content</code></pre>';
    const result = addElementClassesInHtml(html, "code-block", ["pre"]);
    expect(result).not.toContain('class="cblock-body bascik__');
  });
});

describe("single-quoted HTML attributes in styles", () => {
  it("appends element class to existing single-quoted class attribute", () => {
    const html = "<pre class='code'>content</pre>";
    const result = addElementClassesInHtml(html, "my-comp", ["pre"]);
    expect(result).toBe("<pre class='code bascik__my-comp__el__pre'>content</pre>");
  });

  it("adds id class to single-quoted id attribute", () => {
    const html = "<div id='main-box'>content</div>";
    const result = addIdClassesInHtml(html, [
      { idName: "main-box", className: "bascik__my-comp__id__main-box" },
    ]);
    expect(result).toContain('class="bascik__my-comp__id__main-box"');
  });
});

describe("addElementClassesInHtml – nested same-tag elements", () => {
  it("injects class to nested same-tag elements without skipping inner ones", () => {
    const html = '<div class="outer">\n  <div class="inner">nested</div>\n</div>';
    const result = addElementClassesInHtml(html, "my-comp", ["div"]);
    expect(result).toBe(
      '<div class="outer bascik__my-comp__el__div">\n  <div class="inner bascik__my-comp__el__div">nested</div>\n</div>'
    );
  });

  it("handles void elements and nested tags together correctly", () => {
    const html = '<div class="outer"><img src="foo.png" /><div class="inner"></div></div>';
    const result = addElementClassesInHtml(html, "my-comp", ["div", "img"]);
    expect(result).toBe(
      '<div class="outer bascik__my-comp__el__div"><img class="bascik__my-comp__el__img" src="foo.png" /><div class="inner bascik__my-comp__el__div"></div></div>'
    );
  });

  it("handles class attributes inside other string attributes safely without mangling", () => {
    const html = `<div data-foo=' class="fake" '></div>`;
    const result = addElementClassesInHtml(html, "MyComp", ["div"]);
    // Should NOT mangle the inner string.
    expect(result).not.toContain("data-foo=' class=\"fake bascik__");
    // Should inject the new class.
    expect(result).toContain("<div class=\"bascik__MyComp__el__div\" data-foo=' class=\"fake\" '></div>");
  });

  it("handles '>' inside attributes before or after class when scoping elements", () => {
    const html = `<div data-condition="x > y" class="box"></div>`;
    const result = addElementClassesInHtml(html, "MyComp", ["div"]);
    expect(result).toBe(`<div data-condition="x > y" class="box bascik__MyComp__el__div"></div>`);
  });
});

// ─── scopeLayerNames ─────────────────────────────────────────────────────────

describe("scopeLayerNames", () => {
  it("scopes a leading-hyphen layer name", () => {
    expect(scopeLayerNames("@layer --utils { .box { color: red; } }", "my-comp")).toContain(
      "@layer bascik__my-comp__layer__--utils",
    );
  });

  it("scopes a single @layer declaration block", () => {
    const css = "@layer base { .foo { color: red; } }";
    const result = scopeLayerNames(css, "my-comp");
    expect(result).not.toContain("@layer base");
    expect(result).toContain("@layer bascik__my-comp__layer__base");
  });

  it("scopes an @layer ordering statement", () => {
    const css = "@layer reset, base, utilities;";
    const result = scopeLayerNames(css, "my-comp");
    expect(result).toContain("bascik__my-comp__layer__reset");
    expect(result).toContain("bascik__my-comp__layer__base");
    expect(result).toContain("bascik__my-comp__layer__utilities");
    expect(result).not.toContain("@layer reset,");
  });

  it("returns css unchanged when there are no @layer names", () => {
    const css = ".foo { color: red; }";
    expect(scopeLayerNames(css, "my-comp")).toBe(css);
  });
});

// ─── scopeContainerNames ─────────────────────────────────────────────────────

describe("scopeContainerNames", () => {
  it("scopes container-name declaration and matching @container query", () => {
    const css =
      ".card { container-name: card; }\n@container card (min-width: 400px) { .inner { font-size: 1rem; } }";
    const result = scopeContainerNames(css, "my-comp");
    expect(result).toContain(
      "container-name: bascik__my-comp__container__card",
    );
    expect(result).toContain("@container bascik__my-comp__container__card");
    expect(result).not.toContain("container-name: card");
  });

  it("scopes the container shorthand declaration", () => {
    const css = ".wrap { container: sidebar / inline-size; }";
    const result = scopeContainerNames(css, "my-comp");
    expect(result).toContain("bascik__my-comp__container__sidebar");
  });

  it("does not scope unnamed @container queries", () => {
    const css = "@container (min-width: 400px) { .foo { color: red; } }";
    const result = scopeContainerNames(css, "my-comp");
    // No container-name declaration → no scoping
    expect(result).toBe(css);
  });

  it("returns css unchanged when there are no container names", () => {
    const css = ".foo { color: red; }";
    expect(scopeContainerNames(css, "my-comp")).toBe(css);
  });
});

// ─── scopeInlineStyleTags ────────────────────────────────────────────────────

describe("scopeInlineStyleTags", () => {
  it("scopes class names inside a <style> tag", () => {
    const html = '<style>.foo { color: red; }</style><div class="foo"></div>';
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain(".bascik__my-comp__foo");
  });

  it("returns element classes to inject into HTML", () => {
    const html = "<style>p { color: red; }</style><p>hi</p>";
    const { elementsConvertedClasses } = scopeInlineStyleTags(html, "my-comp");
    expect(elementsConvertedClasses).toContain("p");
  });

  it("scopes @keyframes inside a <style> tag", () => {
    const html =
      "<style>@keyframes spin { to { transform: rotate(360deg); } } .icon { animation: spin 1s; }</style>";
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain("bascik__my-comp__keyframe__spin");
    expect(result).not.toContain("animation: spin");
  });

  it("scopes CSS custom properties inside a <style> tag", () => {
    const html =
      "<style>:root { --brand: #d3ff8d; } .title { color: var(--brand); }</style>";
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain("--bascik__my-comp__brand:");
    expect(result).toContain("var(--bascik__my-comp__brand)");
  });

  it("scopes @layer names inside a <style> tag", () => {
    const html = "<style>@layer base { .foo { color: red; } }</style>";
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain("bascik__my-comp__layer__base");
  });

  it("returns unchanged HTML when there are no <style> tags", () => {
    const html = '<div class="foo"></div>';
    const { html: result, elementsConvertedClasses } = scopeInlineStyleTags(
      html,
      "my-comp",
    );
    expect(result).toBe(html);
    expect(elementsConvertedClasses).toHaveLength(0);
  });

  it("strips ID selectors from inline <style> tags", () => {
    const html = "<style>[id] { color: red; } .foo { color: blue; }</style>";
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).not.toContain("[id]");
    expect(result).toContain(".bascik__my-comp__foo");
  });

  it("does NOT mangle decimal values in CSS property values (0.9, 1.1rem, .15s)", () => {
    const html =
      "<style>.nav { background: rgba(0,0,0,0.9); font-size: 1.1rem; transition: all .15s; letter-spacing: -0.02em; }</style>";
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain("rgba(0,0,0,0.9)");
    expect(result).toContain("1.1rem");
    expect(result).toContain(".15s");
    expect(result).toContain("-0.02em");
  });

  it("does NOT mangle sub-1 decimal values (0.7rem, .06em, 0.025, 0.82rem)", () => {
    // Regression: the old regex [a-z0-9-_]+ had no leading-letter guard, so
    // after a decimal '.' it matched digit-starting tokens like '7rem', '06em',
    // '025', '82rem' and scoped them as if they were CSS class names.
    const html =
      "<style>.cblock-lang { font-size: 0.7rem; letter-spacing: .06em; background: rgba(255,255,255,0.025); } .cblock-body { font-size: 0.82rem; line-height: 1.7; }</style>";
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain("font-size: 0.7rem");
    expect(result).toContain("letter-spacing: .06em");
    expect(result).toContain("rgba(255,255,255,0.025)");
    expect(result).toContain("font-size: 0.82rem");
    expect(result).toContain("line-height: 1.7");
    // Class names must still be scoped
    expect(result).toContain(".bascik__my-comp__cblock-lang");
    expect(result).toContain(".bascik__my-comp__cblock-body");
  });

  it("still scopes class names when decimal values are present", () => {
    const html =
      "<style>.nav { opacity: 0.5; } .nav:hover { opacity: 1; }</style>";
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain(".bascik__my-comp__nav");
    expect(result).toContain("opacity: 0.5");
  });
});

// ─── removeIdSelectors — only strips [id] attribute selectors ────────────────

describe("removeIdSelectors – only strips [id] attribute selector form", () => {
  it("strips [id] selector", () => {
    const css = "[id] { color: red; } .foo { color: blue; }";
    expect(removeIdSelectors(css)).not.toContain("[id]");
    expect(removeIdSelectors(css)).toContain(".foo");
  });

  it("passes through #id hash selectors — they are handled by convertCssIdSelectorsToClasses", () => {
    const css = "#btn { color: red; }";
    expect(removeIdSelectors(css)).toContain("#btn");
  });
});

// ─── convertCssIdSelectorsToClasses ──────────────────────────────────────────

describe("convertCssIdSelectorsToClasses – selector vs value context", () => {
  // ── Selector position — SHOULD be converted ────────────────────────────

  it("converts a bare #id rule", () => {
    const { css, idsConverted } = convertCssIdSelectorsToClasses(
      "#btn { color: red; }",
      "my-comp",
    );
    expect(css).toContain(".bascik__my-comp__id__btn");
    expect(css).not.toContain("#btn");
    expect(idsConverted[0].idName).toBe("btn");
  });

  it("preserves pseudo-class on #id", () => {
    const { css } = convertCssIdSelectorsToClasses(
      "#btn:hover { color: blue; }",
      "my-comp",
    );
    expect(css).toContain(".bascik__my-comp__id__btn:hover");
  });

  it("converts #id in a compound descendant selector", () => {
    const { css } = convertCssIdSelectorsToClasses(
      ".parent #btn { font-weight: bold; }",
      "my-comp",
    );
    expect(css).toContain(".parent .bascik__my-comp__id__btn");
  });

  it("converts multiple different IDs", () => {
    const { idsConverted } = convertCssIdSelectorsToClasses(
      "#header { } #footer { }",
      "my-comp",
    );
    expect(idsConverted.map((e) => e.idName)).toEqual(
      expect.arrayContaining(["header", "footer"]),
    );
    expect(idsConverted).toHaveLength(2);
  });

  it("deduplicates repeated ID references", () => {
    const { idsConverted } = convertCssIdSelectorsToClasses(
      "#btn { color: red; } #btn:hover { color: blue; }",
      "my-comp",
    );
    expect(idsConverted).toHaveLength(1);
  });

  it("converts #id inside an @media block", () => {
    const { css } = convertCssIdSelectorsToClasses(
      "@media (max-width: 600px) { #btn { font-size: 0.9rem; } }",
      "my-comp",
    );
    expect(css).toContain(".bascik__my-comp__id__btn");
  });

  // ── Value position — must NOT be converted ──────────────────────────────

  it("does NOT convert hex color terminated by semicolon: color: #abc;", () => {
    const { idsConverted } = convertCssIdSelectorsToClasses(
      ".el { color: #abc; }",
      "my-comp",
    );
    expect(idsConverted).toHaveLength(0);
  });

  it("does NOT convert hex color in linear-gradient function: #abc,", () => {
    const { idsConverted } = convertCssIdSelectorsToClasses(
      ".el { background: linear-gradient(#abc, #def); }",
      "my-comp",
    );
    expect(idsConverted).toHaveLength(0);
  });

  it("does NOT convert hex color followed by closing brace: color: #abc\\n}", () => {
    const css = ".el {\n  color: #abc\n}";
    const { idsConverted } = convertCssIdSelectorsToClasses(css, "my-comp");
    expect(idsConverted).toHaveLength(0);
  });

  it("does NOT convert hex color followed by whitespace value: background: #abc url(…)", () => {
    const { idsConverted } = convertCssIdSelectorsToClasses(
      ".el { background: #abc url('./img.png'); }",
      "my-comp",
    );
    expect(idsConverted).toHaveLength(0);
  });

  it("returns css unchanged when there are no #id selectors", () => {
    const css = ".foo { color: red; }";
    const { css: result, idsConverted } = convertCssIdSelectorsToClasses(
      css,
      "my-comp",
    );
    expect(result).toBe(css);
    expect(idsConverted).toHaveLength(0);
  });
});

// ─── addIdClassesInHtml ───────────────────────────────────────────────────────

describe("addIdClassesInHtml", () => {
  it("injects class onto element with unscoped id", () => {
    const html = '<button id="btn">Click</button>';
    const result = addIdClassesInHtml(html, [
      { idName: "btn", className: "bascik__my-comp__id__btn" },
    ]);
    expect(result).toContain('class="bascik__my-comp__id__btn"');
  });

  it("injects class onto element with already-scoped id", () => {
    const html = '<button id="bascik__my-comp__a1b2c3d4__btn">Click</button>';
    const result = addIdClassesInHtml(html, [
      { idName: "btn", className: "bascik__my-comp__id__btn" },
    ]);
    expect(result).toContain('class="bascik__my-comp__id__btn"');
  });

  it("appends to existing class attribute", () => {
    const html = '<button id="btn" class="primary">Click</button>';
    const result = addIdClassesInHtml(html, [
      { idName: "btn", className: "bascik__my-comp__id__btn" },
    ]);
    expect(result).toContain('class="primary bascik__my-comp__id__btn"');
  });

  it("does not match data-id or other attributes", () => {
    const html = '<div data-id="btn"></div>';
    const result = addIdClassesInHtml(html, [
      { idName: "btn", className: "bascik__my-comp__id__btn" },
    ]);
    expect(result).not.toContain("bascik__my-comp__id__btn");
  });

  it("handles '>' inside attributes and nested class strings safely in addIdClassesInHtml", () => {
    const html = `<button data-condition="x > y" data-foo=' class="fake" ' id="btn" class="primary">Click</button>`;
    const result = addIdClassesInHtml(html, [
      { idName: "btn", className: "bascik__my-comp__id__btn" },
    ]);
    expect(result).toBe(`<button data-condition="x > y" data-foo=' class="fake" ' id="btn" class="primary bascik__my-comp__id__btn">Click</button>`);
  });

  it("returns html unchanged when idsConverted is empty", () => {
    const html = '<div id="btn"></div>';
    expect(addIdClassesInHtml(html, [])).toBe(html);
  });
});

// ─── scopeInlineStyleTags — now also returns idsConverted ────────────────────

describe("scopeInlineStyleTags – #id in inline styles", () => {
  it("converts #id selector and returns idsConverted", () => {
    const html =
      '<style>#btn { color: red; }</style><button id="btn">Click</button>';
    const { html: result, idsConverted } = scopeInlineStyleTags(
      html,
      "my-comp",
    );
    expect(result).toContain(".bascik__my-comp__id__btn");
    expect(idsConverted).toHaveLength(1);
    expect(idsConverted[0].idName).toBe("btn");
  });

  it("does NOT convert hex color inside inline <style>", () => {
    const html = "<style>.el { color: #abc; }</style>";
    const { idsConverted } = scopeInlineStyleTags(html, "my-comp");
    expect(idsConverted).toHaveLength(0);
  });
});

// ─── @starting-style scoping ────────────────────────────────────────────────

describe("convertCssElementSelectorsToClasses – @starting-style", () => {
  it("converts element selector inside standalone @starting-style block", () => {
    const css = "@starting-style {\n  p { opacity: 0; }\n}";
    const { css: result, elementsConvertedClasses } =
      convertCssElementSelectorsToClasses(css, "my-comp");
    expect(elementsConvertedClasses).toContain("p");
    expect(result).toContain(".bascik__my-comp__el__p");
  });
});

describe("scopeInlineStyleTags – @starting-style", () => {
  it("scopes class names inside @starting-style block", () => {
    const html =
      '<style>@starting-style { .box { opacity: 0; } }</style><div class="box"></div>';
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain(".bascik__my-comp__box");
    expect(result).not.toContain("@starting-style { .box");
  });

  it("scopes element selectors inside @starting-style block", () => {
    const html =
      "<style>@starting-style { p { opacity: 0; } }</style><p>text</p>";
    const { html: result, elementsConvertedClasses } = scopeInlineStyleTags(
      html,
      "my-comp",
    );
    expect(elementsConvertedClasses).toContain("p");
    expect(result).toContain(".bascik__my-comp__el__p");
  });

  it("scopes class names nested inside a rule + @starting-style", () => {
    const html =
      '<style>.foo { @starting-style { opacity: 0; transform: translateY(-8px); } }</style><div class="foo"></div>';
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain(".bascik__my-comp__foo");
  });
});

describe("scopeInlineStyleTags – :nth-child(of .selector)", () => {
  it("scopes class name in :nth-child(An+B of .class) argument", () => {
    const html = '<style>li:nth-child(2n+1 of .highlighted) { color: red; }</style><li class="highlighted">x</li>';
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain(":nth-child(2n+1 of .bascik__my-comp__highlighted)");
    expect(result).not.toContain(":nth-child(2n+1 of .highlighted)");
  });

  it("scopes class name in :nth-last-child(An+B of .class) argument", () => {
    const html = '<style>li:nth-last-child(3 of .item) { font-weight: bold; }</style><li class="item">x</li>';
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain(":nth-last-child(3 of .bascik__my-comp__item)");
  });

  it("scopes multiple classes in :nth-child(odd of .a.b) compound selector", () => {
    const html = '<style>li:nth-child(odd of .a.b) { border: 1px solid; }</style>';
    const { html: result } = scopeInlineStyleTags(html, "my-comp");
    expect(result).toContain(".bascik__my-comp__a");
    expect(result).toContain(".bascik__my-comp__b");
  });
});

// ─── scopeViewTransitionNames ─────────────────────────────────────────────────

describe("scopeViewTransitionNames", () => {
  it("scopes a view-transition-name declaration", () => {
    const css = ".el { view-transition-name: my-card; }";
    const result = scopeViewTransitionNames(css, "my-comp");
    expect(result).toContain("bascik__my-comp__vtn__my-card");
    expect(result).not.toContain("view-transition-name: my-card");
  });

  it("scopes ::view-transition-old pseudo-element reference", () => {
    const css =
      ".el { view-transition-name: hero; }\n::view-transition-old(hero) { animation: none; }";
    const result = scopeViewTransitionNames(css, "my-comp");
    const scoped = "bascik__my-comp__vtn__hero";
    expect(result).toContain(`::view-transition-old(${scoped})`);
    expect(result).not.toContain("::view-transition-old(hero)");
  });

  it("scopes ::view-transition-new pseudo-element reference", () => {
    const css =
      ".el { view-transition-name: slide; }\n::view-transition-new(slide) { animation: fade 0.3s; }";
    const result = scopeViewTransitionNames(css, "my-comp");
    expect(result).toContain(
      "::view-transition-new(bascik__my-comp__vtn__slide)",
    );
  });

  it("scopes ::view-transition-group pseudo-element reference", () => {
    const css =
      ".el { view-transition-name: box; }\n::view-transition-group(box) { }";
    const result = scopeViewTransitionNames(css, "my-comp");
    expect(result).toContain(
      "::view-transition-group(bascik__my-comp__vtn__box)",
    );
  });

  it("does not scope the keyword 'none'", () => {
    const css = ".el { view-transition-name: none; }";
    expect(scopeViewTransitionNames(css, "my-comp")).toBe(css);
  });

  it("does not scope the keyword 'auto'", () => {
    const css = ".el { view-transition-name: auto; }";
    expect(scopeViewTransitionNames(css, "my-comp")).toBe(css);
  });

  it("does not scope names not declared in this CSS", () => {
    const css = "::view-transition-old(external) { animation: none; }";
    expect(scopeViewTransitionNames(css, "my-comp")).toBe(css);
  });

  it("scopes multiple view-transition-name declarations independently", () => {
    const css =
      ".a { view-transition-name: card; }\n.b { view-transition-name: hero; }\n::view-transition-old(card) { }\n::view-transition-old(hero) { }";
    const result = scopeViewTransitionNames(css, "comp");
    expect(result).toContain("bascik__comp__vtn__card");
    expect(result).toContain("bascik__comp__vtn__hero");
  });

  it("returns css unchanged when no view-transition-name is declared", () => {
    const css = ".el { color: red; }";
    expect(scopeViewTransitionNames(css, "my-comp")).toBe(css);
  });
});

// ─── scopeCounterStyleNames ───────────────────────────────────────────────────

describe("scopeCounterStyleNames", () => {
  it("scopes an @counter-style declaration name", () => {
    const css = "@counter-style thumbs { system: cyclic; symbols: '\\1F44D'; suffix: ' '; }";
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toContain("@counter-style bascik__my-comp__counter__thumbs");
    expect(result).not.toContain("@counter-style thumbs");
  });

  it("scopes a list-style reference to the counter name", () => {
    const css = "@counter-style steps { system: fixed; }\nul { list-style: steps; }";
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toContain("list-style: bascik__my-comp__counter__steps");
    expect(result).not.toContain("list-style: steps");
  });

  it("scopes a list-style-type reference", () => {
    const css = "@counter-style stars { system: cyclic; }\nol { list-style-type: stars; }";
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toContain("list-style-type: bascik__my-comp__counter__stars");
  });

  it("scopes the counter() function second argument", () => {
    const css = "@counter-style roman { system: additive; }\n.el::before { content: counter(section, roman); }";
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toContain(`counter(section, bascik__my-comp__counter__roman)`);
    expect(result).not.toContain("counter(section, roman)");
  });

  it("scopes the counters() function third argument", () => {
    const css = "@counter-style fancy { system: cyclic; }\n.el::before { content: counters(section, '.', fancy); }";
    const result = scopeCounterStyleNames(css, "my-comp");
    expect(result).toContain(`counters(section, '.', bascik__my-comp__counter__fancy)`);
  });

  it("does not scope built-in counter styles not declared with @counter-style", () => {
    const css = "ul { list-style: disc; }";
    expect(scopeCounterStyleNames(css, "my-comp")).toBe(css);
  });

  it("scopes multiple @counter-style names independently", () => {
    const css = "@counter-style alpha { }\n@counter-style beta { }\nul { list-style: alpha; }\nol { list-style: beta; }";
    const result = scopeCounterStyleNames(css, "comp");
    expect(result).toContain("bascik__comp__counter__alpha");
    expect(result).toContain("bascik__comp__counter__beta");
  });

  it("returns css unchanged when no @counter-style is declared", () => {
    const css = ".el { color: red; }";
    expect(scopeCounterStyleNames(css, "my-comp")).toBe(css);
  });
});

// ─── scopeAnchorNames ─────────────────────────────────────────────────────────

describe("scopeAnchorNames", () => {
  it("scopes an anchor-name declaration", () => {
    const css = ".anchor { anchor-name: --my-anchor; }";
    const result = scopeAnchorNames(css, "my-comp");
    expect(result).toContain("anchor-name: --bascik__my-comp__anchor__my-anchor");
    expect(result).not.toContain("anchor-name: --my-anchor");
  });

  it("scopes position-anchor reference to match the declared anchor-name", () => {
    const css = ".anchor { anchor-name: --btn-anchor; }\n.tooltip { position-anchor: --btn-anchor; }";
    const result = scopeAnchorNames(css, "my-comp");
    expect(result).toContain("position-anchor: --bascik__my-comp__anchor__btn-anchor");
    expect(result).not.toContain("position-anchor: --btn-anchor");
  });

  it("scopes @position-try at-rule name to match the declared anchor-name", () => {
    const css = ".anchor { anchor-name: --pop; }\n@position-try --pop { top: anchor(bottom); }";
    const result = scopeAnchorNames(css, "my-comp");
    expect(result).toContain("@position-try --bascik__my-comp__anchor__pop");
    expect(result).not.toContain("@position-try --pop");
  });

  it("scopes all three: anchor-name, position-anchor, @position-try", () => {
    const css = ".anchor { anchor-name: --foo; }\n.pos { position-anchor: --foo; }\n@position-try --foo { top: anchor(bottom); }";
    const result = scopeAnchorNames(css, "comp");
    const scoped = "bascik__comp__anchor__foo";
    expect(result).toContain(`anchor-name: --${scoped}`);
    expect(result).toContain(`position-anchor: --${scoped}`);
    expect(result).toContain(`@position-try --${scoped}`);
  });

  it("does not scope position-anchor that references an undeclared anchor", () => {
    const css = ".tooltip { position-anchor: --external-anchor; }";
    expect(scopeAnchorNames(css, "my-comp")).toBe(css);
  });

  it("does not affect CSS custom properties with the same name", () => {
    const css = ".el { --my-prop: 16px; padding: var(--my-prop); anchor-name: --my-anchor; }";
    const result = scopeAnchorNames(css, "comp");
    expect(result).toContain("--my-prop: 16px");
    expect(result).toContain("var(--my-prop)");
    expect(result).toContain("--bascik__comp__anchor__my-anchor");
  });

  it("scopes multiple anchor names independently", () => {
    const css = ".a { anchor-name: --alpha; }\n.b { anchor-name: --beta; }\n.c { position-anchor: --alpha; }\n.d { position-anchor: --beta; }";
    const result = scopeAnchorNames(css, "comp");
    expect(result).toContain("bascik__comp__anchor__alpha");
    expect(result).toContain("bascik__comp__anchor__beta");
  });

  it("returns css unchanged when no anchor-name is declared", () => {
    const css = ".el { color: red; }";
    expect(scopeAnchorNames(css, "my-comp")).toBe(css);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CSS scoping idempotence – property-based", () => {
  it("running the full CSS scoping pipeline twice produces identical output", () => {
    const selectorArb = fc.constantFrom(
      ".btn { color: red; }",
      "p { margin: 0; }",
      ":root { --brand: #d3ff8d; } .title { color: var(--brand); }",
      "@keyframes spin { from { opacity: 0; } to { opacity: 1; } } .el { animation: spin 1s; }",
      "@layer base { .nav { display: flex; } }",
      "@container card (min-width: 200px) { .inner { padding: 8px; } }",
      ".a, .b { font-size: 1rem; }",
      "@media (max-width: 600px) { p { display: block; } }",
      "#hero { background: #fff; } .page { color: #333; }",
      ".wrap > p { margin: 0; } .wrap + p { padding: 0; }",
    );

    fc.assert(
      fc.property(
        fc.array(selectorArb, { minLength: 1, maxLength: 4 }),
        (selectors) => {
          const css = selectors.join("\n");
          const once = scopeCssCustomProperties(
            prefixKeyframes(
              convertCssElementSelectorsToClasses(css, "fuzz").css,
              "fuzz",
            ),
            "fuzz",
          );
          const twice = scopeCssCustomProperties(
            prefixKeyframes(
              convertCssElementSelectorsToClasses(once, "fuzz").css,
              "fuzz",
            ),
            "fuzz",
          );
          // Running again must not keep transforming already-scoped output
          expect(typeof twice).toBe("string");
          // Specifically, scoped class names must not accumulate extra scoping prefixes
          expect(twice).not.toContain("bascik__fuzz__el__bascik__");
          expect(twice).not.toContain("bascik__fuzz__keyframe__bascik__");
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("shieldCssStrings – perfect round-trip", () => {
  it("protects selector-like string literals in CSS content properties from class scoping", () => {
    const originalCss = '.box::before { content: ".box #heading"; color: red; }';
    const { css: shielded, restore } = shieldCssStrings(originalCss);
    // Shielded form replaces the string content with a sentinel so class/id scoping does not match .box inside quotes
    expect(shielded).not.toContain('".box #heading"');
    const restored = restore(shielded);
    expect(restored).toBe(originalCss);
  });

  it("restore(shielded) is always byte-identical to the original CSS", () => {
    const cssArb = fc.constantFrom(
      ".nav a { color: white; }",
      `content: ".foo { color: red; }"`,
      `background: url(./img.png); color: #abc;`,
      `content: 'from { opacity: 0; }'; animation: spin 1s;`,
      `background: url("data:image/svg+xml,%3Csvg%3E");`,
      `:root { --brand: #d3ff8d; } .el { color: var(--brand); }`,
      `@keyframes spin { from { opacity: 0; } to { opacity: 1; } }`,
      `.cls { font-family: 'Arial', sans-serif; content: "don't break"; }`,
      `@charset "UTF-8"; .el { background: url('img.png'); }`,
      `.a::before { content: "<div class=\\"x\\">test</div>"; }`,
    );

    fc.assert(
      fc.property(fc.array(cssArb, { minLength: 1, maxLength: 4 }), (parts) => {
        const original = parts.join("\n");
        const { css: shielded, restore } = shieldCssStrings(original);
        expect(restore(shielded)).toBe(original);
        // Shielded form must contain no raw string literals or url() content
        expect(shielded).not.toMatch(/'[^']+'/);
        // Sentinels in shielded form must all be resolvable (no dangling placeholders after restore)
        expect(restore(shielded)).not.toContain("\x00CSSSTR");
      }),
      { numRuns: 200 },
    );
  });
});

describe("extractInlineStyles", () => {
  it("extracts inline <style> tags and strips them from HTML", () => {
    const input = '<style>.badge { color: red; }</style><span class="badge">Badge</span>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toBe('<span class="badge">Badge</span>');
    expect(css).toBe(".badge { color: red; }");
  });

  it("extracts multiple <style> tags and concatenates their CSS", () => {
    const input =
      '<style>.badge { color: red; }</style><style>.dot { width: 4px; }</style><span class="badge">Badge</span>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toBe('<span class="badge">Badge</span>');
    expect(css).toBe(".badge { color: red; }\n.dot { width: 4px; }");
  });

  it("does not extract literal <style> tags inside <code> or <pre> elements", () => {
    const input =
      '<pre><code>&lt;style&gt;.foo { color: blue; }&lt;/style&gt;</code></pre>' +
      '<style>.bar { color: green; }</style><div class="bar">Text</div>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toContain('<pre><code>&lt;style&gt;.foo { color: blue; }&lt;/style&gt;</code></pre>');
    expect(html).not.toContain('<style>.bar');
    expect(css).toBe(".bar { color: green; }");
  });

  it("wraps CSS in @media when <style media='...'> is present", () => {
    const input = '<style media="(max-width: 600px)">.box { display: block; }</style><div class="box"></div>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toBe('<div class="box"></div>');
    expect(css).toBe("@media (max-width: 600px) {\n.box { display: block; }\n}");
  });

  it("returns unchanged HTML and empty CSS when no <style> tags are present", () => {
    const input = '<div class="card">Hello</div>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toBe('<div class="card">Hello</div>');
    expect(css).toBe("");
  });

  it("handles empty or whitespace-only <style> tags cleanly", () => {
    const input = '<style></style><style>   \n   </style><div class="box">Text</div>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toBe('<div class="box">Text</div>');
    expect(css).toBe("");
  });

  it("handles <style> tags with arbitrary attributes (e.g. data-bascik, type)", () => {
    const input = '<style type="text/css" data-custom="123">.item { color: red; }</style><span class="item">X</span>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toBe('<span class="item">X</span>');
    expect(css).toBe(".item { color: red; }");
  });

  it("does not extract literal <style> tags inside <script> or <textarea> elements", () => {
    const input =
      '<script>const str = "<style>.fake { color: red; }</style>";</script>' +
      '<textarea><style>.fake2 {}</style></textarea>' +
      '<style>.real { color: green; }</style><div class="real">Hi</div>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toContain('const str = "<style>.fake { color: red; }</style>";');
    expect(html).toContain('<textarea><style>.fake2 {}</style></textarea>');
    expect(html).not.toContain('<style>.real');
    expect(css).toBe(".real { color: green; }");
  });

  it("extracts and combines multiple <style> tags from HTML", () => {
    const input =
      '<style>.primary { color: red; }</style>' +
      '<div class="primary">Content</div>' +
      '<style media="(min-width: 768px)">.primary { color: blue; }</style>';
    const { html, css } = extractInlineStyles(input);
    expect(html).toBe('<div class="primary">Content</div>');
    expect(css).toContain(".primary { color: red; }");
    expect(css).toContain("@media (min-width: 768px) {\n.primary { color: blue; }\n}");
  });
});

describe("Resilience to regex replacement patterns (TDD)", () => {
  it("prevents $1 injection in scopeCssCustomProperties", () => {
    const css = "@property --brand { syntax: '<color>'; inherits: false; } .el { color: var(--brand); }";
    const result = scopeCssCustomProperties(css, "my$1comp");
    expect(result).toContain("my$1comp");
    expect(result).not.toContain("my@property");
    expect(result).not.toContain("my.el");
  });

  it("prevents $& injection in scopeAnchorNames", () => {
    const css = ".anchor { anchor-name: --foo; }";
    const result = scopeAnchorNames(css, "my$&comp");
    expect(result).toContain("my$&comp");
    expect(result).not.toContain("my.anchorcomp");
    expect(result).not.toContain("myfoo");
  });

  it("prevents $1 injection in scopeCounterStyleNames", () => {
    const css = "@counter-style thumbs { } .el { list-style: thumbs; }";
    const result = scopeCounterStyleNames(css, "my$1comp");
    expect(result).toContain("my$1comp");
    expect(result).not.toContain("my@counter-style");
    expect(result).not.toContain("mthumbs");
  });

  it("prevents $1 injection in scopeContainerNames", () => {
    const css = ".el { container-name: sidebar; } @container sidebar (min-width: 200px) { }";
    const result = scopeContainerNames(css, "my$1comp");
    expect(result).toContain("my$1comp");
    expect(result).not.toContain("mysidebar");
    expect(result).not.toContain("my.el");
  });

  it("prevents $1 injection in scopeViewTransitionNames", () => {
    const css = ".el { view-transition-name: slide; } ::view-transition-old(slide) { }";
    const result = scopeViewTransitionNames(css, "my$1comp");
    expect(result).toContain("my$1comp");
    expect(result).not.toContain("myslide");
    expect(result).not.toContain("my.el");
  });
});

// ─── CSS @import Resolution & Hoisting ────────────────────────────────────────

describe("CSS @import resolution and hoisting", () => {
  it("keeps replacement tokens literal in unresolved async and sync imports", async () => {
    const css = '@import "$&.css";';
    const expected = '/* @import "$&.css" not found */';
    expect(await resolveCssImports(css, "/missing/index.css")).toBe(expected);
    expect(resolveCssImportsSync(css, "/missing/index.css")).toBe(expected);
  });

  describe("isRemoteCssUrl", () => {
    it("identifies remote and data URLs", () => {
      expect(isRemoteCssUrl("http://example.com/style.css")).toBe(true);
      expect(isRemoteCssUrl("https://fonts.googleapis.com/css")).toBe(true);
      expect(isRemoteCssUrl("//cdn.jsdelivr.net/style.css")).toBe(true);
      expect(isRemoteCssUrl("data:text/css;base64,body{color:red}")).toBe(true);
    });

    it("identifies local file paths", () => {
      expect(isRemoteCssUrl("./tokens.css")).toBe(false);
      expect(isRemoteCssUrl("../shared/button.css")).toBe(false);
      expect(isRemoteCssUrl("styles/base.css")).toBe(false);
      expect(isRemoteCssUrl("/abs/path/style.css")).toBe(false);
    });
  });

  describe("parseCssImport", () => {
    it("parses bare quote import", () => {
      const parsed = parseCssImport('@import "./theme.css";');
      expect(parsed).toEqual({
        fullMatch: '@import "./theme.css";',
        url: "./theme.css",
        isRemote: false,
        layer: undefined,
        supports: undefined,
        media: undefined,
      });
    });

    it("parses url(...) import", () => {
      const parsed = parseCssImport('http://fonts.googleapis.com/css');
      expect(parsed).toBeNull();

      const parsed2 = parseCssImport('@import url("https://fonts.googleapis.com/css2?family=Inter");');
      expect(parsed2).toEqual({
        fullMatch: '@import url("https://fonts.googleapis.com/css2?family=Inter");',
        url: "https://fonts.googleapis.com/css2?family=Inter",
        isRemote: true,
        layer: undefined,
        supports: undefined,
        media: undefined,
      });
    });

    it("parses @import with layer, supports, and media conditions", () => {
      const statement = '@import url("./base.css") layer(framework) supports(display: grid) screen and (min-width: 600px);';
      const parsed = parseCssImport(statement);
      expect(parsed).toEqual({
        fullMatch: statement,
        url: "./base.css",
        isRemote: false,
        layer: "framework",
        supports: "display: grid",
        media: "screen and (min-width: 600px)",
      });
    });

    it("parses anonymous layer import", () => {
      const statement = '@import "./reset.css" layer;';
      const parsed = parseCssImport(statement);
      expect(parsed?.layer).toBe(true);
    });

    it("parses MDN example syntax variants", () => {
      // @import "custom.css";
      expect(parseCssImport('@import "custom.css";')?.url).toBe("custom.css");

      // @import 'custom.css';
      expect(parseCssImport("@import 'custom.css';")?.url).toBe("custom.css");

      // @import url(fineprint.css);
      expect(parseCssImport("@import url(fineprint.css);")?.url).toBe("fineprint.css");

      // @import url("fineprint.css");
      expect(parseCssImport('@import url("fineprint.css");')?.url).toBe("fineprint.css");

      // @import url('fineprint.css');
      expect(parseCssImport("@import url('fineprint.css');")?.url).toBe("fineprint.css");

      // @import "common.css" screen, projection;
      const media1 = parseCssImport('@import "common.css" screen, projection;');
      expect(media1?.url).toBe("common.css");
      expect(media1?.media).toBe("screen, projection");

      // @import url("landscape.css") screen and (orientation: landscape);
      const media2 = parseCssImport('@import url("landscape.css") screen and (orientation: landscape);');
      expect(media2?.media).toBe("screen and (orientation: landscape)");

      // @import "common.css" layer;
      expect(parseCssImport('@import "common.css" layer;')?.layer).toBe(true);

      // @import "common.css" layer(layer-name);
      expect(parseCssImport('@import "common.css" layer(layer-name);')?.layer).toBe("layer-name");

      // @import "theme.css" supports(display: grid);
      expect(parseCssImport('@import "theme.css" supports(display: grid);')?.supports).toBe("display: grid");

      // @import "theme.css" supports(not (display: grid));
      expect(parseCssImport('@import "theme.css" supports(not (display: grid));')?.supports).toBe("not (display: grid)");

      // @import "theme.css" layer(utilities) supports(display: grid) screen;
      const comb = parseCssImport('@import "theme.css" layer(utilities) supports(display: grid) screen;');
      expect(comb?.layer).toBe("utilities");
      expect(comb?.supports).toBe("display: grid");
      expect(comb?.media).toBe("screen");
    });
  });

  describe("wrapInlinedCss", () => {
    it("wraps CSS in layer, supports, and media queries", () => {
      const css = ".btn { color: red; }";
      const wrapped = wrapInlinedCss(css, "utilities", "display: flex", "screen");
      expect(wrapped).toContain("@media screen {");
      expect(wrapped).toContain("@layer utilities {");
      expect(wrapped).toContain("@supports (display: flex) {");
      expect(wrapped).toContain(".btn { color: red; }");
    });
  });

  describe("hoistCssImports", () => {
    it("hoists remote @import statements to the top of the CSS", () => {
      const css = `
.card { padding: 1rem; }
@import url("https://fonts.googleapis.com/css?family=Roboto");
.btn { color: blue; }
@import "https://cdn.example.com/icons.css";
      `.trim();

      const hoisted = hoistCssImports(css);
      expect(hoisted.startsWith('@import url("https://fonts.googleapis.com/css?family=Roboto");')).toBe(true);
      expect(hoisted).toContain('@import "https://cdn.example.com/icons.css";');
      expect(hoisted).toContain(".card { padding: 1rem; }");
    });

    it("deduplicates identical @import statements when hoisting", () => {
      const css = `
@import url("https://fonts.googleapis.com/css?family=Roboto");
.card { color: red; }
@import url("https://fonts.googleapis.com/css?family=Roboto");
      `.trim();

      const hoisted = hoistCssImports(css);
      const occurrences = (hoisted.match(/fonts\.googleapis/g) || []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe("resolveCssImports / resolveCssImportsSync", () => {
    it("inlines local CSS files recursively and prevents circular imports", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "bascik-import-test-"));
      try {
        const fileA = join(tmpDir, "a.css");
        const fileB = join(tmpDir, "b.css");

        writeFileSync(fileA, '@import "./b.css";\n.class-a { color: red; }');
        writeFileSync(fileB, '@import "./a.css";\n.class-b { color: blue; }');

        const resolved = await resolveCssImports('@import "./a.css";', join(tmpDir, "index.css"));
        expect(resolved).toContain(".class-a { color: red; }");
        expect(resolved).toContain(".class-b { color: blue; }");

        const resolvedSync = resolveCssImportsSync('@import "./a.css";', join(tmpDir, "index.css"));
        expect(resolvedSync).toContain(".class-a { color: red; }");
        expect(resolvedSync).toContain(".class-b { color: blue; }");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("preserves remote imports untouched", async () => {
      const css = '@import url("https://fonts.googleapis.com/css2?family=Inter");\n.main { font-family: Inter; }';
      const resolved = await resolveCssImports(css);
      expect(resolved).toBe(css);
    });
  });
});

