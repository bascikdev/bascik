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

import {
  existsSync,
  statSync,
  lstatSync,
  accessSync,
  constants,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { SITE_URL_ENV_VAR, validateSiteUrl } from "./environment.ts";
import { LOG_LEVELS } from "./log-level.ts";
import { hostnameExpectation, isPlausibleHostname } from "./server-address.ts";
import {
  CSP_DIRECTIVES,
  CSP_KEYWORDS,
  isSourceListDirective,
} from "./content-security-policy-rules.ts";
import { sourceWatchRoot } from "./watch-root.ts";

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
  /**
   * The identity of the directory entry at a path (device and inode, the
   * final symlink not followed), or undefined when nothing is there. Absent:
   * the output-directory overlap check compares path strings only.
   */
  entryIdentity?(path: string): string | undefined;
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
  entryIdentity: (path) => entryIdentity(path),
};

/** The longest delay setTimeout honors; a longer one fires after 1 ms. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** One extension, dot optional: `.css` or `css`, never `*.css` or `a/b.css`. */
const CACHE_CONTROL_EXTENSION = /^\.?[^./\\*?\s]+$/;

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
  val !== null && typeof val === "object" && !Array.isArray(val);

/** True when `child` is `parent` or a path inside it (both absolute, resolved). */
export const isSameOrInside = (child: string, parent: string): boolean =>
  child === parent ||
  child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * The device and inode of the entry at `path`, without following a final
 * symlink (a recursive rm removes the link, not its target), or undefined
 * when nothing is there or the file system reports no inode (0).
 */
