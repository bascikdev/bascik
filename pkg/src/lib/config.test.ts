import { describe, it, expect, vi, afterEach } from "vitest";

// userConfig is mocked so config.ts can be imported without top-level await
vi.mock("./userConfig.js", () => ({
  config: {},
  buildConfig: {},
}));

import { defaultConfig, BascikConfig, initBascikConfig } from "./config.ts";

describe("defaultConfig", () => {
  it("has scopeScriptBlocks: true", () => {
    expect(defaultConfig.scopeScriptBlocks).toBe(true);
  });

  it("has inheritAttributes: true", () => {
    expect(defaultConfig.inheritAttributes).toBe(true);
  });

  it("has all scopeAttribute keys set to true", () => {
    expect(defaultConfig.scopeAttribute.class).toBe(true);
    expect(defaultConfig.scopeAttribute.id).toBe(true);
    expect(defaultConfig.scopeAttribute.name).toBe(true);
  });

  it("has default directory paths", () => {
    // initBascikConfig shallow-copies defaultConfig so directory is mutated to absolute paths
    expect(defaultConfig.directory.pages).toMatch(/src[/\\]pages$/);
    expect(defaultConfig.directory.components).toMatch(/src[/\\]components$/);
    expect(defaultConfig.watch).toEqual([]);
  });

  it("has default minify options set to false in dev mode", () => {
    expect(defaultConfig.minify).toEqual({
      html: false,
      css: false,
      js: false,
      identifiers: false,
    });
  });

  it("has cacheHttp: false", () => {
    expect(defaultConfig.cacheHttp).toBe(false);
  });

  it("has default devServer logging options", () => {
    expect(defaultConfig.devServer?.logging?.level).toBe("info");
    expect(defaultConfig.devServer?.logging?.requests).toBe(true);
    expect(defaultConfig.devServer?.logging?.copies).toBe(true);
    expect(defaultConfig.devServer?.logging?.deletes).toBe(true);
    expect(defaultConfig.devServer?.logging?.transpiles).toBe(true);
  });

  it("has default prodServer logging options and rateLimit enabled", () => {
    expect(defaultConfig.prodServer?.logging?.level).toBe("info");
    expect(defaultConfig.prodServer?.logging?.requests).toBe(true);
    expect(defaultConfig.prodServer?.rateLimit).toBe(true);
  });

  it("has deduplicateCss: true", () => {
    expect(defaultConfig.deduplicateCss).toBe(true);
  });

  it('has skipTranspilingElementContents: ["code"]', () => {
    expect(defaultConfig.skipTranspilingElementContents).toEqual(["code"]);
  });

  it("has inlineStyles: false", () => {
    expect(defaultConfig.inlineStyles).toBe(false);
  });

  it("has useWorkers: false", () => {
    expect(defaultConfig.useWorkers).toBe(false);
  });
});

describe("BascikConfig", () => {
  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(BascikConfig)).toBe(true);
  });

  it("deep-freezes nested config objects", () => {
    expect(Object.isFrozen(BascikConfig.directory)).toBe(true);
    expect(Object.isFrozen(BascikConfig.scopeAttribute)).toBe(true);
    expect(Object.isFrozen(BascikConfig.generate)).toBe(true);
    expect(Object.isFrozen(BascikConfig.prodServer)).toBe(true);
    expect(Object.isFrozen(BascikConfig.watch)).toBe(true);
    expect(Object.isFrozen(BascikConfig.skipTranspilingElementContents)).toBe(
      true,
    );
  });

  it("throws when mutating a nested config key in strict mode", () => {
    expect(() => {
      (BascikConfig.directory as Record<string, unknown>).pages = "other";
    }).toThrow(TypeError);
  });

  it("contains all default keys", () => {
    expect(BascikConfig).toHaveProperty("scopeScriptBlocks");
    expect(BascikConfig).toHaveProperty("inheritAttributes");
    expect(BascikConfig).toHaveProperty("scopeAttribute");
    expect(BascikConfig).toHaveProperty("directory");
    expect(BascikConfig).toHaveProperty("minify");
    expect(BascikConfig).toHaveProperty("cacheHttp");
    expect(BascikConfig).toHaveProperty("deduplicateCss");
    expect(BascikConfig).toHaveProperty("devServer");
    expect(BascikConfig).toHaveProperty("isBuild");
  });

  it("resolves directory paths to absolute paths", () => {
    expect(BascikConfig.directory.pages).toMatch(/[/\\]src[/\\]pages$/);
    expect(BascikConfig.directory.components).toMatch(
      /[/\\]src[/\\]components$/,
    );
    expect(BascikConfig.watch).toEqual([]);
  });
});

