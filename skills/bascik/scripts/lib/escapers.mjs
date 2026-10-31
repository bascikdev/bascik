// Find hand-written HTML escapers. Dependency-free; Node.js 22.22+.
//
// Bascik ships `html` from @bascik/bascik/html for building markup in every script and helper: it escapes each value
// for where it lands, blocks javascript: URLs, and throws where escaping cannot help. A hand-written escaper does
// none of that, so the skills ask for `html` instead. Heuristic: an escaper is code that replaces `&` together with
// `<` (a character class such as /[&<>"']/), replaces `&` with `&amp;`, or maps "&" to "&amp;". Code that decodes
// entities (`&amp;` to `&`) is not an escaper. An escaper with a comment saying it writes XML (a feed, a sitemap) is
// left alone: `html` builds HTML, not XML.

const PATTERNS = [
  // .replace(/[&<>"']/g, ...) and .replaceAll(/[<&]/g, ...): a character class that holds both & and <.
  /\.replace(?:All)?\(\s*\/\[(?=[^\]\n]*&)(?=[^\]\n]*<)[^\]\n]*\]\/[a-z]*\s*,/g,
  // .replace(/&/g, "&amp;") and .replaceAll("&", "&amp;").
  /\.replace(?:All)?\(\s*(?:\/&\/[a-z]*|(["'`])&\1)\s*,\s*(["'`])&amp;\2/g,
  // { "&": "&amp;" } and new Map([["&", "&amp;"]]).
  /(["'`])&\1\s*[:,]\s*(["'`])&amp;\2/g,
  // case "&": return "&amp;"
  /\bcase\s+(["'`])&\1\s*:[^\n]*&amp;/g,
];

/** Escapers this close together (in lines) are one escaper: an entity map and the replace that reads it. */
const SAME_ESCAPER_LINES = 10;
/** How many lines above an escaper a comment may sit and still explain it. */
const COMMENT_LINES = 6;
const XML_COMMENT = /\b(?:xml|rss|atom|sitemap)\b/i;
const NAME =
  /(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=|\bfunction\s+([A-Za-z_$][\w$]*)|^\s*(?!(?:if|for|while|switch|catch|return)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{\n]+)?\{)/;

const lineAt = (code, index) => code.slice(0, index).split("\n").length;

/** The comment text on one line of code: a `//` comment, or a line inside or opening a block comment. */
function commentOf(line) {
  const trimmed = line.trim();
  if (/^(?:\/\*|\*)/.test(trimmed)) return trimmed;
  const slashes = line.search(/(?<![:"'`\\])\/\/(?!\/)/);
  return slashes === -1 ? "" : line.slice(slashes);
}

/** True when a comment on the escaper's line, or on the lines just above it, says it writes XML. */
function explainedAsXml(lines, line) {
  for (let n = line; n >= Math.max(1, line - COMMENT_LINES); n--)
    if (XML_COMMENT.test(commentOf(lines[n - 1] ?? ""))) return true;
  return false;
}

/** The name of the function or constant the escaper is written in, from its line or the lines just above it. */
function nameAt(lines, line) {
  for (let n = line; n >= Math.max(1, line - 3); n--) {
    const match = NAME.exec(lines[n - 1] ?? "");
    if (match) return match[1] ?? match[2] ?? match[3];
  }
  return undefined;
}

/**
 * The hand-written HTML escapers in `code`, each `{ line, name }` with a 1-based line (the first line of the escaper,
 * or of its entity map) and the function or constant name when one is found.
 */
export function handWrittenEscapers(code) {
  const lines = code.split("\n");
  const hits = new Set();
  for (const pattern of PATTERNS)
    for (const match of code.matchAll(pattern))
      hits.add(lineAt(code, match.index));
  const out = [];
  for (const hit of [...hits].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && hit - last.hit <= SAME_ESCAPER_LINES) {
      last.hit = hit;
      continue;
    }
    out.push({ start: hit, hit });
  }
  return out
    .map(({ start, hit }) => {
      // Report the line that starts the statement: the `const` above a wrapped arrow body, say.
      let line = start;
      for (let n = start; n >= Math.max(1, start - 3); n--)
        if (NAME.test(lines[n - 1] ?? "")) {
          line = n;
          break;
        }
      // Name it from its last line: the replace that reads an entity map sits in the function.
      return { line, name: nameAt(lines, hit) ?? nameAt(lines, start) };
    })
    .filter(({ line }) => !explainedAsXml(lines, line));
}

/** True for a test file, which may write an escaper to state the output it expects. */
export const isTestFile = (path) =>
  /(?:^|[\\/])__tests__[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
