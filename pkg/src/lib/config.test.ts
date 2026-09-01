import { describe, it, expect, vi, afterEach } from "vitest";

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
    expect(defaultConfig.directory.components).toMatch(/src[/\\]components$/);
    expect(defaultConfig.directory.out).toMatch(/dist$/);
    expect(defaultConfig.directory.api).toBe("src/api");
    expect(defaultConfig.directory.public).toBeUndefined();
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
    expect(BascikConfig.directory.components).toMatch(/[/\\]src[/\\]components$/);
    expect(BascikConfig.directory.out).toMatch(/[/\\]dist$/);
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

