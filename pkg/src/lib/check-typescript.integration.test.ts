/**
 * `bascik --check --typescript` through the real CLI, with the real language server: compiled from `lsp/src` into
 * the fixture's `node_modules`, as `npm install` would place it, because the workspace copy publishes a `dist/`
 * that may not be built. TypeScript checks are opt-in: without the flag the check is unchanged, and without a usable
 * `typescript` the flag adds one note and no failure.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const cliPath = resolve(here, "../index.ts");
const require = createRequire(import.meta.url);
const packageDir = (name: string) =>
  dirname(require.resolve(`${name}/package.json`));
/** A dependency of the language server, as the lsp workspace sees it (hoisted, or its own copy). */
const languageServerDependency = (name: string) =>
  [join(repo, "lsp/node_modules", name), join(repo, "node_modules", name)].find(
    (candidate) => existsSync(join(candidate, "package.json")),
  )!;

const PAGE = `<!doctype html>
<html lang="en"><head><title>Milk frother</title></head><body>
<script type="text/typescript">
  const speed: number = "fast";
</script>
</body></html>
`;

let work: string;
let project: string;

const link = (target: string, at: string) => {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, "junction");
};

const check = (args: string[]) => {
  const result = spawnSync(process.execPath, [cliPath, "--check", ...args], {
    cwd: project,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    output: `${result.stdout}${result.stderr}`,
  };
};

beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "bascik-check-ts-")));
  project = join(work, "site");
  mkdirSync(join(project, "src/pages"), { recursive: true });
  writeFileSync(join(project, "bascik.config.js"), "export default {};\n");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "site", private: true, type: "module" }),
  );
  writeFileSync(join(project, "src/pages/index.html"), PAGE);

  // The language server, built from source into the project.
  const server = join(project, "node_modules/@bascik/language-server");
  const tsc = join(packageDir("typescript"), "bin/tsc");
  const build = spawnSync(
    process.execPath,
    [
      tsc,
      "-p",
      join(repo, "lsp/tsconfig.json"),
      "--outDir",
      join(server, "dist"),
      "--declaration",
      "false",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
    ],
    { encoding: "utf8" },
  );
  expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
  const manifest = JSON.parse(
    readFileSync(join(repo, "lsp/package.json"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(server, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      exports: manifest.exports,
    }),
  );
  for (const dependency of [
    "vscode-languageserver",
    "vscode-languageserver-textdocument",
  ])
    link(
      languageServerDependency(dependency),
      join(server, "node_modules", dependency),
    );
}, 120_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("bascik --check --typescript", () => {
  it("misuse: without a usable typescript, prints one note and exits 0", () => {
    const result = check(["--typescript"]);
    expect(result.status, result.output).toBe(0);
    const notes = result.stdout
      .split("\n")
      .filter((line) => line.includes("TypeScript checks of type="));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("npm install --save-dev typescript@6");
    expect(result.stdout).not.toContain("TS2322");
  }, 60_000);

  it("without the flag, the check is the same with or without typescript installed", () => {
    const before = check([]);
    link(packageDir("typescript-6"), join(project, "node_modules/typescript"));
    try {
      const after = check([]);
      expect(before.status, before.output).toBe(0);
      expect(after.status, after.output).toBe(0);
      expect(after.stdout).toBe(before.stdout);
      expect(after.stdout).not.toContain("TS2322");
      expect(after.stdout).toContain("checked by @bascik/language-server");
    } finally {
      rmSync(join(project, "node_modules/typescript"), { force: true });
    }
  }, 60_000);

  it("with the flag and typescript installed, exits 1 and names file:line:column", () => {
    link(packageDir("typescript-6"), join(project, "node_modules/typescript"));
    try {
      const result = check(["--typescript"]);
      expect(result.status, result.output).toBe(1);
      expect(result.stdout).toMatch(
        /src\/pages\/index\.html:4:9 - error: \(TS2322\) Type 'string' is not assignable to type 'number'\./,
      );
      expect(result.stdout).not.toContain("TypeScript checks of type=");

      const json = check(["--typescript", "--json"]);
      expect(json.status).toBe(1);
      const report = JSON.parse(json.stdout) as {
        perFileNotes: string[];
        findings: { category: string; locations: { line: number }[] }[];
      };
      expect(report.perFileNotes).toEqual([]);
      expect(
        report.findings.filter((finding) => finding.category === "TS2322"),
      ).toEqual([
        expect.objectContaining({
          locations: [{ filePath: "src/pages/index.html", line: 4, column: 9 }],
        }),
      ]);
    } finally {
      rmSync(join(project, "node_modules/typescript"), { force: true });
    }
  }, 60_000);
});
