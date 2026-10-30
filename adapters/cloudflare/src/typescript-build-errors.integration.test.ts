/**
 * A TypeScript mistake in a server or stream script fails the build with the
 * same located message on Node (`bascik --build`) and for the Cloudflare
 * Worker (`bascik --build --target cloudflare-workers`).
 *
 * Each case is a REAL build of a small temp project, once per host. Both
 * builds must fail, and the `[bascik]` error line (file, line, column and
 * reason) must be the same text, so a reader who deploys to Cloudflare sees
 * the error they saw locally, never a bundler's staging path.
 *
 * Misuse lens: an `enum` (non-erasable), a plain syntax error the strip
 * rejects, a redeclared binding the strip lets through (an early error only
 * a module parse finds), each inline and as a `.ts` `src=` module.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const cliPath = join(repoRoot, "pkg/dist/index.js");

const page = (body: string): string =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>Typed</title>\n</head>\n<body>\n  <main>\n${body}\n  </main>\n</body>\n</html>\n`;

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const project = async (files: Record<string, string>): Promise<string> => {
  const root = join(
    tmpdir(),
    `bascik-cf-ts-errors-${process.pid}-${Date.now()}-${roots.length}`,
  );
  roots.push(root);
  await mkdir(join(root, "node_modules/@bascik"), { recursive: true });
  await symlink(
    resolve(here, ".."),
    join(root, "node_modules/@bascik/adapter-cloudflare"),
    "dir",
  );
  await symlink(
    join(repoRoot, "pkg"),
    join(root, "node_modules/@bascik/bascik"),
    "dir",
  );
  const all: Record<string, string> = {
    "bascik.config.js": `export default { generate: { sitemap: false, robots: false } };\n`,
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
};

const build = async (
  root: string,
  target?: string,
): Promise<{ failed: boolean; output: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "--build", ...(target ? ["--target", target] : [])],
      {
        cwd: root,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        timeout: 120_000,
      },
    );
    return { failed: false, output: `${stdout}${stderr}` };
  } catch (err: any) {
    return {
      failed: true,
      output: `${err.stdout ?? ""}${err.stderr ?? err.message}`,
    };
  }
};

/** The `[bascik] ...` error line and the code frame under it. */
const errorOf = (output: string): string => {
  const lines = output.split("\n");
  const start = lines.findIndex((line) =>
    /\[bascik\] (TypeScript transformation failed|Syntax error)/.test(line),
  );
  if (start < 0) return `(no [bascik] error line)\n${output}`;
  const frame = lines.slice(start + 1, start + 3).filter((l) => / \| /.test(l));
  return [lines[start].trim(), ...frame].join("\n");
};

const CASES: Array<{
  name: string;
  files: Record<string, string>;
  at: string;
  reason: string;
}> = [
  {
    name: "an enum in an inline server script",
    files: {
      "src/pages/index.html": page(
        `    <script data-bascik-server type="text/typescript">\n      enum Mode { A }\n      export default (): string => String(Mode.A);\n    </script>`,
      ),
    },
    at: "src/pages/index.html:9:7",
    reason: "enum",
  },
  {
    name: "a syntax error in an inline stream script",
    files: {
      "src/pages/index.html": page(
        `    <script data-bascik-stream type="text/typescript">\n      const n: number = 1;\n      const oops = (;\n      export default async (): Promise<string> => String(n);\n    </script>`,
      ),
    },
    at: "src/pages/index.html:10:21",
    reason: "Expression expected",
  },
  {
    name: "a redeclared binding in an inline server script",
    files: {
      "src/pages/index.html": page(
        `    <script data-bascik-server type="text/typescript">\n      let count: number = 1;\n      let count = 2;\n      export default (): string => String(count);\n    </script>`,
      ),
    },
    at: "src/pages/index.html:10:11",
    reason: "Identifier 'count' has already been declared",
  },
  {
    name: "a redeclared binding in a stream script's .ts src",
    files: {
      "src/pages/index.html": page(
        `    <script data-bascik-stream src="@/lib/stream.ts"></script>`,
      ),
      "src/lib/stream.ts": `const label: string = "x";\nconst label = "y";\nexport default async (): Promise<string> => label;\n`,
    },
    at: "src/lib/stream.ts:2:7",
    reason: "Identifier 'label' has already been declared",
  },
];

describe("TypeScript mistakes in server and stream scripts: the same build error on Node and Cloudflare", () => {
  it.each(CASES)(
    "$name",
    async ({ files, at, reason }) => {
      const root = await project(files);
      const node = await build(root);
      const cf = await build(root, "cloudflare-workers");
      expect(node.failed, node.output).toBe(true);
      expect(cf.failed, cf.output).toBe(true);
      const nodeError = errorOf(node.output);
      expect(nodeError).toContain(at);
      expect(nodeError).toContain(reason);
      expect(errorOf(cf.output)).toBe(nodeError);
      expect(cf.output).not.toContain(".staging");
    },
    240_000,
  );
});
