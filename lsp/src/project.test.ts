import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  CONFIG_FILE_CANDIDATES,
  parseApiRoot,
  parseComponentRoots,
  parseImportRoot,
  parsePagesRoot,
  parseScopesName,
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

describe("config readers skip commented-out settings, as the compiler does", () => {
  const config = (body: string) => `export default {\n${body}\n};\n`;

  it("ignores settings inside a /* */ block", () => {
    const commented = config(
      [
        "  /* scoping: { attributes: { name: true } }, */",
        "  directory: {",
        "    /*",
        "    components: ['src/ui'],",
        "    pages: 'site/pages',",
        "    api: 'server/routes',",
        "    */",
        "  },",
        "  /* scripts: { importRoot: 'lib' } */",
      ].join("\n"),
    );
    expect(parseScopesName(commented)).toBe(false);
    expect(parseComponentRoots(commented)).toEqual(["src/components"]);
    expect(parsePagesRoot(commented)).toBe("src/pages");
    expect(parseApiRoot(commented)).toBe("src/api");
    expect(parseImportRoot(commented)).toBe("src");
  });

  it("ignores settings in // comments, but keeps // inside strings", () => {
    const source = config(
      [
        "  site: { url: 'https://example.com' },",
        "  directory: {",
        "    // components: ['src/ui'],",
        "    components: ['src/parts'], // was 'src/ui'",
        "    pages: 'site//pages',",
        "  },",
      ].join("\n"),
    );
    expect(parseComponentRoots(source)).toEqual(["src/parts"]);
    expect(parsePagesRoot(source)).toBe("site//pages");
  });

  it("reads the live setting after a commented copy of it", () => {
    const source = config(
      "  /* directory: { api: 'old/api' } */\n  directory: { api: 'server/routes' },\n  // scoping: { attributes: { name: false } },\n  scoping: { attributes: { name: true } },",
    );
    expect(parseApiRoot(source)).toBe("server/routes");
    expect(parseScopesName(source)).toBe(true);
  });

  it("treats an unclosed /* as a comment to the end of the file, in linear time", () => {
    expect(parseApiRoot("export default { /* directory: { api: 'x' } }")).toBe(
      "src/api",
    );
    const start = performance.now();
    parseComponentRoots("/*".repeat(50_000) + "components: ['a']");
    parseScopesName("'/*".repeat(50_000));
    expect(performance.now() - start).toBeLessThan(250);
  });
});
