// Every file a docs page reads at build time must be watched in dev, or editing it never re-renders the page.
// Bascik watches directory.pages, directory.components, and pipeline.watchPaths; the import root is not
// watched for build-time inputs. This test finds the files the docs read and checks that one of those covers each.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// A watched exec script reruns only for edits its own `watch` list matches (pipeline.watchPaths re-renders pages
// but never reruns a script). So every docs module a script imports, and every other source file it reads, must
// be in that list, or editing it in dev leaves the script's output stale until the server restarts.
const LOCAL_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** The local modules a script imports, directly or through other local modules, not counting itself. */
const importedModules = (script: string): string[] => {
  const seen = new Set<string>();
  const pending = [resolve(docsRoot, script)];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    // A type-only import is erased at run time, so a change to that module cannot change the output.
    const code = readFileSync(file, "utf8").replace(
      /\b(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["']/g,
      "",
    );
    for (const [, specifier] of code.matchAll(LOCAL_IMPORT_RE)) {
      let target = resolve(dirname(file), specifier);
      if (!existsSync(target) && target.endsWith(".js"))
        target = target.replace(/\.js$/, ".ts");
      if (existsSync(target) && /\.(?:ts|mjs|js)$/.test(target))
        pending.push(target);
    }
  }
  seen.delete(resolve(docsRoot, script));
  return [...seen];
};

/** Source files a watched exec script reads without importing them (each must appear in its module graph). */
const EXEC_SCRIPT_READS: Record<string, string[]> = {
  // The Home result's title and description come from the Home page's <title> and <meta name="description">.
  "scripts/generate-search-index.ts": ["src/pages/index.html"],
};

const watchedExecEntries = () =>
  (config.pipeline?.exec ?? []).filter(
    (entry): entry is typeof entry & { watch: string[] } =>
      Array.isArray(entry.watch) && entry.watch.length > 0,
  );

const covers = (patterns: string[], file: string): boolean =>
  isWatched(
    file,
    patterns.map((pattern) =>
      resolve(docsRoot, pattern.replace(/\/?\*\*.*$/, "").replace(/\/$/, "")),
    ),
  );

describe("docs dev exec watch coverage", () => {
  it("finds the modules the search index script imports", () => {
    expect(
      importedModules("scripts/generate-search-index.ts").map((file) =>
        relative(docsRoot, file),
      ),
    ).toEqual(
      expect.arrayContaining(["src/lib/search-index.ts", "src/lib/nav.ts"]),
    );
  });

  it("reruns each watched exec script when a docs module it imports changes", () => {
    const unwatched = watchedExecEntries().flatMap((entry) =>
      importedModules(entry.script)
        .filter((file) => !covers(entry.watch, file))
        .map((file) => `${entry.script} imports ${relative(docsRoot, file)}`),
    );
    expect(unwatched).toEqual([]);
  });

  it("reruns each watched exec script when a source file it reads changes", () => {
    const unwatched: string[] = [];
    for (const [script, reads] of Object.entries(EXEC_SCRIPT_READS)) {
      const entry = watchedExecEntries().find((item) => item.script === script);
      expect(entry, `${script} is a watched exec entry`).toBeDefined();
      const sources = [resolve(docsRoot, script), ...importedModules(script)]
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
      for (const read of reads) {
        // A stale entry here would hide a real input the script stopped or started reading.
        expect(sources, `${script} reads ${read}`).toContain(read);
        if (!covers(entry!.watch, resolve(docsRoot, read)))
          unwatched.push(`${script} reads ${read}`);
      }
    }
    expect(unwatched).toEqual([]);
  });
});
