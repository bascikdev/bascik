/**
 * @module js-minifier
 * Built-in lightweight, safe JavaScript minifier for Bascik.
 *
 * Strips comments, collapses redundant whitespace, removes safe operator spaces,
 * and handles statement boundaries (ASI) safely without modifying literal content
 * or breaking valid JS syntax.
 */

/** Segment representing either literal text (strings, regex) or minifiable code */
type Segment = {
  literal: boolean;
  text: string;
  /**
   * Offsets in `text` of each `)` that closes an `if`/`while`/`for`/`with` header. A string in the
   * header (`if (a === "x")`) splits it across segments, so the closing `)` can sit in a segment
   * that does not contain its keyword, where no text pattern can recognize it.
   */
  controlHeaderCloses?: Set<number>;
  postfixUpdateEnds?: Set<number>;
  /**
   * Offsets in `text` of each `}` that closes an arrow function body (`=> {...}`). An arrow
   * function cannot be called, indexed or tagged, so a line break after its `}` ends the
   * statement, unlike the `}` of an object literal or function expression.
   */
  arrowBodyCloses?: Set<number>;
  /**
   * Offsets in `text` of the last character before a line break that is followed by the `{`
   * of a function, method, class, static block or `catch` body (`function f(a)\n{`,
   * `class A\n{`), or by the `extends` of a class header (`class D\nextends B`). That `{` or
   * `extends` belongs to its header, so the line break is not a statement end, unlike the one
   * in `foo()\n{ block }`.
   */
  bodyHeaderEnds?: Set<number>;
  /**
   * Offsets in `text` of each `}` that ends a value: an object literal, or the body of an
   * arrow function, function expression or class expression. The statement holding that value
   * is not over at the `}`, so an `else` or `while` on the next line needs a `;` before it
   * (`if (a) x = {}\nelse y()`), unlike after the `}` of a block.
   */
  valueBraceCloses?: Set<number>;
  /**
   * Offsets in `text` of the last character of a class field name that has no value and is
   * followed, on a later line, by a member starting with `[` or `*` (`#abort\n[kResume] = null`,
   * `count\n*items() {}`). A field name cannot be indexed or multiplied, so the line break
   * ends the field.
   */
  fieldNameEnds?: Set<number>;
  /**
   * Offsets in `text` of the last character of a class member name spelled like a word in
   * `LINE_END_CONTINUING_KEYWORD` (`let`, `class`, `default`, ...). As a member name the word
   * takes nothing next, so a line break after it can end the field (`let\nfoo() {}`).
   */
  memberKeywordNameEnds?: Set<number>;
  /**
   * Offsets in `text` of the last character of a `static`, `get` or `set` that starts a class
   * member. ECMAScript allows a line break after these modifiers, so the member they modify
   * can start on the next line (`static\nfoo() {}`).
   */
  memberModifierEnds?: Set<number>;
  /**
   * Offsets in `text` of the last character of a binding name in a `var`, `let` or `const`
   * declaration that has no initializer (`var p`, the `b` of `var a = 1, b`). A binding name
   * cannot be called, indexed or operated on, so a line break after it ends the declaration
   * unless the next line starts with `=`, `,`, `;`, `in` or `of`.
   */
  bareBindingEnds?: Set<number>;
  /**
   * Literal segments only: the source has a line break before this literal that JavaScript's
   * automatic semicolon insertion turns into a statement end (`const a = 1\n"use strict"`).
   * The minified output must keep that boundary as a `;`.
   */
  asiBefore?: boolean;
};

/**
 * Test-only instrumentation: counts source characters the scanner examines.
 * Used by the complexity guard to assert linear work without asserting wall
 * time. Production code paths never read it; the increments are integer adds.
 */
export const __scanStatsForTests = {
  charsExamined: 0,
  reset(): void {
    this.charsExamined = 0;
  },
};

/**
 * Keywords expecting an expression (or, for `do`/`else`, a statement) where a following `/`
 * starts a regex literal. Shared with `js-literal-spans.ts`.
 */
export const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "case",
  "throw",
  "yield",
  "await",
  "delete",
  "typeof",
  "void",
  "default",
  "in",
  "of",
  "instanceof",
  "new",
  "do",
  "else",
]);

/**
 * Characters that end an expression, making a following slash division.
 * `)` is handled separately (it may close an `if`/`while`/`for`/`with` header,
 * after which a regex literal is valid). `}` is deliberately absent: it may end
 * a block statement (`function f(){}\n/re/.test(s)`), and treating it as regex-
 * capable is the conservative choice because a regex is only accepted when it
 * closes on the same line.
 */
const REGEX_CANNOT_PRECEDE = new Set(["]", "'", '"', "`"]);

/**
 * Keywords after which a line break does not end the statement: each takes an expression (or a
 * module specifier) next, so `typeof\n"x"` or `import\n"./a.js"` keep going. `return` and
 * `yield` are restricted productions (a line break after them ends the statement) and so are
 * absent, as are value keywords such as `this` or `null`.
 */
const EXPRESSION_CONTINUING_KEYWORDS = new Set(
  [...REGEX_PRECEDING_KEYWORDS, "else", "extends", "import", "from"].filter(
    (keyword) => keyword !== "return" && keyword !== "yield",
  ),
);

/**
 * A processed line ending in one of these reserved words continues on the next line:
 * `else`/`do`/`try`/`finally` take a body, `var`/`let`/`const`/`function`/`class` take the
 * name they declare (`var\n  first = 1,\n  second = 2`), the rest take an operand
 * (`typeof\nx`, `a in\nb`). Contextual words (`of`, `await`, `from`) are left out because they
 * are also valid identifiers that can end a statement; `let` is one too, but a statement that
 * ends in a variable named `let` is not something scripts contain. The character class keeps
 * `x.case` a property and `this.#class` a private name.
 */
const LINE_END_CONTINUING_KEYWORD =
  /(?:^|[^.\w$#])(?:else|do|try|finally|in|instanceof|typeof|void|delete|new|case|extends|default|export|import|var|let|const|function|class)\s*$/;

/**
 * A line ending in a restricted production: ECMAScript ends the statement at the line break
 * after `return`, `throw`, `yield`, `debugger` and `break`/`continue` (with or without a
 * label), so a following `(` or `[` line is a new statement.
 */
const RESTRICTED_PRODUCTION_END =
  /(?:^|[^.\w$])(?:return|throw|yield|debugger|(?:break|continue)(?:\s+[A-Za-z_$][\w$]*)?)$/;

/** The keywords of those restricted productions, for the scanner. */
const RESTRICTED_WORDS = new Set([
  "return",
  "throw",
  "yield",
  "debugger",
  "break",
  "continue",
]);

/**
 * What may start the line after a binding name with no initializer and still continue the
 * declaration: its initializer, the next binding, the end, or the `in`/`of` of a `for` header.
 */
const BARE_BINDING_CONTINUATION = /^(?:[=,;]|(?:in|of)(?![\w$]))/;

/** Keywords that start a variable declaration. */
const DECLARATION_KEYWORDS = new Set(["var", "let", "const"]);

/**
 * Keywords whose parenthesized header is followed by a statement (or, for `switch`, its
 * `{`), not an operator.
 */
const CONTROL_HEADER_KEYWORDS = new Set([
  "if",
  "while",
  "for",
  "with",
  "switch",
]);

/** What an open `{` is, for telling a method body from a block statement. */
const BRACE_BLOCK = 0;
const BRACE_CLASS = 1;
const BRACE_OBJECT = 2;

/**
 * Keywords that take an expression next on the same line, so a `{` right after one is an
 * object literal: `return {`, `yield {`. After a line break, `return` has already ended.
 */
const OBJECT_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "yield",
  "await",
  "typeof",
  "void",
  "new",
  "in",
  "of",
  "instanceof",
]);

