import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CheckUsageError, checkFiles, formatDiagnostic } from "./check.js";

describe("checkFiles", () => {
  let root: string;

  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-check-"));
    write(
      "bascik.config.ts",
      "export default { directory: { api: 'server/routes' } };\n",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns structured diagnostics with relative paths and 1-based positions", async () => {
    write("src/pages/a.html", '<p>ok</p>\n<p data-bascik-slott="x">hi</p>\n');
    const result = await checkFiles({ cwd: root });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      filePath: path.join("src", "pages", "a.html"),
      line: 2,
      column: 4,
      severity: "warning",
      code: "unknown-bascik-attribute",
    });
  });

  it("reports a component name with an underscore as a warning, which disabledRules turns off", async () => {
    write("src/components/site-nav_x.html", "<nav>hi</nav>\n");
    const result = await checkFiles({ cwd: root });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        filePath: path.join("src", "components", "site-nav_x.html"),
        line: 1,
        severity: "warning",
        code: "component-name-underscore",
      }),
    ]);
    write(
      "bascik.ext.json",
      JSON.stringify({
        diagnostics: { disabledRules: ["component-name-underscore"] },
      }),
    );
    expect((await checkFiles({ cwd: root })).diagnostics).toEqual([]);
  });

  it("checks several targets once each, and a file named by two targets is not reported twice", async () => {
    const page = write("src/pages/a.html", '<p data-bascik-slott="x">hi</p>\n');
    write("src/components/my-card.html", "<p>hi</p>\n");
    const result = await checkFiles({
      cwd: root,
      targets: ["src/pages", page, "src/components"],
    });
    expect(result.filesChecked).toBe(2);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("limits a folder to the file types given for it", async () => {
    write("src/pages/a.html", '<p data-bascik-slott="x">hi</p>\n');
    write("src/pages/vendor.js", "document.querySelector('.card');\n");
    const everything = await checkFiles({ cwd: root, targets: ["src/pages"] });
    expect(everything.filesChecked).toBe(2);
    const markupOnly = await checkFiles({
      cwd: root,
      targets: [{ path: "src/pages", extensions: ["html"] }],
    });
    expect(markupOnly.filesChecked).toBe(1);
    expect(markupOnly.diagnostics.map((d) => d.filePath)).toEqual([
      path.join("src", "pages", "a.html"),
    ]);
  });

  it("checks an .mts component script the same way as a .ts one", async () => {
    const script =
      "const id: string = 'x';\ndocument.getElementById(`card-${id}`);\n";
    write("src/components/ts-card.ts", script);
    write("src/components/mts-card.mts", script);
    const result = await checkFiles({ cwd: root, targets: ["src/components"] });
    expect(result.filesChecked).toBe(2);
    const codesFor = (name: string) =>
      result.diagnostics
        .filter((d) => d.filePath.endsWith(name))
        .map((d) => d.code);
    expect(codesFor("ts-card.ts")).not.toEqual([]);
    expect(codesFor("mts-card.mts")).toEqual(codesFor("ts-card.ts"));
  });

  it("applies the API rules in the folder directory.api names", async () => {
    write(
      "server/routes/users.ts",
      'export const get = () => new Response("x");\n',
    );
    write(
      "src/api/ignored.ts",
      'export const get = () => new Response("x");\n',
    );
    const result = await checkFiles({ cwd: root, targets: ["server", "src"] });
    const apiCodes = result.diagnostics
      .filter((d) => d.filePath.endsWith("users.ts"))
      .map((d) => d.code);
    expect(apiCodes).toContain("invalid-method-case");
    expect(
      result.diagnostics.filter((d) => d.filePath.endsWith("ignored.ts")),
    ).toEqual([]);
  });

  it("writes the fixes that have one correct answer and reports only what remains", async () => {
    write(
      "src/components/my-card.html",
      "<h2 data-bascik-prop-title>Title</h2>\n",
    );
    const page = write(
      "src/pages/a.html",
      '<my-card title="Hello"></my-card>\n',
    );
    const before = await checkFiles({ cwd: root });
    expect(before.diagnostics.map((d) => d.code)).toContain(
      "missing-prop-prefix",
    );

    const fixed = await checkFiles({ cwd: root, fix: true });
    expect(fixed.fixedFiles).toEqual([path.join("src", "pages", "a.html")]);
    expect(fixed.diagnostics.map((d) => d.code)).not.toContain(
      "missing-prop-prefix",
    );
    expect(fs.readFileSync(page, "utf8")).toContain(
      'data-bascik-prop-title="Hello"',
    );
  });

  it("reports an unbalanced brace in a component <style> and companion stylesheet at the build's lines (finding 42)", async () => {
    write(
      "src/components/feature-card/feature-card.html",
      '<article class="card">x</article>\n<style>\n  article { color: red;\n  .card { flex: 1; }\n</style>\n',
    );
    write(
      "src/components/book-card/book-card.html",
      '<p class="title">x</p>\n',
    );
    write(
      "src/components/book-card/book-card.css",
      ".title { color: red; }\n}\n",
    );
    write(
      "src/components/good-card/good-card.html",
      '<p class="a">x</p>\n<style>\n  .a::after { content: "}"; }\n  /* { */\n</style>\n',
    );
    const found = (await checkFiles({ cwd: root })).diagnostics
      .filter((d) => d.code === "css-unbalanced-braces")
      .map((d) => [d.filePath, d.line, d.severity]);
    expect(found).toEqual(
      expect.arrayContaining([
        [
          path.join("src", "components", "feature-card", "feature-card.html"),
          3,
          "error",
        ],
        [
          path.join("src", "components", "book-card", "book-card.css"),
          2,
          "error",
        ],
      ]),
    );
    expect(found).toHaveLength(2);
  });

  it("reports CSS that only targets preserved elements at the build's lines (finding 22)", async () => {
    write(
      "bascik.config.ts",
      "export default { directory: { api: 'server/routes' }, scoping: { preserve: ['code', 'x-*'] } };\n",
    );
    write(
      "src/components/code-note/code-note.html",
      '<div class="note">\n  <code class="inline">x</code>\n  <x-chart class="chart-a"></x-chart>\n</div>\n<style>\n  .note code { color: red; }\n  .chart-a { color: red; }\n  .note { color: blue; }\n</style>\n',
    );
    write(
      "src/components/code-note/code-note.css",
      "\n.inline { color: red; }\n",
    );
    const found = (await checkFiles({ cwd: root })).diagnostics
      .filter((d) => d.code === "css-preserved-target")
      .map((d) => [d.filePath, d.line, d.severity]);
    const html = path.join("src", "components", "code-note", "code-note.html");
    const css = path.join("src", "components", "code-note", "code-note.css");
    expect(found).toEqual(
      expect.arrayContaining([
        [html, 6, "warning"],
        [html, 7, "warning"],
        [css, 2, "warning"],
      ]),
    );
    expect(found).toHaveLength(3);
  });

  it("raises a usage error, not a finding, for a path that does not exist", async () => {
    await expect(
      checkFiles({ cwd: root, targets: ["nope"] }),
    ).rejects.toBeInstanceOf(CheckUsageError);
    await expect(
      checkFiles({ cwd: root, projectPath: "nope" }),
    ).rejects.toThrow("Project directory does not exist");
  });

  it("skips tests, dot folders, node_modules, and dist", async () => {
    const bad = '<p data-bascik-slott="x">hi</p>\n';
    write("src/pages/a.test.html", bad);
    write(".hidden/a.html", bad);
    write("node_modules/x/a.html", bad);
    write("dist/a.html", bad);
    const result = await checkFiles({ cwd: root });
    expect(result.diagnostics).toEqual([]);
  });

  it("formats a diagnostic with and without color", () => {
    const diagnostic = {
      filePath: "a.html",
      line: 2,
      column: 4,
      severity: "error" as const,
      code: "x-rule",
      message: "Bad.",
    };
    expect(formatDiagnostic(diagnostic, false)).toBe(
      "a.html:2:4 - error: (x-rule) Bad.",
    );
    expect(formatDiagnostic(diagnostic)).toContain("\x1b[31merror\x1b[0m");
    expect(formatDiagnostic({ ...diagnostic, code: undefined }, false)).toBe(
      "a.html:2:4 - error: Bad.",
    );
  });
});

describe("checkFiles hints", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-check-hints-"));
    fs.writeFileSync(
      path.join(root, "bascik.config.ts"),
      "export default {};\n",
    );
    fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
    // Declares a prop binding that nothing in src/ supplies: a hint, because usage may live outside what is scanned.
    fs.writeFileSync(
      path.join(root, "src", "components", "my-link.html"),
      '<a data-bascik-attr-href="href">x</a>\n',
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports a hint as its own severity by default, so an editor-style run sees it", async () => {
    const result = await checkFiles({ cwd: root });
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["attr-prop-unsupplied", "info"],
    ]);
    expect(formatDiagnostic(result.diagnostics[0], false)).toContain("hint:");
  });

  it("leaves hints out when the caller gates on results", async () => {
    const result = await checkFiles({ cwd: root, hints: false });
    expect(result.diagnostics).toEqual([]);
  });
});
