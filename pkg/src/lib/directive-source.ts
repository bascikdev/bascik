/**
 * @module directive-source
 *
 * Where a directive script (`data-bascik-build`, `-server`, `-stream`,
 * `-routes`) sits in the file it was written in, so its errors name the file's
 * own lines.
 *
 * A directive script runs as a module of its own, and V8 numbers that module's
 * lines from 1. The position has to be known to map those lines back. It
 * cannot be read off the HTML the script is finally run from: by then a
 * component's `<style>` blocks are extracted, a dynamic route's routes script
 * is removed, components are expanded into the page, and the HTML may be
 * minified. So the position is recorded on the tag as soon as the raw file is
 * read (`stampDirectiveSources`), and read back when the script runs
 * (`directiveSourcePosition`).
 *
 * The module is then padded (`padToSourcePosition`) so its first character
 * lands on the line and column it has in the file. V8 then reports file lines
 * and columns directly, with nothing to remap.
 */
import {
  scanAlternatives,
  type ScanAlternative,
} from "./element-content-scan.ts";
import {
  ANY_DIRECTIVE_ATTR_NAME,
  getHtmlAttributeValue,
} from "./html-patterns.ts";

const SOURCE_FILE_ATTRIBUTE = "data-bascik-source-file";
/** The line the script's body starts on: the line of the `>` that ends its opening tag. */
const SOURCE_LINE_ATTRIBUTE = "data-bascik-source-line";
/** The column the script's body starts at on that line. */
const SOURCE_COLUMN_ATTRIBUTE = "data-bascik-source-column";
/** `line:column` of the opening tag's `<`, for error headers and the dev overlay. */
const SOURCE_TAG_ATTRIBUTE = "data-bascik-source-tag";

