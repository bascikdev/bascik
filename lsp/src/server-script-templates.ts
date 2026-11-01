/**
 * Template literals in a server or stream script, for the sink rules and
 * server-script-unescaped-markup: every literal (nested ones inside a hole
 * too), its tag, its static parts and its holes, in one linear pass. Strings
 * and comments are skipped, so a backtick inside them is not a template.
 */
import { scanJavaScript } from "./module-specifiers.js";

export interface TemplateHole {
  /** Offset of `${`. */
  start: number;
  /** Offset just past the closing `}`. */
  end: number;
  /** The expression text between `${` and `}`. */
  expr: string;
  /** 1-based position in its literal. */
  index: number;
}

export interface TemplateLiteral {
  /** Offset of the opening backtick. */
  start: number;
  /** Offset just past the closing backtick. */
  end: number;
  /** The tag (`html`, `b.html`, `sql`), "?" for a call or index tag, or null when untagged. */
  tag: string | null;
  /** Static text between the holes (raw source text). */
  parts: string[];
  holes: TemplateHole[];
}

/** Words before a backtick that are not tags (`return \`...\``). */
const NOT_TAGS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
  "export",
  "default",
]);

const isWord = (c: string | undefined): boolean =>
  c !== undefined && /[\w$.]/.test(c);

const tagBefore = (source: string, backtick: number): string | null => {
  let k = backtick - 1;
  while (k >= 0 && (source[k] === " " || source[k] === "\t")) k--;
  if (k < 0) return null;
  if (k === backtick - 1 && (source[k] === ")" || source[k] === "]"))
    return "?";
  const end = k + 1;
  while (k >= 0 && isWord(source[k])) k--;
  const word = source.slice(k + 1, end);
  if (word === "" || /^\d/.test(word) || word.startsWith(".")) return null;
  if (NOT_TAGS.has(word)) return null;
  return word;
};

/** Keywords after which a `/` starts a regex literal rather than a division. */
export const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);

/** Punctuation after which an operand, so a regex, follows. */
export const OPERAND_FOLLOWS = new Set("(,=:[!&|?{};+-*%<>~^/");

/** The offset just past the regex literal that starts at `start` (its flags included). */
export function skipRegexLiteral(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length && source[i] !== "\n") {
    if (source[i] === "\\") i += 2;
    else if (inClass) {
      if (source[i] === "]") inClass = false;
      i++;
    } else if (source[i] === "[") {
      inClass = true;
      i++;
    } else if (source[i] === "/") {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      return i;
    } else i++;
  }
  return i;
}

/**
 * Every template literal in `source`, outer literals before the ones nested
 * in their holes. A `/` where an operand goes starts a regex literal, which
 * is skipped whole, so a quote, brace or backtick inside `/"/g` opens
 * nothing. Whether an operand goes there is read from the token before it,
 * kept as the scan goes, so the pass stays linear. The literals and holes
 * still open are kept on an explicit stack, so templates nested thousands
 * deep cannot overflow the call stack.
 */
export function findTemplateLiterals(source: string): TemplateLiteral[] {
  const literals: TemplateLiteral[] = [];

  const skipString = (i: number): number => {
    const quote = source[i];
    i++;
    while (i < source.length) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === quote) return i + 1;
      else if (source[i] === "\n") return i;
      else i++;
    }
    return i;
  };

  /** Code: the top level, or a hole's (which stops at the `}` that closes it). */
  interface Code {
    kind: "code";
    inHole: boolean;
    depth: number;
    // Whether a `/` here starts a regex: true where an operand goes.
    regexOk: boolean;
    // The last non-space character, to tell `x.return` from `return`.
    before: string;
    /** In a hole: the offset of its `${`. */
    holeStart: number;
  }
  /** A template's text, between its holes. */
  interface Text {
    kind: "text";
    literal: TemplateLiteral;
    partStart: number;
  }
  const code = (inHole: boolean, holeStart: number): Code => ({
    kind: "code",
    inHole,
    depth: 0,
    regexOk: true,
    before: "",
    holeStart,
  });
  const stack: (Code | Text)[] = [code(false, -1)];

  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1];
    if (top.kind === "text") {
      const c = source[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        top.literal.parts.push(source.slice(top.partStart, i));
        top.literal.end = i + 1;
        i++;
        stack.pop();
        const outer = stack[stack.length - 1] as Code;
        outer.regexOk = false;
        outer.before = c;
      } else if (c === "$" && source[i + 1] === "{") {
        top.literal.parts.push(source.slice(top.partStart, i));
        stack.push(code(true, i));
        i += 2;
      } else i++;
      continue;
    }
    const c = source[i];
    if (c === "'" || c === '"') {
      i = skipString(i);
      top.regexOk = false;
      top.before = c;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
    } else if (c === "/" && top.regexOk) {
      i = skipRegexLiteral(source, i);
      top.regexOk = false;
      top.before = "/";
    } else if (c === "`") {
      const literal: TemplateLiteral = {
        start: i,
        end: source.length,
        tag: tagBefore(source, i),
        parts: [],
        holes: [],
      };
      literals.push(literal);
      stack.push({ kind: "text", literal, partStart: i + 1 });
      i++;
    } else if (/[\w$]/.test(c)) {
      const wordStart = i;
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      top.regexOk =
        top.before !== "." &&
        REGEX_AFTER_KEYWORD.has(source.slice(wordStart, i));
      top.before = "w";
    } else if (/\s/.test(c)) i++;
    else {
      if (c === "{") top.depth++;
      else if (c === "}") {
        if (top.depth === 0 && top.inHole) {
          // The `}` that closes a hole: back to its template's text.
          stack.pop();
          const text = stack[stack.length - 1] as Text;
          text.literal.holes.push({
            start: top.holeStart,
            end: i + 1,
            expr: source.slice(top.holeStart + 2, i),
            index: text.literal.holes.length + 1,
          });
          i++;
          text.partStart = i;
          continue;
        }
        if (top.depth > 0) top.depth--;
      }
      top.regexOk = OPERAND_FOLLOWS.has(c);
      top.before = c;
      i++;
    }
  }
  // Holes and templates still open at the end of the source end there.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    if (frame.kind === "code") {
      const text = stack[stack.length - 1] as Text;
      const close = Math.min(i, source.length);
      text.literal.holes.push({
        start: frame.holeStart,
        end: Math.min(close + 1, source.length),
        expr: source.slice(frame.holeStart + 2, close),
        index: text.literal.holes.length + 1,
      });
      text.partStart = close + 1;
    } else frame.literal.parts.push(source.slice(frame.partStart));
  }
  return literals;
}

// ─── Exempt expressions ─────────────────────────────────────────────────────

export const HTML_MODULE = "@bascik/bascik/html";
const HTML_EXPORTS = new Set(["html", "raw", "esc", "safeUrl", "json"]);

/** Local names bound to @bascik/bascik/html exports in a script body. */
export interface HtmlImports {
  /** Local name to export name. */
  named: Map<string, string>;
  /** Namespace import names (`import * as b`). */
  namespaces: Set<string>;
}

const IDENTIFIER = /^[\w$]+$/;

/** `value` as a literal RegExp source: every syntax character escaped. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * One `{ ... }` import entry (`esc`, `html as h`) as [exported, local], or
 * undefined when it is not `name` or `name as local` with plain identifier
 * names (a half-typed `html as h(` binds nothing to tag with). Splits on
 * whitespace runs, not /\s+as\s+/, which retried a long whitespace run from
 * each of its characters.
 */
