import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// userConfig is mocked so config.ts can be imported without top-level await
vi.mock("./userConfig.js", () => ({
  config: {},
  modeOverrides: {},
  buildConfig: {},
}));

import { defaultConfig, BascikConfig, initBascikConfig, normalizeScopableOption, deepMerge } from "./config.ts";

// Filesystem stub for initBascikConfig calls whose configs reference script
// paths that do not exist on disk. Validation injects the filesystem; there
// is no global skip flag.
const allowAllFs = {
  existsSync: () => true,
  isDirectory: () => true,
  isReadableFile: () => true,
};

describe("defaultConfig", () => {
  it("has scoping options", () => {
    expect(defaultConfig.scoping.scriptBlocks).toBe(true);
    expect(defaultConfig.scoping.inheritAttributes).toBe(true);
    expect(defaultConfig.scoping.attributes.class).toBe(true);
    expect(defaultConfig.scoping.attributes.id).toBe(true);
    expect(defaultConfig.scoping.attributes.name).toBe(true);
    expect(defaultConfig.scoping.deduplicateCss).toBe(true);
    expect(defaultConfig.scoping.preserve).toEqual(["code"]);
  });

  it("has default directory paths including out", () => {
    expect(defaultConfig.directory.pages).toMatch(/src[/\\]pages$/);
    expect(defaultConfig.directory.components).toEqual(["src/components"]);
    expect(defaultConfig.directory.out).toMatch(/dist$/);
    expect(defaultConfig.directory.api).toBe("src/api");
    expect("public" in defaultConfig.directory).toBe(false);
  });

  it("has default minify options set to false in dev mode", () => {
    expect(defaultConfig.minify).toEqual({
      html: false,
      css: false,
      js: false,
      identifiers: false,
    });
  });

  it("has http options", () => {
    expect(defaultConfig.http.httpCache).toBe(false);
    expect(defaultConfig.http.hostname).toBe("localhost");
    expect(defaultConfig.http.port).toBeUndefined();
    expect(defaultConfig.http.tls.enabled).toBe(false);
    expect(defaultConfig.http.rateLimit).toBe(true);
    expect(defaultConfig.http.apiTimeout).toBe(10000);
  });

  it("has default logging options", () => {
    expect(defaultConfig.logging.level).toBe("info");
    expect(defaultConfig.logging.requests).toBe(true);
    expect(defaultConfig.logging.copies).toBe(true);
    expect(defaultConfig.logging.deletes).toBe(true);
    expect(defaultConfig.logging.transpiles).toBe(true);
  });

  it("has assets and pipeline options", () => {
    expect(defaultConfig.assets.inlineStyles).toBe(false);
    expect(defaultConfig.assets.exclude).toEqual([]);
    expect(defaultConfig.pipeline.watchPaths).toEqual([]);
    expect(defaultConfig.pipeline.workers).toBe(false);
  });

  it("has split script error options", () => {
    expect(defaultConfig.scripts.onBuildScriptError).toBe("error");
    expect(defaultConfig.scripts.onRoutesScriptError).toBe("error");
    expect(defaultConfig.scripts.onServerScriptError).toBe("error");
    expect(defaultConfig.onMinifyError).toBe("warn");
  });

  it("defaults scripts.importRoot to 'src' and keeps it unresolved", () => {
    expect(defaultConfig.scripts.importRoot).toBe("src");
    const { BascikConfig: cfg } = initBascikConfig({}, {}, {}, { fs: allowAllFs });
    expect(cfg.scripts.importRoot).toBe("src");
  });

  it("keeps a user-supplied scripts.importRoot as written, including paths outside the project", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { scripts: { importRoot: "../shared/scripts" } },
      {},
      {},
      { fs: allowAllFs },
    );
    expect(cfg.scripts.importRoot).toBe("../shared/scripts");
    // The import root is independent of the pages and components directories.
    expect(cfg.directory.pages).toMatch(/src[/\\]pages$/);
    expect(cfg.directory.components).toHaveLength(1);
    expect(cfg.directory.components[0]).toMatch(/src[/\\]components$/);
  });
});

