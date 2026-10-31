/**
 * hand-written-html-escaper: a function (or a lookup object) in a project
 * script that turns `&` and `<` into HTML entities, the job of `html` and
 * `esc` from @bascik/bascik/html.
 *
 * What counts: a string literal (or a template with no holes) that is
 * exactly an entity (named, or numeric such as `&#38;`), used as a
 * replacement value. That is the second argument of a call
 * (`.replace(/</g, "&lt;")`, `.replaceAll("<", "&lt;")`), the argument of
 * `.join()` (`.split("<").join("&lt;")`), an object or `case` value
 * (`{ "<": "&lt;" }`, `case "<": return "&lt;"`), the second item of a pair
 * (`["<", "&lt;"]`, a `new Map([...])` table), or a value appended with
 * `+=`. A decoder has the entity on the other side: the first argument
 * (`.replaceAll("&lt;", "<")`), a key (`{ "&lt;": "<" }`), the first item
 * of a pair, or inside a regex (`/&lt;/g`), so it never matches; nor does a
 * constant (`const prev = "&lt;"`) or a comparison. An escaper must produce
 * both `&amp;` and `&lt;`: a URL helper that writes only `&amp;` is not one.
 *
 * The finding names the innermost named owner of those values: a function
 * declaration, a method, a `const`/`let`/`var` or property bound to a
 * function or arrow, an unnamed `export default` function, or the object,
 * `new Map(...)` or IIFE result that maps characters to entities.
 * Callbacks (`(c) => map[c]`) are skipped on the way out, so the name is
 * the escaper's, not the callback's.
 *
 * Not reported: an owner with a comment that says it escapes XML (RSS,
 * Atom, a sitemap, SVG), inside it or on its own lines right above its
 * declaration, since `html` builds HTML. Its calls are trusted in that
 * file's markup templates. Test files never reach this rule
 * (createDiagnostics skips them).
 *
 * Linear: one pass over the tokens; each bracket is climbed through once
 * (the owner found for it is cached); comments are found by binary search.
 */
import {
  scanJavaScript,
  type Comment,
  type Token,
} from "./module-specifiers.js";

export const HAND_WRITTEN_ESCAPER_RULE = "hand-written-html-escaper";

export interface HandWrittenEscaper {
  /** The owner's name. */
  name: string;
  /** "function" for a function, method or arrow; "map" for an object of entities. */
  kind: "function" | "map";
  /** Offsets of the name (for an unnamed default export, of `default`). */
  start: number;
  end: number;
  /** An unnamed `export default` function or arrow. */
  defaultExport?: boolean;
  /**
   * Where the "call esc()" fix applies: a function with one plain
   * parameter whose body is one `return` (or an arrow's expression) of
   * that parameter (or `String(param)`, `(param ?? "")`) followed only by
   * `.replace()`/`.replaceAll()` calls that write entities, so esc() does
   * the same job. `start`/`end` cover the body (the braces
   * included, or the arrow's expression); `param` is the parameter name.
   */
  delegate?: { start: number; end: number; param: string; block: boolean };
}

const ENTITIES = new Set([
  "&amp;",
  "&lt;",
  "&gt;",
  "&quot;",
  "&#34;",
  "&#x22;",
  "&#39;",
  "&#039;",
  "&#x27;",
  "&apos;",
]);

/** Numeric entities for the characters html escapes, by code point. */
const NUMERIC_ENTITIES: Record<number, string> = {
  38: "&amp;",
  60: "&lt;",
  62: "&gt;",
  34: "&quot;",
  39: "&#39;",
};

/** The named form of an entity string (`&#38;` is `&amp;`), or undefined for any other text. */
function entityOf(value: string): string | undefined {
  const t = value.trim().toLowerCase();
  if (ENTITIES.has(t)) return t;
  const m = /^&#(?:x([0-9a-f]{1,6})|(\d{1,7}));$/.exec(t);
  if (!m) return undefined;
  return NUMERIC_ENTITIES[m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10)];
}

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
]);

/** Words of an explanatory comment that make an escaper XML-specific. */
const XML_COMMENT = /\b(?:xml|rss|atom|sitemap|svg)\b/i;

const isOpen = (t: Token | undefined): boolean =>
  t?.type === "punctuation" &&
  (t.value === "(" || t.value === "[" || t.value === "{");
const isClose = (t: Token | undefined): boolean =>
  t?.type === "punctuation" &&
  (t.value === ")" || t.value === "]" || t.value === "}");
