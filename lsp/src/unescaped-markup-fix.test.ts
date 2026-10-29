/**
 * The editor side of server-script-unescaped-markup: located diagnostics in
 * a page, the "Wrap template in html`...`" quick fix (two edits in one
 * WorkspaceEdit: the tag and the import), suppression and configuration, and
 * `bascik --check` output, where --fix leaves this rule alone because
 * wrapping changes the value's type from string to SafeHtml.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Diagnostic, TextEdit } from "vscode-languageserver";
import {
  applyAutoFixes,
  createCodeActions,
  createDiagnostics,
} from "./analyzer.js";
import { checkFiles, formatDiagnostic } from "./check.js";
import type { ProjectSnapshot } from "./project.js";

const RULE = "server-script-unescaped-markup";

let root: string;
const snapshot = (): ProjectSnapshot => ({
  projectRoot: root,
  componentRoots: [path.join(root, "src/components")],
  componentMap: new Map(),
  componentMetadata: new Map(),
  importRoot: path.join(root, "src"),
  htmlUsageByFile: new Map(),
});

const write = (relative: string, content: string): string => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-unescaped-markup-"));
  write("bascik.config.ts", "export default {};\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PAGE = (script: string): string =>
  `<!DOCTYPE html>
<html>
<body>
  <main>
    <script data-bascik-server>
${script}
    </script>
  </main>
</body>
</html>
`;

const SEARCH = `      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return \`<p>You searched for \${q}</p>\`;
      }`;

const open = (text: string) => {
  const fsPath = path.join(root, "src/pages/search.html");
  const doc = TextDocument.create(`file://${fsPath}`, "html", 1, text);
  return { doc, fsPath, diags: createDiagnostics(doc, fsPath, snapshot()) };
};

const markupDiags = (diags: Diagnostic[]) =>
  diags.filter((d) => d.code === RULE);

/** Applies a WorkspaceEdit's edits for `uri` to `text`, last first. */
const applyEdits = (doc: TextDocument, edits: TextEdit[]): string => {
  let text = doc.getText();
  const sorted = [...edits].sort(
    (a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start),
  );
  for (const edit of sorted)
    text =
      text.slice(0, doc.offsetAt(edit.range.start)) +
      edit.newText +
      text.slice(doc.offsetAt(edit.range.end));
  return text;
};

describe("diagnostics in a page", () => {
  it("is a warning on the hole, and names the file line of the template", () => {
    const { doc, diags } = open(PAGE(SEARCH));
    const found = markupDiags(diags);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe(2);
    expect(doc.getText(found[0].range)).toBe("${q}");
    expect(found[0].range.start.line + 1).toBe(8);
    expect(found[0].message).toContain("(line 8)");
    expect(found[0].source).toBe("bascik");
  });

  it("is not reported in a build script", () => {
    const { diags } = open(
      PAGE(SEARCH).replace("data-bascik-server", "data-bascik-build"),
    );
    expect(markupDiags(diags)).toEqual([]);
  });
});