/**
 * Characters after which only an expression can start, so a `function` or `class` right
 * after one is a function or class expression: `x = function () {}`, `f(class {})`.
 */
const EXPRESSION_START_AFTER = new Set([
  "=",
  "(",
  ",",
  "[",
  "?",
  "&",
  "|",
  "!",
]);
/** Words that, at the start of a class member, modify the member named after them. */
const CLASS_MEMBER_MODIFIERS = new Set(["get", "set", "async", "accessor"]);

/** Identifier/number characters: the "word" class the scanner tracks. */
const isWordChar = (c: string): boolean =>
  (c >= "a" && c <= "z") ||
  (c >= "A" && c <= "Z") ||
  (c >= "0" && c <= "9") ||
  c === "_" ||
  c === "$";

/** `\w` as JS regex defines it: word chars minus `$`. Needed to mirror `\b`. */
const isRegexWordChar = (c: string): boolean => c !== "$" && isWordChar(c);

const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/**
 * Mirrors the `\s` class used by the previous prefix-trimming implementation
 * (ECMAScript WhiteSpace + LineTerminator), as a char-code test so the hot
 * per-character path does not enter the regex engine.
 */
const isSpace = (c: string): boolean => {
  const code = c.charCodeAt(0);
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

/**
 * Given the maximal run of word characters immediately before a `/`, return
 * the identifier the old implementation's `\b([a-zA-Z_$][a-zA-Z0-9_$]*)$`
 * match would have produced, or `undefined` when it would not have matched.
 *
 * `\b` is defined in terms of `\w`, which excludes `$`, so the match starts at
 * the leftmost position whose character is not a digit and where exactly one
 * of (previous char, this char) is a `\w` character. The character before the
 * run is never a word character (that is what ends the run), so at position 0
 * the boundary exists exactly when the run starts with a letter or `_`.
 * Examples: `return` -> `return`; `$return` -> `return`; `9return` -> none.
 *
 * Cost is the run length, and each run precedes at most one `/`, so total work
 * across a scan stays linear in the input.
 */
const lastWordBeforeSlash = (run: string): string | undefined => {
  for (let p = 0; p < run.length; p++) {
    const cur = run[p];
    __scanStatsForTests.charsExamined++;
    if (isDigit(cur)) continue;
    const prevIsW = p === 0 ? false : isRegexWordChar(run[p - 1]);
    if (prevIsW !== isRegexWordChar(cur)) return run.slice(p);
  }
  return undefined;
};

const skipQuotedString = (js: string, start: number): number => {
  const quote = js[start];
  let i = start + 1;
  while (i < js.length) {
    __scanStatsForTests.charsExamined++;
    if (js[i] === "\\") {
      i += 2;
      continue;
    }
    if (js[i++] === quote) break;
  }
  return Math.min(i, js.length);
};

const skipRegexLiteral = (js: string, start: number): number => {
  let i = start + 1;
  let inClass = false;
  while (i < js.length) {
    __scanStatsForTests.charsExamined++;
    const c = js[i++];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
    else if (c === "\n") return i;
  }
  while (i < js.length && /[a-z]/i.test(js[i])) i++;
  return i;
};

/**
 * Whether a `/` after `token` starts a regex inside a `${}` expression: at the start, after a
 * regex keyword, or after an operator or opening punctuator. After a value, `)`, `]`, `}` or
 * `++`/`--` it is a division. `token` is "" (start), "value", a keyword from
 * `REGEX_PRECEDING_KEYWORDS`, or a punctuator. Shared with `js-literal-spans.ts`.
 */
export const canStartRegexAfter = (token: string): boolean =>
  !token ||
  REGEX_PRECEDING_KEYWORDS.has(token) ||
  !["value", ")", "]", "}", "++", "--"].includes(token);

const findTemplateExpressionEnd = (js: string, start: number): number => {
  let depth = 1;
  let i = start;
  let lastToken = "";

  while (i < js.length) {
    __scanStatsForTests.charsExamined++;
    const c = js[i];

    if (isSpace(c)) {
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      i = skipQuotedString(js, i);
      lastToken = "value";
      continue;
    }

    if (c === "`") {
      i = findTemplateLiteralEnd(js, i);
      lastToken = "value";
      continue;
    }

    if (c === "/") {
      const next = js[i + 1];
      if (next === "/") {
        i += 2;
        while (i < js.length && js[i] !== "\n") {
          __scanStatsForTests.charsExamined++;
          i++;
        }
        continue;
      }
      if (next === "*") {
        i += 2;
        while (i + 1 < js.length && !(js[i] === "*" && js[i + 1] === "/")) {
          __scanStatsForTests.charsExamined++;
          i++;
        }
        i = Math.min(i + 2, js.length);
        continue;
      }
      if (canStartRegexAfter(lastToken)) {
        i = skipRegexLiteral(js, i);
        lastToken = "value";
        continue;
      }
      lastToken = "/";
      i++;
      continue;
    }

    if (isWordChar(c)) {
      const tokenStart = i++;
      while (i < js.length && isWordChar(js[i])) {
        __scanStatsForTests.charsExamined++;
        i++;
      }
      const word = js.slice(tokenStart, i);
      lastToken = REGEX_PRECEDING_KEYWORDS.has(word) ? word : "value";
      continue;
    }

    if (c === "{") {
      depth++;
      lastToken = c;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
      lastToken = c;
      continue;
    }

    if ((c === "+" && js[i + 1] === "+") || (c === "-" && js[i + 1] === "-")) {
      lastToken = c + c;
      i += 2;
      continue;
    }
    lastToken = c;
    i++;
  }
  return js.length;
};

export function findTemplateLiteralEnd(js: string, start: number): number {
  let i = start + 1;
  while (i < js.length) {
    __scanStatsForTests.charsExamined++;
    const c = js[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && js[i + 1] === "{") {
      i = findTemplateExpressionEnd(js, i + 2);
      continue;
    }
    i++;
  }
  return js.length;
}

/**
 * Single forward pass that splits source into literal segments (strings,
 * templates, regex literals, kept verbatim) and code segments (everything
 * else, comments already stripped).
 *
 * Slash classification is context-sensitive and needs "what came before".
 * Instead of rescanning the accumulated code prefix on every `/`, three
 * pieces of state are maintained incrementally while code is appended:
 *   - `lastRaw`: the last character appended to the current code segment
 *   - `lastSig`: the last non-whitespace character appended (the old
 *     implementation's `trimmedAccum.slice(-1)`)
 *   - `wordRun`: the maximal word-character run ending at `lastSig`
 * Together they reproduce the previous decisions byte for byte in O(1)
 * amortized time per character.
 */
const scanSegments = (js: string): Segment[] => {
  const segments: Segment[] = [];
  let codeAccum = "";
  let lastRaw = "";
  let lastSig = "";
  let wordRun = "";
  // One entry per open `(`: true when it opens an if/while/for/with header.
  // Lives outside flushCode because literals never contain code parens.
  const parenIsControlHeader: boolean[] = [];
  let lastParenClosedControlHeader = false;
  // One entry per open `{`: true when it opens an arrow function body (`=> {`).
  const braceIsArrowBody: boolean[] = [];
  let lastBraceClosedArrowBody = false;
  let controlHeaderCloses: Set<number> | undefined;
  let postfixUpdateEnds: Set<number> | undefined;
  let arrowBodyCloses: Set<number> | undefined;
  let bodyHeaderEnds: Set<number> | undefined;
  // One entry per open `(`: true when it opens the parameters of a `function` or `catch`.
  const parenIsBodyHeader: boolean[] = [];
  let lastParenClosedBodyHeader = false;
  // `function` or `catch` was read and its `(` has not come yet.
  let bodyHeaderPending = false;
  // One entry per open `{`: what it is, and how many `(` and `[` were open around it, so a
  // member of a class body or object literal can be told from code nested in one of its values.
  const braceKind: number[] = [];
  const braceParenDepth: number[] = [];
  const braceBracketDepth: number[] = [];
  let bracketDepth = 0;
  // `class` was read and its body `{` has not come yet: the `(` and `[` depth it was read at,
  // so a `{` inside its heritage clause (`extends mix({})`) is not taken for the body.
  let classPendingParenDepth = -1;
  let classPendingBracketDepth = -1;
  // For the word being read: `lastSigOffset` and `lineBreakSinceSignificant` as they were
  // before it, so a `class D\nextends B` header can keep the line break before `extends`.
  let sigOffsetBeforeWord = -1;
  let lineBreakBeforeWord = false;
  // The token before the word being read ends a value, so a line break between them is a
  // statement end when the word is a name (`var a = 1\nfoo`).
  let valueBeforeWord = false;
  // The word before the one being read, when only spaces (no line break) separate them, so
  // the label of `break label` can be told from a name.
  let wordBeforeWord = "";
  // One entry per open `var`/`let`/`const` declaration: the `(`, `[` and `{` depth it was
  // read at. Its commas and binding names are the ones at exactly that depth.
  const declarationParenDepth: number[] = [];
  const declarationBracketDepth: number[] = [];
  const declarationBraceDepth: number[] = [];
  // The next word is a binding name: right after the declaration keyword or one of its commas.
  let bindingNameExpected = false;
  let wordIsBindingName = false;
  let bareBindingEnds: Set<number> | undefined;
  // Offset in `codeAccum` of `lastSig`.
  let lastSigOffset = -1;
  let lineBreakSinceSignificant = false;
  // The significant character before `lastSig`, to recognize `=>` when `{` follows it.
  let prevSig = "";
  // `lastSig` is the second character of a postfix `++`/`--`: the expression has ended, so a
  // following `/` is division (`count++ / 2`), never the start of a regex literal.
  let lastSigIsPostfixUpdate = false;
  let wordIsProperty = false;
  // The current word is the `await` of `for await (`: only whitespace after a `for` keyword.
  let wordIsForAwait = false;
  // The current word stands where only an expression can start, to tell
  // `x = function () {}` (a value) from a function declaration.
  let wordStartsExpression = false;
  // The `function` or `class` last read stands where only an expression can.
  let functionIsExpression = false;
  let classIsExpression = false;
  // One entry per open `(`: true when it opens the parameters of a function expression.
  const parenIsExpressionFunction: boolean[] = [];
  let lastParenClosedExpressionFunction = false;
  // One entry per open `{`: true when its `}` ends a value (an object literal, or the body of
  // an arrow function, function expression or class expression), not a block statement.
  const braceEndsValue: boolean[] = [];
  let valueBraceCloses: Set<number> | undefined;
  // The current word is the name a class member starts with (after `static` or `#` at most),
  // and the same for a `#` just read.
  let wordStartsClassMember = false;
  let hashStartsClassMember = false;
  let fieldNameEnds: Set<number> | undefined;
  let memberKeywordNameEnds: Set<number> | undefined;
  let memberModifierEnds: Set<number> | undefined;
  // The current word follows `{`, `;`, `}` or `static`: where `in` and `instanceof` are a
  // member name rather than an operator continuing the field value before them.
  let wordFollowsMemberBoundary = false;
  // The current word follows a `static` modifier, so it is the member's name even when it is
  // spelled `static`, `get` or `set` (`static static\nfoo() {}` is a field named `static`).
  let wordFollowsStaticModifier = false;
  let i = 0;
  const len = js.length;

  /** Directly in an object literal, where a word is a key: not inside one of its values. */
  const atObjectMemberLevel = (): boolean => {
    const top = braceKind.length - 1;
    return (
      top !== -1 &&
      braceKind[top] === BRACE_OBJECT &&
      braceParenDepth[top] === parenIsControlHeader.length &&
      braceBracketDepth[top] === bracketDepth
    );
  };

  /** Directly in the innermost open declaration: not inside one of its initializers. */
  const atDeclarationLevel = (): boolean => {
    const top = declarationParenDepth.length - 1;
    return (
      top !== -1 &&
      declarationParenDepth[top] === parenIsControlHeader.length &&
      declarationBracketDepth[top] === bracketDepth &&
      declarationBraceDepth[top] === braceKind.length
    );
  };

  /** Close the declarations a `)`, `]` or `}` just left (`for (let x of y)`). */
  const closeLeftDeclarations = (): void => {
    let top = declarationParenDepth.length - 1;
    while (
      top !== -1 &&
      (declarationParenDepth[top] > parenIsControlHeader.length ||
        declarationBracketDepth[top] > bracketDepth ||
        declarationBraceDepth[top] > braceKind.length)
    ) {
      declarationParenDepth.pop();
      declarationBracketDepth.pop();
      declarationBraceDepth.pop();
      top--;
    }
  };

  /**
   * Whether the last token ends a value (a name, `)`, `]`, `}`, a literal or a postfix
   * update), so a name after a line break here starts a new statement. A keyword that takes
   * an operand next (`typeof`, `new`) does not end one.
   */
  const valueEndsHere = (): boolean => {
    if (!lastSig) return segments.at(-1)?.literal === true;
    if (lastSigIsPostfixUpdate) return true;
    if (lastSig === ")" || lastSig === "]" || lastSig === "}") return true;
    if (!isWordChar(lastSig)) return false;
    return wordIsProperty || !EXPRESSION_CONTINUING_KEYWORDS.has(wordRun);
  };

  const closeDeclaration = (): void => {
    declarationParenDepth.pop();
    declarationBracketDepth.pop();
    declarationBraceDepth.pop();
  };

  /** Directly in a class body: not inside a member's parameters, value or computed name. */
  const atClassMemberLevel = (): boolean => {
    const top = braceKind.length - 1;
    return (
      top !== -1 &&
      braceKind[top] === BRACE_CLASS &&
      braceParenDepth[top] === parenIsControlHeader.length &&
      braceBracketDepth[top] === bracketDepth
    );
  };

  /**
   * Whether a name (or its `#`) starting here is the first token of a class member: after
   * `{`, `;`, `}` or `static`, or on a new line after a field value that has ended
   * (`#paused = false\n#abort`). A value has not ended after an operator, or after a word that
   * takes something next (`typeof`, `get`).
   */
  const startsClassMember = (): boolean => {
    if (!atClassMemberLevel()) return false;
    if (lastSig === "{" || lastSig === ";" || lastSig === "}") return true;
    if (isWordChar(lastSig)) {
      if (wordIsProperty) return lineBreakSinceSignificant;
      // After a field named like a keyword (`typeof\nvoid`), a new line is a new member.
      if (memberKeywordNameEnds?.has(lastSigOffset) === true) {
        return lineBreakSinceSignificant;
      }
      if (wordRun === "static") return wordStartsClassMember;
      return (
        lineBreakSinceSignificant &&
        !EXPRESSION_CONTINUING_KEYWORDS.has(wordRun) &&
        !CLASS_MEMBER_MODIFIERS.has(wordRun)
      );
    }
    if (!lineBreakSinceSignificant) return false;
    // After `)`, `]`, or a string, template or regex literal.
    return (
      lastSig === ")" ||
      lastSig === "]" ||
      (!lastSig && segments.at(-1)?.literal === true)
    );
  };

  const flushCode = (): void => {
    if (codeAccum) {
      segments.push({
        literal: false,
        text: codeAccum,
        controlHeaderCloses,
        postfixUpdateEnds,
        arrowBodyCloses,
        bodyHeaderEnds,
        valueBraceCloses,
        fieldNameEnds,
        memberKeywordNameEnds,
        memberModifierEnds,
        bareBindingEnds,
      });
      codeAccum = "";
    }
    bareBindingEnds = undefined;
    controlHeaderCloses = undefined;
    postfixUpdateEnds = undefined;
    arrowBodyCloses = undefined;
    bodyHeaderEnds = undefined;
    valueBraceCloses = undefined;
    fieldNameEnds = undefined;
    memberKeywordNameEnds = undefined;
    memberModifierEnds = undefined;
    lastSigOffset = -1;
    lastRaw = "";
    lastSig = "";
    prevSig = "";
    lastSigIsPostfixUpdate = false;
    wordRun = "";
  };

  /**
   * Whether the line break(s) between the previous token and a literal starting here end the
   * statement under automatic semicolon insertion. Called before `flushCode`, while the
   * previous token's state is still live. A string can never continue a value, a template
   * after a value is a tagged template, and a regex after a value is division (the scanner
   * already reads it that way), so only the token kinds that cannot take one count.
   */
  const asiBeforeLiteral = (kind: "string" | "template" | "regex"): boolean => {
    if (!lineBreakSinceSignificant) return false;
    if (!lastSig) {
      // Only whitespace since the previous segment: a literal (`"a"\n"b"`) or nothing.
      return kind === "string" && segments.at(-1)?.literal === true;
    }
    // Neither an arrow function nor a postfix update can be called, indexed or tagged.
    if (lastSigIsPostfixUpdate) return true;
    if (lastSig === "}") return lastBraceClosedArrowBody || kind === "string";
    // `var a = 1, b\n\`x\``: a binding name cannot be tagged.
    if (bareBindingEnds?.has(lastSigOffset) === true) return true;
    // `return\n\`x\`` returns undefined: the line break after a restricted production ends it.
    if (
      isWordChar(lastSig) &&
      !wordIsProperty &&
      (RESTRICTED_WORDS.has(wordRun) ||
        wordBeforeWord === "break" ||
        wordBeforeWord === "continue")
    ) {
      return true;
    }
    if (kind === "template") return false;
    if (lastSig === "]") return true;
    if (lastSig === ")") return !lastParenClosedControlHeader;
    if (isWordChar(lastSig)) {
      if (wordIsProperty) return true;
      const word = lastWordBeforeSlash(wordRun);
      return word === undefined || !EXPRESSION_CONTINUING_KEYWORDS.has(word);
    }
    return false;
  };

  /**
   * Classify the `{` about to be appended, and when it is the body of the header that ends
   * on an earlier line, record that header's last character so the line break stays a join.
   */
  const openBrace = (): boolean => {
    const parenDepth = parenIsControlHeader.length;
    const top = braceKind.length - 1;
    const enclosing = top === -1 ? BRACE_BLOCK : braceKind[top];
    // Directly in the enclosing `{`, not inside a `(` or `[` it contains.
    const atMemberLevel =
      top !== -1 &&
      braceParenDepth[top] === parenDepth &&
      braceBracketDepth[top] === bracketDepth;
    const word = isWordChar(lastSig) && !wordIsProperty ? wordRun : undefined;

    let kind = BRACE_BLOCK;
    let isBody = false;
    let endsValue = false;
    if (
      classPendingParenDepth === parenDepth &&
      classPendingBracketDepth === bracketDepth
    ) {
      kind = BRACE_CLASS;
      isBody = true;
      endsValue = classIsExpression;
      classPendingParenDepth = -1;
      classPendingBracketDepth = -1;
    } else if (lastSig === ")" && lastParenClosedBodyHeader) {
      // `function f(a)\n{`, `catch (e)\n{`
      isBody = true;
      endsValue = lastParenClosedExpressionFunction;
    } else if (word === "catch") {
      isBody = true;
    } else if (
      atMemberLevel &&
      enclosing !== BRACE_BLOCK &&
      (lastSig === ")" || (enclosing === BRACE_CLASS && word === "static"))
    ) {
      // A method, accessor or static block: a class body or object literal holds only
      // members, so nothing else can put a `{` on a line of its own here.
      isBody = true;
    } else if (
      lastSig === "(" ||
      lastSig === "," ||
      lastSig === "[" ||
      lastSig === "?" ||
      lastSig === "&" ||
      lastSig === "|" ||
      (lastSig === "=" && prevSig !== ">") ||
      (lastSig === ":" &&
        (enclosing === BRACE_OBJECT || !atMemberLevel) &&
        top !== -1) ||
      (word !== undefined &&
        !lineBreakSinceSignificant &&
        OBJECT_PRECEDING_KEYWORDS.has(word))
    ) {
      // Where only an expression can start, `{` is an object literal (or a destructuring
      // pattern, which holds no statements either).
      kind = BRACE_OBJECT;
      endsValue = true;
    }
    if (isBody && lineBreakSinceSignificant && lastSigOffset !== -1) {
      (bodyHeaderEnds ??= new Set()).add(lastSigOffset);
    }
    bodyHeaderPending = false;
    braceKind.push(kind);
    braceParenDepth.push(parenDepth);
    braceBracketDepth.push(bracketDepth);
    return endsValue;
  };

  const appendCode = (c: string): void => {
    // Most characters are part of a word: none of the bookkeeping below applies to them.
    if (isWordChar(c)) {
      codeAccum += c;
      if (isWordChar(lastRaw)) {
        wordRun += c;
      } else {
        wordIsForAwait = wordRun === "for" && !wordIsProperty;
        // `= function`, `return function`, and `= async function` through its `async`.
        wordStartsExpression =
          EXPRESSION_START_AFTER.has(lastSig) ||
          (wordRun !== "" &&
            !wordIsProperty &&
            (OBJECT_PRECEDING_KEYWORDS.has(wordRun) ||
              (wordRun === "async" && wordStartsExpression)));
        wordStartsClassMember =
          lastSig === "#" ? hashStartsClassMember : startsClassMember();
        wordFollowsStaticModifier =
          wordRun === "static" &&
          !wordIsProperty &&
          memberModifierEnds?.has(lastSigOffset) === true;
        wordFollowsMemberBoundary =
          lastSig === "{" ||
          lastSig === ";" ||
          lastSig === "}" ||
          (wordRun === "static" && !wordIsProperty) ||
          (lineBreakSinceSignificant &&
            memberKeywordNameEnds?.has(lastSigOffset) === true);
        valueBeforeWord = valueEndsHere() && !DECLARATION_KEYWORDS.has(wordRun);
        wordBeforeWord =
          isWordChar(lastSig) && !wordIsProperty && !lineBreakSinceSignificant
            ? wordRun
            : "";
        wordIsProperty = lastSig === ".";
        sigOffsetBeforeWord = lastSigOffset;
        lineBreakBeforeWord = lineBreakSinceSignificant;
        wordIsBindingName = bindingNameExpected;
        bindingNameExpected = false;
        wordRun = c;
      }
      lastRaw = c;
      prevSig = lastSig;
      lastSig = c;
      lastSigOffset = codeAccum.length - 1;
      lastSigIsPostfixUpdate = false;
      lineBreakSinceSignificant = false;
      return;
    }
    // A class member name (not a `class Foo\nextends` header still waiting for its body).
    const memberWordEnded =
      !wordIsProperty &&
      isWordChar(lastRaw) &&
      wordStartsClassMember &&
      classPendingParenDepth === -1;
    if (memberWordEnded) {
      if (
        (wordRun === "static" && !wordFollowsStaticModifier) ||
        wordRun === "get" ||
        wordRun === "set"
      ) {
        (memberModifierEnds ??= new Set()).add(lastSigOffset);
      } else if (
        LINE_END_CONTINUING_KEYWORD.test(wordRun) &&
        ((wordRun !== "in" && wordRun !== "instanceof") ||
          wordFollowsMemberBoundary)
      ) {
        (memberKeywordNameEnds ??= new Set()).add(lastSigOffset);
      }
    }
    if (!wordIsProperty && !memberWordEnded && isWordChar(lastRaw)) {
      // A word just ended. `x.class` and `p.catch(f)` are properties, not keywords, and a
      // class member named `class` or `function` declares nothing.
      if (
        lineBreakBeforeWord &&
        valueBeforeWord &&
        wordRun !== "in" &&
        wordRun !== "of" &&
        wordRun !== "instanceof" &&
        atDeclarationLevel()
      ) {
        // `var a = 1\nfoo`: a name after a value on a new line starts a new statement.
        closeDeclaration();
      }
      if (wordIsBindingName && atDeclarationLevel()) {
        (bareBindingEnds ??= new Set()).add(lastSigOffset);
      }
      if (DECLARATION_KEYWORDS.has(wordRun) && !atObjectMemberLevel()) {
        // `{ const: v, deprecated }` names a key, not a declaration.
        declarationParenDepth.push(parenIsControlHeader.length);
        declarationBracketDepth.push(bracketDepth);
        declarationBraceDepth.push(braceKind.length);
        bindingNameExpected = true;
      }
      if (wordRun === "function" || wordRun === "catch") {
        bodyHeaderPending = true;
        functionIsExpression = wordRun === "function" && wordStartsExpression;
      } else if (wordRun === "class") {
        classPendingParenDepth = parenIsControlHeader.length;
        classPendingBracketDepth = bracketDepth;
        classIsExpression = wordStartsExpression;
      } else if (
        wordRun === "extends" &&
        lineBreakBeforeWord &&
        sigOffsetBeforeWord !== -1 &&
        classPendingParenDepth === parenIsControlHeader.length &&
        classPendingBracketDepth === bracketDepth
      ) {
        // `class D\nextends B {}`: the heritage clause continues the class header.
        (bodyHeaderEnds ??= new Set()).add(sigOffsetBeforeWord);
      }
    }
    switch (c) {
      case "(": {
        // `Symbol.for(key)` and `$if(a)` are calls, not headers.
        parenIsControlHeader.push(
          isWordChar(lastSig) &&
            !wordIsProperty &&
            (CONTROL_HEADER_KEYWORDS.has(wordRun) ||
              (wordIsForAwait && wordRun === "await")),
        );
        parenIsBodyHeader.push(bodyHeaderPending);
        parenIsExpressionFunction.push(
          bodyHeaderPending && functionIsExpression,
        );
        bodyHeaderPending = false;
        break;
      }
      case ")":
        lastParenClosedControlHeader = parenIsControlHeader.pop() ?? false;
        lastParenClosedBodyHeader = parenIsBodyHeader.pop() ?? false;
        lastParenClosedExpressionFunction =
          parenIsExpressionFunction.pop() ?? false;
        if (lastParenClosedControlHeader) {
          (controlHeaderCloses ??= new Set()).add(codeAccum.length);
        }
        break;
      case "{": {
        const isArrowBody = lastSig === ">" && prevSig === "=";
        braceIsArrowBody.push(isArrowBody);
        braceEndsValue.push(openBrace() || isArrowBody);
        break;
      }
      case "}":
        lastBraceClosedArrowBody = braceIsArrowBody.pop() ?? false;
        braceKind.pop();
        braceParenDepth.pop();
        braceBracketDepth.pop();
        if (lastBraceClosedArrowBody) {
          (arrowBodyCloses ??= new Set()).add(codeAccum.length);
        }
        if (braceEndsValue.pop()) {
          (valueBraceCloses ??= new Set()).add(codeAccum.length);
        }
        break;
      case "#":
        hashStartsClassMember = startsClassMember();
        break;
      case "[":
      case "*":
        // `name\n[key] = 1` and `name\n*items() {}` in a class body: `name` is a field of its
        // own. `static`, `get` and `set` are modifiers of the member that follows.
        if (
          lineBreakSinceSignificant &&
          isWordChar(lastSig) &&
          wordStartsClassMember &&
          lastSigOffset !== -1 &&
          wordRun !== "static" &&
          (c === "*" || (wordRun !== "get" && wordRun !== "set"))
        ) {
          (fieldNameEnds ??= new Set()).add(lastSigOffset);
        }
        if (c === "[") bracketDepth++;
        break;
      case "]":
        if (bracketDepth > 0) bracketDepth--;
        break;
      case ";":
        bodyHeaderPending = false;
        if (atDeclarationLevel()) closeDeclaration();
        break;
    }
    if (c === ")" || c === "]" || c === "}") closeLeftDeclarations();
    codeAccum += c;
    if (isSpace(c)) {
      if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029")
        lineBreakSinceSignificant = true;
      lastRaw = c;
      return;
    }
    bindingNameExpected = c === "," && atDeclarationLevel();
    wordRun = "";
    lastRaw = c;
    prevSig = lastSig;
    lastSig = c;
    lastSigOffset = codeAccum.length - 1;
    lastSigIsPostfixUpdate = false;
    lineBreakSinceSignificant = false;
  };

  const pushLiteral = (
    text: string,
    kind: "string" | "template" | "regex",
  ): void => {
    const asiBefore = asiBeforeLiteral(kind);
    // `var a = 1\n"x"`: the literal starts a new statement, which declares nothing.
    if (asiBefore && atDeclarationLevel()) closeDeclaration();
    bindingNameExpected = false;
    flushCode();
    segments.push(
      asiBefore ? { literal: true, text, asiBefore } : { literal: true, text },
    );
    lineBreakSinceSignificant = false;
  };

  while (i < len) {
    const ch = js[i];
    __scanStatsForTests.charsExamined++;

    if ((ch === "+" || ch === "-") && js[i + 1] === ch) {
      const previousLiteral = !lastSig && segments.at(-1)?.literal;
      const postfix =
        !lineBreakSinceSignificant &&
        (previousLiteral ||
          lastSig === "]" ||
          (lastSig === ")" && !lastParenClosedControlHeader) ||
          (isWordChar(lastSig) &&
            (wordIsProperty ||
              ((!REGEX_PRECEDING_KEYWORDS.has(wordRun) || wordRun === "of") &&
                wordRun !== "else"))));
      appendCode(ch);
      appendCode(ch);
      if (postfix) {
        (postfixUpdateEnds ??= new Set()).add(codeAccum.length - 1);
        lastSigIsPostfixUpdate = true;
      }
      i += 2;
      continue;
    }

    // Quoted string literals ("...", '...') — preserve verbatim
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let lit = ch;
      i++;
      while (i < len) {
        const c = js[i];
        __scanStatsForTests.charsExamined++;
        if (c === "\\" && i + 1 < len) {
          lit += c + js[i + 1];
          i += 2;
          continue;
        }
        lit += c;
        i++;
        if (c === quote) break;
      }
      pushLiteral(lit, "string");
      continue;
    }

    // Template literals (`...`) — preserve verbatim
    if (ch === "`") {
      const end = findTemplateLiteralEnd(js, i);
      pushLiteral(js.slice(i, end), "template");
      i = end;
      continue;
    }

    // Potential comment, division, or regex literal — all start with "/".
    if (ch === "/") {
      const next = js[i + 1];

      // Disambiguate regex literal vs division operator:
      // A regex literal can only appear where an expression is expected.
      let couldBeRegex = false;
      if (next !== "/" && next !== "*") {
        if (!lastSig) {
          // No significant code yet in this segment, check previous segment if any
          const lastSeg = segments[segments.length - 1];
          if (!lastSeg || !lastSeg.literal) {
            couldBeRegex = true;
          }
        } else if (isWordChar(lastSig)) {
          // Preceded by a word token — regex only if word is an expression keyword (e.g. return /a/)
          const lastWord = lastWordBeforeSlash(wordRun);
          if (
            lastWord !== undefined &&
            REGEX_PRECEDING_KEYWORDS.has(lastWord)
          ) {
            couldBeRegex = true;
          }
        } else if (lastSig === ")") {
          // `if (x) /re/.test(y)` is a regex statement; `f(x) / 2` is division.
          couldBeRegex = lastParenClosedControlHeader;
        } else if (lastSigIsPostfixUpdate) {
          // `count++ / 2` is division: a postfix update ends the expression.
          couldBeRegex = false;
        } else if (!REGEX_CANNOT_PRECEDE.has(lastSig)) {
          // Preceded by operators/punctuation like '=', '(', '[', ':', ',', '!', '?', '&', '|', '+', '-', '*', ';'
          couldBeRegex = true;
        }
      }

      if (couldBeRegex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < len) {
          const c = js[j];
          __scanStatsForTests.charsExamined++;
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) {
            closed = true;
            j++;
            break;
          } else if (c === "\n") break; // Unterminated — not a regex
          j++;
        }
        if (closed) {
          // Consume regex flags (e.g., /abc/gi)
          while (j < len && /[a-z]/i.test(js[j])) j++;
          pushLiteral(js.slice(i, j), "regex");
          i = j;
          continue;
        }
      }

      if (next === "*") {
        // Block comment: skip to */
        i += 2;
        while (i + 1 < len && !(js[i] === "*" && js[i + 1] === "/")) {
          __scanStatsForTests.charsExamined++;
          i++;
        }
        i += 2;
        // If stripping a block comment between two word characters (e.g., return/*x*/v),
        // preserve a space so token boundaries aren't lost. The same goes for two `+` or
        // two `-`, which would join into `++` or `--` (`a +/* sign */+ b`).
        const nextChar = js[i];
        if (
          lastRaw &&
          nextChar &&
          ((isWordChar(lastRaw) && isWordChar(nextChar)) ||
            ((lastRaw === "+" || lastRaw === "-") && nextChar === lastRaw))
        ) {
          appendCode(" ");
        }
        continue;
      }

      if (next === "/") {
        // Line comment: skip to end of line (preserve newline for statement separation)
        i += 2;
        while (i < len && js[i] !== "\n") {
          __scanStatsForTests.charsExamined++;
          i++;
        }
        continue;
      }
    }

    appendCode(ch);
    i++;
  }
  flushCode();
  return segments;
};

