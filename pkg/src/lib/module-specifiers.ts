import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ModuleSpecifier {
  start: number;
  end: number;
  value: string;
}

interface Token {
  type: "identifier" | "string" | "punctuation";
  value: string;
  start: number;
  end: number;
}

// Character classes as char-code tests. `scanCode` runs these once per source
// character, and `RegExp.prototype.test` on a one-character string was the
// largest self-time frame family in the tokenizer. Each predicate is verified
// exhaustively against the regex it replaced across the whole BMP in
// module-specifiers-scan.test.ts.
const isSpaceCode = (code: number): boolean => {
  // ECMAScript WhiteSpace + LineTerminator, exactly the `\s` class.
  if (code <= 32) return code === 32 || (code >= 9 && code <= 13);
  if (code < 0xa0) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
};
const isAlphaCode = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;
const isIdStartCode = (code: number): boolean => isAlphaCode(code) || code === 95 || code === 36;
const isIdPartCode = (code: number): boolean => isIdStartCode(code) || isDigitCode(code);
const isNumberPartCode = (code: number): boolean =>
  isAlphaCode(code) || isDigitCode(code) || code === 95 || code === 46;

/** Test-only: the predicates above, for the exhaustive BMP equivalence test. */
export const __charClassesForTests = {
  isSpace: isSpaceCode,
  isAlpha: isAlphaCode,
  isDigit: isDigitCode,
  isIdStart: isIdStartCode,
  isIdPart: isIdPartCode,
  isNumberPart: isNumberPartCode,
};

/** Test-only: counts tokenizer invocations for the single-pass guard. */
export const __tokenizeStatsForTests = {
  tokenizeCalls: 0,
  reset(): void {
    this.tokenizeCalls = 0;
  },
};

const REGEX_PRECEDING_IDENTIFIERS = new Set(["case", "delete", "return", "throw", "typeof", "void", "yield"]);
const CONTROL_HEAD_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const STATEMENT_PREFIX_KEYWORDS = new Set(["do", "else", "finally", "try"]);

interface DelimiterContext {
  character: "(" | "{" | "[";
  allowsRegexAfterClose: boolean;
}

const tokenizeJavaScript = (source: string): Token[] => {
  __tokenizeStatsForTests.tokenizeCalls++;
  const tokens: Token[] = [];

  const scanCode = (start: number, stopAtClosingBrace: boolean): number => {
    let index = start;
    let braceDepth = 0;
    let canStartRegex = true;
    let statementExpected = true;
    const delimiters: DelimiterContext[] = [];

    while (index < source.length) {
      const character = source[index];
      const code = source.charCodeAt(index);
      const next = source[index + 1];

      if (isSpaceCode(code)) {
        index++;
        continue;
      }

      if (character === "/" && next === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") index++;
        continue;
      }

      if (character === "/" && next === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
        index = Math.min(index + 2, source.length);
        continue;
      }

      if (character === "'" || character === '"') {
        const quote = character;
        const tokenStart = index;
        index++;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
          } else if (source[index] === quote) {
            index++;
            break;
          } else {
            index++;
          }
        }
        tokens.push({
          type: "string",
          value: source.slice(tokenStart + 1, index - 1),
          start: tokenStart + 1,
          end: index - 1,
        });
        canStartRegex = false;
        continue;
      }

      if (character === "`") {
        index++;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
          } else if (source[index] === "`") {
            index++;
            break;
          } else if (source[index] === "$" && source[index + 1] === "{") {
            index = scanCode(index + 2, true);
          } else {
            index++;
          }
        }
        canStartRegex = false;
        statementExpected = false;
        continue;
      }

      if (character === "/" && canStartRegex) {
        index++;
        let inCharacterClass = false;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
          } else if (source[index] === "[") {
            inCharacterClass = true;
            index++;
          } else if (source[index] === "]") {
            inCharacterClass = false;
            index++;
          } else if (source[index] === "/" && !inCharacterClass) {
            index++;
            while (index < source.length && isAlphaCode(source.charCodeAt(index))) index++;
            break;
          } else {
            index++;
          }
        }
        canStartRegex = false;
        statementExpected = false;
        continue;
      }

      if (isIdStartCode(code)) {
        const tokenStart = index++;
        while (index < source.length && isIdPartCode(source.charCodeAt(index))) index++;
        const value = source.slice(tokenStart, index);
        tokens.push({ type: "identifier", value, start: tokenStart, end: index });
        canStartRegex = REGEX_PRECEDING_IDENTIFIERS.has(value);
        statementExpected = STATEMENT_PREFIX_KEYWORDS.has(value);
        continue;
      }

      if (isDigitCode(code)) {
        index++;
        while (index < source.length && isNumberPartCode(source.charCodeAt(index))) index++;
        canStartRegex = false;
        statementExpected = false;
        continue;
      }

      if (character === "{" && stopAtClosingBrace) {
        braceDepth++;
      } else if (character === "}" && stopAtClosingBrace) {
        if (braceDepth === 0) return index + 1;
        braceDepth--;
      }

      tokens.push({ type: "punctuation", value: character, start: index, end: index + 1 });
      const previousToken = tokens[tokens.length - 2];
      if (character === "(") {
        delimiters.push({
          character,
          allowsRegexAfterClose:
            previousToken?.type === "identifier" && CONTROL_HEAD_KEYWORDS.has(previousToken.value),
        });
        canStartRegex = true;
        statementExpected = false;
      } else if (character === "{") {
        const isStatementBlock = statementExpected || previousToken?.value === ")" ||
          (previousToken?.value === ">" && tokens[tokens.length - 3]?.value === "=");
        delimiters.push({ character, allowsRegexAfterClose: isStatementBlock });
        canStartRegex = true;
        statementExpected = true;
      } else if (character === "[") {
        delimiters.push({ character, allowsRegexAfterClose: false });
        canStartRegex = true;
        statementExpected = false;
      } else if (character === ")" || character === "}" || character === "]") {
        const expectedOpen = character === ")" ? "(" : character === "}" ? "{" : "[";
        const delimiter = delimiters.at(-1)?.character === expectedOpen ? delimiters.pop() : undefined;
        canStartRegex = delimiter?.allowsRegexAfterClose ?? false;
        statementExpected = canStartRegex;
      } else {
        canStartRegex = true;
        statementExpected = character === ";";
      }
      index++;
    }

    return index;
  };

  scanCode(0, false);
  return tokens.sort((left, right) => left.start - right.start);
};

