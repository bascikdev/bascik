/**
 * hand-written-html-escaper: a function (or a lookup object) in a project
 * script that turns `&` and `<` into HTML entities, the job of `html` and
 * `esc` from @bascik/bascik/html.
 *
 * What counts: a string literal (or a template with no holes) that is
 * exactly an entity, used as a replacement value. That is the second
 * argument of a call (`.replace(/</g, "&lt;")`, `.replaceAll("<", "&lt;")`),
 * an object or `case` value (`{ "<": "&lt;" }`, `case "<": return "&lt;"`)
 * or the second item of a pair (`["<", "&lt;"]`). A decoder has the entity
 * on the other side: the first argument (`.replaceAll("&lt;", "<")`), a key
 * (`{ "&lt;": "<" }`), the first item of a pair, or inside a regex
 * (`/&lt;/g`), so it never matches. An escaper must produce both `&amp;`
 * and `&lt;`: a URL helper that writes only `&amp;` is not one.
 *
 * The finding names the innermost named owner of those values: a function
 * declaration, a method, a `const`/`let`/`var` or property bound to a
 * function or arrow, or the object that maps characters to entities.
 * Callbacks (`(c) => map[c]`) are skipped on the way out, so the name is
 * the escaper's, not the callback's.
 *
 * Not reported: an owner with a comment that says it escapes XML (RSS,
 * Atom, a sitemap, SVG), inside it or right above it, since `html` builds
 * HTML. Its calls are trusted in that file's markup templates. Test files
 * never reach this rule (createDiagnostics skips them).
 *
 * Linear: one pass over the tokens, and each bracket is climbed through once
 * (the owner found for it is cached).
 */
import { scanJavaScript, type Token } from "./module-specifiers.js";

export const HAND_WRITTEN_ESCAPER_RULE = "hand-written-html-escaper";

export interface HandWrittenEscaper {
  /** The owner's name. */
  name: string;
  /** "function" for a function, method or arrow; "map" for an object of entities. */
  kind: "function" | "map";
  /** Offsets of the name. */
  start: number;
  end: number;
  /**
   * Where the "call esc()" fix applies: a function with one plain
   * parameter whose body is one `return` (or an arrow's expression), and
   * that holds every entity. `start`/`end` cover the body (the braces
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
  if (!ENTITIES.has(t.value.trim().toLowerCase())) return false;
  const next = tokens[i + 1];
  // A key ({ "&lt;": "<" }) is what a decoder reads.
  if (is(next, ":")) return false;
  const prev = tokens[i - 1];
  // The first argument, or the first item of a pair, is what is replaced.
  if (is(prev, "(") || is(prev, "[")) return false;
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
 * it inside that bracket (since the last `,` or `;` there). One forward pass.
 */
function scopes(tokens: Token[]): {
  enclosing: Int32Array;
  arrowBefore: Int32Array;
} {
  const enclosing = new Int32Array(tokens.length).fill(-1);
  const arrowBefore = new Int32Array(tokens.length).fill(-1);
  const frames: { open: number; arrow: number }[] = [{ open: -1, arrow: -1 }];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const top = frames[frames.length - 1];
    enclosing[i] = top.open;
    arrowBefore[i] = top.arrow;
    if (isOpen(t)) frames.push({ open: i, arrow: -1 });
    else if (isClose(t)) {
      if (frames.length > 1) frames.pop();
    } else if (is(t, ",") || is(t, ";")) top.arrow = -1;
    else if (is(t, "=") && is(tokens[i + 1], ">")) top.arrow = i;
  }
  return { enclosing, arrowBefore };
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

/** Statement-level boundaries: a `;` or `}` at depth 0 starts the next top-level statement. */
function topLevelStatements(tokens: Token[]): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && t.value === "}") {
        // `}` that ends a block statement; a following `)` or `;` stays.
        const next = tokens[i + 1];
        if (
          !is(next, ")") &&
          !is(next, ";") &&
          !is(next, ",") &&
          !is(next, ".")
        ) {
          out.push([start, i]);
          start = i + 1;
        }
      }
    } else if (depth === 0 && is(t, ";")) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (start < tokens.length) out.push([start, tokens.length - 1]);
  return out;
}

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
  const { enclosing, arrowBefore } = scopes(tokens);
  const memo = new Map<number, Owner | null>();
  const found: HandWrittenEscaper[] = [];
  let commentIndex = 0;
  let previousEnd = 0;

  for (const [first, last] of topLevelStatements(tokens)) {
    const statementEnd = tokens[last].end;
    // Comments from the end of the previous statement to the end of this
    // one: the ones right above it and the ones inside it.
    const notes: string[] = [];
    while (
      commentIndex < comments.length &&
      comments[commentIndex].start < statementEnd
    ) {
      if (comments[commentIndex].end > previousEnd)
        notes.push(
          source.slice(
            comments[commentIndex].start,
            comments[commentIndex].end,
          ),
        );
      commentIndex++;
    }
    previousEnd = statementEnd;

    // Owners found in this statement, by name token, with the entities they hold.
    const owners = new Map<
      number,
      {
        owner: Owner;
        entities: Set<string>;
        positions: number[];
      }
    >();
    for (let i = first; i <= last; i++) {
      if (!isOutputEntity(tokens, i)) continue;
      const owner = ownerOf(tokens, partner, enclosing, arrowBefore, memo, i);
      if (!owner) continue;
      let entry = owners.get(owner.nameAt);
      if (!entry) {
        entry = { owner, entities: new Set(), positions: [] };
        owners.set(owner.nameAt, entry);
      }
      entry.entities.add(tokens[i].value.trim().toLowerCase());
      entry.positions.push(i);
    }
    for (const { owner, entities, positions } of owners.values()) {
      if (!entities.has("&amp;") || !entities.has("&lt;")) continue;
      if (notes.some((note) => XML_COMMENT.test(note))) {
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
      if (owner.kind === "function") {
        const delegate = delegateOf(tokens, partner, owner, positions);
        if (delegate) escaper.delegate = delegate;
      }
      found.push(escaper);
    }
  }
  return found;
}

