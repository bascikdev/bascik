import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compilerOptionsFor,
  SERVER_WEB_LIBS,
  TypeScriptProject,
  type PageCheckOptions,
  TypeScriptProjects,
  type TypeScriptDiagnostic,
} from "./typescript-service.js";
import {
  BASCIK_TYPES_PATHS,
  createFixture,
  type Fixture,
  NODE_TYPES_DIR,
  offsetOf,
  typescript6 as ts,
} from "./typescript.test.util.js";
import { tsPath } from "./typescript-loader.js";

const fixtures: Fixture[] = [];
/** Shared across the tests, as the language server shares it across projects, so lib files parse once. */
const registry = ts.createDocumentRegistry();
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function fixture(files: Record<string, string> = {}): Fixture {
  const created = createFixture(files);
  fixtures.push(created);
  return created;
}

/** A fixture with Node's types and `@bascik/bascik`'s types, as an installed project has them. */
function nodeProject(files: Record<string, string> = {}): Fixture {
  const created = fixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: BASCIK_TYPES_PATHS },
    }),
    ...files,
  });
  created.link("node_modules/@types/node", NODE_TYPES_DIR);
  return created;
}

function project(
  root: Fixture,
  options: Partial<ConstructorParameters<typeof TypeScriptProject>[0]> = {},
): TypeScriptProject {
  return new TypeScriptProject({
    ts,
    projectRoot: root.root,
    importRoot: root.file("src"),
    registry,
    ...options,
  });
}

/** Diagnostics of a page written to the fixture, with the text each range covers. */
function check(
  root: Fixture,
  relative: string,
  html: string,
  service = project(root),
  options: PageCheckOptions = {},
): (TypeScriptDiagnostic & { text: string })[] {
  const file = root.write(relative, html);
  return service.diagnostics(file, html, options).map((diagnostic) => ({
    ...diagnostic,
    text: html.slice(diagnostic.start, diagnostic.end),
  }));
}

const page = (body: string, attributes = "") =>
  `<!doctype html>\n<main>Milk frother</main>\n<script type="text/typescript"${attributes}>\n${body}\n</script>\n`;

