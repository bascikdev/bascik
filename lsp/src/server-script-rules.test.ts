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

    it("does not apply the server import rule to build or routes, but does report unescaped markup", () => {
      const body = `import { escapeHtml } from '@bascik/bascik';
export default async () => \`<a href="\${request.query}"></a>\`;`;
      for (const directive of ["build", "routes"] as const) {
        const codes = analyzeServerScriptSource(body, {
          hasSrcAttribute: false,
          directive,
        }).map((d) => d.code);
        expect(codes, directive).toEqual(["server-script-unescaped-markup"]);
      }
    });
  });

  describe("Security and Injection Sink Rules", () => {
    it("warns about unescaped interpolation in URL attributes (as unescaped markup: html checks URLs)", () => {
      const body = `
        export default async (req) => {
          return \`<a href="\${req.query}">click</a>\`;
        };
      `;
      const diags = analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      });
      expect(diags.map((d) => d.code)).toEqual([
        "server-script-unescaped-markup",
      ]);
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

  describe("server-script-returns-response", () => {
    const RULE = "server-script-returns-response";
    const responseDiags = (
      body: string,
      directive: "server" | "stream" | "build" | "routes" = "server",
    ) =>
      analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive,
      }).filter((d) => d.code === RULE);

    it.each([
      [
        "server",
        "new Response in a function declaration",
        'export default async function handler(request) {\n  return new Response("Hello");\n}',
        "new Response",
      ],
      [
        "stream",
        "new Response in a stream script",
        'export default async function () {\n  return new Response("Hello");\n}',
        "new Response",
      ],
      [
        "server",
        "Response.json in an async arrow",
        "export default async (request) => {\n  const data = { ok: true };\n  return Response.json(data);\n};",
        "Response.json",
      ],
      [
        "server",
        "Response.redirect in a branch",
        'export default async (request) => {\n  if (!request.headers.get("cookie")) {\n    return Response.redirect("/login", 302);\n  }\n  return "<p>Hi</p>";\n};',
        "Response.redirect",
      ],
      [
        "server",
        "an arrow whose body is a Response",
        'export default () => new Response("Hello");',
        "new Response",
      ],
      [
        "server",
        "an awaited Response in parentheses",
        'export default async () => {\n  return (await new Response("Hello"));\n};',
        "new Response",
      ],
      [
        "stream",
        "a named handler exported as default",
        "async function render(request) {\n  return Response.json({ ok: true });\n}\nexport default render;",
        "Response.json",
      ],
      [
        "server",
        "a const arrow in an export clause",
        'const render = async () => {\n  return new Response("x");\n};\nexport { render as default };',
        "new Response",
      ],
      [
        "server",
        "a TypeScript handler with a return type",
        "export default async function (request: Request): Promise<string> {\n  return Response.json({ ok: true });\n}",
        "Response.json",
      ],
      [
        "server",
        "a TypeScript arrow with a return type",
        'export default async (request: Request): Promise<Response> => {\n  return new Response("x");\n};',
        "new Response",
      ],
      [
        "server",
        "a Response returned from a switch case and a try block",
        'export default async (request) => {\n  switch (request.method) {\n    case "GET": {\n      try {\n        return Response.json({});\n      } catch (error) {\n        throw error;\n      }\n    }\n  }\n  return "";\n};',
        "Response.json",
      ],
    ])(
      "warns on a %s script returning %s",
      (directive, _name, body, marked) => {
        const diags = responseDiags(body, directive as "server" | "stream");
        expect(diags).toHaveLength(1);
        expect(diags[0].severity).toBe("warning");
        expect(body.slice(diags[0].start, diags[0].end)).toBe(marked);
        expect(diags[0].message).toContain(`data-bascik-${directive} script`);
        expect(diags[0].message).toContain("spliced into the page as markup");
        expect(diags[0].message).toContain("html`...`");
        expect(diags[0].message).toContain("API route");
      },
    );

    it("reports each return of a Response in the handler", () => {
      const body =
        'export default async (request) => {\n  if (request.method === "HEAD") return new Response(null);\n  return Response.json({});\n};';
      expect(
        responseDiags(body).map((d) => body.slice(d.start, d.end)),
      ).toEqual(["new Response", "Response.json"]);
    });

    it.each([
      [
        "a build script",
        "build",
        'export default async function () {\n  return new Response("x");\n}',
      ],
      [
        "a routes script",
        "routes",
        "export default async function () {\n  return Response.json([]);\n}",
      ],
    ])("stays quiet in %s", (_name, directive, body) => {
      expect(responseDiags(body, directive as "build" | "routes")).toEqual([]);
    });

    it.each([
      [
        "a Response built but not returned",
        'export default async () => {\n  const res = new Response("x");\n  return await res.text();\n};',
      ],
      [
        "the words in a string",
        'export default () => {\n  return "return new Response(";\n};',
      ],
      [
        "the words in a template literal",
        "export default () => {\n  return `<pre>return Response.json(data)</pre>`;\n};",
      ],
      [
        "the words in a line comment",
        'export default () => {\n  // return new Response("x");\n  return "<p>Hi</p>";\n};',
      ],
      [
        "the words in a block comment",
        'export default () => {\n  /* return Response.json({}) */\n  return "<p>Hi</p>";\n};',
      ],
      [
        "a nested helper function",
        'export default async () => {\n  function toResponse(text) {\n    return new Response(text);\n  }\n  return "<p>Hi</p>";\n};',
      ],
      [
        "a nested arrow callback",
        'export default async () => {\n  const responses = items.map((item) => {\n    return Response.json(item);\n  });\n  return "<p>Hi</p>";\n};',
      ],
      [
        "an object method",
        'export default async () => {\n  const api = { reply() { return new Response("x"); } };\n  return "<p>Hi</p>";\n};',
      ],
      [
        "a helper declared outside the default export",
        'function toResponse(text) {\n  return new Response(text);\n}\nexport default () => "<p>Hi</p>";',
      ],
      [
        "a return of a value on the next line (ASI returns undefined)",
        'export default () => {\n  return\n  new Response("x");\n};',
      ],
      [
        "a nested TypeScript helper with a return type",
        'export default async () => {\n  function toResponse(text: string): Response {\n    return new Response(text);\n  }\n  return "<p>Hi</p>";\n};',
      ],
      [
        "a wrapped handler (what the wrapper returns is not read)",
        'function withAuth(handler) {\n  return new Response("denied");\n}\nexport default withAuth(async () => "<p>Hi</p>");',
      ],
      [
        "a type or class named like Response",
        'export default () => {\n  return new MyResponse("x").html + Responses.json;\n};',
      ],
    ])("misuse: stays quiet for %s", (_name, body) => {
      expect(responseDiags(body)).toEqual([]);
    });

    // The prefix before the Response (parentheses, `await`, whitespace) is
    // skipped by a loop, not a regex star (CodeQL alert 207): these pin that
    // the loop accepts what the regex accepted, and only that.
    it.each([
      [
        "tabs after return",
        'export default () => {\n  return\t\t\tnew Response("x");\n};',
        "new Response",
      ],
      [
        "line breaks inside parentheses",
        'export default () => {\n  return (\n\n    new Response("x")\n  );\n};',
        "new Response",
      ],
      [
        "nested parentheses",
        "export default () => {\n  return (((Response.json({}))));\n};",
        "Response.json",
      ],
      [
        "await and parentheses with tabs between",
        'export default async () => {\n  return (\tawait\t(\tawait Response\t.\tredirect\t("/")));\n};',
        "Response\t.\tredirect",
      ],
      [
        "an awaited arrow body",
        'export default async () => (await\n  new Response("x"));',
        "new Response",
      ],
      [
        "a Response right after an opening parenthesis",
        "export default () => {\n  return(Response.error());\n};",
        "Response.error",
      ],
    ])("warns through a prefix of %s", (_name, body, marked) => {
      expect(
        responseDiags(body).map((d) => body.slice(d.start, d.end)),
      ).toEqual([marked]);
    });

    it.each([
      [
        "an identifier that starts with await",
        "export default async () => {\n  return awaitResponse.json({});\n};",
      ],
      [
        "an identifier that ends with await",
        "export default async () => {\n  return (myawait Response.json({}));\n};",
      ],
      [
        "a word glued to new",
        'export default () => {\n  return\t\tnewResponse("x");\n};',
      ],
      [
        "a long run of tabs before a value that is not a Response",
        `export default () => {\n  return (${"\t".repeat(1_000)}"<p>Hi</p>");\n};`,
      ],
      [
        "a Response.json that is not called",
        "export default () => {\n  return (await Response.json);\n};",
      ],
    ])("misuse: stays quiet for a prefix with %s", (_name, body) => {
      expect(responseDiags(body)).toEqual([]);
    });

    it("stays quiet for a script with src, whose body is not the script", () => {
      expect(
        analyzeServerScriptSource('export default () => new Response("x");', {
          hasSrcAttribute: true,
          directive: "server",
        }).filter((d) => d.code === RULE),
      ).toEqual([]);
    });

    it("keeps reporting returns after an if block and a nested function", () => {
      const body =
        'export default async (request) => {\n  if (request.url) {\n    const f = () => { return 1; };\n  }\n  return new Response("x");\n};';
      expect(
        responseDiags(body).map((d) => body.slice(d.start, d.end)),
      ).toEqual(["new Response"]);
    });

    it("misuse: an unfinished script mid-edit reports nothing and does not throw", () => {
      for (const body of [
        "export default async (request) => {\n  return new Response(",
        "export default",
        "export default async function (",
        'export default async () => { return "<p>',
      ])
        expect(() => responseDiags(body)).not.toThrow();
      expect(responseDiags("export default async function (").length).toBe(0);
    });
  });
});

describe("project import names", () => {
  const analyze = (body: string) =>
    analyzeServerScriptSource(body, {
      hasSrcAttribute: false,
      directive: "server",
    });

  it("reads a long import clause that never reaches a from in linear time", () => {
    // The former clause pattern backtracked quadratically on this text before giving up.
    const body = `import ${"{{|".repeat(20_000)}\nexport default () => "";`;
    expect(analyze(body).map((d) => d.code)).not.toContain(
      "server-script-missing-default-export",
    );
  });

  it("misuse: an import clause broken by a quote or semicolon binds no helper", () => {
    const body = `import { card ; } from "./card.js";\nexport default () => card(1);`;
    expect(() => analyze(body)).not.toThrow();
  });
});
