/**
 * @module vscode-settings
 *
 * Writes or merges the two VS Code files a Bascik project ships with:
 *
 *  - `.vscode/settings.json` turns off `html.validate.scripts`. VS Code's
 *    built-in HTML checker joins every `<script>` in a file that has no
 *    `type="module"` into one JavaScript file, so two Bascik scripts that each
 *    `export default` show the false error "A module cannot have multiple
 *    default exports". Bascik compiles each script on its own.
 *  - `.vscode/extensions.json` recommends the Bascik extension.
 *
 * Existing files are merged, never replaced: comments, other settings and
 * other recommendations stay, a value the user already set is kept, and a file
 * that is not valid JSON is left alone and reported.
 *
 * Two identical copies exist, `create/src/vscode-settings.ts` for
 * `npm create bascik` and `pkg/src/lib/vscode-settings.ts` for `bascik init`.
 * `create/src/vscode-settings.test.ts` fails when they differ.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HTML_VALIDATE_SCRIPTS = "html.validate.scripts";
export const BASCIK_EXTENSION_ID = "bascik.bascik-vscode";

const SETTINGS_COMMENT = [
  "// Bascik pages can hold several <script> blocks. VS Code's HTML checker",
  "// joins them into one file and reports errors Bascik never hits, such as",
  '// "A module cannot have multiple default exports". Bascik compiles each',
  "// script on its own. This turns off only VS Code's inline script check.",
  "// https://bascik.dev/tools/vscode-extension#several-scripts-in-one-file",
];

export const VSCODE_SETTINGS_JSON =
  ["{", ...SETTINGS_COMMENT.map((line) => `  ${line}`)].join("\n") +
  `\n  "${HTML_VALIDATE_SCRIPTS}": false\n}\n`;

export const VSCODE_EXTENSIONS_JSON =
  JSON.stringify({ recommendations: [BASCIK_EXTENSION_ID] }, null, 2) + "\n";

/** What happened to one file. */
export type VscodeFileStatus =
  "created" | "updated" | "unchanged" | "invalid" | "failed";

export interface MergeResult {
  status: "created" | "updated" | "unchanged" | "invalid";
  text: string;
}

export interface VscodeReport {
  settings: VscodeFileStatus;
  extensions: VscodeFileStatus;
}

/**
 * Blank out comments, trailing commas and a byte order mark with spaces, so
 * the result parses as JSON and every character keeps its position.
 */
function blankJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        out += " ";
        i++;
      }
    } else if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      out += text.slice(i, end).replace(/[^\r\n]/g, " ");
      i = end;
    } else if (char === "﻿") {
      out += " ";
      i++;
    } else {
      out += char;
      i++;
    }
  }
  // Trailing commas, now that comments are gone and strings are intact.
  let result = "";
  for (let j = 0; j < out.length; j++) {
    if (out[j] === '"') {
      const end = stringEnd(out, j);
      result += out.slice(j, end);
      j = end - 1;
    } else if (out[j] === "," && /^\s*[}\]]/.test(out.slice(j + 1))) {
      result += " ";
    } else {
      result += out[j];
    }
  }
  return result;
}

/** Index just past the string literal that starts at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === "\\" ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
}

/** Parse JSON with comments and trailing commas, as VS Code reads its files. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(blankJsonc(text));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Position just past the top-level object's `{`, and, when `key` is given,
 * just past the `[` that opens that top-level key's array value.
 */
