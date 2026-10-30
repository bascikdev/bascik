/**
 * Which component tags in an HTML source the compiler expands, found the way the compiler finds them.
 *
 * The language server does not depend on the compiler package, so this mirrors its pipeline, step by step:
 *
 * 1. `maskRawTextContent` (pkg/src/lib/component-masking.ts) blanks comment bodies and the content of
 *    `<script>`, `<style>` and `<textarea>` elements, read left to right as the tokenizer reads them.
 *    A raw-text opener is the regex `<name(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>`: the exact tag
 *    name, as a browser reads one, so `<style-guide>` is a custom element and opens nothing. The closer is
 *    the browser's end tag, `<\/name(?:[\t\n\f\r /][^>]*)?>`, so `</style/>` and `</style foo>` end it and
 *    `</style\v>` does not. A script follows the tokenizer's escaped and double-escaped script data states.
 *    A `<!--` or an opener inside a tag (its name, an attribute, an end tag) or a bogus comment opens
 *    nothing, a comment with no end hides nothing, and an opener with no closer hides nothing.
 * 2. `getFirstComponent` (pkg/src/lib/component-tags.ts) finds `<name` where `name` is a component name
 *    and the whole tag name: the run of `[\w:-]` characters after the `<`, followed by tag whitespace, `/`
 *    or `>` (so `<my-card.foo>`, `<my-card:x>` and `<my-card</p>` are no `my-card`), with a `>` somewhere
 *    after it, and skips a match inside a tag (`<p<my-card>`, an attribute value, `</p <my-card>`) or a bogus
 *    comment (`<!x<my-card>`, `<?<my-card>`, `</<my-card>`) of the masked text.
 *
 * references-scan.test.ts pins the compiler's answers for the inputs where the two could drift, and
 * pkg/src/lib/lsp-component-usages-agreement.test.ts compares the two on random markup.
 */

/** One component tag the compiler expands. */
export interface ComponentUsage {
  /** The component name, lower-cased. */
  name: string;
  /** Offset of the `<`. */
  start: number;
  nameStart: number;
  nameEnd: number;
}

/** JavaScript's `\s` on one UTF-16 code unit. */
const isJsSpace = (code: number): boolean =>
  code === 32 ||
  (code >= 9 && code <= 13) ||
  (code > 127 && /\s/.test(String.fromCharCode(code)));

/** The HTML tokenizer's tag whitespace. */
const isTagSpace = (code: number): boolean =>
  code === 9 || code === 10 || code === 12 || code === 13 || code === 32;

/** What ends a tag name for the tokenizer: tag whitespace, `/` or `>`. NaN is false. */
const isTagNameEndCode = (code: number): boolean =>
  isTagSpace(code) || code === 47 || code === 62;

/** `[A-Za-z0-9_]` */
const isWordCode = (code: number): boolean =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 95;

/** `[A-Za-z]`. NaN is false. */
const isLetterCode = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/**
 * Where an HTML comment that opens at `start` ends, as the HTML tokenizer ends it: after the first `-->` or
 * `--!>`, with `<!-->` and `<!--->` complete empty comments. -1 when it never ends.
 */
export function findCommentEnd(html: string, start: number): number {
  const bodyStart = start + 4;
  if (html.startsWith(">", bodyStart)) return bodyStart + 1;
  if (html.startsWith("->", bodyStart)) return bodyStart + 2;
  let at = bodyStart;
  for (;;) {
    const dashes = html.indexOf("--", at);
    if (dashes < 0) return -1;
    if (html.charCodeAt(dashes + 2) === 62) return dashes + 3;
    if (html.startsWith("!>", dashes + 2)) return dashes + 4;
    at = dashes + 1;
  }
}

type TagState =
  "text" | "name" | "tag" | "quoted" | "unquoted" | "before-value" | "bogus";

/**
 * What a `<` at `at`, read in text, starts (the compiler's `stateAfterLess`): a tag's name for `<` or `</`
 * and a letter (where `=` and quotes are name characters, up to tag whitespace, `/` or `>`); nothing for `<!--` (comments are resolved apart) or a `<` before anything else or the end; a bogus
 * comment up to `>` for `<!`, `<?`, or `</` and anything else.
 */
const stateAfterLess = (html: string, at: number): TagState => {
  const next = html.charCodeAt(at + 1);
  if (isLetterCode(next)) return "name";
  if (next === 63) return "bogus";
  if (next === 33) return html.startsWith("--", at + 2) ? "text" : "bogus";
  if (next !== 47) return "text";
  const after = html.charCodeAt(at + 2);
  if (Number.isNaN(after)) return "text";
  return isLetterCode(after) ? "name" : "bogus";
};

