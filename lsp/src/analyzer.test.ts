import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
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
    const formDiagnostics = (formTag: string) => {
      const filePath = "/test-project/src/components/site-nav.html";
      const doc = TextDocument.create(
        `file://${filePath}`,
        "html",
        1,
        `${formTag}<input name="email"></form>`,
      );
      return createDiagnostics(doc, filePath, mockSnapshot).filter((d) =>
        String(d.message).includes("External form actions require"),
      );
    };

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