export const entryIdentity = (path: string): string | undefined => {
  try {
    const stats = lstatSync(path, { bigint: true });
    return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
};

/**
 * isSameOrInside, also true when `parent` exists and `child` or one of its
 * ancestors is that same folder on disk under another spelling. On a
 * case-insensitive file system (the macOS and Windows default) "SRC" is the
 * src folder, and a string comparison misses it; so does any other alias
 * that names the same entry (a bind mount, an 8.3 short name).
 */
export const isSameOrInsideOnDisk = (
  child: string,
  parent: string,
  identify: ((path: string) => string | undefined) | undefined = entryIdentity,
): boolean => {
  if (isSameOrInside(child, parent)) return true;
  if (!identify) return false;
  const parentIdentity = identify(parent);
  if (parentIdentity === undefined) return false;
  for (let path = child; ; path = dirname(path)) {
    if (identify(path) === parentIdentity) return true;
    if (dirname(path) === path) return false;
  }
};

/**
 * The built-in source and output folders. config.ts builds its defaults from
 * these, and the output-directory overlap check falls back to them for a
 * folder the config leaves unset.
 */
export const DEFAULT_DIRECTORY = {
  pages: "src/pages",
  components: "src/components",
  out: "dist",
  api: "src/api",
} as const;
export const DEFAULT_IMPORT_ROOT = "src";

/* ── Known key schema ─────────────────────────────────────────────────── */

/** Nested map of every known config key. Leaf value is null. */
const KNOWN_KEYS: Record<string, unknown> = {
  directory: { pages: null, components: null, out: null, api: null },
  components: {
    external: null,
    expansionLimits: { maxInstances: null, maxPageLength: null },
  },
  scoping: {
    scriptBlocks: null,
    inheritAttributes: null,
    attributes: { class: null, id: null, name: null },
    preserve: null,
    deduplicateCss: null,
  },
  minify: { html: null, css: null, js: null, identifiers: null },
  assets: { inlineStyles: null, exclude: null, symlink: null },
  generate: {
    sitemap: null,
    robots: null,
    sitemapLastmod: null,
    cspHashes: null,
    manifest: null,
  },
  pipeline: { watchPaths: null, exec: null, workers: null, onExecError: null },
  scripts: {
    cache: { enabled: null, include: null, exclude: null, environment: null },
    typescript: null,
    onBuildScriptError: null,
    onRoutesScriptError: null,
    onServerScriptError: null,
    timeout: null,
    importRoot: null,
    stripAnsi: null,
    renderLimits: {
      maxInstances: null,
      maxOutputLength: null,
      maxNestedScripts: null,
      maxDepth: null,
      rescanFactor: null,
      rescanBase: null,
    },
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
    precompress: null,
    timeouts: { request: null, headers: null, keepAlive: null, drain: null },
    maxBodySize: null,
    apiTimeout: null,
  },
  logging: {
    level: null,
    requests: null,
    copies: null,
    deletes: null,
    transpiles: null,
  },
  base: null,
  contentSecurityPolicy: {
    directives: null,
    hashes: { scripts: null, styles: null },
    reportOnly: null,
  },
  security: {
    blockScriptUrls: null,
    blockCodeBindings: null,
    // Header names are checked by validateSecurity (case-insensitive, with
    // their own redirect messages), so the generic walker skips them.
    headers: null,
    hsts: { maxAge: null, includeSubDomains: null, preload: null },
    privateDynamicPages: null,
    stripDirectiveScripts: null,
    hideDotfiles: null,
  },
};

/** The response headers `security.headers` can change, in lowercase. */
export const SECURITY_HEADER_NAMES = [
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
] as const;

const SECURITY_BOOLEAN_KEYS = [
  "blockScriptUrls",
  "blockCodeBindings",
  "privateDynamicPages",
  "stripDirectiveScripts",
  "hideDotfiles",
] as const;

const SECURITY_KEYS = [
  "blockScriptUrls",
  "blockCodeBindings",
  "headers",
  "hsts",
  "privateDynamicPages",
  "stripDirectiveScripts",
  "hideDotfiles",
] as const;

export const RENDER_LIMIT_KEYS = [
  "maxInstances",
  "maxOutputLength",
  "maxNestedScripts",
  "maxDepth",
  "rescanFactor",
  "rescanBase",
] as const;

export const EXPANSION_LIMIT_KEYS = ["maxInstances", "maxPageLength"] as const;

/** Settings that only take effect when pages and components are built. */
const BUILD_TIME_ONLY_KEYS: readonly (readonly [string, string])[] = [
  ["security", "blockScriptUrls"],
  ["security", "blockCodeBindings"],
  ["security", "stripDirectiveScripts"],
  ["components", "expansionLimits"],
];

const KNOWN_EXEC_ENTRY_KEYS = [
  "script",
  "watch",
  "phase",
  "cwd",
  "env",
  "args",
  "timeout",
];

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
const suggestKey = (
  key: string,
  known: string[],
  pathPrefix: string,
): string => {
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

const isValidBasePathPrefix = (base: string): boolean => {
  const normalized = base.trim();
  if (/[?#%\\\u0000-\u001f\u007f]/.test(normalized)) return false;
  return !normalized
    .split("/")
    .some((segment) => segment === "." || segment === "..");
};

/* ── Pure validation half ─────────────────────────────────────────────── */

const VALID_EXEC_PHASES = ["pre", "post", "parallel"];
const SCRIPT_ERROR_ACTIONS = ['"warn", "error", or "ignore"'];
const VALID_SCRIPT_ERROR_VALUES = new Set(["warn", "error", "ignore"]);
const VALID_MINIFY_ERROR_VALUES = new Set(["warn", "error"]);
const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS);

/**
 * Keys that used to exist and now live somewhere else. A user who still has one gets told where it went,
 * instead of a generic "not a known configuration option".
 */
const MOVED_KEY_MESSAGES: Record<string, string> = {
  "logging.pinServerUrl":
    "removed: pinning is a setting for your own terminal, not the project. " +
    "Run `bascik --no-pin` or set BASCIK_PIN_SERVER_URL=0 instead",
};

export const PLAUSIBLE_TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,49}$/;
/**
 * A preserve wildcard: 1 to 50 characters from [a-zA-Z0-9-*] containing at
 * least one `*`. `*` is the only metacharacter; consecutive `*` behave as one.
 */
export const PRESERVE_WILDCARD_PATTERN = /^(?=.*\*)[a-zA-Z0-9-*]{1,50}$/;

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
        message:
          MOVED_KEY_MESSAGES[fullKey] ??
          suggestKey(key, Object.keys(schema), pathPrefix),
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
              message: suggestKey(
                entryKey,
                KNOWN_EXEC_ENTRY_KEYS,
                `${fullKey}[${index}].`,
              ),
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

  // Protections first: a mistake here changes what the site ships.
  validateSecurity(raw.security, push);

  // A section replaced by a scalar (`generate: false`) would replace the
  // whole defaults block in the merge, leaving every key in it undefined.
  for (const section of OBJECT_SECTIONS) {
    const value = raw[section];
    if (value !== undefined && !isPlainObject(value))
      push(section, value, "expected an object");
  }
  for (const [section, keys] of BOOLEAN_LEAVES) {
    const value = raw[section];
    if (isPlainObject(value)) validateBooleans(value, section, keys, push);
  }
  if (isPlainObject(raw.scoping) && raw.scoping.attributes !== undefined) {
    const attributes = raw.scoping.attributes;
    if (!isPlainObject(attributes))
      push(
        "scoping.attributes",
        attributes,
        "expected an object { class?, id?, name? }",
      );
    else
      validateBooleans(
        attributes,
        "scoping.attributes",
        ["class", "id", "name"],
        push,
      );
  }

  /* directory */
  if (isPlainObject(raw.directory)) {
    const dir = raw.directory;
    for (const key of ["pages", "out", "public", "api"] as const) {
      const value = dir[key];
      if (value !== undefined && typeof value !== "string") {
        push(`directory.${key}`, value, "expected a string path");
      }
    }
    // components accepts one root or many. Outside-project roots are a
    // supported feature (monorepo shared components), so there is no escape
    // check here; duplicate and nested roots need the filesystem and are
    // checked in config.ts.
    const components = dir.components;
    if (components !== undefined) {
      if (typeof components === "string") {
        if (components.trim() === "") {
          push(
            "directory.components",
            components,
            "expected a non-empty directory path",
          );
        }
      } else if (Array.isArray(components)) {
        if (components.length === 0) {
          push(
            "directory.components",
            components,
            "expected a non-empty array of directory paths",
          );
        }
        components.forEach((entry, index) => {
          if (typeof entry !== "string" || entry.trim() === "") {
            push(
              `directory.components[${index}]`,
              entry,
              "expected a non-empty directory path",
            );
          }
        });
      } else {
        push(
          "directory.components",
          components,
          "expected a string path or an array of string paths",
        );
      }
    }
    if (typeof dir.out === "string") {
      const root = resolve(cwd);
      const resolvedOut = resolve(cwd, dir.out);
      if (resolvedOut === root) {
        // The output directory is emptied at the start of every build and
        // dev session; the project root holds the sources and the config.
        push(
          "directory.out",
          dir.out,
          'is the project root; the output directory is emptied at the start of every build and dev session, so it must be a folder of its own such as "dist"',
        );
      } else if (!isSameOrInside(resolvedOut, root)) {
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
      if (
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        push("http.port", port, "expected an integer between 1 and 65535");
      }
    }
    if (http.hostname !== undefined) {
      const hostname = http.hostname;
      if (!isPlausibleHostname(hostname)) {
        push(
          "http.hostname",
          hostname,
          hostnameExpectation(hostname, "http.port"),
        );
      }
    }
    if (http.tls !== undefined && !isPlainObject(http.tls)) {
      push(
        "http.tls",
        http.tls,
        "expected an object { enabled?, keyFile?, certFile? }",
      );
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
    // api-runtime.ts compares these with `> 0`, which is false for a string
    // or NaN, so a wrong type would silently turn the limit off.
    const maxBodySize = http.maxBodySize;
    if (
      maxBodySize !== undefined &&
      (typeof maxBodySize !== "number" ||
        !Number.isSafeInteger(maxBodySize) ||
        maxBodySize < 0)
    ) {
      push(
        "http.maxBodySize",
        maxBodySize,
        "expected a whole number of bytes, such as 1048576 for 1 MB (0 turns the limit off)",
      );
    }
    // setTimeout fires at once for a delay past 2^31 - 1 ms.
    const apiTimeout = http.apiTimeout;
    if (
      apiTimeout !== undefined &&
      (typeof apiTimeout !== "number" ||
        !Number.isFinite(apiTimeout) ||
        apiTimeout < 0 ||
        apiTimeout > MAX_TIMER_DELAY)
    ) {
      push(
        "http.apiTimeout",
        apiTimeout,
        `expected a number of milliseconds from 0 (no timeout) to ${MAX_TIMER_DELAY}`,
      );
    }
    if (http.httpCache !== undefined && typeof http.httpCache !== "boolean") {
      push("http.httpCache", http.httpCache, "expected true or false");
    }
    if (http.trustProxy !== undefined && typeof http.trustProxy !== "boolean") {
      push("http.trustProxy", http.trustProxy, "expected true or false");
    }
    if (
      http.compression !== undefined &&
      typeof http.compression !== "boolean"
    ) {
      push("http.compression", http.compression, "expected true or false");
    }
    if (
      http.precompress !== undefined &&
      typeof http.precompress !== "boolean"
    ) {
      push("http.precompress", http.precompress, "expected true or false");
    }
    if (http.rateLimit !== undefined) {
      const rateLimit = http.rateLimit;
      if (typeof rateLimit !== "boolean" && !isPlainObject(rateLimit)) {
        push(
          "http.rateLimit",
          rateLimit,
          "expected true, false, or an object { window?, max? }",
        );
      } else if (isPlainObject(rateLimit)) {
        if (rateLimit.window !== undefined) {
          const windowVal = rateLimit.window;
          if (
            typeof windowVal !== "number" ||
            Number.isNaN(windowVal) ||
            windowVal <= 0
          ) {
            push(
              "http.rateLimit.window",
              windowVal,
              "expected a positive number (milliseconds)",
            );
          }
        }
        if (rateLimit.max !== undefined) {
          const maxVal = rateLimit.max;
          if (
            typeof maxVal !== "number" ||
            !Number.isInteger(maxVal) ||
            maxVal <= 0
          ) {
            push("http.rateLimit.max", maxVal, "expected a positive integer");
          }
        }
      }
    }
    if (http.cacheControl !== undefined && http.cacheControl !== null) {
      const cacheControl = http.cacheControl;
      if (isPlainObject(cacheControl)) {
        for (const [ext, value] of Object.entries(cacheControl)) {
          const key = `http.cacheControl[${JSON.stringify(ext)}]`;
          // Matched against the file's last extension, with or without the
          // dot; a glob or a path would silently never match.
          if (!CACHE_CONTROL_EXTENSION.test(ext)) {
            push(
              key,
              ext,
              'expected a file extension such as ".css" (matched against the last extension of the file name)',
            );
          } else if (typeof value !== "string") {
            push(key, value, "expected a Cache-Control string");
          }
        }
      } else if (typeof cacheControl !== "string") {
        push(
          "http.cacheControl",
          cacheControl,
          'expected a Cache-Control string, or a per-extension map such as { ".css": "public, max-age=31536000, immutable" }',
        );
      }
    }
    if (http.timeouts !== undefined) {
      const timeouts = http.timeouts;
      if (!isPlainObject(timeouts)) {
        push(
          "http.timeouts",
          timeouts,
          "expected an object with timeout values",
        );
      } else {
        // Node's servers take request, headers and keepAlive as integers and
        // throw at startup on anything else, so a fraction reports here.
        for (const key of ["request", "headers", "keepAlive"] as const) {
          const val = timeouts[key];
          if (
            val !== undefined &&
            (typeof val !== "number" || !Number.isInteger(val) || val <= 0)
          ) {
            push(
              `http.timeouts.${key}`,
              val,
              "expected a positive whole number (milliseconds)",
            );
          }
        }
        const drain = timeouts.drain;
        if (
          drain !== undefined &&
          (typeof drain !== "number" || Number.isNaN(drain) || drain <= 0)
        ) {
          push(
            "http.timeouts.drain",
            drain,
            "expected a positive number (milliseconds)",
          );
        }
      }
    }
  }

  /* scripts */
  if (isPlainObject(raw.scripts)) {
    const scripts = raw.scripts;
    if (scripts.timeout !== undefined) {
      const timeout = scripts.timeout;
      if (
        typeof timeout !== "number" ||
        Number.isNaN(timeout) ||
        timeout <= 0
      ) {
        push(
          "scripts.timeout",
          timeout,
          "expected a positive number (milliseconds)",
        );
      }
    }
    for (const key of [
      "onBuildScriptError",
      "onRoutesScriptError",
      "onServerScriptError",
    ] as const) {
      const value = scripts[key];
      if (
        value !== undefined &&
        !VALID_SCRIPT_ERROR_VALUES.has(value as string)
      ) {
        push(`scripts.${key}`, value, `expected ${SCRIPT_ERROR_ACTIONS}`);
      }
    }
    if (
      scripts.typescript !== undefined &&
      typeof scripts.typescript !== "boolean" &&
      typeof scripts.typescript !== "function"
    ) {
      push(
        "scripts.typescript",
        scripts.typescript,
        "expected true, false, or a function",
      );
    }
    // importRoot is read-only and may legitimately resolve outside the project
    // root (monorepo shared scripts), so there is deliberately no escape check
    // here, unlike directory.out.
    if (scripts.importRoot !== undefined) {
      const importRoot = scripts.importRoot;
      if (typeof importRoot !== "string" || importRoot.length === 0) {
        push(
          "scripts.importRoot",
          importRoot,
          'expected a non-empty directory path like "src"',
        );
      }
    }
    validateScriptsCache(scripts.cache, push);
    if (
      scripts.stripAnsi !== undefined &&
      typeof scripts.stripAnsi !== "boolean"
    )
      push("scripts.stripAnsi", scripts.stripAnsi, "expected true or false");
    validatePositiveIntegers(
      scripts.renderLimits,
      "scripts.renderLimits",
      RENDER_LIMIT_KEYS,
      push,
    );
  }

  if (
    raw.onMinifyError !== undefined &&
    !VALID_MINIFY_ERROR_VALUES.has(raw.onMinifyError as string)
  ) {
    push("onMinifyError", raw.onMinifyError, 'expected "warn" or "error"');
  }

  /* pipeline */
  if (isPlainObject(raw.pipeline)) {
    const pipeline = raw.pipeline;
    if (pipeline.workers !== undefined) {
      const workers = pipeline.workers;
      const valid =
        typeof workers === "boolean" ||
        (typeof workers === "number" &&
          Number.isInteger(workers) &&
          workers > 0);
      if (!valid) {
        push(
          "pipeline.workers",
          workers,
          "expected true, false, or a positive integer",
        );
      }
    }
    if (
      pipeline.onExecError !== undefined &&
      !VALID_MINIFY_ERROR_VALUES.has(pipeline.onExecError as string)
    ) {
      push(
        "pipeline.onExecError",
        pipeline.onExecError,
        'expected "warn" or "error"',
      );
    }
    if (pipeline.watchPaths !== undefined) {
      const watchPaths = pipeline.watchPaths;
      if (!Array.isArray(watchPaths)) {
        push(
          "pipeline.watchPaths",
          watchPaths,
          "expected an array of path strings",
        );
      } else {
        watchPaths.forEach((entry, index) => {
          if (typeof entry !== "string" || entry.length === 0) {
            push(
              `pipeline.watchPaths[${index}]`,
              entry,
              "expected a non-empty path string",
            );
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
            // A bare path is the most likely mistake: show the form to write.
            push(
              `pipeline.exec[${index}]`,
              entry,
              typeof entry === "string" && entry.length > 0
                ? `expected an object with a script key, such as { script: ${JSON.stringify(entry)} }`
                : "expected an object with a script key",
            );
            return;
          }
          if (typeof entry.script !== "string" || entry.script.length === 0) {
            push(
              `pipeline.exec[${index}].script`,
              entry.script,
              "expected a non-empty script path",
            );
          }
          if (
            entry.phase !== undefined &&
            !VALID_EXEC_PHASES.includes(entry.phase as string)
          ) {
            push(
              `pipeline.exec[${index}].phase`,
              entry.phase,
              'expected "pre", "post", or "parallel"',
            );
          }
          validateExecEntryFields(entry, `pipeline.exec[${index}]`, push);
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
        push(
          "assets.inlineStyles",
          inlineStyles,
          "expected true, false, or an array of stylesheet paths",
        );
      } else if (Array.isArray(inlineStyles)) {
        inlineStyles.forEach((entry, index) => {
          if (typeof entry !== "string" || entry.length === 0) {
            push(
              `assets.inlineStyles[${index}]`,
              entry,
              "expected a non-empty stylesheet path",
            );
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
            push(
              `assets.exclude[${index}]`,
              entry,
              "expected a non-empty glob string with balanced brackets",
            );
          }
        });
      }
    }
    if (assets.symlink !== undefined && typeof assets.symlink !== "boolean") {
      push("assets.symlink", assets.symlink, "expected a boolean");
    }
  }

  /* components */
  if (isPlainObject(raw.components) && raw.components.external !== undefined) {
    const external = raw.components.external;
    if (!Array.isArray(external)) {
      push("components.external", external, "expected an array of tag names");
    } else {
      external.forEach((entry, index) => {
        if (
          typeof entry !== "string" ||
          (!PLAUSIBLE_TAG_NAME.test(entry) &&
            !PRESERVE_WILDCARD_PATTERN.test(entry))
        ) {
          push(
            `components.external[${index}]`,
            entry,
            'expected a tag name or wildcard pattern like "heading-anchors" or "vendor-*"',
          );
        }
      });
    }
  }

  if (isPlainObject(raw.components))
    validatePositiveIntegers(
      raw.components.expansionLimits,
      "components.expansionLimits",
      EXPANSION_LIMIT_KEYS,
      push,
    );

  /* scoping */
  if (isPlainObject(raw.scoping) && raw.scoping.preserve !== undefined) {
    const preserve = raw.scoping.preserve;
    if (!Array.isArray(preserve)) {
      push("scoping.preserve", preserve, "expected an array of tag names");
    } else {
      preserve.forEach((entry, index) => {
        if (
          typeof entry !== "string" ||
          (!PLAUSIBLE_TAG_NAME.test(entry) &&
            !PRESERVE_WILDCARD_PATTERN.test(entry))
        ) {
          push(
            `scoping.preserve[${index}]`,
            entry,
            'expected a tag name or wildcard pattern like "code" or "vendor-*"',
          );
        }
      });
    }
  }

  /* logging */
  if (isPlainObject(raw.logging)) {
    const level = raw.logging.level;
    if (level !== undefined && !VALID_LOG_LEVELS.has(level as string)) {
      push(
        "logging.level",
        level,
        'expected "silent", "error", "warn", "info", or "debug"',
      );
    }
  }

  /* base */
  if (raw.base !== undefined) {
    const base = raw.base;
    if (typeof base !== "string") {
      push("base", base, 'expected a root-relative path like "/docs/"');
    } else if (
      /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(base) ||
      /^[a-zA-Z]:[\\/]/.test(base)
    ) {
      push(
        "base",
        base,
        'expected a root-relative path like "/docs/", not a URL',
      );
    } else if (!isValidBasePathPrefix(base)) {
      push(
        "base",
        base,
        "expected a literal URL path prefix without query, fragment, escape, backslash, or dot segments",
      );
    }
  }

  validateContentSecurityPolicy(raw.contentSecurityPolicy, push);

  return errors;
};

type Push = (key: string, value: unknown, message: string) => void;

/** Top-level sections that only take an object (minify, security and contentSecurityPolicy check their own forms). */
const OBJECT_SECTIONS = [
  "directory",
  "components",
  "scoping",
  "assets",
  "generate",
  "pipeline",
  "scripts",
  "http",
  "logging",
] as const;

/** Settings that take only true or false, by section. */
const BOOLEAN_LEAVES: readonly (readonly [string, readonly string[]])[] = [
  [
    "generate",
    ["sitemap", "robots", "sitemapLastmod", "cspHashes", "manifest"],
  ],
  ["scoping", ["scriptBlocks", "inheritAttributes", "deduplicateCss"]],
  ["logging", ["requests", "copies", "deletes", "transpiles"]],
];

const validateBooleans = (
  section: Record<string, unknown>,
  prefix: string,
  keys: readonly string[],
  push: Push,
): void => {
  for (const key of keys) {
    const value = section[key];
    if (value !== undefined && typeof value !== "boolean")
      push(`${prefix}.${key}`, value, "expected true or false");
  }
};

/** An optional array of non-empty strings; reports the array or each bad entry. */
const validateStringList = (
  value: unknown,
  key: string,
  expected: string,
  push: Push,
): void => {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    push(key, value, `expected an array of ${expected}`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0)
      push(`${key}[${index}]`, entry, `expected a non-empty string`);
  });
};

/** `scripts.cache`: true, false, or { enabled?, include?, exclude?, environment? }. */
const validateScriptsCache = (cache: unknown, push: Push): void => {
  if (cache === undefined || typeof cache === "boolean") return;
  if (!isPlainObject(cache)) {
    push(
      "scripts.cache",
      cache,
      "expected true, false, or an object { enabled?, include?, exclude?, environment? }",
    );
    return;
  }
  validateBooleans(cache, "scripts.cache", ["enabled"], push);
  validateStringList(
    cache.include,
    "scripts.cache.include",
    "glob strings",
    push,
  );
  validateStringList(
    cache.exclude,
    "scripts.cache.exclude",
    "glob strings",
    push,
  );
  validateStringList(
    cache.environment,
    "scripts.cache.environment",
    "environment variable names",
    push,
  );
};

/** The optional fields of one `pipeline.exec` entry (script and phase are checked by the caller). */
const validateExecEntryFields = (
  entry: Record<string, unknown>,
  prefix: string,
  push: Push,
): void => {
  const { watch, cwd, env, args, timeout } = entry;
  if (watch !== undefined) {
    if (typeof watch === "string") {
      if (watch.length === 0)
        push(`${prefix}.watch`, watch, "expected a non-empty glob string");
    } else if (Array.isArray(watch)) {
      validateStringList(watch, `${prefix}.watch`, "glob strings", push);
    } else {
      push(
        `${prefix}.watch`,
        watch,
        "expected a glob string or an array of glob strings",
      );
    }
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0))
    push(`${prefix}.cwd`, cwd, "expected a non-empty directory path");
  if (env !== undefined) {
    if (!isPlainObject(env)) {
      push(`${prefix}.env`, env, "expected an object of string values");
    } else {
      for (const [name, value] of Object.entries(env))
        if (typeof value !== "string")
          push(
            `${prefix}.env[${JSON.stringify(name)}]`,
            value,
            "expected a string",
          );
    }
  }
  validateStringList(args, `${prefix}.args`, "argument strings", push);
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout < 0 ||
      timeout > MAX_TIMER_DELAY)
  )
    push(
      `${prefix}.timeout`,
      timeout,
      `expected a number of milliseconds from 0 (no timeout) to ${MAX_TIMER_DELAY}`,
    );
};

