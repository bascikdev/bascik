/**
 * Prompt 157 remeasure: `bascik --server` loads only what serving needs.
 *
 * The prod server reads `dist/.bascik/components.json` and renders component
 * tags at request time, but it never builds a manifest. Reaching the
 * manifest builder from the server pulled the whole build pipeline (build
 * scripts, the scoping recorder, the minifiers, the stylesheet pipeline) into
 * every server boot, which measured +13 ms to the first page on pkg/e2e.
 * The graph is read from the sources, so a new static import that brings the
 * builder back fails here, naming the chain that reaches it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = dirname(fileURLToPath(import.meta.url));

/** Specifiers of the runtime (non type-only) static imports and re-exports in `source`. */
const runtimeSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  const re =
    /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gms;
  for (const m of source.matchAll(re)) {
    if (m[5]) {
      out.push(m[5]);
      continue;
    }
    if (m[2]) continue; // `import type` / `export type`
    const clause = m[3].trim();
    const braced = /^\{([\s\S]*)\}$/.exec(clause);
    if (braced) {
      const names = braced[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // `import { type A, type B } from` is erased like `import type`.
      if (names.length > 0 && names.every((n) => n.startsWith("type ")))
        continue;
    }
    out.push(m[4]);
  }
  return out;
};

/** Every lib module the entry reaches, with the importer that first reached it. */
const reach = (entry: string): Map<string, string | null> => {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (!target.endsWith(".ts") || !existsSync(target)) continue;
      if (parent.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return parent;
};

const chain = (graph: Map<string, string | null>, file: string): string => {
  const names: string[] = [];
  for (let at: string | null | undefined = file; at; at = graph.get(at))
    names.push(relative(LIB, at));
  return names.join(" <- ");
};

/** Modules that only building a site needs. */
const BUILD_ONLY = [
  "component-manifest.ts",
  "build-scripts.ts",
  "scoping-template.ts",
  "page-minification.ts",
  "styles.ts",
  "ordered-output.ts",
];

describe("prod server module graph (prompt 157)", () => {
  it("reads the component manifest without loading the manifest builder or the build pipeline", () => {
    const graph = reach(resolve(LIB, "server-prod.ts"));
    // The reader itself is reached: the server does load the manifest.
    expect(graph.has(resolve(LIB, "component-manifest-file.ts"))).toBe(true);
    const reached = BUILD_ONLY.map((name) => resolve(LIB, name))
      .filter((file) => graph.has(file))
      .map((file) => chain(graph, file));
    expect(reached).toEqual([]);
  });

  it("still reaches the request-time renderer", () => {
    const graph = reach(resolve(LIB, "server-prod.ts"));
    expect(graph.has(resolve(LIB, "request-render.ts"))).toBe(true);
    expect(graph.has(resolve(LIB, "request-render-node.ts"))).toBe(true);
  });

  it("misuse: treats a mixed import with one runtime name as a runtime import", () => {
    expect(runtimeSpecifiers(`import { type A, b } from "./x.ts";\n`)).toEqual([
      "./x.ts",
    ]);
    expect(
      runtimeSpecifiers(
        `import type { A } from "./t.ts";\nimport { type B } from "./u.ts";\n`,
      ),
    ).toEqual([]);
    expect(runtimeSpecifiers(`export { c } from "./re.ts";\n`)).toEqual([
      "./re.ts",
    ]);
  });
});
