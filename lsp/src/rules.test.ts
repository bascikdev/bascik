import { describe, it, expect } from "vitest";
import { matchCompatibilityRules } from "./rules.js";
import { analyzeApiRouteSource } from "./api-rules.js";

describe("Scoping Compatibility Rules", () => {
  describe("CSS rules", () => {
    it("detects [id] attribute selectors", () => {
      const css = '[id="report-form"] { color: red; }';
      const matches = matchCompatibilityRules(css, "css");
      expect(matches.some((m) => m.id === "css-id-attribute-selector")).toBe(
        true,
      );
    });

    it("detects unanchored standalone attribute selector", () => {
      const css = "[data-state] { color: red; }";
      const matches = matchCompatibilityRules(css, "css");
      expect(matches.some((m) => m.id === "css-attribute-selector")).toBe(true);
    });

    it.each([
      "[data-state]:hover { color: red; }",
      "[data-state][hidden] { color: red; }",
      "[data-state]:not(.disabled) { color: red; }",
      "[data-state]:is(.disabled, button) { color: red; }",
    ])("detects unanchored compound selector %s", (css) => {
      const matches = matchCompatibilityRules(css, "css");
      expect(matches.some((m) => m.id === "css-attribute-selector")).toBe(true);
    });

    it("allows an attribute selector with a scoped descendant class", () => {
      const css = "[data-state] > .scoped-class { color: red; }";
      const matches = matchCompatibilityRules(css, "css");
      expect(matches.some((m) => m.id === "css-attribute-selector")).toBe(
        false,
      );
    });

    it("allows a class outside a negative pseudo-class", () => {
      const matches = matchCompatibilityRules(
        "[data-state]:not(.disabled) .card { color: red; }",
        "css",
      );
      expect(matches.some((m) => m.id === "css-attribute-selector")).toBe(
        false,
      );
    });

    it("detects bare element selector in :is()", () => {
      const css = ":is(div, span) { color: blue; }";
      const matches = matchCompatibilityRules(css, "css");
      expect(matches.some((m) => m.id === "css-is-element-names")).toBe(true);
    });

    it("ignores class selectors inside :is()", () => {
      const css = ":is(.btn, .link) { color: blue; }";
      const matches = matchCompatibilityRules(css, "css");
      expect(matches.some((m) => m.id === "css-is-element-names")).toBe(false);
    });
  });

  describe("JavaScript rules", () => {
    it("detects runtime .id assignment", () => {
      const js = 'element.id = "my-id";';
      const matches = matchCompatibilityRules(js, "js");
      expect(matches.some((m) => m.id === "js-id-setter")).toBe(true);
    });

    it("detects attribute selector in querySelector", () => {
      const js = 'document.querySelector("[data-active]");';
      const matches = matchCompatibilityRules(js, "js");
      expect(matches.some((m) => m.id === "js-attribute-selector")).toBe(true);
    });

    it("detects template literal in classList.replace", () => {
      const js = "element.classList.replace(oldName, `card-${state}`);";
      const matches = matchCompatibilityRules(js, "js");
      expect(matches.some((m) => m.id === "js-template-classname")).toBe(true);
    });

    it("detects dynamic custom property name in setProperty", () => {
      const js = 'el.style.setProperty("--theme-color", "red");';
      const matches = matchCompatibilityRules(js, "js");
      expect(matches.some((m) => m.id === "js-style-setproperty")).toBe(true);
    });

    it("detects unsupported DOM methods (removeAttribute, hasAttribute, toggleAttribute)", () => {
      const js =
        'el.removeAttribute("class"); el.hasAttribute("id"); el.toggleAttribute("hidden");';
      const matches = matchCompatibilityRules(js, "js");
      expect(matches.some((m) => m.id === "js-unsupported-dom-methods")).toBe(
        true,
      );
    });

    it("sets error severity on unsupported compatibility rules", () => {
      const css = '[id="report-form"] { color: red; }';
      const matches = matchCompatibilityRules(css, "css");
      const rule = matches.find((m) => m.id === "css-id-attribute-selector");
      expect(rule?.severity).toBe("error");
    });
  });
});