/**
 * An optional object of positive whole numbers (the render and expansion
 * limits). `0`, negatives, fractions, strings, NaN, Infinity and numbers past
 * Number.MAX_SAFE_INTEGER are all rejected.
 */
const validatePositiveIntegers = (
  value: unknown,
  prefix: string,
  keys: readonly string[],
  push: Push,
): void => {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    push(
      prefix,
      value,
      `expected an object { ${keys.map((k) => `${k}?`).join(", ")} }`,
    );
    return;
  }
  for (const key of keys) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field <= 0)
      push(`${prefix}.${key}`, field, "expected a positive whole number");
  }
};

/** `security`: seven named protections, no master switch. */
const validateSecurity = (security: unknown, push: Push): void => {
  if (security === undefined) return;
  const key = "security";
  if (!isPlainObject(security)) {
    push(
      key,
      security,
      `expected an object; turn each protection off by name (${SECURITY_KEYS.join(", ")})`,
    );
    return;
  }
  for (const name of SECURITY_BOOLEAN_KEYS) {
    const value = security[name];
    if (value !== undefined && typeof value !== "boolean")
      push(`${key}.${name}`, value, "expected true or false");
  }

  const headers = security.headers;
  if (headers !== undefined && typeof headers !== "boolean") {
    if (!isPlainObject(headers)) {
      push(
        `${key}.headers`,
        headers,
        "expected true, false, or an object of header names",
      );
    } else {
      const seen = new Map<string, string>();
      for (const [name, value] of Object.entries(headers)) {
        const at = `${key}.headers.${name}`;
        const lower = name.toLowerCase();
        const earlier = seen.get(lower);
        if (earlier !== undefined) {
          push(
            at,
            value,
            `names the same header as "${earlier}"; keep one (header names ignore letter case)`,
          );
          continue;
        }
        seen.set(lower, name);
        if (!(SECURITY_HEADER_NAMES as readonly string[]).includes(lower)) {
          let message: string;
          if (lower === "strict-transport-security")
            message = "set it with security.hsts";
          else if (
            lower === "content-security-policy" ||
            lower === "content-security-policy-report-only"
          )
            message = "set it with contentSecurityPolicy";
          else {
            const suggestion = suggestKey(
              lower,
              [...SECURITY_HEADER_NAMES],
              `${key}.headers.`,
            );
            message = suggestion.startsWith("did you mean")
              ? suggestion
              : `security.headers changes only the headers Bascik sends by default (${SECURITY_HEADER_NAMES.join(", ")}); send other headers from your host or an API route`;
          }
          push(at, value, message);
          continue;
        }
        if (value === false) continue;
        if (typeof value !== "string") {
          push(
            at,
            value,
            "expected a header value string, or false to remove the header",
          );
        } else if (value.trim() === "") {
          push(at, value, "use false to remove the header");
        } else if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
          push(
            at,
            value,
            "header values cannot contain line breaks or control characters",
          );
        } else {
          // Node's setHeader and the Worker's Headers refuse anything else on
          // every response, so a pasted dash or curly quote fails here.
          const outside = /[^\t\u0020-\u007e\u0080-\u00ff]/.exec(value);
          if (outside)
            push(
              at,
              value,
              `header values can hold only printable ASCII and Latin-1 characters; U+${outside[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} at index ${outside.index} cannot be sent (a pasted dash or curly quote?)`,
            );
        }
      }
    }
  }

  const hsts = security.hsts;
  if (hsts !== undefined && typeof hsts !== "boolean") {
    if (!isPlainObject(hsts)) {
      push(
        `${key}.hsts`,
        hsts,
        "expected true, false, or an object { maxAge?, includeSubDomains?, preload? }",
      );
    } else {
      const maxAge = hsts.maxAge;
      if (
        maxAge !== undefined &&
        (typeof maxAge !== "number" ||
          !Number.isSafeInteger(maxAge) ||
          maxAge < 0)
      )
        push(
          `${key}.hsts.maxAge`,
          maxAge,
          "expected a whole number of seconds, 0 or more (31536000 is one year)",
        );
      for (const flag of ["includeSubDomains", "preload"] as const)
        if (hsts[flag] !== undefined && typeof hsts[flag] !== "boolean")
          push(`${key}.hsts.${flag}`, hsts[flag], "expected true or false");
    }
  }
};

