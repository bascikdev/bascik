import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// userConfig is mocked so config.ts can be imported without loading a project config.
vi.mock("./userConfig.js", () => ({
  config: {},
  modeOverrides: {},
  buildConfig: {},
}));

import { buildDefaultConfig, defaultConfig, devDefaultConfig, serverDefaultConfig } from "./config.ts";

// The published bascik-config agent skill hard-codes the defaults it uses to flag redundant config values.
// This test keeps that table honest: if a default changes here, the skill's audit script must change too.
const auditScript = resolve(import.meta.dirname, "../../../skills/bascik-config/scripts/audit-config.mjs");

type Defaults = { KNOWN_DEFAULTS: Record<string, unknown>; MODE_DEFAULTS: Record<"dev" | "build" | "server", Record<string, unknown>> };
const loadAudit = async (): Promise<Defaults> => (await import(pathToFileURL(auditScript).href)) as Defaults;

const lookup = (source: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], source);

describe("bascik-config agent skill defaults", () => {
  it("matches every mode-independent default in defaultConfig", async () => {
    const { KNOWN_DEFAULTS } = await loadAudit();
    expect(Object.keys(KNOWN_DEFAULTS).length).toBeGreaterThan(30);
    for (const [path, expected] of Object.entries(KNOWN_DEFAULTS)) {
      const actual = path === "pipeline.exec" ? (lookup(defaultConfig, path) ?? []) : lookup(defaultConfig, path);
      expect(actual, path).toEqual(expected);
    }
  });

  it("does not list a mode-dependent key as mode-independent", async () => {
    const { KNOWN_DEFAULTS } = await loadAudit();
    for (const modeDefaults of [devDefaultConfig, buildDefaultConfig, serverDefaultConfig]) {
      for (const path of Object.keys(KNOWN_DEFAULTS)) {
        const modeValue = lookup(modeDefaults, path);
        if (modeValue !== undefined) expect(modeValue, path).toEqual(KNOWN_DEFAULTS[path]);
      }
    }
  });

  it("matches the build and server mode defaults and the dev base values", async () => {
    const { MODE_DEFAULTS } = await loadAudit();
    for (const [mode, overrides] of [["build", buildDefaultConfig], ["server", serverDefaultConfig]] as const) {
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
});