/**
 * The compiler's attribute-value scanner (`createAttributeValueScanner`): the tag state at a position, read
 * from `origin` in the text state. Queries in increasing order cost one pass in total.
 */
function createTagStateReader(html: string, origin = 0) {
  let cursor = origin;
  let state: TagState = "text";
  let quote = "";
  // In the text or quoted state, where that state ends once searched; -2 before.
  let ahead = -2;
  const advance = (index: number): void => {
    while (cursor < index) {
      if (state === "text" || state === "quoted" || state === "bogus") {
        if (ahead === -2)
          ahead = html.indexOf(
            state === "text" ? "<" : state === "bogus" ? ">" : quote,
            cursor,
          );
        const end = ahead;
        if (end === -1 || end >= index) {
          cursor = index;
          return;
        }
        ahead = -2;
        if (state === "quoted") state = "tag";
        else if (state === "bogus") state = "text";
        else state = stateAfterLess(html, end);
        cursor = end + 1;
        continue;
      }
      const code = html.charCodeAt(cursor);
      if (state === "name") {
        if (code === 62) state = "text";
        else if (isTagSpace(code) || code === 47) state = "tag";
      } else if (state === "unquoted") {
        if (code === 62) state = "text";
        else if (isJsSpace(code)) state = "tag";
      } else if (state === "before-value") {
        if (code === 34 || code === 39) {
          quote = html[cursor];
          state = "quoted";
        } else if (code === 62) state = "text";
        else if (!isJsSpace(code)) state = "unquoted";
      } else if (code === 61) state = "before-value";
      else if (code === 62) state = "text";
      cursor++;
    }
  };
  return (index: number): TagState => {
    if (index < cursor) {
      cursor = origin;
      state = "text";
      quote = "";
      ahead = -2;
    }
    if (cursor < index) advance(index);
    return state;
  };
}

interface RawElement {
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

/**
 * The end of a quoted-attribute-aware tag body that starts at `from`: the index after the first `>` outside
 * `"..."` and `'...'`, or -1 when a quote never closes or no `>` follows. What the opener regex's
 * `(?:[^>"']|"[^"]*"|'[^']*')*>` accepts. Remembered per position, so many calls stay linear.
 */
function createTagEndFinder(html: string): (from: number) => number {
  const length = html.length;
  // 0 = not scanned yet, -1 = no end, otherwise the index after `>`.
  const endFrom = new Int32Array(length + 1);
  const visited: number[] = [];
  return (from: number): number => {
    let position = from;
    let end = -1;
    visited.length = 0;
    while (position < length) {
      const known = endFrom[position];
      if (known !== 0) {
        end = known;
        break;
      }
      visited.push(position);
      const code = html.charCodeAt(position);
      if (code === 62) {
        end = position + 1;
        break;
      }
      if (code === 34 || code === 39) {
        const close = html.indexOf(html[position], position + 1);
        if (close < 0) break;
        position = close + 1;
        continue;
      }
      position++;
    }
    for (const index of visited) endFrom[index] = end;
    return end;
  };
}

const COMMENT_OPEN = 1; // `<!--`
const COMMENT_CLOSE = 2; // `-->`
const SCRIPT_START = 4; // `<script` + tag whitespace, `/` or `>`
const SCRIPT_END = 8; // `</script` + tag whitespace, `/` or `>`
const END_TAG = 16; // `</script` followed by anything: maybe a closer

const DATA = 0;
const ESCAPED = 1;
const DOUBLE_ESCAPED = 2;

/** Does `html` hold `name` (lower-case letters) at `at`, in any case? */
const nameAt = (html: string, at: number, name: string): boolean =>
  html.slice(at, at + name.length).toLowerCase() === name;

/**
 * For `<script>` content: where the closer that ends content starting at `contentStart` starts, following
 * the tokenizer's script data states, or -1. `<!--` enters the escaped state and `-->` leaves it; in it,
 * `<script` enters the double-escaped state, where closers are text, and `</script` or `-->` leaves it.
 * Each (token, state) pair is walked once.
 */
function createScriptCloserFinder(
  html: string,
  isCloserAt: (at: number) => boolean,
): (contentStart: number) => number {
  let tokens: { at: number[]; kind: number[] } | undefined;
  const collect = () => {
    const at: number[] = [];
    const kind: number[] = [];
    let less = html.indexOf("<");
    let dash = html.indexOf("-->");
    while (less !== -1 || dash !== -1) {
      if (dash === -1 || (less !== -1 && less < dash)) {
        const code = html.charCodeAt(less + 1);
        let found = 0;
        if (code === 33) {
          if (html.startsWith("--", less + 2)) found = COMMENT_OPEN;
        } else {
          const end = code === 47;
          const nameStart = end ? less + 2 : less + 1;
          if (nameAt(html, nameStart, "script")) {
            const after = html.charCodeAt(nameStart + 6);
            const ends = isTagSpace(after) || after === 47 || after === 62;
            if (!end) found = ends ? SCRIPT_START : 0;
            else found = ends ? SCRIPT_END | END_TAG : END_TAG;
          }
        }
        if (found) {
          at.push(less);
          kind.push(found);
        }
        less = html.indexOf("<", less + 1);
      } else {
        at.push(dash);
        kind.push(COMMENT_CLOSE);
        dash = html.indexOf("-->", dash + 1);
      }
    }
    return { at, kind };
  };
  const memo = new Map<number, number>();
  return (contentStart: number): number => {
    tokens ??= collect();
    const { at, kind } = tokens;
    let low = 0;
    let high = at.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (at[middle] < contentStart) low = middle + 1;
      else high = middle;
    }
    const trace: number[] = [];
    let state = DATA;
    let result = -1;
    for (let index = low; index < at.length; index++) {
      const key = index * 3 + state;
      const known = memo.get(key);
      if (known !== undefined) {
        result = known;
        break;
      }
      trace.push(key);
      const token = kind[index];
      if (state === DOUBLE_ESCAPED) {
        if (token === COMMENT_CLOSE) state = DATA;
        else if (token & SCRIPT_END) state = ESCAPED;
        continue;
      }
      if (token & END_TAG && isCloserAt(at[index])) {
        result = at[index];
        break;
      }
      if (state === DATA) {
        if (token === COMMENT_OPEN) state = ESCAPED;
      } else if (token === COMMENT_CLOSE) state = DATA;
      else if (token === SCRIPT_START) state = DOUBLE_ESCAPED;
    }
    for (const key of trace) memo.set(key, result);
    return result;
  };
}