describe("TypeScriptProject diagnostics", () => {
  it("reports a type error at its exact range in the HTML", () => {
    const root = fixture();
    const html = page('const speed: number = "fast";');
    const diagnostics = check(root, "src/pages/index.html", html);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 2322,
        category: "error",
        start: offsetOf(html, "speed"),
        end: offsetOf(html, "speed") + "speed".length,
        text: "speed",
      }),
    ]);
  });

  it("checks each block of a scoped component as its own module", () => {
    const root = fixture();
    const html =
      page("const frother = 1;\nexport const shared = 2;") +
      page("const frother = 'two';\nconsole.log(shared);");
    const diagnostics = check(
      root,
      "src/components/frother-card.html",
      html,
      project(root),
      { isolatedClientBlocks: true },
    );
    // No redeclaration error for `frother`; `shared` from the first block is not visible in the second.
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([
      [2304, "shared"],
    ]);
    expect(diagnostics[0].start).toBe(html.lastIndexOf("shared"));
  });

  it("checks a page's client blocks in one scope, as the browser runs them", () => {
    const root = fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { noUnusedLocals: true },
      }),
    });
    const html =
      page(
        "function frotherLabel(speed: number): string {\n  return `Milk frother ${speed}`;\n}",
      ) +
      page("document.title = frotherLabel(3);") +
      page(
        "const frotherLabel = () => 'built';\nexport default frotherLabel;",
        " data-bascik-build",
      );
    // The second block calls the first block's function, so it is neither unknown nor unused; the build block,
    // a module of its own, may use the same name.
    expect(check(root, "src/pages/index.html", html)).toEqual([]);
  });

  it("misuse: a const declared again in a later page block is reported there", () => {
    const root = fixture();
    const html =
      page("const speed = 1;\nconsole.log(speed);") +
      page("const speed = 2;\nconsole.log(speed);");
    const diagnostics = check(root, "src/pages/index.html", html);
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([
      [2451, "speed"],
      [2451, "speed"],
    ]);
    expect(diagnostics.map((d) => d.start)).toEqual([
      html.indexOf("speed"),
      html.indexOf("speed", html.indexOf("</script>")),
    ]);
  });

  it("misuse: top-level await in a client block is reported, in a page and in a component", () => {
    const root = fixture();
    const html = page(
      "const response = await fetch('/frother');\nfor await (const chunk of [response]) console.log(chunk);\nasync function later() { await fetch('/ok'); }\nconsole.log(later);",
    );
    for (const isolatedClientBlocks of [false, true]) {
      const diagnostics = check(
        root,
        isolatedClientBlocks
          ? "src/components/frother-card.html"
          : "src/pages/index.html",
        html,
        project(root),
        { isolatedClientBlocks },
      );
      expect(diagnostics.map((d) => [d.code, d.text])).toEqual([
        [1308, "await"],
        [1103, "await"],
      ]);
      expect(diagnostics[0].message).toContain("classic script");
    }
    // A server-side block runs as a module, where top-level await is allowed.
    expect(
      check(
        root,
        "src/pages/build.html",
        page(
          "const name = await Promise.resolve('Milk frother');\nexport default () => name;",
          " data-bascik-build",
        ),
      ),
    ).toEqual([]);
  });

  it("maps errors in every block of a page's shared scope back to their own block", () => {
    const root = fixture();
    const html =
      page('const a: number = "one";') +
      "<p>Milk frother</p>\n" +
      page("const b: string = 2;\nconsole.log(a, b);");
    const diagnostics = check(root, "src/pages/index.html", html);
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([
      [2322, "a"],
      [2322, "b"],
    ]);
  });

  it("misuse: a syntax error is reported, not thrown", () => {
    const root = fixture();
    const html = page("const = ;\nlet ok: number = 1;");
    const diagnostics = check(root, "src/pages/index.html", html);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].code).toBe(1134);
    expect(diagnostics[0].start).toBeGreaterThan(html.indexOf("<script"));
  });

  it("misuse: an unclosed brace is reported at the end of its block, and a directive block keeps its types", () => {
    const root = nodeProject();
    const service = project(root);
    const html = page(
      "export default async function (request) {\n  return request.url;",
      " data-bascik-server",
    );
    const diagnostics = check(root, "src/pages/server.html", html, service);
    // A syntax error (TypeScript numbers them below 2000), wherever the unclosed brace makes TypeScript stop.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBeLessThan(2000);
    // Located at the end of the block, never in Bascik's footer past it.
    expect(diagnostics[0].start).toBeGreaterThan(html.indexOf("request.url"));
    expect(diagnostics[0].end).toBeLessThanOrEqual(html.indexOf("</script>"));
    // Once the brace is closed, the parameters still have their types: `frother` is not on Request.
    const fixed = page(
      "export default async function (request) {\n  return request.frother;\n}",
      " data-bascik-server",
    );
    expect(
      check(root, "src/pages/server.html", fixed, service).map((d) => [
        d.code,
        d.text,
      ]),
    ).toEqual([[2339, "frother"]]);
  });

  it("misuse: an unclosed block, a commented-out block and a typo'd type get nothing", () => {
    const root = fixture();
    expect(
      check(
        root,
        "src/pages/a.html",
        '<script type="text/typescript">const a: number = "x";',
      ),
    ).toEqual([]);
    expect(
      check(
        root,
        "src/pages/b.html",
        '<!-- <script type="text/typescript">const a: number = "x";</script> -->',
      ),
    ).toEqual([]);
    expect(
      check(
        root,
        "src/pages/c.html",
        '<script type="text/typscript">const a: number = "x";</script>',
      ),
    ).toEqual([]);
    expect(
      check(
        root,
        "src/pages/d.html",
        '<script>const a: number = "x";</script>',
      ),
    ).toEqual([]);
  });

  it("gives client blocks the DOM and no Node, and server blocks Node and no DOM", () => {
    const root = nodeProject();
    const client = check(
      root,
      "src/pages/client.html",
      page('document.title = "Milk frother";\nconst port = process.env.PORT;'),
    );
    expect(client.map((d) => d.text)).toEqual(["process"]);
    const server = check(
      root,
      "src/pages/server.html",
      page(
        'import { readFileSync } from "node:fs";\nconst port = process.env.PORT;\ndocument.title = "x";\nexport default () => String(readFileSync);',
        " data-bascik-build",
      ),
    );
    expect(server.map((d) => d.text)).toEqual(["document"]);
  });

  it("without @types/node, a server block gets the web globals Node and workerd share, and Node's untyped", () => {
    const root = fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: BASCIK_TYPES_PATHS },
      }),
    });
    const html = page(
      [
        'import { readFile } from "node:fs/promises";',
        'import path from "path";',
        "const port = process.env.PORT;",
        "const here = new URL(import.meta.url);",
        "export default async function (request, context, { signal }) {",
        "  const url = new URL(request.url);",
        "  const body = await fetch(url, { signal }).then((r) => r.text());",
        "  const headers = new Headers({ 'x-frother': String(port) });",
        "  for (const [name] of headers) console.log(name, context.remoteIp);",
        "  return new Response(body + path.join(String(here), String(readFile)), { headers });",
        "}",
      ].join("\n"),
      " data-bascik-server",
    );
    expect(check(root, "src/pages/server.html", html)).toEqual([]);
    expect(
      compilerOptionsFor(ts, root.root, root.file("src"), "server", false).lib,
    ).toEqual(["lib.es2022.d.ts", ...SERVER_WEB_LIBS]);
    // Still checked: a type error, a DOM-only global, and a module that is not one of Node's.
    const wrong = page(
      'import { frother } from "node-frother";\nconst n: number = "x";\ndocument.title = String(frother);\nexport default () => String(n);',
      " data-bascik-build",
    );
    expect(
      check(root, "src/pages/build.html", wrong).map((d) => [d.code, d.text]),
    ).toEqual([
      [2307, '"node-frother"'],
      [2322, "n"],
      [2584, "document"],
    ]);
  });

  it("types a server script's default export from @bascik/bascik", () => {
    const root = nodeProject();
    const html = page(
      "export default async function (request, context, { signal }) {\n  signal.throwIfAborted();\n  return `${request.method} ${context.remoteIp} ${request.frother}`;\n}",
      " data-bascik-server",
    );
    const diagnostics = check(root, "src/pages/server.html", html);
    // No implicit any for the parameters; `frother` is not on Request.
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([
      [2339, "frother"],
    ]);
  });

  it("checks a build script's result and a routes script's entries", () => {
    const root = nodeProject();
    const build = check(
      root,
      "src/pages/build.html",
      page("export default () => 42;", " data-bascik-build-once"),
    );
    expect(build.map((d) => d.code)).toEqual([2322]);
    expect(build[0].text).toBe("42");
    const routes = check(
      root,
      "src/pages/[slug].html",
      page(
        'export default async () => [{ params: { slug: "frother" } }, { slug: "no-params" }];',
        " data-bascik-routes",
      ),
    );
    expect(routes.map((d) => d.code)).toEqual([2353]);
  });

  it("keeps a named default export function in the module's scope when the block uses its name", () => {
    const root = nodeProject();
    const service = project(root);
    const referenced = page(
      "export default function build(): string { return helper(); }\nfunction helper() { return build.name; }",
      " data-bascik-build",
    );
    expect(check(root, "src/pages/a.html", referenced, service)).toEqual([]);
    const hoisted = page(
      'const early = build();\nexport { build };\nexport default function build() { return "Milk frother"; }\nconsole.log(early);',
      " data-bascik-build",
    );
    expect(check(root, "src/pages/b.html", hoisted, service)).toEqual([]);
  });

  it("misuse: a named default export of the wrong type is located on its name, wrapped or not", () => {
    const root = nodeProject();
    const service = project(root);
    const referenced = page(
      "export default function build() { return 42; }\nconsole.log(build.name);",
      " data-bascik-build-once",
    );
    const diagnostics = check(root, "src/pages/a.html", referenced, service);
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([[2345, "build"]]);
    expect(diagnostics[0].start).toBe(referenced.indexOf("build()"));
    // Not used elsewhere, it is still wrapped, so an untyped parameter gets its type.
    const alone = page(
      "export default async function handle(request) {\n  return request.frother;\n}",
      " data-bascik-server",
    );
    expect(
      check(root, "src/pages/b.html", alone, service).map((d) => [
        d.code,
        d.text,
      ]),
    ).toEqual([[2339, "frother"]]);
  });

  it("misuse: without @bascik/bascik's types, a directive script reports nothing it cannot know", () => {
    const root = fixture();
    const html = page(
      "export default function (request) {\n  return request.url;\n}",
      " data-bascik-server",
    );
    expect(check(root, "src/pages/server.html", html)).toEqual([]);
  });

  it("resolves @/ through scripts.importRoot and relative imports from the page's folder", () => {
    const root = fixture({
      "app/lib/frother.ts":
        "export const frotherName: string = 'Milk frother';\n",
      "app/pages/helper.ts": "export const count = 3;\n",
    });
    const service = project(root, { importRoot: root.file("app") });
    const html = page(
      'import { frotherName } from "@/lib/frother.ts";\nimport { count } from "./helper.ts";\nconst n: number = frotherName;\nconst c: number = count;',
    );
    const diagnostics = check(root, "app/pages/index.html", html, service);
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([[2322, "n"]]);
  });

  it("misuse: a typo'd @/ path is located on the specifier", () => {
    const root = fixture({ "src/lib/frother.ts": "export const speed = 1;\n" });
    const html = page(
      'import { speed } from "@/lib/frothr.ts";\nconsole.log(speed);',
    );
    const diagnostics = check(root, "src/pages/index.html", html);
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([
      [2307, '"@/lib/frothr.ts"'],
    ]);
  });

  it("layers Bascik's settings on the project's tsconfig", () => {
    const root = fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: false,
          paths: { "~frother/*": ["./shared/*"], "@/*": ["./elsewhere/*"] },
          module: "commonjs",
          noEmit: false,
          outDir: "dist",
        },
      }),
      "shared/speed.ts": "export const speed: number = 1;\n",
      "src/lib/name.ts": "export const name = 'Milk frother';\n",
    });
    const html = page(
      'import { speed } from "~frother/speed.ts";\nimport { name } from "@/lib/name.ts";\nfunction loose(value) { return value; }\nconst s: string = speed;\nconsole.log(name, loose);',
    );
    const diagnostics = check(root, "src/pages/index.html", html);
    // strict: false allows the untyped parameter; the project's alias resolves; Bascik's @/ wins.
    expect(diagnostics.map((d) => [d.code, d.text])).toEqual([[2322, "s"]]);
  });

  it("misuse: a Node-only tsconfig still gives client blocks the DOM and keeps Node out", () => {
    const root = nodeProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { lib: ["ESNext"], types: ["node"], target: "ES2017" },
      }),
    });
    const options = compilerOptionsFor(
      ts,
      root.root,
      root.file("src"),
      "client",
    );
    expect(options.lib).toEqual([
      "lib.esnext.d.ts",
      "lib.dom.d.ts",
      "lib.dom.iterable.d.ts",
    ]);
    expect(options.types).toEqual([]);
    expect(options.target).toBe(ts.ScriptTarget.ES2022);
    const server = compilerOptionsFor(
      ts,
      root.root,
      root.file("src"),
      "server",
    );
    expect(server.lib).toEqual(["lib.esnext.d.ts"]);
    expect(server.types).toEqual(["node"]);
    const client = check(
      root,
      "src/pages/index.html",
      page("document.title = String(process.pid);"),
    );
    expect(client.map((d) => d.text)).toEqual(["process"]);
  });

  it("misuse: a tsconfig that does not parse falls back to the defaults", () => {
    const root = fixture({ "tsconfig.json": "{ compilerOptions: " });
    const html = page('const n: number = "x";');
    expect(
      check(root, "src/pages/index.html", html).map((d) => d.code),
    ).toEqual([2322]);
  });

  it("misuse: a relative project root and import root resolve from the current directory", () => {
    const root = fixture({ "src/lib/a.ts": "export const a = 1;\n" });
    const relativeRoot = path.relative(process.cwd(), root.root);
    const service = new TypeScriptProject({
      ts,
      projectRoot: relativeRoot,
      importRoot: "src",
    });
    const html = page('import { a } from "@/lib/a.ts";\nconst s: string = a;');
    const file = root.write("src/pages/index.html", html);
    const diagnostics = service.diagnostics(
      path.relative(root.root, file),
      html,
    );
    expect(
      diagnostics.map((d) => [d.code, html.slice(d.start, d.end)]),
    ).toEqual([[2322, "s"]]);
  });

  it("follows unsaved edits to the page and to an imported file", () => {
    const root = fixture({
      "src/pages/speed.ts": "export const speed: string = 'fast';\n",
    });
    const buffers = new Map<string, string>();
    const service = project(root, {
      readOpenFile: (fsPath) => buffers.get(fsPath),
    });
    const broken = page(
      'import { speed } from "./speed.ts";\nconst n: number = speed;',
    );
    expect(
      check(root, "src/pages/index.html", broken, service).map((d) => d.code),
    ).toEqual([2322]);

    // The imported file's buffer changes, unsaved.
    buffers.set(
      tsPath(root.file("src/pages/speed.ts")),
      "export const speed: number = 3;\n",
    );
    service.fileChanged(root.file("src/pages/speed.ts"));
    expect(
      service.diagnostics(root.file("src/pages/index.html"), broken),
    ).toEqual([]);

    // The page changes, unsaved (the file on disk keeps the old text).
    const fixed = page(
      'import { speed } from "./speed.ts";\nconst n: string = speed;',
    );
    expect(
      service
        .diagnostics(root.file("src/pages/index.html"), fixed)
        .map((d) => d.code),
    ).toEqual([2322]);
  });

  it("misuse: an import written before its file clears once the file is created, and returns when it is deleted", () => {
    const root = fixture();
    const service = project(root);
    const html = page(
      'import { frotherSpeed } from "./lib/missing-file.ts";\nimport { label } from "@/lib/also-missing.ts";\nconsole.log(frotherSpeed, label);',
    );
    const file = root.write("src/pages/index.html", html);
    expect(service.diagnostics(file, html).map((d) => d.code)).toEqual([
      2307, 2307,
    ]);
    // Created on disk, in folders that did not exist; the page itself is unchanged.
    const created = root.write(
      "src/pages/lib/missing-file.ts",
      "export const frotherSpeed = 3;\n",
    );
    service.fileChanged(created);
    expect(service.diagnostics(file, html).map((d) => d.code)).toEqual([2307]);
    const alias = root.write(
      "src/lib/also-missing.ts",
      'export const label = "Milk frother";\n',
    );
    service.fileChanged(alias);
    expect(service.diagnostics(file, html)).toEqual([]);
    fs.rmSync(created);
    service.fileChanged(created);
    expect(service.diagnostics(file, html).map((d) => d.code)).toEqual([2307]);
  });

  it("misuse: an import of an unsaved new buffer resolves while the buffer is open", () => {
    const root = fixture();
    const projects = new TypeScriptProjects({
      resolve: () => ({
        ok: true,
        ts,
        version: ts.version,
        source: "project",
        packageDir: "",
        skipped: [],
      }),
    });
    const html = page(
      'import { frotherSpeed } from "./draft.ts";\nconsole.log(frotherSpeed);',
    );
    const request = {
      projectRoot: root.root,
      importRoot: root.file("src"),
      htmlPath: root.write("src/pages/index.html", html),
      text: html,
    };
    const codes = () => {
      const result = projects.diagnostics(request);
      return result.status === "ok"
        ? result.diagnostics.map((d) => d.code)
        : result;
    };
    expect(codes()).toEqual([2307]);
    projects.setOpenFile(
      root.file("src/pages/draft.ts"),
      "export const frotherSpeed = 3;\n",
    );
    expect(codes()).toEqual([]);
    projects.setOpenFile(root.file("src/pages/draft.ts"), undefined);
    expect(codes()).toEqual([2307]);
    projects.dispose();
  });

  it("moves diagnostics with an edit above the block without rechecking it as changed", () => {
    const root = fixture();
    const service = project(root);
    const html = page('const n: number = "x";');
    const first = check(root, "src/pages/index.html", html, service);
    const shifted = `<p>new paragraph</p>\n${html}`;
    const second = service.diagnostics(
      root.file("src/pages/index.html"),
      shifted,
    );
    expect(second[0].start).toBe(
      first[0].start + "<p>new paragraph</p>\n".length,
    );
  });

  it("drops the blocks of a removed page and of blocks deleted from a page", () => {
    const root = fixture();
    const service = project(root);
    const file = root.write(
      "src/pages/index.html",
      page("let a = 1;") + page("let b: number = 'x';"),
    );
    expect(
      service.diagnostics(
        file,
        page("let a = 1;") + page("let b: number = 'x';"),
      ),
    ).toHaveLength(1);
    expect(service.diagnostics(file, page("let a = 1;"))).toEqual([]);
    service.removePage(file);
    expect(
      service.diagnostics(file, page("let a: number = 'x';")),
    ).toHaveLength(1);
  });
});