/** `contentSecurityPolicy`: directive names, source lists, and the two flags. */
const validateContentSecurityPolicy = (
  csp: unknown,
  push: (key: string, value: unknown, message: string) => void,
): void => {
  if (csp === undefined) return;
  const key = "contentSecurityPolicy";
  if (!isPlainObject(csp)) {
    push(key, csp, "expected an object with directives");
    return;
  }
  if (csp.reportOnly !== undefined && typeof csp.reportOnly !== "boolean")
    push(`${key}.reportOnly`, csp.reportOnly, "expected a boolean");
  const hashes = csp.hashes;
  if (isPlainObject(hashes)) {
    for (const kind of ["scripts", "styles"] as const)
      if (hashes[kind] !== undefined && typeof hashes[kind] !== "boolean")
        push(`${key}.hashes.${kind}`, hashes[kind], "expected a boolean");
  } else if (hashes !== undefined && typeof hashes !== "boolean")
    push(
      `${key}.hashes`,
      hashes,
      "expected a boolean, or { scripts, styles } booleans to hash only one kind",
    );
  const directives = csp.directives;
  if (!isPlainObject(directives)) {
    push(
      `${key}.directives`,
      directives,
      'expected an object of directives, for example { "script-src": ["\'self\'"] }',
    );
    return;
  }
  for (const [name, sources] of Object.entries(directives)) {
    const lower = name.toLowerCase();
    if (!CSP_DIRECTIVES.includes(lower)) {
      let best = "";
      let bestDistance = Infinity;
      for (const candidate of CSP_DIRECTIVES) {
        const distance = editDistance(lower, candidate);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      push(
        `${key}.directives`,
        name,
        bestDistance <= 2
          ? `"${name}" is not a CSP directive. Did you mean "${best}"?`
          : `"${name}" is not a CSP directive.`,
      );
      continue;
    }
    const at = `${key}.directives.${name}`;
    if (
      !Array.isArray(sources) ||
      sources.some((source) => typeof source !== "string")
    ) {
      push(
        at,
        sources,
        "expected an array of sources (strings), for example [\"'self'\"]",
      );
      continue;
    }
    sources.forEach((source: string, index) => {
      if (source.trim() === "" || /[\s;,]/.test(source)) {
        push(
          `${at}[${index}]`,
          source,
          "expected one source with no spaces, ';' or ','. List each source as its own string.",
        );
      } else if (
        isSourceListDirective(lower) &&
        CSP_KEYWORDS.has(source.toLowerCase())
      ) {
        push(
          `${at}[${index}]`,
          source,
          `write ${source} as '${source}' (with single quotes).`,
        );
      }
    });
  }
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
  }

  if (
    isPlainObject(raw.http) &&
    isPlainObject(raw.http.tls) &&
    raw.http.tls.enabled === true
  ) {
    for (const key of ["keyFile", "certFile"] as const) {
      const value = raw.http.tls[key];
      if (typeof value === "string" && !fs.isReadableFile(resolvePath(value))) {
        push(
          `http.tls.${key}`,
          value,
          "file does not exist or is not readable",
        );
      }
    }
  }

  if (isPlainObject(raw.pipeline)) {
    const pipeline = raw.pipeline;
    if (Array.isArray(pipeline.watchPaths)) {
      pipeline.watchPaths.forEach((entry, index) => {
        if (
          typeof entry === "string" &&
          entry.length > 0 &&
          // A glob is checked by the folder it starts in, the folder the watcher observes.
          !fs.existsSync(resolvePath(sourceWatchRoot(entry)))
        ) {
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
          push(
            `pipeline.exec[${index}].script`,
            entry.script,
            "file does not exist",
          );
        }
        // The child starts in `cwd`; the script path itself is still a
        // project path (exec.ts resolves it from the project root).
        if (
          isPlainObject(entry) &&
          typeof entry.cwd === "string" &&
          entry.cwd.length > 0 &&
          !fs.isDirectory(resolvePath(entry.cwd))
        ) {
          push(
            `pipeline.exec[${index}].cwd`,
            entry.cwd,
            "directory does not exist",
          );
        }
      });
    }
  }

  if (isPlainObject(raw.assets) && Array.isArray(raw.assets.inlineStyles)) {
    raw.assets.inlineStyles.forEach((entry, index) => {
      if (
        typeof entry === "string" &&
        entry.length > 0 &&
        !fs.existsSync(resolvePath(entry))
      ) {
        push(`assets.inlineStyles[${index}]`, entry, "file does not exist");
      }
    });
  }

  return errors;
};

