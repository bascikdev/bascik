import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOCS_FIXTURE_SIBLING_DIRECTORIES,
  DOCS_FIXTURE_SIBLING_FILES,
} from "../../bench/docs-fixture-files.ts";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Every repository-relative path `docs/bascik.config.ts` names above `docs/`
 * (`"../<path>"`). The config lists them as `pipeline.watchPaths` and as exec
 * script inputs; the compiler rejects a config whose paths do not exist, so a
 * docs fixture must carry each one.
 */
const docsConfigSiblingPaths = (): string[] => {
  const source = readFileSync(
    join(repository, "docs/bascik.config.ts"),
    "utf8",
  );
  const paths = new Set<string>();
  for (const match of source.matchAll(/["'](\.\.\/[^"'\n]+)["']/g)) {
    paths.add(normalize(match[1]).replace(/^\.\.\//, ""));
  }
  return [...paths].sort();
};

describe("docs benchmark fixture sibling files", () => {
  it("names a repository file or directory the docs config reads above docs/", () => {
    const covered = (path: string): boolean =>
      DOCS_FIXTURE_SIBLING_FILES.includes(path) ||
      DOCS_FIXTURE_SIBLING_DIRECTORIES.some(
        (dir) => path === dir || path.startsWith(`${dir}/`),
      );
    const paths = docsConfigSiblingPaths();
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((path) => !covered(path));
    expect(
      missing,
      `docs/bascik.config.ts reads these above docs/, but pkg/bench/docs-fixture-files.ts does not copy them into a docs benchmark fixture`,
    ).toEqual([]);
  });

  it("lists only paths that exist in this repository", () => {
    for (const path of [
      ...DOCS_FIXTURE_SIBLING_FILES,
      ...DOCS_FIXTURE_SIBLING_DIRECTORIES,
    ]) {
      expect(() => readFileSync(join(repository, path)), path).not.toThrow(
        /ENOENT/,
      );
    }
  });
});
