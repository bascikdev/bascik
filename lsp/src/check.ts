/**
 * Per-file checks over a set of files, with structured results.
 *
 * `bascik-language-server --check` prints these, and `bascik --check` (in `@bascik/bascik`) loads this module
 * when the language server is installed and merges the results into its own report. Keeping the logic here, and
 * the printing in `cli.ts`, is what lets both commands run exactly the same rules.
 *
 * It has no dependency on the LSP connection, so loading it never starts a server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity } from "vscode-languageserver";
import {
  buildSnapshot,
  isInsideComponentRoots,
  type ProjectSnapshot,
} from "./project.js";
import { createDiagnostics, applyAutoFixes } from "./analyzer.js";

/**
 * A file or folder to check. A folder can be limited to some file types, because what belongs in a pages folder
 * (markup) is not what belongs in an API folder (scripts).
 */
export type CheckTarget = string | { path: string; extensions?: string[] };

export interface CheckOptions {
  /** Paths in the results are relative to this folder. */
  cwd: string;
  /** Files or folders to check. Defaults to `cwd`. */
  targets?: CheckTarget[];
  /** The project whose config decides component roots and the import root, for files outside it. */
  projectPath?: string;
  /** Write the fixes that have exactly one correct answer, then report what remains. */
  fix?: boolean;
  /**
   * Include informational hints. They are for the editor, where a hint costs nothing to ignore. A caller that gates
   * on results, such as `bascik --check --strict` in CI, leaves them out. Defaults to true.
   */
  hints?: boolean;
}

export interface CheckedDiagnostic {
  /** Relative to `cwd`. */
  filePath: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** Only `error` fails a check. `info` is a hint: advice that may be wrong for a project the file cannot see. */
  severity: "error" | "warning" | "info";
  /** The rule id, usable in `bascik-ignore`, `bascik-disable` and `disabledRules`. */
  code?: string;
  message: string;
}

export interface CheckResult {
  projectRoot: string;
  filesChecked: number;
  /** Files rewritten by `fix`, relative to `cwd`. */
  fixedFiles: string[];
  diagnostics: CheckedDiagnostic[];
}

/** Thrown for a mistake in how the check was asked for (a path that does not exist), not a finding. */
export class CheckUsageError extends Error {}

const CONFIG_FILES = [
  "bascik.config.ts",
  "bascik.config.js",
  "bascik.config.mjs",
];
const DEFAULT_EXTENSIONS = ["html", "css", "js", "mjs", "ts"];
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$/i;

/** The nearest directory at or above `start` that holds a Bascik config file. */
function findConfigRoot(start: string): string | undefined {
  let curr = start;
  while (true) {
    if (CONFIG_FILES.some((file) => fs.existsSync(path.join(curr, file))))
      return curr;
    const parent = path.dirname(curr);
    if (parent === curr) return undefined;
    curr = parent;
  }
}

function collectFiles(
  root: string,
  extensions: string[] = DEFAULT_EXTENSIONS,
): string[] {
  if (fs.statSync(root).isFile()) return [root];
  const wanted = new Set(
    extensions.map((extension) => extension.replace(/^\./, "").toLowerCase()),
  );
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (
        entry.isFile() &&
        wanted.has(path.extname(entry.name).slice(1).toLowerCase()) &&
        !TEST_FILE.test(entry.name)
      ) {
        files.push(full);
      }
    }
  }
  return files;
}

function languageIdFor(
  filePath: string,
): "html" | "css" | "typescript" | "javascript" {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ext === "html"
    ? "html"
    : ext === "css"
      ? "css"
      : ext === "ts"
        ? "typescript"
        : "javascript";
}

export async function checkFiles(options: CheckOptions): Promise<CheckResult> {
  const { cwd, fix = false } = options;
  const requested = (options.targets?.length ? options.targets : [cwd]).map(
    (target) =>
      typeof target === "string"
        ? { path: target, extensions: undefined }
        : target,
  );
  const targets = requested.map((target) => path.resolve(cwd, target.path));
  for (const target of targets) {
    if (!fs.existsSync(target))
      throw new CheckUsageError(`Path does not exist: ${target}`);
  }

  // The project whose config decides component roots and the import root:
  //   1. an explicit project, for checking a folder that lives outside it (a monorepo's shared components)
  //   2. the project in the working directory, when the first target is one of its component roots
  //   3. the nearest config at or above the first target, else the target itself
  const firstTarget = targets[0];
  let projectRoot: string;
  let snapshot: ProjectSnapshot | undefined;
  if (options.projectPath !== undefined) {
    projectRoot = path.resolve(cwd, options.projectPath);
    if (
      !fs.existsSync(projectRoot) ||
      !fs.statSync(projectRoot).isDirectory()
    ) {
      throw new CheckUsageError(
        `Project directory does not exist: ${projectRoot}`,
      );
    }
  } else {
    const cwdProject = findConfigRoot(cwd);
    if (cwdProject) {
      const cwdSnapshot = await buildSnapshot(cwdProject);
      if (
        isInsideComponentRoots(
          firstTarget.replace(/\\/g, "/"),
          cwdSnapshot.componentRoots,
        )
      )
        snapshot = cwdSnapshot;
    }
    projectRoot =
      snapshot?.projectRoot ?? findConfigRoot(firstTarget) ?? firstTarget;
  }

  const files = [
    ...new Set(
      targets.flatMap((target, index) =>
        collectFiles(target, requested[index].extensions),
      ),
    ),
  ].sort();
  snapshot ??= await buildSnapshot(projectRoot);

  const diagnostics: CheckedDiagnostic[] = [];
  const fixedFiles: string[] = [];
  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const languageId = languageIdFor(filePath);
    const relative = path.relative(cwd, filePath);

    let document = TextDocument.create(
      `file://${filePath}`,
      languageId,
      1,
      content,
    );
    if (fix && languageId === "html") {
      const fixed = applyAutoFixes(document, snapshot, filePath);
      if (fixed.fixedCount > 0) {
        fs.writeFileSync(filePath, fixed.text, "utf8");
        fixedFiles.push(relative);
        document = TextDocument.create(
          `file://${filePath}`,
          languageId,
          2,
          fixed.text,
        );
      }
    }

    for (const diagnostic of createDiagnostics(document, filePath, snapshot)) {
      const severity =
        diagnostic.severity === DiagnosticSeverity.Error
          ? "error"
          : diagnostic.severity === DiagnosticSeverity.Warning
            ? "warning"
            : "info";
      if (severity === "info" && options.hints === false) continue;
      diagnostics.push({
        filePath: relative,
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        severity,
        code:
          diagnostic.code === undefined ? undefined : String(diagnostic.code),
        // LSP 3.18 allows a MarkupContent message; use its text, not [object Object].
        message:
          typeof diagnostic.message === "string"
            ? diagnostic.message
            : diagnostic.message.value,
      });
    }
  }

  return { projectRoot, filesChecked: files.length, fixedFiles, diagnostics };
}

/** One diagnostic as a line of terminal output: `file:line:col - severity: (code) message`. */
export function formatDiagnostic(
  diagnostic: CheckedDiagnostic,
  color = true,
): string {
  const paint = (code: string, text: string) =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const severity =
    diagnostic.severity === "error"
      ? paint("31", "error")
      : diagnostic.severity === "warning"
        ? paint("33", "warning")
        : paint("36", "hint");
  const code = diagnostic.code ? ` ${paint("90", `(${diagnostic.code})`)}` : "";
  return `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} - ${severity}:${code} ${diagnostic.message}`;
}
