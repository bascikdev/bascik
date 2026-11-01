import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
const tsc = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

/** Runs tsc and resolves with its exit code and combined output, never rejecting. */
const runTsc = async (
  args: string[],
): Promise<{ code: number; output: string }> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [tsc, ...args], {
      cwd: pkgRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
};

/**
 * The declarations `yarn pkg:build` emits, typechecked the way a consumer
 * with no @types/node and `skipLibCheck: false` sees them. Every public
 * entry in the exports map must typecheck there: a Node-only global such as
 * `Buffer` reaching a public declaration is a TS2591 error inside
 * node_modules for that user, which in-repo consumers (all `types: ["node"]`,
 * `skipLibCheck: true`) cannot see.
 */
describe("published type declarations", () => {
  let work: string;
  let installed: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "bascik-public-types-"));
    installed = join(work, "node_modules", "@bascik", "bascik");
    await mkdir(installed, { recursive: true });
    await copyFile(
      join(pkgRoot, "package.json"),
      join(installed, "package.json"),
    );
    const emitted = await runTsc([
      "-p",
      "tsconfig.build.json",
      "--emitDeclarationOnly",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
      "--outDir",
      join(installed, "dist"),
      "--declarationDir",
      join(installed, "dist"),
    ]);
    expect(emitted.output).toBe("");
    expect(emitted.code).toBe(0);
    await writeFile(join(work, "package.json"), '{ "type": "module" }\n');
  }, 60_000);

  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  const consumerCheck = async (
    source: string,
    types: string[],
  ): Promise<{ code: number; output: string }> => {
    await writeFile(join(work, "use.ts"), source);
    await writeFile(
      join(work, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types,
        },
        files: ["use.ts"],
      }),
    );
    return runTsc(["-p", join(work, "tsconfig.json")]);
  };

  it("every public entry typechecks without @types/node and with skipLibCheck off", async () => {
    const result = await consumerCheck(
      [
        'import { defineConfig, type BascikConfig } from "@bascik/bascik/config";',
        'import * as root from "@bascik/bascik";',
        'import * as runtime from "@bascik/bascik/runtime";',
        'import * as adapter from "@bascik/bascik/adapter";',
        'import * as html from "@bascik/bascik/html";',
        "const config: BascikConfig = defineConfig({});",
        "export const used = [config, root, runtime, adapter, html];",
        "",
      ].join("\n"),
      [],
    );
    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  }, 60_000);

  // Misuse: a config with a wrong-typed value must still be reported, so
  // the consumer check above is not passing only because nothing resolved.
  it("misuse: a wrong-typed config value is still a type error in that consumer", async () => {
    const result = await consumerCheck(
      [
        'import { defineConfig } from "@bascik/bascik/config";',
        "export default defineConfig({ http: { port: 'eighty' } });",
        "",
      ].join("\n"),
      [],
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/use\.ts\(2,\d+\): error TS2322/);
    expect(result.output).not.toContain("node_modules");
  }, 60_000);
});
