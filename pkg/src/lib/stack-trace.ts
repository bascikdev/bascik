import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Bascik's own modules (this directory). A user's error that crossed Bascik on
 * its way up (a server script awaited by the request handler) carries frames
 * from here; they say nothing about the user's code. Test fixtures that live
 * next to the source are user code for the tests that load them.
 */
const BASCIK_LIB_URL = new URL("./", import.meta.url).href;
const BASCIK_LIB_PATH = fileURLToPath(BASCIK_LIB_URL);
const isBascikFrame = (line: string): boolean =>
  (line.includes(BASCIK_LIB_URL) || line.includes(BASCIK_LIB_PATH)) && !line.includes("/test-fixtures/");

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

  // Escaping backslashes for Windows paths
  const escapedTmpPath = tmpPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Also support file:// URI schemes in stack traces
  let fileUri = tmpPath;
  try {
    fileUri = pathToFileURL(tmpPath).href;
  } catch { }
  const escapedFileUri = fileUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // In development the registry imports each generation under
  // `?bascik-gen=N`, and V8 reports that full URL in stack frames. The query
  // is optional here so every generation remaps to the same authored source.
  const regex = new RegExp(`(?:${escapedFileUri}|${escapedTmpPath})(?:\\?bascik-gen=\\d+)?:(\\d+)(?::(\\d+))?`, "g");

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
