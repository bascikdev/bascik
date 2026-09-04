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

const isIdentifierStart = (character: string): boolean => /[A-Za-z_$]/.test(character);
const isIdentifierPart = (character: string): boolean => /[A-Za-z0-9_$]/.test(character);
const CONTROL_HEAD_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const STATEMENT_PREFIX_KEYWORDS = new Set(["do", "else", "finally", "try"]);

interface DelimiterContext {
  character: "(" | "{" | "[";
  allowsRegexAfterClose: boolean;
}

const tokenizeJavaScript = (source: string): Token[] => {
  const tokens: Token[] = [];

  const scanCode = (start: number, stopAtClosingBrace: boolean): number => {
    let index = start;
    let braceDepth = 0;
    let canStartRegex = true;
    let statementExpected = true;
    const delimiters: DelimiterContext[] = [];

    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];

      if (/\s/.test(character)) {
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
            while (/[A-Za-z]/.test(source[index] ?? "")) index++;
            break;
          } else {
            index++;
          }
        }
        canStartRegex = false;
        statementExpected = false;
        continue;
      }

      if (isIdentifierStart(character)) {
        const tokenStart = index++;
        while (index < source.length && isIdentifierPart(source[index])) index++;
        const value = source.slice(tokenStart, index);
        tokens.push({ type: "identifier", value, start: tokenStart, end: index });
        canStartRegex = ["case", "delete", "return", "throw", "typeof", "void", "yield"].includes(value);
        statementExpected = STATEMENT_PREFIX_KEYWORDS.has(value);
        continue;
      }

      if (/[0-9]/.test(character)) {
        index++;
        while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index++;
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

export const findModuleSpecifiers = (source: string): ModuleSpecifier[] => {
  const tokens = tokenizeJavaScript(source);
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

export const findCallArgumentStringLiterals = (source: string): ModuleSpecifier[] => {
  const tokens = tokenizeJavaScript(source);
  return tokens.filter((token, index): token is Token & ModuleSpecifier =>
    token.type === "string" && ["(", ","].includes(tokens[index - 1]?.value),
  );
};

export const rewriteRelativeModuleSpecifiers = (source: string, baseDir: string): string => {
  const replacements = findModuleSpecifiers(source)
    .filter(({ value }) => value.startsWith("./") || value.startsWith("../"))
    .sort((left, right) => right.start - left.start);

  let rewritten = source;
  for (const { start, end, value } of replacements) {
    rewritten =
      rewritten.slice(0, start) +
      pathToFileURL(resolve(baseDir, value)).href +
      rewritten.slice(end);
  }
  return rewritten;
};