// A small, tolerant HTML tree builder for the skill scripts. Dependency-free; Node.js 22.22+.
// Heuristic by design: it never throws on broken markup, keeps 1-based line numbers for every element, and never
// reads markup inside comments, <script>, <style>, <textarea>, or <title>. The compiler is the authority on output.

export const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// An opening tag of one of these closes an open sibling of the listed tags, as the HTML parser does.
const IMPLIED_END = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
  p: ["p"],
};

// An unquoted value runs to whitespace, quotes, `=` and backticks included, as the tokenizer reads it.
const ATTRIBUTE =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'][^\s]*)))?/g;

const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const SPACE = /\s/;
// JavaScript's `\s`, as the attribute reader uses it.
const isSpace = (code) =>
  code < 128
    ? code === 32 || (code >= 9 && code <= 13)
    : SPACE.test(String.fromCharCode(code));
const isLetter = (code) =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
// `\w`
const isWordChar = (code) =>
  isLetter(code) || (code >= 48 && code <= 57) || code === 95;
// `[\w:.-]`
const isTagNameChar = (code) =>
  isWordChar(code) || code === 58 || code === 46 || code === 45;

/**
 * A hand tokenizer over `text`, so the work stays linear however many tags never close: a search that finds nothing
 * remembers it, so no later one from further on reads the text again, and no tag scan reads past the next `<` outside
 * a quoted value.
 */
class Scanner {
  constructor(text) {
    this.text = text;
    // For each needle searched for, the offset from which it is known not to appear.
    this.absentFrom = new Map();
  }

  /** `text.indexOf(needle, from)`, remembering a miss. */
  indexOf(needle, from) {
    const absent = this.absentFrom.get(needle);
    if (absent !== undefined && from >= absent) return -1;
    const at = this.text.indexOf(needle, from);
    if (at < 0) this.absentFrom.set(needle, from);
    return at;
  }

  /**
   * The offset of the `>` that ends a tag whose attribute text starts at `from`, or -1 when the tag does not close.
   * The attribute text is read as the HTML tokenizer reads it: a quote opens a quoted value only right after `=` (and
   * whitespace), so `title=it's` is an unquoted value with an apostrophe in it, not the start of a string that
   * swallows the next tags. An unquoted value is read whole, to whitespace or `>`, so an `=` inside it
   * (`data-x=a"b="`) opens no new value.
   *
   * A `<` outside a quoted value ends the scan and leaves the tag unclosed; reading goes on from that `<`, which can
   * open the next element. The browser reads such a `<` into an attribute name or an unquoted value (a parse error),
   * so to it `<p class="lead"<h1>` is one paragraph tag. Stopping there keeps the heading after a forgotten `>` in the
   * audit, and keeps the scan linear: without it, every `<` of a run of tags that never close started a scan to the
   * end of the input.
   */
  tagEnd(from) {
    const { text } = this;
    let at = from;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code === 62) return at; // >
      if (code === 60) return -1; // <
      at++;
      if (code !== 61) continue;
      // After `=`: optional whitespace, then a quoted value, an unquoted one, or no value before `>`.
      while (at < text.length && isSpace(text.charCodeAt(at))) at++;
      const first = text.charCodeAt(at);
      if (first === 34 || first === 39) {
        const close = this.indexOf(first === 34 ? '"' : "'", at + 1);
        if (close < 0) return -1;
        at = close + 1;
        continue;
      }
      if (first === 62) return at;
      for (; at < text.length; at++) {
        const c = text.charCodeAt(at);
        if (c === 62 || isSpace(c)) break;
        if (c === 60) return -1;
      }
    }
    return -1;
  }

  /**
   * The first tag at or after `from`, as `{ start, end, closing, name, attributes }` with `end` just past its `>`, or
   * undefined. A `<` that opens no tag (`a < b`, a tag that does not close) is skipped: the browser keeps it as text.
   */
  nextTag(from) {
    const { text } = this;
    for (
      let at = text.indexOf("<", from);
      at >= 0;
      at = text.indexOf("<", at + 1)
    ) {
      const closing = text.charCodeAt(at + 1) === 47; // /
      const nameStart = closing ? at + 2 : at + 1;
      if (!isLetter(text.charCodeAt(nameStart))) continue;
      let nameEnd = nameStart + 1;
      while (nameEnd < text.length && isTagNameChar(text.charCodeAt(nameEnd)))
        nameEnd++;
      const close = this.tagEnd(nameEnd);
      if (close < 0) continue;
      return {
        start: at,
        end: close + 1,
        closing,
        name: text.slice(nameStart, nameEnd),
        attributes: text.slice(nameEnd, close),
      };
    }
    return undefined;
  }

  /**
   * The `</tag>` (any case, whitespace allowed before `>`) that ends a raw-text body starting at `from`, or undefined.
   * `tag` is lower case.
   */
  rawTextEnd(tag, from) {
    const { text } = this;
    const key = `</${tag}`;
    const absent = this.absentFrom.get(key);
    if (absent !== undefined && from >= absent) return undefined;
    for (
      let at = this.indexOf("</", from);
      at >= 0;
      at = this.indexOf("</", at + 2)
    ) {
      let end = at + key.length;
      if (text.slice(at + 2, end).toLowerCase() !== tag) continue;
      while (end < text.length && isSpace(text.charCodeAt(end))) end++;
      if (text.charCodeAt(end) === 62) return { start: at, end: end + 1 };
    }
    this.absentFrom.set(key, from);
    return undefined;
  }
}

