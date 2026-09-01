/**
 * @module config-validation
 *
 * Startup validation for bascik.config.
 *
 * Two halves, kept apart so the pure half unit tests without any mocking:
 *
 *   validateConfigShape  — pure: unknown keys, types, ranges, enums, globs.
 *                          Takes no filesystem and performs no I/O.
 *   validateConfigPaths  — I/O: existence and readability of user-supplied
 *                          paths. The filesystem is injected; the default is
 *                          node:fs. There is no global skip flag.
 *
 * validateUserConfig orchestrates both halves across the default export and
 * the mode overrides, appends the site URL check (owned by environment.ts)
 * so every problem reports together, and dedupes errors shared by layers.
 */

import { existsSync, statSync, accessSync, constants } from "node:fs";
import { resolve, sep } from "node:path";
import { SITE_URL_ENV_VAR, validateSiteUrl } from "./environment.ts";

export interface ConfigValidationError {
  /** Dotted key path, e.g. "http.port" or "pipeline.exec[0].script". */
  key: string;
  /** The received value. Undefined for unknown keys. */
  value: unknown;
  /** What was expected, or a "did you mean" suggestion. */
  message: string;
  /** True when the key itself is not a known configuration option. */
  unknownKey?: boolean;
}

/** Minimal filesystem surface used by the I/O half. Injectable for tests. */
export interface ConfigValidationFs {
  existsSync(path: string): boolean;
  isDirectory(path: string): boolean;
  isReadableFile(path: string): boolean;
}

export interface ConfigValidationDeps {
  fs?: ConfigValidationFs;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const defaultFs: ConfigValidationFs = {
  existsSync: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isReadableFile: (path) => {
    try {
      accessSync(path, constants.R_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
  val !== null && typeof val === "object" && !Array.isArray(val);

/* ── Known key schema ─────────────────────────────────────────────────── */

/** Nested map of every known config key. Leaf value is null. */
const KNOWN_KEYS: Record<string, unknown> = {
  directory: { pages: null, components: null, out: null, public: null, api: null },
  scoping: {
    scriptBlocks: null,
    inheritAttributes: null,
    attributes: { class: null, id: null, name: null },
    preserve: null,
    deduplicateCss: null,
  },
  minify: { html: null, css: null, js: null, identifiers: null },
  assets: { inlineStyles: null, exclude: null },
  generate: { sitemap: null, robots: null, sitemapLastmod: null, cspHashes: null, manifest: null },
  pipeline: { watchPaths: null, exec: null, workers: null },
  scripts: {
    cache: { enabled: null, include: null, exclude: null },
    onBuildScriptError: null,
    onRoutesScriptError: null,
    onServerScriptError: null,
    timeout: null,
  },
  onMinifyError: null,
  http: {
    httpCache: null,
    port: null,
    hostname: null,
    tls: { enabled: null, keyFile: null, certFile: null },
    rateLimit: { window: null, max: null },
    trustProxy: null,
    cacheControl: null,
    compression: null,
    timeouts: { request: null, headers: null, keepAlive: null },
    maxBodySize: null,
    apiTimeout: null,
  },
  logging: { level: null, requests: null, copies: null, deletes: null, transpiles: null },
  base: null,
};

const KNOWN_EXEC_ENTRY_KEYS = ["script", "watch", "phase"];

/* ── Edit-distance suggestions ────────────────────────────────────────── */

const editDistance = (a: string, b: string): number => {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = up;
    }
  }
  return prev[b.length];
};

/** Suggest the closest known key within a small edit distance, if any. */
const suggestKey = (key: string, known: string[], pathPrefix: string): string => {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best !== undefined && bestDistance <= 2) {
    return `did you mean "${pathPrefix}${best}"?`;
  }
  return "not a known configuration option";
};

/* ── Base path normalization ──────────────────────────────────────────── */

/**
 * Normalize `base` to a leading and trailing slash. Assumes the value has
 * already passed validation (a string that is not a URL). "/" stays "/".
 */
export const normalizeBasePath = (base: string): string => {
  let normalized = base.trim();
  if (normalized === "" || normalized === "/") return "/";
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (!normalized.endsWith("/")) normalized = `${normalized}/`;
  return normalized;
};

/* ── Pure validation half ─────────────────────────────────────────────── */

const VALID_EXEC_PHASES = ["pre", "post", "parallel"];
const SCRIPT_ERROR_ACTIONS = ['"warn", "error", or "ignore"'];
const VALID_SCRIPT_ERROR_VALUES = new Set(["warn", "error", "ignore"]);
const VALID_MINIFY_ERROR_VALUES = new Set(["warn", "error"]);
const VALID_LOG_LEVELS = new Set(["silent", "error", "warn", "info", "debug"]);

const PLAUSIBLE_TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,49}$/;
const PLAUSIBLE_HOSTNAME = /^[a-zA-Z0-9._:-]+$/;

/** A "valid glob" here: a non-empty string with balanced square brackets. */
const isPlausibleGlob = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return false;
  }
  let depth = 0;
  for (const char of value) {
    if (char === "[") depth++;
    if (char === "]") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
};

