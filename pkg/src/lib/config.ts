import { resolve } from "node:path";
import { config, modeOverrides } from "./userConfig.ts";
import type {
  BascikConfigOptions,
  UserConfig,
  ExecEntry,
  ExecPhase,
  ScopableConfig,
  ScopableOptions,
} from "./types.ts";

const args = process.argv.slice(2);
const isBuild =
  args.includes("--build") || parseInt(process.env.BASCIK_BUILD ?? "0") === 1;
const isProdServer =
  args.includes("--server") ||
  args.includes("--serve") ||
  parseInt(process.env.BASCIK_SERVER ?? process.env.BASCIK_PROD_SERVER ?? "0") === 1;

process.env.BASCIK_BUILD = isBuild ? "1" : "0";
process.env.BASCIK_SERVER = isProdServer ? "1" : "0";
process.env.BASCIK_PROD_SERVER = isProdServer ? "1" : "0";

export const normalizeScopableOption = (
  val: ScopableConfig | undefined,
  defaultEnabled = true,
): ScopableOptions => {
  if (typeof val === "boolean") {
    return { enabled: val };
  }
  if (typeof val === "object" && val !== null) {
    return {
      enabled: val.enabled ?? defaultEnabled,
      include: val.include,
      exclude: val.exclude,
    };
  }
  return { enabled: defaultEnabled };
};

const isPlainObject = (val: unknown): val is Record<string, unknown> => {
  return (
    val !== null &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    typeof val !== "function"
  );
};

export const deepMerge = <T extends Record<string, any>>(
  target: T,
  ...sources: (Record<string, any> | undefined)[]
): T => {
  const result = { ...target } as Record<string, any>;
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of Object.keys(source)) {
      const sourceVal = source[key];
      if (sourceVal === undefined) continue;
      const targetVal = result[key];
      if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
        result[key] = deepMerge(targetVal, sourceVal);
      } else {
        result[key] = sourceVal;
      }
    }
  }
  return result as T;
};

export const devDefaultConfig: Partial<UserConfig> = {};

export const serverDefaultConfig: Partial<UserConfig> = {
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
  scripts: {
    onBuildScriptError: "error",
    onRoutesScriptError: "error",
    onServerScriptError: "error",
  },
  onMinifyError: "error",
  http: {
    httpCache: true,
    rateLimit: true,
  },
};

export const buildDefaultConfig: Partial<UserConfig> = {
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
  scripts: {
    onBuildScriptError: "error",
    onRoutesScriptError: "error",
    onServerScriptError: "error",
  },
  onMinifyError: "error",
};

export const defaultConfig: Omit<BascikConfigOptions, "isBuild" | "isProdServer"> = {
  directory: {
    pages: "src/pages",
    components: "src/components",
    out: "dist",
    public: undefined,
    api: "src/api",
  },
  scoping: {
    scriptBlocks: true,
    inheritAttributes: true,
    attributes: {
      class: true,
      id: true,
      name: true,
    },
    preserve: ["code"],
    deduplicateCss: true,
  },
  minify: {
    html: false,
    css: false,
    js: false,
    identifiers: false,
  },
  assets: {
    inlineStyles: false,
    exclude: [],
  },
  generate: {
    sitemap: true,
    robots: true,
    sitemapLastmod: false,
    cspHashes: false,
    manifest: false,
  },
  pipeline: {
    watchPaths: [],
    exec: undefined,
    workers: false,
  },
  scripts: {
    cache: { enabled: true },
    onBuildScriptError: "error",
    onRoutesScriptError: "error",
    onServerScriptError: "error",
    timeout: 30000,
  },
  onMinifyError: "warn",
  http: {
    httpCache: false,
    port: undefined,
    hostname: "localhost",
    tls: {
      enabled: false,
      keyFile: undefined,
      certFile: undefined,
    },
    rateLimit: true,
    trustProxy: false,
    cacheControl: "public, max-age=3600",
    compression: true,
    timeouts: undefined,
    maxBodySize: 1048576,
    apiTimeout: 10000,
  },
  logging: {
    level: "info",
    requests: true,
    copies: true,
    deletes: true,
    transpiles: true,
  },
  base: "/",
};

export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const shouldLog = (
  configuredLevel: LogLevel | undefined,
  eventLevel: LogLevel = "info",
  defaultLevel: LogLevel = "info",
): boolean => {
  const resolvedLevel = configuredLevel ?? defaultLevel;
  return LOG_LEVELS.indexOf(resolvedLevel) >= LOG_LEVELS.indexOf(eventLevel);
};

