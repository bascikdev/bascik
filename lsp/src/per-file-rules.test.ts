import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createDiagnostics } from "./analyzer.js";
import {
  findComponentStructureProblems,
  isKnownBascikAttribute,
  isKnownBuildValue,
} from "./directive-rules.js";
import { analyzeApiRouteSource } from "./api-rules.js";
import { parseApiRoot, type ProjectSnapshot } from "./project.js";

const snapshot = (
  overrides: Partial<ProjectSnapshot> = {},
): ProjectSnapshot => ({
  projectRoot: "/site",
  componentRoots: ["/site/src/components"],
  apiRoot: "/site/src/api",
  componentMap: new Map(),
  componentMetadata: new Map(),
  importRoot: "/site/src",
  htmlUsageByFile: new Map(),
  ...overrides,
});

const messageText = (message: string | { value: string }): string =>
  typeof message === "string" ? message : message.value;

const codesFor = (
  path: string,
  languageId: string,
  text: string,
  project = snapshot(),
): string[] =>
  createDiagnostics(
    TextDocument.create(`file://${path}`, languageId, 1, text),
    path,
    project,
  )
    .map((diagnostic) => String(diagnostic.code))
    .filter((code) => code !== "undefined");

describe("directive-rules", () => {
  it("knows the fixed and the prefixed data-bascik attributes", () => {
    expect(isKnownBascikAttribute("data-bascik-slot")).toBe(true);
    expect(isKnownBascikAttribute("data-bascik-build-once")).toBe(true);
    expect(isKnownBascikAttribute("data-bascik-prop-title")).toBe(true);
    expect(isKnownBascikAttribute("data-bascik-attr-href")).toBe(true);
    expect(isKnownBascikAttribute("data-bascik-slott")).toBe(false);
    expect(isKnownBascikAttribute("data-bascik-prop")).toBe(false);
  });

  it("accepts only an empty value for data-bascik-build", () => {
    expect(isKnownBuildValue("")).toBe(true);
    expect(isKnownBuildValue("  ")).toBe(true);
    expect(isKnownBuildValue("page")).toBe(false);
    expect(isKnownBuildValue("pages")).toBe(false);
  });

  it("finds a script above the markup and a style below it", () => {
    const masked =
      "<script>        </script>\n<p>hi</p>\n<style>      </style>\n";
    expect(
      findComponentStructureProblems(masked).map((problem) => problem.kind),
    ).toEqual(["script-before-markup", "style-after-markup"]);
  });

  it("accepts styles first and scripts last, and ignores closing tags and comments", () => {
    const masked =
      "<!--  -->\n<style>      </style>\n<p>hi</p>\n<script>        </script>\n";
    expect(findComponentStructureProblems(masked)).toEqual([]);
  });

  it.each([
    "",
    "<script>   </script>\n",
    "<style>   </style>\n",
    "<style>   </style>\n<script>   </script>\n",
    "<script>   </script>\n<style>   </style>\n",
  ])("accepts a component with no markup: %s", (masked) => {
    expect(findComponentStructureProblems(masked)).toEqual([]);
  });
});

