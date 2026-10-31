// Find hand-written HTML escapers. Dependency-free; Node.js 22.22+.
//
// Bascik ships `html` from @bascik/bascik/html for building markup in every script and helper: it escapes each value
// for where it lands, blocks javascript: URLs, and throws where escaping cannot help. A hand-written escaper does
// none of that, so the skills ask for `html` instead. Heuristic: an escaper is code that replaces `&` together with
// `<` (a character class such as /[&<>"']/), replaces `&` with an entity (`&amp;`, `&#38;` or `&#x26;`, also through
// a lookahead such as /&(?!amp;)/ or split("&").join(...)), or maps "&" to one. A character class replaced with an
// empty string is a stripper: it deletes the characters instead of escaping them. Code that decodes entities (`&amp;`
// to `&`) is neither. An escaper whose name says XML or SVG (escapeXml), or whose comment directly above it says it
// writes XML (a feed, a sitemap) without also speaking of HTML, is left alone: `html` builds HTML, not XML.

/** `&` written as an entity: &amp; &#38; &#x26; */
const AMP = "&(?:amp|#0*38|#x0*26);";
/** A quote character: ", ' or a backtick. */
const Q = "[\"'\\x60]";
/** A regular expression literal that matches `&`, alone or with a lookahead: /&/g, /&(?!amp;)/g, /&(?!#?\w+;)/g */
const AMP_REGEX = "\\/&(?:\\(\\?![^)\\n]*\\))?\\/[a-z]*";

const PATTERNS = [
  // .replace(/[&<>"']/g, ...) and .replaceAll(/[<&]/g, ...): a character class that holds both & and <.
  /\.replace(?:All)?\(\s*\/\[(?=[^\]\n]*&)(?=[^\]\n]*<)[^\]\n]*\]\/[a-z]*\s*,/g,
  // .replace(/&/g, "&amp;"), .replace(/&(?!amp;)/g, "&#38;") and .replaceAll("&", "&#x26;").
  new RegExp(
    `\\.replace(?:All)?\\(\\s*(?:${AMP_REGEX}|(${Q})&\\1)\\s*,\\s*(${Q})${AMP}\\2`,
    "g",
  ),
  // .split("&").join("&amp;")
  new RegExp(
    `\\.split\\(\\s*(${Q})&\\1\\s*\\)\\s*\\.join\\(\\s*(${Q})${AMP}\\2`,
    "g",
  ),
  // { "&": "&amp;" } and new Map([["&", "&#38;"]]).
  new RegExp(`(${Q})&\\1\\s*[:,]\\s*(${Q})${AMP}\\2`, "g"),
  // case "&": return "&amp;"
  new RegExp(`\\bcase\\s+(${Q})&\\1\\s*:[^\\n]*${AMP}`, "g"),
];
/** What follows a character-class match when the characters are deleted: an empty string. */
const EMPTY_REPLACEMENT = new RegExp(`^\\s*(${Q})\\1\\s*\\)`);

/** Escapers this close together (in lines) are one escaper: an entity map and the replace that reads it. */
const SAME_ESCAPER_LINES = 10;
/** How many lines of a comment block directly above an escaper are read. */
const COMMENT_LINES = 6;
/** How many lines above an escaper its statement or function may start. */
const STATEMENT_LINES = 3;
const XML_WORDS = /\b(?:xml|rss|atom|sitemap|svg)\b/i;
const XML_NAME = /xml|svg|rss|atom|sitemap/i;
/** "not HTML" in an XML comment is part of the explanation, not a second subject. */
const NOT_HTML = /\b(?:not|isn't)\s+(?:an?\s+)?html\b/gi;
/**
 * A line that starts a named function: `function name(`, `const name = (...) =>`, `= async (`, `= x =>`,
 * `= function`, a parameter list wrapped onto the next lines, or a method `name(...) {`. A `const` that holds a
 * value is not one, so the variable a result lands in is never taken for the escaper's name.
 */
const NAME =
  /(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=\n]+)?=>|\([^)]*$|[A-Za-z_$][\w$]*\s*=>)|\bfunction\s+([A-Za-z_$][\w$]*)|^\s*(?!(?:if|for|while|switch|catch|return|function)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{\n]+)?\{)/;