const collectUnknownKeys = (
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  pathPrefix: string,
  errors: ConfigValidationError[],
): void => {
  for (const key of Object.keys(value)) {
    const fullKey = `${pathPrefix}${key}`;
    if (!(key in schema)) {
      errors.push({
        key: fullKey,
        value: undefined,
        message: suggestKey(key, Object.keys(schema), pathPrefix),
        unknownKey: true,
      });
      continue;
    }
    const child = schema[key];
    const childValue = value[key];
    // Recurse only when both schema and value are plain objects. Values that
    // legitimately accept a boolean-or-object (minify, scripts.cache,
    // http.rateLimit) skip recursion for their non-object forms.
    if (isPlainObject(child) && isPlainObject(childValue)) {
      collectUnknownKeys(childValue, child, `${fullKey}.`, errors);
    }
    // Exec entries have their own key set.
    if (key === "exec" && Array.isArray(childValue)) {
      childValue.forEach((entry, index) => {
        if (!isPlainObject(entry)) return;
        for (const entryKey of Object.keys(entry)) {
          if (!KNOWN_EXEC_ENTRY_KEYS.includes(entryKey)) {
            errors.push({
              key: `${fullKey}[${index}].${entryKey}`,
              value: undefined,
              message: suggestKey(entryKey, KNOWN_EXEC_ENTRY_KEYS, `${fullKey}[${index}].`),
              unknownKey: true,
            });
          }
        }
      });
    }
  }
};

/**
 * Pure validation: unknown keys, types, ranges, enums, glob and tag-name
 * plausibility, and the `directory.out` escape check (string math against
 * the injected cwd). Performs no filesystem access.
 */
