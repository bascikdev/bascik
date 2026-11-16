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
   * Offsets in `text` of each `.` that ends a number literal (`5.`). The number is a value, so
   * a line break after it ends the statement unless the next line continues it (`x = 5.\ny`
   * is `x=5.;y`), where a line-end `.` otherwise expects a property name next.
   */
  numberDotEnds?: Set<number>;
  /**
   * Offsets in `text` of the last digit of a decimal integer (`1`, `1_000`, `08`) that a
   * line break separates from a `.`. Joined, the `.` would become part of the number
   * (`1\n.y` is `1 .y`, never `1.y`), so a space stays between them.
   */
  integerBeforeDotLines?: Set<number>;
  /**
   * Offsets in `text` of the last character before a line break that a `from` or `as` keyword
   * follows in an `import` or `export` clause (`import { a }\nfrom "m"`, `{ a\nas b }`), or
   * that the `of` of a `for` header follows (`for (const x\nof y)`). The statement continues
   * on that line, so the line break is a join.
   */
  moduleFromBreaks?: Set<number>;
  /**
   * Offsets in `text` of the last character of a contextual keyword that takes something
   * next: the `of` of a `for` header (`for (const x of\ny)`) and the `as` of an `import` or
   * `export` clause (`import * as\nn from "m"`). A line break after one is a join.
   */
  contextualKeywordEnds?: Set<number>;
  /**
   * Offsets in `text` of the last character of a property name spelled like a keyword that
   * whitespace or a line break separates from its `.` (`o. return`, `o.\nnew`). The line-end
   * keyword rules read the text, where `.` right before the word marks a property; here it
   * does not, so the scanner says the word is a name.
   */
  propertyKeywordEnds?: Set<number>;
  /**
   * Offsets in `text` of the last character of a `let` at the start of a statement (or of a
   * `for` header), where it declares when a name, `[` or `{` follows. Anywhere else, and before
   * anything else, a `let` is a variable name in a classic script (`x = let\nfoo()`).
   */
  letKeywordEnds?: Set<number>;
  /**
   * Code segments only: the segment starts with a line break and then an `as` that continues
   * the clause after a string name in the literal before it (`export { "a b"\nas c }`).
   */
  continuesClause?: boolean;
  /**
   * Literal segments only: the source has a line break before this literal that JavaScript's
   * automatic semicolon insertion turns into a statement end (`const a = 1\n"use strict"`).
   * The minified output must keep that boundary as a `;`.
   */
  asiBefore?: boolean;
  /**
   * Literal segments only: the line break before this string stays in the output, because
   * whether it ends the statement depends on context the scanner does not track
   * (`await\n"a"` is one statement in an async function and two where `await` is a name;
   * `yield\n\`x\`` is two statements in a generator and a tagged template elsewhere).
   */
  lineBreakBefore?: boolean;
  /**
   * Literal segments only: a string that names a class member (`'a b' = 1`, `static 'a'`). A
   * field with that name and no value ends at a line break before a `[` or `*` member.
   */
  classMemberName?: boolean;
  /**
   * Literal segments only: the module specifier of an `import` or `export`, which its
   * `with { type: "json" }` attributes may follow on the next line.
   */
  moduleSpecifier?: boolean;
  /**
   * Literal segments only: a comment kept as written. `"line"` runs to the end of its line and
   * is followed by a line break: an HTML-like `<!--` comment (a classic script reads it as a
   * line comment, a module as the operators `<`, `!` and `--`, and the kept text and line
   * break run the same program as either), or a `//` comment that holds an HTML script
   * marker. `"close"` is a line-start `-->` comment holding one, put back at a line start.
   * `"block"` is a block comment holding one. See `HTML_SCRIPT_MARKER`.
   */
  keptComment?: "line" | "close" | "block";
};

/**
 * Text the HTML parser watches for in a `<script>` once a `<!--` is in it: `-->`, `<script`
 * and `</script` decide which `</script>` ends the element. Removing a JS comment that holds
 * one can move that end, so in a script that contains `<!--` such comments are kept.
 */
const HTML_SCRIPT_MARKER = /<!--|-->|<\/?script/i;

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
  [
    ...REGEX_PRECEDING_KEYWORDS,
    "else",
    "extends",
    "import",
    "from",
    "as",
  ].filter((keyword) => keyword !== "return" && keyword !== "yield"),
);

/**
 * A processed line ending in one of these reserved words continues on the next line:
 * `else`/`do`/`try`/`finally` take a body, `for` its header (`for\nawait (...)`),
 * `var`/`let`/`const`/`function`/`class` take the name they declare
 * (`var\n  first = 1,\n  second = 2`), the rest take an operand
 * (`typeof\nx`, `a in\nb`). Contextual words (`of`, `await`, `from`) are left out because they
 * are also valid identifiers that can end a statement. `let` is one too: it continues only where
 * the scanner saw it start a statement and a name, `[` or `{` follows (see `letKeywordEnds`),
 * and is a variable name anywhere else. The character class keeps
 * `x.case` a property and `this.#class` a private name; a `...` spread takes an operand
 * (`[...new\n  Set(a)]`).
 */
