/**
 * The markup rules beyond inline server scripts (Collin 2026-10-31): every
 * agent-built Bascik site, static ones included, hand-built markup with
 * template literals and hand-written escapeHtml helpers in build scripts and
 * the .ts modules they import, and the linter said nothing. These tests cover
 * which files count as Node modules, `bascik --check` output for them (file
 * and line), the editor path with unsaved buffers, configuration and
 * suppression, and the quick fixes in a .ts file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { TextEdit } from "vscode-languageserver";
import { createCodeActions, createDiagnostics } from "./analyzer.js";
import { checkFiles } from "./check.js";
import { buildSnapshot } from "./project.js";
import {
  findScriptModules,
  normalizeModulePath,
  scriptModulesOf,
} from "./script-modules.js";

const MARKUP = "server-script-unescaped-markup";
const ESCAPER = "hand-written-html-escaper";

let root: string;
const write = (relative: string, content: string): string => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const rel = (file: string): string =>
  path.relative(root, file).replace(/\\/g, "/");

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "bascik-script-modules-")),
  );
  write("bascik.config.ts", "export default {};\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ESCAPE_HTML = `export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
`;

const PAGE = (scripts: string): string =>
  `<!doctype html>\n<html>\n  <body>\n    ${scripts}\n  </body>\n</html>\n`;

describe("findScriptModules: which files run in Node", () => {
  it("follows src= files and @/ and relative imports, transitively, and leaves browser code out", async () => {
    const page = write(
      "src/pages/index.html",
      PAGE(`<script data-bascik-build src="./index.build.ts"></script>
    <script data-bascik-build>
      import { list } from "@/lib/list";
      export default () => list();
    </script>
    <milk-card></milk-card>`),
    );
    write(
      "src/pages/index.build.ts",
      'import { card } from "../lib/card.js";\nexport default () => card("Milk frother");\n',
    );
    write(
      "src/lib/card.ts",
      'import { escapeHtml } from "./escape.ts";\nimport { marked } from "marked";\nexport const card = (n: string) => `<p>${escapeHtml(n)}</p>`;\n',
    );
    write("src/lib/escape.ts", ESCAPE_HTML);
    write(
      "src/lib/list.ts",
      'import { card } from "./card";\nimport "./list.test.ts";\nexport const list = () => card("x");\n',
    );
    write("src/lib/list.test.ts", "export {};\n");
    // A cycle back to list.ts ends.
    write(
      "src/components/milk-card/milk-card.html",
      `<article><script src="milk-card.ts"></script><script data-bascik-build-once src="@/lib/cycle-a.ts"></script></article>\n`,
    );
    write(
      "src/components/milk-card/milk-card.ts",
      'import { tip } from "./tip.ts";\ndocument.body.innerHTML = `<b>${tip}</b>`;\n',
    );
    write("src/components/milk-card/tip.ts", "export const tip = 'x';\n");
    write("src/lib/cycle-a.ts", 'import "./cycle-b.ts";\nexport {};\n');
    write("src/lib/cycle-b.ts", 'import "./cycle-a.ts";\nexport {};\n');
    write("node_modules/pkg/index.ts", "export {};\n");

    const modules = findScriptModules({
      projectRoot: root,
      importRoot: path.join(root, "src"),
      html: [[page, fs.readFileSync(page, "utf8")]],
    });
    expect([...modules].map((m) => rel(m)).sort()).toEqual([
      "src/lib/card.ts",
      "src/lib/escape.ts",
      "src/lib/list.ts",
      "src/pages/index.build.ts",
    ]);

    const snapshot = await buildSnapshot(root);
    const all = [...scriptModulesOf(snapshot)].map((m) => rel(m)).sort();
    expect(all).toContain("src/lib/cycle-a.ts");
    expect(all).toContain("src/lib/cycle-b.ts");
    expect(all).not.toContain("src/components/milk-card/milk-card.ts");
    expect(all).not.toContain("src/components/milk-card/tip.ts");
    expect(all).not.toContain("src/lib/list.test.ts");
  });

  it("a missing file, a URL, a root-absolute src and a bare package name are skipped without throwing", () => {
    const page = write(
      "src/pages/a.html",
      PAGE(`<script data-bascik-server src="./missing.ts"></script>
    <script data-bascik-build src="https://cdn.example.com/x.js"></script>
    <script data-bascik-build src="/abs.ts"></script>
    <script data-bascik-build>import x from "marked"; import y from "./nope"; export default () => "";</script>`),
    );
    expect(
      findScriptModules({
        projectRoot: root,
        importRoot: path.join(root, "src"),
        html: [[page, fs.readFileSync(page, "utf8")]],
      }).size,
    ).toBe(0);
  });

  it("API routes and what they import are Node modules", async () => {
    write(
      "src/api/hello.ts",
      'import { greet } from "@/lib/greet.ts";\nexport const GET = () => new Response(greet());\n',
    );
    write("src/lib/greet.ts", "export const greet = () => 'hi';\n");
    const modules = [...scriptModulesOf(await buildSnapshot(root))].map((m) =>
      rel(m),
    );
    expect(modules.sort()).toEqual(["src/api/hello.ts", "src/lib/greet.ts"]);
  });
});

/** A scratch site: a build script returning plain markup, an escaper, an XML escaper, a clean helper. */
const writeScratchSite = () => {
  write(
    "src/pages/index.html",
    PAGE(`<script data-bascik-build>
      import { renderPosts } from "@/lib/posts.ts";
      import { feedItem } from "@/lib/feed.ts";
      import { productCard } from "@/lib/product-card.ts";
      export default async function () {
        const posts = [{ title: "Milk frother", url: "/frother" }];
        return \`<ul>\${posts.map((p) => \`<li>\${p.title}</li>\`)}</ul>\`;
      }
    </script>`),
  );
  write(
    "src/lib/posts.ts",
    `import { escapeHtml } from "./escape.ts";

export function renderPosts(posts: { title: string }[]): string {
  return posts
    .map(
      (post) => \`
        <article>
          <h2>\${post.title}</h2>
        </article>
      \`,
    )
    .join("");
}
`,
  );
  write("src/lib/escape.ts", ESCAPE_HTML);
  write(
    "src/lib/feed.ts",
    `// RSS is XML, which html does not build, so the feed keeps its own escaper.
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

export const feedItem = (title: string): string =>
  \`<item><title>\${escapeXml(title)}</title></item>\`;
`,
  );
  write(
    "src/lib/product-card.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";

export const productCard = (name: string): SafeHtml =>
  html\`<article class="product">\${name}</article>\`;
`,
  );
};