describe("a page's client blocks run as one classic script", () => {
  const strict = () =>
    fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { noUnusedLocals: true },
      }),
    });

  it("augments a global interface such as Window, with or without a tsconfig, in a page and in a component", () => {
    const body =
      "interface Window { dataLayer: unknown[] }\nwindow.dataLayer = window.dataLayer || [];";
    for (const root of [fixture(), strict()]) {
      expect(check(root, "src/pages/index.html", page(body))).toEqual([]);
      expect(
        check(
          root,
          "src/components/frother-card.html",
          page(body),
          project(root),
          { isolatedClientBlocks: true },
        ),
      ).toEqual([]);
    }
  });

  it("misuse: a typo'd property of the augmented Window is still reported", () => {
    const root = fixture();
    const html = page(
      "interface Window { dataLayer: unknown[] }\nwindow.dataLayr = [];",
    );
    expect(
      check(root, "src/pages/index.html", html).map((d) => [d.code, d.text]),
    ).toEqual([[2551, "dataLayr"]]);
  });

  it("never reports a top-level name as unused: markup and later scripts can use it", () => {
    const root = strict();
    const html =
      '<button onclick="toggleFrother()">Milk frother</button>\n' +
      page(
        "interface FrotherSettings { speed: number }\nconst [first, second] = [1, 2];\nfunction toggleFrother(): void {\n  document.body.classList.toggle('frothing');\n}",
      );
    expect(check(root, "src/pages/index.html", html)).toEqual([]);
  });

  it("misuse: an unused name inside a function is still reported with noUnusedLocals", () => {
    const root = strict();
    const html = page(
      "function toggleFrother(): void {\n  const unusedSpeed = 3;\n}",
    );
    expect(
      check(root, "src/pages/index.html", html).map((d) => [d.code, d.text]),
    ).toEqual([[6133, "unusedSpeed"]]);
  });

  it("sees names declared by the page's untyped classic scripts", () => {
    const root = fixture();
    const html =
      "<script>function track(x){ return x } var frotherCount = 0; const [speedA] = [1];</script>\n" +
      page('track("hi");\nfrotherCount++;\nconsole.log(speedA);');
    expect(check(root, "src/pages/index.html", html)).toEqual([]);
    // A typed block may declare a name an untyped one also declares, as a later script may.
    expect(
      check(
        root,
        "src/pages/again.html",
        "<script>var frotherCount = 0;</script>\n" +
          page("var frotherCount = 1;\nconsole.log(frotherCount);"),
      ),
    ).toEqual([]);
  });

  it("misuse: names from a module, a server-side or an external script, and typos, are not in the page scope", () => {
    const root = fixture();
    const html =
      '<script type="module">function fromModule() {}</script>\n' +
      "<script data-bascik-build>function fromBuild() {}</script>\n" +
      '<script src="/frother.js">function fromSrc() {}</script>\n' +
      '<script type="application/json">{"fromJson": 1}</script>\n' +
      "<script>function track() {}</script>\n" +
      page("fromModule();\nfromBuild();\nfromSrc();\ntrak();");
    const diagnostics = check(root, "src/pages/index.html", html);
    expect(diagnostics.map((d) => d.text)).toEqual([
      "fromModule",
      "fromBuild",
      "fromSrc",
      "trak",
    ]);
    expect(diagnostics.every((d) => d.code === 2304 || d.code === 2552)).toBe(
      true,
    );
  });

  it("sees names declared by component scripts that run in the page scope", () => {
    const root = fixture();
    const component =
      "<button>Milk frother</button>\n<script>function startFrother() {}</script>\n" +
      '<script type="text/typescript">const frotherSpeed: number = 3;</script>\n';
    const html = page("startFrother();\nconsole.log(frotherSpeed + 1);");
    const file = root.write("src/pages/index.html", html);
    const service = project(root);
    expect(service.diagnostics(file, html)).toHaveLength(2);
    expect(
      service.diagnostics(file, html, { pageScopeHtml: [component] }),
    ).toEqual([]);
  });

  it("misuse: a syntax error stays in its own block, and the next block still runs", () => {
    const root = fixture();
    const first =
      page("const a: number =") + page("const b = 2;\nconsole.log(b);");
    const firstErrors = check(root, "src/pages/index.html", first);
    expect(firstErrors.map((d) => d.code)).toEqual([1109]);
    const firstEnd = first.indexOf("</script>");
    expect(firstErrors[0].start).toBeGreaterThan(first.indexOf("const a"));
    expect(firstErrors[0].end).toBeLessThanOrEqual(firstEnd);

    const unclosed =
      page('function openFrother() { console.log("open");') +
      page("const c = 3;\nconsole.log(c);\nopenFrother();");
    const unclosedErrors = check(root, "src/pages/unclosed.html", unclosed);
    // Only the brace, in the first block; the second block does not lose sight of the first block's function.
    expect(unclosedErrors.map((d) => d.code)).toEqual([1005]);
    expect(unclosedErrors[0].start).toBeGreaterThan(
      unclosed.indexOf("openFrother"),
    );
    expect(unclosedErrors[0].end).toBeLessThanOrEqual(
      unclosed.indexOf("</script>"),
    );

    // Every block broken: each reports its own error.
    const both = page("let = 1;") + page("const = 2;");
    const bothErrors = check(root, "src/pages/both.html", both);
    expect(bothErrors.length).toBeGreaterThanOrEqual(2);
    expect(bothErrors[0].start).toBeLessThan(both.indexOf("</script>"));
    expect(bothErrors.at(-1)!.start).toBeGreaterThan(both.indexOf("</script>"));
  });
});