describe("quick fix: Wrap template in html`...`", () => {
  const fixFor = (text: string) => {
    const { doc, diags } = open(text);
    const diag = markupDiags(diags)[0];
    expect(diag).toBeDefined();
    const actions = createCodeActions(doc, diag.range, diags, snapshot());
    const action = actions.find(
      (a) => a.title === "Wrap template in html`...`",
    );
    return { doc, action };
  };

  it("adds the tag and the import in one edit", () => {
    const { doc, action } = fixFor(PAGE(SEARCH));
    expect(action).toBeDefined();
    expect(action!.kind).toBe("quickfix");
    const edits = action!.edit!.changes![doc.uri];
    expect(edits).toHaveLength(2);
    const fixed = applyEdits(doc, edits);
    expect(fixed).toContain('import { html } from "@bascik/bascik/html";');
    expect(fixed).toContain("return html`<p>You searched for ${q}</p>`;");
    expect(markupDiags(open(fixed).diags)).toEqual([]);
  });

  it("puts the import after the script's last import", () => {
    const script = `      import { load } from "@/lib/data.ts";
      import { format } from "@/lib/format.ts";
${SEARCH}`;
    const { doc, action } = fixFor(PAGE(script));
    const fixed = applyEdits(doc, action!.edit!.changes![doc.uri]);
    const lines = fixed.split("\n");
    const at = lines.findIndex((l) => l.includes("@bascik/bascik/html"));
    expect(lines[at - 1]).toContain('from "@/lib/format.ts"');
  });

  it("merges html into an existing import from the module, once", () => {
    const script = `      import { esc } from "@bascik/bascik/html";
${SEARCH}`;
    const { doc, action } = fixFor(PAGE(script));
    const fixed = applyEdits(doc, action!.edit!.changes![doc.uri]);
    expect(fixed).toContain('import { esc, html } from "@bascik/bascik/html";');
    expect(fixed.match(/@bascik\/bascik\/html/g)).toHaveLength(1);
  });

  it("imports html as safeHtml when a local html binding exists", () => {
    const script = `      const html = "<p>static</p>";
${SEARCH}`;
    const { doc, action } = fixFor(PAGE(script));
    const fixed = applyEdits(doc, action!.edit!.changes![doc.uri]);
    expect(fixed).toContain(
      'import { html as safeHtml } from "@bascik/bascik/html";',
    );
    expect(fixed).toContain("return safeHtml`<p>You searched for ${q}</p>`;");
  });

  it("is not offered when a hole of the template sits where html would throw (onclick)", () => {
    const script = `      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return \`<p>\${q}</p><button onclick="\${q}">go</button>\`;
      }`;
    const { doc, diags } = open(PAGE(script));
    const actions = createCodeActions(
      doc,
      { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
      diags,
      snapshot(),
    );
    expect(actions.map((a) => a.title)).not.toContain(
      "Wrap template in html`...`",
    );
  });

  it("aliases the import when a local html binding exists and the module is already imported", () => {
    const script = `      import { safeUrl } from "@bascik/bascik/html";
      export default async function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        const html = \`<p>You searched for \${q}</p>\`;
        return html;
      }`;
    const { doc, action } = fixFor(PAGE(script));
    expect(action).toBeDefined();
    const fixed = applyEdits(doc, action!.edit!.changes![doc.uri]);
    expect(fixed).toContain(
      'import { safeUrl, html as safeHtml } from "@bascik/bascik/html";',
    );
    expect(fixed).toContain(
      "const html = safeHtml`<p>You searched for ${q}</p>`;",
    );
    expect(fixed.match(/@bascik\/bascik\/html/g)).toHaveLength(1);
  });

  it("aliases the import when a parameter named html shadows it", () => {
    const script = `      const layout = (title, html) => \`<h1>\${title}</h1><main>\${html}</main>\`;
      export default async function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return layout(q, "body");
      }`;
    const { doc, action } = fixFor(PAGE(script));
    expect(action).toBeDefined();
    const fixed = applyEdits(doc, action!.edit!.changes![doc.uri]);
    expect(fixed).toContain(
      'import { html as safeHtml } from "@bascik/bascik/html";',
    );
    expect(fixed).toContain(
      "(title, html) => safeHtml`<h1>${title}</h1><main>${html}</main>`",
    );
  });

  it("adds an alias next to an imported html that a parameter shadows", () => {
    const script = `      import { html } from "@bascik/bascik/html";
      const layout = (title, html) => \`<h1>\${title}</h1><main>\${html}</main>\`;
      export default async function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return layout(q, html\`<p>x</p>\`);
      }`;
    const { doc, action } = fixFor(PAGE(script));
    expect(action).toBeDefined();
    const fixed = applyEdits(doc, action!.edit!.changes![doc.uri]);
    expect(fixed).toContain(
      'import { html, html as safeHtml } from "@bascik/bascik/html";',
    );
    expect(fixed).toContain("(title, html) => safeHtml`<h1>");
  });

  it("is not offered when both html and safeHtml are taken", () => {
    const script = `      const safeHtml = 1;
      const layout = (title, html) => \`<h1>\${title}</h1><main>\${html}</main>\`;
      export default async function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return layout(q, "body");
      }`;
    const { doc, diags } = open(PAGE(script));
    expect(markupDiags(diags).length).toBeGreaterThan(0);
    const actions = createCodeActions(
      doc,
      { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
      diags,
      snapshot(),
    );
    expect(actions.map((a) => a.title)).not.toContain(
      "Wrap template in html`...`",
    );
  });

  it("the word html in markup, strings and comments (and b.html members) is no clash", () => {
    const script = `      // returns html
      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        const file = page.html + "html";
        return \`<html><p>You searched for \${q}</p></html>\`;
      }`;
    const { doc, action } = fixFor(PAGE(script));
    const fixed = applyEdits(doc, action!.edit!.changes![doc.uri]);
    expect(fixed).toContain('import { html } from "@bascik/bascik/html";');
    expect(fixed).toContain("return html`<html>");
  });

  it.each([
    ["a tag name", "`<h\${level}>\${q}</h\${level}>`"],
    ["an HTML comment", "`<!-- query: \${q} --><p>\${q}</p>`"],
  ])("is not offered when a hole is %s", (_name, ret) => {
    const script = `      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        const level = 2;
        return ${ret};
      }`;
    const { doc, diags } = open(PAGE(script));
    expect(markupDiags(diags).length).toBeGreaterThan(0);
    const actions = createCodeActions(
      doc,
      { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
      diags,
      snapshot(),
    );
    expect(actions.map((a) => a.title)).not.toContain(
      "Wrap template in html`...`",
    );
  });

  it("bascik --fix (applyAutoFixes) does not apply it", () => {
    const text = PAGE(SEARCH);
    const { doc, fsPath } = open(text);
    const result = applyAutoFixes(doc, snapshot(), fsPath);
    expect(result.text).toBe(text);
  });
});

describe("suppression and configuration", () => {
  it("// bascik-ignore server-script-unescaped-markup on the line before", () => {
    const script = SEARCH.replace(
      "        return",
      "        // bascik-ignore server-script-unescaped-markup\n        return",
    );
    expect(markupDiags(open(PAGE(script)).diags)).toEqual([]);
  });

  it("// bascik-ignore above a multi-line template covers holes on its later lines", () => {
    const script = `      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        // bascik-ignore server-script-unescaped-markup
        return \`<section>
          <p>Results for \${q}</p>
        </section>\`;
      }`;
    expect(markupDiags(open(PAGE(script)).diags)).toEqual([]);
    const unsuppressed = script.replace(
      "        // bascik-ignore server-script-unescaped-markup\n",
      "",
    );
    expect(markupDiags(open(PAGE(unsuppressed)).diags)).toHaveLength(1);
  });

  it("bascik-disable / bascik-enable ranges", () => {
    const script = `      // bascik-disable server-script-unescaped-markup
${SEARCH}
      // bascik-enable server-script-unescaped-markup`;
    expect(markupDiags(open(PAGE(script)).diags)).toEqual([]);
  });

  it("diagnostics.disabledRules", () => {
    write(
      "bascik.ext.json",
      JSON.stringify({ diagnostics: { disabledRules: [RULE] } }),
    );
    expect(markupDiags(open(PAGE(SEARCH)).diags)).toEqual([]);
  });

  it("diagnostics.serverScriptRules: false", () => {
    write(
      "bascik.ext.json",
      JSON.stringify({ diagnostics: { serverScriptRules: false } }),
    );
    expect(markupDiags(open(PAGE(SEARCH)).diags)).toEqual([]);
  });

  it("diagnostics.escapeFunctions trusts a project's own escaper", () => {
    const script = `      import { escapeHtml } from "@/lib/server.ts";
      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return \`<p>\${escapeHtml(q)}</p>\`;
      }`;
    expect(markupDiags(open(PAGE(script)).diags)).toHaveLength(1);
    write(
      "bascik.ext.json",
      JSON.stringify({ diagnostics: { escapeFunctions: ["escapeHtml"] } }),
    );
    expect(markupDiags(open(PAGE(script)).diags)).toEqual([]);
  });
});

describe("bascik --check", () => {
  it("prints file:line:col, the severity and the rule id", async () => {
    write("src/pages/search.html", PAGE(SEARCH));
    const result = await checkFiles({ cwd: root });
    const found = result.diagnostics.filter((d) => d.code === RULE);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      filePath: path.join("src", "pages", "search.html"),
      line: 8,
      severity: "warning",
    });
    const printed = formatDiagnostic(found[0]);
    expect(printed).toContain(`${path.join("src", "pages", "search.html")}:8:`);
    expect(printed).toContain(RULE);
    expect(printed).toContain("(hole 1)");
  });

  it("--fix leaves the template unwrapped", async () => {
    const file = write("src/pages/search.html", PAGE(SEARCH));
    await checkFiles({ cwd: root, fix: true });
    expect(fs.readFileSync(file, "utf8")).toBe(PAGE(SEARCH));
  });
});
