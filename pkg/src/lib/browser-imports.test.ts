import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setEsbuildLoaderForTests,
  bundleBrowserImports,
  localModuleImports,
} from "./browser-imports.ts";
import { BascikConfig } from "./config.ts";
import { TypeScriptTransformError } from "./typescript.ts";

vi.mock("./config.ts", () => ({
  BascikConfig: { scripts: { typescript: true } },
}));

type MutableScripts = { typescript?: unknown; importRoot?: string };
const scripts = BascikConfig.scripts as MutableScripts;

let root: string;

const write = async (path: string, text: string): Promise<void> => {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
};

/** Run `code` as a classic script body and return what it assigned to `out`. */
const run = (code: string): unknown => {
  const scope: { out?: unknown } = {};
  new Function("scope", code)(scope);
  return scope.out;
};

beforeEach(async () => {
  // esbuild reports real paths, so the project root is one too.
  root = await realpath(
    await mkdtemp(join(tmpdir(), "bascik-browser-imports-")),
  );
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  __setEsbuildLoaderForTests(undefined);
  scripts.typescript = true;
  scripts.importRoot = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("localModuleImports", () => {
  it("lists relative and @/ specifiers, static and literal dynamic", () => {
    expect(
      localModuleImports(
        [
          `import { a } from "./a.ts";`,
          `import "../b.js";`,
          `import c from "@/lib/c.ts";`,
          `const d = import("./d.ts");`,
          `import e from "/js/e.js";`,
          `import f from "https://example.com/f.js";`,
          `import g from "lit";`,
        ].join("\n"),
      ),
    ).toEqual(["./a.ts", "../b.js", "@/lib/c.ts", "./d.ts"]);
  });

  it("ignores import-shaped text in strings and comments", () => {
    expect(
      localModuleImports(
        `// import x from "./x.ts";\nconst s = 'import y from "./y.ts"';`,
      ),
    ).toEqual([]);
  });
});

describe("bundleBrowserImports", () => {
  it("returns a script with no local import byte for byte", async () => {
    const code = `import x from "/js/x.js";\nconst a = 1; // kept\n`;
    const loader = vi.fn();
    __setEsbuildLoaderForTests(loader);
    await expect(
      bundleBrowserImports(code, { sourceFile: "src/components/c/c.ts" }),
    ).resolves.toEqual({ code, dependencies: [] });
    expect(loader).not.toHaveBeenCalled();
  });

  it("bundles relative TypeScript imports, stripping each file's types", async () => {
    await write(
      "src/components/c/format.ts",
      `import { double } from "./math.ts";\n` +
        `export const label = (n: number): string => \`n=\${double(n)}\`;\n`,
    );
    await write(
      "src/components/c/math.ts",
      `export const double = (n: number): number => n * 2;\n`,
    );
    const { code, dependencies } = await bundleBrowserImports(
      `import { label } from "./format.ts";\nscope.out = label(21);\n`,
      { sourceFile: join(root, "src/components/c/c.ts") },
    );
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toContain(": number");
    expect(run(code)).toBe("n=42");
    expect(dependencies.sort()).toEqual([
      "src/components/c/format.ts",
      "src/components/c/math.ts",
    ]);
  });

  it("resolves @/ against scripts.importRoot", async () => {
    scripts.importRoot = "shared";
    await write("shared/lib/greet.ts", `export const greet = () => "hi";\n`);
    const { code, dependencies } = await bundleBrowserImports(
      `import { greet } from "@/lib/greet.ts";\nscope.out = greet();\n`,
      { sourceFile: "src/pages/index.html", inline: true },
    );
    expect(run(code)).toBe("hi");
    expect(dependencies).toEqual(["shared/lib/greet.ts"]);
  });

  it("keeps URL, site-path and package imports as written", async () => {
    await write("src/c/util.js", `export const u = 1;\n`);
    const { code } = await bundleBrowserImports(
      `import { u } from "./util.js";\nimport x from "/js/x.js";\nimport y from "https://example.com/y.js";\nimport z from "lit";\nconsole.log(u, x, y, z);\n`,
      { sourceFile: "src/c/c.ts" },
    );
    expect(code).toContain(`from "/js/x.js"`);
    expect(code).toContain(`from "https://example.com/y.js"`);
    expect(code).toContain(`from "lit"`);
    expect(code).not.toContain("./util.js");
  });

  it("wraps a page's classic script so bundled names stay out of the global scope", async () => {
    await write("src/c/n.ts", `export const n = 7;\n`);
    const { code } = await bundleBrowserImports(
      `import { n } from "./n.ts";\nscope.out = n;\n`,
      { sourceFile: "src/c/c.ts", wrap: true },
    );
    expect(code.startsWith("(() => {\n")).toBe(true);
    expect(code.endsWith("})();\n")).toBe(true);
    expect(run(code)).toBe(7);
  });

  it("leaves a bundle that still imports a URL unwrapped, for the classic-script check", async () => {
    await write("src/c/n.ts", `export const n = 7;\n`);
    const { code } = await bundleBrowserImports(
      `import { n } from "./n.ts";\nimport x from "/js/x.js";\nconsole.log(n, x);\n`,
      { sourceFile: "src/c/c.ts", wrap: true },
    );
    expect(code.startsWith("(() =>")).toBe(false);
    expect(code).toContain(`from "/js/x.js"`);
  });

  it("does not let an imported string end the inline <script>", async () => {
    await write("src/c/markup.ts", `export const tag = "</script>";\n`);
    const { code } = await bundleBrowserImports(
      `import { tag } from "./markup.ts";\nscope.out = tag;\n`,
      { sourceFile: "src/c/c.ts" },
    );
    expect(code).not.toMatch(/<\/script/i);
    expect(run(code)).toBe("</script>");
  });

  it("fails naming the script, line and specifier when a file is missing", async () => {
    const error = await bundleBrowserImports(
      `const a = 1;\nimport { b } from "./missing.ts";\n`,
      { sourceFile: "src/components/c/c.ts" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeScriptTransformError);
    expect((error as Error).message).toContain(`"src/components/c/c.ts"`);
    expect((error as Error).message).toContain("src/components/c/c.ts:2:");
    expect((error as Error).message).toContain("./missing.ts");
  });

  it("names the line within an inline block", async () => {
    const error = await bundleBrowserImports(
      `\nimport { b } from "./missing.ts";\n`,
      { sourceFile: "src/components/c/c.html", inline: true },
    ).catch((e: unknown) => e);
    expect((error as Error).message).toContain(
      `the <script type="text/typescript"> in "src/components/c/c.html"`,
    );
    expect((error as Error).message).toContain("line 2 of the script");
  });

  it("passes on the strip error of an imported file", async () => {
    await write("src/c/bad.ts", `export enum Mode { A }\n`);
    const error = await bundleBrowserImports(
      `import { Mode } from "./bad.ts";\nconsole.log(Mode);\n`,
      { sourceFile: "src/c/c.ts" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeScriptTransformError);
    expect((error as Error).message).toContain("src/c/bad.ts");
  });

  it("refuses a local import that is not a script", async () => {
    await write("src/c/data.json", `{"a":1}`);
    const error = await bundleBrowserImports(
      `import data from "./data.json";\nconsole.log(data);\n`,
      { sourceFile: "src/c/c.ts" },
    ).catch((e: unknown) => e);
    expect((error as Error).message).toContain(
      "is not a JavaScript or TypeScript file",
    );
  });

  it("says how to install esbuild when it is missing", async () => {
    __setEsbuildLoaderForTests(async () => undefined);
    const error = await bundleBrowserImports(`import { a } from "./a.ts";\n`, {
      sourceFile: "src/c/c.ts",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeScriptTransformError);
    expect((error as Error).message).toContain(`"./a.ts"`);
    expect((error as Error).message).toContain(
      "npm install --save-dev esbuild",
    );
  });

  it("uses a custom scripts.typescript compiler for imported files", async () => {
    const compiler = vi.fn(async (code: string) =>
      code.replace(": number", ""),
    );
    scripts.typescript = compiler;
    await write("src/c/n.ts", `export const n: number = 5;\n`);
    const { code } = await bundleBrowserImports(
      `import { n } from "./n.ts";\nscope.out = n;\n`,
      { sourceFile: "src/c/c.ts" },
    );
    expect(run(code)).toBe(5);
    expect(compiler).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sourcePath: "src/c/n.ts" }),
    );
  });
});