describe("directory.components normalization (string | string[] -> string[])", () => {
  let baseDir: string;
  let workDir: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    baseDir = realpathSync(mkdtempSync(join(tmpdir(), "bascik-config-roots-")));
    // The project is a child of the temp base so `../shared` stays inside it.
    workDir = join(baseDir, "site");
    mkdirSync(workDir);
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(baseDir, { recursive: true, force: true });
  });

  const init = (components: string | string[]) =>
    initBascikConfig({ directory: { components } }, {}, {}, { fs: allowAllFs }).BascikConfig;

  it("wraps a single string in an array and resolves it to an absolute realpath", () => {
    mkdirSync(join(workDir, "x"));
    expect(init("x").directory.components).toEqual([realpathSync(resolve(workDir, "x"))]);
  });

  it("keeps two roots in author order as absolute paths, including one outside the project", () => {
    mkdirSync(join(baseDir, "shared", "components"), { recursive: true });
    mkdirSync(join(workDir, "src", "components"), { recursive: true });
    const roots = init(["../shared/components", "src/components"]).directory.components;
    expect(roots).toEqual([
      join(baseDir, "shared", "components"),
      join(workDir, "src", "components"),
    ]);
  });

  it("defaults to one entry ending in src/components", () => {
    const { BascikConfig: cfg } = initBascikConfig({}, {}, {}, { fs: allowAllFs });
    expect(cfg.directory.components).toHaveLength(1);
    expect(cfg.directory.components[0]).toMatch(/[/\\]src[/\\]components$/);
  });

  it("keeps a non-existent entry as its resolved path without throwing", () => {
    expect(init("does-not-exist-yet").directory.components).toEqual([
      resolve(workDir, "does-not-exist-yet"),
    ]);
  });

  it("rejects the same directory spelled two ways, naming both spellings", () => {
    mkdirSync(join(workDir, "a"));
    expect(() => init(["a", "./a/"])).toThrow(/directory\.components[\s\S]*"a"[\s\S]*"\.\/a\/"[\s\S]*same directory/);
  });

  it("rejects a symlink to an already-listed root as a duplicate", () => {
    mkdirSync(join(workDir, "a"));
    symlinkSync(join(workDir, "a"), join(workDir, "link-to-a"), "dir");
    expect(() => init(["a", "link-to-a"])).toThrow(/same directory/);
  });

  it("rejects a root nested inside another root, naming parent and child", () => {
    mkdirSync(join(workDir, "src", "components", "shared"), { recursive: true });
    const expected = /"src\/components\/shared" is inside "src\/components"/;
    expect(() => init(["src/components", "src/components/shared"])).toThrow(expected);
    expect(() => init(["src/components/shared", "src/components"])).toThrow(expected);
  });

  it("does not mistake a sibling with a shared prefix for a nested root", () => {
    mkdirSync(join(workDir, "src", "components"), { recursive: true });
    mkdirSync(join(workDir, "src", "components-shared"), { recursive: true });
    const roots = init(["src/components", "src/components-shared"]).directory.components;
    expect(roots).toHaveLength(2);
    expect(roots[1].endsWith(`${sep}components-shared`)).toBe(true);
  });
});

describe("scopable option normalizer", () => {
  it("normalizes boolean values", () => {
    expect(normalizeScopableOption(true)).toEqual({ enabled: true });
    expect(normalizeScopableOption(false)).toEqual({ enabled: false });
  });

  it("normalizes object values", () => {
    expect(normalizeScopableOption({ enabled: false })).toEqual({ enabled: false, include: undefined, exclude: undefined });
    expect(normalizeScopableOption({ include: ["src/"] })).toEqual({ enabled: true, include: ["src/"], exclude: undefined });
    expect(normalizeScopableOption({ exclude: ["node_modules/"] })).toEqual({ enabled: true, include: undefined, exclude: ["node_modules/"] });
    expect(normalizeScopableOption({ enabled: true, include: ["src/"], exclude: ["tmp/"] })).toEqual({ enabled: true, include: ["src/"], exclude: ["tmp/"] });
  });

  it("falls back to default for undefined or invalid input", () => {
    expect(normalizeScopableOption(undefined)).toEqual({ enabled: true });
  });
});

describe("deepMerge", () => {
  it("deeply merges nested objects", () => {
    const target = { http: { port: 3000, tls: { enabled: false, keyFile: "a" } } };
    const source = { http: { tls: { enabled: true } } };
    const merged = deepMerge<any>({}, target, source);
    expect(merged.http.port).toBe(3000);
    expect(merged.http.tls.enabled).toBe(true);
    expect(merged.http.tls.keyFile).toBe("a");
  });
});