const normalizeCodeSegment = (text: string): string => {
  let code = text.replace(/\s+/g, " ");
  code = code.replace(/\s*([{}();,:=?*!^~%])\s*/g, "$1");
  code = code.replace(
    /\s*(<|>|<=|>=|==|===|!=|!==|<<|>>|>>>|\&\&|\|\||\?\?|\+=|-=|\*=|\/=|%=)\s*/g,
    "$1",
  );
  code = code.replace(/([^\s+-])\s*\+/g, "$1+");
  code = code.replace(/\+\s*([^\s+-])/g, "+$1");
  code = code.replace(/([^\s+-])\s*-/g, "$1-");
  code = code.replace(/-\s*([^\s+-])/g, "-$1");
  code = code.replace(/([^\d\s])\s*\.\s*/g, "$1.");
  return code.replace(/([^\d])\s*\.\s*([^\d\s])/g, "$1.$2");
};

/**
 * Strip block/line comments and collapse whitespace from a JS string.
 * String literals, template literals, and regex literals are preserved verbatim
 * so their content is never altered.
 */
export const minifyJs = (js: string): string => {
  if (!js) return "";
  if (js.startsWith("#!")) {
    // A hashbang comment runs to the end of its line, so the line break after it must stay.
    const lineEnd = js.search(/[\n\r\u2028\u2029]/);
    if (lineEnd === -1) return js;
    const bodyStart = lineEnd + (js.startsWith("\r\n", lineEnd) ? 2 : 1);
    return js.slice(0, bodyStart) + minifyJs(js.slice(bodyStart));
  }

  const segments = scanSegments(js);

  // Process code segments and assemble minified JS.
  // `resultLast` mirrors result.slice(-1) without flattening the growing
  // string on every segment (V8 rope flattening made that quadratic in the
  // number of segments).
  let result = "";
  let resultLast = "";
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    if (seg.literal) {
      if (seg.asiBefore && result && resultLast !== ";") {
        // The source's line break ended the statement (`const a = 1\n"use strict"`).
        result += ";";
      } else if (result && isWordChar(resultLast) && isWordChar(seg.text[0])) {
        // Ensure space between preceding keyword/identifier and literal if needed
        result += " ";
      } else if (resultLast === "/" && seg.text[0] === "/") {
        // A division sign and then a regex literal (`a / /b/.source.length`): without the
        // space the two slashes start a line comment that swallows the rest of the script.
        result += " ";
      }
      result += seg.text;
      resultLast = seg.text[seg.text.length - 1];
      continue;
    }

    if (sIdx > 0 && segments[sIdx - 1].literal && /^\s*\n/.test(seg.text)) {
      const firstLine = seg.text.match(/\S.*/)?.[0] ?? "";
      if (
        resultLast &&
        firstLine &&
        !/^(?:(?:instanceof|in|of)(?![a-zA-Z0-9_$])|,|;|:|\(|\)|\}|\[|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
          firstLine,
        )
      ) {
        result += ";";
        resultLast = ";";
      }
    }

    let text = seg.text;

    // 1. Process line breaks: convert newlines to semicolons or spaces for ASI safety
    //
    // The join decision looks at the text accumulated so far ("prevLine").
    // Every test is `$`-anchored, and prevLine never has trailing whitespace
    // (each appended line is trimmed and non-empty), so the decision depends
    // only on a suffix. Three incrementally maintained views replace the
    // former whole-prefix trimEnd + regex scans:
    //   - `ptLast`: last character of processedText
    //   - `ptTail`: last TAIL_WINDOW characters (enough for every bounded
    //     pattern; the longest is `instanceof$` which needs 10 + 1 for the
    //     character before it)
    // Whether a final `)` closes an `if`/`while`/`for`/`switch` header is not a
    // suffix question (`Symbol.for(key)` ends the same way): the scanner
    // records those in `controlHeaderCloses`.
    const TAIL_WINDOW = 12;
    const lines = text.split("\n");
    let processedText = "";
    let ptLast = "";
    let ptTail = "";
    // Offset in `text` of the last character of the most recently appended line.
    let lineOffset = 0;
    let prevLineEnd = -1;
    // The most recently appended (trimmed) line, for the restricted-production check.
    let prevLine = "";

    const appendProcessed = (s: string): void => {
      processedText += s;
      ptLast = s[s.length - 1];
      ptTail =
        s.length >= TAIL_WINDOW
          ? s.slice(-TAIL_WINDOW)
          : (ptTail + s).slice(-TAIL_WINDOW);
    };

    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const rawLine = lines[lIdx];
      const rawLineOffset = lineOffset;
      lineOffset += rawLine.length + 1;
      const line = rawLine.trim();
      if (!line) continue;
      const lineEnd = rawLineOffset + rawLine.trimEnd().length - 1;

      if (!processedText) {
        appendProcessed(line);
        prevLineEnd = lineEnd;
        prevLine = line;
        continue;
      }

      const lastChar = ptLast;
      const firstChar = line[0];
      __scanStatsForTests.charsExamined += ptTail.length;

      // Check if semicolon is required between prevLine and current line
      let needsSemicolon = false;

      // Statements ending in value tokens or return/break/continue/throw require ; before next statement
      if (/[a-zA-Z0-9_\)$\]'"`]/.test(lastChar)) {
        // Do NOT insert semicolon if line ends with an open control flow / operator
        let endsWithOpenControl = false;
        if (seg.bodyHeaderEnds?.has(prevLineEnd)) {
          // `function f(a)` or `class A` then its body `{` on the next line.
          endsWithOpenControl = true;
        } else if (
          lastChar === ")" &&
          seg.controlHeaderCloses?.has(prevLineEnd)
        ) {
          // `if (a === "x")` then a body on the next line: the scanner saw this `)` close the header.
          endsWithOpenControl = true;
        }
        // A class member named `let` or `default` takes nothing next; `static`, `get` and
        // `set` take the member they modify.
        endsWithOpenControl =
          endsWithOpenControl ||
          seg.memberModifierEnds?.has(prevLineEnd) === true ||
          (seg.memberKeywordNameEnds?.has(prevLineEnd) !== true &&
            LINE_END_CONTINUING_KEYWORD.test(ptTail)) ||
          /(=|,|\+|\-|\*|\/|%|\?|:|=>|\.|\&\&|\|\||\?\?)\s*$/.test(ptTail);

        // Do NOT insert semicolon if next line starts with closing/continuation structures.
        // Only binary keyword operators (instanceof/in/of) continue an expression
        // across a newline; after a value token `else`, `while`, `catch` and
        // `finally` start a new statement, so they must get a semicolon
        // (`do step()\nwhile(c)`, `if(a) step()\nelse other()`).
        //
        // A line starting with `(` or `[` continues a value as a call or an index
        // (`getEl("x")\n(fn)()` is `getEl("x")(fn)()`), unless the previous line
        // ends in a restricted production (`return`, `break label`, ...) where the
        // line break itself ends the statement. A declaration's binding name with no
        // initializer (`var a = 1, b`) takes only `=`, `,`, `;`, `in` or `of` next, so
        // any other line starts a new statement (`var p\n[a].map(f)`, `let p\n+z`).
        const startsWithContinuation =
          seg.bareBindingEnds?.has(prevLineEnd) === true
            ? BARE_BINDING_CONTINUATION.test(line)
            : /^(instanceof(?![a-zA-Z0-9_$])|in(?![a-zA-Z0-9_$])|of(?![a-zA-Z0-9_$])|,|;|:|\)|\}|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
                line,
              ) ||
              ((firstChar === "(" || firstChar === "[") &&
                !RESTRICTED_PRODUCTION_END.test(prevLine));

        if (
          !endsWithOpenControl &&
          !startsWithContinuation &&
          !/[;{}:,]\s*$/.test(ptTail)
        ) {
          needsSemicolon = true;
        } else if (
          RESTRICTED_PRODUCTION_END.test(prevLine) &&
          !/^[;}]/.test(line)
        ) {
          // `return\n-z` returns undefined: the line break after a restricted production
          // ends the statement whatever the next line starts with, so a sign, an operator
          // or a regex there starts a new statement (`return;-z`).
          needsSemicolon = true;
        }
      } else if (lastChar === "}") {
        // After }, insert semicolon unless followed by control continuation (else, catch, finally, while, etc.)
        // A `(` or `[` line continues the `}` of an object literal or function expression
        // (and starts a new statement after a block or declaration either way), but not the
        // `}` of an arrow function body, which cannot be called or indexed.
        if (
          !/^((?:else|catch|finally|while|instanceof|in|of)(?![a-zA-Z0-9_$])|,|;|:|\)|\}|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
            line,
          ) &&
          ((firstChar !== "(" && firstChar !== "[") ||
            seg.arrowBodyCloses?.has(prevLineEnd) === true)
        ) {
          needsSemicolon = true;
        } else if (
          seg.valueBraceCloses?.has(prevLineEnd) === true &&
          /^(?:else|while)(?![a-zA-Z0-9_$])/.test(line)
        ) {
          // `if (a) x = {}\nelse y()`: the `}` ends a value, not the `if` body, so the
          // statement still needs its `;` before `else` (or before a `while` loop).
          needsSemicolon = true;
        }
      } else if (seg.postfixUpdateEnds?.has(prevLineEnd)) {
        const startsWithContinuation =
          /^(instanceof(?![a-zA-Z0-9_$])|in(?![a-zA-Z0-9_$])|,|;|:|\)|\}|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
            line,
          );
        if (!startsWithContinuation) {
          needsSemicolon = true;
        }
      }
      if (seg.fieldNameEnds?.has(prevLineEnd)) {
        // A class field name, then a member starting with `[` or `*` on this line.
        needsSemicolon = true;
      }

      prevLineEnd = lineEnd;
      prevLine = line;
      if (needsSemicolon) {
        appendProcessed(";" + line);
      } else if (
        (isWordChar(lastChar) && isWordChar(firstChar)) ||
        ((lastChar === "+" || lastChar === "-") && firstChar === lastChar)
      ) {
        // Ensure space between word tokens when joining without semicolon, and between a
        // binary `+` or `-` and a sign or update on the next line: `a +\n+b` is `a+ +b`,
        // and `a +\n++b` is `a+ ++b`, where `a+++b` would read as `a++ + b`.
        appendProcessed(" " + line);
      } else {
        appendProcessed(line);
      }
    }

    const code = codeSegmentMemo.minify(processedText);

    // Ensure boundary spacing with previous segment if both end/start with word chars.
    // `code` can be empty (a whitespace-only segment between two literals); the
    // original `/[a-zA-Z0-9_$]/.test(code[0])` coerced undefined to "undefined"
    // and matched, so an empty segment after a word char still emits a space.
    // Preserved for byte identity.
    const codeFirst = code[0];
    if (
      result &&
      isWordChar(resultLast) &&
      (codeFirst === undefined || isWordChar(codeFirst))
    ) {
      result += " ";
      resultLast = " ";
    }

    result += code;
    if (code) resultLast = code[code.length - 1];
  }

  return result.trim();
};