const is = (t: Token | undefined, value: string): boolean =>
  t !== undefined && t.type === "punctuation" && t.value === value;
const isWord = (t: Token | undefined, value?: string): boolean =>
  t !== undefined &&
  t.type === "identifier" &&
  (value === undefined || t.value === value);

/** Pairs each bracket token with its partner (index to index), in one pass. */
function matchBrackets(tokens: Token[]): Int32Array {
  const partner = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isOpen(tokens[i])) stack.push(i);
    else if (isClose(tokens[i]) && stack.length > 0) {
      const open = stack.pop()!;
      partner[open] = i;
      partner[i] = open;
    }
  }
  return partner;
}

/** Whether a string token is an entity used as a replacement value. */
function isOutputEntity(tokens: Token[], i: number): boolean {
  const t = tokens[i];
  if (t.type !== "string" && t.type !== "template") return false;
  if (entityOf(t.value) === undefined) return false;
  const next = tokens[i + 1];
  // A key ({ "&lt;": "<" }) is what a decoder reads.
  if (is(next, ":")) return false;
  const prev = tokens[i - 1];
  // `.split("<").join("&lt;")`: join's argument is what is written.
  if (is(prev, "(") && isWord(tokens[i - 2], "join")) return true;
  // The first argument, or the first item of a pair, is what is replaced.
  if (is(prev, "(") || is(prev, "[")) return false;
  // A constant (`const prev = "&lt;"`) or a comparison (`=== "&lt;"`) is
  // not a replacement; `out += "&lt;"` is.
  if (is(prev, "=") && !is(tokens[i - 2], "+")) return false;
  return true;
}

type Owner = {
  nameAt: number;
  kind: "function" | "map";
  /** The body's `{`, or -1 for an arrow with an expression body. */
  open: number;
  /** The `=` of an arrow's `=>`. */
  arrow?: number;
};

/**
 * For each token: the bracket that encloses it, and the nearest `=>` before
 * it inside that bracket (since the last `,` or `;` there). For each open
 * bracket: how many `;` sit directly in it, and the last one. One forward
 * pass.
 */
function scopes(tokens: Token[]): {
  enclosing: Int32Array;
  arrowBefore: Int32Array;
  semicolons: Int32Array;
  lastSemicolon: Int32Array;
} {
  const enclosing = new Int32Array(tokens.length).fill(-1);
  const arrowBefore = new Int32Array(tokens.length).fill(-1);
  const semicolons = new Int32Array(tokens.length);
  const lastSemicolon = new Int32Array(tokens.length).fill(-1);
  const frames: { open: number; arrow: number }[] = [{ open: -1, arrow: -1 }];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const top = frames[frames.length - 1];
    enclosing[i] = top.open;
    arrowBefore[i] = top.arrow;
    if (isOpen(t)) frames.push({ open: i, arrow: -1 });
    else if (isClose(t)) {
      if (frames.length > 1) frames.pop();
    } else if (is(t, ",") || is(t, ";")) {
      top.arrow = -1;
      if (is(t, ";") && top.open !== -1) {
        semicolons[top.open]++;
        lastSemicolon[top.open] = i;
      }
    } else if (is(t, "=") && is(tokens[i + 1], ">")) top.arrow = i;
  }
  return { enclosing, arrowBefore, semicolons, lastSemicolon };
}

/**
 * The innermost named owner of the token at `from`, climbing out through
 * the brackets that enclose it. `memo` caches each bracket's answer, so
 * every bracket is climbed through once in a whole file.
 */
function ownerOf(
  tokens: Token[],
  partner: Int32Array,
  enclosing: Int32Array,
  arrowBefore: Int32Array,
  memo: Map<number, Owner | null>,
  from: number,
): Owner | undefined {
  const arrow = arrowBefore[from];
  if (arrow !== -1) {
    const named = namedArrow(tokens, partner, arrow);
    if (named) return named;
  }
  const visited: number[] = [];
  let open = enclosing[from];
  let result: Owner | null = null;
  while (open !== -1) {
    const cached = memo.get(open);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    visited.push(open);
    if (tokens[open].value === "{") {
      const named = namedBlock(tokens, partner, open);
      if (named) {
        result = named;
        break;
      }
    } else if (tokens[open].value === "(") {
      const named = namedParen(tokens, partner, open);
      if (named) {
        result = named;
        break;
      }
    } else if (tokens[open].value === "[" && is(tokens[open - 1], "=")) {
      // An array of [char, entity] pairs bound to a name.
      const nameAt = nameBeforeValue(tokens, open - 1);
      if (nameAt !== -1) {
        result = { nameAt, kind: "map", open };
        break;
      }
    }
    const outerArrow = arrowBefore[open];
    if (outerArrow !== -1) {
      const named = namedArrow(tokens, partner, outerArrow);
      if (named) {
        result = named;
        break;
      }
    }
    open = enclosing[open];
  }
  for (const v of visited) memo.set(v, result);
  return result ?? undefined;
}

