import * as path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { checkFiles, supportsTypeScript } from "./check.js";
import { runCliCheck } from "./cli.js";
import {
  createFixture,
  type Fixture,
  TYPESCRIPT_6_DIR,
  TYPESCRIPT_7_DIR,
} from "./typescript.test.util.js";

const PAGE =
  '<main>Milk frother</main>\n<script type="text/typescript">\n  const speed: number = "fast";\n</script>\n';

describe("checkFiles with TypeScript", () => {
  let root: Fixture;

  beforeEach(() => {
    root = createFixture({
      "bascik.config.ts": "export default {};\n",
      "src/pages/index.html": PAGE,
      "src/pages/plain.html":
        '<script>const speed: number = "fast";</script>\n',
    });
  });

  afterEach(() => root.remove());

  it("says it supports the typescript option", () => {
    expect(supportsTypeScript).toBe(true);
  });

  it("reports nothing from TypeScript unless asked", async () => {
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    const result = await checkFiles({ cwd: root.root });
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("reports a TypeScript error as an error at its line and column when asked", async () => {
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    const result = await checkFiles({ cwd: root.root, typescript: true });
    expect(result.diagnostics).toEqual([
      {
        filePath: path.join("src", "pages", "index.html"),
        line: 3,
        column: 9,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  it("misuse: without a usable TypeScript, adds one note and still runs Bascik's checks", async () => {
    root.write("src/pages/other.html", PAGE);
    root.write("src/pages/typo.html", '<p data-bascik-slott="x">hi</p>\n');
    const result = await checkFiles({ cwd: root.root, typescript: true });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain(
      'TypeScript checks of type="text/typescript" scripts are off',
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "unknown-bascik-attribute",
    ]);
  });

  it("checks a page's client blocks in one scope and a scoped component's one by one", async () => {
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    const blocks =
      '<script type="text/typescript">\n  function frotherLabel(): string { return "Milk frother"; }\n</script>\n' +
      '<script type="text/typescript">\n  document.title = frotherLabel();\n</script>\n';
    root.write("src/pages/index.html", blocks);
    root.write("src/components/frother-card.html", blocks);
    const result = await checkFiles({ cwd: root.root, typescript: true });
    // The page's second block sees the first block's function; the component's is wrapped on its own.
    expect(result.diagnostics.map((d) => [d.filePath, d.code])).toEqual([
      [path.join("src", "components", "frother-card.html"), "TS2304"],
    ]);

    // With scoping.scriptBlocks off, a component's blocks share the page's scope too.
    root.write(
      "bascik.config.ts",
      "export default { scoping: { scriptBlocks: false } };\n",
    );
    const unscoped = await checkFiles({ cwd: root.root, typescript: true });
    expect(unscoped.diagnostics).toEqual([]);
  });

  it("sees the names a page's plain scripts declare, and a component's when its scripts share the page scope", async () => {
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    root.write(
      "src/components/frother-button.html",
      "<button>Milk frother</button>\n<script>function startFrother() {}</script>\n",
    );
    root.write(
      "src/pages/index.html",
      '<frother-button />\n<script>function track(name) { return name; }</script>\n<script type="text/typescript">\n  track("open");\n  startFrother();\n</script>\n',
    );
    // Scoped (the default), the component's script runs in its own function: its name is not the page's.
    const scoped = await checkFiles({ cwd: root.root, typescript: true });
    expect(scoped.diagnostics.map((d) => [d.line, d.code])).toEqual([
      [5, "TS2304"],
    ]);
    root.write(
      "bascik.config.ts",
      "export default { scoping: { scriptBlocks: false } };\n",
    );
    const unscoped = await checkFiles({ cwd: root.root, typescript: true });
    expect(unscoped.diagnostics).toEqual([]);
  });

  it("misuse: a project with TypeScript 7 gets the note, naming why its copy was skipped", async () => {
    root.link("node_modules/typescript", TYPESCRIPT_7_DIR);
    const result = await checkFiles({ cwd: root.root, typescript: true });
    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatch(
      /TypeScript 7\.\d+\.\d+ in .* has no language service/,
    );
  });
});

describe("bascik-language-server --check --typescript", () => {
  let root: Fixture;
  let log: MockInstance<typeof console.log>;
  let error: MockInstance<typeof console.error>;
  let cwd: MockInstance<typeof process.cwd>;

  beforeEach(() => {
    root = createFixture({
      "bascik.config.ts": "export default {};\n",
      "src/pages/index.html": PAGE,
    });
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    cwd = vi.spyOn(process, "cwd").mockReturnValue(root.root);
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    cwd.mockRestore();
    root.remove();
  });

  const output = () => log.mock.calls.map(([line]) => String(line)).join("\n");

  it("exits 1 and prints file:line:column with TS2322", async () => {
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    expect(await runCliCheck(["--typescript"])).toBe(1);
    expect(output()).toContain(
      `${path.join("src", "pages", "index.html")}:3:9`,
    );
    expect(output()).toContain("(TS2322)");
  });

  it("without the flag, stays as it was", async () => {
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    expect(await runCliCheck([])).toBe(0);
    expect(output()).not.toContain("TS2322");
  });

  it("misuse: without TypeScript, prints one note and exits 0", async () => {
    expect(await runCliCheck(["--typescript"])).toBe(0);
    const notes = log.mock.calls.filter(([line]) =>
      String(line).startsWith("note: "),
    );
    expect(notes).toHaveLength(1);
    expect(String(notes[0][0])).toContain(
      "npm install --save-dev typescript@6",
    );
  });

  it("misuse: a typo'd flag is a usage error, not ignored", async () => {
    expect(await runCliCheck(["--typscript"])).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown option: --typscript"),
    );
  });
});
