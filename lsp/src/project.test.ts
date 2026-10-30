import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  CONFIG_FILE_CANDIDATES,
  readConfigSource,
  resolveComponentRoots,
} from "./project.js";

describe("resolveComponentRoots", () => {
  const workRoot = path.resolve("/work").replace(/\\/g, "/");

  it("resolves roots against the workspace with forward slashes and no trailing slash", () => {
    expect(
      resolveComponentRoots("/work", ["src/components/", "shared"]),
    ).toEqual([`${workRoot}/src/components`, `${workRoot}/shared`]);
  });

  it("runs in linear time on a long slash run that does not end the root", () => {
    // Backslashes survive POSIX `path.resolve` and become a slash run; the old
    // `/\/+$/` trim was quadratic on it.
    const root = `a${"\\".repeat(50_000)}b`;
    const start = performance.now();
    const [resolved] = resolveComponentRoots("/work", [root]);
    expect(performance.now() - start).toBeLessThan(250);
    expect(resolved).toMatch(new RegExp(`^${workRoot}/a/+b$`));
  });
});

describe("readConfigSource", () => {
  const withConfigs = async (
    files: Record<string, string>,
    run: (root: string) => Promise<void>,
  ) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bascik-lsp-cfg-"));
    try {
      for (const [name, body] of Object.entries(files))
        await fs.writeFile(path.join(root, name), body);
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  };

  it("reads bascik.config.mjs when it is the only config", async () => {
    await withConfigs({ "bascik.config.mjs": "mjs" }, async (root) => {
      expect(await readConfigSource(root)).toBe("mjs");
    });
  });

  it("reads the same file the CLI loads when several are present: .js, then .mjs, then .ts", async () => {
    await withConfigs(
      { "bascik.config.ts": "ts", "bascik.config.mjs": "mjs" },
      async (root) => {
        expect(await readConfigSource(root)).toBe("mjs");
        await fs.writeFile(path.join(root, "bascik.config.js"), "js");
        expect(await readConfigSource(root)).toBe("js");
      },
    );
  });

  it("lists the config names in the CLI's discovery order", async () => {
    // pkg's list lives in pkg/src/lib/config-file-names.ts; read its source
    // so the two cannot drift without this failing.
    const source = await fs.readFile(
      path.join(
        __dirname,
        "..",
        "..",
        "pkg",
        "src",
        "lib",
        "config-file-names.ts",
      ),
      "utf8",
    );
    const list = /CONFIG_FILE_NAMES = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    const pkgNames = Array.from(list.matchAll(/"([^"]+)"/g), (m) => m[1]);
    expect(pkgNames.length).toBeGreaterThan(0);
    expect(CONFIG_FILE_CANDIDATES).toEqual(pkgNames);
  });
});