export const validateConfigShape = (
  raw: unknown,
  opts: { cwd?: string } = {},
): ConfigValidationError[] => {
  const errors: ConfigValidationError[] = [];
  const cwd = opts.cwd ?? process.cwd();

  if (!isPlainObject(raw)) {
    if (raw === undefined || raw === null) return errors;
    return [{ key: "(config)", value: raw, message: "expected an object" }];
  }

  collectUnknownKeys(raw, KNOWN_KEYS, "", errors);

  const push = (key: string, value: unknown, message: string): void => {
    errors.push({ key, value, message });
  };

  /* directory */
  if (isPlainObject(raw.directory)) {
    const dir = raw.directory;
    for (const key of ["pages", "components", "out", "public", "api"] as const) {
      const value = dir[key];
      if (value !== undefined && typeof value !== "string") {
        push(`directory.${key}`, value, "expected a string path");
      }
    }
    if (typeof dir.out === "string") {
      const root = resolve(cwd);
      const resolvedOut = resolve(cwd, dir.out);
      if (resolvedOut !== root && !resolvedOut.startsWith(root + sep)) {
        push(
          "directory.out",
          dir.out,
          "resolves outside the project root; the output directory must stay inside the project",
        );
      }
    }
  }

  /* minify */
  if (raw.minify !== undefined) {
    if (typeof raw.minify === "boolean") {
      // valid shorthand
    } else if (isPlainObject(raw.minify)) {
      for (const key of ["css", "js"] as const) {
        const value = raw.minify[key];
        if (
          value !== undefined &&
          typeof value !== "boolean" &&
          typeof value !== "function"
        ) {
          push(`minify.${key}`, value, "expected true, false, or a function");
        }
      }
      for (const key of ["html", "identifiers"] as const) {
        const value = raw.minify[key];
        if (value !== undefined && typeof value !== "boolean") {
          push(`minify.${key}`, value, "expected true or false");
        }
      }
    } else {
      push("minify", raw.minify, "expected a boolean or an object");
    }
  }

  /* http */
  if (isPlainObject(raw.http)) {
    const http = raw.http;
    if (http.port !== undefined) {
      const port = http.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        push("http.port", port, "expected an integer between 1 and 65535");
      }
    }
    if (http.hostname !== undefined) {
      const hostname = http.hostname;
      if (
        typeof hostname !== "string" ||
        hostname.length === 0 ||
        hostname.includes("://") ||
        hostname.includes("/") ||
        hostname.includes("\\") ||
        /\s/.test(hostname) ||
        !PLAUSIBLE_HOSTNAME.test(hostname)
      ) {
        push(
          "http.hostname",
          hostname,
          'expected a hostname like "localhost" or "example.com", not a URL or path',
        );
      }
    }
    if (isPlainObject(http.tls)) {
      const tls = http.tls;
      if (tls.enabled !== undefined && typeof tls.enabled !== "boolean") {
        push("http.tls.enabled", tls.enabled, "expected true or false");
      }
      for (const key of ["keyFile", "certFile"] as const) {
        const value = tls[key];
        if (value !== undefined && typeof value !== "string") {
          push(`http.tls.${key}`, value, "expected a string path");
        }
      }
    }
  }

  /* scripts */
  if (isPlainObject(raw.scripts)) {
    const scripts = raw.scripts;
    if (scripts.timeout !== undefined) {
      const timeout = scripts.timeout;
      if (typeof timeout !== "number" || Number.isNaN(timeout) || timeout <= 0) {
        push("scripts.timeout", timeout, "expected a positive number (milliseconds)");
      }
    }
    for (const key of ["onBuildScriptError", "onRoutesScriptError", "onServerScriptError"] as const) {
      const value = scripts[key];
      if (value !== undefined && !VALID_SCRIPT_ERROR_VALUES.has(value as string)) {
        push(`scripts.${key}`, value, `expected ${SCRIPT_ERROR_ACTIONS}`);
      }
    }
  }

  if (raw.onMinifyError !== undefined && !VALID_MINIFY_ERROR_VALUES.has(raw.onMinifyError as string)) {
    push("onMinifyError", raw.onMinifyError, 'expected "warn" or "error"');
  }

  /* pipeline */
  if (isPlainObject(raw.pipeline)) {
    const pipeline = raw.pipeline;
    if (pipeline.workers !== undefined) {
      const workers = pipeline.workers;
      const valid =
        typeof workers === "boolean" ||
        (typeof workers === "number" && Number.isInteger(workers) && workers > 0);
      if (!valid) {
        push("pipeline.workers", workers, "expected true, false, or a positive integer");
      }
    }
    if (pipeline.watchPaths !== undefined) {
      const watchPaths = pipeline.watchPaths;
      if (!Array.isArray(watchPaths)) {
        push("pipeline.watchPaths", watchPaths, "expected an array of path strings");
      } else {
        watchPaths.forEach((entry, index) => {
          if (typeof entry !== "string" || entry.length === 0) {
            push(`pipeline.watchPaths[${index}]`, entry, "expected a non-empty path string");
          }
        });
      }
    }
    if (pipeline.exec !== undefined) {
      const exec = pipeline.exec;
      if (!Array.isArray(exec)) {
        push("pipeline.exec", exec, "expected an array of exec entries");
      } else {
        exec.forEach((entry, index) => {
          if (!isPlainObject(entry)) {
            push(`pipeline.exec[${index}]`, entry, "expected an object with a script key");
            return;
          }
          if (typeof entry.script !== "string" || entry.script.length === 0) {
            push(`pipeline.exec[${index}].script`, entry.script, "expected a non-empty script path");
          }
          if (entry.phase !== undefined && !VALID_EXEC_PHASES.includes(entry.phase as string)) {
            push(`pipeline.exec[${index}].phase`, entry.phase, 'expected "pre", "post", or "parallel"');
          }
        });
      }
    }
  }

  /* assets */
  if (isPlainObject(raw.assets)) {
    const assets = raw.assets;
    if (assets.inlineStyles !== undefined) {
      const inlineStyles = assets.inlineStyles;
      if (typeof inlineStyles !== "boolean" && !Array.isArray(inlineStyles)) {
        push("assets.inlineStyles", inlineStyles, "expected true, false, or an array of stylesheet paths");
      } else if (Array.isArray(inlineStyles)) {
        inlineStyles.forEach((entry, index) => {
          if (typeof entry !== "string" || entry.length === 0) {
            push(`assets.inlineStyles[${index}]`, entry, "expected a non-empty stylesheet path");
          }
        });
      }
    }
    if (assets.exclude !== undefined) {
      const exclude = assets.exclude;
      if (!Array.isArray(exclude)) {
        push("assets.exclude", exclude, "expected an array of glob strings");
      } else {
        exclude.forEach((entry, index) => {
          if (!isPlausibleGlob(entry)) {
            push(`assets.exclude[${index}]`, entry, "expected a non-empty glob string with balanced brackets");
          }
        });
      }
    }
  }

  /* scoping */
  if (isPlainObject(raw.scoping) && raw.scoping.preserve !== undefined) {
    const preserve = raw.scoping.preserve;
    if (!Array.isArray(preserve)) {
      push("scoping.preserve", preserve, "expected an array of tag names");
    } else {
      preserve.forEach((entry, index) => {
        if (typeof entry !== "string" || !PLAUSIBLE_TAG_NAME.test(entry)) {
          push(`scoping.preserve[${index}]`, entry, 'expected a plausible HTML tag name like "code" or "my-element"');
        }
      });
    }
  }

  /* logging */
  if (isPlainObject(raw.logging)) {
    const level = raw.logging.level;
    if (level !== undefined && !VALID_LOG_LEVELS.has(level as string)) {
      push("logging.level", level, 'expected "silent", "error", "warn", "info", or "debug"');
    }
  }

  /* base */
  if (raw.base !== undefined) {
    const base = raw.base;
    if (typeof base !== "string") {
      push("base", base, 'expected a root-relative path like "/docs/"');
    } else if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(base) || /^[a-zA-Z]:[\\/]/.test(base)) {
      push("base", base, 'expected a root-relative path like "/docs/", not a URL');
    }
  }

  return errors;
};