describe("API Route Rules", () => {
  it("reports missing method export when none found", () => {
    const ts = 'export const helper = () => "not a method";';
    const diags = analyzeApiRouteSource(ts);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          d.message.includes("does not export any recognized HTTP method"),
      ),
    ).toBe(true);
  });

  it("passes when valid GET method is exported", () => {
    const ts = `export async function GET(request: Request) { return new Response("ok"); }`;
    const diags = analyzeApiRouteSource(ts);
    expect(diags.length).toBe(0);
  });

  const codesOf = (ts: string) =>
    analyzeApiRouteSource(ts)
      .map((d) => d.code)
      .sort();

  it.each([
    ['export { GET, POST } from "./handlers.ts";'],
    ['const GET = () => new Response("ok");\nexport { GET };'],
    ['const handler = () => new Response("ok");\nexport { handler as GET };'],
    ['export {\n  helper,\n  handler as DELETE,\n} from "./handlers.ts";'],
    ['export * from "./handlers.ts";'],
  ])("finds a method exported by an export clause: %s", (ts) => {
    expect(codesOf(ts)).toEqual([]);
  });

  it("reports what a misspelled or renamed export clause really exports", () => {
    // `get` is not a method the dispatcher finds, and `GET as handler` exports `handler`.
    expect(codesOf("const get = () => 1;\nexport { get };")).toEqual([
      "invalid-method-case",
      "missing-method-handler",
    ]);
    expect(codesOf("const GET = () => 1;\nexport { GET as handler };")).toEqual(
      ["missing-method-handler"],
    );
    // Types do not exist at run time, and a namespace re-export is one name.
    expect(codesOf('export type { GET } from "./types.ts";')).toEqual([
      "missing-method-handler",
    ]);
    expect(codesOf('export * as handlers from "./handlers.ts";')).toEqual([
      "missing-method-handler",
    ]);
  });

  it("accepts a default export as the handler for every method", () => {
    expect(
      codesOf(
        "export default (request: Request) => new Response(request.method);",
      ),
    ).toEqual([]);
    expect(
      codesOf(
        "export default async function handler() { return new Response(null); }",
      ),
    ).toEqual([]);
    expect(
      codesOf(
        "const proxy = () => new Response(null);\nexport { proxy as default };",
      ),
    ).toEqual([]);
    // A default that is only mentioned is not one.
    expect(
      codesOf(
        '// export default () => new Response("x");\nconst s = "export default";',
      ),
    ).toEqual(["missing-method-handler"]);
  });

  it("does not count a method export in a comment or a string", () => {
    expect(
      codesOf(
        '// export const GET = () => new Response("x");\nconst s = "export function POST() {}";',
      ),
    ).toEqual(["missing-method-handler"]);
  });

  it.each([
    [
      'const clean = (p: string) => p.replace(/^\\/*/, "");\nexport const GET = () => new Response("x");',
    ],
    [
      'const RE = /[`]/g;\nexport async function POST() { return new Response("x"); }',
    ],
    ['const quote = /["\']/;\nexport const GET = () => new Response("x");'],
    ['const slash = /[/]/;\nexport const GET = () => new Response("x");'],
    [
      'function f(s: string) { return /\\/*$/.test(s); }\nexport const GET = () => new Response("x");',
    ],
  ])("reads a regex literal as code, not a comment or string: %s", (ts) => {
    expect(codesOf(ts)).toEqual([]);
  });

  it("still reads a slash after a value as division", () => {
    // `a / b` then a later `/` must not swallow the export between them as one regex.
    expect(
      codesOf(
        "const half = total / 2;\nexport const GET = () => new Response(String(half / 1));",
      ),
    ).toEqual([]);
    expect(
      codesOf("const x = (a) / 2; // export const GET = 1\nconst y = 1 / 2;"),
    ).toEqual(["missing-method-handler"]);
  });

  it("reads a slash whose line ends before a closing slash as division", () => {
    expect(
      codesOf(
        'const q = (/[(/[ 2;\nexport const GET = () => new Response("x");',
      ),
    ).toEqual([]);
  });
});