const DIRECTIVE_SCRIPT_RE = new RegExp(
  String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`,
  "i",
);
/**
 * A comment, a `<style>` or `<textarea>` element, or a whole script element.
 * Each match consumes its contents, so a tag-like string inside one (a
 * `"<script data-bascik-server>"` or a `"<!--"` in a browser script) is never
 * read as a tag. Only a script element's opening tag is ever rewritten.
 *
 * This is the regex
 * `<!--[\s\S]*?-->|<(style|textarea)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?<\/script(?:[\t\n\f\r /][^>]*)?>)`
 * (flags `gi`), scanned in linear time: the regex retried from every opener
 * that had no closer or no `>`.
 */
const SKIPPED_OR_SCRIPT: readonly ScanAlternative[] = [
  { kind: "comment" },
  {
    kind: "element",
    name: "style",
    options: { opener: "word-boundary", closer: "regex-space" },
  },
  {
    kind: "element",
    name: "textarea",
    options: { opener: "word-boundary", closer: "regex-space" },
  },
  {
    kind: "element",
    name: "script",
    options: { opener: "word-boundary", closer: "attributes" },
  },
];
const SCRIPT_ALTERNATIVE = 3;

export interface DirectiveSourcePosition {
  /** The file the script was written in, when it is recorded on the tag. */
  sourceFile?: string;
  /** 1-based line and column of the opening tag's `<`. */
  tagLine: number;
  tagColumn: number;
  /** 1-based line and column of the script body's first character. */
  bodyLine: number;
  bodyColumn: number;
}

/** 1-based line and column of `offset` in `text`. */
const lineAndColumn = (
  text: string,
  offset: number,
): { line: number; column: number } => {
  let line = 1;
  let lineStart = 0;
  for (
    let index = text.indexOf("\n");
    index !== -1 && index < offset;
    index = text.indexOf("\n", index + 1)
  ) {
    line++;
    lineStart = index + 1;
  }
  return { line, column: offset - lineStart + 1 };
};

/** The position of a script whose opening tag starts at `index` in `html`, measured in `html` itself. */
const measure = (
  html: string,
  index: number,
  openTag: string,
): Omit<DirectiveSourcePosition, "sourceFile"> => {
  const tag = lineAndColumn(html, index);
  const body = lineAndColumn(html, index + openTag.length);
  return {
    tagLine: tag.line,
    tagColumn: tag.column,
    bodyLine: body.line,
    bodyColumn: body.column,
  };
};

/**
 * Records file, line, and column on every directive script in a file that was
 * just read from disk. The attributes add no newlines, so positions measured
 * later in the same text are unaffected. Scripts inside comments, tag-like
 * text inside other scripts, `<style>`, or `<textarea>`, and scripts that
 * already carry a position are left alone.
 */
export const stampDirectiveSources = (
  html: string,
  sourceFile: string,
): string => {
  if (!html.includes("data-bascik-")) return html;
  const encodedFile = encodeURIComponent(sourceFile);
  let result = "";
  let cursor = 0;
  for (const match of scanAlternatives(html, SKIPPED_OR_SCRIPT)) {
    if (match.alternative !== SCRIPT_ALTERNATIVE) continue;
    const openTag = html.slice(match.start, match.contentStart);
    if (!DIRECTIVE_SCRIPT_RE.test(openTag)) continue;
    result +=
      html.slice(cursor, match.start) +
      stampOpenTag(html, match.start, openTag, encodedFile);
    cursor = match.contentStart;
  }
  return cursor === 0 ? html : result + html.slice(cursor);
};

/** One directive opening tag with its position added, or unchanged when it already has one. */
const stampOpenTag = (
  html: string,
  index: number,
  openTag: string,
  encodedFile: string,
): string => {
  if (
    getHtmlAttributeValue(openTag, SOURCE_LINE_ATTRIBUTE) !== undefined ||
    getHtmlAttributeValue(openTag, SOURCE_COLUMN_ATTRIBUTE) !== undefined
  ) {
    return openTag;
  }
  const position = measure(html, index, openTag);
  const attributes: string[] = [];
  if (getHtmlAttributeValue(openTag, SOURCE_FILE_ATTRIBUTE) === undefined) {
    attributes.push(`${SOURCE_FILE_ATTRIBUTE}="${encodedFile}"`);
  }
  attributes.push(
    `${SOURCE_LINE_ATTRIBUTE}="${position.bodyLine}"`,
    `${SOURCE_COLUMN_ATTRIBUTE}="${position.bodyColumn}"`,
    `${SOURCE_TAG_ATTRIBUTE}="${position.tagLine}:${position.tagColumn}"`,
  );
  return `${openTag.slice(0, -1)} ${attributes.join(" ")}>`;
};

/**
 * Where the script whose opening tag is `openTag` (at `index` in `html`) was
 * written. Uses the position recorded when its file was read. Without one, the
 * script is taken to be in `html` as written, which holds for HTML that was
 * never transformed.
 */
export const directiveSourcePosition = (
  html: string,
  index: number,
  openTag: string,
): DirectiveSourcePosition => {
  const encodedFile = getHtmlAttributeValue(openTag, SOURCE_FILE_ATTRIBUTE);
  const sourceFile = encodedFile ? decodeURIComponent(encodedFile) : undefined;
  const bodyLine = Number(
    getHtmlAttributeValue(openTag, SOURCE_LINE_ATTRIBUTE),
  );
  const bodyColumn = Number(
    getHtmlAttributeValue(openTag, SOURCE_COLUMN_ATTRIBUTE),
  );
  const [tagLine, tagColumn] = (
    getHtmlAttributeValue(openTag, SOURCE_TAG_ATTRIBUTE) ?? ""
  )
    .split(":")
    .map(Number);
  if (bodyLine > 0 && bodyColumn > 0 && tagLine > 0 && tagColumn > 0) {
    return { sourceFile, tagLine, tagColumn, bodyLine, bodyColumn };
  }
  const measured = measure(html, index, openTag);
  // A line recorded without a column (an older stamp, or a hand-written one in a test) still wins.
  if (bodyLine > 0)
    return {
      ...measured,
      sourceFile,
      bodyLine,
      bodyColumn: bodyColumn > 0 ? bodyColumn : 1,
    };
  return { ...measured, sourceFile };
};

/** Reads the recorded body column from an opening tag, for the server-script sidecar. */
export const directiveSourceColumn = (openTag: string): number | undefined => {
  const column = Number(
    getHtmlAttributeValue(openTag, SOURCE_COLUMN_ATTRIBUTE),
  );
  return column > 0 ? column : undefined;
};

/**
 * Where the first non-whitespace character of `body` is in the file, when
 * `body` starts at `line`:`column`. For a module made of the trimmed body:
 * module line 1 is file line `line`, and its columns shift by `columnOffset`
 * (later lines keep their indentation, so their columns do not shift).
 */
export const trimmedStartPosition = (
  body: string,
  line: number,
  column: number,
): { line: number; columnOffset: number } => {
  const leading = body.slice(0, body.length - body.trimStart().length);
  const newlines = leading.split("\n").length - 1;
  if (newlines === 0)
    return { line, columnOffset: column - 1 + leading.length };
  return {
    line: line + newlines,
    columnOffset: leading.length - (leading.lastIndexOf("\n") + 1),
  };
};

/**
 * Puts `code` at `line`:`column` of a module, so V8 reports the file's own
 * lines and columns. `code` must be the script body exactly as written,
 * untrimmed, for the columns of its first line to hold.
 */
export const padToSourcePosition = (
  code: string,
  line: number,
  column = 1,
): string =>
  "\n".repeat(Math.max(0, line - 1)) +
  " ".repeat(Math.max(0, column - 1)) +
  code;
