/**
 * Every identifier a docs page imports from `@bascik/bascik/runtime` is a
 * real export of that entry point (pkg/src/runtime.ts and the modules it
 * re-exports). A tutorial that imports a function the package does not have
 * (`handleRequest`, once) fails the reader at the first build, so the page
 * is pinned against the source, values and types alike.
 *
 * Misuse lens: a named import, a renamed one (`a as b`), a type-only import,
 * a default or namespace import (the entry point has no default export), and
 * a page that imports nothing from the runtime at all.
 */
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DOCS_ROOT = path.resolve(import.meta.dirname, "../..");
const PKG_SRC = path.resolve(DOCS_ROOT, "../pkg/src");
const RUNTIME_ENTRY = path.join(PKG_SRC, "runtime.ts");
const SPECIFIER = "@bascik/bascik/runtime";

/** Names a module exports, following `export *` and `export { } from`. */
const moduleExports = async (
  file: string,
  seen = new Set<string>(),
): Promise<Set<string>> => {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    names.add(match[1]);
  for (const match of source.matchAll(
    /^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/gm,
  )) {
    for (const part of match[1].split(",")) {
      const spec = part.trim().replace(/^type\s+/, "");
      if (!spec) continue;
      const exported = spec
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      names.add(exported);
    }
  }
  for (const match of source.matchAll(
    /^export\s+\*\s+from\s+["'](\.[^"']+)["']/gm,
  )) {
    const target = path.resolve(path.dirname(file), match[1]);
    for (const name of await moduleExports(target, seen)) names.add(name);
  }
  return names;
};

interface RuntimeImport {
  file: string;
  /** The name as the runtime must export it; "default" or "*" for those forms. */
  name: string;
  statement: string;
}

/** Every import from the runtime in a page's fenced code blocks. */
const runtimeImports = (file: string, content: string): RuntimeImport[] => {
  const found: RuntimeImport[] = [];
  const importRe = new RegExp(
    // The clause holds no quote or semicolon, so one match never spans
    // two statements.
    "\\bimport\\s+(type\\s+)?([^;\"'`]*?)\\s+from\\s+[\"']" +
      // Every regex metacharacter, not only the "/" and "." this specifier
      // has today, so a renamed one cannot widen the match.
      SPECIFIER.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&") +
      String.raw`["']`,
    "g",
  );
  for (const block of content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const match of block[1].matchAll(importRe)) {
      const clause = match[2].trim();
      const statement = match[0];
      const named = /\{([\s\S]*)\}/.exec(clause);
      const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ");
      if (/\*\s+as\s+/.test(outside))
        found.push({ file, name: "*", statement });
      else if (outside.trim()) found.push({ file, name: "default", statement });
      if (named) {
        for (const part of named[1].split(",")) {
          const spec = part.trim().replace(/^type\s+/, "");
          if (!spec) continue;
          found.push({
            file,
            name: spec.split(/\s+as\s+/)[0].trim(),
            statement,
          });
        }
      }
    }
  }
  return found;
};

/** `content` without its fenced code blocks. */
const withoutFences = (content: string): string =>
  content.replace(/```[^\n]*\n[\s\S]*?```/g, "");

/**
 * The identifiers the Exports column of the "Reference: Portable Runtime"
 * table names in inline code: `wrapRunner(run, plan, host)` names
 * `wrapRunner`, `ExecutionPlan` names itself.
 */