describe("bascik --check (checkFiles) on Node modules", () => {
  it("reports exactly the right diagnostics with file and line, checking helpers the pages import", async () => {
    writeScratchSite();
    // As bascik --check asks: pages are markup only.
    const result = await checkFiles({
      cwd: root,
      targets: [{ path: "src/pages", extensions: ["html"] }],
      projectPath: root,
      hints: false,
    });
    const got = result.diagnostics
      .map((d) => `${d.filePath.replace(/\\/g, "/")}:${d.line} ${d.code}`)
      .sort();
    expect(got).toEqual(
      [
        "src/lib/escape.ts:1 hand-written-html-escaper",
        // The feed's XML escaper says so in a comment: it is not reported, and
        // its calls are trusted in the feed's templates.
        "src/lib/posts.ts:8 server-script-unescaped-markup",
        "src/pages/index.html:10 server-script-unescaped-markup",
        "src/pages/index.html:10 server-script-unescaped-markup",
      ].sort(),
    );
    expect(result.filesChecked).toBe(5);
    const escaper = result.diagnostics.find((d) => d.code === ESCAPER);
    expect(escaper?.severity).toBe("warning");
    expect(escaper?.column).toBe(17);
  });

  it("a browser companion keeps its scoping rules and gets no markup rules; a src= build file in the component folder gets the reverse", async () => {
    write(
      "src/components/milk-card/milk-card.html",
      `<article>\n  <script src="milk-card.ts"></script>\n  <script data-bascik-build src="./milk-card.build.ts"></script>\n</article>\n`,
    );
    const browser =
      "const id = location.hash;\ndocument.getElementById(`card-${id}`);\ndocument.body.insertAdjacentHTML('beforeend', `<b>${id}</b>`);\n";
    write("src/components/milk-card/milk-card.ts", browser);
    write("src/components/milk-card/milk-card.build.ts", browser);
    const result = await checkFiles({
      cwd: root,
      targets: ["src/components"],
      projectPath: root,
    });
    const codesFor = (name: string) =>
      result.diagnostics
        .filter((d) => d.filePath.endsWith(name))
        .map((d) => d.code);
    expect(codesFor("milk-card.ts")).not.toEqual([]);
    expect(codesFor("milk-card.ts")).not.toContain(MARKUP);
    expect(codesFor("milk-card.build.ts")).toEqual([MARKUP]);
  });

  it("an API route that returns markup is reported", async () => {
    write(
      "src/api/search.ts",
      "export function GET(request: Request) {\n  const q = new URL(request.url).searchParams.get('q');\n  return new Response(`<p>${q}</p>`, { headers: { 'content-type': 'text/html' } });\n}\n",
    );
    const result = await checkFiles({ cwd: root, targets: ["src/api"] });
    expect(
      result.diagnostics.filter((d) => d.code === MARKUP).map((d) => d.line),
    ).toEqual([3]);
  });

  it("a helper only a test imports, and a test file itself, are not checked", async () => {
    write(
      "src/pages/index.html",
      PAGE(
        '<script data-bascik-build>import { a } from "@/lib/a.test.ts"; export default () => a;</script>',
      ),
    );
    write("src/lib/a.test.ts", ESCAPE_HTML);
    const result = await checkFiles({
      cwd: root,
      targets: [{ path: "src/pages", extensions: ["html"] }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.filesChecked).toBe(1);
  });

  it("disabledRules, ignore comments and serverScriptRules: false apply to modules", async () => {
    writeScratchSite();
    write(
      "src/lib/escape.ts",
      `// bascik-ignore hand-written-html-escaper\n${ESCAPE_HTML}`,
    );
    write(
      "bascik.ext.json",
      JSON.stringify({
        diagnostics: { disabledRules: ["server-script-unescaped-markup"] },
      }),
    );
    const target = [{ path: "src/pages", extensions: ["html"] }];
    let result = await checkFiles({ cwd: root, targets: target });
    expect(result.diagnostics).toEqual([]);

    write("src/lib/escape.ts", ESCAPE_HTML);
    write(
      "bascik.ext.json",
      JSON.stringify({ diagnostics: { serverScriptRules: false } }),
    );
    result = await checkFiles({ cwd: root, targets: target });
    expect(result.diagnostics).toEqual([]);
  });

  it("a project escaper listed in escapeFunctions is trusted in holes, but its definition is still reported", async () => {
    writeScratchSite();
    write(
      "src/lib/feed.ts",
      `import { escapeHtml } from "./escape.ts";\nexport const feedItem = (title: string): string =>\n  \`<item><title>\${escapeHtml(title)}</title></item>\`;\n`,
    );
    write(
      "bascik.ext.json",
      JSON.stringify({ diagnostics: { escapeFunctions: ["escapeHtml"] } }),
    );
    const result = await checkFiles({
      cwd: root,
      targets: [{ path: "src/pages", extensions: ["html"] }],
    });
    expect(
      result.diagnostics.filter((d) => d.filePath.endsWith("feed.ts")),
    ).toEqual([]);
    expect(
      result.diagnostics
        .filter((d) => d.code === ESCAPER)
        .map((d) => d.filePath),
    ).toEqual([path.join("src", "lib", "escape.ts")]);
  });
});

describe("the editor: open documents", () => {
  const docFor = (file: string, text = fs.readFileSync(file, "utf8")) =>
    TextDocument.create(pathToFileURL(file).toString(), "typescript", 1, text);

  it("an unsaved page that starts importing a helper makes it a Node module", async () => {
    const helper = write(
      "src/lib/card.ts",
      "export const card = (n: string) => `<p>${n}</p>`;\n",
    );
    const page = write("src/pages/index.html", PAGE("<p>hi</p>"));
    const snapshot = await buildSnapshot(root);
    const doc = docFor(helper);
    const codes = (open: { fsPath: string; text: string }[]) =>
      createDiagnostics(doc, helper, snapshot, open).map((d) => d.code);
    expect(codes([{ fsPath: helper, text: doc.getText() }])).toEqual([]);
    const unsaved = PAGE(
      '<script data-bascik-build>import { card } from "@/lib/card.ts"; export default () => card("x");</script>',
    );
    expect(
      codes([
        { fsPath: helper, text: doc.getText() },
        { fsPath: page, text: unsaved },
      ]),
    ).toEqual([MARKUP]);
  });

  it("a helper's unsaved import is followed from its buffer", async () => {
    write(
      "src/pages/index.html",
      PAGE(
        '<script data-bascik-build>import { a } from "@/lib/a.ts"; export default () => a;</script>',
      ),
    );
    const a = write("src/lib/a.ts", "export const a = 1;\n");
    const b = write("src/lib/b.ts", ESCAPE_HTML);
    const snapshot = await buildSnapshot(root);
    const open = [
      { fsPath: a, text: 'import "./b.ts";\nexport const a = 1;\n' },
      { fsPath: b, text: ESCAPE_HTML },
    ];
    expect(scriptModulesOf(snapshot, open).has(normalizeModulePath(b))).toBe(
      true,
    );
    expect(
      createDiagnostics(docFor(b), b, snapshot, open).map((d) => d.code),
    ).toEqual([ESCAPER]);
  });
});

describe("quick fixes in a .ts module", () => {
  const applyEdits = (doc: TextDocument, edits: TextEdit[]): string =>
    TextDocument.applyEdits(doc, edits);

  const setup = async (helper: string) => {
    write(
      "src/pages/index.html",
      PAGE(
        '<script data-bascik-build>import * as h from "@/lib/h.ts"; export default () => "";</script>',
      ),
    );
    const file = write("src/lib/h.ts", helper);
    const snapshot = await buildSnapshot(root);
    const doc = TextDocument.create(
      pathToFileURL(file).toString(),
      "typescript",
      1,
      helper,
    );
    const diags = createDiagnostics(doc, file, snapshot);
    const actionsFor = (code: string) => {
      const diag = diags.find((d) => d.code === code)!;
      expect(diag, code).toBeDefined();
      return createCodeActions(doc, diag.range, diags, snapshot);
    };
    return { doc, diags, actionsFor };
  };

  it("Make escapeHtml() call esc(): the body becomes one call and esc is imported", async () => {
    const { doc, actionsFor } = await setup(
      `import { readFile } from "node:fs/promises";\n\n${ESCAPE_HTML}`,
    );
    const [action] = actionsFor(ESCAPER);
    expect(action.title).toBe(
      "Make escapeHtml() call esc() from @bascik/bascik/html",
    );
    expect(action.isPreferred).toBe(true);
    expect(applyEdits(doc, action.edit!.changes![doc.uri])).toBe(
      `import { readFile } from "node:fs/promises";
import { esc } from "@bascik/bascik/html";

export function escapeHtml(value: string): string {
  return esc(value);
}
`,
    );
  });

  it('an unnamed default export gets "Make the default export call esc()"', async () => {
    const { doc, actionsFor } = await setup(
      'export default (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");\n',
    );
    const [action] = actionsFor(ESCAPER);
    expect(action.title).toBe(
      "Make the default export call esc() from @bascik/bascik/html",
    );
    expect(applyEdits(doc, action.edit!.changes![doc.uri])).toBe(
      'import { esc } from "@bascik/bascik/html";\nexport default (s: string) => esc(s);\n',
    );
  });

  it("an escaper that also turns newlines into <br> gets no esc() fix, only the html import", async () => {
    const { actionsFor } = await setup(
      'export function escapeHtml(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\\n/g, "<br>"); }\n',
    );
    const titles = actionsFor(ESCAPER).map((a) => a.title);
    expect(titles).toEqual([
      "Import html from @bascik/bascik/html to build markup safely",
    ]);
  });

  it("an escaper named esc imports esc as escapeValue; an arrow keeps its expression form", async () => {
    const { doc, actionsFor } = await setup(
      'export const esc = (s: string): string =>\n  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");\n',
    );
    const [action] = actionsFor(ESCAPER);
    expect(applyEdits(doc, action.edit!.changes![doc.uri])).toBe(
      'import { esc as escapeValue } from "@bascik/bascik/html";\nexport const esc = (s: string): string =>\n  escapeValue(s);\n',
    );
  });

  it("an existing import from the module gets esc merged in", async () => {
    const { doc, actionsFor } = await setup(
      `import { html } from "@bascik/bascik/html";\n${ESCAPE_HTML}`,
    );
    const [action] = actionsFor(ESCAPER);
    expect(applyEdits(doc, action.edit!.changes![doc.uri])).toContain(
      'import { html, esc } from "@bascik/bascik/html";',
    );
  });

  it("a lookup map gets only the import of html, not preferred; none once html is imported", async () => {
    const map =
      'const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;" };\nexport const e = (s: string) => s.replace(/[&<]/g, (c) => ENTITIES[c]);\n';
    let { doc, actionsFor } = await setup(map);
    const actions = actionsFor(ESCAPER);
    expect(actions.map((a) => [a.title, a.isPreferred])).toEqual([
      ["Import html from @bascik/bascik/html to build markup safely", false],
    ]);
    expect(applyEdits(doc, actions[0].edit!.changes![doc.uri])).toBe(
      `import { html } from "@bascik/bascik/html";\n${map}`,
    );
    ({ doc, actionsFor } = await setup(
      `import { html } from "@bascik/bascik/html";\n${map}`,
    ));
    expect(actionsFor(ESCAPER)).toEqual([]);
  });

  it("Wrap template in html`...` in a .ts helper adds the import at the top", async () => {
    const { doc, actionsFor } = await setup(
      "export const card = (name: string) =>\n  `<li>${name}</li>`;\n",
    );
    const action = actionsFor(MARKUP).find(
      (a) => a.title === "Wrap template in html`...`",
    )!;
    expect(applyEdits(doc, action.edit!.changes![doc.uri])).toBe(
      'import { html } from "@bascik/bascik/html";\nexport const card = (name: string) =>\n  html`<li>${name}</li>`;\n',
    );
  });
});

describe("review 2026-10-31: which modules run per request, outside roots, shared browser code", () => {
  const SINKS = [
    "server-script-sink-event-handler",
    "server-script-sink-style",
    "server-script-sink-url-attribute",
  ];
  const SEARCH_ROUTE = `import { esc } from "@bascik/bascik/html";
export function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return new Response(
    \`<button onclick="\${q}">Froth</button><a href="\${esc(q)}">Milk frother</a><div style="\${q}"></div>\`,
  );
}
`;
  const codesIn = (
    diagnostics: { filePath: string; code?: string }[],
    name: string,
  ) =>
    diagnostics
      .filter((d) => d.filePath.replace(/\\/g, "/").endsWith(name))
      .map((d) => d.code ?? "")
      .sort();

  it("an API route is request-time code: event handler, URL and style sinks warn", async () => {
    write("src/api/search.ts", SEARCH_ROUTE);
    const result = await checkFiles({ cwd: root, targets: ["src/api"] });
    expect(codesIn(result.diagnostics, "search.ts")).toEqual(
      expect.arrayContaining(SINKS),
    );
  });

  it("a helper of a server script, a stream script or an API route is request-time; one only build scripts import is not", async () => {
    const helper = (name: string) =>
      write(
        `src/lib/${name}.ts`,
        `export const button = (q: string) => \`<button onclick="\${q}" style="\${q}">Froth</button>\`;\n`,
      );
    helper("server-helper");
    helper("stream-helper");
    helper("api-helper");
    helper("build-helper");
    helper("both-helper");
    write(
      "src/pages/index.html",
      PAGE(`<script data-bascik-server>
      import { button } from "@/lib/server-helper.ts";
      import { button as b2 } from "@/lib/both-helper.ts";
      export default () => button("x") + b2("y");
    </script>
    <script data-bascik-stream>
      import { button } from "@/lib/stream-helper.ts";
      export default async function* () { yield button("x"); }
    </script>
    <script data-bascik-build>
      import { button } from "@/lib/build-helper.ts";
      import { button as b2 } from "@/lib/both-helper.ts";
      export default () => button("x") + b2("y");
    </script>`),
    );
    write(
      "src/api/x.ts",
      'import { button } from "@/lib/api-helper.ts";\nexport const GET = () => new Response(button("x"));\n',
    );
    const modules = findScriptModules({
      projectRoot: root,
      importRoot: path.join(root, "src"),
      html: [
        [
          path.join(root, "src/pages/index.html"),
          fs.readFileSync(path.join(root, "src/pages/index.html"), "utf8"),
        ],
      ],
      apiRoutes: [path.join(root, "src/api/x.ts")],
    });
    const requestTime = [...modules.requestTime].map(rel).sort();
    expect(requestTime).toEqual([
      "src/api/x.ts",
      "src/lib/api-helper.ts",
      "src/lib/both-helper.ts",
      "src/lib/server-helper.ts",
      "src/lib/stream-helper.ts",
    ]);
    expect(
      modules.has(
        normalizeModulePath(path.join(root, "src/lib/build-helper.ts")),
      ),
    ).toBe(true);

    const result = await checkFiles({
      cwd: root,
      targets: [{ path: "src/pages", extensions: ["html"] }, "src/api"],
      projectPath: root,
    });
    for (const name of [
      "server-helper.ts",
      "stream-helper.ts",
      "api-helper.ts",
      "both-helper.ts",
    ])
      expect(codesIn(result.diagnostics, name), name).toEqual([
        "server-script-sink-event-handler",
        "server-script-sink-style",
      ]);
    // Build time: the site's own values in a handler or style are not sinks.
    expect(codesIn(result.diagnostics, "build-helper.ts")).toEqual([]);
  });

  it("a helper under a component root outside the project is checked (directory.components: ../shared/components)", async () => {
    const site = path.join(root, "site");
    write(
      "site/bascik.config.ts",
      'export default { directory: { components: ["src/components", "../shared/components"] } };\n',
    );
    write("site/src/pages/index.html", PAGE("<site-header></site-header>"));
    write(
      "shared/components/site-header/site-header.html",
      `<header>\n  <script data-bascik-build>\n    import { links } from "./links.ts";\n    export default () => links();\n  </script>\n</header>\n`,
    );
    write(
      "shared/components/site-header/links.ts",
      `const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ENTITIES[c]);
export const links = () => ["Milk frother"].map((n) => \`<a href="/">\${n}</a>\`).join("");
`,
    );
    const result = await checkFiles({
      cwd: site,
      targets: [
        { path: "src/pages", extensions: ["html"] },
        "src/components",
        "../shared/components",
      ].filter(
        (t) => typeof t !== "string" || fs.existsSync(path.join(site, t)),
      ),
      projectPath: site,
    });
    expect(codesIn(result.diagnostics, "site-header/links.ts")).toEqual([
      ESCAPER,
      MARKUP,
    ]);
  });

  it("a module both a browser companion and a build script import keeps its browser scoping diagnostics, and gets the markup rules", async () => {
    write(
      "src/components/milk-card/milk-card.html",
      `<article>\n  <script src="milk-card.ts"></script>\n  <script data-bascik-build src="./milk-card.build.ts"></script>\n</article>\n`,
    );
    write(
      "src/components/milk-card/milk-card.ts",
      'import { label } from "./shared.ts";\nlabel();\n',
    );
    write(
      "src/components/milk-card/milk-card.build.ts",
      'import { label } from "./shared.ts";\nexport default () => label();\n',
    );
    write(
      "src/components/milk-card/shared.ts",
      "export const label = () => {\n  const id = location.hash;\n  document.getElementById(`card-${id}`);\n  return `<b>${id}</b>`;\n};\n",
    );
    const result = await checkFiles({
      cwd: root,
      targets: ["src/components"],
      projectPath: root,
    });
    const shared = codesIn(result.diagnostics, "milk-card/shared.ts");
    expect(shared).toContain(MARKUP);
    expect(shared.some((c) => c.startsWith("js-"))).toBe(true);
  });
});

describe("review 2026-10-31: the editor reuses the module set while imports stay the same", () => {
  it("returns the cached set for the same buffers, for an edit that changes no import, and recomputes when an import changes", async () => {
    const page = write(
      "src/pages/index.html",
      PAGE(
        '<script data-bascik-build>import { a } from "@/lib/a.ts"; export default () => a;</script>',
      ),
    );
    const a = write("src/lib/a.ts", "export const a = 1;\n");
    write("src/lib/b.ts", ESCAPE_HTML);
    const snapshot = await buildSnapshot(root);
    const pageText = fs.readFileSync(page, "utf8");
    const first = scriptModulesOf(snapshot, [
      { fsPath: page, text: pageText },
      { fsPath: a, text: "export const a = 1;\n" },
    ]);
    // Typing in a.ts or in the page's markup: no import changed.
    const second = scriptModulesOf(snapshot, [
      {
        fsPath: page,
        text: pageText.replace("<body>", "<body>\n<p>Froth</p>"),
      },
      { fsPath: a, text: "export const a = 2; // typing\n" },
    ]);
    expect(second).toBe(first);
    const third = scriptModulesOf(snapshot, [
      { fsPath: page, text: pageText },
      { fsPath: a, text: 'import "./b.ts";\nexport const a = 1;\n' },
    ]);
    expect(third).not.toBe(first);
    expect(
      third.has(normalizeModulePath(path.join(root, "src/lib/b.ts"))),
    ).toBe(true);
    // A page's unsaved import of a helper changes the set too.
    const fourth = scriptModulesOf(snapshot, [
      {
        fsPath: page,
        text: PAGE(
          '<script data-bascik-build>import { b } from "@/lib/b.ts"; export default () => b;</script>',
        ),
      },
    ]);
    expect([...fourth].map(rel).sort()).toEqual(["src/lib/b.ts"]);
  });
});