/**
 * A `(` that holds a lookup table bound to a name: `NAME = new Map(...)`,
 * or an IIFE whose result is (`NAME = (() => ({ ... }))()`).
 */
function namedParen(
  tokens: Token[],
  partner: Int32Array,
  open: number,
): Owner | undefined {
  if (isWord(tokens[open - 1]) && isWord(tokens[open - 2], "new")) {
    if (!is(tokens[open - 3], "=")) return undefined;
    const nameAt = nameBeforeValue(tokens, open - 3);
    return nameAt === -1 ? undefined : { nameAt, kind: "map", open };
  }
  const close = partner[open];
  if (is(tokens[open - 1], "=") && close !== -1 && is(tokens[close + 1], "(")) {
    const nameAt = nameBeforeValue(tokens, open - 1);
    return nameAt === -1 ? undefined : { nameAt, kind: "map", open };
  }
  return undefined;
}

/** Index of the `)` that ends a parameter list before a `{` or `=>`, skipping a return type. */
function paramsCloseBefore(tokens: Token[], at: number): number {
  if (is(tokens[at], ")")) return at;
  // `(s: string): string {` or `): Promise<string> =>`: a short type.
  for (let k = at; k >= 0 && at - k < 24; k--) {
    const t = tokens[k];
    if (is(t, ")") && is(tokens[k + 1], ":")) return k;
    if (
      t.type === "punctuation" &&
      !"<>|&[].,:?".includes(t.value) &&
      !(t.value === ")" || t.value === "(")
    )
      return -1;
  }
  return -1;
}

/** The name before a function value: `NAME =`, `NAME:`, or nothing. */
function nameBeforeValue(tokens: Token[], at: number): number {
  let k = at;
  if (isWord(tokens[k], "async")) k--;
  // `export default function (s)` or `export default (s) =>`: the default export.
  if (isWord(tokens[k], "default") && isWord(tokens[k - 1], "export")) return k;
  if (is(tokens[k], "=") && !is(tokens[k - 1], "=")) {
    // `const NAME: Type = ...`: walk back over a short type annotation.
    for (let j = k - 1, steps = 0; j > 0 && steps < 24; steps++, j--) {
      const declared =
        isWord(tokens[j - 1], "const") ||
        isWord(tokens[j - 1], "let") ||
        isWord(tokens[j - 1], "var");
      if (isWord(tokens[j]) && declared) return j;
      if (is(tokens[j], ";") || is(tokens[j], "{") || is(tokens[j], "}")) break;
    }
    return isWord(tokens[k - 1]) && !is(tokens[k - 2], ".") ? k - 1 : -1;
  }
  if (is(tokens[k], ":") && isWord(tokens[k - 1])) return k - 1;
  if (is(tokens[k], ":") && tokens[k - 1]?.type === "string") return k - 1;
  return -1;
}

function namedBlock(
  tokens: Token[],
  partner: Int32Array,
  open: number,
): Owner | undefined {
  const prev = tokens[open - 1];
  // An object literal bound to a name: a lookup map.
  if (is(prev, "=") || is(prev, ":")) {
    const nameAt = nameBeforeValue(tokens, open - 1);
    if (nameAt !== -1 && !is(prev, ":")) return { nameAt, kind: "map", open };
    if (nameAt !== -1 && is(prev, ":") && !isWord(tokens[nameAt - 1], "case"))
      return { nameAt, kind: "map", open };
    return undefined;
  }
  if (is(prev, ">") && is(tokens[open - 2], "=")) {
    return namedArrow(tokens, partner, open - 2, open);
  }
  const close = paramsCloseBefore(tokens, open - 1);
  if (close === -1) return undefined;
  const paramsOpen = partner[close];
  if (paramsOpen === -1) return undefined;
  const before = tokens[paramsOpen - 1];
  if (!isWord(before)) return undefined;
  if (CONTROL_KEYWORDS.has(before.value)) return undefined;
  if (before.value === "function") {
    // `const NAME = function (s) {`
    const nameAt = nameBeforeValue(tokens, paramsOpen - 2);
    return nameAt === -1 ? undefined : { nameAt, kind: "function", open };
  }
  // `function NAME(s) {` or a method `NAME(s) {`.
  if (is(tokens[paramsOpen - 2], ".")) return undefined;
  return { nameAt: paramsOpen - 1, kind: "function", open };
}