function locate(
  blanked: string,
  key?: string,
): { objectOpen: number; arrayOpen?: number } {
  const objectOpen = blanked.indexOf("{") + 1;
  let depth = 0;
  for (let i = 0; i < blanked.length; i++) {
    const char = blanked[i];
    if (char === '"') {
      const end = stringEnd(blanked, i);
      if (depth === 1 && key !== undefined) {
        const rest = blanked.slice(end);
        const colon = /^\s*:\s*\[/.exec(rest);
        if (colon && JSON.parse(blanked.slice(i, end)) === key) {
          return { objectOpen, arrayOpen: end + colon[0].length };
        }
      }
      i = end - 1;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
    }
  }
  return { objectOpen };
}

/**
 * VS Code reads a file that holds only comments as an empty object. Keep the
 * comments and write the default content after them.
 */
function afterComments(existing: string, content: string): MergeResult {
  const nl = newlineOf(existing);
  const gap = /[\r\n]$/.test(existing) ? "" : nl;
  return {
    status: "updated",
    text: existing + gap + content.replace(/\n/g, nl),
  };
}

/** Whether `list` holds the Bascik extension. IDs ignore case in VS Code. */
function listsBascik(list: unknown): boolean {
  return (
    Array.isArray(list) &&
    list.some(
      (id) =>
        typeof id === "string" && id.toLowerCase() === BASCIK_EXTENSION_ID,
    )
  );
}

/** Add `"html.validate.scripts": false` to a settings file, keeping the rest. */
export function mergeSettingsJson(existing: string | undefined): MergeResult {
  if (existing === undefined || existing.trim() === "") {
    return { status: "created", text: VSCODE_SETTINGS_JSON };
  }
  if (blankJsonc(existing).trim() === "") {
    return afterComments(existing, VSCODE_SETTINGS_JSON);
  }
  const parsed = parseJsonc(existing);
  if (!isObject(parsed)) return { status: "invalid", text: existing };
  if (HTML_VALIDATE_SCRIPTS in parsed) {
    return { status: "unchanged", text: existing };
  }
  const nl = newlineOf(existing);
  const { objectOpen } = locate(blankJsonc(existing));
  const empty = Object.keys(parsed).length === 0;
  const insert =
    SETTINGS_COMMENT.map((line) => `${nl}  ${line}`).join("") +
    `${nl}  "${HTML_VALIDATE_SCRIPTS}": false` +
    (empty ? nl : ",");
  return {
    status: "updated",
    text: existing.slice(0, objectOpen) + insert + existing.slice(objectOpen),
  };
}

/** Add the Bascik extension to an extensions file, keeping the rest. */
export function mergeExtensionsJson(existing: string | undefined): MergeResult {
  if (existing === undefined || existing.trim() === "") {
    return { status: "created", text: VSCODE_EXTENSIONS_JSON };
  }
  if (blankJsonc(existing).trim() === "") {
    return afterComments(existing, VSCODE_EXTENSIONS_JSON);
  }
  const parsed = parseJsonc(existing);
  if (!isObject(parsed)) return { status: "invalid", text: existing };
  const { unwantedRecommendations } = parsed;
  if (
    parsed.recommendations !== undefined &&
    !Array.isArray(parsed.recommendations)
  ) {
    return { status: "invalid", text: existing };
  }
  const recommendations = parsed.recommendations as unknown[] | undefined;
  if (listsBascik(recommendations) || listsBascik(unwantedRecommendations)) {
    return { status: "unchanged", text: existing };
  }
  const blanked = blankJsonc(existing);
  const { objectOpen, arrayOpen } = locate(blanked, "recommendations");
  const id = JSON.stringify(BASCIK_EXTENSION_ID);
  const nl = newlineOf(existing);
  if (recommendations && arrayOpen !== undefined) {
    let insert = id;
    if (recommendations.length > 0) {
      // A list that spans lines gets the id on its own line, indented like
      // the first entry; a one-line list stays on one line.
      const before = /^\s*/.exec(blanked.slice(arrayOpen))![0];
      const lineBreak = Math.max(
        before.lastIndexOf("\n"),
        before.lastIndexOf("\r"),
      );
      insert =
        lineBreak === -1
          ? `${id}, `
          : `${nl}${before.slice(lineBreak + 1)}${id},`;
    }
    return {
      status: "updated",
      text: existing.slice(0, arrayOpen) + insert + existing.slice(arrayOpen),
    };
  }
  const empty = Object.keys(parsed).length === 0;
  const insert = `${nl}  "recommendations": [${id}]` + (empty ? nl : ",");
  return {
    status: "updated",
    text: existing.slice(0, objectOpen) + insert + existing.slice(objectOpen),
  };
}

async function mergeFile(
  path: string,
  merge: (existing: string | undefined) => MergeResult,
): Promise<VscodeFileStatus> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "failed";
  }
  const result = merge(existing);
  if (result.status === "created" || result.status === "updated") {
    try {
      await writeFile(path, result.text, "utf8");
    } catch {
      return "failed";
    }
  }
  return result.status;
}

/**
 * Write or merge `.vscode/settings.json` and `.vscode/extensions.json` under
 * `root`. Never throws; the report says what happened to each file.
 */
export async function writeVscodeFiles(root: string): Promise<VscodeReport> {
  const dir = join(root, ".vscode");
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return { settings: "failed", extensions: "failed" };
  }
  const [settings, extensions] = await Promise.all([
    mergeFile(join(dir, "settings.json"), mergeSettingsJson),
    mergeFile(join(dir, "extensions.json"), mergeExtensionsJson),
  ]);
  return { settings, extensions };
}

/** Lines worth showing the user: what was added, and what to fix by hand. */
export function vscodeReportLines(report: VscodeReport): string[] {
  const lines: string[] = [];
  const setting = `"${HTML_VALIDATE_SCRIPTS}": false`;
  if (report.settings === "updated") {
    lines.push(`.vscode/settings.json: added ${setting}`);
  } else if (report.settings === "invalid" || report.settings === "failed") {
    lines.push(
      `.vscode/settings.json: ${report.settings === "invalid" ? "left as is because it is not valid JSON" : "could not be written"}. ` +
        `Add ${setting} to it so VS Code stops flagging separate Bascik <script> blocks as one file.`,
    );
  }
  if (report.extensions === "updated") {
    lines.push(`.vscode/extensions.json: added ${BASCIK_EXTENSION_ID}`);
  } else if (
    report.extensions === "invalid" ||
    report.extensions === "failed"
  ) {
    lines.push(
      `.vscode/extensions.json: ${report.extensions === "invalid" ? "left as is because it is not valid JSON" : "could not be written"}. ` +
        `Add "${BASCIK_EXTENSION_ID}" to its "recommendations" list.`,
    );
  }
  return lines;
}
