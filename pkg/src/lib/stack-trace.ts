import { pathToFileURL } from "node:url";

/**
 * Clean and remap stack traces from ephemeral script files back to the original
 * source template file and line offset.
 */
export const cleanStackTrace = (
  rawTrace: string,
  tmpPath: string,
  realPath: string,
  lineOffset: number,
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

  const regex = new RegExp(`(?:${escapedFileUri}|${escapedTmpPath}):(\\d+)`, "g");

  const mappedTrace = rawTrace.replace(regex, (_match, lineStr) => {
    const lineNum = parseInt(lineStr, 10);
    const mappedLine = lineOffset + lineNum - 1;
    return `${realPath}:${mappedLine}`;
  });

  const lines = mappedTrace.split(/\r?\n/);
  const filteredLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip command failed lines
    if (/^\s*Command failed:/i.test(line)) {
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

  return filteredLines.join("\n").trim();
};