describe("a page's classic globals are properties of window", () => {
  const WINVAR =
    "<script>var legacyState = { ready: true };</script>\n" +
    '<script type="text/typescript">var frotherState = { on: false }; function gtag(...args: unknown[]): void {}</script>\n' +
    '<script type="text/typescript">window.frotherState.on = true; globalThis.frotherState.on = false; self.gtag("js", new Date()); window.gtag("js", new Date()); console.log(window.legacyState, globalThis.legacyState);</script>\n';

  it("reaches a top-level var or function, and a plain script's names, through window, self and globalThis", () => {
    for (const root of [
      fixture(),
      fixture({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { noUnusedLocals: true },
        }),
      }),
    ])
      expect(check(root, "src/pages/winvar.html", WINVAR)).toEqual([]);
  });

  it("types them from their declarations, and keeps the DOM's own members", () => {
    const root = fixture();
    const html =
      page(
        "var frotherState = { on: false };\nfunction gtag(event: string): void {}",
      ) +
      page(
        'window.frotherState.on = 3;\nglobalThis.gtag(1);\nwindow.frotherStat;\nwindow.document.title = "Milk frother";\nconst w: Window = window;\nw.addEventListener("load", () => undefined);',
      );
    expect(
      check(root, "src/pages/index.html", html).map((d) => [d.code, d.text]),
    ).toEqual([
      [2322, "window.frotherState.on"],
      [2345, "1"],
      [2551, "frotherStat"],
    ]);
  });

  it("misuse: a typo's message names the global object's type, not Bascik's names for the page's globals", () => {
    const root = fixture();
    const html = page(
      "var frotherState = { on: false };\nglobalThis.frotherStat;\nwindow.frotherStat;",
    );
    const messages = check(root, "src/pages/index.html", html).map(
      (d) => d.message,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("'typeof globalThis'");
    expect(messages[1]).toContain("'Window & typeof globalThis'");
    for (const message of messages) expect(message).not.toMatch(/__bascik/i);
  });

  it("misuse: an addition several pages share through one component is declared once", () => {
    const root = fixture();
    const service = project(root);
    const html =
      '<span>config</span>\n<script type="text/typescript">\ndeclare global { const FROTHER_CONFIG: { speed: number } }\n</script>\n';
    const config = {
      fsPath: root.write("src/components/frother-config.html", html),
      text: html,
    };
    for (const name of ["a", "b"])
      expect(
        check(
          root,
          `src/pages/${name}.html`,
          page("FROTHER_CONFIG.speed;"),
          service,
          { usedComponents: [config] },
        ),
      ).toEqual([]);
  });

  it("misuse: let, const and class names, and names of other pages, are not properties of window", () => {
    const root = fixture();
    const service = project(root);
    check(
      root,
      "src/pages/other.html",
      page("var otherPageState = 1;\nwindow.otherPageState;"),
      service,
    );
    const html = page(
      "let frotherLet = 1;\nconst frotherConst = 2;\nclass FrotherClass {}\nconsole.log(frotherLet, frotherConst, FrotherClass);\nwindow.frotherLet;\nwindow.frotherConst;\nwindow.FrotherClass;\nwindow.otherPageState;",
    );
    expect(
      check(root, "src/pages/index.html", html, service).map((d) => [
        d.code,
        d.text,
      ]),
    ).toEqual([
      [2339, "frotherLet"],
      [2339, "frotherConst"],
      [2339, "FrotherClass"],
      [2339, "otherPageState"],
    ]);
  });

  it("misuse: a var named like a DOM global keeps the DOM's type on window", () => {
    const root = fixture();
    const html = page(
      'var length = "three";\nfunction close(reason: string): void {}\nconst size: number = window.length;\nwindow.close();\nconsole.log(length.toUpperCase());\nclose("done");',
    );
    expect(check(root, "src/pages/index.html", html)).toEqual([]);
  });

  it("does not report a var a plain script assigns as used before being assigned", () => {
    const root = fixture();
    const html =
      "<script>var shared = 1;</script>\n" +
      page("var shared: number;\nconsole.log(shared + 1);");
    expect(check(root, "src/pages/index.html", html)).toEqual([]);
    // Without another script that could assign it, the read is still reported.
    const alone = page("var own: number;\nconsole.log(own + 1);");
    expect(
      check(root, "src/pages/alone.html", alone).map((d) => [d.code, d.text]),
    ).toEqual([[2454, "own"]]);
  });
});

