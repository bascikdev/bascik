/**
 * Defaults and merging for the `security` toggles, `scripts.stripAnsi`,
 * `scripts.renderLimits` and `components.expansionLimits`. Every protection
 * is on by default and today's limits are the defaults; partial objects
 * keep the rest; a mode export wins; the config literals equal the code
 * constants the renderer and the build loop use.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./userConfig.js", () => ({
  config: {},
  modeOverrides: {},
  buildConfig: {},
}));

import { defaultConfig, initBascikConfig } from "./config.ts";
import { REQUEST_RENDER_LIMITS } from "./request-render.ts";
import { BUILD_EXPANSION_LIMITS } from "./component-expansion.ts";
import { SCAN_BUDGET } from "./component-scan-budget.ts";

const allowAllFs = {
  existsSync: () => true,
  isDirectory: () => true,
  isReadableFile: () => true,
};

type Loose = Record<string, any>;
const defaults = defaultConfig as unknown as Loose;
const resolve = (
  user: Loose = {},
  overrides: Loose = {},
  flags: Loose = {},
): Loose =>
  initBascikConfig(user as never, overrides as never, flags as never, {
    fs: allowAllFs,
  }).BascikConfig as unknown as Loose;

describe("defaults: every protection on", () => {
  it("security has seven keys, all true", () => {
    expect(defaults.security).toEqual({
      blockScriptUrls: true,
      blockCodeBindings: true,
      headers: true,
      hsts: true,
      privateDynamicPages: true,
      stripDirectiveScripts: true,
      hideDotfiles: true,
    });
  });

  it("scripts.stripAnsi is on", () => {
    expect(defaults.scripts.stripAnsi).toBe(true);
  });

  it("scripts.renderLimits are today's request-time limits", () => {
    expect(defaults.scripts.renderLimits).toEqual({
      maxInstances: 1000,
      maxOutputLength: 4 * 1024 * 1024,
      maxNestedScripts: 64,
      maxDepth: 4,
      rescanFactor: 16,
      rescanBase: 32 * 1024 * 1024,
    });
  });

  it("components.expansionLimits are today's build guard", () => {
    expect(defaults.components.expansionLimits).toEqual({
      maxInstances: 10_000,
      maxPageLength: 50 * 1024 * 1024,
    });
  });

  it.each(["dev", "build", "server"])(
    "the resolved %s config carries the defaults",
    (mode) => {
      const cfg = resolve(
        {},
        {},
        mode === "build"
          ? { isBuild: true }
          : mode === "server"
            ? { isProdServer: true }
            : {},
      );
      expect(cfg.security.hsts).toBe(true);
      expect(cfg.security.hideDotfiles).toBe(true);
      expect(cfg.scripts.stripAnsi).toBe(true);
      expect(cfg.scripts.renderLimits.maxInstances).toBe(1000);
      expect(cfg.components.expansionLimits.maxInstances).toBe(10_000);
    },
  );
});

describe("the config defaults equal the code constants", () => {
  it("renderLimits match REQUEST_RENDER_LIMITS and SCAN_BUDGET", () => {
    const limits = REQUEST_RENDER_LIMITS as unknown as Loose;
    expect(defaults.scripts.renderLimits.maxInstances).toBe(
      limits.maxInstances,
    );
    expect(defaults.scripts.renderLimits.maxDepth).toBe(limits.maxDepth);
    expect(defaults.scripts.renderLimits.maxOutputLength).toBe(
      limits.maxOutputLength,
    );
    expect(defaults.scripts.renderLimits.maxNestedScripts).toBe(
      limits.maxNestedScripts,
    );
    expect(defaults.scripts.renderLimits.rescanFactor).toBe(
      limits.rescanFactor ?? SCAN_BUDGET.perOutputChar,
    );
    expect(defaults.scripts.renderLimits.rescanBase).toBe(
      limits.rescanBase ?? SCAN_BUDGET.base,
    );
  });

  it("REQUEST_RENDER_LIMITS uses the config's field names", () => {
    expect(Object.keys(REQUEST_RENDER_LIMITS).sort()).toEqual(
      [
        "maxDepth",
        "maxInstances",
        "maxNestedScripts",
        "maxOutputLength",
        "rescanBase",
        "rescanFactor",
      ].sort(),
    );
  });

  it("expansionLimits match BUILD_EXPANSION_LIMITS", () => {
    expect(defaults.components.expansionLimits).toEqual({
      maxInstances: BUILD_EXPANSION_LIMITS.maxSubstitutions,
      maxPageLength: BUILD_EXPANSION_LIMITS.maxOutputBytes,
    });
  });
});

describe("partial objects merge", () => {
  it("one render limit keeps the other five", () => {
    const cfg = resolve({ scripts: { renderLimits: { maxDepth: 8 } } });
    expect(cfg.scripts.renderLimits).toEqual({
      ...defaults.scripts.renderLimits,
      maxDepth: 8,
    });
  });

  it("one expansion limit keeps the other", () => {
    const cfg = resolve({
      components: { expansionLimits: { maxInstances: 20_000 } },
    });
    expect(cfg.components.expansionLimits).toEqual({
      maxInstances: 20_000,
      maxPageLength: 50 * 1024 * 1024,
    });
    expect(cfg.components.external).toEqual([]);
  });

  it("one security key off keeps the other six on", () => {
    const cfg = resolve({ security: { hideDotfiles: false } });
    expect(cfg.security).toEqual({ ...defaults.security, hideDotfiles: false });
  });

  it("an hsts object is kept as written (the header string is built from it later)", () => {
    const cfg = resolve({ security: { hsts: { includeSubDomains: true } } });
    expect(cfg.security.hsts).toEqual({ includeSubDomains: true });
  });

  it("a headers object is kept as written", () => {
    const cfg = resolve({
      security: { headers: { "x-frame-options": false } },
    });
    expect(cfg.security.headers).toEqual({ "x-frame-options": false });
  });

  it("scripts.stripAnsi: false keeps the other scripts settings", () => {
    const cfg = resolve({ scripts: { stripAnsi: false } });
    expect(cfg.scripts.stripAnsi).toBe(false);
    expect(cfg.scripts.renderLimits).toEqual(defaults.scripts.renderLimits);
    expect(cfg.scripts.onServerScriptError).toBe(
      defaults.scripts.onServerScriptError,
    );
  });
});

describe("mode exports win", () => {
  it("a server export turns hsts off for bascik --server only", () => {
    const overrides = { server: { security: { hsts: false } } };
    expect(resolve({}, overrides, { isProdServer: true }).security.hsts).toBe(
      false,
    );
    expect(resolve({}, overrides, { isBuild: true }).security.hsts).toBe(true);
    expect(resolve({}, overrides).security.hsts).toBe(true);
  });

  it("a build export's render limit wins over the default export's", () => {
    const cfg = resolve(
      { scripts: { renderLimits: { maxInstances: 10 } } },
      { build: { scripts: { renderLimits: { maxInstances: 20 } } } },
      { isBuild: true },
    );
    expect(cfg.scripts.renderLimits.maxInstances).toBe(20);
    expect(cfg.scripts.renderLimits.maxDepth).toBe(4);
  });
});