/* ── I/O validation half ──────────────────────────────────────────────── */

/**
 * Filesystem validation: existence and readability of user-supplied paths.
 * Only paths the user explicitly set are checked; built-in defaults are
 * trusted (a missing default pages directory is reported by the build's
 * runtime half). The filesystem is injected — there is no skip flag.
 */
export const validateConfigPaths = (
  raw: unknown,
  deps: { fs?: ConfigValidationFs; cwd?: string } = {},
): ConfigValidationError[] => {
  const errors: ConfigValidationError[] = [];
  if (!isPlainObject(raw)) return errors;

  const fs = deps.fs ?? defaultFs;
  const cwd = deps.cwd ?? process.cwd();
  const resolvePath = (path: string): string => resolve(cwd, path);

  const push = (key: string, value: unknown, message: string): void => {
    errors.push({ key, value, message });
  };

  if (isPlainObject(raw.directory)) {
    const dir = raw.directory;
    if (typeof dir.pages === "string") {
      if (!fs.existsSync(resolvePath(dir.pages))) {
        push("directory.pages", dir.pages, "directory does not exist");
      } else if (!fs.isDirectory(resolvePath(dir.pages))) {
        push("directory.pages", dir.pages, "expected a directory");
      }
    }
    if (typeof dir.public === "string" && !fs.isDirectory(resolvePath(dir.public))) {
      push("directory.public", dir.public, "directory does not exist");
    }
  }

  if (isPlainObject(raw.http) && isPlainObject(raw.http.tls) && raw.http.tls.enabled === true) {
    for (const key of ["keyFile", "certFile"] as const) {
      const value = raw.http.tls[key];
      if (typeof value === "string" && !fs.isReadableFile(resolvePath(value))) {
        push(`http.tls.${key}`, value, "file does not exist or is not readable");
      }
    }
  }

  if (isPlainObject(raw.pipeline)) {
    const pipeline = raw.pipeline;
    if (Array.isArray(pipeline.watchPaths)) {
      pipeline.watchPaths.forEach((entry, index) => {
        if (typeof entry === "string" && entry.length > 0 && !fs.existsSync(resolvePath(entry))) {
          push(`pipeline.watchPaths[${index}]`, entry, "path does not exist");
        }
      });
    }
    if (Array.isArray(pipeline.exec)) {
      pipeline.exec.forEach((entry, index) => {
        if (
          isPlainObject(entry) &&
          typeof entry.script === "string" &&
          entry.script.length > 0 &&
          !fs.existsSync(resolvePath(entry.script))
        ) {
          push(`pipeline.exec[${index}].script`, entry.script, "file does not exist");
        }
      });
    }
  }

  if (isPlainObject(raw.assets) && Array.isArray(raw.assets.inlineStyles)) {
    raw.assets.inlineStyles.forEach((entry, index) => {
      if (typeof entry === "string" && entry.length > 0 && !fs.existsSync(resolvePath(entry))) {
        push(`assets.inlineStyles[${index}]`, entry, "file does not exist");
      }
    });
  }

  return errors;
};

