export interface ModuleSpecifier {
  start: number;
  end: number;
  value: string;
}

/**
 * A token of a script. A `string` token's offsets and value are its text
 * between the quotes. A `template` is a template literal with no holes
 * (offsets and value inside the backticks); one with holes gives no token of
 * its own, only the tokens of the code in its holes.
 */
export interface Token extends ModuleSpecifier {
  type: "identifier" | "string" | "template" | "punctuation";
}

/** A `//` or `/* *\/` comment, with its delimiters. */
export interface Comment {
  start: number;
  end: number;
}

const isIdentifierStart = (character: string): boolean =>
  /[A-Za-z_$]/.test(character);
const isIdentifierPart = (character: string): boolean =>
  /[A-Za-z0-9_$]/.test(character);
const CONTROL_HEAD_KEYWORDS = new Set([
  "catch",
  "for",
  "if",
  "switch",
  "while",
  "with",
]);
const STATEMENT_PREFIX_KEYWORDS = new Set(["do", "else", "finally", "try"]);

interface DelimiterContext {
  character: "(" | "{" | "[";
  allowsRegexAfterClose: boolean;
}

/** A code frame: the top level, or the code in one template hole. */
interface CodeFrame {
  kind: "code";
  stopAtClosingBrace: boolean;
  braceDepth: number;
  canStartRegex: boolean;
  statementExpected: boolean;
  delimiters: DelimiterContext[];
}

/** A template literal's text, between its holes. */
interface TemplateFrame {
  kind: "template";
  tokenStart: number;
  holes: boolean;
}

/**
 * The tokens of a script in source order, and its comments. Strings,
 * template text and regular expression literals are skipped as units, so a
 * quote inside `/"/g` opens no string. One linear pass, with the templates
 * and holes still open kept on an explicit stack, so templates nested
 * thousands deep cannot overflow the call stack.
 */