describe("a page's global augmentations stay in that page", () => {
  const AUG_A = page(
    "interface Window { pageConfig: { speed: number } }\nwindow.pageConfig = { speed: 1 };",
  );
  const AUG_B = page(
    'interface Window { pageConfig: string }\nwindow.pageConfig = "two";',
  );
  const DATA_LAYER = page(
    "interface Window { dataLayer: unknown[] }\nwindow.dataLayer = window.dataLayer || [];",
  );
  const USES_DATA_LAYER = page("window.dataLayer = [];");

  it("checks two pages that augment Window differently without a conflict, in either order", () => {
    for (const order of [
      ["aug-a", "aug-b"],
      ["aug-b", "aug-a"],
    ]) {
      const root = fixture();
      const service = project(root);
      const html: Record<string, string> = { "aug-a": AUG_A, "aug-b": AUG_B };
      for (const name of order)
        expect(
          check(root, `src/pages/${name}.html`, html[name], service),
        ).toEqual([]);
      // Both are still clean once both are loaded.
      for (const name of order)
        expect(
          check(root, `src/pages/${name}.html`, html[name], service),
        ).toEqual([]);
    }
  });

  it("misuse: another page's augmentation is not seen, whether or not that page is loaded", () => {
    const root = fixture();
    const alone = check(root, "src/pages/b.html", USES_DATA_LAYER);
    const service = project(root);
    expect(check(root, "src/pages/index.html", DATA_LAYER, service)).toEqual(
      [],
    );
    const withIndex = check(root, "src/pages/b.html", USES_DATA_LAYER, service);
    expect(alone.map((d) => [d.code, d.text])).toEqual([[2339, "dataLayer"]]);
    expect(withIndex.map((d) => [d.code, d.text])).toEqual([
      [2339, "dataLayer"],
    ]);
  });

  it("keeps an author's declare global and a component's augmentation in their own file", () => {
    const root = fixture();
    const service = project(root);
    check(
      root,
      "src/components/frother-card.html",
      page(
        "declare global { interface Window { cardState: number } }\nwindow.cardState = 1;",
      ),
      service,
      { isolatedClientBlocks: true },
    );
    check(
      root,
      "src/pages/declared.html",
      page(
        'declare global { interface Window { cardState: string } }\nwindow.cardState = "x";',
      ),
      service,
    );
    expect(
      check(
        root,
        "src/pages/index.html",
        page("window.cardState;"),
        service,
      ).map((d) => [d.code, d.text]),
    ).toEqual([[2339, "cardState"]]);
  });

  it("checks the same addition on many pages together, and one that names a page's own type apart", () => {
    const root = fixture();
    const service = project(root);
    for (let index = 0; index < 4; index++)
      expect(
        check(root, `src/pages/same-${index}.html`, DATA_LAYER, service),
      ).toEqual([]);
    // One service for the four, beside the shared client and server ones.
    expect(service.serviceCount).toBe(3);
    const local = page(
      "type Config = { speed: number };\ninterface Window { config: Config }\nwindow.config = { speed: 1 };",
    );
    for (const name of ["local-a", "local-b"])
      expect(check(root, `src/pages/${name}.html`, local, service)).toEqual([]);
    expect(service.serviceCount).toBe(5);
    const imported = page(
      'import type { Frother } from "@/lib/frother.ts";\ninterface Window { frother: Frother }\nwindow.frother = { speed: 1 };',
    );
    root.write(
      "src/lib/frother.ts",
      "export interface Frother { speed: number }\n",
    );
    for (const name of ["imported-a", "imported-b"])
      expect(check(root, `src/pages/${name}.html`, imported, service)).toEqual(
        [],
      );
    expect(service.serviceCount).toBe(7);
  });

  it("misuse: one page leaving a shared addition does not take it from the others", () => {
    const root = fixture();
    const service = project(root);
    const first = root.write("src/pages/first.html", DATA_LAYER);
    const second = root.write("src/pages/second.html", DATA_LAYER);
    expect(service.diagnostics(first, DATA_LAYER)).toEqual([]);
    expect(service.diagnostics(second, DATA_LAYER)).toEqual([]);
    expect(
      service.diagnostics(first, USES_DATA_LAYER).map((d) => d.code),
    ).toEqual([2339]);
    service.removePage(first);
    expect(service.diagnostics(second, DATA_LAYER)).toEqual([]);
    expect(service.serviceCount).toBe(3);
    service.removePage(second);
    expect(service.serviceCount).toBe(2);
  });

  it("misuse: a page that stops augmenting, or is removed, leaves nothing behind", () => {
    const root = fixture();
    const service = project(root);
    const file = root.write("src/pages/aug-a.html", AUG_A);
    expect(service.diagnostics(file, AUG_A)).toEqual([]);
    const plain = page("window.pageConfig;");
    expect(service.diagnostics(file, plain).map((d) => d.code)).toEqual([2339]);
    expect(service.diagnostics(file, AUG_A)).toEqual([]);
    service.removePage(file);
    expect(service.serviceCount).toBe(2);
    expect(check(root, "src/pages/aug-b.html", AUG_B, service)).toEqual([]);
  });
});