/**
 * The first `<tag>...</tag>` element whose opener starts at or after `from`, with a non-decreasing `from`.
 * The closer is `</tag`, tag whitespace, `/` or `>`, then anything up to the first `>`.
 */
function createRawElementFinder(
  html: string,
  tag: "script" | "style" | "textarea",
  tagEnd: (from: number) => number,
): (from: number) => RawElement | null {
  const opener = new RegExp(`<${tag}(?=[\\t\\n\\f\\r />])`, "gi");
  const closerStart = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, "giy");
  // The first `>` at or after a position, remembered.
  let gtFrom = Infinity;
  let gtAt = -1;
  const nextGt = (from: number): number => {
    if (!(from >= gtFrom && (gtAt === -1 || from <= gtAt))) {
      gtFrom = from;
      gtAt = html.indexOf(">", from);
    }
    return gtAt;
  };
  const closerEnd = (at: number): number => {
    closerStart.lastIndex = at;
    if (!closerStart.test(html)) return -1;
    const gt = nextGt(at + 2 + tag.length);
    return gt === -1 ? -1 : gt + 1;
  };
  // The first closer at or after a position: remembered, since unclosed openers ask again and again. With no
  // `>` after one closer's name, none follows a later one.
  const anyCloser = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, "gi");
  let closerFrom = Infinity;
  let closerAt = -1;
  const nextCloser = (from: number): number => {
    if (!(from >= closerFrom && (closerAt === -1 || from <= closerAt))) {
      anyCloser.lastIndex = from;
      const match = anyCloser.exec(html);
      closerFrom = from;
      closerAt =
        match && nextGt(match.index + 2 + tag.length) !== -1 ? match.index : -1;
    }
    return closerAt;
  };
  const scriptCloser =
    tag === "script"
      ? createScriptCloserFinder(html, (at) => closerEnd(at) !== -1)
      : undefined;

  let lastFrom = -1;
  let last: RawElement | null | undefined;
  return (from: number): RawElement | null => {
    if (
      last !== undefined &&
      from >= lastFrom &&
      (last === null || from <= last.start)
    )
      return last;
    lastFrom = from;
    last = null;
    opener.lastIndex = from;
    for (
      let match = opener.exec(html);
      match !== null;
      match = opener.exec(html)
    ) {
      const start = match.index;
      opener.lastIndex = start + 1;
      const contentStart = tagEnd(start + 1 + tag.length);
      if (contentStart < 0) continue;
      const contentEnd = scriptCloser
        ? scriptCloser(contentStart)
        : nextCloser(contentStart);
      if (contentEnd < 0) continue;
      last = { start, contentStart, contentEnd, end: closerEnd(contentEnd) };
      break;
    }
    return last;
  };
}