describe("BascikConfig.isBuild", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is false when BASCIK_BUILD is not set", async () => {
    vi.stubEnv("BASCIK_BUILD", "0");
    vi.resetModules();
    const mod = await import("./config.ts");
    expect(mod.BascikConfig.isBuild).toBe(false);
  });

  it("is true when BASCIK_BUILD=1", async () => {
    vi.stubEnv("BASCIK_BUILD", "1");
    vi.resetModules();
    const mod = await import("./config.ts");
    expect(mod.BascikConfig.isBuild).toBe(true);
  });

  it("is true when --build is in process.argv", async () => {
    const original = process.argv;
    process.argv = ["node", "bascik.js", "--build"];
    vi.resetModules();
    const mod = await import("./config.ts");
    expect(mod.BascikConfig.isBuild).toBe(true);
    process.argv = original;
  });
});

describe("dev vs build vs prod server defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps minify options off and defaults error actions to 'warn' in dev mode", () => {
    const { BascikConfig: cfg } = initBascikConfig({}, {}, { isBuild: false, isProdServer: false });
    expect(cfg.minify).toEqual({
      html: false,
      css: false,
      js: false,
      identifiers: false,
    });
    expect(cfg.onScriptError).toBe("warn");
    expect(cfg.onMinifyError).toBe("warn");
  });

  it("turns minify options on and defaults error actions to 'error' for --build", () => {
    const { BascikConfig: cfg } = initBascikConfig({}, {}, { isBuild: true });
    expect(cfg.minify).toEqual({
      html: true,
      css: true,
      js: true,
      identifiers: true,
    });
    expect(cfg.onScriptError).toBe("error");
    expect(cfg.onMinifyError).toBe("error");
  });

  it("turns minify options on and defaults error actions to 'error' for --serve (prod server)", () => {
    const { BascikConfig: cfg } = initBascikConfig({}, {}, { isProdServer: true });
    expect(cfg.minify).toEqual({
      html: true,
      css: true,
      js: true,
      identifiers: true,
    });
    expect(cfg.onScriptError).toBe("error");
    expect(cfg.onMinifyError).toBe("error");
  });

  it("applies build defaults through the singleton when BASCIK_BUILD=1", async () => {
    vi.stubEnv("BASCIK_BUILD", "1");
    vi.resetModules();
    const mod = await import("./config.ts");
    expect(mod.BascikConfig.isBuild).toBe(true);
    expect(mod.BascikConfig.minify.html).toBe(true);
    expect(mod.BascikConfig.minify.identifiers).toBe(true);
  });

  it("exposes buildDefaultConfig with the production defaults", async () => {
    const { buildDefaultConfig } = await import("./config.ts");
    expect(buildDefaultConfig.minify).toEqual({
      html: true,
      css: true,
      js: true,
      identifiers: true,
    });
  });
});

describe("minify user config overrides", () => {
  it("allows overriding minify options individually", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { minify: { html: false, css: true } },
      {},
      { isBuild: true },
    );
    expect(cfg.minify.html).toBe(false);
    expect(cfg.minify.css).toBe(true);
    expect(cfg.minify.js).toBe(true);
  });

  it("supports boolean minify: false to disable all minification during build", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { minify: false },
      {},
      { isBuild: true },
    );
    expect(cfg.minify).toEqual({
      html: false,
      css: false,
      js: false,
      identifiers: false,
    });
  });

  it("supports boolean minify: true to enable all minification in dev mode", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { minify: true },
      {},
      { isBuild: false },
    );
    expect(cfg.minify).toEqual({
      html: true,
      css: true,
      js: true,
      identifiers: true,
    });
  });

  it("allows user config to override onScriptError and onMinifyError in dev mode", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { onScriptError: "error", onMinifyError: "error" },
      {},
      { isBuild: false },
    );
    expect(cfg.onScriptError).toBe("error");
    expect(cfg.onMinifyError).toBe("error");
  });

  it("allows user config to override onScriptError and onMinifyError in build mode", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { onScriptError: "warn", onMinifyError: "warn" },
      {},
      { isBuild: true },
    );
    expect(cfg.onScriptError).toBe("warn");
    expect(cfg.onMinifyError).toBe("warn");
  });
});

