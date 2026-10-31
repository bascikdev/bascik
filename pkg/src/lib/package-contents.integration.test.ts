import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
const srcRoot = join(pkgRoot, "src");
const tsc = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

/**
 * Source files that exist only for tests. tsconfig.build.json must leave
 * every one of them out, or `yarn pkg:build` compiles them into dist/ and
 * `files: ["dist/"]` ships them (deliberately leaky handlers and fixture
 * builders included) to every install.
 */
const TEST_ONLY = [
  /\.test\.ts$/,
  /\.test-helper\.ts$/,
  /\.fixtures?\.ts$/,
  /(^|\/)__fixtures__\//,
  /(^|\/)test-fixtures\//,
  /(^|\/)build-fixtures\.ts$/,
];

describe("files the build compiles into dist/", () => {
  it("leave out every test-only source file", async () => {
    const { stdout } = await run(
      process.execPath,
      [tsc, "-p", "tsconfig.build.json", "--listFilesOnly"],
      { cwd: pkgRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    const inputs = stdout
      .split(/\r?\n/)
      .filter(
        (file) =>
          file.startsWith(srcRoot + sep) || file.startsWith(srcRoot + "/"),
      )
      .map((file) => relative(srcRoot, file).split(sep).join("/"));
    // The listing worked: the CLI entry and the config entry are inputs.
    expect(inputs).toContain("index.ts");
    expect(inputs).toContain("lib/defineConfig.ts");
    const shipped = inputs.filter((file) =>
      TEST_ONLY.some((pattern) => pattern.test(file)),
    );
    expect(shipped).toEqual([]);
  }, 60_000);
});
