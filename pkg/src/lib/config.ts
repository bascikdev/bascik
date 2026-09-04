import { resolve, sep, relative } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { config, modeOverrides } from "./userConfig.ts";
import { ensureEnvironmentReady } from "./environment.ts";
import { resolveCliAction } from "./cli.ts";
import {
  collectConfigWarnings,
  formatConfigErrors,
  normalizeBasePath,
  validateUserConfig,
  type ConfigValidationDeps,
  type ConfigValidationError,
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
    components: ["src/components"],
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
    // Kept relative (not resolved here) so worker threads and the main thread
    // resolve it identically against process.cwd() at use sites.
    importRoot: "src",
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

/**
 * Normalize `directory.components` (string | string[]) into an ordered array
 * of absolute roots. Each entry is resolved against `cwd` and, when it exists,
 * replaced by its realpath so `a` and `link-to-a` compare equal. A missing
 * directory keeps its resolved path so a fresh project with no components yet
 * still boots.
 *
 * Two structural rules are enforced here, because they need the filesystem
 * and therefore cannot live in the pure shape validator:
 *   - duplicates by realpath are rejected (same directory spelled twice, or
 *     reached through a symlink)
 *   - a root nested inside another root is rejected, because the parent
 *     already covers it and scanning both would double-report every file
 * Errors use the validator's formatting so the user sees one consistent
 * "Configuration errors" block.
 */
export const normalizeComponentRoots = (
  input: string | string[] | undefined,
  cwd: string,
): string[] => {
  const entries = input === undefined ? ["src/components"] : Array.isArray(input) ? input : [input];
  const canonical = entries.map((entry) => {
    const resolved = resolve(cwd, entry);
    if (!existsSync(resolved)) return resolved;
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  });

  const errors: ConfigValidationError[] = [];
  const display = (index: number): string => {
    const rel = relative(cwd, canonical[index]).replace(/\\/g, "/");
    return rel || ".";
  };
  for (let i = 0; i < canonical.length; i++) {
    for (let j = i + 1; j < canonical.length; j++) {
      const a = canonical[i];
      const b = canonical[j];
      if (a === b) {
        errors.push({
          key: "directory.components",
          value: [entries[i], entries[j]],
          message: `"${entries[i]}" and "${entries[j]}" are the same directory (${display(i)}). List each root once.`,
        });
      } else if (b.startsWith(a + sep)) {
        errors.push({
          key: "directory.components",
          value: entries[j],
          message: `"${display(j)}" is inside "${display(i)}"; the parent already includes it. Remove the nested entry.`,
        });
      } else if (a.startsWith(b + sep)) {
        errors.push({
          key: "directory.components",
          value: entries[i],
          message: `"${display(i)}" is inside "${display(j)}"; the parent already includes it. Remove the nested entry.`,
        });
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(formatConfigErrors(errors));
  }
  return canonical;
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
    allowInvalidConfig?: boolean;
  } = {},
  deps: ConfigValidationDeps = {},
) => {
  const safeUserConfig = typeof userConfig === "object" && userConfig !== null ? userConfig : {};
  let effectiveUserConfig: UserConfig = safeUserConfig;
  let effectiveModeOverrides: { dev?: UserConfig; build?: UserConfig; server?: UserConfig } | UserConfig = modeOverrides;
  const isBuild = flags.isBuild ?? false;
  const isProdServer = flags.isProdServer ?? false;
  const activeMode: "dev" | "build" | "server" = isBuild ? "build" : isProdServer ? "server" : "dev";

  // Validate every config layer before anything consumes it. All problems
  // report together in one aggregated error rather than one fix-at-a-time.
  const validationErrors = validateUserConfig(safeUserConfig, modeOverrides, deps);
  if (validationErrors.length > 0) {
    if (flags.allowInvalidConfig === true) {
      effectiveUserConfig = {};
      effectiveModeOverrides = {};
    } else {
      throw new Error(formatConfigErrors(validationErrors));
    }
  }

  // Non-fatal findings (e.g. a missing scripts.importRoot directory) are
  // reported once and never abort startup.
  for (const warning of collectConfigWarnings(safeUserConfig, { fs: deps.fs, cwd: deps.cwd })) {
    console.warn(`[bascik] warning: ${warning.key} ${JSON.stringify(warning.value)}: ${warning.message}`);
  }

  let activeOverride: UserConfig = {};
  if (typeof effectiveModeOverrides === "object" && effectiveModeOverrides !== null) {
    if ("dev" in effectiveModeOverrides || "build" in effectiveModeOverrides || "server" in effectiveModeOverrides) {
      const typedOverrides = effectiveModeOverrides as { dev?: UserConfig; build?: UserConfig; server?: UserConfig };
      activeOverride = typedOverrides[activeMode] ?? {};
    } else {
      if (activeMode !== "dev") {
        activeOverride = effectiveModeOverrides as UserConfig;
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
    effectiveUserConfig as unknown as BascikConfigOptions,
    activeOverride as unknown as BascikConfigOptions,
  );

  if (typeof effectiveUserConfig.minify === "boolean") {
    merged.minify = {
      html: effectiveUserConfig.minify,
      css: effectiveUserConfig.minify,
      js: effectiveUserConfig.minify,
      identifiers: effectiveUserConfig.minify,
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
  (["pages", "out"] as const).forEach((key) => {
    if (resolvedDirectory[key]) {
      resolvedDirectory[key] = resolve(
        process.cwd(),
        resolvedDirectory[key]!,
      );
    }
  });
  // The user layer may still hold a bare string; deepMerge does not touch
  // leaves, so this is the one place the shape is normalized to string[].
  resolvedDirectory.components = normalizeComponentRoots(
    resolvedDirectory.components as unknown as string | string[] | undefined,
    process.cwd(),
  );

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
    allowInvalidConfig: cliDecision.action === "check",
  },
);