describe("per-file rules reported by the analyzer", () => {
  it("reports unknown data-bascik attributes with the rule id and the attribute as the range", () => {
    const text = '<p data-bascik-slott="x" data-bascik-slot="y">hi</p>';
    const [diagnostic] = createDiagnostics(
      TextDocument.create("file:///site/src/pages/a.html", "html", 1, text),
      "/site/src/pages/a.html",
      snapshot(),
    );
    expect(diagnostic.code).toBe("unknown-bascik-attribute");
    expect(
      text.slice(
        diagnostic.range.start.character,
        diagnostic.range.end.character,
      ),
    ).toBe("data-bascik-slott");
  });

  it("checks attributes on script tags too, but not inside <code> or comments", () => {
    const page = [
      '<script data-bascik-bild>export default () => "";</script>',
      "<code><p data-bascik-nope></p></code>",
      "<!-- <p data-bascik-nope></p> -->",
    ].join("\n");
    expect(
      codesFor("/site/src/pages/a.html", "html", page).filter(
        (code) => code === "unknown-bascik-attribute",
      ),
    ).toHaveLength(1);
  });

  it("reports values on data-bascik-build and accepts a bare directive", () => {
    const body = 'export default () => "";';
    expect(
      codesFor(
        "/site/src/pages/a.html",
        "html",
        `<script data-bascik-build="pages">${body}</script>`,
      ),
    ).toContain("unknown-directive-value");
    expect(
      codesFor(
        "/site/src/pages/a.html",
        "html",
        `<script data-bascik-build="page">${body}</script>`,
      ),
    ).toContain("unknown-directive-value");
    expect(
      codesFor(
        "/site/src/pages/a.html",
        "html",
        `<script data-bascik-build>${body}</script>`,
      ),
    ).not.toContain("unknown-directive-value");
  });

  it.each([
    "/site/src/components/site-footer.html",
    "/site/src/pages/index.html",
  ])("accepts a bare build-once directive in %s", (file) => {
    const body = 'export default () => "<p>shared</p>";';
    expect(
      codesFor(file, "html", `<script data-bascik-build-once>${body}</script>`),
    ).toEqual([]);
    expect(
      codesFor(
        file,
        "html",
        `<script data-bascik-build-once="yes">${body}</script>`,
      ),
    ).toContain("unknown-directive-value");
    expect(
      codesFor(
        file,
        "html",
        `<script data-bascik-build data-bascik-build-once>${body}</script>`,
      ),
    ).toContain("script-mode-conflict");
  });

  it("gives conflicting script directives their rule id", () => {
    const page =
      '<script data-bascik-build data-bascik-server>export default () => "";</script>';
    expect(codesFor("/site/src/pages/a.html", "html", page)).toContain(
      "script-mode-conflict",
    );
  });

  it("checks component layout in component files only", () => {
    const component =
      "<script>const a = 1;</script>\n<p>hi</p>\n<style>p { color: red; }</style>\n";
    expect(
      codesFor("/site/src/components/my-card.html", "html", component).filter(
        (code) => code === "component-structure-order",
      ),
    ).toHaveLength(2);
    expect(codesFor("/site/src/pages/a.html", "html", component)).not.toContain(
      "component-structure-order",
    );
  });

  it.each(["", '="page"'])(
    "accepts components whose markup comes entirely from a build script%s",
    (value) => {
      const component = [
        "<!-- All markup is generated at build time. -->",
        "<style>.card { color: red; }</style>",
        `<script data-bascik-build${value}>`,
        "export default () => '<article class=\"card\">Generated</article>';",
        "</script>",
      ].join("\n");
      expect(
        codesFor("/site/src/components/my-card.html", "html", component),
      ).not.toContain("component-structure-order");
      expect(
        codesFor(
          "/site/src/components/my-card.html",
          "html",
          component + "\n<p>Static markup</p>",
        ),
      ).toContain("component-structure-order");
    },
  );
});

describe("API route rules", () => {
  it("give every diagnostic a rule id", () => {
    const source =
      'export const get = async (): Promise<string> => "x";\nawait request.json();\n';
    expect(
      analyzeApiRouteSource(source)
        .map((d) => d.code)
        .sort(),
    ).toEqual([
      "api-handler-return-type",
      "api-unguarded-json",
      "invalid-method-case",
      "missing-method-handler",
    ]);
  });

  it("are applied in directory.api, wherever the config puts it", () => {
    const route = 'export const get = () => new Response("x");\n';
    const custom = snapshot({ apiRoot: "/site/server/routes" });
    expect(
      codesFor("/site/server/routes/users.ts", "typescript", route, custom),
    ).toContain("invalid-method-case");
    expect(
      codesFor("/site/src/api/users.ts", "typescript", route, custom),
    ).not.toContain("invalid-method-case");
  });

  it("reports a middleware file by its rule id", () => {
    const route = 'export const GET = () => new Response("x");\n';
    expect(
      codesFor("/site/src/api/_middleware.ts", "typescript", route),
    ).toContain("middleware-unsupported");
  });

  it("reads directory.api from the config source, and does not mistake apiTimeout for it", () => {
    expect(
      parseApiRoot("export default { directory: { api: 'server/routes' } };"),
    ).toBe("server/routes");
    expect(parseApiRoot("export default { http: { apiTimeout: 5000 } };")).toBe(
      "src/api",
    );
    expect(parseApiRoot(undefined)).toBe("src/api");
  });
});