describe("a component's global additions reach the pages that use it", () => {
  const GA_TAG =
    '<template><span>ga</span></template>\n<script type="text/typescript">\ninterface Window { dataLayer: unknown[] }\nwindow.dataLayer = window.dataLayer || [];\n</script>\n';
  const USES_GA = page('window.dataLayer.push({ event: "x" });');

  /** Writes a component to the fixture and returns it as a page's `usedComponents` entry. */
  function component(root: Fixture, relative: string, html: string) {
    return { fsPath: root.write(relative, html), text: html };
  }

  it("sees a scoped component's Window addition on the page that uses it, and only there", () => {
    const root = fixture();
    const service = project(root);
    const ga = component(root, "src/components/ga-tag.html", GA_TAG);
    expect(
      check(root, "src/components/ga-tag.html", GA_TAG, service, {
        isolatedClientBlocks: true,
      }),
    ).toEqual([]);
    expect(
      check(root, "src/pages/uses-ga.html", USES_GA, service, {
        usedComponents: [ga],
      }),
    ).toEqual([]);
    // In either order: a fresh project that checks the page first.
    expect(
      check(root, "src/pages/uses-ga.html", USES_GA, project(root), {
        usedComponents: [ga],
      }),
    ).toEqual([]);
    // A page that does not use the component never sees it.
    expect(
      check(root, "src/pages/other.html", USES_GA, service).map((d) => [
        d.code,
        d.text,
      ]),
    ).toEqual([[2339, "dataLayer"]]);
  });

  it("sees the addition of a component whose scripts share the page scope", () => {
    const root = fixture();
    const shared =
      '<template><span>ga</span></template>\n<script type="text/typescript">\ninterface Window { dataLayer: unknown[] }\nfunction gtag2(...args: unknown[]): void { window.dataLayer.push(args); }\n</script>\n';
    const ga = component(root, "src/components/ga-tag.html", shared);
    const html = page(
      'window.dataLayer.push({ event: "x" });\nwindow.gtag2("js");',
    );
    expect(
      check(root, "src/pages/uses-ga.html", html, project(root), {
        pageScopeHtml: [shared],
        usedComponents: [ga],
      }),
    ).toEqual([]);
  });

  it("follows an addition that names the component's own types, and a declare global", () => {
    const root = fixture();
    const card = component(
      root,
      "src/components/frother-card.html",
      '<article>card</article>\n<script type="text/typescript">\ninterface FrotherState { speed: number }\ninterface Window { frother: FrotherState }\ndeclare global { var frotherReady: boolean }\nwindow.frother = { speed: 1 };\n</script>\n',
    );
    const html = page(
      'window.frother.speed = 2;\nif (frotherReady) window.frother.speed = "fast";\nwindow.frothr;',
    );
    expect(
      check(root, "src/pages/index.html", html, project(root), {
        usedComponents: [card],
      }).map((d) => [d.code, d.text]),
    ).toEqual([
      [2322, "window.frother.speed"],
      [2551, "frothr"],
    ]);
  });

  it("checks many pages that use one component together, apart from pages that do not", () => {
    const root = fixture();
    const service = project(root);
    const ga = component(root, "src/components/ga-tag.html", GA_TAG);
    for (let index = 0; index < 4; index++)
      expect(
        check(root, `src/pages/uses-${index}.html`, USES_GA, service, {
          usedComponents: [ga],
        }),
      ).toEqual([]);
    expect(service.serviceCount).toBe(3);
    expect(
      check(root, "src/components/ga-tag.html", GA_TAG, service, {
        isolatedClientBlocks: true,
      }),
    ).toEqual([]);
    expect(
      check(root, "src/pages/plain.html", page("window.dataLayer;"), service)
        .length,
    ).toBe(1);
  });

  it("misuse: an edited, broken or dropped component changes what the page sees", () => {
    const root = fixture();
    const service = project(root);
    const ga = component(root, "src/components/ga-tag.html", GA_TAG);
    const file = root.write("src/pages/uses-ga.html", USES_GA);
    expect(
      service.diagnostics(file, USES_GA, { usedComponents: [ga] }),
    ).toEqual([]);
    // The component's unsaved edit renames the addition.
    const renamed = { ...ga, text: GA_TAG.replace(/dataLayer/g, "events") };
    expect(
      service
        .diagnostics(file, USES_GA, { usedComponents: [renamed] })
        .map((d) => d.code),
    ).toEqual([2339]);
    // A component block mid-edit adds nothing and breaks nothing.
    const broken = {
      ...ga,
      text: GA_TAG.replace("unknown[] }", "unknown[] "),
    };
    expect(
      service
        .diagnostics(file, USES_GA, { usedComponents: [broken] })
        .map((d) => d.code),
    ).toEqual([2339]);
    expect(
      service.diagnostics(file, USES_GA, { usedComponents: [ga] }),
    ).toEqual([]);
    // The page stops using it.
    expect(service.diagnostics(file, USES_GA).map((d) => d.code)).toEqual([
      2339,
    ]);
    service.removePage(file);
    expect(service.serviceCount).toBe(2);
  });

  it("misuse: a component without additions keeps the page in the shared program", () => {
    const root = fixture();
    const service = project(root);
    const button = component(
      root,
      "src/components/frother-button.html",
      '<button>Milk frother</button>\n<script type="text/typescript">\nconst label: string = "on";\n</script>\n',
    );
    expect(
      check(root, "src/pages/index.html", page("const speed = 1;"), service, {
        usedComponents: [button],
      }),
    ).toEqual([]);
    expect(service.serviceCount).toBe(2);
  });
});

