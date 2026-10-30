/**
 * Template literals in a server or stream script, for the sink rules and
 * server-script-unescaped-markup: every literal (nested ones inside a hole
 * too), its tag, its static parts and its holes, in one linear pass. Strings
 * and comments are skipped, so a backtick inside them is not a template.
 */

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

/** Every template literal in `source`, outer literals before the ones nested in their holes. */
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

  /** Scan code from `i`; with `inHole`, stop at the `}` that closes the hole. */
  const scanCode = (i: number, inHole: boolean): number => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === "'" || c === '"') i = skipString(i);
      else if (c === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i++;
      } else if (c === "/" && source[i + 1] === "*") {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? source.length : close + 2;
      } else if (c === "`") i = scanTemplate(i);
      else if (c === "{") {
        depth++;
        i++;
      } else if (c === "}") {
        if (depth === 0 && inHole) return i;
        if (depth > 0) depth--;
        i++;
      } else i++;
    }
    return i;
  };

  const scanTemplate = (start: number): number => {
    const literal: TemplateLiteral = {
      start,
      end: source.length,
      tag: tagBefore(source, start),
      parts: [],
      holes: [],
    };
    literals.push(literal);
    let i = start + 1;
    let partStart = i;
    while (i < source.length) {
      const c = source[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        literal.parts.push(source.slice(partStart, i));
        literal.end = i + 1;
        return i + 1;
      } else if (c === "$" && source[i + 1] === "{") {
        literal.parts.push(source.slice(partStart, i));
        const close = scanCode(i + 2, true);
        literal.holes.push({
          start: i,
          end: Math.min(close + 1, source.length),
          expr: source.slice(i + 2, close),
          index: literal.holes.length + 1,
        });
        i = close + 1;
        partStart = i;
      } else i++;
    }
    literal.parts.push(source.slice(partStart));
    return source.length;
  };

  scanCode(0, false);
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
}

/**
 * `const|let|var NAME = EXPR` bindings, each EXPR up to `;` or the line end
 * at depth 0. A let or var name also collects every later plain assignment
 * (`NAME = EXPR`, `NAME += EXPR`, `NAME ||= EXPR`, `NAME ??= EXPR`), so a
 * name reassigned from request data is not trusted from its declaration.
 */
export function findBindings(body: string): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  const valueAt = (from: number): string => {
    let depth = 0;
    let i = from;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === "'" || c === '"' || c === "`") {
        const close = c === "`" ? templateEnd(body, i) : stringEnd(body, i);
        i = close - 1;
      } else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === ";" || c === "\n" || c === ",")) break;
    }
    return body.slice(from, i);
  };
  const add = (name: string, value: string): void => {
    const list = bindings.get(name) ?? [];
    list.push(value);
    bindings.set(name, list);
  };
  const reassignable = new Set<string>();
  for (const m of body.matchAll(
    /\b(const|let|var)\s+([\w$]+)\s*=(?![=>])\s*/g,
  )) {
    add(m[2], valueAt((m.index ?? 0) + m[0].length));
    if (m[1] !== "const") reassignable.add(m[2]);
  }
  for (const m of body.matchAll(/\b(?:let|var)\s+([\w$]+)\s*[;,\n]/g))
    reassignable.add(m[1]);
  if (reassignable.size === 0) return bindings;
  // Plain assignments: not after `.` (a property) or a declaration keyword
  // (counted above); `-=`, `*=` and the like always store a number.
  for (const m of body.matchAll(
    /(?<![\w$.])([\w$]+)\s*(?:\+|\|\||\?\?|&&)?=(?![=>])\s*/g,
  )) {
    if (!reassignable.has(m[1])) continue;
    const before = body.slice(Math.max(0, (m.index ?? 0) - 6), m.index);
    if (/\b(?:const|let|var)\s+$/.test(before)) continue;
    add(m[1], valueAt((m.index ?? 0) + m[0].length));
  }
  return bindings;
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
    if (!bound || seen.has(e)) return false;
    seen.add(e);
    return bound.every((value) => isExempt(value, ctx, seen));
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

/** Static text that looks like markup: a start or end tag. */
export const looksLikeMarkup = (parts: readonly string[]): boolean =>
  parts.some((part) => /<\/?[a-zA-Z][\w:-]*(?=[\s/>]|$)/.test(part));

/** Whether a literal is the direct argument of console.*(), new *Error() or throw. */
export const isMessageArgument = (source: string, start: number): boolean => {
  const before = source.slice(Math.max(0, start - 80), start);
  return (
    /\bthrow\s*$/.test(before) ||
    /\b(?:console\.[a-zA-Z]+|new\s+[\w$.]*Error)\s*\(\s*$/.test(before)
  );
};

// ─── Where html would throw ─────────────────────────────────────────────────

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

const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const SVG_ANIMATION_TAGS = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);
const isAsciiAlpha = (c: string): boolean => /[a-zA-Z]/.test(c);
const isTagSpace = (c: string): boolean => /[\t\n\f\r ]/.test(c);

/**
 * Whether html`...` would throw for a template with these static parts:
 * a hole in a tag name, where an attribute name goes, in an unquoted value,
 * inside a comment or <!...> declaration, inside a <script> or <style>, in
 * an on*, style or srcdoc value, a <meta> http-equiv or content value, any
 * attribute of an SVG animation element, or a template that ends inside a
 * tag, comment, quoted value or raw-text element. A small version of
 * html's own tokenizer, one linear pass; it errs toward true, since a true
 * only withholds the quick fix.
 */
export function htmlWouldThrow(parts: readonly string[]): boolean {
  let state = T.Data;
  let tag = "";
  let isEnd = false;
  let attr = "";
  let rawTag = "";
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
          } else if (c === "/") state = T.EndTagOpen;
          else if (c === "!") {
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
            } else state = T.Data;
          } else if (state === T.TagName) {
            if (isTagSpace(c)) state = T.BeforeAttrName;
            else if (c === "/") state = T.SelfClosing;
            else tag += c.toLowerCase();
          } else if (state === T.BeforeAttrValue) {
            if (c === '"') state = T.ValueDq;
            else if (c === "'") state = T.ValueSq;
            else if (!isTagSpace(c)) state = T.ValueUq;
          } else if (state === T.ValueUq) {
            if (isTagSpace(c)) state = T.BeforeAttrName;
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
          if (c === '"') state = T.AfterValueQuoted;
          break;
        case T.ValueSq:
          if (c === "'") state = T.AfterValueQuoted;
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
          }
          break;
      }
    }
    if (p === parts.length - 1) break;
    // A hole after parts[p].
    switch (state) {
      case T.Data:
        break;
      case T.RawText:
        if (rawTag === "script" || rawTag === "style") return true;
        break;
      case T.ValueDq:
      case T.ValueSq:
        if (
          /^on/.test(attr) ||
          attr === "style" ||
          attr === "srcdoc" ||
          (tag === "meta" && (attr === "http-equiv" || attr === "content")) ||
          SVG_ANIMATION_TAGS.has(tag)
        )
          return true;
        break;
      default:
        return true;
    }
  }
  return state !== T.Data;
}