const RAW_TEXT_TAGS = ["script", "style", "textarea"] as const;
const HAS_RAW_TAG = /<(?:script|style|textarea)[\t\n\f\r />]/i;

/**
 * A same-length copy of `html` with comment bodies and raw-text element content blanked, as the compiler's
 * `maskRawTextContent` blanks them.
 */
export function maskLikeCompiler(html: string): string {
  let comments = html.includes("<!--");
  const raw = HAS_RAW_TAG.test(html);
  if (!comments && !raw) return html;
  // Whether a position is inside a tag, read from the end of the last region that started in text.
  let tagsFrom = 0;
  let reader: ((index: number) => TagState) | undefined;
  const insideTag = (at: number): boolean => {
    reader ??= createTagStateReader(html, tagsFrom);
    return reader(at) !== "text";
  };
  const tagEnd = createTagEndFinder(html);
  const finders = raw
    ? RAW_TEXT_TAGS.map((tag) => createRawElementFinder(html, tag, tagEnd))
    : [];
  let masked = "";
  let cursor = 0;
  let position = 0;
  let commentAt = -2;
  for (;;) {
    if (comments && (commentAt === -2 || commentAt < position))
      commentAt = html.indexOf("<!--", position);
    if (commentAt === -1) comments = false;
    let element: RawElement | null = null;
    for (const find of finders) {
      const match = find(position);
      if (match && (!element || match.start < element.start)) element = match;
    }
    if (comments && (!element || commentAt < element.start)) {
      if (insideTag(commentAt)) {
        commentAt = html.indexOf("<!--", commentAt + 1);
        if (commentAt === -1) comments = false;
        continue;
      }
      const end = findCommentEnd(html, commentAt);
      if (end === -1) {
        comments = false;
        continue;
      }
      const closeLength = html.charCodeAt(end - 2) === 0x21 ? 4 : 3;
      const innerLength = end - commentAt - 4 - closeLength;
      if (innerLength > 0) {
        masked += `${html.slice(cursor, commentAt + 4)}${" ".repeat(innerLength)}`;
        cursor = end - closeLength;
      }
      position = end;
      tagsFrom = end;
      reader = undefined;
      continue;
    }
    if (!element) break;
    // An opener inside a tag (an attribute value that reads `<script>`, or `<p<style>`) is part of that tag.
    if (insideTag(element.start)) {
      position = element.start + 1;
      continue;
    }
    masked += `${html.slice(cursor, element.contentStart)}${" ".repeat(element.contentEnd - element.contentStart)}`;
    cursor = element.contentEnd;
    position = element.end;
    tagsFrom = element.end;
    reader = undefined;
  }
  return cursor === 0 ? html : masked + html.slice(cursor);
}

/** `[A-Za-z0-9_-]` or `:`, the run the compiler reads a component name from. */
const isNameRunCode = (code: number): boolean =>
  isWordCode(code) || code === 45 || code === 58;

/**
 * Every component tag in `html` the compiler expands, in order: each `<name` it finds searching on from just
 * after the previous one. `names` holds lower-case component names.
 */
export function findComponentUsages(
  html: string,
  names: ReadonlySet<string>,
  masked = maskLikeCompiler(html),
): ComponentUsage[] {
  const usages: ComponentUsage[] = [];
  if (names.size === 0 || !html.includes("<")) return usages;
  let maxLength = 0;
  for (const name of names) maxLength = Math.max(maxLength, name.length);
  const length = masked.length;
  const tagState = createTagStateReader(masked);
  for (
    let start = masked.indexOf("<");
    start !== -1;
    start = masked.indexOf("<", start + 1)
  ) {
    const nameStart = start + 1;
    const limit = Math.min(length, nameStart + maxLength);
    let nameEnd = -1;
    for (let index = nameStart; index <= limit; index++) {
      const code = masked.charCodeAt(index);
      if (isNameRunCode(code)) continue;
      if (
        index > nameStart &&
        isTagNameEndCode(code) &&
        names.has(masked.slice(nameStart, index).toLowerCase())
      )
        nameEnd = index;
      break;
    }
    if (nameEnd === -1) continue;
    // No `>` after this name means none after any later one either.
    const gt = masked.indexOf(">", nameEnd);
    if (gt === -1) break;
    // Inside a tag or a bogus comment: the compiler searches on after this tag's `>`.
    if (tagState(start) !== "text") {
      start = gt;
      continue;
    }
    usages.push({
      name: masked.slice(nameStart, nameEnd).toLowerCase(),
      start,
      nameStart,
      nameEnd,
    });
  }
  return usages;
}