export const scanJavaScript = (
  source: string,
): { tokens: Token[]; comments: Comment[] } => {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const codeFrame = (stopAtClosingBrace: boolean): CodeFrame => ({
    kind: "code",
    stopAtClosingBrace,
    braceDepth: 0,
    canStartRegex: true,
    statementExpected: true,
    delimiters: [],
  });
  const stack: (CodeFrame | TemplateFrame)[] = [codeFrame(false)];
  /** Closes the innermost template, which ends just before `end`. */
  const closeTemplate = (frame: TemplateFrame, end: number): void => {
    if (!frame.holes)
      tokens.push({
        type: "template",
        value: source.slice(frame.tokenStart + 1, end),
        start: frame.tokenStart + 1,
        end,
      });
    const outer = stack[stack.length - 1];
    if (outer?.kind === "code") {
      outer.canStartRegex = false;
      outer.statementExpected = false;
    }
  };

  let index = 0;
  while (index < source.length) {
    const top = stack[stack.length - 1];
    if (top.kind === "template") {
      if (source[index] === "\\") index += 2;
      else if (source[index] === "`") {
        index++;
        stack.pop();
        closeTemplate(top, index - 1);
      } else if (source[index] === "$" && source[index + 1] === "{") {
        top.holes = true;
        index += 2;
        stack.push(codeFrame(true));
      } else index++;
      continue;
    }
    const frame = top;
    const character = source[index];
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "/" && next === "/") {
      const commentStart = index;
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      comments.push({ start: commentStart, end: index });
      continue;
    }
    if (character === "/" && next === "*") {
      const commentStart = index;
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      )
        index++;
      index = Math.min(index + 2, source.length);
      comments.push({ start: commentStart, end: index });
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const tokenStart = index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) {
          index++;
          break;
        } else index++;
      }
      tokens.push({
        type: "string",
        value: source.slice(tokenStart + 1, index - 1),
        start: tokenStart + 1,
        end: index - 1,
      });
      frame.canStartRegex = false;
      frame.statementExpected = false;
      continue;
    }
    if (character === "`") {
      stack.push({ kind: "template", tokenStart: index++, holes: false });
      continue;
    }
    if (character === "/" && frame.canStartRegex) {
      index++;
      let inCharacterClass = false;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "[") {
          inCharacterClass = true;
          index++;
        } else if (source[index] === "]") {
          inCharacterClass = false;
          index++;
        } else if (source[index] === "/" && !inCharacterClass) {
          index++;
          while (/[A-Za-z]/.test(source[index] ?? "")) index++;
          break;
        } else index++;
      }
      frame.canStartRegex = false;
      frame.statementExpected = false;
      continue;
    }
    if (isIdentifierStart(character)) {
      const tokenStart = index++;
      while (index < source.length && isIdentifierPart(source[index])) index++;
      const value = source.slice(tokenStart, index);
      tokens.push({
        type: "identifier",
        value,
        start: tokenStart,
        end: index,
      });
      frame.canStartRegex = [
        "case",
        "delete",
        "return",
        "throw",
        "typeof",
        "void",
        "yield",
      ].includes(value);
      frame.statementExpected = STATEMENT_PREFIX_KEYWORDS.has(value);
      continue;
    }
    if (/[0-9]/.test(character)) {
      index++;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index]))
        index++;
      frame.canStartRegex = false;
      frame.statementExpected = false;
      continue;
    }
    if (character === "{" && frame.stopAtClosingBrace) frame.braceDepth++;
    else if (character === "}" && frame.stopAtClosingBrace) {
      if (frame.braceDepth === 0) {
        // The `}` that closes a hole: back to its template's text.
        index++;
        stack.pop();
        continue;
      }
      frame.braceDepth--;
    }
    tokens.push({
      type: "punctuation",
      value: character,
      start: index,
      end: index + 1,
    });
    const previousToken = tokens[tokens.length - 2];
    const delimiters = frame.delimiters;
    if (character === "(") {
      delimiters.push({
        character,
        allowsRegexAfterClose:
          previousToken?.type === "identifier" &&
          CONTROL_HEAD_KEYWORDS.has(previousToken.value),
      });
      frame.canStartRegex = true;
      frame.statementExpected = false;
    } else if (character === "{") {
      const isStatementBlock =
        frame.statementExpected ||
        previousToken?.value === ")" ||
        (previousToken?.value === ">" &&
          tokens[tokens.length - 3]?.value === "=");
      delimiters.push({ character, allowsRegexAfterClose: isStatementBlock });
      frame.canStartRegex = true;
      frame.statementExpected = true;
    } else if (character === "[") {
      delimiters.push({ character, allowsRegexAfterClose: false });
      frame.canStartRegex = true;
      frame.statementExpected = false;
    } else if (character === ")" || character === "}" || character === "]") {
      const expectedOpen =
        character === ")" ? "(" : character === "}" ? "{" : "[";
      const delimiter =
        delimiters.at(-1)?.character === expectedOpen
          ? delimiters.pop()
          : undefined;
      frame.canStartRegex = delimiter?.allowsRegexAfterClose ?? false;
      frame.statementExpected = frame.canStartRegex;
    } else {
      frame.canStartRegex = true;
      frame.statementExpected = character === ";";
    }
    index++;
  }
  // Templates still open at the end of the source end there.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    if (frame.kind === "template") closeTemplate(frame, index - 1);
  }
  return {
    tokens: tokens.sort((left, right) => left.start - right.start),
    comments: comments.sort((left, right) => left.start - right.start),
  };
};

const tokenizeJavaScript = (source: string): Token[] =>
  scanJavaScript(source).tokens;

export const findModuleSpecifiers = (source: string): ModuleSpecifier[] => {
  const tokens = tokenizeJavaScript(source);
  const specifiers: ModuleSpecifier[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      token.type !== "identifier" ||
      (token.value !== "import" && token.value !== "export")
    )
      continue;
    if (tokens[index - 1]?.value === ".") continue;
    const next = tokens[index + 1];
    if (token.value === "import" && next?.type === "string") {
      specifiers.push(next);
      continue;
    }
    if (
      token.value === "import" &&
      next?.value === "(" &&
      tokens[index + 2]?.type === "string"
    ) {
      specifiers.push(tokens[index + 2]);
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const candidate = tokens[cursor];
      if (
        candidate.value === ";" ||
        (candidate.type === "identifier" &&
          (candidate.value === "import" || candidate.value === "export"))
      )
        break;
      if (
        candidate.type === "identifier" &&
        candidate.value === "from" &&
        tokens[cursor + 1]?.type === "string"
      ) {
        specifiers.push(tokens[cursor + 1]);
        break;
      }
    }
  }
  return specifiers;
};