/**
 * Bounded least-recently-used memo for a pure string minifier. Pages repeat
 * the same component scripts, so identical inputs are minified once. Sizes
 * count UTF-16 bytes of input plus output. A throw is never cached.
 */
export const createMinifyJsMemo = (
  minify: (code: string) => string,
  limits: { maxEntries: number; maxBytes: number },
): {
  minify: (code: string) => string;
  stats: () => { entries: number; bytes: number };
} => {
  const entries = new Map<string, string>();
  let bytes = 0;
  const sizeOf = (code: string, result: string): number =>
    2 * (code.length + result.length);
  return {
    minify: (code: string): string => {
      const cached = entries.get(code);
      if (cached !== undefined) {
        entries.delete(code);
        entries.set(code, cached);
        return cached;
      }
      const result = minify(code);
      const size = sizeOf(code, result);
      if (size > limits.maxBytes) return result;
      entries.set(code, result);
      bytes += size;
      while (entries.size > limits.maxEntries || bytes > limits.maxBytes) {
        const [oldestCode, oldestResult] = entries.entries().next().value as [
          string,
          string,
        ];
        entries.delete(oldestCode);
        bytes -= sizeOf(oldestCode, oldestResult);
      }
      return result;
    },
    stats: () => ({ entries: entries.size, bytes }),
  };
};