/* ── Warnings (non-fatal) ─────────────────────────────────────────────── */

/**
 * Non-fatal findings about user-supplied paths. A project with no shared
 * helpers has no import root directory and is still valid, so a missing
 * `scripts.importRoot` is reported as a warning, never an error.
 */
export const collectConfigWarnings = (
  raw: unknown,
  deps: { fs?: ConfigValidationFs; cwd?: string } = {},
): ConfigValidationError[] => {
  const warnings: ConfigValidationError[] = [];
  if (!isPlainObject(raw)) return warnings;

  const fs = deps.fs ?? defaultFs;
  const cwd = deps.cwd ?? process.cwd();

  if (
    isPlainObject(raw.scripts) &&
    typeof raw.scripts.importRoot === "string" &&
    raw.scripts.importRoot.length > 0
  ) {
    const importRoot = raw.scripts.importRoot;
    if (!fs.existsSync(resolve(cwd, importRoot))) {
      warnings.push({
        key: "scripts.importRoot",
        value: importRoot,
        message:
          "directory does not exist; @/ and / imports in scripts will fail until it is created",
      });
    }
  }

  if (isPlainObject(raw.security) && isPlainObject(raw.security.hsts)) {
    const hsts = raw.security.hsts;
    const maxAge = typeof hsts.maxAge === "number" ? hsts.maxAge : 31536000;
    if (
      hsts.preload === true &&
      (hsts.includeSubDomains !== true || maxAge < 31536000)
    )
      warnings.push({
        key: "security.hsts.preload",
        value: true,
        message:
          "the browser preload list requires includeSubDomains and a max-age of at least one year (maxAge: 31536000); browsers ignore the preload request until both are set",
      });
  }

  if (
    isPlainObject(raw.security) &&
    isPlainObject(raw.security.hsts) &&
    raw.security.hsts.maxAge === 0 &&
    raw.security.hsts.includeSubDomains === true
  )
    warnings.push({
      key: "security.hsts.includeSubDomains",
      value: true,
      message:
        "maxAge 0 clears the policy, so includeSubDomains has no effect; keep maxAge 0 alone to reset browsers, or set a maxAge to apply HTTPS to subdomains",
    });

  const csp = raw.contentSecurityPolicy;
  if (isPlainObject(csp) && isPlainObject(csp.directives)) {
    const directives = csp.directives;
    // Directive names are case-insensitive; the header builder lowercases them.
    const valueOf = (name: string): unknown =>
      Object.entries(directives).find(
        ([written]) => written.toLowerCase() === name,
      )?.[1];
    const sourcesOf = (name: string): string[] => {
      const value = valueOf(name);
      return Array.isArray(value)
        ? (value as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
    };
    const hashScripts =
      csp.hashes !== false &&
      !(isPlainObject(csp.hashes) && csp.hashes.scripts === false);
    // script-src-elem decides which <script> elements run when written, so
    // it gets the same warnings as script-src.
    for (const name of ["script-src", "script-src-elem"]) {
      const at = `contentSecurityPolicy.directives.${name}`;
      if (hashScripts && sourcesOf(name).includes("'unsafe-inline'"))
        warnings.push({
          key: at,
          value: valueOf(name),
          message: `${at} lists 'unsafe-inline', so every inline script runs, including one injected into a page, and Bascik adds no script hashes to it. Remove 'unsafe-inline' to allow only the scripts from your build.`,
        });
      for (const wide of sourcesOf(name).filter(
        (s) => s === "*" || s.toLowerCase() === "https:" || s === "http:",
      ))
        warnings.push({
          key: at,
          value: wide,
          message: `${at} lists ${wide}, so a script from any site may run. List the origins you load scripts from instead.`,
        });
    }
    if (
      csp.reportOnly === true &&
      !("report-to" in directives) &&
      !("report-uri" in directives)
    )
      warnings.push({
        key: "contentSecurityPolicy.reportOnly",
        value: true,
        message:
          "contentSecurityPolicy.reportOnly is on but no report-to or report-uri directive says where to send reports; violations show only in the browser console.",
      });
  }

  return warnings;
};

/**
 * Settings in the `server` export that only take effect when pages and
 * components are built. `bascik --server` serves what the build wrote, so
 * these do nothing there; the author is told where to put them instead.
 */
export const collectModeOverrideWarnings = (
  modeOverrides: unknown,
  userConfig: unknown = {},
): ConfigValidationError[] => {
  const warnings: ConfigValidationError[] = [];
  if (!isPlainObject(modeOverrides)) return warnings;

  // security.hideDotfiles acts twice: the build decides whether dotfiles in
  // src/pages are published, and the server whether it answers them. The
  // build uses the default export plus `build`; `bascik --server` the default
  // export plus `server`. When those disagree, one half undoes the other.
  const hideDotfilesIn = (layer: unknown): unknown =>
    isPlainObject(layer) && isPlainObject(layer.security)
      ? layer.security.hideDotfiles
      : undefined;
  const base = hideDotfilesIn(userConfig) ?? true;
  const atBuild = hideDotfilesIn(modeOverrides.build) ?? base;
  const atServer = hideDotfilesIn(modeOverrides.server) ?? base;
  if (
    typeof atBuild === "boolean" &&
    typeof atServer === "boolean" &&
    atBuild !== atServer
  )
    warnings.push({
      key: "security.hideDotfiles",
      value: { build: atBuild, server: atServer },
      message:
        "the build and the server must agree: the build decides whether dotfiles are published and the server whether it answers them, so with different values dotfiles are either left out of the build or published but answered with 404. Set it once in the default export",
    });

  if (!isPlainObject(modeOverrides.server)) return warnings;
  const server = modeOverrides.server;
  for (const [group, name] of BUILD_TIME_ONLY_KEYS) {
    const section = server[group];
    if (!isPlainObject(section) || section[name] === undefined) continue;
    warnings.push({
      key: `${group}.${name}`,
      value: section[name],
      message:
        "has no effect in the server export: it applies when pages and components are built; set it in the default or build export",
    });
  }
  return warnings;
};

/* ── Orchestration ────────────────────────────────────────────────────── */

/**
 * The `http.timeouts` defaults in milliseconds (config.ts uses these). The
 * drain default lives with the shutdown handler in server-lifecycle.ts.
 */
export const DEFAULT_HTTP_TIMEOUTS = {
  request: 30_000,
  headers: 10_000,
  keepAlive: 5_000,
} as const;

/**
 * The headers timeout used when the config leaves it out: the documented
 * default, lowered to a request timeout set below it, since Node refuses a
 * headers timeout longer than the request timeout.
 */
export const defaultHeadersTimeout = (request: number): number =>
  Math.min(DEFAULT_HTTP_TIMEOUTS.headers, request);

const timeoutValue = (
  layer: unknown,
  key: "request" | "headers",
): number | undefined => {
  if (!isPlainObject(layer) || !isPlainObject(layer.http)) return undefined;
  const timeouts = layer.http.timeouts;
  if (!isPlainObject(timeouts)) return undefined;
  const value = timeouts[key];
  // A malformed value already reported in the shape pass; skip it here.
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
};

/**
 * Node refuses to start a server whose headers timeout is longer than its
 * request timeout (the headers are part of the request), so report the
 * merged pair as a config error instead of a stack trace at listen time.
 */
const checkHttpTimeoutOrder = (
  base: unknown,
  override: unknown,
): ConfigValidationError | undefined => {
  const requestSet =
    timeoutValue(override, "request") ?? timeoutValue(base, "request");
  const headers =
    timeoutValue(override, "headers") ?? timeoutValue(base, "headers");
  const request = requestSet ?? DEFAULT_HTTP_TIMEOUTS.request;
  // An unset headers timeout follows request down (defaultHeadersTimeout).
  if (headers === undefined || headers <= request) return undefined;
  return {
    key: "http.timeouts.headers",
    value: headers,
    message: `expected at most http.timeouts.request (${request}${requestSet === undefined ? ", the default" : ""}); the headers are part of the request, so lower headers or raise request`,
  };
};

/**
 * The folders the output directory must never hold or be, as the merged
 * config for one mode sees them: the layers' values over the defaults.
 * Wrong-typed values are skipped (the shape pass reports them).
 */
const sourceFoldersFor = (
  layers: unknown[],
): { out: string | undefined; sources: [string, string][] } => {
  let out: string | undefined = DEFAULT_DIRECTORY.out;
  let pages: string = DEFAULT_DIRECTORY.pages;
  let api: string = DEFAULT_DIRECTORY.api;
  let components: string[] = [DEFAULT_DIRECTORY.components];
  let importRoot: string = DEFAULT_IMPORT_ROOT;
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    if (isPlainObject(layer.directory)) {
      const dir = layer.directory;
      if (dir.out !== undefined)
        out = typeof dir.out === "string" ? dir.out : undefined;
      if (typeof dir.pages === "string") pages = dir.pages;
      if (typeof dir.api === "string") api = dir.api;
      if (typeof dir.components === "string") components = [dir.components];
      else if (Array.isArray(dir.components))
        components = dir.components.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim() !== "",
        );
    }
    if (
      isPlainObject(layer.scripts) &&
      typeof layer.scripts.importRoot === "string" &&
      layer.scripts.importRoot.length > 0
    )
      importRoot = layer.scripts.importRoot;
  }
  return {
    out,
    sources: [
      ["directory.pages", pages],
      ...components.map((root): [string, string] => [
        "directory.components",
        root,
      ]),
      ["directory.api", api],
      ["scripts.importRoot", importRoot],
    ],
  };
};