export function parseImportSpecifier(
  entry: string,
): [exported: string, local: string] | undefined {
  const words = entry.split(/\s+/).filter(Boolean);
  const [exported, as, local] =
    words.length === 1
      ? [words[0], "as", words[0]]
      : words.length === 3
        ? words
        : [];
  if (as !== "as" || !exported || !local) return undefined;
  return IDENTIFIER.test(exported) && IDENTIFIER.test(local)
    ? [exported, local]
    : undefined;
}

export function findHtmlImports(body: string): HtmlImports {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const m of body.matchAll(
    /\bimport\s*\{([^}]*)\}\s*from\s*["']@bascik\/bascik\/html["']/g,
  )) {
    for (const entry of m[1].split(",")) {
      const specifier = parseImportSpecifier(entry);
      if (specifier && HTML_EXPORTS.has(specifier[0]))
        named.set(specifier[1], specifier[0]);
    }
  }
  for (const m of body.matchAll(
    /\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*["']@bascik\/bascik\/html["']/g,
  ))
    namespaces.add(m[1]);
  return { named, namespaces };
}

/** The export a callee or tag names (`esc`, `b.esc`), or undefined. */
export function htmlExportOf(
  name: string,
  imports: HtmlImports,
): string | undefined {
  const dot = name.indexOf(".");
  if (dot === -1) return imports.named.get(name);
  const ns = name.slice(0, dot);
  const member = name.slice(dot + 1);
  return imports.namespaces.has(ns) && HTML_EXPORTS.has(member)
    ? member
    : undefined;
}

/** The names that tag an html template in this body. */
export function htmlTagNames(imports: HtmlImports): string[] {
  const names = [...imports.named]
    .filter(([, exported]) => exported === "html")
    .map(([local]) => local);
  for (const ns of imports.namespaces) names.push(`${ns}.html`);
  return names;
}

/** Index of the bracket that closes the one at `open`, skipping strings and templates. */
const matchingClose = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Top-level operator positions in `text` (outside brackets, strings and templates). */
const topLevel = (text: string, visit: (i: number) => boolean | void): void => {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        else if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
          const close = matchingClose(text, i + 1);
          if (close === -1) return;
          i = close;
        }
        i++;
      }
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && visit(i) === true) return;
  }
};

const LITERAL =
  /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?(?:\d[\d_]*\.?\d*(?:e[+-]?\d+)?|0x[\da-f]+)n?|true|false|null|undefined)$/i;