/** A line that starts a declaration, function or not: where a wrapped statement such as an entity map begins. */
const DECLARATION = /^\s*(?:export\s+)?(?:const|let|var|function)\b/;

const lineAt = (code, index) => code.slice(0, index).split("\n").length;

/** The comment text on one line of code: a `//` comment, or a line inside, opening or closing a block comment. */
function commentOf(line) {
  const trimmed = line.trim();
  if (/^(?:\/\*|\*)/.test(trimmed) || trimmed.endsWith("*/")) return trimmed;
  const slashes = line.search(/(?<![:"'`\\])\/\/(?!\/)/);
  return slashes === -1 ? "" : line.slice(slashes);
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    /^(?:\/\*|\*)/.test(trimmed) ||
    trimmed.endsWith("*/")
  );
}

/**
 * True when the escaper explains itself as XML: its name says XML or SVG, or the comment on its line or the comment
 * block directly above it (no code in between) speaks of XML and not also of HTML.
 */
function explainedAsXml(lines, line, name) {
  if (name && XML_NAME.test(name)) return true;
  const comments = [commentOf(lines[line - 1] ?? "")];
  for (let n = line - 1; n >= Math.max(1, line - COMMENT_LINES); n--) {
    const text = lines[n - 1] ?? "";
    if (!isCommentLine(text)) break;
    comments.push(commentOf(text));
  }
  const text = comments.join(" ").replace(NOT_HTML, "");
  return XML_WORDS.test(text) && !/\bhtml\b/i.test(text);
}

/** The name of the function the escaper is written in, from its line or the lines just above it. */
function nameAt(lines, line) {
  for (let n = line; n >= Math.max(1, line - STATEMENT_LINES); n--) {
    const match = NAME.exec(lines[n - 1] ?? "");
    if (match) return match[1] ?? match[2] ?? match[3];
  }
  return undefined;
}

/**
 * The line that starts the escaper's statement: the `const` above a wrapped arrow body or an entity map, never a
 * line above the end of an earlier statement.
 */
function statementLine(lines, start) {
  for (let n = start; n >= Math.max(1, start - STATEMENT_LINES); n--) {
    const text = lines[n - 1] ?? "";
    if (NAME.test(text) || DECLARATION.test(text)) return n;
    const above = (lines[n - 2] ?? "").trim();
    if (above === "" || /[;}]$/.test(above)) break;
  }
  return start;
}

/**
 * The hand-written HTML escapers in `code`, each `{ line, name, kind }`: a 1-based line (the first line of the
 * escaper's statement, or of its entity map), the function's name when one is found, and `kind` "escape" for code
 * that writes entities or "strip" for code that deletes the characters.
 */
export function handWrittenEscapers(code) {
  const lines = code.split("\n");
  const hits = new Map();
  for (const pattern of PATTERNS)
    for (const match of code.matchAll(pattern)) {
      const line = lineAt(code, match.index);
      const strip =
        pattern === PATTERNS[0] &&
        EMPTY_REPLACEMENT.test(code.slice(match.index + match[0].length));
      if (!strip || !hits.has(line)) hits.set(line, strip ? "strip" : "escape");
    }
  const out = [];
  for (const hit of [...hits.keys()].sort((a, b) => a - b)) {
    const kind = hits.get(hit);
    const last = out.at(-1);
    if (last && hit - last.hit <= SAME_ESCAPER_LINES) {
      last.hit = hit;
      if (kind === "escape") last.kind = "escape";
      continue;
    }
    out.push({ start: hit, hit, kind });
  }
  return out
    .map(({ start, hit, kind }) => ({
      line: statementLine(lines, start),
      // Name it from its last line: the replace that reads an entity map sits in the function.
      name: nameAt(lines, hit) ?? nameAt(lines, start),
      kind,
    }))
    .filter(({ line, name }) => !explainedAsXml(lines, line, name));
}

/** True for a test file, which may write an escaper to state the output it expects. */
export const isTestFile = (path) =>
  /(?:^|[\\/])__tests__[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
