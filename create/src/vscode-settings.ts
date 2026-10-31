/**
 * @module vscode-settings
 *
 * Writes or merges the editor files a Bascik project ships with:
 *
 *  - `.vscode/settings.json` turns off `html.validate.scripts`. VS Code's
 *    built-in HTML checker joins every `<script>` in a file that has no
 *    `type="module"` into one JavaScript file, so two Bascik scripts that each
 *    `export default` show the false error "A module cannot have multiple
 *    default exports". It also checks `type="text/typescript"` blocks as
 *    TypeScript without Bascik's `@/` import root. Bascik compiles each script
 *    on its own.
 *  - `.vscode/extensions.json` recommends the Bascik extension.
 *  - `.hintrc` (or an existing `.hintrc.json`) scopes webhint for source
 *    files. Bascik composes a page's `<head>` (charset, viewport, title) at
 *    build time from a component and a build script, and an `<img>` can get
 *    its `alt` from a prop, so editor linters that read `src/` report tags the
 *    built page in `dist/` has. `.hintrc.dist.json` checks the built pages
 *    with every hint on (`npx hint -c .hintrc.dist.json <built files>`). It
 *    does not extend `.hintrc`: webhint joins the `ignoredUrls` lists of an
 *    `extends` chain, so the source pattern, or an old entry that skips
 *    `dist/`, would reach the built pages.
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
  '// "A module cannot have multiple default exports". It also checks',
  '// type="text/typescript" blocks without Bascik\'s @/ import root. Bascik',
  "// compiles each script on its own. This turns off only VS Code's inline",
  "// script check.",
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
  /** Things the merge left for the user to change by hand. Absent when none. */
  notes?: string[];
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
 * just past the `opener` (`[` by default) that opens that top-level key's
 * value.
 */
