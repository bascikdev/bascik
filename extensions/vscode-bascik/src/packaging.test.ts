import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, matchesGlob, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error build.mjs is plain JavaScript with no declaration file.
import { bundleServer, TYPESCRIPT_EXTERNALS } from "../build.mjs";

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

  it("runs every real-editor configuration from the tests tsc emits", () => {
    const loaded = createRequire(__filename)(
      join(extensionRoot, ".vscode-test.cjs"),
    ) as { files: string } | { files: string }[];
    const configs = Array.isArray(loaded) ? loaded : [loaded];
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(config.files.startsWith(`${tscOutDir()}/`), config.files).toBe(
        true,
      );
    }
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

  it("ships every grammar the manifest contributes", () => {
    const { contributes } = JSON.parse(read("package.json")) as {
      contributes: { grammars: { path: string }[] };
    };
    expect(contributes.grammars.length).toBeGreaterThan(1);
    for (const { path } of contributes.grammars) {
      const file = relative(extensionRoot, resolve(extensionRoot, path));
      expect(ships(file), file).toBe(true);
      expect(() => JSON.parse(read(file)), file).not.toThrow();
    }
  });

  it("never bundles TypeScript: the server uses the editor's copy or the project's at run time", async () => {
    const work = mkdtempSync(join(tmpdir(), "bascik-ext-pack-"));
    try {
      const outfile = join(work, "server.js");
      const result = (await bundleServer(outfile)) as {
        metafile: { inputs: Record<string, unknown> };
      };
      const typescriptInputs = Object.keys(result.metafile.inputs).filter(
        (input) => /node_modules[\\/]typescript(?:-\d+)?[\\/]/.test(input),
      );
      expect(typescriptInputs).toEqual([]);
      expect(TYPESCRIPT_EXTERNALS).toEqual(["typescript", "typescript-6"]);
      // TypeScript alone is about 9 MB; the server with its TypeScript support stays well under 1 MB.
      expect(statSync(outfile).size).toBeLessThan(1_000_000);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("lists no runtime dependency, so vsce publish --no-dependencies ships everything it needs", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
  });
});