const CODE_SEGMENT_MEMO_LIMITS = {
  maxEntries: 2048,
  maxBytes: 4 * 1024 * 1024,
};
let normalizationRuns = 0;
const createCodeSegmentMemo = (limits: typeof CODE_SEGMENT_MEMO_LIMITS) =>
  createMinifyJsMemo((text) => {
    normalizationRuns++;
    return normalizeCodeSegment(text);
  }, limits);

// Only post-ASI normalization is a pure function of the segment text.
let codeSegmentMemo = createCodeSegmentMemo(CODE_SEGMENT_MEMO_LIMITS);

export const __segmentMemoForTests = {
  normalizeUnmemoized: normalizeCodeSegment,
  normalize: (text: string): string => codeSegmentMemo.minify(text),
  stats: () => ({ normalizationRuns, ...codeSegmentMemo.stats() }),
  reset(limits = CODE_SEGMENT_MEMO_LIMITS): void {
    normalizationRuns = 0;
    codeSegmentMemo = createCodeSegmentMemo(limits);
  },
};

const builtInMinifyJsMemo = createMinifyJsMemo(minifyJs, {
  maxEntries: 512,
  maxBytes: 16 * 1024 * 1024,
});

/** `minifyJs` with a bounded memo of recent inputs. Same output for every input. */
export const memoizedMinifyJs = builtInMinifyJsMemo.minify;
