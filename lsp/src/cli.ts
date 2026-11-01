#!/usr/bin/env node
import { CheckUsageError, checkFiles, formatDiagnostic } from "./check.js";

interface CliOptions {
  targetPaths: string[];
  projectPath?: string;
  fix: boolean;
}

const USAGE =
  "Usage: bascik-language-server --check [--fix] [--project <dir>] [path ...]";

/** Every positional argument is a path to check; an unknown flag is a usage error, never ignored. */
function parseArgs(args: string[]): CliOptions {
  const targetPaths: string[] = [];
  let projectPath: string | undefined;
  let fix = false;
  const projectValue = (value: string | undefined): string => {
    if (!value || value.startsWith("-"))
      throw new CheckUsageError(`--project needs a directory. ${USAGE}`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stdio" || arg === "--check") {
      // Handled by main bin launcher
      continue;
    }
    if (arg === "--fix") {
      fix = true;
      continue;
    }
    if (arg === "--project") {
      projectPath = projectValue(args[++i]);
      continue;
    }
    if (arg.startsWith("--project=")) {
      projectPath = projectValue(arg.slice("--project=".length));
      continue;
    }
    if (arg === "--") {
      targetPaths.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-"))
      throw new CheckUsageError(`Unknown option: ${arg}. ${USAGE}`);
    targetPaths.push(arg);
  }
  return { targetPaths, projectPath, fix };
}

/** `bascik-language-server --check`: per-file diagnostics over a folder or file, printed one per line. */
export async function runCliCheck(
  args: string[] = process.argv.slice(2),
): Promise<number> {
  const cwd = process.cwd();

  let result;
  try {
    const { targetPaths, projectPath, fix } = parseArgs(args);
    result = await checkFiles({
      cwd,
      targets: targetPaths.length > 0 ? targetPaths : undefined,
      projectPath,
      fix,
    });
  } catch (error) {
    if (error instanceof CheckUsageError) {
      console.error(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  for (const diagnostic of result.diagnostics)
    console.log(formatDiagnostic(diagnostic));

  const errorCount = result.diagnostics.filter(
    (d) => d.severity === "error",
  ).length;
  const warningCount = result.diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;
  const hintCount = result.diagnostics.length - errorCount - warningCount;
  if (errorCount > 0 || warningCount > 0 || hintCount > 0) {
    const hints =
      hintCount > 0 ? `, ${hintCount} hint${hintCount === 1 ? "" : "s"}` : "";
    console.log(
      `\nFound ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}${hints}.`,
    );
  } else {
    console.log(
      `\x1b[32m✔ No Bascik diagnostics found in ${result.filesChecked} file${result.filesChecked === 1 ? "" : "s"}.\x1b[0m`,
    );
  }

  return errorCount > 0 ? 1 : 0;
}