function namedArrow(
  tokens: Token[],
  partner: Int32Array,
  arrowAt: number,
  bodyOpen?: number,
): Owner | undefined {
  const paramsStart = paramsStartBefore(tokens, partner, arrowAt - 1);
  if (paramsStart === -1) return undefined;
  const nameAt = nameBeforeValue(tokens, paramsStart - 1);
  if (nameAt === -1) return undefined;
  return {
    nameAt,
    kind: "function",
    open: bodyOpen ?? -1,
    arrow: arrowAt,
  };
}

/**
 * Where the parameters end before a body or `=>` at `at` start: the `(` of a
 * list (past a return type), or a lone parameter name; -1 when neither.
 */
function paramsStartBefore(
  tokens: Token[],
  partner: Int32Array,
  at: number,
): number {
  const close = paramsCloseBefore(tokens, at);
  if (close !== -1) return partner[close];
  return isWord(tokens[at]) ? at : -1;
}

/** The single plain parameter of a function whose parameters end at `beforeBody`. */
function soleParam(
  tokens: Token[],
  partner: Int32Array,
  beforeBody: number,
): string | undefined {
  const close = paramsCloseBefore(tokens, beforeBody);
  if (close === -1)
    return isWord(tokens[beforeBody]) ? tokens[beforeBody].value : undefined;
  const open = partner[close];
  if (open === -1) return undefined;
  const inside = tokens.slice(open + 1, close);
  if (inside.length === 0 || !isWord(inside[0])) return undefined;
  // `s`, `s: string`, `s: unknown`, `s?: string | null`: one name and a type.
  if (inside.some((t) => is(t, ",") || is(t, "=") || is(t, "{")))
    return undefined;
  if (inside.length > 1 && !is(inside[1], ":") && !is(inside[1], "?"))
    return undefined;
  return inside[0].value;
}

/** Modifiers that can come before an owner's name in its declaration. */
const DECLARATION_WORDS = new Set([
  "function",
  "const",
  "let",
  "var",
  "async",
  "export",
  "default",
  "static",
  "public",
  "private",
  "protected",
  "readonly",
  "override",
  "declare",
  "get",
  "set",
]);

/** The first token of the owner's declaration: its name, past `export`, `const`, `async` and the like. */
function declarationStart(tokens: Token[], nameAt: number): number {
  let k = nameAt;
  while (
    k > 0 &&
    ((tokens[k - 1].type === "identifier" &&
      DECLARATION_WORDS.has(tokens[k - 1].value)) ||
      is(tokens[k - 1], "*"))
  )
    k--;
  return k;
}

