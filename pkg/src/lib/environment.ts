/**
 * @module environment
 *
 * .env Loading and Site URL Resolution
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The site URL is a per-deployment value, so it is not a config-file key.
 * Three sources, in precedence order (most specific and most ephemeral wins):
 *
 *   --site-url flag  >  BASCIK_SITE_URL env var  >  .env file
 *
 * `.env` loading uses Node 24's built-in `process.loadEnvFile()`; there is no
 * dotenv dependency. A default `./.env` is loaded when present and is silent
 * when missing. Explicit `--env-file=<path>` flags are repeatable, later files
 * override earlier ones, and a missing explicit path is an error (mirroring
 * Node's `--env-file` versus `--env-file-if-exists` distinction).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export const SITE_URL_ENV_VAR = "BASCIK_SITE_URL";

export interface EnvFlags {
  siteUrl?: string;
  envFiles: string[];
}

/** Extract `--site-url` and repeatable `--env-file` from raw CLI args. */
export const parseEnvFlags = (args: string[]): EnvFlags => {
  const envFiles: string[] = [];
  let siteUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--site-url") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        siteUrl = next;
        i++;
      }
    } else if (arg.startsWith("--site-url=")) {
      siteUrl = arg.slice("--site-url=".length);
    } else if (arg === "--env-file") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        envFiles.push(next);
        i++;
      }
    } else if (arg.startsWith("--env-file=")) {
      envFiles.push(arg.slice("--env-file=".length));
    }
  }
  return { siteUrl, envFiles };
};

/**
 * Load `./.env` (if present) followed by each explicit env file. Returns the
 * list of files loaded. A missing default `.env` is silent; a missing
 * explicit file throws.
 *
 * Files are parsed with Node's built-in `util.parseEnv` and merged in order
 * (later files override earlier files, matching Node's `--env-file` flag),
 * then applied to `process.env` only for keys that were not already set. A
 * real environment variable therefore always beats a .env file value: Node
 * documents that for the flag but not for `process.loadEnvFile()`, so the
 * pre-existing keys are snapshotted and protected explicitly instead of
 * relying on unspecified behavior.
 */
export const loadEnvFiles = (
  explicitFiles: string[] = [],
  cwd: string = process.cwd(),
): string[] => {
  const candidates: { path: string; explicit: boolean }[] = [
    { path: resolve(cwd, ".env"), explicit: false },
    ...explicitFiles.map((f) => ({ path: resolve(cwd, f), explicit: true })),
  ];

  const preExistingKeys = new Set(Object.keys(process.env));
  const fileValues: Record<string, string> = {};
  const loaded: string[] = [];

  for (const { path, explicit } of candidates) {
    if (!existsSync(path)) {
      if (explicit) {
        throw new Error(
          `[bascik] error: --env-file "${path}" does not exist. ` +
          `Pass an existing file, or omit the flag to use the default ./.env when present.`,
        );
      }
      continue;
    }
    Object.assign(fileValues, parseEnv(readFileSync(path, "utf8")));
    loaded.push(path);
  }

  for (const [key, value] of Object.entries(fileValues)) {
    if (!preExistingKeys.has(key)) process.env[key] = value;
  }

  return loaded;
};

/** Reject anything that is not an absolute http or https URL. */
export const validateSiteUrl = (value: string): string => {
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    // handled below
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(
      `[bascik] error: invalid site URL "${value}".\n` +
      `  Expected an absolute http or https URL, e.g. "https://example.com".`,
    );
  }
  return value;
};

/**
 * Resolve the site URL from CLI args and an environment map. Pure: the
 * `--site-url` flag beats the env var. The env var already reflects any
 * `.env` file values once `bootEnvironment` has run.
 */
export const resolveSiteUrl = (
  args: string[],
  env: NodeJS.ProcessEnv,
): string | undefined => {
  const raw = parseEnvFlags(args).siteUrl ?? (env[SITE_URL_ENV_VAR] || undefined);
  if (raw === undefined) return undefined;
  return validateSiteUrl(raw);
};

/**
 * Load env files and apply the `--site-url` flag into `process.env`. The flag
 * is written into the environment (after loading and restoring, so it wins)
 * because worker threads do not inherit `process.argv` — the environment is
 * the one channel every thread and child process shares.
 */
export const bootEnvironment = (
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): void => {
  const flags = parseEnvFlags(args);
  loadEnvFiles(flags.envFiles, cwd);
  if (flags.siteUrl !== undefined) {
    process.env[SITE_URL_ENV_VAR] = flags.siteUrl;
  }
};

let booted = false;

/** Idempotent boot: load env files and apply CLI flags exactly once. */
export const ensureEnvironmentReady = (): void => {
  if (booted) return;
  booted = true;
  bootEnvironment();
};

/**
 * The resolved, validated site URL, or undefined when no source provides one.
 * Empty string counts as unset. Throws when a provided value is not an
 * absolute http/https URL.
 */
export const getSiteUrl = (): string | undefined => {
  ensureEnvironmentReady();
  const raw = process.env[SITE_URL_ENV_VAR];
  if (raw === undefined || raw === "") return undefined;
  return validateSiteUrl(raw);
};