describe("user config overrides", () => {
  it("handles null or non-object userConfig gracefully without throwing", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      null as any,
      null as any,
      { isBuild: false },
    );
    expect(cfg.scopeScriptBlocks).toBe(true);
    expect(cfg.directory.pages).toMatch(/src[/\\]pages$/);
  });

  it("lets userConfig win over build defaults", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { minify: { css: false, identifiers: false } },
      {},
      { isBuild: true },
    );
    expect(cfg.minify.css).toBe(false);
    expect(cfg.minify.identifiers).toBe(false);
    // Untouched build default still applies.
    expect(cfg.minify.js).toBe(true);
  });

  it("lets buildOverrideConfig win over userConfig during --build", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { minify: { css: false } },
      { minify: { css: true } },
      { isBuild: true },
    );
    expect(cfg.minify.css).toBe(true);
  });

  it("lets buildOverrideConfig win over userConfig during --serve", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { minify: { css: false } },
      { minify: { css: true } },
      { isProdServer: true },
    );
    expect(cfg.minify.css).toBe(true);
  });

  it("ignores buildOverrideConfig in dev mode", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { minify: { css: false } },
      { minify: { css: true } },
      { isBuild: false },
    );
    expect(cfg.minify.css).toBe(false);
  });
});

describe("buildOverrideConfig.prodServer merge", () => {
  it("merges buildOverrideConfig.prodServer over user prodServer config during --build", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { prodServer: { port: 9000, hostname: "example.test" } },
      { prodServer: { port: 443 } },
      { isBuild: true },
    );
    expect(cfg.prodServer?.port).toBe(443);
    // Keys not overridden by the build config keep the user value.
    expect(cfg.prodServer?.hostname).toBe("example.test");
  });

  it("merges buildOverrideConfig.prodServer over user prodServer config during --serve", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { prodServer: { port: 9000, hostname: "example.test" } },
      { prodServer: { port: 443 } },
      { isProdServer: true },
    );
    expect(cfg.prodServer?.port).toBe(443);
    expect(cfg.prodServer?.hostname).toBe("example.test");
  });

  it("does not apply buildOverrideConfig.prodServer in dev mode", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { prodServer: { port: 9000 } },
      { prodServer: { port: 443 } },
      { isBuild: false },
    );
    expect(cfg.prodServer?.port).toBe(9000);
  });

  it("merges devServer logging config from user config", () => {
    const { BascikConfig: cfg } = initBascikConfig({
      devServer: { logging: { level: "debug", requests: false, copies: false, transpiles: false } },
    });
    expect(cfg.devServer?.logging?.level).toBe("debug");
    expect(cfg.devServer?.logging?.requests).toBe(false);
    expect(cfg.devServer?.logging?.copies).toBe(false);
    expect(cfg.devServer?.logging?.transpiles).toBe(false);
    expect(cfg.devServer?.logging?.deletes).toBe(true);
  });

  it("falls back to the default prodServer config when nothing overrides it", () => {
    expect(BascikConfig.prodServer?.port).toBeUndefined();
    expect(BascikConfig.prodServer?.hostname).toBe("localhost");
    expect(BascikConfig.prodServer?.logging?.level).toBe("info");
    expect(BascikConfig.prodServer?.logging?.requests).toBe(true);
    expect(BascikConfig.prodServer?.rateLimit).toBe(true);
  });

  it("allows rateLimit to be disabled in prodServer config", () => {
    const { BascikConfig: cfg } = initBascikConfig({
      prodServer: { rateLimit: false },
    });
    expect(cfg.prodServer?.rateLimit).toBe(false);
  });
});

describe("exec config normalization and merging", () => {
  it("normalizes an exec entry with no phase to 'pre'", () => {
    const { BascikConfig: cfg } = initBascikConfig({
      exec: [{ script: "scripts/gen.js" }],
    });
    expect(cfg.exec).toEqual([{ script: "scripts/gen.js", phase: "pre" }]);
  });

  it("preserves explicit valid phase ('post' and 'parallel')", () => {
    const { BascikConfig: cfg } = initBascikConfig({
      exec: [
        { script: "scripts/a.js", phase: "post" },
        { script: "scripts/b.js", phase: "parallel" },
        { script: "scripts/c.js", phase: "pre" },
      ],
    });
    expect(cfg.exec).toEqual([
      { script: "scripts/a.js", phase: "post" },
      { script: "scripts/b.js", phase: "parallel" },
      { script: "scripts/c.js", phase: "pre" },
    ]);
  });

  it("warns and falls back to 'pre' when an invalid phase is provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const { BascikConfig: cfg } = initBascikConfig({
      exec: [{ script: "scripts/invalid.js", phase: "invalid-phase" as any }],
    });
    expect(cfg.exec).toEqual([{ script: "scripts/invalid.js", phase: "pre" }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid exec phase "invalid-phase"'),
    );
    warnSpy.mockRestore();
  });

  it("lets buildOverrideConfig replace exec array during build", () => {
    const { BascikConfig: cfg } = initBascikConfig(
      { exec: [{ script: "scripts/dev-only.js" }] },
      { exec: [{ script: "scripts/build-only.js", phase: "post" }] },
      { isBuild: true },
    );
    expect(cfg.exec).toEqual([
      { script: "scripts/build-only.js", phase: "post" },
    ]);
  });
});

