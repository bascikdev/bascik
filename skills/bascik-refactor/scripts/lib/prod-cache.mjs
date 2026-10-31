// The production cache: what a parity check measured on production, kept on disk so the next run reads it instead of
// loading production again at every matrix case. Dependency-free; Node.js 22.22+. Nothing here imports Playwright.
//
// Why: production does not change between two runs of the iteration loop, but every run measured it again, which made
// a full run take 20 to 50 minutes per route. The key holds everything that changes what production measures, so a
// changed mask, skip-control, case, settle time, browser or skill script is a miss, never a stale hit:
// - the check, CACHE_FORMAT, and a hash of every script of this skill (a skill update invalidates every entry);
// - the browser version, the production origin, the route (or routes) and the full matrix case object;
// - the anchor or item where a check measures one element, and any other part the check passes;
// - settleMs, the sorted masks and skip-controls (presence-by-route adds its dismiss selectors as a part: no other check
//   dismisses anything, so --dismiss on run-checks never misses another check's entries).
// An entry is <dir>/<check>/<sha256 of the key>.json ({ format, hash, key, capturedAt, value }); a Buffer in the
// value (a PNG crop) is written beside it as <sha256>-<n>.png. Production changed? Pass --refresh-prod.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the cache lives unless --prod-cache says otherwise; --no-prod-cache turns it off. */
export const DEFAULT_PROD_CACHE = "artifacts/prod-cache";

/** Bumped when the entry format changes; part of every key. */
export const CACHE_FORMAT = 1;

/** The parseArgs options every check CLI and run-checks take. */
export const PROD_CACHE_OPTIONS = Object.freeze({
  "refresh-prod": { type: "boolean", default: false },
  "no-prod-cache": { type: "boolean", default: false },
  "prod-cache": { type: "string" },
});

/**
 * The cache flags from parsed values: { prodCache: dir | null, refreshProd }. --refresh-prod or --prod-cache with
 * --no-prod-cache is an error: one says use the cache, the other says do not.
 */
export function prodCacheFlags(values) {
  const off = Boolean(values["no-prod-cache"]);
  const refresh = Boolean(values["refresh-prod"]);
  const dir = values["prod-cache"];
  if (off && refresh)
    throw new Error(
      "--refresh-prod and --no-prod-cache contradict each other: --refresh-prod measures production again and stores it, --no-prod-cache neither reads nor stores; pass one",
    );
  if (off && dir !== undefined)
    throw new Error(
      "--prod-cache <dir> and --no-prod-cache contradict each other; pass one",
    );
  if (dir !== undefined && !String(dir).trim())
    throw new Error(
      "--prod-cache needs a folder, such as artifacts/prod-cache",
    );
  return {
    prodCache: off ? null : (dir ?? DEFAULT_PROD_CACHE),
    refreshProd: refresh,
  };
}

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
let scriptsHash;

/** A hash of every script of this skill (scripts/*.mjs and scripts/lib/*.mjs): an updated skill misses every entry. */
export function sourceHash() {
  if (scriptsHash) return scriptsHash;
  const hash = createHash("sha256");
  for (const folder of [SCRIPTS, join(SCRIPTS, "lib")]) {
    let names = [];
    try {
      names = readdirSync(folder)
        .filter((n) => n.endsWith(".mjs"))
        .sort();
    } catch {
      // A copied script without its folder: the hash covers what is there.
    }
    for (const name of names) {
      hash.update(`${folder === SCRIPTS ? "" : "lib/"}${name}\n`);
      hash.update(readFileSync(join(folder, name)));
    }
  }
  scriptsHash = hash.digest("hex");
  return scriptsHash;
}

/**
 * The cache for one run, or null without a folder. `browser` gives the version for the key. The state counts what it
 * read and captured (`stats`) and collects warnings, each printed once to stderr unless `quiet`.
 */
export async function openProdCache(
  browser,
  { dir, refresh = false, quiet } = {},
) {
  if (!dir) return null;
  let version = "unknown";
  try {
    version = String((await browser?.version?.()) ?? "unknown");
  } catch {
    // A browser without a version: entries are keyed "unknown".
  }
  return {
    dir,
    refresh: Boolean(refresh),
    browser: version,
    source: sourceHash(),
    disabled: false,
    quiet: Boolean(quiet),
    warnings: [],
    stats: { fromCache: 0, captured: 0, oldest: undefined },
  };
}

function warn(state, message) {
  state.warnings.push(message);
  if (!state.quiet) process.stderr.write(`warning: ${message}\n`);
}

const sorted = (...lists) =>
  [
    ...new Set(
      lists
        .flat()
        .filter((v) => v !== undefined && v !== null)
        .map(String),
    ),
  ].sort();