const moduleSpecifiersFromTokens = (tokens: Token[]): ModuleSpecifier[] => {
  const specifiers: ModuleSpecifier[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "identifier" || (token.value !== "import" && token.value !== "export")) continue;
    if (tokens[index - 1]?.value === ".") continue;

    const next = tokens[index + 1];
    if (token.value === "import" && next?.type === "string") {
      specifiers.push(next);
      continue;
    }
    if (token.value === "import" && next?.value === "(" && tokens[index + 2]?.type === "string") {
      specifiers.push(tokens[index + 2]);
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const candidate = tokens[cursor];
      if (candidate.value === ";" ||
        (candidate.type === "identifier" && (candidate.value === "import" || candidate.value === "export"))) {
        break;
      }
      if (candidate.type === "identifier" && candidate.value === "from" && tokens[cursor + 1]?.type === "string") {
        specifiers.push(tokens[cursor + 1]);
        break;
      }
    }
  }

  return specifiers;
};

const callArgumentLiteralsFromTokens = (tokens: Token[]): ModuleSpecifier[] =>
  tokens.filter((token, index): token is Token & ModuleSpecifier =>
    token.type === "string" && ["(", ","].includes(tokens[index - 1]?.value),
  );

export const findModuleSpecifiers = (source: string): ModuleSpecifier[] =>
  moduleSpecifiersFromTokens(tokenizeJavaScript(source));

export const findCallArgumentStringLiterals = (source: string): ModuleSpecifier[] =>
  callArgumentLiteralsFromTokens(tokenizeJavaScript(source));

export interface ScriptScan {
  moduleSpecifiers: ModuleSpecifier[];
  callArgumentLiterals: ModuleSpecifier[];
}

/**
 * Tokenize `source` once and derive both the module specifiers and the
 * call-argument string literals from the same token array. Equivalent to
 * calling `findModuleSpecifiers` and `findCallArgumentStringLiterals`
 * separately, at half the lexing cost. Dependency extraction needs both.
 */
export const scanScript = (source: string): ScriptScan => {
  const tokens = tokenizeJavaScript(source);
  return {
    moduleSpecifiers: moduleSpecifiersFromTokens(tokens),
    callArgumentLiterals: callArgumentLiteralsFromTokens(tokens),
  };
};

/**
 * How a module specifier (or a script tag `src=` value) is resolved by Bascik.
 *
 * - `relative`: `./` or `../`, resolved against the containing file's directory.
 * - `root`: `@/`, resolved against the configured import root
 *   (`scripts.importRoot`, default `src`).
 * - `root-slash`: a leading `/`. Rejected with a hard error. A bare slash is
 *   ambiguous between "filesystem root" (what Node means) and "site root"
 *   (what an HTML `src=` attribute means), so Bascik refuses to guess and
 *   points the author at `@/` or `./` instead.
 * - `external`: everything else (bare packages such as `marked` or `@scope/pkg`,
 *   `node:` builtins, `file:`/`https:`/`data:` URLs). Left untouched for Node.
 *
 * `@scope/pkg` is deliberately NOT a root alias: only the exact `@/` prefix is.
 */