// These cases moved here from `bascik --check`'s own tests when the rules did. Each is a real mistake the rule
// has to find, or a look-alike it has to leave alone.
describe("rules moved from bascik --check keep their edge cases", () => {
  const page = "/site/src/pages/index.html";
  const component = "/site/src/components/my-comp/my-comp.html";
  const diagnosticsFor = (path: string, languageId: string, text: string) =>
    createDiagnostics(
      TextDocument.create(`file://${path}`, languageId, 1, text),
      path,
      snapshot(),
    );

  describe("unknown data-bascik-* attributes", () => {
    it("reads only real open-tag attribute names, and reports the line of the tag", () => {
      const text = [
        "<p>literal data-bascik-not-real text is not an attribute</p>",
        '<div data-bascik-propps="x"></div>',
      ].join("\n");
      const found = diagnosticsFor(page, "html", text).filter(
        (d) => d.code === "unknown-bascik-attribute",
      );
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"data-bascik-propps"');
      expect(found[0].range.start.line).toBe(1);
    });

    it("finds the attribute after a quoted > on the same tag", () => {
      const found = diagnosticsFor(
        page,
        "html",
        '<div title="a > b" data-bascik-typo="1"></div>',
      ).filter((d) => d.code === "unknown-bascik-attribute");
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"data-bascik-typo"');
    });

    it("lists the known attributes so the typo is easy to fix", () => {
      const [found] = diagnosticsFor(
        page,
        "html",
        '<div data-bascik-props="x"></div>',
      ).filter((d) => d.code === "unknown-bascik-attribute");
      expect(found.message).toContain("data-bascik-prop-");
    });
  });

  describe("script directives", () => {
    it("reports a conflict as an error on the line of the script", () => {
      const text =
        "<script data-bascik-build data-bascik-server>console.log(1)</script>";
      const [found] = diagnosticsFor(page, "html", text).filter(
        (d) => d.code === "script-mode-conflict",
      );
      expect(found).toBeDefined();
      expect(found.severity).toBe(1);
    });

    it("reads directives after a quoted attribute value containing >", () => {
      const text = [
        '<script data-note="a > b" data-bascik-build data-bascik-server>console.log(1)</script>',
        '<script data-note="x > y" data-bascik-build>',
        '  export default () => "dynamic-card";',
        "</script>",
      ].join("\n");
      const found = diagnosticsFor(page, "html", text).filter(
        (d) => d.code === "script-mode-conflict",
      );
      expect(found).toHaveLength(1);
      expect(found[0].range.start.line).toBe(0);
    });

    it("reports every nonempty data-bascik-build value", () => {
      const text = [
        '<script data-bascik-build="pages">export default () => "a"</script>',
        '<script data-bascik-build = "page">export default () => "b"</script>',
        '<script data-bascik-build=PAGE>export default () => "c"</script>',
        '<script data-bascik-build="">export default () => "d"</script>',
        '<script data-bascik-build>export default () => "e"</script>',
        '<script data-bascik-build=static>export default () => "f"</script>',
      ].join("\n");
      const found = diagnosticsFor(page, "html", text).filter(
        (d) => d.code === "unknown-directive-value",
      );
      expect(found.map((d) => d.range.start.line)).toEqual([0, 1, 2, 5]);
      expect(found[0].message).toContain("does not take a value");
    });
  });

  describe("component layout", () => {
    it("reports a script before the markup and a style after it, each once", () => {
      const text = "<script>1</script><div>Card</div><style>.x{}</style>";
      const found = diagnosticsFor(component, "html", text).filter(
        (d) => d.code === "component-structure-order",
      );
      expect(found).toHaveLength(2);
      expect(found.every((d) => d.severity === 2)).toBe(true);
    });

    it("is not fooled by markup-like text in styles, scripts, comments, or preserved subtrees", () => {
      const text = [
        '<style>.x::before { content: "<div"; } /* :is(p) */</style>',
        '<div data-note="x > y" data-bascik-preserve><my-comp></my-comp></div>',
        '<script>// el.id = "commented";</script>',
        '<script data-bascik-build>const node = { id: "server-only" }; node.id = "ok"; export default () => "";</script>',
      ].join("\n");
      const found = diagnosticsFor(component, "html", text).filter(
        (d) => d.severity !== 3 && d.code !== "unknown-bascik-attribute",
      );
      expect(found).toEqual([]);
    });
  });

  describe("scoping compatibility", () => {
    it("flags [id] selectors and element names in :is() as errors, but not #id or a hex color", () => {
      const text = `<style>
            #report-form { display: grid; color: #fff; }
            [id="report-form"] { color: red; }
            :is(div, span) { font-size: 14px; }
          </style><form id="report-form"></form>`;
      const found = diagnosticsFor(component, "html", text).filter((d) =>
        /css-/.test(String(d.code)),
      );
      expect(found).toHaveLength(2);
      expect(found.every((d) => d.severity === 1)).toBe(true);
      expect(
        found.some((d) =>
          messageText(d.message).includes("[id] attribute selectors"),
        ),
      ).toBe(true);
      expect(
        found.some((d) =>
          messageText(d.message).includes("Element names inside :is()"),
        ),
      ).toBe(true);
    });

    it("flags a runtime .id setter, an attribute selector, and removeAttribute", () => {
      const text = `<div id="box"></div><script>
            el.id = "new-id";
            document.querySelector("[data-active]");
            el.removeAttribute("class");
          </script>`;
      const found = diagnosticsFor(component, "html", text).filter((d) =>
        /^js-/.test(String(d.code)),
      );
      expect(found).toHaveLength(3);
      expect(
        found.some((d) =>
          messageText(d.message).includes("Runtime .id assignment"),
        ),
      ).toBe(true);
      expect(
        found.some((d) =>
          messageText(d.message).includes(
            "Attribute selectors are not rewritten",
          ),
        ),
      ).toBe(true);
      expect(
        found.some((d) => messageText(d.message).includes("removeAttribute")),
      ).toBe(true);
    });

    it("checks inline TypeScript component scripts like JavaScript ones, as the compiler does", () => {
      for (const type of ["text/typescript", "TEXT/TypeScript"]) {
        const text = `<div class="a"></div><script type="${type}">const el = document.querySelector("div")!; el.id = "x";</script>`;
        expect(
          diagnosticsFor(component, "html", text)
            .filter((d) => /^js-/.test(String(d.code)))
            .map((d) => d.code),
        ).toEqual(["js-id-setter"]);
      }
      // A script type the browser does not run (a data block) is not code, so it stays unchecked.
      const dataBlock =
        '<div class="a"></div><script type="application/json">{"id": "x", "el.id = 1": true}</script>';
      expect(
        diagnosticsFor(component, "html", dataBlock).filter((d) =>
          /^js-/.test(String(d.code)),
        ),
      ).toEqual([]);
    });

    it("checks inline style blocks whatever their end tag spelling, and skips <style-guide>", () => {
      const text =
        '<style-guide>[data-a] text</style-guide><div class="x"></div>' +
        "<style>[data-b] { color: red; }</style/>" +
        "<style>[data-c] { color: red; }</style\n foo>";
      const found = diagnosticsFor(component, "html", text).filter((d) =>
        /^css-/.test(String(d.code)),
      );
      expect(found).toHaveLength(2);
      expect(
        found.every((d) =>
          messageText(d.message).includes("Standalone attribute selectors"),
        ),
      ).toBe(true);
    });

    it("reports every occurrence, not just the first, and none inside comments", () => {
      const css =
        "[data-a] { color: red; }\n/* [data-b] { color: red; } */\n[data-c] { color: red; }\n";
      const found = diagnosticsFor(
        "/site/src/components/my-comp/my-comp.css",
        "css",
        css,
      );
      expect(found.map((d) => d.range.start.line)).toEqual([0, 2]);
    });

    it("does not apply to pages, which Bascik does not scope, or to directive scripts, which run in Node", () => {
      const pageWithDom =
        '<script>document.querySelector("[data-x]");</script>';
      expect(
        diagnosticsFor(page, "html", pageWithDom).filter((d) =>
          /^js-/.test(String(d.code)),
        ),
      ).toEqual([]);
      const buildScript =
        '<script data-bascik-build>export default () => { el.id = "x"; return ""; };</script>';
      expect(
        diagnosticsFor(component, "html", buildScript).filter((d) =>
          /^js-/.test(String(d.code)),
        ),
      ).toEqual([]);
    });
  });

  describe("API routes", () => {
    it("flags _middleware.ts as an error with the documented message", () => {
      const found = diagnosticsFor(
        "/site/src/api/_middleware.ts",
        "typescript",
        "export default function middleware() {}",
      ).filter((d) => d.code === "middleware-unsupported");
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe(1);
      expect(found[0].message).toContain(
        "Middleware chains (_middleware.ts) are not supported by design",
      );
    });

    it("reports a file that exports no method handler, and a method export that is not uppercase", () => {
      const none = diagnosticsFor(
        "/site/src/api/none.ts",
        "typescript",
        "export const helper = () => 1;\n",
      );
      expect(
        none.some(
          (d) => d.code === "missing-method-handler" && d.severity === 1,
        ),
      ).toBe(true);
      const lower = diagnosticsFor(
        "/site/src/api/lower.ts",
        "typescript",
        'export async function Post() { return new Response("x"); }\n',
      );
      expect(
        lower.some((d) => d.code === "invalid-method-case" && d.severity === 2),
      ).toBe(true);
    });
  });
});

