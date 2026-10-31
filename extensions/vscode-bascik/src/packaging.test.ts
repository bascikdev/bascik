import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, matchesGlob, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = join(__dirname, "..");
const read = (file: string) => readFileSync(join(extensionRoot, file), "utf8");

/** Where `tsc -p tsconfig.json` (run by build.mjs to type-check and emit the tests) writes its output. */
const tscOutDir = (): string => {
  const tsconfig = JSON.parse(read("tsconfig.json")) as {
    compilerOptions: { outDir: string };
  };
  return relative(
    extensionRoot,
    resolve(extensionRoot, tsconfig.compilerOptions.outDir),
  ).replace(/\\/g, "/");
};

/** `.vscodeignore` patterns, split as vsce reads them: a `!` pattern puts back a file another pattern left out. */
const ignorePatterns = () => {
  const lines = read(".vscodeignore")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return {
    exclude: lines.filter((line) => !line.startsWith("!")),
    include: lines
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1)),
  };
};

/** Whether `vsce package` puts `file` (relative to the extension folder) in the VSIX. */
const ships = (file: string): boolean => {
  const { exclude, include } = ignorePatterns();
  return (
    !exclude.some((pattern) => matchesGlob(file, pattern)) ||
    include.some((pattern) => matchesGlob(file, pattern))
  );
};

describe("extension packaging", () => {
  it("keeps tsc output out of dist/, which holds only the bundles that ship", () => {
    const outDir = tscOutDir();
    expect(outDir === "dist" || outDir.startsWith("dist/")).toBe(false);
  });

  it("runs the real-editor suite from the tests tsc emits", () => {
    const config = createRequire(__filename)(
      join(extensionRoot, ".vscode-test.cjs"),
    ) as { files: string };
    expect(config.files.startsWith(`${tscOutDir()}/`)).toBe(true);
  });

  it("ships the two bundles from dist/ and nothing else built", () => {
    const outDir = tscOutDir();
    expect(ships("dist/extension.js")).toBe(true);
    expect(ships("dist/server.js")).toBe(true);
    for (const leftOver of [
      "dist/script-check.js",
      "dist/script-check-prompt.js",
      "dist/client-options.js",
      "dist/a-module-added-later.js",
      "dist/test/extension.test.js",
      `${outDir}/extension.js`,
      `${outDir}/script-check.js`,
      `${outDir}/test/extension.test.js`,
    ]) {
      expect(ships(leftOver), leftOver).toBe(false);
    }
  });

  it("ships the manifest, the grammar, the snippets, the license, and the bundled packages' notices", () => {
    for (const file of [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/THIRD-PARTY-NOTICES.txt",
      "icon.png",
      "syntaxes/bascik-html.tmLanguage.json",
      "snippets/api-routes.json",
      "snippets/api-routes-javascript.json",
    ]) {
      expect(ships(file), file).toBe(true);
    }
  });
});
