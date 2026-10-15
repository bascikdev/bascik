/**
 * @module check-language-server
 *
 * Runs the per-file half of `bascik --check`, which lives in `@bascik/language-server`.
 *
 * `bascik --check` answers questions about the whole project: does the config make sense, do two pages claim one
 * route, is a component never used. The language server answers questions about one file at a time: is this
 * attribute a typo, does this CSS survive scoping. Each rule lives in exactly one of them, so a finding is never
 * reported twice, and the language server is the same engine the editor uses.
 *
 * The language server is an optional peer dependency. `@bascik/bascik` stays free of production dependencies, and
 * projects scaffolded with `npm create bascik` already have it. When it is missing, the project half still runs
 * and the report says what was skipped.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BascikConfig } from "./config.ts";

/** One per-file finding, as the language server reports it. */
export interface LanguageServerDiagnostic {
  filePath: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
}

interface LanguageServerCheckResult {
  filesChecked: number;
  fixedFiles: string[];
  diagnostics: LanguageServerDiagnostic[];
}

type CheckTarget = string | { path: string; extensions?: string[] };

/** The part of `@bascik/language-server/check` this module uses. Checked at run time, because the version is the user's. */
interface LanguageServerCheckModule {
  checkFiles: (options: { cwd: string; targets: CheckTarget[]; projectPath: string; fix: boolean; hints: boolean }) => Promise<LanguageServerCheckResult>;
  formatDiagnostic: (diagnostic: LanguageServerDiagnostic, color?: boolean) => string;
}

export type LanguageServerOutcome =
  | { status: "ran"; filesChecked: number; fixedFiles: string[]; diagnostics: LanguageServerDiagnostic[]; formatDiagnostic: LanguageServerCheckModule["formatDiagnostic"] }
  | { status: "missing" }
  | { status: "outdated" };

/** `--fix` was asked for, but the language server that applies the fixes is not available. */
export class LanguageServerRequiredError extends Error {
  override name = "LanguageServerRequiredError";
}

const SPECIFIER = "@bascik/language-server/check";

const isNotFound = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
};

/**
 * Loads the language server's check module, or returns null when it is not installed.
 *
 * It is looked up from the project first, so the version the user installed is the one that runs (this also works
 * under pnpm's strict layout). The lookup from this package is the fallback, which is how a workspace checkout finds it.
 */
export async function loadLanguageServerCheck(
  projectRoot: string = process.cwd(),
  fallbackFrom: string | null = import.meta.url,
): Promise<LanguageServerCheckModule | null | "outdated"> {
  const lookups = [join(projectRoot, "package.json"), ...(fallbackFrom === null ? [] : [fallbackFrom])];
  let installedWithoutCheck = false;
  for (const from of lookups) {
    let resolved: string;
    try {
      resolved = createRequire(from).resolve(SPECIFIER);
    } catch (error) {
      // The package is there but does not export ./check: a release from before the per-file checks moved into it.
      if ((error as { code?: string } | null)?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        installedWithoutCheck = true;
        continue;
      }
      if (isNotFound(error)) continue;
      throw error;
    }
    const mod = (await import(pathToFileURL(resolved).href)) as Partial<LanguageServerCheckModule>;
    // A newer language server that renamed these would land here too.
    if (typeof mod.checkFiles !== "function" || typeof mod.formatDiagnostic !== "function") return "outdated";
    return mod as LanguageServerCheckModule;
  }
  return installedWithoutCheck ? "outdated" : null;
}

/** The folders `bascik --check` hands to the language server, each with the file types that belong there. */
export function languageServerTargets(cwd: string = process.cwd()): CheckTarget[] {
  const directory = BascikConfig.directory;
  const targets: CheckTarget[] = [];
  // Pages are markup. Their static assets (.js, .css) are served as they are and are not Bascik source.
  targets.push({ path: resolve(cwd, directory?.pages ?? "src/pages"), extensions: ["html"] });
  for (const root of directory?.components ?? ["src/components"]) targets.push({ path: resolve(cwd, root) });
  targets.push({ path: resolve(cwd, directory?.api ?? "src/api"), extensions: ["ts", "js", "mjs"] });
  return targets.filter((target) => typeof target === "string" || existsSync(target.path));
}

/** Runs the per-file checks over the project's pages, components, and API routes. */
export async function runLanguageServerCheck(options: { fix?: boolean; cwd?: string } = {}): Promise<LanguageServerOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const mod = await loadLanguageServerCheck(cwd);
  if (mod === null) return { status: "missing" };
  if (mod === "outdated") return { status: "outdated" };
  const result = await mod.checkFiles({
    cwd,
    targets: languageServerTargets(cwd),
    projectPath: cwd,
    fix: options.fix ?? false,
    // Hints are advice for the editor. A check that gates CI reports only what is wrong.
    hints: false,
  });
  return { status: "ran", ...result, formatDiagnostic: mod.formatDiagnostic };
}

/** Why `--fix` cannot run. Fixes are applied by the language server, so without it there is nothing to apply. */
export function languageServerFixMessage(outcome: LanguageServerOutcome): string {
  return outcome.status === "outdated"
    ? "[bascik] --fix needs a newer @bascik/language-server than the one installed. Update it with: npm install --save-dev @bascik/language-server@latest"
    : "[bascik] --fix needs @bascik/language-server to apply fixes, and it is not installed. Install it with: npm install --save-dev @bascik/language-server";
}

/** What to tell the user when the per-file checks could not run, or `undefined` when they did. */
export function languageServerHint(outcome: LanguageServerOutcome): string | undefined {
  if (outcome.status === "missing") {
    return "per-file checks skipped: install @bascik/language-server to run them (npm install --save-dev @bascik/language-server)";
  }
  if (outcome.status === "outdated") {
    return "per-file checks skipped: the installed @bascik/language-server is too old for this version of bascik. Update it with npm install --save-dev @bascik/language-server@latest";
  }
  return undefined;
}