function locate(
  blanked: string,
  key?: string,
  opener: "[" | "{" = "[",
): { objectOpen: number; arrayOpen?: number } {
  const objectOpen = blanked.indexOf("{") + 1;
  let depth = 0;
  for (let i = 0; i < blanked.length; i++) {
    const char = blanked[i];
    if (char === '"') {
      const end = stringEnd(blanked, i);
      if (depth === 1 && key !== undefined) {
        const rest = blanked.slice(end);
        const colon = (opener === "[" ? /^\s*:\s*\[/ : /^\s*:\s*\{/).exec(rest);
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

// ─── webhint ──────────────────────────────────────────────────────────────────

/** The docs section that explains every exception below. */
export const EDITOR_LINTERS_URL =
  "https://bascik.dev/testing/linting#editor-linters-read-source";

/** Hints that are false on source files only: the built page has these tags. */
export const HINT_SOURCE_ONLY = ["meta-viewport", "meta-charset-utf-8"];

const AXE_TEXT_ALTERNATIVES = "axe/text-alternatives";
const AXE_TEXT_ALTERNATIVES_VALUE =
  '["default", { "document-title": "off", "image-alt": "off" }]';

/** Where a project keeps the files Bascik reads and writes, relative to its root. */
export interface SourceDirectories {
  pages: string;
  components: string[];
  /** `directory.out`, the built site. Defaults to `dist`. */
  out?: string;
}

/** Bascik's defaults (`directory.pages`, `directory.components` and `directory.out`). */
export const DEFAULT_SOURCE_DIRECTORIES: SourceDirectories = {
  pages: "src/pages",
  components: ["src/components"],
  out: "dist",
};

/**
 * The folder as it appears in a `file:///` URL, with `/` separators and no
 * leading `./`, `../` or drive letter. Empty when the folder is the root.
 */
function urlFragment(dir: string): string {
  const segments = dir.replace(/\\/g, "/").split("/");
  while (segments.length > 0 && /^(\.{0,2}|[A-Za-z]:)$/.test(segments[0])) {
    segments.shift();
  }
  return segments.filter((part) => part !== "" && part !== ".").join("/");
}

/**
 * The `ignoredUrls` pattern for HTML files in the pages and components
 * folders. webhint tests it, without regard to case, against the file's
 * absolute `file:///` URL, so it starts at a `/` and cannot be anchored to
 * the project root. Undefined when the pages folder is the project root, so
 * no pattern could leave `dist/` out.
 */
export function sourceUrlPattern(dirs: SourceDirectories): string | undefined {
  const pages = urlFragment(dirs.pages);
  if (pages === "") return undefined;
  const fragments = [pages, ...dirs.components.map(urlFragment)].filter(
    (fragment, index, all) =>
      fragment !== "" && all.indexOf(fragment) === index,
  );
  const escaped = fragments.map((fragment) =>
    fragment.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`),
  );
  return `/(?:${escaped.join("|")})/[^?#]*\\.html$`;
}

/**
 * The output folder as a shell word for `find`: `/` separators, no leading
 * `./` or trailing `/`, and single quotes when it holds anything but plain
 * path characters.
 */
function shellFolder(dir: string): string {
  const tidy =
    dir
      .replace(/\\/g, "/")
      .replace(/^(\.\/)+/, "")
      .replace(/\/+$/, "") || ".";
  return /^[\w./@+-]+$/.test(tidy) ? tidy : `'${tidy.replace(/'/g, "'\\''")}'`;
}

/** The command that checks the built pages with `.hintrc.dist.json`. */
export function hintDistCommand(out = "dist"): string {
  return `npx hint -c .hintrc.dist.json $(find ${shellFolder(out)} -name '*.html')`;
}

function hintrcComment(out: string): string[] {
  return [
    "// Bascik builds each page's <head> (charset, viewport, title) from a",
    "// component and a build script, and an <img> can get its alt from a prop,",
    "// so a source file lacks tags the built page has. These entries turn off",
    "// only those checks, and the charset and viewport ones only for source",
    "// files. So the editor does not flag an <img> with no alt, even a literal",
    "// one; the bascik skill's audit-components.mjs and this check of the",
    "// built site do (webhint skips hints when given a folder, so pass files):",
    `//   ${hintDistCommand(out)}`,
    `// ${EDITOR_LINTERS_URL}`,
  ];
}

function ignoredUrlEntry(pattern: string): string {
  return `{ "domain": ${JSON.stringify(pattern)}, "hints": ${JSON.stringify(HINT_SOURCE_ONLY).replace(/,/g, ", ")} }`;
}

/** The `.hintrc` a new project gets. */
export function hintrcJson(dirs: SourceDirectories): string {
  const pattern = sourceUrlPattern(dirs);
  const lines = [
    "{",
    ...hintrcComment(dirs.out ?? "dist").map((line) => `  ${line}`),
    '  "extends": ["development"],',
    '  "hints": {',
    `    "${AXE_TEXT_ALTERNATIVES}": ${AXE_TEXT_ALTERNATIVES_VALUE}`,
    pattern === undefined ? "  }" : "  },",
  ];
  if (pattern !== undefined) {
    lines.push('  "ignoredUrls": [', `    ${ignoredUrlEntry(pattern)}`, "  ]");
  }
  return lines.join("\n") + "\n}\n";
}

/**
 * The config for the built site: webhint's development config with every
 * hint on. It does not extend the editor config, because webhint joins the
 * `ignoredUrls` lists of an `extends` chain. The stylish formatter replaces
 * the development config's html one, which writes a `hint-report/` folder.
 */
export function hintDistJson(): string {
  return [
    "{",
    "  // The built pages with every hint on. This file does not extend .hintrc:",
    "  // webhint would add that file's ignoredUrls, which skip source folders.",
    `  // ${EDITOR_LINTERS_URL}`,
    '  "extends": ["development"],',
    '  "formatters": ["stylish"]',
    "}",
    "",
  ].join("\n");
}

/**
 * Text to insert at `open` (just past a `{` or `[`) to add `entry` as the
 * first item: on its own line, indented like the next one, in a container that
 * spans lines; inline in a one-line container.
 */
function firstItem(
  blanked: string,
  open: number,
  entry: string,
  empty: boolean,
  nl: string,
): string {
  if (empty) return entry;
  const before = /^\s*/.exec(blanked.slice(open))![0];
  const lineBreak = Math.max(
    before.lastIndexOf("\n"),
    before.lastIndexOf("\r"),
  );
  if (lineBreak !== -1) return `${nl}${before.slice(lineBreak + 1)}${entry},`;
  return before === "" ? `${entry}, ` : ` ${entry},`;
}

/** Whether a hint value turns the hint off: `"off"`, `0`, or either first in a list. */
function isOff(value: unknown): boolean {
  const severity = Array.isArray(value) ? value[0] : value;
  return severity === "off" || severity === 0;
}

/**
 * Add the Bascik source-file exceptions to a webhint config, keeping the
 * rest: the `axe/text-alternatives` options unless the user set that hint, and
 * the `ignoredUrls` entry unless the file has one with the same pattern.
 */
export function mergeHintrc(
  existing: string | undefined,
  dirs: SourceDirectories,
): MergeResult {
  if (existing === undefined || existing.trim() === "") {
    return { status: "created", text: hintrcJson(dirs) };
  }
  if (blankJsonc(existing).trim() === "") {
    // webhint refuses a file of only comments; keep them and add the config.
    return afterComments(existing, hintrcJson(dirs));
  }
  const parsed = parseJsonc(existing);
  if (!isObject(parsed)) return { status: "invalid", text: existing };
  const blanked = blankJsonc(existing);
  const nl = newlineOf(existing);
  const pattern = sourceUrlPattern(dirs);
  const inserts: Array<[at: number, text: string]> = [];
  const topLevel: string[] = [];

  const notes: string[] = [];
  const axeEntry = `"${AXE_TEXT_ALTERNATIVES}": ${AXE_TEXT_ALTERNATIVES_VALUE}`;
  const { hints, ignoredUrls } = parsed;
  if (hints !== undefined && !isObject(hints)) {
    notes.push(
      `"hints" is not an object, so add ${axeEntry} to it by hand (${EDITOR_LINTERS_URL})`,
    );
  }
  if (isObject(hints)) {
    const off = HINT_SOURCE_ONLY.filter((name) => isOff(hints[name]));
    if (off.length > 0) {
      notes.push(
        `${off.join(" and ")} ${off.length === 1 ? "is" : "are"} off for every file. ` +
          "The ignoredUrls entry already skips source files, so remove that from hints to have webhint check the rest",
      );
    }
  }
  if (
    pattern !== undefined &&
    ignoredUrls !== undefined &&
    !Array.isArray(ignoredUrls)
  ) {
    notes.push(
      `"ignoredUrls" is not a list, so add ${ignoredUrlEntry(pattern)} to it by hand (${EDITOR_LINTERS_URL})`,
    );
  }
  if (hints === undefined) {
    topLevel.push(
      `"hints": { "${AXE_TEXT_ALTERNATIVES}": ${AXE_TEXT_ALTERNATIVES_VALUE} }`,
    );
  } else if (isObject(hints) && !(AXE_TEXT_ALTERNATIVES in hints)) {
    const at = locate(blanked, "hints", "{").arrayOpen!;
    const empty = Object.keys(hints).length === 0;
    inserts.push([at, firstItem(blanked, at, axeEntry, empty, nl)]);
  }

  if (pattern !== undefined) {
    if (ignoredUrls === undefined) {
      topLevel.push(`"ignoredUrls": [${ignoredUrlEntry(pattern)}]`);
    } else if (
      Array.isArray(ignoredUrls) &&
      !ignoredUrls.some((entry) => isObject(entry) && entry.domain === pattern)
    ) {
      const at = locate(blanked, "ignoredUrls").arrayOpen!;
      const empty = ignoredUrls.length === 0;
      inserts.push([
        at,
        firstItem(blanked, at, ignoredUrlEntry(pattern), empty, nl),
      ]);
    }
  }

  if (topLevel.length > 0) {
    const { objectOpen } = locate(blanked);
    const empty = Object.keys(parsed).length === 0;
    const insert =
      `${nl}  // Bascik source-file exceptions: ${EDITOR_LINTERS_URL}` +
      topLevel.map((entry) => `${nl}  ${entry}`).join(",") +
      (empty ? nl : ",");
    inserts.push([objectOpen, insert]);
  }
  const withNotes = notes.length > 0 ? { notes } : {};
  if (inserts.length === 0) {
    return { status: "unchanged", text: existing, ...withNotes };
  }

  let text = existing;
  for (const [at, insert] of inserts.sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, at) + insert + text.slice(at);
  }
  return { status: "updated", text, ...withNotes };
}

/** What happened to the webhint files. */
export interface HintReport {
  /** The config file webhint reads in this folder. */
  file: string;
  /** `elsewhere`: the config is a `.hintrc.js` or package.json `hintConfig`, left alone. */
  config: VscodeFileStatus | "elsewhere";
  dist: VscodeFileStatus | "skipped";
  /** What the merge left for the user to change by hand. Absent when none. */
  notes?: string[];
}

/** Read a file, or undefined when it does not exist. Throws on other errors. */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Whether package.json holds a `hintConfig`, which webhint reads last. */
async function packageHintConfig(root: string): Promise<boolean> {
  try {
    const pkg = parseJsonc(
      (await readIfPresent(join(root, "package.json"))) ?? "",
    );
    return isObject(pkg) && pkg.hintConfig !== undefined;
  } catch {
    return false;
  }
}

/**
 * The webhint config file in `root`, in the order webhint looks: `.hintrc`,
 * `.hintrc.js`, `.hintrc.json`, then package.json `hintConfig`. A new
 * `.hintrc` would hide the other three, so an existing one is used instead.
 */
async function hintConfigFile(root: string): Promise<string> {
  for (const file of [".hintrc", ".hintrc.js", ".hintrc.json"]) {
    try {
      if ((await readIfPresent(join(root, file))) !== undefined) return file;
    } catch {
      return file;
    }
  }
  return (await packageHintConfig(root)) ? "package.json" : ".hintrc";
}

/**
 * Write or merge the webhint config (`.hintrc`, or an existing `.hintrc.json`)
 * and write `.hintrc.dist.json` when absent. A `.hintrc.js` or package.json
 * `hintConfig` is left alone; the dist config stands on its own, so it is
 * written then too. Never throws; the report says what happened.
 */
export async function writeHintFiles(
  root: string,
  dirs: SourceDirectories = DEFAULT_SOURCE_DIRECTORIES,
): Promise<HintReport> {
  const file = await hintConfigFile(root);
  let notes: string[] | undefined;
  const config: HintReport["config"] =
    file === ".hintrc.js" || file === "package.json"
      ? "elsewhere"
      : await mergeFile(join(root, file), (existing) => {
          const result = mergeHintrc(existing, dirs);
          notes = result.notes;
          return result;
        });
  if (config === "invalid" || config === "failed") {
    return { file, config, dist: "skipped" };
  }
  const dist = await mergeFile(join(root, ".hintrc.dist.json"), (existing) =>
    existing === undefined
      ? { status: "created", text: hintDistJson() }
      : { status: "unchanged", text: existing },
  );
  return notes ? { file, config, dist, notes } : { file, config, dist };
}

/** Lines worth showing the user: what was added, and what to fix by hand. */
export function hintReportLines(report: HintReport): string[] {
  const { file, config } = report;
  const notes = (report.notes ?? []).map((note) => `${file}: ${note}`);
  if (config === "updated") {
    return [
      `${file}: added the Bascik source-file exceptions (${EDITOR_LINTERS_URL})`,
      ...notes,
    ];
  }
  if (config === "unchanged" || config === "created") return notes;
  if (config === "elsewhere") {
    const where = file === "package.json" ? 'package.json "hintConfig"' : file;
    return [
      `${where}: left as is. Add the Bascik source-file exceptions for webhint by hand: ${EDITOR_LINTERS_URL}`,
    ];
  }
  if (config === "invalid" || config === "failed") {
    return [
      `${file}: ${config === "invalid" ? "left as is because it is not valid JSON" : "could not be written"}. ` +
        `Add the Bascik source-file exceptions for webhint by hand: ${EDITOR_LINTERS_URL}`,
    ];
  }
  return [];
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
