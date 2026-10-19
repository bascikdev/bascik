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
