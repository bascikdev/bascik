import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DOCS_DIR } from "./content-path.ts";
import { readDemoBlock } from "./md-renderer.ts";

/** Every extractDemoBlock()/readDemoBlock() call with literal arguments in the page shells and components. */
async function demoBlockCalls(): Promise<
  { source: string; line: number; file: string; marker: string }[]
> {
  const calls: {
    source: string;
    line: number;
    file: string;
    marker: string;
  }[] = [];
  for (const folder of ["src/pages", "src/components"]) {
    const dir = join(DOCS_DIR, folder);
    for (const name of await readdir(dir, { recursive: true })) {
      if (!/\.(html|ts)$/.test(name) || name.endsWith(".test.ts")) continue;
      const path = join(dir, name);
      const text = await readFile(path, "utf8");
      for (const call of text.matchAll(
        /\b(?:extractDemoBlock|readDemoBlock)\(\s*(["'])([^"']+)\1\s*,\s*(["'])([^"']+)\3/g,
      )) {
        calls.push({
          source: relative(DOCS_DIR, path),
          line: text.slice(0, call.index).split("\n").length,
          file: call[2],
          marker: call[4],
        });
      }
    }
  }
  return calls;
}

describe("demo blocks named in page shells and components", () => {
  // A typo in a marker id, or a marker renamed in the Markdown, used to ship a page whose tab showed an
  // empty code block while the build reported success.
  it("all exist, each with a fenced code block after its marker", async () => {
    const calls = await demoBlockCalls();
    expect(calls.length).toBeGreaterThan(150);
    const missing: string[] = [];
    for (const call of calls) {
      const block = await readDemoBlock(join(DOCS_DIR, call.file), call.marker);
      if (block.code === undefined)
        missing.push(
          `${call.source}:${call.line} demo:${call.marker} in ${call.file}: ${block.problem}`,
        );
    }
    expect(missing).toEqual([]);
  });
});
