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

const RAW_TEXT =
  /(<(script|style|textarea|title)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi;
const TAG = /<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const keepLines = (text) => text.replace(/[^\n]/g, " ");

/** Blank comments and raw-text element bodies, keeping every newline so offsets and lines still match the source. */
export function maskKeepingLines(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, keepLines)
    .replace(
      RAW_TEXT,
      (_match, open, _tag, body, close) => open + keepLines(body) + close,
    );
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

  for (const m of masked.matchAll(TAG)) {
    const tag = m[2].toLowerCase();
    const end = m.index + m[0].length;
    if (m[1] === "/") {
      let at = stack.length - 1;
      while (at > 0 && stack[at].tag !== tag) at--;
      if (at === 0) continue; // A stray closing tag: ignore it, as the browser does.
      for (let i = stack.length - 1; i > at; i--)
        finish(stack[i], m.index, m.index);
      finish(stack[at], end, m.index);
      stack.length = at;
      continue;
    }
    const peers = IMPLIED_END[tag];
    const top = stack[stack.length - 1];
    if (peers && peers.includes(top.tag)) {
      finish(top, m.index, m.index);
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const node = {
      tag,
      attrs: parseAttributes(m[3]),
      start: m.index,
      openEnd: end,
      end,
      line: lineAt(starts, m.index),
      endLine: lineAt(starts, m.index),
      children: [],
      parent,
    };
    parent.children.push(node);
    if (VOID_ELEMENTS.has(tag) || /\/\s*$/.test(m[3])) finish(node, end, end);
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
