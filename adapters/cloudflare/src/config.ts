/**
 * @module config
 *
 * Structured configuration discovery and parsing for Cloudflare Wrangler configuration files.
 * Supports jsonc (comments and trailing commas), json, and toml with safe error reporting.
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  parse as parseJsoncRaw,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { parse as parseTomlRaw, TomlError } from "smol-toml";
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  CLOUDFLARE_COMPATIBILITY_FLAGS,
  type CompatSettings,
} from "./compat.js";

/**
 * Wrangler configuration file discovery order according to Cloudflare Wrangler documentation:
 * 1. wrangler.jsonc
 * 2. wrangler.json
 * 3. wrangler.toml
 */
export const WRANGLER_CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
] as const;

export type WranglerConfigFile = (typeof WRANGLER_CONFIG_FILES)[number];

export interface ParsedWranglerConfig {
  name?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  [key: string]: unknown;
}

export interface DiscoveredConfig {
  filename: WranglerConfigFile;
  filePath: string;
  values: ParsedWranglerConfig;
}

/**
 * Parses JSONC (JSON with comments and trailing commas) using the maintained
 * jsonc-parser library (Microsoft, used by VS Code). The parser is fault
 * tolerant and returns partial data on errors, so the errors array is always
 * checked and any parse error rejects the input.
 */
export function parseJsonc(
  text: string,
  filename = "wrangler.jsonc",
): ParsedWranglerConfig {
  const errors: ParseError[] = [];
  const parsed = parseJsoncRaw(text, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const first = errors[0];
    const { line, character } = lineAndCharacterAt(text, first.offset);
    const reason = printParseErrorCode(first.error);
    throw new Error(
      `[bascik] Failed to parse ${filename} at line ${line}, column ${character}: ${reason}.`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `[bascik] Failed to parse ${filename}: expected a top-level JSON object.`,
    );
  }

  return parsed as ParsedWranglerConfig;
}

/**
 * Computes a 1-based line and column for a character offset within text.
 */
function lineAndCharacterAt(
  text: string,
  offset: number,
): { line: number; character: number } {
  let line = 1;
  let character = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") {
      line++;
      character = 1;
    } else {
      character++;
    }
  }
  return { line, character };
}

/**
 * Parses TOML syntax using the maintained smol-toml library (BSD-3-Clause).
 * The parser is strict: duplicate keys, duplicate tables, malformed values,
 * and unclosed constructs all throw. Error messages are built from the first
 * line of the parser message only, which never contains source excerpts or
 * raw configuration values.
 */
export function parseToml(
  text: string,
  filename = "wrangler.toml",
): ParsedWranglerConfig {
  try {
    const parsed = parseTomlRaw(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `[bascik] Failed to parse ${filename}: expected a top-level TOML table.`,
      );
    }
    return parsed as ParsedWranglerConfig;
  } catch (err) {
    if (err instanceof TomlError) {
      // TomlError.message includes a codeblock with source excerpts and raw
      // values. Only the first line is safe to surface.
      const reason = err.message.split("\n")[0];
      throw new Error(
        `[bascik] Failed to parse ${filename} at line ${err.line}: ${reason}.`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[bascik] Failed to parse ${filename}: ${msg}`);
  }
}

/**
 * Parses package.json as strict JSON (no comments, no trailing commas, as
 * npm reads it). An error is located by line and column and, like the
 * Wrangler parsers, never quotes the file: `JSON.parse`'s own message
 * includes a source excerpt. A value that is not an object has no name.
 */
function parsePackageJson(text: string): { name?: unknown } | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsoncRaw(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (errors.length > 0) {
    const first = errors[0];
    const { line, character } = lineAndCharacterAt(text, first.offset);
    throw new Error(
      `[bascik] Failed to parse package.json at line ${line}, column ${character}: ${printParseErrorCode(first.error)}.`,
    );
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as { name?: unknown })
    : null;
}

/**
 * Discovers and parses the highest precedence Wrangler configuration file in the project root.
 * Returns null if no Wrangler configuration file exists.
 * Throws an actionable error if the discovered configuration file is malformed.
 */
export async function discoverWranglerConfig(
  projectRoot: string,
): Promise<DiscoveredConfig | null> {
  for (const filename of WRANGLER_CONFIG_FILES) {
    const filePath = join(projectRoot, filename);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // The bare fs message (EISDIR, EACCES) names no file.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[bascik] Failed to read ${filename}: ${msg}`);
    }

    // The file exists: parse it according to its extension
    if (filename.endsWith(".toml")) {
      const values = parseToml(raw, filename);
      return { filename, filePath, values };
    } else {
      const values = parseJsonc(raw, filename);
      return { filename, filePath, values };
    }
  }

  return null;
}