export type SpecifierClass = "relative" | "root" | "root-slash" | "external";

export const classifySpecifier = (value: string): SpecifierClass => {
  if (value.startsWith("./") || value.startsWith("../")) return "relative";
  if (value.startsWith("@/")) return "root";
  if (value.startsWith("/")) return "root-slash";
  return "external";
};

/**
 * Thrown when a build, server, or routes script uses a leading-slash specifier
 * or `src=` value. Carries the two valid rewrites so callers (the compiler
 * error surface and the VS Code diagnostic) can show the same suggestion.
 */
export class LeadingSlashSpecifierError extends Error {
  readonly specifier: string;
  readonly aliasSuggestion: string;
  readonly relativeSuggestion: string;

  constructor(specifier: string) {
    const rest = specifier.replace(/^\/+/, "");
    const aliasSuggestion = `@/${rest}`;
    const relativeSuggestion = `./${rest}`;
    super(formatLeadingSlashMessage(specifier, aliasSuggestion, relativeSuggestion));
    this.name = "LeadingSlashSpecifierError";
    this.specifier = specifier;
    this.aliasSuggestion = aliasSuggestion;
    this.relativeSuggestion = relativeSuggestion;
  }
}

/**
 * Single source of truth for the leading-slash error text. The VS Code
 * extension reproduces this wording in its diagnostic so the editor and the
 * compiler agree.
 */
export const formatLeadingSlashMessage = (
  specifier: string,
  aliasSuggestion: string,
  relativeSuggestion: string,
): string =>
  `Leading-slash specifier '${specifier}' is not supported in Bascik scripts. ` +
  `A bare '/' is ambiguous (filesystem root vs. site root). ` +
  `Use '${aliasSuggestion}' to resolve against scripts.importRoot, ` +
  `or '${relativeSuggestion}' to resolve relative to this file.`;

/** Strip the `@/` alias prefix so the remainder can be joined onto the import root. */
const stripRootPrefix = (value: string): string => value.slice(2);

export interface RewriteModuleSpecifierOptions {
  /** Absolute path of the import root that `@/` resolves against. */
  importRoot: string;
}

/**
 * Resolve a specifier to an absolute filesystem path using Bascik's rules.
 * Returns `undefined` for external specifiers, which are left to Node.
 * Throws `LeadingSlashSpecifierError` for a leading `/`.
 */
export const resolveSpecifierPath = (
  value: string,
  baseDir: string,
  importRoot: string,
): string | undefined => {
  switch (classifySpecifier(value)) {
    case "relative":
      return resolve(baseDir, value);
    case "root":
      return resolve(importRoot, stripRootPrefix(value));
    case "root-slash":
      throw new LeadingSlashSpecifierError(value);
    default:
      return undefined;
  }
};

/**
 * Resolve the `src="…"` attribute of a build, server, or routes script tag.
 * Relative and bare paths resolve against the containing file's directory
 * (unchanged behavior); `@/` resolves against the import root; a leading `/`
 * throws. This is the single helper every script kind must use so `src=`
 * semantics cannot drift.
 */
export const resolveScriptSrcPath = (
  srcPath: string,
  containingDir: string,
  importRoot: string,
): string => {
  const kind = classifySpecifier(srcPath);
  if (kind === "root") return resolve(importRoot, stripRootPrefix(srcPath));
  if (kind === "root-slash") throw new LeadingSlashSpecifierError(srcPath);
  return resolve(containingDir, srcPath);
};

/**
 * Rewrite every genuine ESM specifier (static import, bare import, export-from,
 * dynamic import) that Bascik owns to an absolute `file://` URL, so the script
 * can execute from a temp module under `node_modules/.cache/bascik/` while
 * still resolving the author's helpers. External specifiers, comments, strings,
 * template raw text, and regex literals are left byte-for-byte unchanged.
 */
export const rewriteModuleSpecifiers = (
  source: string,
  baseDir: string,
  { importRoot }: RewriteModuleSpecifierOptions,
): string => {
  const replacements = findModuleSpecifiers(source)
    .map((specifier) => ({
      ...specifier,
      resolved: resolveSpecifierPath(specifier.value, baseDir, importRoot),
    }))
    .filter((specifier): specifier is ModuleSpecifier & { resolved: string } => specifier.resolved !== undefined)
    .sort((left, right) => right.start - left.start);

  let rewritten = source;
  for (const { start, end, resolved } of replacements) {
    // String concatenation (not String.replace) so `$&`, `$1`, and similar
    // tokens in paths are inserted literally.
    rewritten =
      rewritten.slice(0, start) +
      pathToFileURL(resolved).href +
      rewritten.slice(end);
  }
  return rewritten;
};