describe("TypeScriptProjects", () => {
  it("reports why there is no TypeScript, without checking", () => {
    const root = fixture();
    const projects = new TypeScriptProjects({
      resolve: () => ({
        ok: false,
        message: "no typescript here",
        skipped: [],
      }),
    });
    expect(
      projects.diagnostics({
        projectRoot: root.root,
        importRoot: root.file("src"),
        htmlPath: root.file("src/pages/index.html"),
        text: page('const n: number = "x";'),
      }),
    ).toEqual({ status: "unavailable", message: "no typescript here" });
  });

  const loaded = (root: Fixture) => () => ({
    ok: true as const,
    ts,
    version: ts.version,
    source: "project" as const,
    packageDir: root.root,
    skipped: [],
  });

  it("misuse: a library the tsconfig adds but the TypeScript copy lacks turns checks off with a note", () => {
    const root = fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { lib: ["ES2023", "DOM"] },
      }),
    });
    // A copy of the library folder without lib.es2023.d.ts.
    const realLib = path.dirname(ts.getDefaultLibFilePath({}));
    for (const name of fs.readdirSync(realLib)) {
      if (name.startsWith("lib.") && name !== "lib.es2023.d.ts")
        root.link(`partial-lib/${name}`, path.join(realLib, name));
    }
    const partial = {
      ...ts,
      getDefaultLibFilePath: () => root.file("partial-lib/lib.d.ts"),
    };
    const projects = new TypeScriptProjects({
      resolve: () => ({
        ok: true,
        ts: partial,
        version: ts.version,
        source: "project",
        packageDir: root.file("partial"),
        skipped: [],
      }),
    });
    const result = projects.diagnostics({
      projectRoot: root.root,
      importRoot: root.file("src"),
      htmlPath: root.file("src/pages/index.html"),
      text: page("document.title = 'Milk frother';"),
    });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.message).toContain(
      "is missing library files the project's settings need: lib.es2023.d.ts",
    );
  });

  it("returns cancelled when the request goes stale mid-check", () => {
    const root = fixture();
    let cancelled = false;
    const projects = new TypeScriptProjects({
      resolve: loaded(root),
      isCancellationRequested: () => cancelled,
    });
    const request = {
      projectRoot: root.root,
      importRoot: root.file("src"),
      htmlPath: root.file("src/pages/index.html"),
      text: page('const n: number = "x";'),
    };
    cancelled = true;
    expect(projects.diagnostics(request)).toEqual({ status: "cancelled" });
    cancelled = false;
    expect(projects.diagnostics(request)).toMatchObject({
      status: "ok",
      diagnostics: [{ code: 2322 }],
    });
  });

  it("brings each program up to date once for pages prepared together, not once per page", () => {
    // With @bascik/bascik's types, so the server program is not made again without them.
    const root = nodeProject();
    const make = () =>
      new TypeScriptProjects({
        resolve: () => ({
          ok: true,
          ts,
          version: ts.version,
          source: "project",
          packageDir: "",
          skipped: [],
        }),
      });
    const pages = ["a", "b", "c", "d"].map((name) => {
      const text =
        page('const speed: number = "fast";') +
        page('export default () => "Milk frother";', " data-bascik-build");
      return {
        htmlPath: root.write(`src/pages/${name}.html`, text),
        text,
      };
    });
    const base = { projectRoot: root.root, importRoot: root.file("src") };

    const oneByOne = make();
    for (const one of pages)
      expect(oneByOne.diagnostics({ ...base, ...one })).toMatchObject({
        status: "ok",
      });
    const unbatched = oneByOne.programUpdates(root.root);

    const batched = make();
    batched.preparePages({ ...base, pages });
    for (const one of pages) {
      const result = batched.diagnostics({ ...base, ...one });
      expect(
        result.status === "ok" && result.diagnostics.map((d) => d.code),
      ).toEqual([2322]);
    }
    // One update per program (client and server), however many pages.
    expect(batched.programUpdates(root.root)).toBe(2);
    expect(unbatched).toBeGreaterThanOrEqual(pages.length * 2);
    oneByOne.dispose();
    batched.dispose();
  });

  it("misuse: preparing pages without a usable TypeScript, or for a page closed since, does nothing harmful", () => {
    const root = fixture();
    const missing = new TypeScriptProjects({
      resolve: () => ({ ok: false, message: "none", skipped: [] }),
    });
    expect(() =>
      missing.preparePages({
        projectRoot: root.root,
        importRoot: root.file("src"),
        pages: [{ htmlPath: root.file("src/pages/a.html"), text: page("1;") }],
      }),
    ).not.toThrow();
    expect(missing.programUpdates(root.root)).toBe(0);
  });

  it("reads unsaved buffers, and remakes a project when its tsconfig or import root changes", () => {
    const root = fixture({ "src/lib/a.ts": "export const a: number = 1;\n" });
    const projects = new TypeScriptProjects({ resolve: loaded(root) });
    const text = page(
      'import { a } from "@/lib/a.ts";\nfunction f(x) { return x; }\nconst s: number = a;',
    );
    const request = {
      projectRoot: root.root,
      importRoot: root.file("src"),
      htmlPath: root.file("src/pages/index.html"),
      text,
    };
    const codes = () => {
      const result = projects.diagnostics(request);
      return result.status === "ok"
        ? result.diagnostics.map((d) => d.code)
        : result.status;
    };
    expect(codes()).toEqual([7006]);
    projects.setOpenFile(
      root.file("src/lib/a.ts"),
      "export const a: string = 'x';\n",
    );
    expect(codes()).toEqual([7006, 2322]);
    projects.setOpenFile(root.file("src/lib/a.ts"), undefined);
    expect(codes()).toEqual([7006]);
    root.write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    projects.fileChanged(root.file("tsconfig.json"));
    expect(codes()).toEqual([]);
    // `@/` now points at the project root, where lib/a.ts exports a string.
    root.write("lib/a.ts", "export const a = 'moved';\n");
    request.importRoot = root.root;
    expect(codes()).toEqual([2322]);
  });
});
