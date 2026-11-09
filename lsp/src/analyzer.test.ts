import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity } from "vscode-languageserver";
import type { CompletionItem, TextEdit } from "vscode-languageserver";
import {
  createDiagnostics,
  createCompletions,
  createHover,
  createDefinition,
  createCodeActions,
  applyAutoFixes,
  escapeMarkdownText,
} from "./analyzer.js";
import { type ProjectSnapshot } from "./project.js";

/** What accepting a completion inserts. */
const insertedText = (item: CompletionItem | undefined): string | undefined =>
  (item?.textEdit as TextEdit | undefined)?.newText;

describe("Bascik Language Server Analyzer", () => {
  const mockSnapshot: ProjectSnapshot = {
    projectRoot: "/test-project",
    componentRoots: ["/test-project/src/components"],
    componentMap: new Map([
      ["site-nav", "/test-project/src/components/site-nav.html"],
      ["docs-head", "/test-project/src/components/docs-head.html"],
    ]),
    componentMetadata: new Map([
      [
        "site-nav",
        {
          description: "Top navigation bar",
          props: [{ name: "title", description: "Page title" }],
          slots: [{ name: "actions", description: "Action buttons" }],
          defaultSlot: { name: "default", description: "Content" },
          hasStyles: false,
          hasScripts: false,
          diagnostics: [],
        },
      ],
      [
        "docs-head",
        {
          description: "Document head elements",
          props: [],
          slots: [],
          hasStyles: false,
          hasScripts: false,
          diagnostics: [],
        },
      ],
    ]),
    importRoot: "/test-project/src",
    htmlUsageByFile: new Map(),
  };

  it("provides component tag completions with snippets", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<site",
    );
    const completions = createCompletions(
      doc,
      { line: 0, character: 5 },
      mockSnapshot,
    );
    expect(completions).toBeDefined();
    const siteNav = completions?.find((c) => c.label === "site-nav");
    expect(siteNav).toBeDefined();
    expect(insertedText(siteNav)).toBe("<site-nav>$0</site-nav>");

    const docVoid = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<docs",
    );
    const completionsVoid = createCompletions(
      docVoid,
      { line: 0, character: 5 },
      mockSnapshot,
    );
    const docsHead = completionsVoid?.find((c) => c.label === "docs-head");
    expect(insertedText(docsHead)).toBe("<docs-head />$0");
  });

  it('replaces the typed "<" and filters on it, so the editor does not hide the item', () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<p>hi</p>\n<site",
    );
    const completions =
      createCompletions(doc, { line: 1, character: 5 }, mockSnapshot) ?? [];
    const siteNav = completions.find((c) => c.label === "site-nav");
    // The replacement starts at the "<" (column 0), so what is typed ("<site") is what the filter text must match.
    expect((siteNav?.textEdit as TextEdit).range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 5 },
    });
    expect(siteNav?.filterText).toBe("<site-nav");
    for (const shorthand of createCompletions(
      TextDocument.create(
        "file:///test-project/src/pages/index.html",
        "html",
        1,
        "<bascik-",
      ),
      { line: 0, character: 8 },
      mockSnapshot,
    ) ?? []) {
      expect(shorthand.filterText).toBe(`<${shorthand.label}`);
      expect((shorthand.textEdit as TextEdit).range.start).toEqual({
        line: 0,
        character: 0,
      });
    }
  });

  it("provides component prop completions", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<site-nav ",
    );
    const completions = createCompletions(
      doc,
      { line: 0, character: 10 },
      mockSnapshot,
    );
    expect(completions).toBeDefined();
    const propTitle = completions?.find(
      (c) => c.label === "data-bascik-prop-title",
    );
    expect(propTitle).toBeDefined();
  });

  it("provides script directive completions with updated documentation", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<script ",
    );
    const completions = createCompletions(
      doc,
      { line: 0, character: 8 },
      mockSnapshot,
    );
    expect(completions).toBeDefined();
    expect(completions?.map((c) => c.label)).toEqual([
      "data-bascik-build",
      "data-bascik-build-once",
      "data-bascik-routes",
      "data-bascik-server",
      "data-bascik-stream",
    ]);
    const buildItem = completions?.find((c) => c.label === "data-bascik-build");
    expect((buildItem?.documentation as { value: string })?.value).toContain(
      "The default exported handler function returns HTML markup that replaces this script tag in the generated HTML.",
    );
    const routesItem = completions?.find(
      (c) => c.label === "data-bascik-routes",
    );
    expect((routesItem?.documentation as { value: string })?.value).toContain(
      "The default exported handler function returns an array of dynamic route parameters to generate multiple pages from a template.",
    );
  });

  it("says stream scripts run on the dev server too, as server scripts do and the docs say", () => {
    const docOf = (text: string, label: string) => {
      const items =
        createCompletions(
          TextDocument.create(
            "file:///test-project/src/pages/index.html",
            "html",
            1,
            text,
          ),
          { line: 0, character: text.length },
          mockSnapshot,
        ) ?? [];
      const item = items.find((c) => c.label === label);
      const documentation = item?.documentation;
      return typeof documentation === "string"
        ? documentation
        : (documentation?.value ?? "");
    };
    for (const documentation of [
      docOf("<script ", "data-bascik-stream"),
      docOf("<bascik-", "bascik-stream"),
    ]) {
      expect(documentation).toContain(
        "per request on production and dev servers",
      );
    }
  });

  it("provides script shorthand completions (<bascik-...) expanding to script blocks", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<bascik-",
    );
    const completions = createCompletions(
      doc,
      { line: 0, character: 8 },
      mockSnapshot,
    );
    expect(completions).toBeDefined();
    const buildShorthand = completions?.find((c) => c.label === "bascik-build");
    expect(buildShorthand).toBeDefined();
    expect(insertedText(buildShorthand)).toBe(
      "<script data-bascik-build>\n  export default async function () {\n    return `$0`;\n  }\n</script>",
    );

    const routesShorthand = completions?.find(
      (c) => c.label === "bascik-routes",
    );
    expect(routesShorthand).toBeDefined();
    expect(insertedText(routesShorthand)).toBe(
      "<script data-bascik-routes>\n  export default async function () {\n    return [\n      $0\n    ];\n  }\n</script>",
    );

    const serverShorthand = completions?.find(
      (c) => c.label === "bascik-server",
    );
    expect(serverShorthand).toBeDefined();
    expect(insertedText(serverShorthand)).toBe(
      "<script data-bascik-server>\n  export default async function (request, context, { signal }) {\n    return `$0`;\n  }\n</script>",
    );

    const streamShorthand = completions?.find(
      (c) => c.label === "bascik-stream",
    );
    expect(streamShorthand).toBeDefined();
    expect(insertedText(streamShorthand)).toBe(
      "<script data-bascik-stream>\n  export default async function (request, context, { signal }) {\n    return `$0`;\n  }\n</script>",
    );
  });

  it("provides hover documentation on components", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<site-nav></site-nav>",
    );
    const hover = createHover(doc, { line: 0, character: 3 }, mockSnapshot);
    expect(hover).toBeDefined();
    const contents = hover?.contents as { value: string };
    expect(contents.value).toContain("Top&nbsp;navigation&nbsp;bar");
    expect(contents.value).toContain("`title`: Page&nbsp;title");
    expect(contents.value).toContain(
      `(${pathToFileURL("/test-project/src/components/site-nav.html").toString()})`,
    );
  });

  describe("escapeMarkdownText", () => {
    it("keeps prose literal: markup, emphasis, and links are not interpreted", () => {
      expect(
        escapeMarkdownText("Uses <unsafe> markup and *stars* and [a](b)"),
      ).toBe(
        "Uses&nbsp;<unsafe\\>&nbsp;markup&nbsp;and&nbsp;\\*stars\\*&nbsp;and&nbsp;\\[a\\]\\(b\\)",
      );
    });

    it("turns a newline into a hard break and leaves plain words alone", () => {
      expect(escapeMarkdownText("one\ntwo")).toBe("one\\\ntwo");
      expect(escapeMarkdownText("plain")).toBe("plain");
    });
  });

  it("diagnoses unclosed component tags", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<site-nav>",
    );
    const diags = createDiagnostics(
      doc,
      "/test-project/src/pages/index.html",
      mockSnapshot,
    );
    const unclosed = diags.find((d) => d.code === "unclosed-component-tag");
    expect(unclosed).toBeDefined();
  });

  it("attributes each data-bascik-slot to its own nearest component", () => {
    const text = [
      '<site-nav><p data-bascik-slot="actions">ok</p></site-nav>',
      '<p data-bascik-slot="actions">outside</p>',
      '<site-nav><div><p data-bascik-slot="actoins">typo</p></div></site-nav>',
      '<site-nav><p data-bascik-slot="actions">ok again</p></site-nav>',
    ].join("\n");
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      text,
    );
    const slotDiagnostics = createDiagnostics(
      doc,
      "/test-project/src/pages/index.html",
      mockSnapshot,
    )
      .filter((d) => /slot/.test(String(d.code)))
      .map((d) => [d.code, d.range.start.line]);
    expect(slotDiagnostics).toEqual([
      ["slot-outside-component", 1],
      ["undeclared-slot", 2],
    ]);
  });

  describe("component tag names end where HTML ends them", () => {
    const codesIn = (text: string) =>
      createDiagnostics(
        TextDocument.create(
          "file:///test-project/src/pages/index.html",
          "html",
          1,
          text,
        ),
        "/test-project/src/pages/index.html",
        mockSnapshot,
      ).map((d) => d.code);

    it("does not read a longer custom element that starts with a component name as that component", () => {
      expect(
        codesIn('<site-nav-toggle title="Menu">x</site-nav-toggle>'),
      ).toEqual([]);
      expect(codesIn('<site-nav-toggle title="Menu" />')).toEqual([]);
      expect(codesIn("<site-nav_x>")).toEqual([]);
    });

    it("still reads the component when whitespace, / or > ends its name", () => {
      expect(codesIn('<site-nav\n  title="Welcome"></site-nav>')).toEqual([
        "missing-prop-prefix",
      ]);
      expect(codesIn('<site-nav title="Welcome"/>')).toEqual([
        "missing-prop-prefix",
      ]);
      expect(codesIn("<site-nav>")).toEqual(["unclosed-component-tag"]);
    });

    it("accepts a closing tag with whitespace or attributes before >, as the compiler does", () => {
      for (const closer of [
        "</site-nav >",
        "</site-nav\n>",
        "</site-nav\t>",
        '</site-nav foo="x">',
        "</SITE-NAV>",
      ]) {
        expect(
          codesIn(`<site-nav data-bascik-prop-title="A">x${closer}`),
          closer,
        ).toEqual([]);
      }
    });

    it("does not take a longer data-bascik-prop-* name as supplying the prop", () => {
      expect(
        codesIn(
          '<site-nav title="A" data-bascik-prop-title-extra="B"></site-nav>',
        ),
      ).toContain("missing-prop-prefix");
    });

    it("still reports a component closed by a different tag, or by a longer name", () => {
      expect(
        codesIn('<site-nav data-bascik-prop-title="A">x</site-navx>'),
      ).toEqual(["unclosed-component-tag"]);
      expect(
        codesIn('<site-nav data-bascik-prop-title="A">x</site-nav-toggle>'),
      ).toEqual(["unclosed-component-tag"]);
    });

    it("counts a nested same-name component written with a newline after its name", () => {
      expect(
        codesIn(
          '<site-nav data-bascik-prop-title="A"><site-nav\ndata-bascik-prop-title="B"></site-nav>',
        ),
      ).toEqual(["unclosed-component-tag"]);
    });
  });

  it("diagnoses paired tag on zero-slot component", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<docs-head></docs-head>",
    );
    const diags = createDiagnostics(
      doc,
      "/test-project/src/pages/index.html",
      mockSnapshot,
    );
    const zeroSlot = diags.find(
      (d) => d.code === "prefer-self-closing-component",
    );
    expect(zeroSlot).toBeDefined();
  });

  it("diagnoses missing data-bascik-prop-* prefix when passing a declared prop name and provides quick fix", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      '<site-nav title="Welcome"><p>Body</p></site-nav><docs-head></docs-head>',
    );
    const diags = createDiagnostics(
      doc,
      "/test-project/src/pages/index.html",
      mockSnapshot,
    );
    const missingPrefix = diags.find((d) => d.code === "missing-prop-prefix");
    expect(missingPrefix).toBeDefined();
    expect(String(missingPrefix?.message)).toContain("data-bascik-prop-title");

    const actions = createCodeActions(
      doc,
      missingPrefix!.range,
      diags,
      mockSnapshot,
    );
    expect(actions.length).toBeGreaterThan(0);
    const edit = actions[0].edit?.changes?.[doc.uri]?.[0];
    expect(edit?.newText).toBe("data-bascik-prop-title");

    const fixed = applyAutoFixes(doc, mockSnapshot);
    expect(fixed.fixedCount).toBe(2);
    expect(fixed.text).toBe(
      '<site-nav data-bascik-prop-title="Welcome"><p>Body</p></site-nav><docs-head />',
    );
  });

  it("diagnoses script directive placed on non-script tag", () => {
    const doc = TextDocument.create(
      "file:///test-project/src/pages/index.html",
      "html",
      1,
      "<div data-bascik-build></div>",
    );
    const diags = createDiagnostics(
      doc,
      "/test-project/src/pages/index.html",
      mockSnapshot,
    );
    expect(
      diags.some((d) =>
        String(d.message).includes("only valid on <script> tags"),
      ),
    ).toBe(true);
  });

  describe("script and style blocks follow the browser tag rules", () => {
    const componentPath = "/test-project/src/components/demo-card.html";
    const diagnose = (source: string) =>
      createDiagnostics(
        TextDocument.create(`file://${componentPath}`, "html", 1, source),
        componentPath,
        mockSnapshot,
      ).map((d) => d.code);

    it("reports compatibility errors inside an inline <style> block", () => {
      // The body was read from text with style contents blanked, so nothing matched.
      expect(
        diagnose(
          '<div class="a"></div><style>[data-x] { color: red; }</style>',
        ),
      ).toContain("css-attribute-selector");
    });

    it.each([
      ["</style/>"],
      ["</style foo>"],
      ["</style\t\n bar>"],
      ["</STYLE >"],
    ])("checks a <style> block ending in %j", (endTag) => {
      expect(
        diagnose(
          `<div class="a"></div><style>[data-x] { color: red; }${endTag}`,
        ),
      ).toContain("css-attribute-selector");
    });

    it.each([["</script/>"], ["</script foo>"], ["</script\t\n bar>"]])(
      "checks a <script> block ending in %j",
      (endTag) => {
        expect(
          diagnose(`<div class="a"></div><script>el.id = "x";${endTag}`),
        ).toContain("js-id-setter");
      },
    );

    it("does not end a <script> block at </script followed by a no-break space", () => {
      // `</script\u00a0>` is script text, so the block runs to the real end tag.
      expect(
        diagnose(
          '<div class="a"></div><script>a();</script\u00a0>el.id = "x";</script>',
        ),
      ).toContain("js-id-setter");
    });

    it("reports the same lines as the build after a five-line @bascik doc comment", () => {
      // Finding 104: pkg components.test.ts pins the build warnings for this file at 11 and 15.
      const source =
        "<!-- @bascik\nA book card.\n@prop title - The title.\n@prop author - The author.\n-->\n" +
        "<article>\n  <h2 data-bascik-prop-title></h2>\n  <p data-bascik-prop-author></p>\n</article>\n" +
        "<style>\n  [data-state] { color: blue; }\n</style>\n" +
        '<script>\n  const el = document.getElementById("card");\n  el.id = "new-card";\n</script>\n';
      const lines = createDiagnostics(
        TextDocument.create(`file://${componentPath}`, "html", 1, source),
        componentPath,
        mockSnapshot,
      )
        .filter(
          (d) =>
            d.code === "css-attribute-selector" || d.code === "js-id-setter",
        )
        .map((d) => [d.code, d.range.start.line + 1]);
      expect(lines).toEqual(
        expect.arrayContaining([
          ["css-attribute-selector", 11],
          ["js-id-setter", 15],
        ]),
      );
      expect(lines).toHaveLength(2);
    });

    it("reports an unclosed { and a stray } in a component <style> at the brace's line (finding 42)", () => {
      const braces = (source: string) =>
        createDiagnostics(
          TextDocument.create(`file://${componentPath}`, "html", 1, source),
          componentPath,
          mockSnapshot,
        )
          .filter((d) => d.code === "css-unbalanced-braces")
          .map((d) => [d.range.start.line + 1, d.range.start.character]);
      expect(
        braces(
          '<!-- doc\n-->\n<p class="a">x</p>\n<style>\n  .a { color: red;\n</style>\n',
        ),
      ).toEqual([[5, 5]]);
      expect(
        braces(
          '<p class="a">x</p>\n<style>\n  .a { color: red; }\n  }\n</style>\n',
        ),
      ).toEqual([[4, 2]]);
      expect(
        braces(
          '<p class="a">x</p>\n<style>\n  .a::after { content: "}"; }\n  /* { */\n  @media (min-width: 1px) { .a { & b { color: red; } } }\n</style>\n',
        ),
      ).toEqual([]);
      expect(
        braces('<p class="a">x</p>\n<!-- <style> .a { </style> -->\n'),
      ).toEqual([]);
    });

    it("reports an unbalanced brace in a component's companion stylesheet", () => {
      const cssPath = "/test-project/src/components/demo-card.css";
      const found = createDiagnostics(
        TextDocument.create(
          `file://${cssPath}`,
          "css",
          1,
          ".a {\n  color: red;\n\n.b { color: blue; }\n",
        ),
        cssPath,
        mockSnapshot,
      ).filter((d) => d.code === "css-unbalanced-braces");
      expect(found.map((d) => d.range.start.line + 1)).toEqual([1]);
      expect(String(found[0]?.message)).toContain('Add the missing "}"');
    });

    it("warns at the selector for CSS and class queries that only reach preserved elements (finding 22)", () => {
      const preserved = (
        source: string,
        snapshot: ProjectSnapshot = mockSnapshot,
      ) =>
        createDiagnostics(
          TextDocument.create(`file://${componentPath}`, "html", 1, source),
          componentPath,
          snapshot,
        )
          .filter(
            (d) =>
              d.code === "css-preserved-target" ||
              d.code === "js-preserved-target",
          )
          .map((d) => [
            d.code,
            d.range.start.line + 1,
            source
              .split("\n")
              [d.range.start.line].slice(
                d.range.start.character,
                d.range.end.character,
              ),
            d.severity,
          ]);
      const source =
        '<!-- doc\n-->\n<div class="note"><code class="inline" id="snippet">x</code></div>\n<style>\n  .note code { color: red; }\n  .inline, #snippet { color: red; }\n  .note { color: blue; }\n</style>\n<script>\n  document.getElementById("snippet");\n  document.querySelector(".note .inline");\n</script>\n';
      expect(preserved(source)).toEqual([
        ["css-preserved-target", 5, "code", DiagnosticSeverity.Warning],
        ["css-preserved-target", 6, ".inline", DiagnosticSeverity.Warning],
        ["css-preserved-target", 6, "#snippet", DiagnosticSeverity.Warning],
        ["js-preserved-target", 11, ".inline", DiagnosticSeverity.Warning],
      ]);
      // The project's scoping.preserve list decides: an empty list preserves nothing, a wildcard matches.
      expect(preserved(source, { ...mockSnapshot, preserve: [] })).toEqual([]);
      expect(
        preserved(
          '<x-chart class="chart-a"></x-chart><p data-bascik-preserve="class" class="kept"></p>\n<style>\n  .chart-a, .kept { color: red; }\n</style>\n',
          { ...mockSnapshot, preserve: ["x-*"] },
        ).map(([, line, written]) => [line, written]),
      ).toEqual([
        [3, ".chart-a"],
        [3, ".kept"],
      ]);
      // A page, or a file outside any project, is never scoped, so its `code {}` rule works.
      const pagePath = "/test-project/src/pages/index.html";
      for (const snapshot of [mockSnapshot, undefined]) {
        expect(
          createDiagnostics(
            TextDocument.create(`file://${pagePath}`, "html", 1, source),
            pagePath,
            snapshot,
          ).filter((d) => String(d.code).endsWith("preserved-target")),
        ).toEqual([]);
      }
      // A class a scoped element shares stays quiet.
      expect(
        preserved(
          '<code class="shared">x</code><em class="shared"></em>\n<style>\n  .shared { color: red; }\n</style>\n',
        ),
      ).toEqual([]);
    });

    it("warns in a companion stylesheet for a class only its component's preserved elements carry", () => {
      const cssPath = "/test-project/src/components/demo-card.css";
      const found = createDiagnostics(
        TextDocument.create(
          `file://${cssPath}`,
          "css",
          1,
          ".a {}\n.inline { color: red; }\n",
        ),
        cssPath,
        mockSnapshot,
        [
          {
            fsPath: componentPath,
            text: '<p class="a"></p><code class="inline">x</code>\n',
          },
        ],
      ).filter((d) => d.code === "css-preserved-target");
      expect(found.map((d) => d.range.start.line + 1)).toEqual([2]);
      expect(String(found[0]?.message)).toContain('".inline"');
    });

    it("does not read a <style-guide> or <script-loader> element as a style or script block", () => {
      const codes = diagnose(
        "<style-guide>[data-x] text</style-guide><style>.a { color: red; }</style>" +
          '<script-loader>el.id = "x";</script-loader><script>run();</script>',
      );
      expect(codes).not.toContain("css-attribute-selector");
      expect(codes).not.toContain("js-id-setter");
    });

    it("recognizes unquoted and whitespace-spaced ID declarations and references in components", () => {
      const diags = createDiagnostics(
        TextDocument.create(
          `file://${componentPath}`,
          "html",
          1,
          "<input id = email /><label for=email>Email</label><a href=#missing>Jump</a>",
        ),
        componentPath,
        mockSnapshot,
      );
      const messages = diags.map((d) => d.message);
      expect(messages.some((m) => String(m).includes('"email"'))).toBe(false);
      expect(messages.some((m) => String(m).includes('"missing"'))).toBe(true);
    });
  });
  describe("external form preserve check", () => {
    // Only a project that opts in to name scoping renames field names, so
    // only there does a form posting elsewhere need them kept literal.
    const formDiagnostics = (formTag: string, scopesName = true) => {
      const filePath = "/test-project/src/components/site-nav.html";
      const doc = TextDocument.create(
        `file://${filePath}`,
        "html",
        1,
        `${formTag}<input name="email"></form>`,
      );
      return createDiagnostics(doc, filePath, {
        ...mockSnapshot,
        scopesName,
      }).filter((d) =>
        String(d.message).includes("External form actions require"),
      );
    };

    it("is silent by default, when name ships as written", () => {
      expect(
        formDiagnostics('<form action="https://forms.example/submit">', false),
      ).toHaveLength(0);
    });

    it.each([
      '<form action="https://forms.example/submit" data-bascik-preserve>',
      '<form action="https://forms.example/submit" data-bascik-preserve="">',
      "<form action=https://forms.example/submit data-bascik-preserve = ''>",
      '<form action = "https://forms.example/submit" data-bascik-preserve = "name">',
      '<form action="https://forms.example/submit" data-bascik-preserve=name>',
    ])("accepts %s", (formTag) => {
      expect(formDiagnostics(formTag)).toHaveLength(0);
    });

    it.each([
      '<form action="https://forms.example/submit">',
      "<form action=https://forms.example/submit>",
      "<form action = //forms.example/submit/>",
      '<form action="https://forms.example/submit" data-bascik-preserve="class">',
      '<form action="https://forms.example/submit" data-note="data-bascik-preserve">',
    ])("warns for %s", (formTag) => {
      expect(formDiagnostics(formTag)).toHaveLength(1);
    });
  });
});
