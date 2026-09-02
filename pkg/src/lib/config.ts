import { resolve } from "node:path";
import { config, modeOverrides } from "./userConfig.ts";
import { ensureEnvironmentReady } from "./environment.ts";
import { resolveCliAction } from "./cli.ts";
import {
  formatConfigErrors,
  normalizeBasePath,
  validateUserConfig,
  type ConfigValidationDeps,
} from "./config-validation.ts";
import type {
  BascikConfigOptions,
  UserConfig,
  ExecEntry,
  ExecPhase,
  ScopableConfig,
  ScopableOptions,
} from "./types.ts";

// Load .env files and apply CLI flag overrides (--site-url, --port, --host,
// --log-level) into the environment before anything reads it. A missing
// explicitly-passed --env-file fails here, at startup.
ensureEnvironmentReady();

// The CLI mode comes from the ONE argv parser in cli.ts, the same parser
// index.ts uses to pick the action, so the action and the resolved config can
// never drift: a flag the parser rejects can never reach the config.
const cliDecision = resolveCliAction(process.argv.slice(2));
const isBuild =
  cliDecision.action === "build" || parseInt(process.env.BASCIK_BUILD ?? "0") === 1;
const isProdServer =
  cliDecision.action === "server" ||
  parseInt(process.env.BASCIK_SERVER ?? "0") === 1;

process.env.BASCIK_BUILD = isBuild ? "1" : "0";
process.env.BASCIK_SERVER = isProdServer ? "1" : "0";

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
 * Deep-clone plain objects and arrays. Functions (e.g. a custom `minify.js`
 * implementation) and class instances pass through by reference: they cannot
 * be cloned, and they hold no mutable config values.
 *
 * The merge above keeps source arrays and untouched subtrees by reference, so
 * without this clone `deepFreeze` would freeze arrays inside the user's own
 * config module and inside the exported `defaultConfig` — a global side
 * effect on objects the caller still owns.
 */
const deepClone = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => deepClone(entry)) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
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

const normalizeExec = (
  exec: ExecEntry[] | undefined,
): ExecEntry[] | undefined => {
  if (!exec || !Array.isArray(exec)) return undefined;
  // Unknown phases never reach here: config validation rejects them first.
  return exec.map((entry) => ({
    ...entry,
    phase: (entry.phase ?? "pre") as ExecPhase,
  }));
};

/**
 * Merge the layered configs into the final, frozen `BascikConfig`.
 *
 * Layer order (lowest → highest precedence):
 *   defaultConfig → activeModeDefaultConfig → safeUserConfig → activeOverride
 *   → CLI flag / env var overrides (`flags.port`, `flags.host`, `flags.logLevel`)
 *
 * Exported (pure) so tests can exercise the merge logic directly without
 * relying on module-cache manipulation of the argv/env-derived singleton.
 */
export const initBascikConfig = (
  userConfig: UserConfig = {},
  modeOverrides: { dev?: UserConfig; build?: UserConfig; server?: UserConfig } | UserConfig = {},
  flags: {
    isBuild?: boolean;
    isProdServer?: boolean;
    port?: number;
    host?: string;
    logLevel?: LogLevel;
    only?: string[];
  } = {},
  deps: ConfigValidationDeps = {},
) => {
  const safeUserConfig = typeof userConfig === "object" && userConfig !== null ? userConfig : {};
  const isBuild = flags.isBuild ?? false;
  const isProdServer = flags.isProdServer ?? false;
  const activeMode: "dev" | "build" | "server" = isBuild ? "build" : isProdServer ? "server" : "dev";

  // Validate every config layer before anything consumes it. All problems
  // report together in one aggregated error rather than one fix-at-a-time.
  const validationErrors = validateUserConfig(safeUserConfig, modeOverrides, deps);
  if (validationErrors.length > 0) {
    throw new Error(formatConfigErrors(validationErrors));
  }

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

  // CLI flag / env var overrides beat every config-file layer
  // (flag > env var > config file).
  if (flags.port !== undefined || flags.host !== undefined) {
    merged.http = {
      ...merged.http,
      ...(flags.port !== undefined ? { port: flags.port } : {}),
      ...(flags.host !== undefined ? { hostname: flags.host } : {}),
    };
  }
  if (flags.logLevel !== undefined) {
    merged.logging = { ...merged.logging, level: flags.logLevel };
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
    // Validated above as a non-URL path; normalize missing slashes rather
    // than rejecting a value like "docs" that has one clear meaning.
    base: normalizeBasePath(merged.base),
    scripts: {
      ...merged.scripts,
      cache: normalizedCache,
    },
    isBuild,
    isProdServer,
    ...(flags.only && flags.only.length > 0 ? { only: flags.only } : {}),
  };

  if (BascikConfig.pipeline?.exec) {
    BascikConfig.pipeline.exec = normalizeExec(BascikConfig.pipeline.exec);
  }

  return { BascikConfig: deepFreeze(deepClone(BascikConfig)) };
};

// Flag values were written into the environment by ensureEnvironmentReady
// above (worker threads do not inherit process.argv), so this one env read
// covers both the flag and the plain env var, with the flag winning.
const envLogLevel = process.env.BASCIK_LOG_LEVEL;
if (envLogLevel !== undefined && !(LOG_LEVELS as readonly string[]).includes(envLogLevel)) {
  throw new Error(
    `[bascik] error: invalid BASCIK_LOG_LEVEL "${envLogLevel}".\n` +
    `  Expected one of: ${LOG_LEVELS.join(", ")}.`,
  );
}
// Lenient like server.ts: a malformed port env var is ignored, not fatal.
const envPortRaw = process.env.BASCIK_SERVER_PORT;
const envPortParsed = envPortRaw ? Number.parseInt(envPortRaw, 10) : undefined;
const envPort =
  envPortParsed !== undefined &&
    Number.isInteger(envPortParsed) &&
    envPortParsed >= 1 &&
    envPortParsed <= 65535
    ? envPortParsed
    : undefined;
const envHost = process.env.BASCIK_SERVER_HOST?.trim() || undefined;

export const { BascikConfig } = initBascikConfig(
  config ?? {},
  modeOverrides ?? {},
  {
    isBuild,
    isProdServer,
    port: envPort,
    host: envHost,
    logLevel: envLogLevel as LogLevel | undefined,
    only: cliDecision.flags.only,
  },
);
