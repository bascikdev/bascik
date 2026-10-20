// Every file a docs page reads at build time must be watched in dev, or editing it never re-renders the page.
// Bascik watches directory.pages, directory.components, and pipeline.watchPaths; the import root is not
// watched for build-time inputs. This test finds the files the docs read and checks that one of those covers each.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../bascik.config.ts";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const listFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });

// A quoted path the build reads from the docs project root, such as "../CHANGELOG.md" or "content/x.md".
const DATA_PATH_RE =
  /(?<!from\s|import\()["'`]((?:\.\.\/)+[\w@.[\]/-]+\.(?:md|json|svg|ts|css|txt|html|ya?ml|csv))["'`]/g;
const EXAMPLE_FILE_RE = /<!-- example:file (\S+) -->/g;

const readInputs = (): Map<string, string> => {
  const inputs = new Map<string, string>();
  const sources = listFiles(join(docsRoot, "src")).filter(
    (file) => /\.(html|ts)$/.test(file) && !/\.test\.ts$/.test(file),
  );
  for (const file of sources) {
    for (const [, path] of readFileSync(file, "utf8").matchAll(DATA_PATH_RE)) {
      inputs.set(resolve(docsRoot, path), relative(docsRoot, file));
    }
  }
  for (const file of listFiles(join(docsRoot, "content"))) {
    if (!file.endsWith(".md")) continue;
    for (const [, path] of readFileSync(file, "utf8").matchAll(
      EXAMPLE_FILE_RE,
    )) {
      inputs.set(
        resolve(docsRoot, "../examples", path),
        relative(docsRoot, file),
      );
    }
  }
  return inputs;
};

const watchedRoots = (): string[] =>
  [
    "src/pages",
    ...(config.directory?.components ?? []),
    ...(config.pipeline?.watchPaths ?? []),
  ].map((path) => resolve(docsRoot, path));

const isWatched = (file: string, roots: string[]): boolean =>
  roots.some((root) => file === root || file.startsWith(root + sep));

describe("docs dev watch coverage", () => {
  it("finds the files outside the docs project that pages read", () => {
    const inputs = [...readInputs().keys()].map((file) =>
      relative(docsRoot, file),
    );
    expect(inputs).toEqual(
      expect.arrayContaining([
        "../CHANGELOG.md",
        "../pkg/package.json",
        "../examples/starter-site/src/api/contact.ts",
      ]),
    );
  });

  it("watches every file a docs page reads at build time", () => {
    const roots = watchedRoots();
    const unwatched = [...readInputs()]
      .filter(([file]) => !isWatched(file, roots))
      .map(
        ([file, readBy]) => `${relative(docsRoot, file)} (read by ${readBy})`,
      );
    expect(unwatched).toEqual([]);
  });
});
