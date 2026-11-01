/**
 * A rewritten module runs in a real Node.js process: Vitest's own loader accepts URLs that
 * Node's ESM loader rejects, so the specifier rewrite is checked outside it.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteModuleSpecifiers } from "./module-specifiers.ts";

describe("rewriteModuleSpecifiers in Node.js", () => {
  it.each(["./render.mjs?v=2", "./render.mjs#frag", "@/render.mjs?x=1"])(
    "keeps a module that imports %s loadable (F043)",
    (specifier) => {
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), "bascik-spec-query-")),
      );
      try {
        writeFileSync(
          join(dir, "render.mjs"),
          "export const render = () => 'ok';\n",
        );
        const entry = join(dir, "entry.mjs");
        writeFileSync(
          entry,
          rewriteModuleSpecifiers(
            `import { render } from "${specifier}";\nconsole.log(render());\n`,
            dir,
            { importRoot: dir },
          ),
        );
        const run = spawnSync(process.execPath, [entry], { encoding: "utf8" });
        expect(run.stderr).toBe("");
        expect(run.stdout.trim()).toBe("ok");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