/**
 * Resolves the Worker name from candidate sources in strict priority order:
 * 1. Environment variables (CLOUDFLARE_WORKER_NAME, WORKER_NAME, CF_PAGES_PROJECT_NAME)
 * 2. Authored Wrangler config (wrangler.jsonc, wrangler.json, wrangler.toml in discovery order)
 * 3. Root package.json "name" field (with @scope/ stripped)
 * 4. Fallback default: "bascik-site"
 */
export async function resolveWorkerName(
  projectRoot: string,
  discoveredConfig?: DiscoveredConfig | null,
): Promise<{
  workerName: string;
  source: "env" | "config" | "package" | "default";
  discoveredConfig?: DiscoveredConfig | null;
}> {
  const envName =
    process.env.CLOUDFLARE_WORKER_NAME ||
    process.env.WORKER_NAME ||
    process.env.CF_PAGES_PROJECT_NAME;

  if (envName && envName.trim()) {
    return { workerName: envName.trim(), source: "env", discoveredConfig };
  }

  const discovered =
    discoveredConfig !== undefined
      ? discoveredConfig
      : await discoverWranglerConfig(projectRoot);
  if (
    discovered &&
    discovered.values.name &&
    typeof discovered.values.name === "string" &&
    discovered.values.name.trim()
  ) {
    return {
      workerName: discovered.values.name.trim(),
      source: "config",
      discoveredConfig: discovered,
    };
  }

  let pkgJsonRaw: string | undefined;
  try {
    pkgJsonRaw = await readFile(join(projectRoot, "package.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[bascik] Failed to read package.json: ${msg}`);
    }
  }
  if (pkgJsonRaw !== undefined) {
    const pkgJson = parsePackageJson(pkgJsonRaw);
    if (
      pkgJson?.name &&
      typeof pkgJson.name === "string" &&
      pkgJson.name.trim()
    ) {
      const name = pkgJson.name.replace(/^@[^/]+\//, "").trim();
      if (name) {
        return {
          workerName: name,
          source: "package",
          discoveredConfig: discovered,
        };
      }
    }
  }

  return {
    workerName: "bascik-site",
    source: "default",
    discoveredConfig: discovered,
  };
}

/** The Worker entry the adapter generates beside the generated config. */
export const GENERATED_WORKER_MAIN = "worker.js";
/** The binding the generated Worker serves static files through (runtime.ts). */
export const ASSETS_BINDING = "ASSETS";

export interface GenerateWranglerConfigInput {
  /** The authored config discovered in the project root, if any. */
  authored: DiscoveredConfig | null | undefined;
  projectRoot: string;
  /** Where the generated wrangler.jsonc is written (dist/.bascik/<target>/). */
  outDir: string;
  workerName: string;
  /** `true`, or the computed invocation routes. */
  runWorkerFirst: true | string[];
  /** The installed wrangler/config-schema.json, when it resolves. */
  schemaPath?: string;
  compatibilityDate?: string;
  compatibilityFlags?: readonly string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toPosix = (path: string): string => path.replace(/\\/g, "/");

/**
 * Generates the wrangler.jsonc written beside worker.js. The adapter owns
 * `name` (resolved by resolveWorkerName), `main`, `assets.directory`,
 * `assets.binding` and `assets.run_worker_first` (computed from the routes,
 * unioned with an authored list); `compatibility_flags` are the union of the
 * authored flags and the adapter's. Every other authored key, top level or
 * nested, is carried over verbatim, except that path-valued keys Wrangler
 * reads relative to the config file are rebased from the project root to the
 * output directory, so they name the same files. An authored key the adapter
 * replaces is reported as a warning naming the file and key; an authored
 * `assets.binding` other than `ASSETS` is an error, since the generated
 * Worker reads `env.ASSETS`. Unknown keys are carried over without checks:
 * Wrangler validates its own config.
 */
export function generateWranglerConfig(input: GenerateWranglerConfigInput): {
  config: Json;
  warnings: string[];
} {
  const {
    authored,
    projectRoot,
    outDir,
    workerName,
    runWorkerFirst,
    schemaPath,
    compatibilityDate = CLOUDFLARE_COMPATIBILITY_DATE,
    compatibilityFlags = CLOUDFLARE_COMPATIBILITY_FLAGS,
  } = input;
  const filename = authored?.filename ?? "wrangler.jsonc";
  const values: Json = authored?.values ?? {};
  const warnings: string[] = [];
  const at = (key: string) => `[bascik] ${filename}: "${key}"`;

  const rebase = (value: unknown): unknown => {
    if (typeof value !== "string" || value === "") return value;
    if (isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
    return toPosix(relative(outDir, resolve(projectRoot, value))) || ".";
  };
  const rebaseList = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(rebase) : rebase(value);
  const rebaseMap = (value: unknown): unknown =>
    isObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, rebase(v)]),
        )
      : value;
  const rebaseItems = (value: unknown, fn: (item: Json) => Json): unknown =>
    Array.isArray(value)
      ? value.map((item) => (isObject(item) ? fn(item) : item))
      : value;
  const rebaseD1 = (item: Json): Json => {
    const out = { ...item };
    if ("migrations_dir" in out)
      out.migrations_dir = rebase(out.migrations_dir);
    // Wrangler defaults migrations_dir to ./migrations beside the config file;
    // the generated config sits elsewhere, so the authored folder is named.
    // A migrations_pattern without migrations_dir is left for Wrangler to
    // report, as it would from the project root.
    else if (!("migrations_pattern" in out))
      out.migrations_dir = rebase("migrations");
    if ("migrations_pattern" in out)
      out.migrations_pattern = rebase(out.migrations_pattern);
    return out;
  };
  const rebaseContainer = (item: Json): Json => {
    const out = { ...item };
    // `image` is a Dockerfile path or a registry reference: only a path
    // spelled as one is rebased.
    if (
      typeof out.image === "string" &&
      (/^\.\.?[\\/]/.test(out.image) || /dockerfile/i.test(out.image)) &&
      !/^[a-z][a-z0-9+.-]*:/i.test(out.image)
    )
      out.image = rebase(out.image);
    if ("image_build_context" in out)
      out.image_build_context = rebase(out.image_build_context);
    // Named images of a Durable Object-managed container.
    if (isObject(out.images))
      out.images = Object.fromEntries(
        Object.entries(out.images).map(([imageName, image]) => {
          if (!isObject(image)) return [imageName, image];
          const rebased = { ...image };
          if ("dockerfile" in rebased)
            rebased.dockerfile = rebase(rebased.dockerfile);
          if ("build_context" in rebased)
            rebased.build_context = rebase(rebased.build_context);
          return [imageName, rebased];
        }),
      );
    return out;
  };

  /** The assets block the adapter writes, merged with an authored one. */
  const mergeAssets = (assets: unknown, keyPrefix: string): Json => {
    const authoredAssets = isObject(assets) ? assets : {};
    if (assets !== undefined && !isObject(assets))
      warnings.push(
        `${at(`${keyPrefix}assets`)} is not an object and is ignored: the adapter writes its own assets block.`,
      );
    const {
      directory,
      binding,
      run_worker_first: authoredFirst,
      not_found_handling,
      ...rest
    } = authoredAssets;
    if (directory !== undefined)
      warnings.push(
        `${at(`${keyPrefix}assets.directory`)} is ignored: the adapter stages the site's files in ./public beside the generated worker.js. Remove the key.`,
      );
    if (binding !== undefined && binding !== ASSETS_BINDING)
      throw new Error(
        `${at(`${keyPrefix}assets.binding`)} must be "${ASSETS_BINDING}" or left out: the generated Worker serves static files through env.${ASSETS_BINDING}.`,
      );
    // Wrangler takes a boolean or a list of route patterns. Anything else
    // (a string "true", a number in the list) never reaches Wrangler: say
    // so, since the Worker would silently run first for fewer paths.
    const strayFirst =
      authoredFirst === undefined || typeof authoredFirst === "boolean"
        ? []
        : Array.isArray(authoredFirst)
          ? authoredFirst.filter((p) => typeof p !== "string")
          : [authoredFirst];
    if (strayFirst.length)
      warnings.push(
        `${at(`${keyPrefix}assets.run_worker_first`)} must be true or a list of route patterns: ${strayFirst.map((v) => JSON.stringify(v)).join(", ")} is ignored, and the Worker runs first only for the routes the build computes${Array.isArray(authoredFirst) ? " and your other patterns" : ""}.`,
      );
    let first: true | string[];
    // The top-level `true` is resolved by build.ts (it also decides who
    // sends the static files' headers); an env section's own `true` is
    // kept for that environment, as Wrangler would read it.
    if (runWorkerFirst === true || authoredFirst === true) first = true;
    else {
      const extra = Array.isArray(authoredFirst)
        ? authoredFirst.filter((p): p is string => typeof p === "string")
        : [];
      first = [...new Set([...runWorkerFirst, ...extra])];
    }
    return {
      directory: "./public",
      binding: ASSETS_BINDING,
      ...rest,
      not_found_handling: not_found_handling ?? "404-page",
      run_worker_first: first,
    };
  };

  const unionFlags = (flags: unknown): string[] => [
    ...new Set([
      ...(Array.isArray(flags)
        ? flags.filter(
            (f): f is string => typeof f === "string" && f.trim().length > 0,
          )
        : []),
      ...compatibilityFlags,
    ]),
  ];

  /** Rebases the path-valued keys of a top-level or env section. */
  const rebaseSection = (section: Json): Json => {
    const out = { ...section };
    if ("tsconfig" in out) out.tsconfig = rebase(out.tsconfig);
    if ("base_dir" in out) out.base_dir = rebase(out.base_dir);
    if (isObject(out.build)) {
      const build = { ...out.build };
      // Wrangler runs build.command in the config's folder by default: the
      // generated config sits elsewhere, so the authored folder is named.
      if ("cwd" in build) build.cwd = rebase(build.cwd);
      else if (build.command !== undefined) build.cwd = rebase(".");
      if ("watch_dir" in build) build.watch_dir = rebaseList(build.watch_dir);
      out.build = build;
    }
    if ("d1_databases" in out)
      out.d1_databases = rebaseItems(out.d1_databases, rebaseD1);
    if ("containers" in out)
      out.containers = rebaseItems(out.containers, rebaseContainer);
    if (isObject(out.site) && "bucket" in out.site)
      out.site = { ...out.site, bucket: rebase(out.site.bucket) };
    for (const key of ["wasm_modules", "text_blobs", "data_blobs"])
      if (key in out) out[key] = rebaseMap(out[key]);
    if (isObject(out.previews)) out.previews = rebaseSection(out.previews);
    return out;
  };

  const {
    $schema: authoredSchema,
    name: _name,
    main,
    compatibility_date,
    compatibility_flags,
    assets,
    env,
    ...rest
  } = values;
  if (main !== undefined)
    warnings.push(
      `${at("main")} is ignored: the adapter generates the Worker entry (${GENERATED_WORKER_MAIN}) from your pages and API routes. Remove the key.`,
    );
  const checkDate = (value: unknown, key: string) => {
    if (value !== undefined && !isCompatibilityDate(value))
      warnings.push(
        `${at(key)} must be a date like "${compatibilityDate}", but is ${JSON.stringify(value)}: Wrangler will reject it, and the build checks node:* imports against ${compatibilityDate} instead.`,
      );
  };
  checkDate(compatibility_date, "compatibility_date");

  let schema: unknown;
  if (typeof authoredSchema === "string") schema = rebase(authoredSchema);
  else if (authoredSchema !== undefined) schema = authoredSchema;
  else if (schemaPath)
    schema = toPosix(relative(outDir, schemaPath)) || undefined;

  let envOut: unknown = env;
  if (isObject(env)) {
    envOut = Object.fromEntries(
      Object.entries(env).map(([envName, section]) => {
        if (!isObject(section)) return [envName, section];
        const prefix = `env.${envName}.`;
        const { main: envMain, ...envRest } = section;
        if (envMain !== undefined)
          warnings.push(
            `${at(`${prefix}main`)} is ignored: every environment runs the generated ${GENERATED_WORKER_MAIN}. Remove the key.`,
          );
        checkDate(envRest.compatibility_date, `${prefix}compatibility_date`);
        const out = rebaseSection(envRest);
        if ("compatibility_flags" in out)
          out.compatibility_flags = unionFlags(out.compatibility_flags);
        if ("assets" in out) out.assets = mergeAssets(out.assets, prefix);
        return [envName, out];
      }),
    );
  }

  const config: Json = {
    ...(schema !== undefined ? { $schema: schema } : {}),
    name: workerName,
    main: GENERATED_WORKER_MAIN,
    compatibility_date: compatibility_date ?? compatibilityDate,
    compatibility_flags: unionFlags(compatibility_flags),
    ...rebaseSection(rest),
    ...(env !== undefined ? { env: envOut } : {}),
    assets: mergeAssets(assets, ""),
  };
  return { config, warnings };
}

/** A compatibility date as Wrangler takes it: `YYYY-MM-DD`. */
const isCompatibilityDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * The compatibility settings each deployment of a generated config runs
 * under: the top level, then every `env.<name>` section (its own date and
 * flags, or the top level's, which Wrangler gives a section without them).
 * A malformed date (reported by generateWranglerConfig) counts as `fallback`.
 */
export const deploymentCompatSettings = (
  config: Json,
  filename: string | undefined,
  fallback: CompatSettings,
): CompatSettings[] => {
  const flagsOf = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value.filter((f): f is string => typeof f === "string")
      : undefined;
  const top: CompatSettings = {
    compatibilityDate: isCompatibilityDate(config.compatibility_date)
      ? config.compatibility_date
      : fallback.compatibilityDate,
    compatibilityFlags:
      flagsOf(config.compatibility_flags) ?? fallback.compatibilityFlags,
    ...(filename ? { source: filename } : {}),
  };
  const settings = [top];
  if (isObject(config.env))
    for (const [envName, section] of Object.entries(config.env)) {
      if (!isObject(section)) continue;
      settings.push({
        compatibilityDate: isCompatibilityDate(section.compatibility_date)
          ? section.compatibility_date
          : top.compatibilityDate,
        compatibilityFlags:
          flagsOf(section.compatibility_flags) ?? top.compatibilityFlags,
        source: `${filename ?? "wrangler.jsonc"} env.${envName}`,
      });
    }
  return settings;
};