/** Object keys in a stable order, so the same key always hashes the same. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}

/**
 * The full key of one production measurement and its hash. `options` are the runCheck options (prod, settleMs, masks
 * or mask, skipControls or skip-control); `parts` come from the check (check, route or routes, case, anchor, the
 * dismiss selectors of presence-by-route, and anything else that changes what it measures).
 */
export function cacheKey(state, options, parts) {
  const key = stable({
    format: CACHE_FORMAT,
    source: state.source,
    browser: state.browser,
    prod: options.prod,
    settleMs: options.settleMs ?? null,
    masks: sorted(options.masks ?? [], options.mask ?? []),
    skipControls: sorted(
      options.skipControls ?? [],
      options["skip-control"] ?? [],
    ),
    ...parts,
  });
  const hash = createHash("sha256").update(JSON.stringify(key)).digest("hex");
  return { parts: key, hash };
}

/** Replaces each Buffer in `value` with { $file } and collects the buffers. */
function encode(value, files) {
  if (value instanceof Uint8Array) {
    files.push(Buffer.from(value));
    return { $file: files.length - 1 };
  }
  if (Array.isArray(value)) return value.map((v) => encode(v, files));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      if (v !== undefined) out[k] = encode(v, files);
    return out;
  }
  return value;
}

/** The inverse of encode: reads each { $file } back (a missing file throws, so the entry counts as corrupt). */
function decode(value, read) {
  if (Array.isArray(value)) return value.map((v) => decode(v, read));
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$file") return read(value.$file);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v, read);
    return out;
  }
  return value;
}

function readEntry(state, file, hash) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      warn(
        state,
        `cannot read ${file} (${error.message}); measuring production again`,
      );
    return undefined;
  }
  try {
    const entry = JSON.parse(text);
    if (
      entry?.format !== CACHE_FORMAT ||
      entry.hash !== hash ||
      !("value" in entry)
    )
      throw new Error("not an entry for this key");
    if (Number.isNaN(Date.parse(entry.capturedAt)))
      throw new Error("no capturedAt date");
    const value = decode(entry.value, (n) =>
      readFileSync(join(dirname(file), `${hash}-${n}.png`)),
    );
    return { value, capturedAt: entry.capturedAt };
  } catch (error) {
    warn(
      state,
      `ignoring the corrupt production cache entry ${file} (${error.message.split("\n")[0]}); measuring production again`,
    );
    return undefined;
  }
}

function writeEntry(state, file, hash, parts, value) {
  const files = [];
  const entry = {
    format: CACHE_FORMAT,
    hash,
    key: parts,
    capturedAt: new Date().toISOString(),
    value: encode(value, files),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    files.forEach((buffer, n) =>
      writeFileSync(join(dirname(file), `${hash}-${n}.png`), buffer),
    );
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entry) + "\n");
    renameSync(temp, file);
  } catch (error) {
    state.disabled = true;
    warn(
      state,
      `cannot write the production cache at ${state.dir} (${error.message.split("\n")[0]}); running without it, so production is measured on every run`,
    );
  }
}

/**
 * Production's measurement for one key: from the cache when it holds one (unless the run refreshes), else `fn()`,
 * stored for the next run. Without a cache (`options.prodCache` is not an open cache) it always runs `fn()`.
 * `parts` are the check's key parts (see cacheKey).
 */
export async function cachedProd(options, parts, fn) {
  const state = options?.prodCache;
  if (!state || typeof state !== "object" || !state.stats) return fn();
  if (state.disabled) {
    const value = await fn();
    state.stats.captured++;
    return value;
  }
  const { parts: key, hash } = cacheKey(state, options, parts);
  const file = join(state.dir, String(parts.check), `${hash}.json`);
  if (!state.refresh) {
    const hit = readEntry(state, file, hash);
    if (hit) {
      state.stats.fromCache++;
      if (!state.stats.oldest || hit.capturedAt < state.stats.oldest)
        state.stats.oldest = hit.capturedAt;
      return hit.value;
    }
  }
  const value = await fn();
  state.stats.captured++;
  writeEntry(state, file, hash, key, value);
  return value;
}

/** The terminal line about the cache: how much came from it, how old the oldest is, and how to refresh. */
export function prodCacheSummary(stats) {
  const from = stats.fromCache
    ? `${stats.fromCache} measurements from cache (oldest ${stats.oldest})`
    : "0 measurements from cache";
  return `production: ${from}, ${stats.captured} captured; pass --refresh-prod after production changes`;
}

/** What report.json records about the cache: { cache, refreshed, fromCache, captured, oldestCachedAt }. */
export function prodCacheRecord(state) {
  if (!state) return { cache: null, refreshed: false, fromCache: 0 };
  return {
    cache: state.disabled ? null : state.dir,
    refreshed: state.refresh,
    fromCache: state.stats.fromCache,
    captured: state.stats.captured,
    ...(state.stats.oldest ? { oldestCachedAt: state.stats.oldest } : {}),
  };
}
