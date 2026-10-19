import { fileURLToPath, pathToFileURL } from "node:url";
import type { SpecifierEdit } from "./module-specifiers.ts";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Bascik's own modules: the files directly in this directory, by file URL or by
 * path (either separator). A user's error that crossed Bascik on its way up (a
 * server script awaited by the request handler) carries frames from them; they
 * say nothing about the user's code. Files in subdirectories (test fixtures)
 * are not Bascik's modules, so their frames are kept.
 */
const BASCIK_LIB_URL = new URL("./", import.meta.url).href;
const BASCIK_LIB_PATH = fileURLToPath(BASCIK_LIB_URL);
const BASCIK_MODULE_FRAME_RE = new RegExp(
  `(?:${[BASCIK_LIB_URL, BASCIK_LIB_PATH, BASCIK_LIB_PATH.replace(/\\/g, "/")].map(escapeRegExp).join("|")})[^/\\\\\\s():]+:\\d+`,
);
/**
 * Set to `1` to keep Bascik's own frames, for when the failure starts inside
 * Bascik (a module hook, the request handler) rather than in the user's code.
 */
export const KEEP_INTERNAL_FRAMES_ENV = "BASCIK_KEEP_INTERNAL_FRAMES";
const isBascikFrame = (line: string): boolean =>
  process.env[KEEP_INTERNAL_FRAMES_ENV] !== "1" && BASCIK_MODULE_FRAME_RE.test(line);

/** The column in the source for `column` on `line` of a module whose specifiers were rewritten by `edits`. */
const sourceColumnFor = (edits: readonly SpecifierEdit[], line: number, column: number): number => {
  let shift = 0;
  for (const edit of edits) {
    if (edit.line !== line) continue;
    const start = edit.column + shift;
    const end = start + edit.newLength;
    if (column < start) break;
    // Inside the rewritten specifier: the start of the specifier as written.
    if (column < end) return edit.column;
    shift += edit.newLength - edit.oldLength;
  }
  return column - shift;
};

/**
 * Puts columns back where they are in the source, in frames of a module whose
 * import specifiers Bascik rewrote to file URLs (longer than `./x.ts`). Only
 * frames naming one of `moduleReferences` (the names V8 gives that module) are
 * changed, and only on lines with a rewrite. `edits` are in module coordinates.
 */
export const remapRewrittenColumns = (
  rawTrace: string,
  moduleReferences: readonly string[],
  edits: readonly SpecifierEdit[],
): string => {
  if (!rawTrace || edits.length === 0) return rawTrace;
  const references = moduleReferences.filter(Boolean).map(escapeRegExp).join("|");
  if (!references) return rawTrace;
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const frameRe = new RegExp(`(?<![\\w./-])((?:${references})(?:\\?bascik-gen=\\d+)?):(\\d+):(\\d+)`, "g");
  return rawTrace.replace(frameRe, (_match, reference: string, lineText: string, columnText: string) => {
    const line = Number(lineText);
    return `${reference}:${line}:${sourceColumnFor(edits, line, Number(columnText))}`;
  });
};

/** A stack frame that names a source location (`file:line:column`), as opposed to a builtin such as `Promise.all (index 1)`. */
const hasLocation = (line: string): boolean => /:\d+:\d+\)?\s*$/.test(line);
const isFrame = (line: string): boolean => line.trimStart().startsWith("at ");

/**
 * Clean and remap stack traces from ephemeral script files back to the original
 * source template file and line offset.
 */
export const cleanStackTrace = (
  rawTrace: string,
  tmpPath: string,
  realPath: string,
  lineOffset: number,
  /** Added to columns on the module's first line, for a module whose first line starts mid-line in the file. */
  firstLineColumnOffset = 0,
): string => {
  if (!rawTrace) return rawTrace;

  // Match file:// URLs, POSIX paths, Windows backslash paths, and forward-slash Windows paths.
  const normalizedTmpPath = tmpPath.replace(/\\/g, "/");
  let fileUri = `file://${normalizedTmpPath}`;
  try {
    fileUri = pathToFileURL(tmpPath).href;
  } catch { }
  const tripleSlashFileUri = `file:///${normalizedTmpPath.replace(/^\/+/, "")}`;
  const posixFileUri = `file://${normalizedTmpPath}`;
  const candidates = [...new Set([fileUri, tripleSlashFileUri, posixFileUri, tmpPath, normalizedTmpPath])].map(escapeRegExp);

  // In development the registry imports each generation under
  // `?bascik-gen=N`, and V8 reports that full URL in stack frames. The query
  // is optional here so every generation remaps to the same authored source.
  const regex = new RegExp(`(?:${candidates.join("|")})(?:\\?bascik-gen=\\d+)?:(\\d+)(?::(\\d+))?`, "g");

  const mappedTrace = rawTrace
    .replace(regex, (_match, lineStr: string, columnStr: string | undefined) => {
      const lineNum = parseInt(lineStr, 10);
      const mappedLine = lineOffset + lineNum - 1;
      if (columnStr === undefined) return `${realPath}:${mappedLine}`;
      const columnNum = parseInt(columnStr, 10) + (lineNum === 1 ? firstLineColumnOffset : 0);
      return `${realPath}:${mappedLine}:${columnNum}`;
    })
    // Helpers imported by the entry are loaded under their own generation URL
    // by the dev module graph hook. Their frames keep the helper's path (it is
    // the authored file) but the framework marker is noise, so it is removed
    // from every remaining frame.
    .replace(/\?bascik-gen=\d+(?=:\d+)/g, () => "");

  const lines = mappedTrace.split(/\r?\n/);
  const filteredLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip command failed lines
    if (/^\s*Command failed:/i.test(line)) {
      continue;
    }

    // Node prints its version after an uncaught error in a child process.
    if (/^Node\.js v\d+\.\d+\.\d+\s*$/.test(line)) {
      continue;
    }

    if (isFrame(line) && isBascikFrame(line)) {
      continue;
    }

    // Skip node:internal or other node: internal module stack frames
    if (line.includes("node:internal/") || line.includes("node:diagnostics_channel") || /\(node:/.test(line)) {
      if (line.endsWith(" {") && filteredLines.length > 0) {
        const lastIdx = filteredLines.length - 1;
        if (!filteredLines[lastIdx].endsWith(" {")) {
          filteredLines[lastIdx] += " {";
        }
      }
      if (!line.trim().startsWith("at ")) {
        if (i + 2 < lines.length && lines[i + 2].trim() === "^") {
          i += 2;
          continue;
        }
      }
      continue;
    }

    filteredLines.push(line);
  }

  // Builtin frames left after the user's last frame belong to whatever awaited
  // the user's code (Bascik's own `Promise.all`), not to the user's code.
  while (filteredLines.length > 0) {
    const last = filteredLines[filteredLines.length - 1];
    if (!isFrame(last) || hasLocation(last)) break;
    filteredLines.pop();
  }

  return filteredLines.join("\n").trim();
};