/* ── Orchestration ────────────────────────────────────────────────────── */

const errorSignature = (error: ConfigValidationError): string =>
  `${error.key}${error.message}${String(error.value)}`;

/**
 * Validate the user config and mode overrides together. Runs the pure half
 * and the (injected) filesystem half for every config layer, checks the
 * site URL from the environment so it reports in the same pass, and dedupes
 * errors shared across layers.
 */
export const validateUserConfig = (
  userConfig: unknown,
  modeOverrides: unknown,
  deps: ConfigValidationDeps = {},
): ConfigValidationError[] => {
  const layers: unknown[] = [userConfig];

  if (isPlainObject(modeOverrides)) {
    if ("dev" in modeOverrides || "build" in modeOverrides || "server" in modeOverrides) {
      for (const mode of ["dev", "build", "server"] as const) {
        if (mode in modeOverrides) layers.push(modeOverrides[mode]);
      }
    } else {
      layers.push(modeOverrides);
    }
  }

  const errors: ConfigValidationError[] = [];
  for (const layer of layers) {
    errors.push(...validateConfigShape(layer, { cwd: deps.cwd }));
    errors.push(...validateConfigPaths(layer, { fs: deps.fs, cwd: deps.cwd }));
  }

  // Site URL: owned by environment.ts, validated here so an invalid value
  // reports together with every other configuration error.
  const env = deps.env ?? process.env;
  const siteUrl = env[SITE_URL_ENV_VAR];
  if (siteUrl !== undefined && siteUrl !== "") {
    try {
      validateSiteUrl(siteUrl);
    } catch {
      errors.push({
        key: SITE_URL_ENV_VAR,
        value: siteUrl,
        message: 'expected an absolute http or https URL, e.g. "https://example.com"',
      });
    }
  }

  const seen = new Set<string>();
  return errors.filter((error) => {
    const signature = errorSignature(error);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
};

/* ── Output formatting ────────────────────────────────────────────────── */

const formatValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "[function]";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Render the aggregated error report: errors grouped by key, each naming
 * the key, the received value, and the expectation.
 *
 *   Configuration errors in bascik.config.ts
 *
 *     http.port                70000
 *                              expected an integer between 1 and 65535
 *
 *   1 configuration error
 */
export const formatConfigErrors = (
  errors: ConfigValidationError[],
  sourceName = "bascik.config.ts",
): string => {
  const width = Math.max(...errors.map((error) => error.key.length));
  const valueColumn = width + 2;
  const blocks = errors.map((error) => {
    const displayValue = error.unknownKey ? "unknown key" : formatValue(error.value);
    const head = `  ${error.key.padEnd(valueColumn)}${displayValue}`;
    const tail = `${" ".repeat(valueColumn + 2)}${error.message}`;
    return `${head}\n${tail}`;
  });
  const count = `${errors.length} configuration error${errors.length === 1 ? "" : "s"}`;
  return `Configuration errors in ${sourceName}\n\n${blocks.join("\n\n")}\n\n${count}`;
};