describe("BascikConfig freeze and structure", () => {
  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(BascikConfig)).toBe(true);
  });

  it("deep-freezes nested config objects", () => {
    expect(Object.isFrozen(BascikConfig.directory)).toBe(true);
    expect(Object.isFrozen(BascikConfig.scoping)).toBe(true);
    expect(Object.isFrozen(BascikConfig.generate)).toBe(true);
    expect(Object.isFrozen(BascikConfig.http)).toBe(true);
    expect(Object.isFrozen(BascikConfig.pipeline.watchPaths)).toBe(true);
  });

  it("does not accept prodServer or devServer as containers", () => {
    expect(BascikConfig).not.toHaveProperty("prodServer");
    expect(BascikConfig).not.toHaveProperty("devServer");
  });

  it("resolves directory paths to absolute paths", () => {
    expect(BascikConfig.directory.pages).toMatch(/[/\\]src[/\\]pages$/);
    expect(BascikConfig.directory.components[0]).toMatch(/[/\\]src[/\\]components$/);
    expect(BascikConfig.directory.out).toMatch(/[/\\]dist$/);
  });
});

describe("initBascikConfig does not mutate objects the caller owns", () => {
  it("does not freeze arrays on the caller's own config object", () => {
    const userConfig = { pipeline: { watchPaths: ["src/assets"] } };
    initBascikConfig(userConfig, {}, {}, { fs: allowAllFs });
    // The resolved config is frozen; the caller's own module exports must
    // stay mutable — deepFreeze must never reach across the boundary.
    expect(Object.isFrozen(userConfig.pipeline.watchPaths)).toBe(false);
    expect(() => userConfig.pipeline.watchPaths.push("src/more")).not.toThrow();
    expect(userConfig.pipeline.watchPaths).toEqual(["src/assets", "src/more"]);
  });

  it("does not freeze nested objects on the caller's own config object", () => {
    const userConfig = { http: { hostname: "example.test" } };
    initBascikConfig(userConfig, {}, {}, { fs: allowAllFs });
    expect(Object.isFrozen(userConfig.http)).toBe(false);
  });

  it("leaves the exported defaultConfig unfrozen and unmodified", () => {
    // Two symptoms of the same leak: freezing the merged config must not
    // reach back into defaultConfig, whose arrays are shared by reference
    // through the merge when the user provides no override.
    initBascikConfig({}, {}, {}, { fs: allowAllFs });
    expect(Object.isFrozen(defaultConfig)).toBe(false);
    expect(Object.isFrozen(defaultConfig.scoping)).toBe(false);
    expect(Object.isFrozen(defaultConfig.pipeline.watchPaths)).toBe(false);
    expect(defaultConfig.pipeline.watchPaths).toEqual([]);
    expect(defaultConfig.scoping.preserve).toEqual(["code"]);
  });
});