const referenceTableNames = (content: string): string[] => {
  const section =
    /^## Reference: Portable Runtime[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(
      content,
    )?.[1] ?? "";
  const names: string[] = [];
  for (const row of section.matchAll(/^\|[^|\n]*\|([^\n]*)\|\s*$/gm)) {
    for (const code of row[1].matchAll(/`([^`\n]+)`/g)) {
      const name = /^[A-Za-z_$][\w$]*/.exec(code[1])?.[0];
      if (name) names.push(name);
    }
  }
  return names;
};

/** Every `name(` called inside inline code in prose (not property calls). */
const proseCalls = (content: string): string[] => {
  const names: string[] = [];
  for (const code of withoutFences(content).matchAll(/`([^`\n]+)`/g))
    for (const call of code[1].matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\(/g))
      names.push(call[1]);
  return names;
};

const markdownFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

describe("docs imports from @bascik/bascik/runtime", () => {
  it("the export scan sees the runtime's real exports and not a made-up one", async () => {
    const exports = await moduleExports(RUNTIME_ENTRY);
    // Values and types from several re-exported modules.
    for (const name of [
      "wrapRunner",
      "composeBufferedResponse",
      "streamComposedResponse",
      "applyOutputScope",
      "decodeOutputScope",
      "RenderHost",
      "ExecutionPlan",
      "ScriptJobRunner",
    ])
      expect(exports, name).toContain(name);
    expect(exports).not.toContain("handleRequest");
    expect(exports).not.toContain("default");
  });

  it("the import scan reads named, renamed, type-only, default and namespace imports", () => {
    const sample = [
      "```ts",
      `import { a, b as c, type D } from "${SPECIFIER}";`,
      `import type { E } from '${SPECIFIER}';`,
      `import runtime from "${SPECIFIER}";`,
      `import * as all from "${SPECIFIER}";`,
      `import { other } from "@bascik/bascik/adapter";`,
      "```",
    ].join("\n");
    expect(runtimeImports("x.md", sample).map((i) => i.name)).toEqual([
      "a",
      "b",
      "D",
      "E",
      "default",
      "*",
    ]);
  });

  it("custom-adapters.md imports from the runtime, and every name it imports is a real export", async () => {
    const exports = await moduleExports(RUNTIME_ENTRY);
    const page = path.join(DOCS_ROOT, "content/deployment/custom-adapters.md");
    const imports = runtimeImports(page, await readFile(page, "utf8"));
    expect(
      imports.length,
      "the tutorial's runtime entry point imports from the runtime",
    ).toBeGreaterThan(0);
    const missing = imports
      .filter((i) => (i.name === "*" ? false : !exports.has(i.name)))
      .map((i) => `${i.name} (${i.statement.replace(/\s+/g, " ")})`);
    expect(missing).toEqual([]);
  });

  it("the reference-table and prose scans read inline code and skip fenced code", () => {
    const sample = [
      "## Reference: Portable Runtime (`x`)",
      "",
      "| Area | Exports |",
      "| :--- | :------ |",
      "| Pages | `handleRequest(request, env)`, the `ExecutionPlan` type. |",
      "",
      "Call `wrapRunner(run, plan, host)` and `path.join(a)` here.",
      "",
      "```ts",
      "fencedOnly(1);",
      "```",
      "",
      "## Next",
      "",
      "| Area | Exports |",
      "| `notInTheSection()` | |",
    ].join("\n");
    expect(referenceTableNames(sample)).toEqual([
      "handleRequest",
      "ExecutionPlan",
    ]);
    expect(proseCalls(sample)).toEqual([
      "handleRequest",
      "wrapRunner",
      "notInTheSection",
    ]);
  });

  it("misuse: every name the Portable Runtime reference table lists is a real export", async () => {
    const exports = await moduleExports(RUNTIME_ENTRY);
    const page = path.join(DOCS_ROOT, "content/deployment/custom-adapters.md");
    const names = referenceTableNames(await readFile(page, "utf8"));
    expect(names.length, "the table lists the runtime's parts").toBeGreaterThan(
      20,
    );
    expect(names.filter((name) => !exports.has(name))).toEqual([]);
  });

  it("misuse: every function custom-adapters.md calls in inline prose code is a runtime export or a named non-runtime function", async () => {
    const exports = await moduleExports(RUNTIME_ENTRY);
    // Functions the prose names that are not the runtime's, each with where
    // it comes from, so a new one is a decision rather than a pass.
    const notRuntime = new Map([
      ["join", "node:path, in the tutorial's build"],
    ]);
    const page = path.join(DOCS_ROOT, "content/deployment/custom-adapters.md");
    const unknown = proseCalls(await readFile(page, "utf8")).filter(
      (name) => !exports.has(name) && !notRuntime.has(name),
    );
    expect(unknown).toEqual([]);
  });

  it("no docs page or skill imports a name the runtime does not export", async () => {
    const exports = await moduleExports(RUNTIME_ENTRY);
    const files = [
      ...(await markdownFiles(path.join(DOCS_ROOT, "content"))),
      ...(await markdownFiles(path.resolve(DOCS_ROOT, "../skills"))),
    ];
    const missing: string[] = [];
    for (const file of files) {
      for (const i of runtimeImports(file, await readFile(file, "utf8"))) {
        if (i.name !== "*" && !exports.has(i.name))
          missing.push(`${path.relative(DOCS_ROOT, file)}: ${i.name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
