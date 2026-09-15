/**
 * @module config
 *
 * Structured configuration discovery and parsing for Cloudflare Wrangler configuration files.
 * Supports jsonc (comments and trailing commas), json, and toml with safe error reporting.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";

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
  [key: string]: unknown;
}

export interface DiscoveredConfig {
  filename: WranglerConfigFile;
  filePath: string;
  config: ParsedWranglerConfig;
}

/**
 * Parses JSONC (JSON with comments and trailing commas) using a structured tokenizer.
 * Handles line comments (//), block comments (/* *\/), and trailing commas in objects and arrays.
 * Preserves strings accurately without breaking on URLs or embedded comment syntax in string literals.
 */
export function parseJsonc(text: string, filename = "wrangler.jsonc"): Record<string, unknown> {
  let result = "";
  let i = 0;
  const len = text.length;

  let inString = false;
  let isEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < len) {
    const char = text[i];
    const nextChar = i + 1 < len ? text[i + 1] : "";

    if (inString) {
      result += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        result += char;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      i++;
      continue;
    }

    if (char === "/" && nextChar === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    result += char;
    i++;
  }

  if (inBlockComment) {
    throw new Error(`[bascik] Failed to parse ${filename}: unclosed block comment.`);
  }

  // Strip trailing commas before } or ] while respecting whitespace
  let cleanJson = "";
  let j = 0;
  const resLen = result.length;
  let inCleanString = false;
  let isCleanEscaped = false;

  while (j < resLen) {
    const c = result[j];
    if (inCleanString) {
      cleanJson += c;
      if (isCleanEscaped) {
        isCleanEscaped = false;
      } else if (c === "\\") {
        isCleanEscaped = true;
      } else if (c === '"') {
        inCleanString = false;
      }
      j++;
      continue;
    }

    if (c === '"') {
      inCleanString = true;
      cleanJson += c;
      j++;
      continue;
    }

    if (c === ",") {
      // Lookahead to see if next non-whitespace character is } or ]
      let k = j + 1;
      while (k < resLen && /\s/.test(result[k])) {
        k++;
      }
      if (k < resLen && (result[k] === "}" || result[k] === "]")) {
        // Skip trailing comma
        j++;
        continue;
      }
    }

    cleanJson += c;
    j++;
  }

  try {
    const parsed = JSON.parse(cleanJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Expected a top-level JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[bascik] Failed to parse ${filename}: ${msg}`);
  }
}

/**
 * Parses basic TOML syntax relevant for Wrangler config files (top-level key-values and basic tables).
 * Avoids ad-hoc fragile regex and handles quoted keys, comments, multi-line strings, and tables.
 */
export function parseToml(text: string, filename = "wrangler.toml"): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentTarget: Record<string, unknown> = root;

  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    let line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    // Check for section header [table]
    const tableMatch = line.match(/^\[([A-Za-z0-9_\-.]+)\]$/);
    if (tableMatch) {
      const sectionPath = tableMatch[1].split(".");
      currentTarget = root;
      for (const section of sectionPath) {
        if (!currentTarget[section] || typeof currentTarget[section] !== "object") {
          currentTarget[section] = {};
        }
        currentTarget = currentTarget[section] as Record<string, unknown>;
      }
      continue;
    }

    // Strip comments after values if not inside quotes
    let parsedKey = "";
    let inQuote: string | null = null;
    let splitIdx = -1;

    for (let cIdx = 0; cIdx < line.length; cIdx++) {
      const ch = line[cIdx];
      if (inQuote) {
        if (ch === inQuote && line[cIdx - 1] !== "\\") {
          inQuote = null;
        }
      } else {
        if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === "=") {
          splitIdx = cIdx;
          break;
        } else if (ch === "#") {
          // Comment before equals sign - syntax error
          break;
        }
      }
    }

    if (splitIdx === -1) {
      throw new Error(`[bascik] Failed to parse ${filename} at line ${lineIndex + 1}: invalid syntax.`);
    }

    parsedKey = line.slice(0, splitIdx).trim();
    const rest = line.slice(splitIdx + 1).trim();

    // Remove trailing comment from rest
    let valStr = "";
    inQuote = null;
    for (let cIdx = 0; cIdx < rest.length; cIdx++) {
      const ch = rest[cIdx];
      if (inQuote) {
        valStr += ch;
        if (ch === inQuote && rest[cIdx - 1] !== "\\") {
          inQuote = null;
        }
      } else {
        if (ch === '"' || ch === "'") {
          inQuote = ch;
          valStr += ch;
        } else if (ch === "#") {
          break;
        } else {
          valStr += ch;
        }
      }
    }
    valStr = valStr.trim();

    // Parse primitive values
    let val: unknown = valStr;
    if (
      (valStr.startsWith('"') && valStr.endsWith('"')) ||
      (valStr.startsWith("'") && valStr.endsWith("'"))
    ) {
      val = valStr.slice(1, -1);
    } else if (valStr === "true") {
      val = true;
    } else if (valStr === "false") {
      val = false;
    } else if (!Number.isNaN(Number(valStr)) && valStr !== "") {
      val = Number(valStr);
    }

    // Set key in currentTarget (handling dot-notation keys like site.bucket)
    const keyParts = parsedKey.split(".").map((k) => k.trim().replace(/^["']|["']$/g, ""));
    let targetObj = currentTarget;
    for (let k = 0; k < keyParts.length - 1; k++) {
      const part = keyParts[k];
      if (!targetObj[part] || typeof targetObj[part] !== "object") {
        targetObj[part] = {};
      }
      targetObj = targetObj[part] as Record<string, unknown>;
    }
    targetObj[keyParts[keyParts.length - 1]] = val;
  }

  return root;
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
      const config = parseToml(raw, filename);
      return { filename, filePath, config };
    } else {
      const config = parseJsonc(raw, filename);
      return { filename, filePath, config };
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
): Promise<{ workerName: string; source: "env" | "config" | "package" | "default"; config?: DiscoveredConfig | null }> {
  const envName =
    process.env.CLOUDFLARE_WORKER_NAME ||
    process.env.WORKER_NAME ||
    process.env.CF_PAGES_PROJECT_NAME;

  if (envName && envName.trim()) {
    return { workerName: envName.trim(), source: "env", config: discoveredConfig };
  }

  const config = discoveredConfig !== undefined ? discoveredConfig : await discoverWranglerConfig(projectRoot);
  if (config && config.config.name && typeof config.config.name === "string" && config.config.name.trim()) {
    return { workerName: config.config.name.trim(), source: "config", config };
  }

  try {
    const pkgJsonRaw = await readFile(join(projectRoot, "package.json"), "utf8");
    const pkgJson = JSON.parse(pkgJsonRaw) as { name?: string };
    if (pkgJson.name && typeof pkgJson.name === "string" && pkgJson.name.trim()) {
      const name = pkgJson.name.replace(/^@[^/]+\//, "").trim();
      if (name) {
        return { workerName: name, source: "package", config };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[bascik] Failed to parse package.json: ${msg}`);
    }
  }

  return { workerName: "bascik-site", source: "default", config };
}
