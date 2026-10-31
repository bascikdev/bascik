/**
 * Reads `bascik.ext.json`, `.bascikrc.json`, `bascik.ext.ts` or `bascik.ext.js` without running any of
 * them. Kept out of the package index: `loadExtensionConfig` in config.ts is the public entry point.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BascikExtensionConfig } from "./config.js";

/** Why a config file present in the project could not be read, located by file and line. */
export interface ExtensionConfigProblem {
  file: string;
  line: number;
  message: string;
}

export interface ExtensionConfigResult {
  config: BascikExtensionConfig;
  /** The config file that was read, when the project has one. */
  file?: string;
  problem?: ExtensionConfigProblem;
}

/** Looked up in this order; the first file present is the project's config. */
export const EXTENSION_CONFIG_FILES = [
  "bascik.ext.json",
  ".bascikrc.json",
  "bascik.ext.ts",
  "bascik.ext.js",
] as const;

class LiteralError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

type Token =
  | { kind: "punct" | "ident" | "other"; value: string; start: number }
  | { kind: "string"; value: string; start: number }
  | { kind: "number"; value: number; start: number };

const PUNCT = new Set(["{", "}", "[", "]", "(", ")", ",", ":", ";", "=", "."]);
const STRING_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "\n": "",
};
const NUMBER_RE =
  /0[xX][0-9a-fA-F_]+|(?:[0-9][0-9_]*)?\.?[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?/y;

/**
 * Splits JavaScript or TypeScript source into the tokens a config literal is made of, skipping comments.
 * A template literal without `${` reads as a string; one with `${` is an `other` token, so a config that
 * computes a value is reported instead of evaluated. One pass, so the cost is linear in the file size.
 */
function tokenize(source: string, json = false): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (json && c === "/" && /[/*]/.test(source[i + 1] ?? "")) {
      throw new LiteralError("Comments are not allowed in JSON.", i);
    } else if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end < 0 ? source.length : end + 1;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new LiteralError("Unclosed /* comment.", i);
      i = end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const start = i;
      if (json && c !== '"')
        throw new LiteralError("JSON strings use double quotes.", start);
      let value = "";
      let computed = false;
      i++;
      for (;;) {
        const ch = source[i];
        if (ch === undefined || (c !== "`" && ch === "\n"))
          throw new LiteralError(`Unclosed ${c} string.`, start);
        i++;
        if (ch === c) break;
        if (ch === "\\") {
          const next = source[i] ?? "";
          value += STRING_ESCAPES[next] ?? next;
          i++;
          continue;
        }
        if (c === "`" && ch === "$" && source[i] === "{") computed = true;
        value += ch;
      }
      tokens.push(
        computed
          ? { kind: "other", value: "`...${...}`", start }
          : { kind: "string", value, start },
      );
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1]))) {
      NUMBER_RE.lastIndex = i;
      const text = NUMBER_RE.exec(source)?.[0] ?? c;
      tokens.push({
        kind: "number",
        value: Number(text.replace(/_/g, "")),
        start: i,
      });
      i += text.length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i), start });
    } else {
      tokens.push({
        kind: PUNCT.has(c) ? "punct" : "other",
        value: c,
        start: i,
      });
      i++;
    }
  }
  return tokens;
}

const isPunct = (token: Token | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value;
const isIdent = (token: Token | undefined, value: string): boolean =>
  token?.kind === "ident" && token.value === value;

const UNSUPPORTED =
  "The language server reads this file without running it, so only literal values are allowed: strings, numbers, true, false, null, arrays and objects.";

/** Reads one literal value starting at `tokens[at]`; returns it and the index after it. */
function parseValue(
  tokens: Token[],
  at: number,
  endOffset: number,
  json = false,
): [unknown, number] {
  const token = tokens[at];
  if (!token) throw new LiteralError("Unexpected end of file.", endOffset);
  if (token.kind === "string" || token.kind === "number")
    return [token.value, at + 1];
  const next = tokens[at + 1];
  if (token.kind === "other" && token.value === "-" && next?.kind === "number")
    return [-next.value, at + 2];
  if (token.kind === "ident") {
    if (token.value === "true") return [true, at + 1];
    if (token.value === "false") return [false, at + 1];
    if (token.value === "null") return [null, at + 1];
  }
  const close = isPunct(token, "[") ? "]" : isPunct(token, "{") ? "}" : "";
  if (!close) {
    throw new LiteralError(
      `Unsupported value \`${String(token.value)}\`. ${UNSUPPORTED}`,
      token.start,
    );
  }
  const items: unknown[] = [];
  const object: Record<string, unknown> = {};
  let i = at + 1;
  while (!isPunct(tokens[i], close)) {
    if (close === "]") {
      const [item, after] = parseValue(tokens, i, endOffset, json);
      items.push(item);
      i = after;
    } else {
      const key = tokens[i];
      const isKey = json
        ? key?.kind === "string"
        : key?.kind === "ident" ||
          key?.kind === "string" ||
          key?.kind === "number";
      if (!isKey || !isPunct(tokens[i + 1], ":")) {
        throw new LiteralError(
          `Expected a \`key: value\` property. ${UNSUPPORTED}`,
          key?.start ?? endOffset,
        );
      }
      const [value, after] = parseValue(tokens, i + 2, endOffset, json);
      object[String(key.value)] = value;
      i = after;
    }
    if (isPunct(tokens[i], ",")) {
      if (json && isPunct(tokens[i + 1], close))
        throw new LiteralError(
          "Trailing commas are not allowed in JSON.",
          tokens[i].start,
        );
      i++;
    } else if (!isPunct(tokens[i], close))
      throw new LiteralError(
        `Expected , or ${close}.`,
        tokens[i]?.start ?? endOffset,
      );
  }
  return [close === "]" ? items : object, i + 1];
}

/** Index of the token after the `=` of `const|let|var name[: Type] =`, or -1. */
function declarationValueAt(tokens: Token[], name: string): number {
  for (let i = 0; i + 1 < tokens.length; i++) {
    const keyword = tokens[i];
    if (
      !(
        isIdent(keyword, "const") ||
        isIdent(keyword, "let") ||
        isIdent(keyword, "var")
      ) ||
      !isIdent(tokens[i + 1], name)
    )
      continue;
    // Skip a type annotation up to the `=` at bracket depth 0.
    let depth = 0;
    for (let j = i + 2; j < tokens.length; j++) {
      const token = tokens[j];
      if (depth === 0 && (isPunct(token, "=") || isPunct(token, ";")))
        return isPunct(token, "=") ? j + 1 : -1;
      if (token.kind === "punct" && "{[(".includes(token.value)) depth++;
      if (token.kind === "punct" && "}])".includes(token.value)) depth--;
    }
    return -1;
  }
  return -1;
}

/**
 * The config object of a `bascik.ext.ts` or `bascik.ext.js`, read without running the file: the editor
 * never executes workspace code (project.ts reads `bascik.config.*` lexically too). Accepted shapes:
 * `export default { ... }` (a `satisfies` or `as` after it is fine), `export default name` naming a
 * `const`/`let`/`var` declared with a literal (a type annotation is fine), and `module.exports = { ... }`.
 */
export function parseExtensionConfigSource(source: string): unknown {
  const tokens = tokenize(source);
  let valueAt = -1;
  for (let i = 0; i < tokens.length && valueAt < 0; i++) {
    if (isIdent(tokens[i], "export") && isIdent(tokens[i + 1], "default")) {
      valueAt = i + 2;
    } else if (
      isIdent(tokens[i], "module") &&
      isPunct(tokens[i + 1], ".") &&
      isIdent(tokens[i + 2], "exports") &&
      isPunct(tokens[i + 3], "=")
    ) {
      valueAt = i + 4;
    }
  }
  if (valueAt < 0) {
    throw new LiteralError("No `export default { ... }` found.", source.length);
  }
  while (isPunct(tokens[valueAt], "(")) valueAt++;
  const exported = tokens[valueAt];
  if (
    exported?.kind === "ident" &&
    !["true", "false", "null"].includes(exported.value)
  ) {
    valueAt = declarationValueAt(tokens, exported.value);
    if (valueAt < 0) {
      throw new LiteralError(
        `\`export default ${exported.value}\` does not name a const declared with a value in this file. ${UNSUPPORTED}`,
        exported.start,
      );
    }
    while (isPunct(tokens[valueAt], "(")) valueAt++;
  }
  return parseValue(tokens, valueAt, source.length)[0];
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * The line of a JSON.parse error. Node names a position for some errors only, so the text is re-read
 * with the literal reader in strict JSON mode, which stops at the first offending token.
 */
function jsonErrorLine(raw: string, message: string): number {
  const position = /\bposition (\d+)/.exec(message);
  if (position) return lineOf(raw, Number(position[1]));
  try {
    const tokens = tokenize(raw, true);
    const [, after] = parseValue(tokens, 0, raw.length, true);
    if (tokens[after]) return lineOf(raw, tokens[after].start);
  } catch (error) {
    if (error instanceof LiteralError) return lineOf(raw, error.offset);
  }
  return 1;
}

export function parseExtensionConfigFile(
  fullPath: string,
  raw: string,
): ExtensionConfigResult {
  let value: unknown;
  try {
    value = fullPath.endsWith(".json")
      ? JSON.parse(raw)
      : parseExtensionConfigSource(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line =
      error instanceof LiteralError
        ? lineOf(raw, error.offset)
        : jsonErrorLine(raw, message);
    return {
      config: {},
      file: fullPath,
      problem: { file: fullPath, line, message },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      config: {},
      file: fullPath,
      problem: {
        file: fullPath,
        line: 1,
        message:
          'The config must be an object, such as { "diagnostics": { ... } }.',
      },
    };
  }
  return { config: value as BascikExtensionConfig, file: fullPath };
}

export function readConfigFile(
  projectRoot: string,
): { fullPath: string; raw: string } | undefined {
  for (const filename of EXTENSION_CONFIG_FILES) {
    const fullPath = path.join(projectRoot, filename);
    try {
      return { fullPath, raw: fs.readFileSync(fullPath, "utf8") };
    } catch {
      // Not present (or unreadable): try the next name.
    }
  }
  return undefined;
}

/**
 * Reads the project's extension config and says why it could not be read. The first file present in
 * {@link EXTENSION_CONFIG_FILES} order is the config; a broken one yields `{}` and a located problem
 * rather than falling through to the next file. No file is ever executed.
 */
export function readExtensionConfig(
  projectRoot: string,
): ExtensionConfigResult {
  const found = readConfigFile(projectRoot);
  return found
    ? parseExtensionConfigFile(found.fullPath, found.raw)
    : { config: {} };
}

export function formatExtensionConfigProblem(
  problem: ExtensionConfigProblem,
): string {
  return `${problem.file}:${problem.line}: Bascik extension config ignored: ${problem.message}`;
}
