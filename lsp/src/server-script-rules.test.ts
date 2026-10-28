import { describe, it, expect } from "vitest";
import { analyzeServerScriptSource } from "./server-script-rules.js";

describe("Server Script Diagnostics", () => {
  describe("Contract Rules", () => {
    it("fails when server script has no export default", () => {
      const body = `const x = 1;\nlet y = 2;`;
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("server-script-missing-default-export");
      expect(diags[0].severity).toBe("error");
      expect(diags[0].message).toContain(
        "A data-bascik-server script must `export default`",
      );
    });

    // A quote, backtick or slash pair inside a regex literal must not start a
    // string or comment that swallows the export after it.
    it.each([
      [
        "a quote in a regex literal",
        `const escape = (s) => s.replace(/"/g, "&quot;");\nexport default () => escape("x");`,
      ],
      [
        "an apostrophe in a regex literal",
        `const t = (s) => s.replace(/'/g, "&#39;");\nexport default () => t("x");`,
      ],
      [
        "a backtick in a regex literal",
        "const t = (s) => s.replace(/`/g, '');\nexport default () => t('x');",
      ],
      [
        "an escaped slash and a class with a slash",
        `const parts = (u) => u.split(/\\//).filter((p) => /[/"]/.test(p));\nexport default () => parts("a/b");`,
      ],
      [
        "a regex after return",
        `function q(s) { return /"/.test(s); }\nexport default () => String(q("x"));`,
      ],
    ])("finds export default after %s", (_name, body) => {
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(
        diags.filter((d) => d.code === "server-script-missing-default-export"),
      ).toEqual([]);
    });

    // A `/` after a value is division. If it were read as a regex start, the
    // regex skip would run to the end of the line and swallow the export that
    // follows on the same line, so each case keeps both on one line.
    it.each([
      [
        "a string literal",
        `const n = "10" / 2; export default () => String(n);`,
      ],
      [
        "a single-quoted string",
        `const n = '10' / 2; export default () => String(n);`,
      ],
      [
        "a template literal",
        "const n = `10` / 2; export default () => String(n);",
      ],
      [
        "a template literal with a placeholder",
        "const n = `${x}` / 2; export default () => String(n);",
      ],
      [
        "a property named like a keyword",
        `const n = values.of / 2; export default () => String(n);`,
      ],
      [
        "an optional property named like a keyword",
        `const n = values?.in / 2; export default () => String(n);`,
      ],
      [
        "a spaced property access",
        `const n = values . return / 2; export default () => String(n);`,
      ],
      ["a closing paren", `const n = (4) / 2; export default () => String(n);`],
      [
        "a closing bracket",
        `const n = a[0] / 2; export default () => String(n);`,
      ],
      ["a number", `const n = 10 / 2; export default () => String(n);`],
      ["an identifier", `const n = half / 2; export default () => String(n);`],
      [
        "an identifier ending in a keyword",
        `const n = typeofx / 2; export default () => String(n);`,
      ],
    ])("finds export default after division following %s", (_name, body) => {
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(
        diags.filter((d) => d.code === "server-script-missing-default-export"),
      ).toEqual([]);
    });

    // The other direction: a real keyword, including one after a spread, must
    // still start a regex so a quote inside it cannot open a string.
    it.each([
      ["typeof", `const t = typeof /"/; export default () => t;`],
      [
        "a spread",
        `function f(s) { return [.../"/.exec(s)]; }\nexport default () => f("x");`,
      ],
      [
        "await after a spread",
        `async function f(s) { return [...await /"/.exec(s)]; }\nexport default () => f("x");`,
      ],
      [
        "a keyword after a semicolon",
        `let v = 1; void /"/.test("x");\nexport default () => v;`,
      ],
    ])("still reads a regex after %s", (_name, body) => {
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(
        diags.filter((d) => d.code === "server-script-missing-default-export"),
      ).toEqual([]);
    });

    // Deciding whether a `/` starts a regex looks only at the text just
    // before it. Testing end-anchored patterns against everything scanned so
    // far made the scan quadratic: a 320 KB minified script took 3.7 s and
    // stalled every diagnostics pass of the language server.
    it.each([
      ["division", "a/"],
      ["division after whitespace", "a  /"],
      ["a keyword-like identifier", "returned/"],
      ["a property named like a keyword", "x.of/"],
    ])(
      "misuse: a huge script full of %s is analyzed in linear time",
      (_name, unit) => {
        const body = `const x = ${unit.repeat(160_000)}b;\nexport default () => x;`;
        const started = performance.now();
        const diags = analyzeServerScriptSource(body, {
          hasSrcAttribute: false,
          directive: "server",
        });
        const elapsed = performance.now() - started;
        expect(
          diags.filter(
            (d) => d.code === "server-script-missing-default-export",
          ),
        ).toEqual([]);
        // Linear work is about 100-200 ms here, quadratic 3.5-15 s: the bound
        // leaves room for a slow CI machine and still catches the regression.
        expect(elapsed).toBeLessThan(2_000);
      },
    );

    it("reads a keyword or spread across long whitespace and comments before a /", () => {
      const pad = " \n\t".repeat(5_000);
      for (const body of [
        `const t = typeof${pad}/"/; export default () => t;`,
        `function f(s) { return [...${pad}/"/.exec(s)]; }\nexport default () => f("x");`,
        `const r = (1)${pad}/* c */${pad}/2; const s = "/"; export default () => r;`,
      ]) {
        expect(
          analyzeServerScriptSource(body, {
            hasSrcAttribute: false,
            directive: "server",
          }).filter((d) => d.code === "server-script-missing-default-export"),
        ).toEqual([]);
      }
      // A property access across whitespace is still division.
      const division = `const values = { of: 4 }; const v = values .${pad}of / 2; const s = "/"; export default () => v;`;
      expect(
        analyzeServerScriptSource(division, {
          hasSrcAttribute: false,
          directive: "server",
        }).filter((d) => d.code === "server-script-missing-default-export"),
      ).toEqual([]);
    });

    it("still reports a missing export when division is not a regex", () => {
      const body = `const half = 10 / 2; const q = half / 5; // "export default" in a comment\n`;
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(diags.map((d) => d.code)).toContain(
        "server-script-missing-default-export",
      );
    });

    it("does not fail when hasSrcAttribute is true or export default exists", () => {
      const withExport = `export default async (request) => "<p>ok</p>";`;
      const diags1 = analyzeServerScriptSource(withExport, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(
        diags1.filter((d) => d.code === "server-script-missing-default-export")
          .length,
      ).toBe(0);

      const withSrc = ``;
      const diags2 = analyzeServerScriptSource(withSrc, {
        hasSrcAttribute: true,
        directive: "stream",
      });
      expect(
        diags2.filter((d) => d.code === "server-script-missing-default-export")
          .length,
      ).toBe(0);
    });

    it("formats message correctly for stream directive", () => {
      const body = `console.log("hello");`;
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "stream",
      });
      expect(diags[0].message).toContain(
        "A data-bascik-stream script must `export default`",
      );
    });

    it("diagnoses missing default export for build directive", () => {
      const body = `console.log("hello");`;
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "build",
      });
      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("server-script-missing-default-export");
      expect(diags[0].message).toBe(
        "A data-bascik-build script must `export default` a function returning a string. Expected: export default async function() { ... }",
      );
    });

    it("diagnoses missing default export for routes directive", () => {
      const body = `console.log("hello");`;
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "routes",
      });
      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("server-script-missing-default-export");
      expect(diags[0].message).toBe(
        "A data-bascik-routes script must `export default` a function returning an array. Expected: export default async function() { ... }",
      );
    });

    it("recognizes various export forms and ignores export in comments/strings", () => {
      const validCases = [
        "export default async function () {}",
        "export default function () {}",
        "export default function named() {}",
        'export default async () => ""',
        "export default () => []",
        'const h = () => ""; export default h;',
        "export { handler as default };",
        'export { default } from "./helper.js";',
        'export { a, b as default } from "./helper.js";',
        'export * as default from "./helper.js";',
      ];
      for (const valid of validCases) {
        const diags = analyzeServerScriptSource(valid, {
          hasSrcAttribute: false,
          directive: "build",
        });
        expect(
          diags.filter((d) => d.code === "server-script-missing-default-export")
            .length,
        ).toBe(0);
      }

      const invalidCases = [
        "// export default function () {}\nconsole.log(1);",
        "/* export default function () {} */\nconsole.log(1);",
        'const str = "export default function () {}";',
        "const tmpl = `export default function () {}`;",
        'export { default as named } from "./helper.js";',
      ];
      for (const invalid of invalidCases) {
        const diags = analyzeServerScriptSource(invalid, {
          hasSrcAttribute: false,
          directive: "build",
        });
        expect(
          diags.filter((d) => d.code === "server-script-missing-default-export")
            .length,
        ).toBe(1);
      }
    });

    it("does not apply server-specific import or sink rules to build or routes", () => {
      const body = `import { escapeHtml } from '@bascik/bascik';
export default async () => \`<a href="\${request.query}"></a>\`;`;
      const diagsBuild = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "build",
      });
      expect(diagsBuild.length).toBe(0);

      const diagsRoutes = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "routes",
      });
      expect(diagsRoutes.length).toBe(0);
    });
  });

  describe("Security and Injection Sink Rules", () => {
    it("warns about unescaped interpolation in URL attributes", () => {
      const body = `
        export default async (req) => {
          return \`<a href="\${req.query}">click</a>\`;
        };
      `;
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(
        diags.some((d) => d.code === "server-script-sink-url-attribute"),
      ).toBe(true);
    });

    const sinkCodes = (markup: string) =>
      analyzeServerScriptSource(
        `export default async (req) => \`${markup}\`;`,
        {
          hasSrcAttribute: false,
          directive: "server",
        },
      ).map((d) => d.code);

    it.each([["</script >"], ["</script foo>"], ["</script/>"], ["</SCRIPT>"]])(
      "treats a placeholder after a script ending in %j as outside the script",
      (endTag) => {
        expect(
          sinkCodes(`<script>a()${endTag}<p>\${req.query}</p>`),
        ).not.toContain("server-script-sink-inline-script");
      },
    );

    it.each([["</style >"], ["</style foo>"], ["</style/>"]])(
      "treats a placeholder after a style ending in %j as outside the style",
      (endTag) => {
        expect(
          sinkCodes(`<style>.a{}${endTag}<p>\${req.query}</p>`),
        ).not.toContain("server-script-sink-style");
      },
    );

    it("still warns inside a script or style whose start tag has a quoted >", () => {
      expect(
        sinkCodes('<script data-x="a>b">const v = "${req.query}";'),
      ).toContain("server-script-sink-inline-script");
      expect(
        sinkCodes('<style media="(width > 1px)">.a{content:"${req.query}"}'),
      ).toContain("server-script-sink-style");
    });

    it("does not treat <style-guide> or <script-loader> elements as style or script context", () => {
      const codes = sinkCodes(
        "<style-guide><script-loader><p>${req.query}</p>",
      );
      expect(codes).not.toContain("server-script-sink-style");
      expect(codes).not.toContain("server-script-sink-inline-script");
    });
  });
});
