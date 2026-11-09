import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// WHY (finding 16, 132): importing the adapter contract used to evaluate the
// working directory's bascik.config through a module-scope await in
// userConfig.ts. So `require("@bascik/bascik/adapter")` failed with
// ERR_REQUIRE_ASYNC_MODULE, a broken config made the library import itself
// reject, a config's side effects ran on a bare import, and
// `bascik-netlify-install --config <missing>` died with an uncaught stack
// before its own try/catch ran. The contract must load the config only when
// something reads it (readSiteGraph without explicit options), and then
// surface the loader's located `[bascik]` error from that call.
const adapterEntry = fileURLToPath(new URL("../adapter.ts", import.meta.url));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A scratch project whose cwd holds `config` as bascik.config.ts. */
const projectWithConfig = async (config: string): Promise<string> => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bascik-adapter-entry-")),
  );
  roots.push(root);
  await writeFile(join(root, "bascik.config.ts"), config);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "site", type: "module" }),
  );
  return root;
};

const runNode = (cwd: string, args: string[]) =>
  spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

const BROKEN_CONFIG =
  'import { defineConfig } from "@bascik/bascik/config";\nexport default defineConfig({ base: "/x/" \n';

describe("@bascik/bascik/adapter loads bascik.config lazily", () => {
  it("can be require()d from CommonJS with a broken bascik.config in cwd", async () => {
    const root = await projectWithConfig(BROKEN_CONFIG);
    const result = runNode(root, [
      "-e",
      `const a = require(${JSON.stringify(adapterEntry)});
       console.log("exports:" + ["defineAdapter","readSiteGraph","pageAliasesFor","detectPublicCollisions","isPublicAssetPath","splitDistPageIntoSegments","resolveAdapterProjectPaths","resolvePlatformCli","availableDevPort"].map((n) => typeof a[n]).join(","));`,
    ]);
    expect(result.stderr).not.toContain("ERR_REQUIRE_ASYNC_MODULE");
    expect(result.stderr).not.toContain("Failed to load bascik.config");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `exports:${Array(9).fill("function").join(",")}`,
    );
  });

  it("can be imported as ESM with a broken bascik.config in cwd", async () => {
    const root = await projectWithConfig(BROKEN_CONFIG);
    const result = runNode(root, [
      "--input-type=module",
      "-e",
      `const a = await import(${JSON.stringify(adapterEntry)});
       console.log("aliases:" + a.pageAliasesFor("/books", "/").join(" "));`,
    ]);
    expect(result.stderr).not.toContain("Failed to load bascik.config");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("aliases:/books /books/ /books.html");
  });

  it("does not evaluate bascik.config on import", async () => {
    const root = await projectWithConfig(
      'console.log("CONFIG FILE EVALUATED");\nexport default {};\n',
    );
    for (const args of [
      ["-e", `require(${JSON.stringify(adapterEntry)});`],
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(adapterEntry)});`,
      ],
    ]) {
      const result = runNode(root, args);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("CONFIG FILE EVALUATED");
    }
  });

  it("misuse: readSiteGraph with a broken config rejects with the located config error, catchable by the caller", async () => {
    const root = await projectWithConfig(BROKEN_CONFIG);
    await mkdir(join(root, "dist"), { recursive: true });
    const result = runNode(root, [
      "--input-type=module",
      "-e",
      `const a = await import(${JSON.stringify(adapterEntry)});
       try {
         await a.readSiteGraph({ projectRoot: process.cwd(), distDir: "dist", version: "1" });
         console.log("NO ERROR");
       } catch (error) {
         console.log("CAUGHT:" + error.message.split("\\n")[0]);
       }`,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `CAUGHT:[bascik] Failed to load bascik.config (${join(root, "bascik.config.ts")})`,
    );
  });

  it("misuse: a --config path that does not exist rejects from readSiteGraph, not at import", async () => {
    const root = await projectWithConfig("export default {};\n");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "read-graph.mjs"),
      `const a = await import(${JSON.stringify(adapterEntry)});
       console.log("IMPORTED");
       try {
         await a.readSiteGraph({ projectRoot: process.cwd(), distDir: "dist", version: "1" });
         console.log("NO ERROR");
       } catch (error) {
         console.log("CAUGHT:" + error.message.split("\\n")[0]);
       }`,
    );
    const result = runNode(root, [
      "read-graph.mjs",
      "--config",
      "nope.config.ts",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("IMPORTED");
    expect(result.stdout).toMatch(
      /CAUGHT:\[bascik\] error: --config "[^"]*nope\.config\.ts" does not exist\./,
    );
  });
});
