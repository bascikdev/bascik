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
  // case "&": return "&amp;", also with the return on the next line as Prettier writes it.
  new RegExp(`\\bcase\\s+(${Q})&\\1\\s*:\\s*[^\\n]*${AMP}`, "g"),
];
/** The patterns that find an entity map rather than code that replaces: { "&": "&amp;" } and case "&":. */
const ENTITY_MAPS = PATTERNS.slice(3);
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

const indentOf = (line) => /^\s*/.exec(line ?? "")[0].length;

/**
 * The name of the function the escaper is written in, from its line or the lines just above it. A block closed at
 * the escaper's own level or outside it (`}`) ends the search, so a name is never borrowed from an earlier function.
 * After a finished statement (`;`) above the escaper, only a function that opens a block around the escaper counts.
 */
function nameAt(lines, line) {
  const indent = indentOf(lines[line - 1]);
  let afterStatement = false;
  for (let n = line; n >= Math.max(1, line - STATEMENT_LINES); n--) {
    const text = lines[n - 1] ?? "";
    if (n < line) {
      const trimmed = text.trim();
      if (/\}[\s;,)]*$/.test(trimmed) && indentOf(text) <= indent) break;
      if (/[;}]$/.test(trimmed)) {
        afterStatement = true;
        continue;
      }
    }
    const match = NAME.exec(text);
    if (!match) continue;
    if (afterStatement && !(indentOf(text) < indent && /\{\s*$/.test(text)))
      continue;
    return match[1] ?? match[2] ?? match[3];
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
      const map = ENTITY_MAPS.includes(pattern);
      const reader = pattern === PATTERNS[0];
      const known = hits.get(line);
      if (!known)
        hits.set(line, { kind: strip ? "strip" : "escape", map, reader });
      else {
        if (!strip) known.kind = "escape";
        known.map &&= map;
        known.reader ||= reader;
      }
    }
  // Each hit is judged on its own: its function's name and whether it explains itself as XML. Hits close together
  // join one escaper only in two cases: two lines of the same function (same name, same explanation), or an entity
  // map and the function that reads it. Only that map case shares an XML explanation, so a replace chain beside an
  // escapeXml never hides behind it, and an escapeXml beside an escapeHtml never hides the HTML one.
  const out = [];
  for (const hit of [...hits.keys()].sort((a, b) => a - b)) {
    const { kind, map, reader } = hits.get(hit);
    const name = nameAt(lines, hit);
    const xml = explainedAsXml(lines, statementLine(lines, hit), name);
    const last = out.at(-1);
    const near = last && hit - last.hit <= SAME_ESCAPER_LINES;
    // An unnamed entity map belongs to the character-class replace just above it that reads it, and a
    // character-class replace reads the unnamed map just above it. A replace that writes its own entities reads no
    // map, so it never joins one, and never shares an XML explanation with one.
    const mapCase =
      near &&
      ((map && name === undefined && last.reader) ||
        (last.map && last.name === undefined && reader));
    const sameFunction = near && name === last.name && xml === last.xml;
    if (mapCase || sameFunction) {
      last.hit = hit;
      last.name ??= name;
      if (mapCase) last.xml ||= xml;
      last.map &&= map;
      last.reader ||= reader;
      if (kind === "escape") last.kind = "escape";
      continue;
    }
    out.push({ start: hit, hit, kind, name, xml, map, reader });
  }
  return out
    .filter(({ xml }) => !xml)
    .map(({ start, kind, name }) => ({
      line: statementLine(lines, start),
      name,
      kind,
    }));
}

/** True for a test file, which may write an escaper to state the output it expects. */
export const isTestFile = (path) =>
  /(?:^|[\\/])__tests__[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
