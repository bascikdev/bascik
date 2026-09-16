/**
 * @module config
 *
 * Structured configuration discovery and parsing for Cloudflare Wrangler configuration files.
 * Supports jsonc (comments and trailing commas), json, and toml with safe error reporting.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseJsoncRaw, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseTomlRaw, TomlError } from "smol-toml";

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
export function parseJsonc(text: string, filename = "wrangler.jsonc"): ParsedWranglerConfig {
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
    throw new Error(`[bascik] Failed to parse ${filename}: expected a top-level JSON object.`);
  }

  return parsed as ParsedWranglerConfig;
}

/**
 * Computes a 1-based line and column for a character offset within text.
 */
function lineAndCharacterAt(text: string, offset: number): { line: number; character: number } {
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
export function parseToml(text: string, filename = "wrangler.toml"): ParsedWranglerConfig {
  try {
    const parsed = parseTomlRaw(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`[bascik] Failed to parse ${filename}: expected a top-level TOML table.`);
    }
    return parsed as ParsedWranglerConfig;
  } catch (err) {
    if (err instanceof TomlError) {
      // TomlError.message includes a codeblock with source excerpts and raw
      // values. Only the first line is safe to surface.
      const reason = err.message.split("\n")[0];
      throw new Error(`[bascik] Failed to parse ${filename} at line ${err.line}: ${reason}.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[bascik] Failed to parse ${filename}: ${msg}`);
  }
}

/**
 * Discovers and parses the highest precedence Wrangler configuration file in the project root.
 * Returns null if no Wrangler configuration file exists.
 * Throws an actionable error if the discovered configuration file is malformed.
 */
export async function discoverWranglerConfig(projectRoot: string): Promise<DiscoveredConfig | null> {
  for (const filename of WRANGLER_CONFIG_FILES) {
    const filePath = join(projectRoot, filename);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
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
): Promise<{ workerName: string; source: "env" | "config" | "package" | "default"; discoveredConfig?: DiscoveredConfig | null }> {
  const envName =
    process.env.CLOUDFLARE_WORKER_NAME ||
    process.env.WORKER_NAME ||
    process.env.CF_PAGES_PROJECT_NAME;

  if (envName && envName.trim()) {
    return { workerName: envName.trim(), source: "env", discoveredConfig };
  }

  const discovered = discoveredConfig !== undefined ? discoveredConfig : await discoverWranglerConfig(projectRoot);
  if (discovered && discovered.values.name && typeof discovered.values.name === "string" && discovered.values.name.trim()) {
    return { workerName: discovered.values.name.trim(), source: "config", discoveredConfig: discovered };
  }

  try {
    const pkgJsonRaw = await readFile(join(projectRoot, "package.json"), "utf8");
    const pkgJson = JSON.parse(pkgJsonRaw) as { name?: string };
    if (pkgJson.name && typeof pkgJson.name === "string" && pkgJson.name.trim()) {
      const name = pkgJson.name.replace(/^@[^/]+\//, "").trim();
      if (name) {
        return { workerName: name, source: "package", discoveredConfig: discovered };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[bascik] Failed to parse package.json: ${msg}`);
    }
  }

  return { workerName: "bascik-site", source: "default", discoveredConfig: discovered };
}
