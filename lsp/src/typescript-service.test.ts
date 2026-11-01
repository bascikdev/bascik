import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compilerOptionsFor,
  TypeScriptProject,
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
  options: { isolatedClientBlocks?: boolean } = {},
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

  it("without @types/node, a server block reports Node's globals as unknown", () => {
    const root = fixture();
    const server = check(
      root,
      "src/pages/server.html",
      page("const port = process.env.PORT;", " data-bascik-build"),
    );
    expect(server.map((d) => d.text)).toEqual(["process"]);
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
      root.file("src/pages/speed.ts"),
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