const HOLE_FREE_TEMPLATE = /^`(?:[^`\\$]|\\.|\$(?!\{))*`$/;

export interface ExemptContext {
  imports: HtmlImports;
  htmlTags: string[];
  escapeFunctions: readonly string[];
  /** `const|let|var NAME = EXPR` bindings in the body (every binding of a name). */
  bindings: Map<string, string[]>;
  /**
   * Verdicts already reached for a name, so a name declared in many
   * functions (`const count` in each) is read once for the whole script,
   * not once per hole. Filled by isExempt and isEscapedJson.
   */
  memo?: NameMemo;
}

/**
 * Per-name verdicts, and the state that keeps them sound: a verdict cut
 * short by a cycle or by the alias depth bound is not stored when false.
 */
export interface NameMemo {
  exempt: Map<string, boolean>;
  escapedJson: Map<string, boolean>;
  /** boundTo verdicts, by question, and the label each fine name resolved to. */
  bound: Map<
    string,
    { verdicts: Map<string, boolean>; labels: Map<string, string> }
  >;
  /** Names being read right now, innermost last. */
  depth: number;
  /** A read under way was cut short (a cycle or the depth bound). */
  cut: boolean;
}

export const newNameMemo = (): NameMemo => ({
  exempt: new Map(),
  escapedJson: new Map(),
  bound: new Map(),
  depth: 0,
  cut: false,
});

/**
 * How many names deep an alias chain is followed (`const b = a; const c =
 * b; ...`). Deeper chains count as not fine, so a generated chain of
 * thousands of aliases cannot overflow the stack.
 */
const MAX_ALIAS_DEPTH = 200;

/**
 * Whether every value bound to `name` passes `check`, read once per script
 * through `verdicts`. A name already on the path (a cycle) or past
 * MAX_ALIAS_DEPTH is not fine; a false verdict cut short that way is not
 * stored, since a later read from elsewhere may reach further.
 */
function nameVerdict(
  name: string,
  bound: readonly string[],
  memo: NameMemo,
  verdicts: Map<string, boolean>,
  seen: Set<string>,
  check: (value: string) => boolean,
): boolean {
  const known = verdicts.get(name);
  if (known !== undefined) return known;
  if (seen.has(name) || memo.depth >= MAX_ALIAS_DEPTH) {
    memo.cut = true;
    return false;
  }
  seen.add(name);
  const outerCut = memo.cut;
  memo.cut = false;
  memo.depth++;
  let result: boolean;
  try {
    result = bound.every(check);
  } finally {
    memo.depth--;
  }
  if (result || !memo.cut) verdicts.set(name, result);
  memo.cut = outerCut || memo.cut;
  return result;
}

/**
 * `const|let|var NAME = EXPR` bindings, each EXPR up to `;`, `,` or the line
 * end at its own depth, or the bracket that closes the one it is in. A
 * TypeScript annotation (`const NAME: Record<string, string> = EXPR`) is
 * skipped. A let or var name also collects every later plain assignment
 * (`NAME = EXPR`, `NAME += EXPR`, `NAME ||= EXPR`, `NAME ??= EXPR`), so a
 * name reassigned from request data is not trusted from its declaration.
 * Destructured names (`const { icon } = EXPR`) are left out: EXPR is not
 * their value. Every value's end is found in one pass (valueEnds), so
 * nested declarations, each of which runs to the end of the ones around
 * it, are not each scanned again.
 */
export function findBindings(
  body: string,
  ranges: readonly BindingRange[] = findBindingRanges(body),
): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const { name, from, end, destructured, assigned } of ranges) {
    // A destructuring declaration's value holds the name somewhere; a
    // destructuring assignment stores a value this file does not follow.
    if (destructured && !assigned) continue;
    const list = bindings.get(name) ?? [];
    list.push(body.slice(from, end));
    bindings.set(name, list);
  }
  return bindings;
}

/** A binding findBindingRanges found: the value's offsets in the body. */
export interface BindingRange {
  name: string;
  from: number;
  end: number;
  /** A name in a destructuring pattern: the value holds it somewhere. */
  destructured?: true;
  /** A destructuring assignment to a `let` or `var` (`[body] = [v]`), not a declaration. */
  assigned?: true;
}

/**
 * How far a type annotation or a destructuring pattern is read. Past it
 * the declaration is not followed, so a run of unclosed annotations
 * cannot make the scan quadratic.
 */
const MAX_DECLARATION_HEAD = 2_000;

/**
 * From just after a declared name or pattern: the offset just past the
 * `=` that starts its value (a TypeScript annotation skipped), "none" for
 * a declaration with no value (`let out: string;`), or undefined (`for
 * (const x of xs)`, or past MAX_DECLARATION_HEAD).
 */
function declarationValueStart(
  body: string,
  at: number,
): number | "none" | undefined {
  let i = at;
  while (i < body.length && /\s/.test(body[i])) i++;
  if (body[i] === "=" && body[i + 1] !== "=" && body[i + 1] !== ">")
    return i + 1;
  if (body[i] === ";" || body[i] === "," || i >= body.length) return "none";
  if (body[i] !== ":") {
    // A newline ends a declaration with no value (`let out\n`).
    return /\n/.test(body.slice(at, i)) ? "none" : undefined;
  }
  let depth = 0;
  let last = ":";
  const limit = Math.min(body.length, i + MAX_DECLARATION_HEAD);
  for (i++; i < limit; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      i = stringEnd(body, i) - 1;
      last = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth < 0) return undefined;
    } else if (c === ">") {
      if (depth > 0) depth--;
    } else if (c === "=") {
      if (body[i + 1] === ">") {
        i++;
        last = ">";
        continue;
      }
      if (body[i + 1] === "=") return undefined;
      if (depth === 0) return i + 1;
    } else if (depth === 0 && (c === ";" || c === ",")) return "none";
    else if (depth === 0 && c === "\n") {
      // Prettier wraps a long union after the colon or before a `|`.
      let k = i + 1;
      while (k < body.length && /\s/.test(body[k])) k++;
      if (!/[:|&]/.test(last) && !/[|&=]/.test(body[k] ?? "")) return "none";
    }
    if (!/\s/.test(c)) last = c;
  }
  return undefined;
}

/**
 * The names a destructuring pattern starting at `open` (`{` or `[`)
 * declares, and the offset past its closing bracket; undefined when it
 * does not close within MAX_DECLARATION_HEAD. Property keys (`{ a: b }`
 * declares b) are left out; a name in a default value is kept, which
 * only makes the fix more careful.
 */
function patternNames(
  body: string,
  open: number,
): { names: string[]; end: number } | undefined {
  let depth = 0;
  const limit = Math.min(body.length, open + MAX_DECLARATION_HEAD);
  for (let i = open; i < limit; i++) {
    const c = body[i];
    if (c === '"' || c === "'") i = stringEnd(body, i) - 1;
    else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      if (--depth === 0) {
        const pattern = body.slice(open, i + 1);
        const names: string[] = [];
        for (const m of pattern.matchAll(
          /(?<![\w$.'"])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*:)/g,
        ))
          names.push(m[1]);
        return { names, end: i + 1 };
      }
    }
  }
  return undefined;
}

/** The bindings findBindings reads, each with its value's offsets, in no set order. */
export function findBindingRanges(body: string): BindingRange[] {
  const found: {
    name: string;
    from: number;
    destructured?: true;
    assigned?: true;
  }[] = [];
  const reassignable = new Set<string>();
  for (const m of body.matchAll(/(?<![\w$.])(const|let|var)\s+/g)) {
    const at = (m.index ?? 0) + m[0].length;
    let names: string[];
    let after: number;
    let destructured = false;
    const name = /^[A-Za-z_$][\w$]*/.exec(body.slice(at, at + 256));
    if (name) {
      names = [name[0]];
      after = at + name[0].length;
    } else if (body[at] === "{" || body[at] === "[") {
      const pattern = patternNames(body, at);
      if (!pattern) continue;
      names = pattern.names;
      after = pattern.end;
      destructured = true;
    } else continue;
    const start = declarationValueStart(body, after);
    if (start === undefined) continue;
    if (m[1] !== "const") for (const n of names) reassignable.add(n);
    if (start === "none") continue;
    let from = start;
    while (from < body.length && /[ \t\r\n]/.test(body[from])) from++;
    for (const n of names)
      found.push(
        destructured ? { name: n, from, destructured } : { name: n, from },
      );
  }
  if (reassignable.size > 0)
    // Plain assignments: not after `.` (a property) or a declaration keyword
    // (counted above); `-=`, `*=` and the like always store a number.
    for (const m of body.matchAll(
      /(?<![\w$.])([\w$]+)\s*(?:\+|\|\||\?\?|&&)?=(?![=>])\s*/g,
    )) {
      if (!reassignable.has(m[1])) continue;
      const before = body.slice(Math.max(0, (m.index ?? 0) - 6), m.index);
      if (/\b(?:const|let|var)\s+$/.test(before)) continue;
      found.push({ name: m[1], from: (m.index ?? 0) + m[0].length });
    }
  if (reassignable.size > 0)
    for (const { names, from } of patternAssignments(body))
      for (const name of names)
        if (reassignable.has(name))
          found.push({ name, from, destructured: true, assigned: true });
  const ends = valueEnds(
    body,
    [...new Set(found.map((f) => f.from))].sort((x, y) => x - y),
  );
  const ranges: BindingRange[] = [];
  for (const { name, from, destructured, assigned } of found) {
    const end = ends.get(from);
    // Inside a string, comment or template text: not code.
    if (end === undefined) continue;
    ranges.push(
      assigned
        ? { name, from, end, destructured: true, assigned }
        : destructured
          ? { name, from, end, destructured }
          : { name, from, end },
    );
  }
  return ranges;
}

/**
 * Destructuring assignments (`[a, b] = [b, a]`, `({ body } = o)`): the
 * names in each pattern and where the assigned value starts. A pattern
 * after `const`, `let` or `var` is a declaration, and `x[i] = v` an
 * index, so neither counts. One pass over the tokens.
 */
function patternAssignments(body: string): { names: string[]; from: number }[] {
  const { tokens } = scanJavaScript(body);
  const n = tokens.length;
  const punct = (k: number, v: string): boolean =>
    k >= 0 &&
    k < n &&
    tokens[k].type === "punctuation" &&
    tokens[k].value === v;
  const partner = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < n; k++) {
    const v = tokens[k].type === "punctuation" ? tokens[k].value : "";
    if (v === "(" || v === "[" || v === "{") stack.push(k);
    else if ((v === ")" || v === "]" || v === "}") && stack.length > 0)
      partner[k] = stack.pop()!;
  }
  const out: { names: string[]; from: number }[] = [];
  for (let k = 1; k < n; k++) {
    if (!punct(k, "=") || punct(k + 1, "=") || punct(k + 1, ">")) continue;
    if (!punct(k - 1, "]") && !punct(k - 1, "}")) continue;
    if (
      tokens[k].start !== tokens[k - 1].end &&
      /\S/.test(body.slice(tokens[k - 1].end, tokens[k].start))
    )
      continue;
    const open = partner[k - 1];
    if (open === -1) continue;
    const before = open > 0 ? tokens[open - 1] : undefined;
    if (
      before?.type === "identifier" &&
      /^(?:const|let|var)$/.test(before.value)
    )
      continue;
    // x[i] = v, f()[0] = v and "s"[0] = v are indexes; `) {...} =` is no pattern.
    if (
      before !== undefined &&
      (before.type === "string" ||
        (before.type === "identifier" &&
          !/^(?:return|typeof|void|in|of|case|await|yield|delete)$/.test(
            before.value,
          )) ||
        punct(open - 1, ")") ||
        punct(open - 1, "]"))
    )
      continue;
    const names: string[] = [];
    for (let q = open + 1; q < k - 1; q++)
      if (
        tokens[q].type === "identifier" &&
        !punct(q - 1, ".") &&
        !punct(q + 1, ":")
      )
        names.push(tokens[q].value);
    let from = tokens[k].end;
    while (from < body.length && /[ \t\r\n]/.test(body[from])) from++;
    out.push({ names, from });
  }
  return out;
}

/**
 * The end of the value that starts at each offset in `starts` (ascending):
 * the first `;`, `,` or newline at the value's own bracket depth, or the
 * closing bracket of the one it is in, or the end of the body. One pass
 * over the code: strings, comments, regex literals and template text are
 * skipped (a value that starts inside one gets no end), and a template's
 * holes are code one level deeper. Values still open are kept on a stack,
 * shallowest first, so each one is closed once.
 */
function valueEnds(body: string, starts: number[]): Map<number, number> {
  const ends = new Map<number, number>();
  const open: { from: number; depth: number }[] = [];
  let next = 0;
  let depth = 0;
  /** "t" in a template's text, "h" in a hole's code; empty at the top level. */
  const modes: ("t" | "h")[] = [];
  /** The depth each open hole's code starts at. */
  const holeDepths: number[] = [];
  let regexOk = true;
  let before = "";
  const close = (atDepth: number, at: number): void => {
    while (open.length > 0 && open[open.length - 1].depth >= atDepth)
      ends.set(open.pop()!.from, at);
  };
  /** Drops starts before `to` that no code reaches (inside a skipped token). */
  const skip = (to: number): void => {
    while (next < starts.length && starts[next] < to) next++;
  };
  let i = 0;
  while (i < body.length) {
    if (modes[modes.length - 1] === "t") {
      skip(i + 1);
      const c = body[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        modes.pop();
        depth--;
        regexOk = false;
        before = c;
        i++;
      } else if (c === "$" && body[i + 1] === "{") {
        modes.push("h");
        depth++;
        holeDepths.push(depth);
        regexOk = true;
        before = "{";
        i += 2;
      } else i++;
      continue;
    }
    skip(i);
    while (next < starts.length && starts[next] === i)
      open.push({ from: starts[next++], depth });
    const c = body[i];
    if (c === "'" || c === '"') {
      i = Math.min(stringEnd(body, i), body.length);
      skip(i);
      regexOk = false;
      before = c;
    } else if (c === "/" && body[i + 1] === "/") {
      const newline = body.indexOf("\n", i);
      i = newline === -1 ? body.length : newline;
      skip(i);
    } else if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      i = end === -1 ? body.length : end + 2;
      skip(i);
    } else if (c === "/" && regexOk) {
      i = skipRegexLiteral(body, i);
      skip(i);
      regexOk = false;
      before = "/";
    } else if (c === "`") {
      modes.push("t");
      depth++;
      i++;
    } else if (/[\w$]/.test(c)) {
      const wordStart = i;
      while (i < body.length && /[\w$]/.test(body[i])) i++;
      regexOk =
        before !== "." && REGEX_AFTER_KEYWORD.has(body.slice(wordStart, i));
      before = "w";
    } else {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        close(depth, i);
        if (
          c === "}" &&
          modes.length > 0 &&
          depth === holeDepths[holeDepths.length - 1]
        ) {
          // The `}` that closes a hole: back to the template's text.
          modes.pop();
          holeDepths.pop();
        }
        depth--;
      } else if (c === ";" || c === "\n" || c === ",") close(depth, i);
      if (!/\s/.test(c)) {
        regexOk = OPERAND_FOLLOWS.has(c);
        before = c;
      }
      i++;
    }
  }
  close(-Infinity, body.length);
  return ends;
}