describe("every diagnostic can be named", () => {
  // A diagnostic with no rule id cannot be suppressed (`bascik-ignore <id>`, `disabledRules`) or searched for in the
  // docs. This feeds the analyzer one mistake for each rule that used to be anonymous.
  const component = "/site/src/components/widget.html";
  const withUsage = snapshot({
    componentMap: new Map([["my-card", "/site/src/components/my-card.html"]]),
    componentMetadata: new Map([
      [
        "my-card",
        {
          description: "",
          props: [],
          slots: [],
          hasStyles: false,
          hasScripts: false,
          diagnostics: [],
        },
      ],
    ]),
  });

  const emitted = (path: string, text: string, project = withUsage) =>
    createDiagnostics(
      TextDocument.create(`file://${path}`, "html", 1, text),
      path,
      project,
    );

  it.each([
    ["component-name-not-hyphenated", component, "<p>hi</p>"],
    [
      "id-reference-undeclared",
      "/site/src/components/my-card.html",
      '<label for="missing">x</label>',
    ],
    [
      "unknown-preserve-token",
      "/site/src/pages/a.html",
      '<p data-bascik-preserve="nope">x</p>',
    ],
    [
      "external-form-missing-preserve-name",
      "/site/src/components/my-card.html",
      '<form action="https://example.com/post"></form>',
      { scopesName: true },
    ],
    [
      "shared-name-group",
      "/site/src/components/my-card.html",
      '<input type="radio" name="a"><input type="radio" name="a">',
      {
        componentSourceByFile: new Map([
          [
            "/site/src/components/my-card.html",
            '<input type="radio" name="a"><input type="radio" name="a">',
          ],
        ]),
        htmlUsageByFile: new Map([
          ["/site/src/pages/index.html", "<my-card></my-card><my-card />"],
        ]),
      },
    ],
    [
      "attr-prop-unsupplied",
      "/site/src/components/my-card.html",
      '<a data-bascik-attr-href="href">x</a>',
    ],
    [
      "directive-on-non-script",
      "/site/src/pages/a.html",
      "<div data-bascik-build></div>",
    ],
    [
      "slot-outside-component",
      "/site/src/pages/a.html",
      "<div data-bascik-slot></div>",
    ],
    [
      "undeclared-slot",
      "/site/src/pages/a.html",
      '<my-card><p data-bascik-slot="missing">x</p></my-card>',
    ],
  ] as Array<[string, string, string, Partial<ProjectSnapshot>?]>)(
    "%s",
    (code, path, text, extra) => {
      const found = emitted(path, text, { ...withUsage, ...extra });
      expect(found.map((d) => d.code)).toContain(code);
      expect(found.filter((d) => d.code === undefined)).toEqual([]);
    },
  );

  it("treats an unsupplied attr prop as a hint, not a warning, because it cannot see pages built from Markdown", () => {
    const [found] = emitted(
      "/site/src/components/my-card.html",
      '<a data-bascik-attr-href="href">x</a>',
    ).filter((d) => d.code === "attr-prop-unsupplied");
    expect(found.severity).toBe(3);
  });
});