/** Where a one-return function can be rewritten to call esc(). */
function delegateOf(
  tokens: Token[],
  partner: Int32Array,
  owner: Owner,
  positions: number[],
): HandWrittenEscaper["delegate"] {
  if (owner.open !== -1) {
    const close = partner[owner.open];
    if (close === -1) return undefined;
    // The body is `{ return <expression>; }`, with nothing after the return.
    if (!isWord(tokens[owner.open + 1], "return")) return undefined;
    let depth = 0;
    for (let k = owner.open + 2; k < close; k++) {
      if (isOpen(tokens[k])) depth++;
      else if (isClose(tokens[k])) depth--;
      else if (depth === 0 && is(tokens[k], ";") && k !== close - 1)
        return undefined;
    }
    if (positions.some((p) => p <= owner.open || p >= close)) return undefined;
    const beforeBody =
      owner.arrow !== undefined ? owner.arrow - 1 : owner.open - 1;
    const param = soleParam(tokens, partner, beforeBody);
    if (!param) return undefined;
    return {
      start: tokens[owner.open].start,
      end: tokens[close].end,
      param,
      block: true,
    };
  }
  if (owner.arrow === undefined) return undefined;
  // An arrow with an expression body: it runs to the `;`, `,` or closing
  // bracket at its own depth.
  const bodyStart = owner.arrow + 2;
  if (bodyStart >= tokens.length) return undefined;
  let k = bodyStart;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (isOpen(t)) {
      const close = partner[k];
      if (close === -1) return undefined;
      k = close;
      continue;
    }
    if (isClose(t) || is(t, ";") || is(t, ",")) break;
  }
  const bodyEnd = k - 1;
  if (bodyEnd < bodyStart) return undefined;
  if (positions.some((p) => p < bodyStart || p > bodyEnd)) return undefined;
  const param = soleParam(tokens, partner, owner.arrow - 1);
  if (!param) return undefined;
  const lastToken = tokens[bodyEnd];
  // A string token's end is before its closing quote.
  const end =
    lastToken.type === "string" || lastToken.type === "template"
      ? lastToken.end + 1
      : lastToken.end;
  const firstToken = tokens[bodyStart];
  const start =
    firstToken.type === "string" || firstToken.type === "template"
      ? firstToken.start - 1
      : firstToken.start;
  return { start, end, param, block: false };
}
