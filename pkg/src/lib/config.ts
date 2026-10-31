import { basename, resolve, sep, relative } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { config, modeOverrides } from "./userConfig.ts";
import { findConfigFile } from "./config-file-names.ts";
import { ensureEnvironmentReady } from "./environment.ts";
import { resolveCliAction } from "./cli.ts";
import { LOG_LEVELS, shouldLog, type LogLevel } from "./log-level.ts";
import { stderr as colorErr } from "./colors.ts";
import {
  HOSTNAME_EXPECTATION,
  isPlausibleHostname,
  parsePort,
} from "./server-address.ts";
import {
  collectConfigWarnings,
  collectModeOverrideWarnings,
  DEFAULT_DIRECTORY,
  DEFAULT_HTTP_TIMEOUTS,
  DEFAULT_IMPORT_ROOT,
  defaultHeadersTimeout,
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
  cliDecision.action === "build" ||
  parseInt(process.env.BASCIK_BUILD ?? "0") === 1;
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
      environment: val.environment,
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

export const defaultConfig: Omit<
  BascikConfigOptions,
  "isBuild" | "isProdServer"
> = {
  directory: {
    pages: DEFAULT_DIRECTORY.pages,
    components: [DEFAULT_DIRECTORY.components],
    out: DEFAULT_DIRECTORY.out,
    api: DEFAULT_DIRECTORY.api,
  },
  components: {
    external: [],
    // Equal to BUILD_EXPANSION_LIMITS in component-expansion.ts (a unit test
    // pins them), kept as literals so config.ts never imports the renderer.
    expansionLimits: {
      maxInstances: 10_000,
      maxPageLength: 50 * 1024 * 1024,
    },
  },
  scoping: {
    scriptBlocks: true,
    inheritAttributes: true,
    attributes: {
      class: true,
      id: true,
      // `name` is a page-level contract (form submission keys, radio groups,
      // iframe targets, maps, exclusive accordions), so it ships as written.
      name: false,
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
    symlink: false,
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
    typescript: true,
    onBuildScriptError: "error",
    onRoutesScriptError: "error",
    onServerScriptError: "error",
    timeout: 30000,
    // Kept relative (not resolved here) so worker threads and the main thread
    // resolve it identically against process.cwd() at use sites.
    importRoot: DEFAULT_IMPORT_ROOT,
    stripAnsi: true,
    // Equal to REQUEST_RENDER_LIMITS in request-render.ts (a unit test pins
    // them).
    renderLimits: {
      maxInstances: 1000,
      maxOutputLength: 4 * 1024 * 1024,
      maxNestedScripts: 64,
      maxDepth: 4,
      rescanFactor: 16,
      rescanBase: 32 * 1024 * 1024,
    },
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
    precompress: false,
    // headers is filled after the merge: its default follows request down.
    timeouts: {
      request: DEFAULT_HTTP_TIMEOUTS.request,
      keepAlive: DEFAULT_HTTP_TIMEOUTS.keepAlive,
    },
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
  // Every protection that changes the author's output is on by default and
  // can be turned off by name (see docs/content/security.md).
  security: {
    blockScriptUrls: true,
    blockCodeBindings: true,
    headers: true,
    hsts: true,
    privateDynamicPages: true,
    stripDirectiveScripts: true,
    hideDotfiles: true,
  },
};

// The level list and comparison live in log-level.ts so the CLI parser and the config validator can share them
// without importing this module. Re-exported because this is where callers have always imported them from.
export { LOG_LEVELS, shouldLog };
export type { LogLevel };

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
  sourceName?: string,
): string[] => {
  const entries =
    input === undefined
      ? ["src/components"]
      : Array.isArray(input)
        ? input
        : [input];
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
    throw new Error(formatConfigErrors(errors, sourceName));
  }
  return canonical;
};

/**
 * A copy of one config layer without the settings validation rejected. An
 * error key such as `pipeline.exec[0].phase` or `http.cacheControl[".css"]`
 * drops the whole setting it belongs to (`pipeline.exec`,
 * `http.cacheControl`), so a half-valid list never reaches the merge.
 */
const withoutRejectedKeys = (
  layer: UserConfig | undefined,
  errors: ConfigValidationError[],
): UserConfig => {
  if (!isPlainObject(layer)) return {};
  const copy = deepClone(layer) as Record<string, unknown>;
  for (const error of errors) {
    const setting = error.key.split("[")[0];
    const path = setting.split(".");
    let parent: unknown = copy;
    for (const segment of path.slice(0, -1)) {
      parent = isPlainObject(parent) ? parent[segment] : undefined;
    }
    if (isPlainObject(parent)) delete parent[path[path.length - 1]];
  }
  return copy as UserConfig;
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
  modeOverrides:
    | { dev?: UserConfig; build?: UserConfig; server?: UserConfig }
    | UserConfig = {},
  flags: {
    isBuild?: boolean;
    isProdServer?: boolean;
    port?: number;
    host?: string;
    logLevel?: LogLevel;
    only?: string[];
    target?: BascikConfigOptions["target"];
    allowInvalidConfig?: boolean;
    /** The loaded config's filename, named in configuration errors. */
    configFile?: string;
  } = {},
  deps: ConfigValidationDeps = {},
) => {
  const safeUserConfig =
    typeof userConfig === "object" && userConfig !== null ? userConfig : {};
  let effectiveUserConfig: UserConfig = safeUserConfig;
  let effectiveModeOverrides:
    { dev?: UserConfig; build?: UserConfig; server?: UserConfig } | UserConfig =
    modeOverrides;
  const isBuild = flags.isBuild ?? false;
  const isProdServer = flags.isProdServer ?? false;
  const activeMode: "dev" | "build" | "server" = isBuild
    ? "build"
    : isProdServer
      ? "server"
      : "dev";

  // Validate every config layer before anything consumes it. All problems
  // report together in one aggregated error rather than one fix-at-a-time.
  const validationErrors = validateUserConfig(
    safeUserConfig,
    modeOverrides,
    deps,
  );
  if (validationErrors.length > 0) {
    if (flags.allowInvalidConfig === true) {
      // `bascik --check` reports these errors itself and checks the rest of
      // the project with what is left: drop only the rejected settings, so
      // a valid directory block keeps pointing the check at the right folders.
      effectiveUserConfig = withoutRejectedKeys(
        safeUserConfig,
        validationErrors,
      );
      effectiveModeOverrides = isPlainObject(modeOverrides)
        ? "dev" in modeOverrides ||
          "build" in modeOverrides ||
          "server" in modeOverrides
          ? Object.fromEntries(
              Object.entries(modeOverrides).map(([mode, layer]) => [
                mode,
                withoutRejectedKeys(layer as UserConfig, validationErrors),
              ]),
            )
          : withoutRejectedKeys(modeOverrides as UserConfig, validationErrors)
        : {};
    } else {
      throw new Error(formatConfigErrors(validationErrors, flags.configFile));
    }
  }

  // Non-fatal findings (e.g. a missing scripts.importRoot directory) are
  // reported once and never abort startup.
  for (const warning of [
    ...collectConfigWarnings(safeUserConfig, {
      fs: deps.fs,
      cwd: deps.cwd,
    }),
    ...collectModeOverrideWarnings(modeOverrides, safeUserConfig),
  ]) {
    console.warn(
      `${colorErr.tag("warn", "[bascik] warning:")} ${warning.key} ${JSON.stringify(warning.value)}: ${warning.message}`,
    );
  }

  let activeOverride: UserConfig = {};
  if (
    typeof effectiveModeOverrides === "object" &&
    effectiveModeOverrides !== null
  ) {
    if (
      "dev" in effectiveModeOverrides ||
      "build" in effectiveModeOverrides ||
      "server" in effectiveModeOverrides
    ) {
      const typedOverrides = effectiveModeOverrides as {
        dev?: UserConfig;
        build?: UserConfig;
        server?: UserConfig;
      };
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

  // `minify: true | false` is shorthand for all four minifiers. Expanding it
  // in each layer before the merge keeps the layer order: a boolean in the
  // default export is refined by an object in the mode export, and a boolean
  // in the mode export replaces an object in the default export.
  const expandMinify = (layer: UserConfig): UserConfig =>
    typeof layer.minify === "boolean"
      ? {
          ...layer,
          minify: {
            html: layer.minify,
            css: layer.minify,
            js: layer.minify,
            identifiers: layer.minify,
          },
        }
      : layer;

  const merged = deepMerge<BascikConfigOptions>(
    {} as BascikConfigOptions,
    defaultConfig as unknown as BascikConfigOptions,
    activeModeDefaultConfig as unknown as BascikConfigOptions,
    expandMinify(effectiveUserConfig) as unknown as BascikConfigOptions,
    expandMinify(activeOverride) as unknown as BascikConfigOptions,
  );

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
  if (merged.http.timeouts?.headers === undefined) {
    const request =
      merged.http.timeouts?.request ?? DEFAULT_HTTP_TIMEOUTS.request;
    merged.http = {
      ...merged.http,
      timeouts: {
        ...merged.http.timeouts,
        headers: defaultHeadersTimeout(request),
      },
    };
  }

  const rawCache = merged.scripts?.cache;
  const normalizedCache = normalizeScopableOption(
    typeof rawCache === "boolean" || typeof rawCache === "object"
      ? rawCache
      : true,
  );

  const resolvedDirectory = { ...merged.directory };
  (["pages", "out"] as const).forEach((key) => {
    if (resolvedDirectory[key]) {
      resolvedDirectory[key] = resolve(process.cwd(), resolvedDirectory[key]!);
    }
  });
  // The user layer may still hold a bare string; deepMerge does not touch
  // leaves, so this is the one place the shape is normalized to string[].
  resolvedDirectory.components = normalizeComponentRoots(
    resolvedDirectory.components as unknown as string | string[] | undefined,
    process.cwd(),
    flags.configFile,
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
    ...(flags.target ? { target: flags.target } : {}),
  };

  // contentSecurityPolicy needs each route's hashes: it turns on
  // generate.cspHashes unless the author set cspHashes explicitly.
  if (
    BascikConfig.contentSecurityPolicy &&
    effectiveUserConfig.generate?.cspHashes === undefined &&
    activeOverride.generate?.cspHashes === undefined
  ) {
    BascikConfig.generate = { ...BascikConfig.generate, cspHashes: true };
  }

  if (BascikConfig.pipeline?.exec) {
    BascikConfig.pipeline.exec = normalizeExec(BascikConfig.pipeline.exec);
  }

  return { BascikConfig: deepFreeze(deepClone(BascikConfig)) };
};

/**
 * `BASCIK_SERVER_PORT`, by the `--port` rule: whole digits from 1 to 65535.
 * A malformed value is ignored with a warning, never fatal and never partly
 * parsed (`8080abc` is not port 8080), so the configured port applies.
 */
export const readServerPortEnv = (
  raw: string | undefined,
): number | undefined => {
  if (!raw?.trim()) return undefined;
  const port = parsePort(raw);
  if (port !== undefined) return port;
  console.warn(
    `${colorErr.tag("warn", "[bascik] warning:")} ignoring BASCIK_SERVER_PORT ${JSON.stringify(raw)}: expected an integer between 1 and 65535.`,
  );
  return undefined;
};

/**
 * `BASCIK_SERVER_HOST`, by the `http.hostname` rule (`--host` is checked by
 * the CLI parser before it is written here). A URL or path is fatal, with
 * the variable named, instead of a getaddrinfo error at listen time.
 */
export const readServerHostEnv = (
  raw: string | undefined,
): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!isPlausibleHostname(value))
    throw new Error(
      `[bascik] error: invalid BASCIK_SERVER_HOST ${JSON.stringify(raw)}: ${HOSTNAME_EXPECTATION}.`,
    );
  return value;
};

// Flag values were written into the environment by ensureEnvironmentReady
// above (worker threads do not inherit process.argv), so this one env read
// covers both the flag and the plain env var, with the flag winning.
const envLogLevel = process.env.BASCIK_LOG_LEVEL;
if (
  envLogLevel !== undefined &&
  !(LOG_LEVELS as readonly string[]).includes(envLogLevel)
) {
  throw new Error(
    `[bascik] error: invalid BASCIK_LOG_LEVEL "${envLogLevel}".\n` +
      `  Expected one of: ${LOG_LEVELS.join(", ")}.`,
  );
}
const envPort = readServerPortEnv(process.env.BASCIK_SERVER_PORT);
const envHost = readServerHostEnv(process.env.BASCIK_SERVER_HOST);
// Configuration errors name the file that was loaded (bascik.config.mjs, a
// --config path), not a bascik.config.ts that may not exist.
const loadedConfigFile = findConfigFile(process.argv.slice(2)).path;

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
    target: cliDecision.flags.target,
    allowInvalidConfig: cliDecision.action === "check",
    configFile: loadedConfigFile && basename(loadedConfigFile),
  },
);