const LINE_END_CONTINUING_KEYWORD =
  /(?:^|\.\.\.|(?![\w$\\]|[^\x00-\x7f\s])[^.#])(?:else|do|try|finally|in|instanceof|typeof|void|delete|new|case|extends|default|export|import|var|let|const|function|class|for)\s*$/;

/**
 * The words the line-end keyword rules (`LINE_END_CONTINUING_KEYWORD`,
 * `RESTRICTED_PRODUCTION_END`, `CONTEXTUAL_OPERATOR_END`) look for.
 */
const LINE_END_KEYWORD_SPELLING =
  /^(?:return|throw|yield|await|debugger|break|continue|else|do|try|finally|in|instanceof|typeof|void|delete|new|case|extends|default|export|import|var|let|const|function|class|for)$/;

/** A line ending in the word `let` (not `x.let` or `#let`). */
const LINE_END_LET = /(?:^|(?![\w$\\]|[^\x00-\x7f\s])[^.#])let$/;

/** What may follow a `let` that declares: a binding name or a destructuring pattern. */
const LET_DECLARATION_CONTINUATION = /^(?:[A-Za-z_$\\[{]|[^\x00-\x7f\s])/;

/**
 * A line ending in a restricted production: ECMAScript ends the statement at the line break
 * after `return`, `throw`, `yield`, `debugger` and `break`/`continue` (with or without a
 * label), so a following `(` or `[` line is a new statement.
 */
const RESTRICTED_PRODUCTION_END =
  /(?:^|(?![\w$\\]|[^\x00-\x7f\s])[^.#])(?:return|throw|yield|debugger|(?:break|continue)(?:\s+(?:[\w$\\]|[^\x00-\x7f\s])+)?)$/;

/**
 * A line ending in `await` or `yield`. `await` is an operator in an async function or a
 * module and a name elsewhere; `yield` is a restricted production in a generator and a name
 * elsewhere. The scanner does not track which, and the line break after either word means
 * something different in each (`await\na` is `await a` or two statements, `yield\n(a)` is two
 * statements or a call), so it stays as written. `x.await` and `#yield` are names.
 */
const CONTEXTUAL_OPERATOR_END =
  /(?:^|(?![\w$\\]|[^\x00-\x7f\s])[^.#])(?:await|yield)$/;

/**
 * Stands for a line break kept in the output (see `CONTEXTUAL_OPERATOR_END`) while the code
 * is normalized, which collapses whitespace. Outside literals, U+0001 is not valid JavaScript,
 * so none is in the source.
 */
const KEPT_LINE_BREAK = "\u0001";

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
 * declaration: its initializer, the next binding, the end, or the `in` of a `for` header. The
 * `of` of a header is told apart from a variable named `of` by the scanner
 * (`moduleFromBreaks`).
 */
const BARE_BINDING_CONTINUATION = /^(?:[=,;]|in(?![\w$\\]|[^\x00-\x7f\s]))/;

/** A decimal integer literal, which a `.` written right after it makes a decimal (`1.`). */
const DECIMAL_INTEGER = /^(?:0|[1-9][\d_]*|0\d*[89]\d*)$/;

/** Words after which an `export` declares or exports a value instead of a `from` clause. */
const MODULE_CLAUSE_ENDING_WORDS = new Set([
  "default",
  "var",
  "let",
  "const",
  "function",
  "class",
  "async",
]);

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
  "delete",
]);

/**
 * The last character of an operator that takes an operand next (`b + {}`, `!{}`, `a < {}`,
 * and the `>` of `=>` before a `function` or `class`). After a postfix `++`/`--` the `+` or
 * `-` has ended an expression instead.
 */
const OPERAND_EXPECTED_AFTER = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "^",
  "~",
  "!",
]);

/**
 * Characters after which only an expression can start, so a `function` or `class` right
 * after one is a function or class expression: `x = function () {}`, `f(class {})`. The
 * operators in `OPERAND_EXPECTED_AFTER` and the `:` of a conditional count too.
 */
const EXPRESSION_START_AFTER = new Set(["=", "(", ",", "[", "?", "&", "|"]);
/** Words that, at the start of a class member, modify the member named after them. */
const CLASS_MEMBER_MODIFIERS = new Set(["get", "set", "async", "accessor"]);

/**
 * Identifier/number characters: the "word" class the scanner tracks. Outside string, template
 * and regex literals, a non-ASCII character that is not whitespace can only be part of a name
 * (Unicode ID_Start or ID_Continue, ZWNJ, ZWJ, or half of an astral one), and a `\` only starts
 * a `\u` escape in one, so both count.
 */
const isWordChar = (c: string): boolean =>
  (c >= "a" && c <= "z") ||
  (c >= "A" && c <= "Z") ||
  (c >= "0" && c <= "9") ||
  c === "_" ||
  c === "$" ||
  c === "\\" ||
  (c >= "\u0080" && !isSpace(c));

const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** ECMAScript's LineTerminator: LF, CR, LINE SEPARATOR and PARAGRAPH SEPARATOR. */
const isLineTerminator = (c: string | undefined): boolean =>
  c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";

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
    else if (isLineTerminator(c)) return i;
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
        while (i < js.length && !isLineTerminator(js[i])) {
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
  // The last `}` ended a value (see `braceEndsValue`), so a `/` after it divides.
  let lastBraceEndedValue = false;
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
  let numberDotEnds: Set<number> | undefined;
  let integerBeforeDotLines: Set<number> | undefined;
  let moduleFromBreaks: Set<number> | undefined;
  // A `+`, `-` or `!` that started a line after a value in a declaration: the next character
  // tells whether it starts a new statement (`++b`, `!f()`) or continues (`+ b`, `!= b`).
  let operatorAfterValueBreak = "";
  // The `(`, `[` and `{` nesting of each `?` of a conditional still waiting for its `:`, and
  // whether the `:` last read is a conditional's (`b ? {} : {}`), not a label's or a key's.
  const conditionalNesting: number[] = [];
  let colonIsConditional = false;
  // The same for each `case` or `default` of a `switch` still waiting for its `:`, and whether
  // the `:` last read ends one. A case clause holds declarations; a label's statement does not
  // (`case 1: let\nx` declares `x`, `a: let\nx` reads a variable named `let`).
  const caseColonNesting: number[] = [];
  let colonEndsCase = false;
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

  // An `import` or `export` was read and its module specifier has not come yet, so a `from`
  // here is the keyword before it, not a variable named `from`.
  let moduleClauseOpen = false;
  // In an open clause: an `as` here is the keyword (after `*`, or after a name or string
  // being imported or exported), and the `as` last read still waits for its name.
  // How many `{` were open at the `import` or `export`, so a `{` past that is the clause's.
  let moduleClauseBraceLevel = 0;
  // The clause's `{...}` has closed: only its `from` can follow.
  let moduleClauseBracesClosed = false;
  let clauseAsAllowed = false;
  let clauseAsTargetNext = false;
  // One entry per open `[`: true when it opens the computed key of a class member.
  const bracketIsComputedKey: boolean[] = [];
  // Offset in `codeAccum` of the `]` that last closed a computed key, or -1.
  let lastComputedKeyCloseOffset = -1;
  let contextualKeywordEnds: Set<number> | undefined;
  let propertyKeywordEnds: Set<number> | undefined;
  let letKeywordEnds: Set<number> | undefined;
  // The word being read starts a statement (or a `for` header), where `let` can declare.
  let wordAtStatementStart = false;
  let continuesClause = false;

  /**
   * Whether `word`, read as a keyword, takes an operand next. The contextual words count only
   * where they are keywords: `from` and `as` in an `import` or `export`, `of` in a `for`
   * header.
   */
  const continuesExpression = (word: string): boolean => {
    if (!EXPRESSION_CONTINUING_KEYWORDS.has(word)) return false;
    if (word === "from") return moduleClauseOpen;
    if (word === "as") return moduleClauseOpen && clauseAsTargetNext;
    if (word === "of") return parenIsControlHeader.at(-1) === true;
    return true;
  };

  /** The segment before is a string, template or regex literal: a value, not a comment. */
  const previousIsValueLiteral = (): boolean => {
    const previous = segments.at(-1);
    return previous?.literal === true && previous.keptComment === undefined;
  };

  /** How many `(`, `[` and `{` are open. */
  const nesting = (): number =>
    parenIsControlHeader.length + bracketDepth + braceKind.length;

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
    if (!lastSig) return previousIsValueLiteral();
    if (lastSigIsPostfixUpdate) return true;
    if (lastSig === ")" || lastSig === "]" || lastSig === "}") return true;
    if (!isWordChar(lastSig)) return false;
    return wordIsProperty || !continuesExpression(wordRun);
  };

  const closeDeclaration = (): void => {
    declarationParenDepth.pop();
    declarationBracketDepth.pop();
    declarationBraceDepth.pop();
  };

  /**
   * Close the open declaration when the punctuator `c`, the first on its line, starts a new
   * statement, so a comma later on that statement's line does not start a binding
   * (`let p\n(0, f)\n(5)` calls `f`). After a binding name with no initializer only `=`, `,`
   * and `;` continue the declaration; after any other value a `++`, `--` (a postfix update
   * cannot follow a line break), `~` or `!` that is not `!=` starts a new statement.
   */
  const endDeclarationAtLineStart = (c: string): void => {
    const pending = operatorAfterValueBreak;
    operatorAfterValueBreak = "";
    if (isSpace(c) || !atDeclarationLevel()) return;
    if (pending !== "") {
      if (pending === "!" ? c !== "=" : c === pending) closeDeclaration();
      return;
    }
    if (!lineBreakSinceSignificant) return;
    if (bareBindingEnds?.has(lastSigOffset) === true) {
      if (c !== "=" && c !== "," && c !== ";") closeDeclaration();
    } else if (valueEndsHere()) {
      if (c === "~") closeDeclaration();
      else if (c === "+" || c === "-" || c === "!") operatorAfterValueBreak = c;
    }
  };

  /**
   * Whether the word last read is a decimal integer literal that a `.` right after it would
   * extend (`1`, `1_000`, `08`), and not `0x1`, `1e3`, a legacy octal `07`, the fraction of
   * `1.5` or the exponent of `1e-5`, which a `.` after them only takes a property of.
   */
  const wordIsDecimalInteger = (): boolean => {
    if (!isWordChar(lastSig) || wordIsProperty) return false;
    if (!DECIMAL_INTEGER.test(wordRun)) return false;
    const start = lastSigOffset + 1 - wordRun.length;
    const sign = codeAccum[start - 1];
    if (
      (sign !== "+" && sign !== "-") ||
      !/[eE]/.test(codeAccum[start - 2] ?? "")
    ) {
      return true;
    }
    // `1e-5`: the word before the sign is a number when it starts with a digit (`xe-5` is not).
    let p = start - 2;
    while (p > 0 && isWordChar(codeAccum[p - 1])) p--;
    return !isDigit(codeAccum[p]);
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
      // `accessor e`, `get a`: the name after a modifier on its line starts the same member.
      if (
        CLASS_MEMBER_MODIFIERS.has(wordRun) &&
        wordStartsClassMember &&
        !lineBreakSinceSignificant
      ) {
        return true;
      }
      return (
        lineBreakSinceSignificant &&
        !continuesExpression(wordRun) &&
        !CLASS_MEMBER_MODIFIERS.has(wordRun)
      );
    }
    if (!lineBreakSinceSignificant) return false;
    // After `)`, `]`, or a string, template or regex literal.
    return (
      lastSig === ")" ||
      lastSig === "]" ||
      (!lastSig && previousIsValueLiteral())
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
        numberDotEnds,
        integerBeforeDotLines,
        moduleFromBreaks,
        contextualKeywordEnds,
        propertyKeywordEnds,
        letKeywordEnds,
        ...(continuesClause ? { continuesClause } : {}),
      });
      codeAccum = "";
    }
    contextualKeywordEnds = undefined;
    propertyKeywordEnds = undefined;
    letKeywordEnds = undefined;
    lastComputedKeyCloseOffset = -1;
    continuesClause = false;
    bareBindingEnds = undefined;
    numberDotEnds = undefined;
    integerBeforeDotLines = undefined;
    moduleFromBreaks = undefined;
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
      return kind === "string" && previousIsValueLiteral();
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
    // `x = 5.\n"y"`: the dot ends the number, it does not take a property name.
    if (lastSig === ".") return numberDotEnds?.has(lastSigOffset) === true;
    if (lastSig === ")") return !lastParenClosedControlHeader;
    if (isWordChar(lastSig)) {
      if (wordIsProperty) return true;
      // `get\n'a'() {}`, `static\n'a' = 1`: a line break may follow these modifiers, so the
      // string names the member they modify.
      if (memberModifierEnds?.has(lastSigOffset) === true) return false;
      if (
        (wordRun === "get" || wordRun === "set") &&
        atObjectMemberLevel() &&
        (codeAccum[sigOffsetBeforeWord] === "{" ||
          codeAccum[sigOffsetBeforeWord] === ",")
      ) {
        return false;
      }
      return !continuesExpression(wordRun);
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
      // `b ? {} : {}`, `b + {}`, `!{}`; not the arrow body of `=> {`.
      (lastSig === ":" && colonIsConditional) ||
      (OPERAND_EXPECTED_AFTER.has(lastSig) &&
        !lastSigIsPostfixUpdate &&
        !(lastSig === ">" && prevSig === "=")) ||
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
          (OPERAND_EXPECTED_AFTER.has(lastSig) && !lastSigIsPostfixUpdate) ||
          (lastSig === ":" && colonIsConditional) ||
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
        wordAtStatementStart =
          lastSig === "" ||
          lastSig === ";" ||
          lastSig === "}" ||
          (lastSig === "{" && !atObjectMemberLevel()) ||
          (lastSig === "(" && parenIsControlHeader.at(-1) === true) ||
          (lastSig === ":" && colonEndsCase) ||
          (wordRun === "export" && !wordIsProperty) ||
          (lineBreakSinceSignificant && valueEndsHere());
        valueBeforeWord = valueEndsHere() && !DECLARATION_KEYWORDS.has(wordRun);
        wordBeforeWord =
          isWordChar(lastSig) && !wordIsProperty && !lineBreakSinceSignificant
            ? wordRun
            : "";
        // A property (`x.class`) or a private name (`#return`): a name, never a keyword.
        wordIsProperty = lastSig === "." || lastSig === "#";
        sigOffsetBeforeWord = lastSigOffset;
        lineBreakBeforeWord = lineBreakSinceSignificant;
        wordIsBindingName = bindingNameExpected;
        bindingNameExpected = false;
        if (operatorAfterValueBreak !== "") endDeclarationAtLineStart(c);
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
    if (
      wordIsProperty &&
      isWordChar(lastRaw) &&
      sigOffsetBeforeWord !== -1 &&
      codeAccum[sigOffsetBeforeWord] === "." &&
      // `...typeof x` spreads an operand.
      codeAccum[sigOffsetBeforeWord - 1] !== "." &&
      LINE_END_KEYWORD_SPELLING.test(wordRun)
    ) {
      // `o. return\n(1)`, `o.\nnew\nfoo()`: a property, though no `.` is right before it.
      (propertyKeywordEnds ??= new Set()).add(lastSigOffset);
    }
    if (!wordIsProperty && !memberWordEnded && isWordChar(lastRaw)) {
      // A word just ended. `x.class` and `p.catch(f)` are properties, not keywords, and a
      // class member named `class` or `function` declares nothing.
      // `of` is a keyword only in a `for` header (`for (const x of y)`), a name elsewhere.
      const ofInForHeader =
        wordRun === "of" &&
        parenIsControlHeader.at(-1) === true &&
        (braceKind.length === 0 ||
          braceParenDepth[braceKind.length - 1] < parenIsControlHeader.length);
      if (
        lineBreakBeforeWord &&
        valueBeforeWord &&
        wordRun !== "in" &&
        !ofInForHeader &&
        wordRun !== "instanceof" &&
        atDeclarationLevel()
      ) {
        // `var a = 1\nfoo`: a name after a value on a new line starts a new statement.
        closeDeclaration();
      }
      if (
        (wordRun === "get" || wordRun === "set") &&
        atObjectMemberLevel() &&
        (codeAccum[sigOffsetBeforeWord] === "{" ||
          codeAccum[sigOffsetBeforeWord] === ",")
      ) {
        // `{ get\na() {} }`: a line break may follow the modifier of an object accessor.
        (memberModifierEnds ??= new Set()).add(lastSigOffset);
      }
      if (wordIsBindingName && atDeclarationLevel()) {
        (bareBindingEnds ??= new Set()).add(lastSigOffset);
      }
      if (
        wordRun === "from" &&
        moduleClauseOpen &&
        lineBreakBeforeWord &&
        sigOffsetBeforeWord !== -1
      ) {
        // `import { a }\nfrom "m"`: no statement ends before the `from` of a clause.
        (moduleFromBreaks ??= new Set()).add(sigOffsetBeforeWord);
      }
      if (moduleClauseOpen) {
        if (wordRun === "as" && clauseAsAllowed) {
          // `import * as\nn`, `{ a\nas b }`: the clause continues on either side of `as`.
          clauseAsAllowed = false;
          clauseAsTargetNext = true;
          (contextualKeywordEnds ??= new Set()).add(lastSigOffset);
          if (lineBreakBeforeWord) {
            if (sigOffsetBeforeWord !== -1) {
              (moduleFromBreaks ??= new Set()).add(sigOffsetBeforeWord);
            } else if (previousIsValueLiteral()) {
              continuesClause = true;
            }
          }
        } else {
          // A name imported or exported may take an `as` next; the name after `as` may not.
          clauseAsAllowed = !clauseAsTargetNext && wordRun !== "from";
          clauseAsTargetNext = false;
        }
      }
      if (ofInForHeader) {
        // `for (const x of\ny)`, `for (const x\nof y)`: no statement ends inside the header.
        (contextualKeywordEnds ??= new Set()).add(lastSigOffset);
        if (lineBreakBeforeWord && sigOffsetBeforeWord !== -1) {
          (moduleFromBreaks ??= new Set()).add(sigOffsetBeforeWord);
        }
      }
      // Inside the braces of a clause every word is a name being imported or exported
      // (`export { default as x, let }`), never a keyword.
      const clauseName =
        moduleClauseOpen && braceKind.length > moduleClauseBraceLevel;
      if (clauseName) {
        // Nothing to track: the word declares nothing and does not end the clause.
      } else if (wordRun === "import" || wordRun === "export") {
        clauseAsAllowed = false;
        clauseAsTargetNext = false;
        moduleClauseOpen = !atObjectMemberLevel();
        moduleClauseBraceLevel = braceKind.length;
        moduleClauseBracesClosed = false;
      } else if (
        MODULE_CLAUSE_ENDING_WORDS.has(wordRun) ||
        (moduleClauseBracesClosed && wordRun !== "from")
      ) {
        // `export default from`, `export const a = from`: a value follows, not a clause.
        moduleClauseOpen = false;
      }
      if (
        (wordRun === "case" ||
          (wordRun === "default" && wordBeforeWord !== "export")) &&
        !clauseName &&
        !atObjectMemberLevel()
      ) {
        // `case 1:` and `default:`, not `export default` or a key named `default`.
        caseColonNesting.push(nesting());
      }
      if (wordRun === "let" && wordAtStatementStart && !clauseName) {
        (letKeywordEnds ??= new Set()).add(lastSigOffset);
      }
      if (
        !clauseName &&
        DECLARATION_KEYWORDS.has(wordRun) &&
        (wordRun !== "let" || wordAtStatementStart) &&
        !atObjectMemberLevel()
      ) {
        // `{ const: v, deprecated }` names a key, not a declaration.
        declarationParenDepth.push(parenIsControlHeader.length);
        declarationBracketDepth.push(bracketDepth);
        declarationBraceDepth.push(braceKind.length);
        bindingNameExpected = true;
      }
      if (clauseName) {
        // `import { function as f }` names an export.
      } else if (wordRun === "function" || wordRun === "catch") {
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
    endDeclarationAtLineStart(c);
    if (c === "(" || c === "." || c === ";" || c === "=") {
      // `import("a")`, `import.meta`, the end of the statement, or an initializer.
      moduleClauseOpen = false;
    }
    if (!isSpace(c)) {
      // `* as n`; after `{`, `,` or `}` no `as` can come before a name.
      clauseAsAllowed = c === "*" && moduleClauseOpen;
      clauseAsTargetNext = false;
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
        // `export { a }\n{ let x }`: a second `{` is a block after the clause.
        if (moduleClauseBracesClosed) moduleClauseOpen = false;
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
        if (moduleClauseOpen && braceKind.length === moduleClauseBraceLevel) {
          moduleClauseBracesClosed = true;
        }
        if (lastBraceClosedArrowBody) {
          (arrowBodyCloses ??= new Set()).add(codeAccum.length);
        }
        lastBraceEndedValue = braceEndsValue.pop() ?? false;
        if (lastBraceEndedValue) {
          (valueBraceCloses ??= new Set()).add(codeAccum.length);
        }
        break;
      case ":":
        colonIsConditional = conditionalNesting.at(-1) === nesting();
        if (colonIsConditional) conditionalNesting.pop();
        colonEndsCase =
          !colonIsConditional && caseColonNesting.at(-1) === nesting();
        if (colonEndsCase) caseColonNesting.pop();
        break;
      case "#":
        hashStartsClassMember = startsClassMember();
        break;
      case "[":
      case "*": {
        // `name\n[key] = 1` and `name\n*items() {}` in a class body: `name` is a field of its
        // own. `static`, `get` and `set` are modifiers of the member that follows. A computed
        // key (`[name]\n[key] = 1`) cannot be indexed or multiplied either.
        const fieldEnds =
          lineBreakSinceSignificant &&
          lastSigOffset !== -1 &&
          ((isWordChar(lastSig) &&
            wordStartsClassMember &&
            // `#static` and `#get` are field names, not modifiers.
            (wordIsProperty ||
              (wordRun !== "static" &&
                (c === "*" || (wordRun !== "get" && wordRun !== "set"))))) ||
            (lastSig === "]" && lastComputedKeyCloseOffset === lastSigOffset));
        if (fieldEnds) (fieldNameEnds ??= new Set()).add(lastSigOffset);
        if (c === "[") {
          // A computed key starts a member: after `{`, `;` or the `}` of a method, after a
          // modifier, or where the field before it has just ended.
          bracketIsComputedKey.push(
            atClassMemberLevel() &&
              (fieldEnds ||
                lastSig === "{" ||
                lastSig === ";" ||
                (lastSig === "}" && !lastBraceEndedValue) ||
                (isWordChar(lastSig) &&
                  !wordIsProperty &&
                  wordStartsClassMember &&
                  (wordRun === "static" ||
                    CLASS_MEMBER_MODIFIERS.has(wordRun))) ||
                (!lastSig &&
                  lineBreakSinceSignificant &&
                  segments.at(-1)?.classMemberName === true)),
          );
          bracketDepth++;
        }
        break;
      }
      case "]":
        if (bracketDepth > 0) bracketDepth--;
        if (bracketIsComputedKey.pop() === true) {
          lastComputedKeyCloseOffset = codeAccum.length;
        }
        break;
      case ".":
        if (wordIsDecimalInteger()) {
          if (lastRaw === lastSig) {
            // `5.`: the dot is part of the number.
            (numberDotEnds ??= new Set()).add(codeAccum.length);
          } else if (lineBreakSinceSignificant) {
            // `1\n.toString()`: the dot takes a property of the number.
            (integerBeforeDotLines ??= new Set()).add(lastSigOffset);
          }
        }
        break;
      case ";":
        bodyHeaderPending = false;
        if (atDeclarationLevel()) closeDeclaration();
        break;
    }
    if (c === ")" || c === "]" || c === "}") {
      closeLeftDeclarations();
      const depth = nesting();
      while ((conditionalNesting.at(-1) ?? -1) > depth)
        conditionalNesting.pop();
      while ((caseColonNesting.at(-1) ?? -1) > depth) caseColonNesting.pop();
    }
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
    const afterWord = isWordChar(lastSig) && !wordIsProperty ? wordRun : "";
    // The module specifier ends the clause (a string export name, `export { "a b" as c }`,
    // does not). Its `with { type: "json" }` attributes may follow on the next line.
    const moduleSpecifier =
      kind === "string" &&
      ((afterWord === "from" && moduleClauseOpen) || afterWord === "import");
    if (afterWord === "from" || afterWord === "import")
      moduleClauseOpen = false;
    // `export { "a b" as c }`: a string name may take an `as` next, unless it follows one.
    clauseAsAllowed =
      moduleClauseOpen && kind === "string" && !clauseAsTargetNext;
    clauseAsTargetNext = false;
    // `await\n"a"` is `await "a"` in a module or an async function and two statements where
    // `await` is a name, and `yield\n\`x\`` is two statements in a generator and a tagged
    // template where `yield` is a name. The scanner does not track which, so the line break
    // stays (see `CONTEXTUAL_OPERATOR_END`).
    const lineBreakBefore =
      lineBreakSinceSignificant &&
      (afterWord === "await" || afterWord === "yield");
    if (operatorAfterValueBreak !== "") {
      // `let p = 1\n!"x"`: the `!` started a new statement.
      endDeclarationAtLineStart(text[0]);
    } else if (asiBefore && atDeclarationLevel()) {
      // `var a = 1\n"x"`: the literal starts a new statement, which declares nothing.
      closeDeclaration();
    }
    // `'a b'\n[k] = 1`: a string that starts a class member, or follows its modifier.
    const classMemberName =
      kind === "string" &&
      (startsClassMember() ||
        (atClassMemberLevel() &&
          isWordChar(lastSig) &&
          !wordIsProperty &&
          wordStartsClassMember &&
          CLASS_MEMBER_MODIFIERS.has(wordRun)));
    bindingNameExpected = false;
    flushCode();
    const segment: Segment = lineBreakBefore
      ? { literal: true, text, lineBreakBefore }
      : asiBefore
        ? { literal: true, text, asiBefore }
        : moduleSpecifier
          ? { literal: true, text, moduleSpecifier }
          : { literal: true, text };
    if (classMemberName) segment.classMemberName = true;
    segments.push(segment);
    lineBreakSinceSignificant = false;
  };

  /** The end of the line comment that starts at `start`. */
  const lineCommentEnd = (start: number): number => {
    let end = start;
    while (end < len && !isLineTerminator(js[end])) {
      __scanStatsForTests.charsExamined++;
      end++;
    }
    return end;
  };

  // A comment holding an HTML script marker is kept only where the HTML parser watches for
  // them: once the script has a `<!--`. Elsewhere `-->` and `<script` in a comment are inert.
  const htmlMarkersMatter = js.includes("<!--");

  /** Push a comment kept as written (see `Segment.keptComment`). */
  const pushKeptComment = (
    text: string,
    keptComment: "line" | "close" | "block",
  ): void => {
    bindingNameExpected = false;
    flushCode();
    segments.push({ literal: true, text, keptComment });
  };

  // Only whitespace and comments since the last line break (or the start of the script), so
  // a `-->` here is an HTML-like comment.
  let atLineStart = true;

  while (i < len) {
    const ch = js[i];
    __scanStatsForTests.charsExamined++;
    const lineStart = atLineStart;
    if (isLineTerminator(ch)) atLineStart = true;
    else if (!isSpace(ch) && !(ch === "/" && js[i + 1] === "*")) {
      atLineStart = false;
    }

    if (ch === "-" && lineStart && js.startsWith("->", i + 1)) {
      // `-->` at the start of a line is a line comment in a classic script and a syntax error
      // in a module (a `--` cannot follow a line break), so it is dropped like `//`.
      const end = lineCommentEnd(i + 3);
      if (htmlMarkersMatter) pushKeptComment(js.slice(i, end), "close");
      i = end;
      continue;
    }

    if (ch === "<" && js.startsWith("!--", i + 1)) {
      // `<!--` is a line comment in a classic script, unless its `<` is the second of a `<<`.
      let lessThans = 0;
      while (js[i - 1 - lessThans] === "<") lessThans++;
      if (lessThans % 2 === 0) {
        const end = lineCommentEnd(i + 4);
        pushKeptComment(js.slice(i, end), "line");
        i = end;
        continue;
      }
    }

    if ((ch === "+" || ch === "-") && js[i + 1] === ch) {
      const previousLiteral = !lastSig && previousIsValueLiteral();
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
          if (
            !lastSeg ||
            !lastSeg.literal ||
            lastSeg.keptComment !== undefined
          ) {
            couldBeRegex = true;
          }
        } else if (isWordChar(lastSig)) {
          // Preceded by a word token: a regex only after an expression keyword (`return /a/`).
          // The whole word counts: `$return / 2 / g` and `o.return / 2` divide.
          couldBeRegex =
            !wordIsProperty && REGEX_PRECEDING_KEYWORDS.has(wordRun);
        } else if (lastSig === ")") {
          // `if (x) /re/.test(y)` is a regex statement; `f(x) / 2` is division.
          couldBeRegex = lastParenClosedControlHeader;
        } else if (
          lastSigIsPostfixUpdate ||
          (lastSig === "." && numberDotEnds?.has(lastSigOffset) === true)
        ) {
          // `count++ / 2` and `5. / 2` are division: a postfix update or a number ends the
          // expression.
          couldBeRegex = false;
        } else if (lastSig === "}") {
          // `x = {}\n/ 2 /* d */` divides an object literal (or a function or class
          // expression). After a block, and after an arrow body, which cannot be an operand,
          // a statement can start: a regex is kept when it closes on the same line.
          couldBeRegex = !lastBraceEndedValue || lastBraceClosedArrowBody;
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
          } else if (isLineTerminator(c)) break; // Unterminated — not a regex
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
        const commentStart = i;
        i += 2;
        let spansLines = false;
        while (i + 1 < len && !(js[i] === "*" && js[i + 1] === "/")) {
          __scanStatsForTests.charsExamined++;
          const c = js[i];
          if (isLineTerminator(c)) {
            spansLines = true;
          }
          i++;
        }
        i += 2;
        if (
          htmlMarkersMatter &&
          HTML_SCRIPT_MARKER.test(js.slice(commentStart, i))
        ) {
          pushKeptComment(js.slice(commentStart, i), "block");
          if (spansLines) {
            atLineStart = true;
            lineBreakSinceSignificant = true;
          }
          continue;
        }
        if (spansLines) {
          atLineStart = true;
          // ECMAScript reads a comment holding a line terminator as a line terminator, so
          // automatic semicolon insertion can end the statement there (`a = b /*\n*/ c`).
          appendCode("\n");
          continue;
        }
        // If stripping a block comment between two word characters (e.g., return/*x*/v),
        // preserve a space so token boundaries aren't lost. The same goes for two `+` or
        // two `-`, which would join into `++` or `--` (`a +/* sign */+ b`), and for a decimal
        // integer and a `.`, which would join into one number (`1/* c */.toString()`).
        const nextChar = js[i];
        if (
          lastRaw &&
          nextChar &&
          ((isWordChar(lastRaw) && isWordChar(nextChar)) ||
            ((lastRaw === "+" || lastRaw === "-") && nextChar === lastRaw) ||
            (nextChar === "." &&
              lastRaw === lastSig &&
              wordIsDecimalInteger()) ||
            // `a </* c */script` and `a--/* c */> b` must not write `<script` or `-->` into a
            // script holding `<!--`, where the HTML parser reads them.
            (htmlMarkersMatter &&
              ((lastRaw === "<" && (nextChar === "s" || nextChar === "S")) ||
                (lastRaw === "-" && nextChar === ">"))))
        ) {
          appendCode(" ");
        }
        continue;
      }

      if (next === "/") {
        // Line comment: skip to end of line (preserve newline for statement separation)
        const end = lineCommentEnd(i + 2);
        if (htmlMarkersMatter && HTML_SCRIPT_MARKER.test(js.slice(i, end))) {
          pushKeptComment(js.slice(i, end), "line");
        }
        i = end;
        continue;
      }
    }

    if (ch === "?") {
      const next = js[i + 1];
      if (next === "?") {
        // `??` and `??=` are not a conditional.
        appendCode(ch);
        appendCode(next);
        i += 2;
        continue;
      }
      appendCode(ch);
      i++;
      // `a?.b` is an optional chain; `a?.5:1` is a conditional with a number.
      if (next !== "." || isDigit(js[i + 1] ?? "")) {
        conditionalNesting.push(nesting());
      }
      continue;
    }

    if (
      ch === "\u2028" ||
      ch === "\u2029" ||
      (ch === "\r" && js[i + 1] !== "\n")
    ) {
      // A lone CR, LINE SEPARATOR or PARAGRAPH SEPARATOR ends a line as LF does; the line
      // joiner reads LF only.
      appendCode("\n");
      i++;
      continue;
    }

    if (ch === "\\" && js[i + 1] === "u" && js[i + 2] === "{") {
      // `\u{62}` in a name is the same name as `b`, and `\u{1D465}` as `𝑥`. Writing the
      // escape without braces keeps its `}` out of the brace tracking and away from the rules
      // that drop the spaces around a `}` (`a\u{62} in o` must not become `a\u{62}in o`).
      let end = i + 3;
      while (end < len && end - i < 64 && /[0-9a-fA-F]/.test(js[end])) end++;
      const codePoint =
        js[end] === "}" && end > i + 3
          ? Number.parseInt(js.slice(i + 3, end), 16)
          : Number.NaN;
      if (codePoint <= 0x10ffff) {
        const escape =
          codePoint <= 0xffff
            ? `\\u${codePoint.toString(16).padStart(4, "0")}`
            : String.fromCodePoint(codePoint);
        for (let k = 0; k < escape.length; k++) appendCode(escape[k]);
        i = end + 1;
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
  code = code.replace(/([^\d])\s*\.\s*([^\d\s])/g, "$1.$2");
  // `a < !--b` and `a <\n!--b` compare with a decrement: joined, `<!--` would start a comment.
  code = code.replace(/<!--/g, "< !--");
  if (code.includes(KEPT_LINE_BREAK)) {
    code = code.replaceAll(KEPT_LINE_BREAK, "\n");
  }
  return code.includes("\0") ? code.replace(/\0/g, " ") : code;
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
  // Once a script holds `<!--`, the HTML parser reads `<script` and `-->` in it to find the
  // `</script>` that ends the element, so joining code must not write either one.
  const htmlMarkersMatter = js.includes("<!--");

  // Process code segments and assemble minified JS.
  // `resultLast` mirrors result.slice(-1) without flattening the growing
  // string on every segment (V8 rope flattening made that quadratic in the
  // number of segments).
  let result = "";
  let resultLast = "";
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    if (seg.keptComment !== undefined) {
      // A kept block comment splits the code around it into two segments, so the line breaks
      // on either side of it stay as written: they end the statement where the source's do
      // (`x = a\n/* --> */\nb = 2`, `return /* --> */\n1`).
      const before = segments[sIdx - 1];
      const after = segments[sIdx + 1];
      const breakBefore =
        seg.keptComment === "block" &&
        before?.literal === false &&
        /\n\s*$/.test(before.text);
      const breakAfter =
        seg.keptComment === "block" &&
        after?.literal === false &&
        /^\s*\n/.test(after.text);
      if (seg.keptComment === "close" || breakBefore) {
        // A `-->` comment only starts at the start of a line.
        if (result && resultLast !== "\n") result += "\n";
      } else if (resultLast === "<" || resultLast === "/") {
        // `a < <!-- c` must not become `<<!--`, nor `a / // c` a `///` comment.
        result += " ";
      }
      if (seg.keptComment === "block") {
        result += breakAfter ? `${seg.text}\n` : seg.text;
        resultLast = breakAfter ? "\n" : "/";
      } else {
        result += `${seg.text.trimEnd()}\n`;
        resultLast = "\n";
      }
      continue;
    }
    if (seg.literal) {
      if (seg.asiBefore && result && resultLast !== ";") {
        // The source's line break ended the statement (`const a = 1\n"use strict"`).
        result += ";";
      } else if (seg.lineBreakBefore) {
        result += "\n";
      } else if (result && isWordChar(resultLast) && isWordChar(seg.text[0])) {
        // Ensure space between preceding keyword/identifier and literal if needed
        result += " ";
      } else if (
        (resultLast === "/" || resultLast === "<") &&
        seg.text[0] === "/"
      ) {
        // A division sign and then a regex literal (`a / /b/.source.length`): without the
        // space the two slashes start a line comment that swallows the rest of the script.
        // After `<` (`a < /script>/`), `</script` would end an inline `<script>` element.
        result += " ";
      }
      result += seg.text;
      resultLast = seg.text[seg.text.length - 1];
      continue;
    }

    if (
      sIdx > 0 &&
      segments[sIdx - 1].literal &&
      segments[sIdx - 1].keptComment === undefined &&
      /^\s*\n/.test(seg.text)
    ) {
      const firstLine = seg.text.match(/\S.*/)?.[0] ?? "";
      // `import a from "m.json"\nwith { type: "json" }`: the attributes continue the import.
      const importAttributes =
        segments[sIdx - 1].moduleSpecifier === true &&
        /^with(?![\w$\\]|[^\x00-\x7f\s])/.test(firstLine);
      // `'a b'\n[k] = 1`: a field named by a string ends before a `[` or `*` member.
      const fieldNameEnds =
        segments[sIdx - 1].classMemberName === true && /^[[*]/.test(firstLine);
      if (resultLast && firstLine && fieldNameEnds) {
        result += ";";
        resultLast = ";";
      } else if (
        resultLast &&
        firstLine &&
        !importAttributes &&
        seg.continuesClause !== true &&
        !/^(?:(?:instanceof|in)(?![\w$\\]|[^\x00-\x7f\s])|,|;|:|\(|\)|\}|\[|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
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
      // `1\n.toString()`: joined without a space, the `.` would make `1.` a number.
      const integerBeforeDot =
        firstChar === "." &&
        seg.integerBeforeDotLines?.has(prevLineEnd) === true;
      __scanStatsForTests.charsExamined += ptTail.length;

      // Check if semicolon is required between prevLine and current line
      let needsSemicolon = false;

      // Statements ending in value tokens or return/break/continue/throw require ; before next statement
      // `5.` ends a number: a value, though a line-end `.` otherwise takes a property next.
      // `o. return`, `o.\nnew`: a property spelled like a keyword, not the keyword.
      const propertyKeywordEnd =
        seg.propertyKeywordEnds?.has(prevLineEnd) === true;
      const numberDotEnd = seg.numberDotEnds?.has(prevLineEnd) === true;
      if (numberDotEnd || isWordChar(lastChar) || /[)\]'"`]/.test(lastChar)) {
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
          seg.contextualKeywordEnds?.has(prevLineEnd) === true ||
          (seg.memberKeywordNameEnds?.has(prevLineEnd) !== true &&
            !propertyKeywordEnd &&
            LINE_END_CONTINUING_KEYWORD.test(ptTail) &&
            // `x = let\nfoo()`: a `let` that does not declare is a variable name.
            (!LINE_END_LET.test(ptTail) ||
              (seg.letKeywordEnds?.has(prevLineEnd) === true &&
                LET_DECLARATION_CONTINUATION.test(line)))) ||
          (!numberDotEnd &&
            /(=|,|\+|\-|\*|\/|%|\?|:|=>|\.|\&\&|\|\||\?\?)\s*$/.test(ptTail));

        // Do NOT insert semicolon if next line starts with closing/continuation structures.
        // Only binary keyword operators (instanceof/in) continue an expression
        // across a newline (`of` only in a `for` header, which the scanner records
        // in `moduleFromBreaks`: elsewhere it is a name, `a\nof(1)`); after a value
        // token `else`, `while`, `catch` and
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
            : /^(instanceof(?![\w$\\]|[^\x00-\x7f\s])|in(?![\w$\\]|[^\x00-\x7f\s])|,|;|:|\)|\}|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
                line,
              ) ||
              ((firstChar === "(" || firstChar === "[") &&
                (propertyKeywordEnd ||
                  !RESTRICTED_PRODUCTION_END.test(prevLine)));

        if (
          !endsWithOpenControl &&
          !startsWithContinuation &&
          !/[;{}:,]\s*$/.test(ptTail)
        ) {
          needsSemicolon = true;
        } else if (
          !propertyKeywordEnd &&
          RESTRICTED_PRODUCTION_END.test(prevLine) &&
          !/^[;,:)\]}]/.test(line)
        ) {
          // `return\n-z` returns undefined: the line break after a restricted production
          // ends the statement whatever the next line starts with, so a sign, an operator
          // or a regex there starts a new statement (`return;-z`). Punctuation that ends
          // the expression holding a `yield` (`f(yield\n)`) takes no `;` before it.
          needsSemicolon = true;
        }
      } else if (lastChar === "}") {
        // After }, insert semicolon unless followed by control continuation (else, catch, finally, while, etc.)
        // A `(` or `[` line continues the `}` of an object literal or function expression
        // (and starts a new statement after a block or declaration either way), but not the
        // `}` of an arrow function body, which cannot be called or indexed.
        if (seg.arrowBodyCloses?.has(prevLineEnd) === true) {
          // An arrow function is not an operand either (`() => {}\n+y` is two statements):
          // only the punctuation that ends the expression holding it continues the line.
          needsSemicolon = !/^[,;:)\]}]/.test(line);
        } else if (
          !/^((?:else|catch|finally|while|instanceof|in)(?![\w$\\]|[^\x00-\x7f\s])|,|;|:|\)|\}|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
            line,
          ) &&
          firstChar !== "(" &&
          firstChar !== "["
        ) {
          needsSemicolon = true;
        } else if (
          seg.valueBraceCloses?.has(prevLineEnd) === true &&
          /^(?:else|while)(?![\w$\\]|[^\x00-\x7f\s])/.test(line)
        ) {
          // `if (a) x = {}\nelse y()`: the `}` ends a value, not the `if` body, so the
          // statement still needs its `;` before `else` (or before a `while` loop).
          needsSemicolon = true;
        }
      } else if (seg.postfixUpdateEnds?.has(prevLineEnd)) {
        const startsWithContinuation =
          /^(instanceof(?![\w$\\]|[^\x00-\x7f\s])|in(?![\w$\\]|[^\x00-\x7f\s])|,|;|:|\)|\}|\]|\.|\?|\*|\/|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\||!=)/.test(
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
      if (seg.moduleFromBreaks?.has(prevLineEnd)) {
        // `import { a }\nfrom "m"`: the clause continues with its `from`.
        needsSemicolon = false;
      }
      // `await\na`, `yield\n(a)`: the line break stays as written, unless the next line
      // starts with punctuation that no operand can start with, which reads the same joined.
      const keepLineBreak =
        !propertyKeywordEnd &&
        CONTEXTUAL_OPERATOR_END.test(prevLine) &&
        !/^[;,:)\]}]/.test(line);

      prevLineEnd = lineEnd;
      prevLine = line;
      if (keepLineBreak) {
        appendProcessed(KEPT_LINE_BREAK + line);
      } else if (needsSemicolon) {
        appendProcessed(";" + line);
      } else if (
        (isWordChar(lastChar) && isWordChar(firstChar)) ||
        ((lastChar === "+" || lastChar === "-") && firstChar === lastChar) ||
        integerBeforeDot ||
        (htmlMarkersMatter &&
          ((lastChar === "<" && /^script/i.test(line)) ||
            (ptTail.endsWith("--") && firstChar === ">")))
      ) {
        // Ensure space between word tokens when joining without semicolon, and between a
        // binary `+` or `-` and a sign or update on the next line: `a +\n+b` is `a+ +b`,
        // and `a +\n++b` is `a+ ++b`, where `a+++b` would read as `a++ + b`.
        appendProcessed(" " + line);
      } else {
        appendProcessed(line);
      }
    }

    // `\0` marks a space that normalization keeps: `a < script` and `a-- > b` must not
    // become `<script` or `-->` (see `htmlMarkersMatter`). Outside literals, a NUL is not
    // valid JavaScript, so none is in the source.
    const code = codeSegmentMemo.minify(
      htmlMarkersMatter
        ? processedText
            .replace(/<\s+(?=script)/gi, "<\0")
            .replace(/--\s+>/g, "--\0>")
        : processedText,
    );

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