/**
 * `directory.out` is emptied at the start of every build and dev session
 * (transpile.ts), so an output directory that is or holds a source folder
 * deletes that source before a page is read. An output directory inside the
 * pages, components or API folder is rejected too: what the build writes
 * would be read back as source. Inside the import root is fine (nothing is
 * deleted, and scripts only import what they name).
 */
const checkOutputDirectoryOverlap = (
  userConfig: unknown,
  modeOverrides: unknown,
  cwd: string,
  fs: ConfigValidationFs,
): ConfigValidationError[] => {
  // Compared on disk too: "SRC" is src on a case-insensitive file system.
  const overlaps = (child: string, parent: string): boolean =>
    isSameOrInsideOnDisk(child, parent, fs.entryIdentity?.bind(fs));
  const root = resolve(cwd);
  const perMode =
    isPlainObject(modeOverrides) &&
    ("dev" in modeOverrides ||
      "build" in modeOverrides ||
      "server" in modeOverrides);
  const errors: ConfigValidationError[] = [];
  for (const mode of ["dev", "build", "server"] as const) {
    const override = perMode
      ? (modeOverrides as Record<string, unknown>)[mode]
      : mode === "dev"
        ? undefined
        : modeOverrides;
    const { out, sources } = sourceFoldersFor([userConfig, override]);
    if (out === undefined) continue;
    const resolvedOut = resolve(cwd, out);
    // The project root and an escaping out report in the shape pass.
    if (resolvedOut === root || !isSameOrInside(resolvedOut, root)) continue;
    const display = (path: string): string =>
      relative(root, resolve(cwd, path)).replace(/\\/g, "/") || ".";
    const deleted = sources.filter(([, path]) =>
      overlaps(resolve(cwd, path), resolvedOut),
    );
    if (deleted.length > 0) {
      errors.push({
        key: "directory.out",
        value: out,
        message: `would delete ${deleted.map(([key, path]) => `${key} "${display(path)}"`).join(", ")}: the output directory is emptied at the start of every build and dev session, so it must be a folder of its own that holds no source, such as "dist"`,
      });
      continue;
    }
    const readBack = sources.find(
      ([key, path]) =>
        key !== "scripts.importRoot" &&
        overlaps(resolvedOut, resolve(cwd, path)),
    );
    if (readBack) {
      errors.push({
        key: "directory.out",
        value: out,
        message: `is inside ${readBack[0]} "${display(readBack[1])}": what the build writes there would be read back as source. Use a folder outside it, such as "dist"`,
      });
    }
  }
  return errors;
};

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
    if (
      "dev" in modeOverrides ||
      "build" in modeOverrides ||
      "server" in modeOverrides
    ) {
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
  // headers <= request holds for the merged values a server runs with, so
  // check the pair dev and --server each see (build starts no server). A
  // flat override applies to build and --server only, as in config.ts.
  const perMode =
    isPlainObject(modeOverrides) &&
    ("dev" in modeOverrides ||
      "build" in modeOverrides ||
      "server" in modeOverrides);
  for (const mode of ["dev", "server"] as const) {
    const override = perMode
      ? (modeOverrides as Record<string, unknown>)[mode]
      : mode === "server"
        ? modeOverrides
        : undefined;
    const error = checkHttpTimeoutOrder(userConfig, override);
    if (error) errors.push(error);
  }

  errors.push(
    ...checkOutputDirectoryOverlap(
      userConfig,
      modeOverrides,
      deps.cwd ?? process.cwd(),
      deps.fs ?? defaultFs,
    ),
  );

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
        message:
          'expected an absolute http or https URL, e.g. "https://example.com"',
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
    const displayValue = error.unknownKey
      ? "unknown key"
      : formatValue(error.value);
    const head = `  ${error.key.padEnd(valueColumn)}${displayValue}`;
    const tail = `${" ".repeat(valueColumn + 2)}${error.message}`;
    return `${head}\n${tail}`;
  });
  const count = `${errors.length} configuration error${errors.length === 1 ? "" : "s"}`;
  return `Configuration errors in ${sourceName}\n\n${blocks.join("\n\n")}\n\n${count}`;
};