/**
 * Recursively freeze the config object. `Object.freeze` alone is shallow —
 * without this, nested objects (`directory`, `scopeAttribute`, `generate`,
 * `serve`) would remain mutable at runtime.
 */
const deepFreeze = <T>(value: T): Readonly<T> => {
  // Only freeze plain objects/arrays. Functions (e.g. a custom `minify.js`
  // implementation) are left untouched — freezing a function would break any
  // internal state it carries, and functions hold no mutable config values.
  if (
    value !== null &&
    typeof value !== "function" &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

const VALID_EXEC_PHASES = new Set(["pre", "post", "parallel"]);

const normalizeExec = (
  exec: ExecEntry[] | undefined,
): ExecEntry[] | undefined => {
  if (!exec || !Array.isArray(exec)) return undefined;
  return exec.map((entry) => {
    let phase = entry.phase ?? "pre";
    if (!VALID_EXEC_PHASES.has(phase)) {
      console.warn(
        `[bascik:config] Invalid exec phase "${phase}", falling back to "pre"`,
      );
      phase = "pre";
    }
    return {
      ...entry,
      phase: phase as ExecPhase,
    };
  });
};

/**
 * Merge the layered configs into the final, frozen `BascikConfig`.
 *
 * Layer order (lowest → highest precedence):
 *   defaultConfig → activeModeDefaultConfig → safeUserConfig → activeOverride
 *
 * Exported (pure) so tests can exercise the merge logic directly without
 * relying on module-cache manipulation of the argv/env-derived singleton.
 */
export const initBascikConfig = (
  userConfig: UserConfig = {},
  modeOverrides: { dev?: UserConfig; build?: UserConfig; server?: UserConfig } | UserConfig = {},
  flags: { isBuild?: boolean; isProdServer?: boolean } = {},
) => {
  const safeUserConfig = typeof userConfig === "object" && userConfig !== null ? userConfig : {};
  const isBuild = flags.isBuild ?? false;
  const isProdServer = flags.isProdServer ?? false;
  const activeMode: "dev" | "build" | "server" = isBuild ? "build" : isProdServer ? "server" : "dev";

  let activeOverride: UserConfig = {};
  if (typeof modeOverrides === "object" && modeOverrides !== null) {
    if ("dev" in modeOverrides || "build" in modeOverrides || "server" in modeOverrides) {
      const typedOverrides = modeOverrides as { dev?: UserConfig; build?: UserConfig; server?: UserConfig };
      activeOverride = typedOverrides[activeMode] ?? {};
    } else {
      if (activeMode !== "dev") {
        activeOverride = modeOverrides as UserConfig;
      }
    }
  }

  const activeModeDefaultConfig =
    activeMode === "build"
      ? buildDefaultConfig
      : activeMode === "server"
        ? serverDefaultConfig
        : devDefaultConfig;

  const merged = deepMerge<BascikConfigOptions>(
    {} as BascikConfigOptions,
    defaultConfig as unknown as BascikConfigOptions,
    activeModeDefaultConfig as unknown as BascikConfigOptions,
    safeUserConfig as unknown as BascikConfigOptions,
    activeOverride as unknown as BascikConfigOptions,
  );

  if (typeof safeUserConfig.minify === "boolean") {
    merged.minify = {
      html: safeUserConfig.minify,
      css: safeUserConfig.minify,
      js: safeUserConfig.minify,
      identifiers: safeUserConfig.minify,
    };
  }
  if (typeof activeOverride.minify === "boolean") {
    merged.minify = {
      html: activeOverride.minify,
      css: activeOverride.minify,
      js: activeOverride.minify,
      identifiers: activeOverride.minify,
    };
  }

  const rawCache = merged.scripts?.cache;
  const normalizedCache = normalizeScopableOption(
    typeof rawCache === "boolean" || typeof rawCache === "object" ? rawCache : true,
  );

  const resolvedDirectory = { ...merged.directory };
  (["pages", "components", "out"] as const).forEach((key) => {
    if (resolvedDirectory[key]) {
      resolvedDirectory[key] = resolve(
        process.cwd(),
        resolvedDirectory[key]!,
      );
    }
  });

  const BascikConfig: BascikConfigOptions = {
    ...merged,
    directory: resolvedDirectory,
    scripts: {
      ...merged.scripts,
      cache: normalizedCache,
    },
    isBuild,
    isProdServer,
  };

  if (BascikConfig.pipeline?.exec) {
    BascikConfig.pipeline.exec = normalizeExec(BascikConfig.pipeline.exec);
  }

  return { BascikConfig: deepFreeze(BascikConfig) };
};

export const { BascikConfig } = initBascikConfig(
  config ?? {},
  modeOverrides ?? {},
  { isBuild, isProdServer },
);