describe("dev vs build vs server mode overrides and defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps minify options off and defaults error actions to 'error' for scripts in dev mode", () => {
    const { BascikConfig: cfg } = initBascikConfig({}, {}, { isBuild: false, isProdServer: false });
    expect(cfg.minify).toEqual({ html: false, css: false, js: false, identifiers: false });
    expect(cfg.scripts.onBuildScriptError).toBe("error");
    expect(cfg.scripts.onRoutesScriptError).toBe("error");
    expect(cfg.scripts.onServerScriptError).toBe("error");
    expect(cfg.onMinifyError).toBe("warn");
    expect(cfg.http.httpCache).toBe(false);
  });

  it("turns minify options on and defaults error actions to 'error' for --build", () => {
    const { BascikConfig: cfg } = initBascikConfig({}, {}, { isBuild: true });
    expect(cfg.minify).toEqual({ html: true, css: true, js: true, identifiers: true });
    expect(cfg.scripts.onBuildScriptError).toBe("error");
    expect(cfg.scripts.onRoutesScriptError).toBe("error");
    expect(cfg.scripts.onServerScriptError).toBe("error");
    expect(cfg.onMinifyError).toBe("error");
  });

  it("turns minify options on, defaults error actions to 'error', and enables httpCache for --server", () => {
    const { BascikConfig: cfg } = initBascikConfig({}, {}, { isProdServer: true });
    expect(cfg.minify).toEqual({ html: true, css: true, js: true, identifiers: true });
    expect(cfg.scripts.onBuildScriptError).toBe("error");
    expect(cfg.onMinifyError).toBe("error");
    expect(cfg.http.httpCache).toBe(true);
  });

  it("deep-merges mode export override over default userConfig", () => {
    const userConfig = {
      logging: { level: "info" as const, copies: true },
      http: { port: 3000, hostname: "localhost" },
    };
    const modeOverrides = {
      build: { logging: { copies: false }, minify: { css: false } },
      server: { http: { port: 8080, tls: { enabled: true } } },
    };

    const buildCfg = initBascikConfig(userConfig, modeOverrides, { isBuild: true }).BascikConfig;
    expect(buildCfg.logging.level).toBe("info");
    expect(buildCfg.logging.copies).toBe(false);
    expect(buildCfg.http.port).toBe(3000);
    expect(buildCfg.minify.css).toBe(false);

    const serverCfg = initBascikConfig(userConfig, modeOverrides, { isProdServer: true }).BascikConfig;
    expect(serverCfg.http.port).toBe(8080);
    expect(serverCfg.http.hostname).toBe("localhost");
    expect(serverCfg.http.tls.enabled).toBe(true);
  });

  it("allows directory.out to be customized and reach all resolution logic", () => {
    const { BascikConfig: cfg } = initBascikConfig({ directory: { out: "custom-build" } });
    expect(cfg.directory.out).toMatch(/[/\\]custom-build$/);
  });

});

describe("CLI flag overrides (flag > env var > config file)", () => {
  it("applies port, host, and logLevel above the merged config", () => {
    const userConfig = {
      http: { port: 3000, hostname: "config-host" },
      logging: { level: "info" as const },
    };
    const { BascikConfig: cfg } = initBascikConfig(userConfig, {}, {
      port: 4321,
      host: "flag-host",
      logLevel: "debug",
    });
    expect(cfg.http.port).toBe(4321);
    expect(cfg.http.hostname).toBe("flag-host");
    expect(cfg.logging.level).toBe("debug");
  });

  it("leaves config-file values in place when no overrides are passed", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { http: { port: 3000, hostname: "config-host" }, logging: { level: "warn" as const } },
      {},
      {},
    );
    expect(cfg.http.port).toBe(3000);
    expect(cfg.http.hostname).toBe("config-host");
    expect(cfg.logging.level).toBe("warn");
  });
});

describe("exec config normalization and merging", () => {
  it("normalizes an exec entry with no phase to 'pre'", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { pipeline: { exec: [{ script: "scripts/gen.js" }] } },
      {},
      {},
      { fs: allowAllFs },
    );
    expect(cfg.pipeline.exec).toEqual([{ script: "scripts/gen.js", phase: "pre" }]);
  });

  it("preserves explicit valid phase ('post' and 'parallel')", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      {
        pipeline: {
          exec: [
            { script: "scripts/a.js", phase: "post" },
            { script: "scripts/b.js", phase: "parallel" },
            { script: "scripts/c.js", phase: "pre" },
          ],
        },
      },
      {},
      {},
      { fs: allowAllFs },
    );
    expect(cfg.pipeline.exec).toEqual([
      { script: "scripts/a.js", phase: "post" },
      { script: "scripts/b.js", phase: "parallel" },
      { script: "scripts/c.js", phase: "pre" },
    ]);
  });

  it("rejects an invalid phase in the validation pass, naming key and value", () => {
    let thrown: Error | undefined;
    try {
      initBascikConfig(
        { pipeline: { exec: [{ script: "scripts/invalid.js", phase: "invalid-phase" as any }] } },
        {},
        {},
        { fs: allowAllFs },
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("pipeline.exec[0].phase");
    expect(thrown!.message).toContain("invalid-phase");
    expect(thrown!.message).toContain('"pre", "post", or "parallel"');
  });

  it("lets buildOverrideConfig replace exec array during build", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { pipeline: { exec: [{ script: "scripts/dev-only.js" }] } },
      { pipeline: { exec: [{ script: "scripts/build-only.js", phase: "post" }] } },
      { isBuild: true },
      { fs: allowAllFs },
    );
    expect(cfg.pipeline.exec).toEqual([
      { script: "scripts/build-only.js", phase: "post" },
    ]);
  });
});