describe("component-name-not-hyphenated", () => {
  // Windows paths start with a drive letter. resolveComponentRoots stores roots with forward
  // slashes, and the editor and --check pass the file's native path.
  const windowsProject = snapshot({
    projectRoot: "C:/site",
    componentRoots: ["C:/site/src/components"],
    importRoot: "C:/site/src",
    apiRoot: "C:/site/src/api",
  });

  it("warns for an unhyphenated component on a Windows path", () => {
    expect(
      codesFor(
        "C:\\site\\src\\components\\card.html",
        "html",
        "<article>hi</article>",
        windowsProject,
      ),
    ).toContain("component-name-not-hyphenated");
  });

  it("stays quiet for a hyphenated component and for a page, on either path style", () => {
    expect(
      codesFor(
        "C:\\site\\src\\components\\demo-card.html",
        "html",
        "<article>hi</article>",
        windowsProject,
      ),
    ).not.toContain("component-name-not-hyphenated");
    expect(
      codesFor(
        "C:\\site\\src\\pages\\card.html",
        "html",
        "<p>hi</p>",
        windowsProject,
      ),
    ).not.toContain("component-name-not-hyphenated");
    expect(
      codesFor("/site/src/pages/card.html", "html", "<p>hi</p>"),
    ).not.toContain("component-name-not-hyphenated");
  });

  it("does not fire for a document with no file path, such as an unsaved buffer", () => {
    expect(
      codesFor("Untitled-1", "html", "<p>hi</p>", windowsProject),
    ).not.toContain("component-name-not-hyphenated");
  });
});

describe("attr-prop-unsupplied", () => {
  const ITEM = '<a data-bascik-attr-href="href">x</a>';
  // A component root outside src, as a monorepo's shared components are (directory.components: ["components"]).
  const sharedProject = (listSource: string) =>
    snapshot({
      componentRoots: ["/site/components"],
      componentMap: new Map([
        ["card-item", "/site/components/card-item.html"],
        ["card-list", "/site/components/card-list.html"],
      ]),
      componentSourceByFile: new Map([
        ["/site/components/card-item.html", ITEM],
        ["/site/components/card-list.html", listSource],
      ]),
    });

  it("counts a usage in a sibling component under a root outside src", () => {
    expect(
      codesFor(
        "/site/components/card-item.html",
        "html",
        ITEM,
        sharedProject('<card-item data-bascik-prop-href="/x"></card-item>'),
      ),
    ).not.toContain("attr-prop-unsupplied");
  });

  it("still hints when that sibling misspells the prop", () => {
    expect(
      codesFor(
        "/site/components/card-item.html",
        "html",
        ITEM,
        sharedProject('<card-item data-bascik-prop-hrf="/x"></card-item>'),
      ),
    ).toContain("attr-prop-unsupplied");
  });
});
