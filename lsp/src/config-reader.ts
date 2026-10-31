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
  // A backslash before a line break continues the string on the next line.
  "\n": "",
  "\r": "",
  "\u2028": "",
  "\u2029": "",
};
/** The hex digits of a `\x`, `\u` or `\u{...}` escape, read from just after the letter. */
const CODE_ESCAPE_DIGITS = {
  x: /[0-9a-fA-F]{2}/y,
  u: /[0-9a-fA-F]{4}/y,
  "u{": /\{([0-9a-fA-F]+)\}/y,
};

/**
 * Decodes the `\xHH`, `\uHHHH` or `\u{H...}` escape whose letter is at `at`; returns the text and the
 * index after it. A malformed one is reported, as JavaScript reports it, instead of read as letters.
 */
function readCodeEscape(source: string, at: number): [string, number] {
  const form = source[at] === "x" ? "x" : source[at + 1] === "{" ? "u{" : "u";
  const digits = CODE_ESCAPE_DIGITS[form];
  digits.lastIndex = at + 1;
  const match = digits.exec(source);
  const codePoint = match ? parseInt(match[1] ?? match[0], 16) : NaN;
  if (!match || !(codePoint <= 0x10ffff))
    throw new LiteralError(
      `Invalid \\${source[at]} escape in a string.`,
      at - 1,
    );
  return [String.fromCodePoint(codePoint), digits.lastIndex];
}
const NUMBER_RE =
  /0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?/y;

/** Words after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Whether a `/` after `previous` starts a regex literal: at the start, after an operator or `(`, `,`,
 * `=`, `:` and the like, or after a keyword such as `return`. After a value, `)`, `]` or `}` it divides.
 */
function regexCanStartAfter(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === "string" || previous.kind === "number") return false;
  if (previous.kind === "ident") return REGEX_AFTER_WORDS.has(previous.value);
  // A template literal or a regex literal is a value; a lone `/` is the division operator.
  if (previous.value.length > 1) return false;
  return (
    previous.value !== ")" && previous.value !== "]" && previous.value !== "}"
  );
}

/**
 * Index after the regex literal (flags included) whose `/` is at `start`, or the negated index of the line
 * break (or end of file) it reached without closing.
 */
function regexLiteralEnd(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029")
      return -i;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = i + 1;
      while (end < source.length && /[\w$]/.test(source[end])) end++;
      return end;
    }
  }
  return -source.length;
}

/**
 * Splits JavaScript or TypeScript source into the tokens a config literal is made of, skipping comments.
 * A template literal without `${` reads as a string; one with `${` is an `other` token, so a config that
 * computes a value is reported instead of evaluated. One pass, so the cost is linear in the file size.
 */
function tokenize(source: string, json = false): Token[] {
  const tokens: Token[] = [];
  // Where the last `/` that could not be a regex stopped looking, so a line of slashes is scanned once.
  let noRegexBefore = 0;
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
    } else if (
      !json &&
      c === "/" &&
      i >= noRegexBefore &&
      regexCanStartAfter(tokens[tokens.length - 1])
    ) {
      // A regex literal: its quotes and slashes are not strings or comments. One that does not close on
      // its line is a division after all.
      const end = regexLiteralEnd(source, i);
      if (end > 0) {
        tokens.push({ kind: "other", value: source.slice(i, end), start: i });
        i = end;
      } else {
        noRegexBefore = -end;
        tokens.push({ kind: "other", value: "/", start: i });
        i++;
      }
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
          if (next === "\r" && source[i + 1] === "\n") {
            // A CRLF line continuation, as a Windows editor saves one.
            i += 2;
            continue;
          }
          if (next === "x" || next === "u") {
            const [decoded, after] = readCodeEscape(source, i);
            value += decoded;
            i = after;
            continue;
          }
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
      // An own property even for `__proto__`, as JSON.parse makes it, so a key never sets the prototype.
      Object.defineProperty(object, String(key.value), {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
  readError?: string,
): ExtensionConfigResult {
  if (readError !== undefined) {
    return {
      config: {},
      file: fullPath,
      problem: {
        file: fullPath,
        line: 1,
        message: `The file could not be read: ${readError}`,
      },
    };
  }
  let value: unknown;
  try {
    // JSON.parse rejects the byte order mark some Windows editors write first.
    value = fullPath.endsWith(".json")
      ? JSON.parse(raw.replace(/^\uFEFF/, ""))
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

/**
 * The first config file present in {@link EXTENSION_CONFIG_FILES} order. A file that is there but cannot be
 * read (a folder by that name, no permission) is still the config, with `readError` saying why, so it is
 * reported instead of silently replaced by the next name.
 */
export function readConfigFile(
  projectRoot: string,
): { fullPath: string; raw: string; readError?: string } | undefined {
  for (const filename of EXTENSION_CONFIG_FILES) {
    const fullPath = path.join(projectRoot, filename);
    try {
      return { fullPath, raw: fs.readFileSync(fullPath, "utf8") };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Not present: try the next name.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return {
        fullPath,
        raw: "",
        readError: error instanceof Error ? error.message : String(error),
      };
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
    ? parseExtensionConfigFile(found.fullPath, found.raw, found.readError)
    : { config: {} };
}

export function formatExtensionConfigProblem(
  problem: ExtensionConfigProblem,
): string {
  return `${problem.file}:${problem.line}: Bascik extension config ignored: ${problem.message}`;
}