describe("api-unguarded-json", () => {
  const unguarded = (body: string) =>
    analyzeApiRouteSource(
      `export const POST = async (request: Request) => {\n${body}\n};`,
    ).filter((d) => d.code === "api-unguarded-json").length;

  it("is not silenced by identifiers or words that contain try or catch", () => {
    expect(unguarded("const entry = await request.json();")).toBe(1);
    expect(
      unguarded("const country = retry(registry);\nawait request.json();"),
    ).toBe(1);
    expect(
      unguarded('// try this\nconst s = "try {";\nawait req.json();'),
    ).toBe(1);
  });

  it("is silent inside a try block, whatever the block holds", () => {
    expect(
      unguarded(
        "try {\n  const catchAll = 1;\n  if (catchAll) { }\n  await request.json();\n} catch {}",
      ),
    ).toBe(0);
    expect(
      unguarded("try {\n  const body = `${await request.json()}`;\n} catch {}"),
    ).toBe(0);
  });

  it("reports a call after a closed try block, or in its catch or finally", () => {
    expect(unguarded("try { setup(); } catch {}\nawait request.json();")).toBe(
      1,
    );
    expect(
      unguarded("try { setup(); } catch (e) { await request.json(); }"),
    ).toBe(1);
    expect(
      unguarded("try { setup(); } finally { await request.json(); }"),
    ).toBe(1);
  });

  it("ignores a call written in a comment or a string", () => {
    expect(
      unguarded('// await request.json()\nconst doc = "request.json()";'),
    ).toBe(0);
  });
});

describe("API Route Rules: locations", () => {
  const rangeOf = (ts: string, code: string) =>
    analyzeApiRouteSource(ts).find((d) => d.code === code)?.range;

  it("anchors invalid-method-case to the misspelled export name", () => {
    const ts =
      'import x from "y";\n\nexport const post = () => new Response("ok");\nexport const GET = () => new Response("ok");\n';
    expect(rangeOf(ts, "invalid-method-case")).toEqual({
      startLine: 2,
      startChar: 13,
      endLine: 2,
      endChar: 17,
    });
  });

  it("anchors invalid-method-case in an export clause to the specifier", () => {
    const ts = 'const get = () => new Response("ok");\nexport {\n  get,\n};\n';
    expect(rangeOf(ts, "invalid-method-case")).toEqual({
      startLine: 2,
      startChar: 2,
      endLine: 2,
      endChar: 5,
    });
  });

  it("anchors api-handler-return-type to the handler export name", () => {
    const ts =
      '// header\n\nexport const POST = async (): Promise<string> => "x";\n';
    expect(rangeOf(ts, "api-handler-return-type")).toEqual({
      startLine: 2,
      startChar: 13,
      endLine: 2,
      endChar: 17,
    });
  });

  it("anchors missing-method-handler to the first export, not line 1", () => {
    const ts = "// header\n\nconst a = 1;\nexport const helper = () => 1;\n";
    expect(rangeOf(ts, "missing-method-handler")).toEqual({
      startLine: 3,
      startChar: 13,
      endLine: 3,
      endChar: 19,
    });
  });

  it("anchors missing-method-handler to the first code line when nothing is exported", () => {
    const ts = "// header\n\nconst a = 1;\n";
    expect(rangeOf(ts, "missing-method-handler")).toEqual({
      startLine: 2,
      startChar: 0,
      endLine: 2,
      endChar: 12,
    });
  });

  it("never reports a located rule without a range", () => {
    for (const ts of ["", "export default {};", "export const get = 1;"]) {
      for (const d of analyzeApiRouteSource(ts)) expect(d.range).toBeDefined();
    }
  });
});
