import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// userConfig is mocked so config.ts can be imported without loading a project config.
vi.mock("./userConfig.js", () => ({
  config: {},
  modeOverrides: {},
  buildConfig: {},
}));

import {
  buildDefaultConfig,
  defaultConfig,
  devDefaultConfig,
  serverDefaultConfig,
} from "./config.ts";

// The published bascik-config agent skill hard-codes the defaults it uses to flag redundant config values.
// This test keeps that table honest: if a default changes here, the skill's audit script must change too.
const auditScript = resolve(
  import.meta.dirname,
  "../../../skills/bascik-config/scripts/audit-config.mjs",
);

type Defaults = {
  KNOWN_DEFAULTS: Record<string, unknown>;
  MODE_DEFAULTS: Record<"dev" | "build" | "server", Record<string, unknown>>;
};
const loadAudit = async (): Promise<Defaults> =>
  (await import(pathToFileURL(auditScript).href)) as Defaults;

const lookup = (source: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown> | undefined)?.[key],
      source,
    );

describe("bascik-config agent skill defaults", () => {
  it("matches every mode-independent default in defaultConfig", async () => {
    const { KNOWN_DEFAULTS } = await loadAudit();
    expect(Object.keys(KNOWN_DEFAULTS).length).toBeGreaterThan(30);
    for (const [path, expected] of Object.entries(KNOWN_DEFAULTS)) {
      const actual =
        path === "pipeline.exec"
          ? (lookup(defaultConfig, path) ?? [])
          : lookup(defaultConfig, path);
      expect(actual, path).toEqual(expected);
    }
  });

  it("lists every mode-independent default leaf of defaultConfig, so a restated default is never missed", async () => {
    const { KNOWN_DEFAULTS, MODE_DEFAULTS } = await loadAudit();
    const modeKeys = new Set(
      Object.values(MODE_DEFAULTS).flatMap((defaults) => Object.keys(defaults)),
    );
    const leaves: string[] = [];
    const walk = (value: unknown, prefix: string) => {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0
      ) {
        for (const [key, child] of Object.entries(value))
          walk(child, prefix ? `${prefix}.${key}` : key);
        return;
      }
      if (value === undefined || typeof value === "function") return;
      leaves.push(prefix);
    };
    walk(defaultConfig, "");
    const modeDependent = (path: string) =>
      modeKeys.has(path) ||
      [devDefaultConfig, buildDefaultConfig, serverDefaultConfig].some(
        (mode) => lookup(mode, path) !== undefined,
      );
    const missing = leaves.filter(
      (path) => !Object.hasOwn(KNOWN_DEFAULTS, path) && !modeDependent(path),
    );
    expect(missing).toEqual([]);
  });

  it("does not list a mode-dependent key as mode-independent", async () => {
    const { KNOWN_DEFAULTS } = await loadAudit();
    for (const modeDefaults of [
      devDefaultConfig,
      buildDefaultConfig,
      serverDefaultConfig,
    ]) {
      for (const path of Object.keys(KNOWN_DEFAULTS)) {
        const modeValue = lookup(modeDefaults, path);
        if (modeValue !== undefined)
          expect(modeValue, path).toEqual(KNOWN_DEFAULTS[path]);
      }
    }
  });

  it("matches the build and server mode defaults and the dev base values", async () => {
    const { MODE_DEFAULTS } = await loadAudit();
    for (const [mode, overrides] of [
      ["build", buildDefaultConfig],
      ["server", serverDefaultConfig],
    ] as const) {
      for (const [path, expected] of Object.entries(MODE_DEFAULTS[mode])) {
        if (path === "pipeline.onExecError") continue; // resolved at run time, not in the defaults table
        const actual = lookup(overrides, path) ?? lookup(defaultConfig, path);
        expect(actual, `${mode} ${path}`).toEqual(expected);
      }
    }
    for (const [path, expected] of Object.entries(MODE_DEFAULTS.dev)) {
      if (path === "pipeline.onExecError") continue;
      expect(lookup(defaultConfig, path), `dev ${path}`).toEqual(expected);
    }
  });

  it("covers every minify flag that differs between dev and production", async () => {
    const { MODE_DEFAULTS } = await loadAudit();
    for (const key of Object.keys(defaultConfig.minify)) {
      expect(MODE_DEFAULTS.build, key).toHaveProperty([`minify.${key}`]);
      expect(MODE_DEFAULTS.server, key).toHaveProperty([`minify.${key}`]);
      expect(MODE_DEFAULTS.dev, key).toHaveProperty([`minify.${key}`]);
    }
  });
  it("lists every security toggle, scripts.stripAnsi and both limit objects (Collin 2026-10-29)", async () => {
    const { KNOWN_DEFAULTS } = await loadAudit();
    const expected: Record<string, unknown> = {
      "security.blockScriptUrls": true,
      "security.blockCodeBindings": true,
      "security.headers": true,
      "security.hsts": true,
      "security.privateDynamicPages": true,
      "security.stripDirectiveScripts": true,
      "security.hideDotfiles": true,
      "scripts.stripAnsi": true,
      "scripts.renderLimits.maxInstances": 1000,
      "scripts.renderLimits.maxOutputLength": 4194304,
      "scripts.renderLimits.maxNestedScripts": 64,
      "scripts.renderLimits.maxDepth": 4,
      "scripts.renderLimits.rescanFactor": 16,
      "scripts.renderLimits.rescanBase": 33554432,
      "components.expansionLimits.maxInstances": 10000,
      "components.expansionLimits.maxPageLength": 52428800,
    };
    for (const [path, value] of Object.entries(expected))
      expect(KNOWN_DEFAULTS[path], path).toEqual(value);
  });
});