const stringEnd = (text: string, i: number): number => {
  const quote = text[i];
  i++;
  while (i < text.length && text[i] !== quote && text[i] !== "\n") {
    if (text[i] === "\\") i++;
    i++;
  }
  return i + 1;
};

const templateEnd = (text: string, i: number): number => {
  i++;
  while (i < text.length && text[i] !== "`") {
    if (text[i] === "\\") i++;
    else if (text[i] === "$" && text[i + 1] === "{") {
      const close = matchingClose(text, i + 1);
      if (close === -1) return text.length;
      i = close;
    }
    i++;
  }
  return i + 1;
};

const stripParens = (e: string): string => {
  while (e.startsWith("(") && matchingClose(e, 0) === e.length - 1)
    e = e.slice(1, -1).trim();
  return e;
};

/** Whether `e` is exactly one call of a trusted function (`esc(q)`, `b.esc(q)`). */
const isTrustedCall = (e: string, ctx: ExemptContext): boolean => {
  const m = /^([\w$]+(?:\.[\w$]+)*)\s*\(/.exec(e);
  if (!m) return false;
  const name = m[1];
  const trusted =
    (htmlExportOf(name, ctx.imports) !== undefined &&
      htmlExportOf(name, ctx.imports) !== "html") ||
    ctx.escapeFunctions.includes(name);
  return trusted && matchingClose(e, m[0].length - 1) === e.length - 1;
};

/** The callee of a call to `name` (local) that spans the whole expression. */
export const callOf = (expr: string): string | undefined => {
  const e = expr.trim();
  const m = /^([\w$]+(?:\.[\w$]+)*)\s*\(/.exec(e);
  if (!m) return undefined;
  return matchingClose(e, m[0].length - 1) === e.length - 1 ? m[1] : undefined;
};

/**
 * What `test` says of `expr` (a label, such as the callee of `json(x)`), or,
 * when `expr` is a name, of every value bound to it, followed through
 * aliases (`const body = json(x)`, `const b = body`): the label of the first
 * value when every one passes, so a `let` reassigned to anything else is not
 * followed. `question` names the test, so each name is read once per script
 * and question. Undefined when the expression, or any value, fails.
 */
export function boundTo(
  expr: string,
  ctx: ExemptContext,
  question: string,
  test: (e: string) => string | undefined,
  seen: Set<string> = new Set(),
): string | undefined {
  const e = stripParens(expr.trim());
  if (!/^[\w$]+$/.test(e)) return test(e);
  const bound = ctx.bindings.get(e);
  if (!bound) return undefined;
  ctx.memo ??= newNameMemo();
  let entry = ctx.memo.bound.get(question);
  if (entry === undefined) {
    entry = { verdicts: new Map(), labels: new Map() };
    ctx.memo.bound.set(question, entry);
  }
  const { labels } = entry;
  let first: string | undefined;
  const fine = nameVerdict(
    e,
    bound,
    ctx.memo,
    entry.verdicts,
    seen,
    (value) => {
      const label = boundTo(value, ctx, question, test, seen);
      first ??= label;
      return label !== undefined;
    },
  );
  if (!fine) return undefined;
  if (first !== undefined) labels.set(e, first);
  return labels.get(e);
}

/**
 * Whether a hole's expression cannot carry markup a visitor controls:
 * literals, numbers, calls to html/raw/esc/safeUrl/json (or a listed
 * escaper), nested html, conditionals of those, and names bound to them.
 */
export function isExempt(
  expr: string,
  ctx: ExemptContext,
  seen: Set<string> = new Set(),
): boolean {
  const e = stripParens(expr.trim());
  if (e === "") return true;
  if (LITERAL.test(e) || HOLE_FREE_TEMPLATE.test(e)) return true;
  // Numbers: .length/.size, a whole Number()/parseInt()/parseFloat()/Math.*()
  // call, a lone toFixed() call. Arithmetic is handled after || ?? && and ?:.
  if (/^[\w$.[\]]+\.(?:length|size)$/.test(e)) return true;
  const callee = callOf(e);
  if (
    callee !== undefined &&
    /^(?:Number|parseInt|parseFloat|Math\.\w+)$/.test(callee)
  )
    return true;
  if (/^[\w$.[\]]+\.toFixed\s*\([^()]*\)$/.test(e)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(e)) return true;
  if (isTrustedCall(e, ctx)) return true;
  for (const tag of ctx.htmlTags) {
    if (e.startsWith(`${tag}\``)) return true;
    // A callback that returns html (items.map((i) => html`...`)).
    if (new RegExp(`=>\\s*${escapeRegExp(tag)}\``).test(e)) return true;
  }
  if (/^[\w$]+$/.test(e)) {
    const bound = ctx.bindings.get(e);
    if (!bound) return false;
    ctx.memo ??= newNameMemo();
    return nameVerdict(e, bound, ctx.memo, ctx.memo.exempt, seen, (value) =>
      isExempt(value, ctx, seen),
    );
  }
  // cond ? a : b (only the rendered branches matter).
  let question = -1;
  topLevel(e, (i) => {
    if (
      e[i] === "?" &&
      e[i + 1] !== "?" &&
      e[i + 1] !== "." &&
      e[i - 1] !== "?"
    ) {
      question = i;
      return true;
    }
  });
  if (question !== -1) {
    let nested = 0;
    let colon = -1;
    topLevel(e.slice(question + 1), (i) => {
      const c = e[question + 1 + i];
      const next = e[question + 2 + i];
      if (c === "?" && next !== "?" && next !== ".") nested++;
      else if (c === ":") {
        if (nested === 0) {
          colon = question + 1 + i;
          return true;
        }
        nested--;
      }
    });
    if (colon !== -1)
      return (
        isExempt(e.slice(question + 1, colon), ctx, seen) &&
        isExempt(e.slice(colon + 1), ctx, seen)
      );
  }
  // a || b, a ?? b (both may render), a && b (b renders, or a falsy value).
  let split: { at: number; op: string } | undefined;
  topLevel(e, (i) => {
    const two = e.slice(i, i + 2);
    if (two === "||" || two === "??") {
      split = { at: i, op: two };
      return true;
    }
  });
  if (!split)
    topLevel(e, (i) => {
      if (e.slice(i, i + 2) === "&&") {
        split = { at: i, op: "&&" };
        return true;
      }
    });
  if (split) {
    const left = e.slice(0, split.at);
    const right = e.slice(split.at + 2);
    return split.op === "&&"
      ? isExempt(right, ctx, seen)
      : isExempt(left, ctx, seen) && isExempt(right, ctx, seen);
  }
  return isArithmeticExempt(e, ctx, seen);
}

const NUMBER_LITERAL = /^(?:\d[\d_]*\.?\d*(?:e[+-]?\d+)?|0x[\da-f]+)n?$/i;
const NAME_OR_MEMBER = /^[\w$]+(?:\??\.[\w$]+|\[[\w$]+\])*$/;

/**
 * Arithmetic. `-`, `*`, `/`, `%` and unary `+`/`-` always make a number,
 * but binary `+` joins strings, so a `+` chain is exempt only when every
 * operand is (`count + 1`, `"Hi " + esc(q)`). One lenience keeps loop
 * counters quiet: `i + 1` (names or members plus a number literal, with no
 * string operand) is exempt unless a name is bound to a value that is not.
 */
function isArithmeticExempt(
  e: string,
  ctx: ExemptContext,
  seen: Set<string>,
): boolean {
  const plus: number[] = [];
  let other = false;
  let disqualified = false;
  topLevel(e, (i) => {
    const c = e[i];
    if (c === "+" || c === "-") {
      // ++ and -- are part of their operand.
      if (e[i + 1] === c || e[i - 1] === c) return;
      let k = i - 1;
      while (k >= 0 && /\s/.test(e[k])) k--;
      const unary = k < 0 || /[-+*/%=<>!&|?:,~^]/.test(e[k]);
      if (unary) return;
      if (c === "+") plus.push(i);
      else other = true;
    } else if (c === "*" || c === "/" || c === "%") other = true;
    else if (c === "?" && e[i + 1] === ".") return;
    else if (/[=<>!&|?:,^~]/.test(c)) disqualified = true;
  });
  if (disqualified) return false;
  if (plus.length === 0) {
    const unaryNumber = /^[-+]\s*[^-+]/.test(e);
    if (!other && !unaryNumber) return false;
    // Every operand of - * / % (or a unary sign) is a number, whatever it is.
    return true;
  }
  const operands: string[] = [];
  let from = 0;
  for (const at of plus) {
    operands.push(e.slice(from, at).trim());
    from = at + 1;
  }
  operands.push(e.slice(from).trim());
  // Each operand gets its own copy of `seen`: `n + n` reads n twice.
  const exempt = operands.map((o) => isExempt(o, ctx, new Set(seen)));
  if (exempt.every(Boolean)) return true;
  // i + 1: names and a number literal, no string, no call.
  if (!operands.some((o) => NUMBER_LITERAL.test(stripParens(o)))) return false;
  return operands.every((o, i) => {
    const op = stripParens(o);
    if (exempt[i]) return true;
    if (!NAME_OR_MEMBER.test(op)) return false;
    const root = /^[\w$]+/.exec(op)![0];
    return !ctx.bindings.has(root);
  });
}

/**
 * A tag whose name is a hole: `<${tag} class="...">`, or `<${tag}>` with
 * an end tag `</${tag}>` in the same template. A lone `<${tag}>` is how a
 * message names an element (`<${tag}> needs a src attribute`), and a hole
 * after `<` followed by neither is a comparison or a regex source.
 */
const holeNamesTag = (
  parts: readonly string[],
  skipCodeSpans = false,
): boolean => {
  const last = parts.length - 1;
  let startThenClose = false;
  let endTag = false;
  for (let p = 0; p < last; p++) {
    const part = parts[p];
    const next = parts[p + 1];
    // In a Markdown code span (`` `<${tag} class="..."> ``), as a fixed tag
    // right after a backtick is.
    if (skipCodeSpans && /`<\/?$/.test(part)) continue;
    if (part.endsWith("</")) {
      if (/^\s*>/.test(next)) endTag = true;
    } else if (!part.endsWith("<")) continue;
    else if (HOLE_THEN_ATTRIBUTE.test(next)) return true;
    else if (/^\s*>/.test(next)) startThenClose = true;
  }
  return startThenClose && endTag;
};

/** Static text that looks like markup: a start or end tag. */
export const looksLikeMarkup = (parts: readonly string[]): boolean =>
  parts.some((part) => /<\/?[a-zA-Z][\w:-]*(?=[\s/>]|$)/.test(part)) ||
  holeNamesTag(parts);

/**
 * Elements whose bare start tag (`<li>`, no attribute) counts as markup in
 * build-time code: names that are not also CLI placeholders, TypeScript
 * type names or words a message names elements by (`<path>`, `<output>`,
 * `<title>`, `<img>`, `<script>`, `<template>` all are).
 */
const BARE_MARKUP_ELEMENTS = new Set(
  "article aside blockquote br dd div dl dt em figcaption h1 h2 h3 h4 h5 h6 hr li nav ol p span strong tbody td tfoot th thead tr ul wbr".split(
    " ",
  ),
);

/**
 * A tag in build-time text: group 1 is `/` for an end tag, group 2 the
 * name, group 3 the first attribute when it is written as one (`name="`,
 * `name='`, `name=value`, `name=` before a hole, or a lone `name>`), and
 * group 4 the `>` of a bare start tag. Names start with a lower-case
 * letter, as HTML, SVG and custom element names do in practice, so
 * `Array<Path>` is no tag.
 */
const CODE_TAG =
  /<(\/?)([a-z][\w:-]*)(?:(\s+[a-zA-Z_:@][-\w:.@]*(?:=(?:["']|[^\s"'=<>`]|$)|\s*\/?>))|\s*\/?(>))?/g;

/** After a hole inside a start tag: the rest of the name, then `=` or an attribute. */
const HOLE_THEN_ATTRIBUTE =
  /^[-\w:.@]*(?:=|\s+[a-zA-Z_:@][-\w:.@]*(?:=|\s*\/?>))/;

/**
 * Static text that looks like markup in build-time code, which also holds
 * CLI text (`tool <command> --out <output>`), prose that names elements
 * (`<img> needs alt text`), Markdown code spans (`` `<nav>` ``), SQL
 * (`a<b AND id = 1`) and generated TypeScript (`Array<Path>`). It needs an
 * end tag (`</li>`), a start tag with an attribute
 * (`<product-card title="...">`, `<details open>`), or a bare start tag of
 * an element in BARE_MARKUP_ELEMENTS (`<li>`), or a tag a hole continues
 * with an attribute or an end tag's `>` after the hole (`<h${level} id=`,
 * `<meta ${attr}="...">`, `</h${level}>`). A tag right after a
 * backtick is in a Markdown code span and does not count. One pass per part.
 */
export const markupInCode = (source: readonly string[]): boolean => {
  const { parts } = markdownFences(source);
  return (
    holeNamesTag(parts, true) ||
    parts.some((part, p) => {
      for (const m of part.matchAll(CODE_TAG)) {
        if (m.index > 0 && part[m.index - 1] === "`") continue;
        if (m[3] !== undefined && m[1] !== "/") return true;
        if (m[4] !== undefined) {
          if (m[1] === "/") return true;
          // A bare start tag counts where markup goes: at the start of the
          // template or right after a hole, or after another tag. After a
          // word it is prose that names the element (`Found <p> inside`).
          if (BARE_MARKUP_ELEMENTS.has(m[2]) && afterTagOrStart(part, m.index))
            return true;
          continue;
        }
        // A tag that a hole continues, with an attribute or an end tag's `>`
        // after the hole: `<h${level} id="`, `<meta ${attr}="`, `</h${level}>`.
        // A bare `<h${n}>` is how a message names a heading level.
        if (
          p < parts.length - 1 &&
          /^\s*$/.test(part.slice(m.index + m[0].length)) &&
          (m[1] === "/" ? /^\s*>/ : HOLE_THEN_ATTRIBUTE).test(parts[p + 1])
        )
          return true;
      }
      return false;
    })
  );
};

/** A Markdown fence line's start, as template source writes it: \`\`\` or ~~~. */
const FENCE = /^[ \t]*(?:\\`\\`\\`|```|~~~)/;

/** A template's parts with its Markdown fenced blocks blanked. */
export interface MarkdownFences {
  /** The parts, each fenced line blanked (holes stay where they are). */
  parts: readonly string[];
  /** The holes (1-based) inside a fenced block. */
  fencedHoles: ReadonlySet<number>;
  /** Whether the template has a fence line at all. */
  hasFence: boolean;
}

const NO_FENCED_HOLES: ReadonlySet<number> = new Set();

/**
 * Blanks each Markdown fenced block: from a line that starts with three
 * backticks (written \`\`\` in a template) or three tildes, through the
 * line that closes it. A fence that never closes opens no block: a stray
 * \`\`\` would otherwise hide every real markup hole after it. Code in a fence is text the
 * Markdown renderer escapes, not markup. A line ends at a newline or a
 * `\n` escape. One pass.
 */
export const markdownFences = (parts: readonly string[]): MarkdownFences => {
  if (!parts.some((part) => part.includes("`\\`") || part.includes("~~~")))
    return { parts, fencedHoles: NO_FENCED_HOLES, hasFence: false };
  const text = parts.join(HOLE_CHAR);
  // Lines, as [end, next]; a fence that never closes opens no block, so
  // the markup after it is still read as markup.
  const lines: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lines.push([i, i + 1]);
    else if (text[i] === "\\") {
      if (text[i + 1] === "n") lines.push([i, i + 2]);
      i++;
    }
  }
  lines.push([text.length, text.length]);
  let unclosed = -1;
  let open = false;
  let sawFence = false;
  for (let l = 0, start = 0; l < lines.length; start = lines[l][1], l++)
    if (FENCE.test(text.slice(start, lines[l][0]))) {
      sawFence = true;
      open = !open;
      if (open) unclosed = start;
    }
  if (!open) unclosed = -1;
  let out = "";
  let inFence = false;
  let hasFence = sawFence;
  let lineStart = 0;
  let holesBefore = 0;
  const fencedHoles = new Set<number>();
  const endLine = (end: number, next: number): void => {
    const line = text.slice(lineStart, end);
    const fence = lineStart !== unclosed && FENCE.test(line);
    if (inFence || fence) {
      hasFence = true;
      out += line.replace(/[^\u0000]/g, " ") + text.slice(end, next);
      for (
        let k = line.indexOf(HOLE_CHAR);
        k !== -1;
        k = line.indexOf(HOLE_CHAR, k + 1)
      )
        fencedHoles.add(++holesBefore);
      if (fence) inFence = !inFence;
    } else {
      out += text.slice(lineStart, next);
      for (
        let k = line.indexOf(HOLE_CHAR);
        k !== -1;
        k = line.indexOf(HOLE_CHAR, k + 1)
      )
        holesBefore++;
    }
    lineStart = next;
  };
  for (const [end, next] of lines) endLine(end, next);
  return { parts: out.split(HOLE_CHAR), fencedHoles, hasFence };
};

/** Whether only whitespace, or a tag's `>` then whitespace, comes before `at` in `part`. */
const afterTagOrStart = (part: string, at: number): boolean => {
  let k = at - 1;
  while (k >= 0 && /\s/.test(part[k])) k--;
  return k < 0 || part[k] === ">";
};

/** `<` written as \u003c in a replacement: `.replace(/</g, "\\u003c")`. */
const LT_TO_U003C =
  /^\s*(?:\/<\/[a-z]*|(["'`])<\1)\s*,\s*(["'`])\\\\u003c\2\s*$/i;

/**
 * Whether a hole is JSON.stringify(...) followed by .replace()/.replaceAll()
 * calls, one of which writes `<` as \u003c (or a name bound only to such
 * values). In a <script type="application/ld+json"> that value can never
 * close the script, so it is not a sink.
 */
export function isEscapedJson(
  expr: string,
  ctx: ExemptContext,
  seen: Set<string> = new Set(),
): boolean {
  const e = stripParens(expr.trim());
  if (/^[\w$]+$/.test(e)) {
    const bound = ctx.bindings.get(e);
    if (!bound) return false;
    ctx.memo ??= newNameMemo();
    return nameVerdict(
      e,
      bound,
      ctx.memo,
      ctx.memo.escapedJson,
      seen,
      (value) => isEscapedJson(value, ctx, seen),
    );
  }
  const head = /^JSON\.stringify\s*\(/.exec(e);
  if (!head) return false;
  let i = matchingClose(e, head[0].length - 1);
  if (i === -1) return false;
  i++;
  let escaped = false;
  while (i < e.length) {
    const call = /^\s*\??\.\s*replace(?:All)?\s*\(/.exec(e.slice(i));
    if (!call) return false;
    const open = i + call[0].length - 1;
    const close = matchingClose(e, open);
    if (close === -1) return false;
    if (LT_TO_U003C.test(e.slice(open + 1, close))) escaped = true;
    i = close + 1;
  }
  return escaped;
}

/**
 * Whether a literal is a message, not markup: the direct argument of
 * console.*(), new *Error() or throw, or the value of a `message`, `error`,
 * `reason` or `warning` property. `super(...)` in a class that extends an
 * Error is checked by the caller, which knows the class.
 */
export const isMessageArgument = (source: string, start: number): boolean => {
  const before = source.slice(Math.max(0, start - 80), start);
  return (
    /\bthrow\s*$/.test(before) ||
    /\b(?:console\.[a-zA-Z]+|new\s+[\w$.]*Error)\s*\(\s*$/.test(before) ||
    /(?:^|[{,\s])(?:message|error|reason|warning)\s*:\s*$/.test(before)
  );
};

/**
 * Whether a literal is a pattern that searches text rather than markup
 * the code writes: the needle of .includes(), .indexOf(), .lastIndexOf(),
 * .startsWith(), .endsWith(), .split(), .search(), .match() or
 * .matchAll(), the first argument of .replace() or .replaceAll(), or the
 * source of RegExp(). Wrapping it in html would change what it matches.
 */
export const isPatternArgument = (source: string, start: number): boolean =>
  /(?:\.\s*(?:includes|indexOf|lastIndexOf|startsWith|endsWith|split|search|match|matchAll|replace|replaceAll)|\bRegExp)\s*\(\s*(?:String\.raw\s*)?$/.test(
    source.slice(Math.max(0, start - 80), start),
  );

// ─── Where each hole lands, and where html would throw ─────────────────────

const enum T {
  Data,
  TagOpen,
  EndTagOpen,
  TagName,
  BeforeAttrName,
  AttrName,
  AfterAttrName,
  BeforeAttrValue,
  ValueDq,
  ValueSq,
  ValueUq,
  AfterValueQuoted,
  SelfClosing,
  Comment,
  Bogus,
  RawText,
}

/** Where a template hole lands in the markup its static parts build. */
export type HoleContext =
  /** Text. `sawTag` is false while the template has not opened a tag yet (a fragment such as ` href="${u}"`). */
  | { kind: "text"; sawTag: boolean }
  /**
   * The body of a raw-text element (script, style, textarea, title).
   * `jsonScript`: a <script type="application/json"> or
   * "application/ld+json" with only whitespace before the hole.
   */
  | { kind: "raw"; tag: string; jsonScript: boolean }
  /** A quoted attribute value. `attr` is lower case; it holds U+0000 where a hole made part of the name. */
  | { kind: "value"; tag: string; attr: string }
  /** An unquoted attribute value. */
  | { kind: "unquoted"; tag: string; attr: string }
  /** A tag name, where an attribute name goes, or inside a <!...> declaration. */
  | { kind: "name" }
  /** Inside a <!-- --> comment. */
  | { kind: "comment" };

export interface TemplateHtml {
  /** One per hole, in order. */
  holes: HoleContext[];
  /**
   * Where html`...` would throw: the 1-based number of the first hole it
   * throws on, 0 when only the end does (the template stops inside a tag,
   * comment, quoted value or raw-text element), or -1 when it would not.
   */
  throwsAt: number;
}

const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const SVG_ANIMATION_TAGS = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "animatecolor",
  "set",
]);

// ─── html's URL scheme rule (pkg/src/lib/url-safety.ts, html-template.ts) ──

/** Attribute names whose whole value is one URL (url-safety.ts URL_TARGETS). */
const URL_TARGETS = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "codebase",
  "longdesc",
  "lowsrc",
  "dynsrc",
  "manifest",
  "icon",
]);
const IMAGE_TARGETS = new Set([
  "img src",
  "img srcset",
  "source srcset",
  "video poster",
  "input src",
  "link imagesrcset",
]);
const SCRIPT_SCHEMES = new Set([
  "javascript",
  "vbscript",
  "livescript",
  "mocha",
  "data",
]);
type UrlSlot = "url" | "srcset" | "ping" | "animation";
const LIST_BOUNDARY: Readonly<Record<Exclude<UrlSlot, "url">, RegExp>> = {
  srcset: /[\t\n\f\r ,]/,
  ping: /[\t\n\f\r ]/,
  animation: /;/,
};

/** Which kind of URL `<tag attr>` holds, as html reads it, or null. */
const urlSlotOf = (tag: string, attr: string): UrlSlot | null => {
  if (URL_TARGETS.has(attr) || (tag === "object" && attr === "data"))
    return "url";
  if (attr === "srcset" || attr === "imagesrcset") return "srcset";
  if (attr === "ping") return "ping";
  if (
    SVG_ANIMATION_TAGS.has(tag) &&
    (attr === "to" || attr === "from" || attr === "by" || attr === "values")
  )
    return "animation";
  return null;
};

/** A URL as the URL parser reads it: outer C0 controls and spaces dropped, tabs and newlines removed. */
const normalizeUrl = (url: string): string => {
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  return url.slice(start, end).replace(/[\t\n\r]/g, "");
};

/** How the text before a URL hole settles its scheme (html's prefixVerdict). */
const prefixVerdict = (
  prefix: string,
  image: boolean,
): "start" | "settled" | "refused" => {
  const text = normalizeUrl(prefix);
  if (text === "") return "start";
  const match = /[/?#:&]/.exec(text);
  if (match === null || match[0] === "&") return "refused";
  if (match[0] !== ":") return "settled";
  const scheme = text.slice(0, match.index);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) return "settled";
  if (!SCRIPT_SCHEMES.has(scheme.toLowerCase())) return "settled";
  return image && /^data:image\/[a-z0-9.+-]+[;,]/i.test(text)
    ? "settled"
    : "refused";
};

/**
 * The 1-based number of the first hole html refuses in a URL attribute
 * value, from its static text and hole numbers in order, or -1. A list
 * (srcset, ping, SVG animation values) is read entry by entry; one URL
 * whose first hole starts it must reach a /, ? or # before a : or & or a
 * second hole, or end there.
 */
const urlRefusal = (
  slot: UrlSlot,
  image: boolean,
  parts: readonly (string | number)[],
): number => {
  if (slot !== "url") {
    // Each entry's verdict is read once it is settled, and a blank entry
    // (spaces, controls, holes) starts its URL, so this stays linear in
    // the value however many holes it has.
    const boundary = LIST_BOUNDARY[slot];
    let token = "";
    let blank = true;
    let settled = false;
    for (const p of parts) {
      if (typeof p === "string") {
        for (const c of p)
          if (boundary.test(c)) {
            token = "";
            blank = true;
            settled = false;
          } else if (!settled) {
            token += c;
            if (c.charCodeAt(0) > 0x20) blank = false;
          }
        continue;
      }
      if (!blank && !settled) {
        if (prefixVerdict(token, image) === "refused") return p + 1;
        settled = true;
      }
      if (!settled) token += HOLE_CHAR;
    }
    return -1;
  }
  const first = parts.findIndex((p) => typeof p === "number");
  if (first === -1) return -1;
  const start = parts[first] as number;
  const verdict = prefixVerdict(parts.slice(0, first).join(""), image);
  if (verdict === "refused") return start + 1;
  if (verdict === "settled") return -1;
  let after = "";
  let index = first + 1;
  while (index < parts.length && typeof parts[index] === "string")
    after += parts[index++] as string;
  const match = /[/?#:&]/.exec(after);
  const settled = match !== null && match[0] !== ":" && match[0] !== "&";
  return settled || (index >= parts.length && match === null) ? -1 : start + 1;
};

const isAsciiAlpha = (c: string): boolean => /[a-zA-Z]/.test(c);
const isTagSpace = (c: string): boolean => /[\t\n\f\r ]/.test(c);
/** Stands for the text of a hole inside a tag or attribute name. */
const HOLE_CHAR = "\u0000";

/** Whether html`...` throws on a hole in this context. */
const throwsOn = (context: HoleContext): boolean => {
  switch (context.kind) {
    case "text":
      return false;
    case "raw":
      return context.tag === "script" || context.tag === "style";
    case "value":
      return (
        /^on/.test(context.attr) ||
        context.attr === "style" ||
        context.attr === "srcdoc" ||
        (context.tag === "meta" &&
          (context.attr === "http-equiv" || context.attr === "content")) ||
        SVG_ANIMATION_TAGS.has(context.tag)
      );
    default:
      return true;
  }
};

/**
 * Where each hole of a template lands, from its static parts, and where
 * html`...` would throw: a hole in a tag name, where an attribute name
 * goes, in an unquoted value, inside a comment or <!...> declaration,
 * inside a <script> or <style>, in an on*, style or srcdoc value, a <meta>
 * http-equiv or content value, any attribute of an SVG animation element,
 * a URL value that breaks html's scheme rule (see urlRefusal), or a
 * template that ends inside a tag, comment, quoted value or raw-text
 * element. A small version of html's own tokenizer that carries its state
 * across the holes, so the whole template is read once, however many holes
 * it has. A hole in a name position counts as part of that name, so the
 * text after it is read as html would read it.
 */
export function scanTemplateHtml(parts: readonly string[]): TemplateHtml {
  const holes: HoleContext[] = [];
  let throwsAt = -1;
  let state = T.Data;
  let tag = "";
  let isEnd = false;
  let attr = "";
  let rawTag = "";
  let sawTag = false;
  /** The current tag's type="..." value, for a JSON script. */
  let typeValue = "";
  let jsonScript = false;
  /** Only whitespace so far in the raw-text element. */
  let rawBlank = true;
  /**
   * The quoted value being read when it holds URLs (html's URL scheme
   * rule): its slot, and its static text and hole numbers so far.
   */
  let urlSlot: UrlSlot | null = null;
  let urlImage = false;
  let urlParts: (string | number)[] = [];
  let urlText = "";
  const endUrlValue = (): void => {
    if (urlSlot === null) return;
    urlParts.push(urlText);
    const refused = urlRefusal(urlSlot, urlImage, urlParts);
    if (refused !== -1 && (throwsAt === -1 || refused < throwsAt))
      throwsAt = refused;
    urlSlot = null;
    urlParts = [];
    urlText = "";
  };
  const startValue = (): void => {
    urlSlot = urlSlotOf(tag, attr);
    urlImage = IMAGE_TARGETS.has(`${tag} ${attr}`);
  };
  for (let p = 0; p < parts.length; p++) {
    const text = parts[p];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      switch (state) {
        case T.Data:
          if (c === "<") state = T.TagOpen;
          break;
        case T.TagOpen:
          if (isAsciiAlpha(c)) {
            state = T.TagName;
            tag = c.toLowerCase();
            isEnd = false;
            sawTag = true;
            typeValue = "";
          } else if (c === "/") state = T.EndTagOpen;
          else if (c === "!") {
            sawTag = true;
            if (text.startsWith("--", i + 1)) {
              state = T.Comment;
              i += 2;
            } else state = T.Bogus;
          } else if (c === "?") state = T.Bogus;
          else {
            state = T.Data;
            i--;
          }
          break;
        case T.EndTagOpen:
          if (isAsciiAlpha(c)) {
            state = T.TagName;
            tag = c.toLowerCase();
            isEnd = true;
            sawTag = true;
          } else if (c === ">") state = T.Data;
          else state = T.Bogus;
          break;
        case T.TagName:
        case T.BeforeAttrName:
        case T.AttrName:
        case T.AfterAttrName:
        case T.BeforeAttrValue:
        case T.ValueUq:
        case T.AfterValueQuoted:
        case T.SelfClosing:
          if (c === ">") {
            if (!isEnd && RAW_TEXT_TAGS.has(tag)) {
              state = T.RawText;
              rawTag = tag;
              rawBlank = true;
              jsonScript =
                tag === "script" &&
                /^application\/(?:ld\+)?json$/i.test(typeValue.trim());
            } else state = T.Data;
          } else if (state === T.TagName) {
            if (isTagSpace(c)) state = T.BeforeAttrName;
            else if (c === "/") state = T.SelfClosing;
            else tag += c.toLowerCase();
          } else if (state === T.BeforeAttrValue) {
            if (c === '"') {
              state = T.ValueDq;
              startValue();
            } else if (c === "'") {
              state = T.ValueSq;
              startValue();
            } else if (!isTagSpace(c)) {
              state = T.ValueUq;
              if (attr === "type") typeValue += c;
            }
          } else if (state === T.ValueUq) {
            if (isTagSpace(c)) state = T.BeforeAttrName;
            else if (attr === "type") typeValue += c;
          } else if (state === T.AttrName) {
            if (isTagSpace(c)) state = T.AfterAttrName;
            else if (c === "/") state = T.SelfClosing;
            else if (c === "=") state = T.BeforeAttrValue;
            else attr += c.toLowerCase();
          } else if (isTagSpace(c)) {
            if (state !== T.AfterAttrName) state = T.BeforeAttrName;
          } else if (c === "/") state = T.SelfClosing;
          else if (c === "=" && state === T.AfterAttrName)
            state = T.BeforeAttrValue;
          else {
            state = T.AttrName;
            attr = c.toLowerCase();
          }
          break;
        case T.ValueDq:
        case T.ValueSq:
          if (c === (state === T.ValueDq ? '"' : "'")) {
            state = T.AfterValueQuoted;
            endUrlValue();
          } else {
            if (attr === "type") typeValue += c;
            if (urlSlot !== null) urlText += c;
          }
          break;
        case T.Comment: {
          const close = text.indexOf("-->", i);
          if (close === -1) i = text.length;
          else {
            state = T.Data;
            i = close + 2;
          }
          break;
        }
        case T.Bogus:
          if (c === ">") state = T.Data;
          break;
        case T.RawText:
          if (
            c === "<" &&
            text[i + 1] === "/" &&
            text.slice(i + 2, i + 2 + rawTag.length).toLowerCase() === rawTag &&
            /^[\t\n\f\r />]/.test(text[i + 2 + rawTag.length] ?? "")
          ) {
            state = T.TagName;
            tag = rawTag;
            isEnd = true;
            i += 1 + rawTag.length;
          } else if (c === "\\" && /[ntrf]/.test(text[i + 1] ?? "")) {
            // `\n` in the template source is a newline in the value.
            i++;
          } else if (!isTagSpace(c)) rawBlank = false;
          break;
      }
    }
    if (p === parts.length - 1) break;
    // A hole after parts[p]: where it lands, then the state html reads on in.
    let context: HoleContext;
    switch (state) {
      case T.Data:
        context = { kind: "text", sawTag };
        break;
      case T.RawText:
        context = {
          kind: "raw",
          tag: rawTag,
          jsonScript: jsonScript && rawBlank,
        };
        rawBlank = false;
        break;
      case T.ValueDq:
      case T.ValueSq:
        context = { kind: "value", tag, attr };
        if (attr === "type") typeValue += HOLE_CHAR;
        if (urlSlot !== null) {
          urlParts.push(urlText, holes.length);
          urlText = "";
        }
        break;
      case T.BeforeAttrValue:
      case T.ValueUq:
        context = { kind: "unquoted", tag, attr };
        state = T.ValueUq;
        if (attr === "type") typeValue += HOLE_CHAR;
        break;
      case T.Comment:
        context = { kind: "comment" };
        break;
      case T.Bogus:
        context = { kind: "name" };
        break;
      case T.TagOpen:
      case T.EndTagOpen:
        // `<${tag}`: the hole is the tag name.
        context = { kind: "name" };
        isEnd = state === T.EndTagOpen;
        tag = HOLE_CHAR;
        sawTag = true;
        state = T.TagName;
        break;
      case T.TagName:
        context = { kind: "name" };
        tag += HOLE_CHAR;
        break;
      case T.AttrName:
        context = { kind: "name" };
        attr += HOLE_CHAR;
        break;
      default:
        // Where an attribute name goes: the hole starts one.
        context = { kind: "name" };
        attr = HOLE_CHAR;
        state = T.AttrName;
        break;
    }
    holes.push(context);
    if (throwsAt === -1 && throwsOn(context)) throwsAt = holes.length;
  }
  if (throwsAt === -1 && state !== T.Data) throwsAt = 0;
  return { holes, throwsAt };
}

/** Whether html`...` would throw for a template with these static parts (see scanTemplateHtml). */
export const htmlWouldThrow = (parts: readonly string[]): boolean =>
  scanTemplateHtml(parts).throwsAt !== -1;