/** Index of the first comment that starts at or after `offset`. */
function firstCommentFrom(comments: Comment[], offset: number): number {
  let lo = 0;
  let hi = comments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (comments[mid].start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const isBlank = (text: string): boolean => /^\s*$/.test(text);

/**
 * The hand-written escapers in `source`. With `xml`, also the names of the
 * function escapers left out because a comment says they escape XML: the
 * markup rule trusts those in the same file, like diagnostics.escapeFunctions.
 */
export function findHandWrittenEscapers(
  source: string,
  xml?: string[],
): HandWrittenEscaper[] {
  const { tokens, comments } = scanJavaScript(source);
  if (tokens.length === 0) return [];
  const partner = matchBrackets(tokens);
  const { enclosing, arrowBefore, semicolons, lastSemicolon } = scopes(tokens);
  const memo = new Map<number, Owner | null>();

  // Owners by name token, with the entities they hold.
  const owners = new Map<
    number,
    { owner: Owner; entities: Set<string>; positions: number[] }
  >();
  for (let i = 0; i < tokens.length; i++) {
    if (!isOutputEntity(tokens, i)) continue;
    const owner = ownerOf(tokens, partner, enclosing, arrowBefore, memo, i);
    if (!owner) continue;
    let entry = owners.get(owner.nameAt);
    if (!entry) {
      entry = { owner, entities: new Set(), positions: [] };
      owners.set(owner.nameAt, entry);
    }
    entry.entities.add(entityOf(tokens[i].value)!);
    entry.positions.push(i);
  }

  // How many comments before each index mention XML: a range count is two lookups.
  const xmlBefore = new Int32Array(comments.length + 1);
  for (let k = 0; k < comments.length; k++)
    xmlBefore[k + 1] =
      xmlBefore[k] +
      (XML_COMMENT.test(source.slice(comments[k].start, comments[k].end))
        ? 1
        : 0);
  const saysXml = (owner: Owner, positions: number[]): boolean => {
    const declStart = tokens[declarationStart(tokens, owner.nameAt)].start;
    const close = owner.open !== -1 ? partner[owner.open] : -1;
    const end =
      owner.open === -1
        ? tokens[positions[positions.length - 1]].end
        : close === -1
          ? source.length
          : tokens[close].end;
    // Inside the owner.
    const from = firstCommentFrom(comments, declStart);
    const to = firstCommentFrom(comments, end);
    if (xmlBefore[to] - xmlBefore[from] > 0) return true;
    // On its own lines right above the declaration, with only whitespace between.
    let pos = declStart;
    for (let k = from - 1; k >= 0; k--) {
      const c = comments[k];
      if (!isBlank(source.slice(c.end, pos))) break;
      const lineStart = source.lastIndexOf("\n", c.start - 1) + 1;
      if (!isBlank(source.slice(lineStart, c.start))) break;
      if (xmlBefore[k + 1] - xmlBefore[k] > 0) return true;
      pos = c.start;
    }
    return false;
  };

  const found: HandWrittenEscaper[] = [];
  const entries = [...owners.values()].sort(
    (a, b) => a.owner.nameAt - b.owner.nameAt,
  );
  for (const { owner, entities, positions } of entries) {
    if (!entities.has("&amp;") || !entities.has("&lt;")) continue;
    if (saysXml(owner, positions)) {
      if (owner.kind === "function") xml?.push(tokens[owner.nameAt].value);
      continue;
    }
    const nameToken = tokens[owner.nameAt];
    const escaper: HandWrittenEscaper = {
      name: nameToken.value,
      kind: owner.kind,
      start: nameToken.start,
      end: nameToken.end,
    };
    if (
      nameToken.value === "default" &&
      isWord(tokens[owner.nameAt - 1], "export")
    )
      escaper.defaultExport = true;
    if (owner.kind === "function") {
      const delegate = delegateOf(
        tokens,
        partner,
        owner,
        semicolons,
        lastSemicolon,
      );
      if (delegate) escaper.delegate = delegate;
    }
    found.push(escaper);
  }
  return found;
}

/**
 * The index just past `param` followed by one or more `.replace(x, ENTITY)`
 * or `.replaceAll(x, ENTITY)` calls, starting at `k`, or -1. The receiver
 * may also be `String(param)`, `(param ?? "")`, `(param || "")` or
 * `String(param ?? "")`. Reads only the chain, so it stops at the first
 * token that does not fit.
 */
function entityChainEnd(
  tokens: Token[],
  partner: Int32Array,
  k: number,
  param: string,
): number {
  const isEmptyString = (t: Token | undefined): boolean =>
    (t?.type === "string" || t?.type === "template") && t.value === "";
  /** `param`, or `param ?? ""` / `param || ""`, from j up to (not including) `end`. */
  const isParamOrDefault = (j: number, end: number): boolean => {
    if (!isWord(tokens[j], param)) return false;
    if (j + 1 === end) return true;
    const op =
      (is(tokens[j + 1], "?") && is(tokens[j + 2], "?")) ||
      (is(tokens[j + 1], "|") && is(tokens[j + 2], "|"));
    return op && isEmptyString(tokens[j + 3]) && j + 4 === end;
  };
  let i: number;
  if (isWord(tokens[k], param)) i = k + 1;
  else if (isWord(tokens[k], "String") && is(tokens[k + 1], "(")) {
    const close = partner[k + 1];
    if (close === -1 || !isParamOrDefault(k + 2, close)) return -1;
    i = close + 1;
  } else if (is(tokens[k], "(")) {
    const close = partner[k];
    if (close === -1 || !isParamOrDefault(k + 1, close)) return -1;
    if (k + 2 === close) return -1;
    i = close + 1;
  } else return -1;
  let links = 0;
  while (
    is(tokens[i], ".") &&
    (isWord(tokens[i + 1], "replace") || isWord(tokens[i + 1], "replaceAll")) &&
    is(tokens[i + 2], "(")
  ) {
    const close = partner[i + 2];
    if (close === -1) return -1;
    // `(pattern, ENTITY)` or `(, ENTITY)` (a regex leaves no token), with a trailing comma allowed.
    let j = i + 3;
    if (!is(tokens[j], ",")) j++;
    if (!is(tokens[j], ",")) return -1;
    const replacement = tokens[j + 1];
    let after: number;
    if (
      replacement &&
      (replacement.type === "string" || replacement.type === "template") &&
      entityOf(replacement.value) !== undefined
    )
      after = j + 2;
    else {
      after = entityCallbackEnd(tokens, partner, j + 1);
      if (after === -1) return -1;
    }
    if (!(after === close || (is(tokens[after], ",") && after + 1 === close)))
      return -1;
    links++;
    i = close + 1;
  }
  return links > 0 ? i : -1;
}

/**
 * The index just past a callback that looks a character up in an inline
 * table of entities, `(c) => ({ "&": "&amp;", "<": "&lt;" })[c]`, starting
 * at `k`, or -1.
 */
function entityCallbackEnd(
  tokens: Token[],
  partner: Int32Array,
  k: number,
): number {
  let name: string;
  let i: number;
  if (is(tokens[k], "(") && isWord(tokens[k + 1]) && is(tokens[k + 2], ")")) {
    name = tokens[k + 1].value;
    i = k + 3;
  } else if (isWord(tokens[k])) {
    name = tokens[k].value;
    i = k + 1;
  } else return -1;
  if (!is(tokens[i], "=") || !is(tokens[i + 1], ">")) return -1;
  if (!is(tokens[i + 2], "(") || !is(tokens[i + 3], "{")) return -1;
  const objectClose = partner[i + 3];
  if (objectClose === -1 || partner[i + 2] !== objectClose + 1) return -1;
  // Every entry is `"c": ENTITY`.
  for (let e = i + 4; e < objectClose; e += 4) {
    const key = tokens[e];
    const value = tokens[e + 2];
    if (
      key.type !== "string" ||
      !is(tokens[e + 1], ":") ||
      !value ||
      (value.type !== "string" && value.type !== "template") ||
      entityOf(value.value) === undefined
    )
      return -1;
    if (!is(tokens[e + 3], ",") && e + 3 !== objectClose) return -1;
  }
  const index = objectClose + 2;
  if (
    !is(tokens[index], "[") ||
    !isWord(tokens[index + 1], name) ||
    !is(tokens[index + 2], "]")
  )
    return -1;
  return index + 3;
}

/** Where a one-return function can be rewritten to call esc() without changing what it returns. */
function delegateOf(
  tokens: Token[],
  partner: Int32Array,
  owner: Owner,
  semicolons: Int32Array,
  lastSemicolon: Int32Array,
): HandWrittenEscaper["delegate"] {
  if (owner.open !== -1) {
    const close = partner[owner.open];
    if (close === -1) return undefined;
    // The body is `{ return <chain>; }`, with nothing after the return.
    if (!isWord(tokens[owner.open + 1], "return")) return undefined;
    const count = semicolons[owner.open];
    if (count > 1 || (count === 1 && lastSemicolon[owner.open] !== close - 1))
      return undefined;
    const beforeBody =
      owner.arrow !== undefined ? owner.arrow - 1 : owner.open - 1;
    const param = soleParam(tokens, partner, beforeBody);
    if (!param) return undefined;
    const end = entityChainEnd(tokens, partner, owner.open + 2, param);
    if (end !== close && !(end === close - 1 && count === 1)) return undefined;
    return {
      start: tokens[owner.open].start,
      end: tokens[close].end,
      param,
      block: true,
    };
  }
  if (owner.arrow === undefined) return undefined;
  // An arrow with an expression body: the chain, then the end of the arrow.
  const bodyStart = owner.arrow + 2;
  const param = soleParam(tokens, partner, owner.arrow - 1);
  if (!param) return undefined;
  const end = entityChainEnd(tokens, partner, bodyStart, param);
  if (end === -1) return undefined;
  const next = tokens[end];
  if (next && !is(next, ";") && !is(next, ",") && !isClose(next))
    return undefined;
  return {
    start: tokens[bodyStart].start,
    end: tokens[end - 1].end,
    param,
    block: false,
  };
}
