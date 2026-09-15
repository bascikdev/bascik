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
 * Parses JSONC (JSON with comments and trailing commas) using a structured tokenizer.
 * Handles line comments (//), block comments (/* *\/), and trailing commas in objects and arrays.
 * Preserves strings accurately without breaking on URLs or embedded comment syntax in string literals.
 */
export function parseJsonc(text: string, filename = "wrangler.jsonc"): ParsedWranglerConfig {
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
    return parsed as ParsedWranglerConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[bascik] Failed to parse ${filename}: ${msg}`);
  }
}

/**
 * Parses TOML primitive or array value literals.
 */
function parseTomlValue(rawVal: string, filename: string): unknown {
  const valStr = rawVal.trim();
  if (valStr.startsWith("[") && valStr.endsWith("]")) {
    const inner = valStr.slice(1, -1).trim();
    if (!inner) return [];
    // Split elements respecting quotes and nested brackets
    const elements: string[] = [];
    let currentElem = "";
    let inQuote: string | null = null;
    let bracketDepth = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (inQuote) {
        currentElem += ch;
        if (ch === inQuote && inner[i - 1] !== "\\") {
          inQuote = null;
        }
      } else {
        if (ch === '"' || ch === "'") {
          inQuote = ch;
          currentElem += ch;
        } else if (ch === "[") {
          bracketDepth++;
          currentElem += ch;
        } else if (ch === "]") {
          bracketDepth--;
          currentElem += ch;
        } else if (ch === "," && bracketDepth === 0) {
          elements.push(currentElem.trim());
          currentElem = "";
        } else {
          currentElem += ch;
        }
      }
    }
    if (currentElem.trim()) {
      elements.push(currentElem.trim());
    }
    return elements.map((elem) => parseTomlValue(elem, filename));
  }

  if (
    (valStr.startsWith('"') && valStr.endsWith('"')) ||
    (valStr.startsWith("'") && valStr.endsWith("'"))
  ) {
    return valStr.slice(1, -1);
  } else if (valStr === "true") {
    return true;
  } else if (valStr === "false") {
    return false;
  } else if (!Number.isNaN(Number(valStr)) && valStr !== "") {
    return Number(valStr);
  }
  return valStr;
}

/**
 * Parses TOML syntax relevant for Wrangler config files:
 * - standard tables ([table])
 * - array of tables ([[table]]) such as [[migrations]]
 * - multi-line arrays (e.g. compatibility_flags = [\n "nodejs_compat",\n])
 * - inline arrays, comments, quoted keys, primitives
 */
export function parseToml(text: string, filename = "wrangler.toml"): ParsedWranglerConfig {
  const root: Record<string, unknown> = {};
  let currentTarget: Record<string, unknown> = root;

  const rawLines = text.split(/\r?\n/);

  // First pass: join multi-line arrays and remove comments
  const joinedLines: { text: string; startLine: number }[] = [];
  let buffer = "";
  let bufferStartLine = 1;
  let bracketDepth = 0;
  let inStringQuote: string | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const lineNum = i + 1;

    // Scan character by character to strip comments not inside quotes and track bracket depth
    let strippedLine = "";
    for (let c = 0; c < rawLine.length; c++) {
      const ch = rawLine[c];
      if (inStringQuote) {
        strippedLine += ch;
        if (ch === inStringQuote && rawLine[c - 1] !== "\\") {
          inStringQuote = null;
        }
      } else {
        if (ch === '"' || ch === "'") {
          inStringQuote = ch;
          strippedLine += ch;
        } else if (ch === "#") {
          break; // Comment starts here
        } else {
          if (ch === "[") bracketDepth++;
          if (ch === "]") bracketDepth--;
          strippedLine += ch;
        }
      }
    }

    const trimmed = strippedLine.trim();
    if (!trimmed) {
      if (bracketDepth === 0 && !buffer) continue;
    }

    if (!buffer) {
      bufferStartLine = lineNum;
      buffer = trimmed;
    } else {
      buffer += " " + trimmed;
    }

    if (bracketDepth <= 0 && !inStringQuote) {
      if (buffer.trim()) {
        joinedLines.push({ text: buffer.trim(), startLine: bufferStartLine });
      }
      buffer = "";
      bracketDepth = 0;
    }
  }

  if (bracketDepth > 0 || inStringQuote) {
    throw new Error(`[bascik] Failed to parse ${filename} starting at line ${bufferStartLine}: unclosed array or string.`);
  }

  for (const { text: line, startLine } of joinedLines) {
    if (!line || line.startsWith("#")) continue;

    // Check for array of tables [[table.name]]
    const arrayOfTablesMatch = line.match(/^\[\[([A-Za-z0-9_\-.]+)\]\]$/);
    if (arrayOfTablesMatch) {
      const sectionPath = arrayOfTablesMatch[1].split(".");
      let targetObj = root;
      for (let s = 0; s < sectionPath.length - 1; s++) {
        const part = sectionPath[s];
        if (!targetObj[part] || typeof targetObj[part] !== "object") {
          targetObj[part] = {};
        }
        targetObj = targetObj[part] as Record<string, unknown>;
      }
      const lastPart = sectionPath[sectionPath.length - 1];
      if (!Array.isArray(targetObj[lastPart])) {
        targetObj[lastPart] = [];
      }
      const newEntry: Record<string, unknown> = {};
      (targetObj[lastPart] as Record<string, unknown>[]).push(newEntry);
      currentTarget = newEntry;
      continue;
    }

    // Check for section table [table.name]
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

    // Parse key-value assignment
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
        }
      }
    }

    if (splitIdx === -1) {
      throw new Error(`[bascik] Failed to parse ${filename} at line ${startLine}: invalid syntax.`);
    }

    const parsedKey = line.slice(0, splitIdx).trim();
    const rest = line.slice(splitIdx + 1).trim();

    const val = parseTomlValue(rest, filename);

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