const keepLines = (text) => text.replace(/[^\n]/g, " ");

/** Blank every comment, keeping its newlines. One with no `-->` after it is left as text, and so is every later one. */
function maskComments(html) {
  let out = "";
  let copied = 0;
  for (;;) {
    const open = html.indexOf("<!--", copied);
    if (open < 0) break;
    const close = html.indexOf("-->", open + 4);
    if (close < 0) break;
    out += html.slice(copied, open) + keepLines(html.slice(open, close + 3));
    copied = close + 3;
  }
  return out + html.slice(copied);
}

/** Blank comments and raw-text element bodies, keeping every newline so offsets and lines still match the source. */
export function maskKeepingLines(html) {
  const text = maskComments(html);
  const scanner = new Scanner(text);
  let out = "";
  let copied = 0;
  for (let at = text.indexOf("<"); at >= 0;) {
    // `<script`, `<style`, `<textarea` or `<title` before a character that is not `\w` (so `<script-x` counts too),
    // then the rest of its open tag, its body, and its end tag.
    let nameEnd = at + 1;
    while (nameEnd < text.length && isWordChar(text.charCodeAt(nameEnd)))
      nameEnd++;
    const tag = text.slice(at + 1, nameEnd).toLowerCase();
    const openTagClose = RAW_TEXT_TAGS.has(tag) ? scanner.tagEnd(nameEnd) : -1;
    const close =
      openTagClose < 0 ? undefined : scanner.rawTextEnd(tag, openTagClose + 1);
    if (!close) {
      at = text.indexOf("<", at + 1);
      continue;
    }
    out +=
      text.slice(copied, openTagClose + 1) +
      keepLines(text.slice(openTagClose + 1, close.start));
    copied = close.start;
    at = text.indexOf("<", close.end);
  }
  return out + text.slice(copied);
}

/** Offsets where each line starts, for `lineAt`. */
export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line of `index`. */
export function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export function parseAttributes(text) {
  const attrs = {};
  for (const m of text.replace(/\/\s*$/, "").matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/**
 * Parse `html` into a tree. Every element is `{ tag, attrs, line, endLine, start, end, children, parent }`;
 * `<script>` and `<style>` elements also carry `body`, their raw text. The root is `{ tag: "#root", children }`.
 */
export function parseMarkup(html) {
  const masked = maskKeepingLines(html);
  const starts = lineStarts(html);
  const root = {
    tag: "#root",
    attrs: {},
    start: 0,
    end: html.length,
    line: 1,
    endLine: starts.length,
    children: [],
    parent: undefined,
  };
  const stack = [root];
  const finish = (node, end, innerEnd) => {
    node.end = end;
    node.endLine = lineAt(starts, Math.max(node.start, end - 1));
    if (node.tag === "script" || node.tag === "style")
      node.body = html.slice(node.openEnd, innerEnd).trim();
  };

  const scanner = new Scanner(masked);
  for (
    let m = scanner.nextTag(0);
    m !== undefined;
    m = scanner.nextTag(m.end)
  ) {
    const tag = m.name.toLowerCase();
    const { end } = m;
    if (m.closing) {
      let at = stack.length - 1;
      while (at > 0 && stack[at].tag !== tag) at--;
      if (at === 0) continue; // A stray closing tag: ignore it, as the browser does.
      for (let i = stack.length - 1; i > at; i--)
        finish(stack[i], m.start, m.start);
      finish(stack[at], end, m.start);
      stack.length = at;
      continue;
    }
    const peers = IMPLIED_END[tag];
    const top = stack[stack.length - 1];
    if (peers && peers.includes(top.tag)) {
      finish(top, m.start, m.start);
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const node = {
      tag,
      attrs: parseAttributes(m.attributes),
      start: m.start,
      openEnd: end,
      end,
      line: lineAt(starts, m.start),
      endLine: lineAt(starts, m.start),
      children: [],
      parent,
    };
    parent.children.push(node);
    if (VOID_ELEMENTS.has(tag) || /\/\s*$/.test(m.attributes))
      finish(node, end, end);
    else stack.push(node);
  }
  for (let i = stack.length - 1; i > 0; i--)
    finish(stack[i], html.length, html.length);
  return root;
}

/** Visit every element under `node` depth first; return false from `visit` to skip an element's children. */
export function walkElements(node, visit) {
  for (const child of node.children) {
    if (visit(child) !== false) walkElements(child, visit);
  }
}

/** Non-blank lines of `text` between two offsets. */
export function countNonBlankLines(text, start = 0, end = text.length) {
  let count = 0;
  for (const line of text.slice(start, end).split("\n"))
    if (line.trim()) count++;
  return count;
}
