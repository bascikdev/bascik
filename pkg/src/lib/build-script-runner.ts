/**
 * @module build-script-runner
 *
 * Child-process runner for executing batched `<script data-bascik-build>` blocks.
 * Runs multiple script files sequentially in a single Node process, intercepting
 * stdout and stderr for each script and returning JSON results.
 */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ScriptRunResult {
  id: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ScriptRunTask {
  file: string;
  sourceFile?: string;
}

export async function runScriptFiles(
  files: Array<string | ScriptRunTask>,
): Promise<ScriptRunResult[]> {
  const results: ScriptRunResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const task = typeof files[i] === "string"
      ? { file: files[i] as string }
      : files[i] as ScriptRunTask;
    let stdout = "";
    let stderr = "";
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    const originalSourceFile = process.env.BASCIK_SOURCE_FILE;

    if (task.sourceFile !== undefined) {
      process.env.BASCIK_SOURCE_FILE = task.sourceFile;
    }

    process.stdout.write = (chunk: any, encoding?: any, cb?: any) => {
      const callback = typeof encoding === "function" ? encoding : (typeof cb === "function" ? cb : undefined);
      const enc = typeof encoding === "string" ? encoding : undefined;
      if (typeof chunk === "string") {
        stdout += chunk;
      } else if (chunk && typeof chunk.toString === "function") {
        stdout += chunk.toString(enc);
      }
      if (typeof callback === "function") callback();
      return true;
    };

    process.stderr.write = (chunk: any, encoding?: any, cb?: any) => {
      const callback = typeof encoding === "function" ? encoding : (typeof cb === "function" ? cb : undefined);
      const enc = typeof encoding === "string" ? encoding : undefined;
      if (typeof chunk === "string") {
        stderr += chunk;
      } else if (chunk && typeof chunk.toString === "function") {
        stderr += chunk.toString(enc);
      }
      if (typeof callback === "function") callback();
      return true;
    };

    try {
      await import(pathToFileURL(resolve(process.cwd(), task.file)).href);
      results.push({ id: i, ok: true, stdout, stderr });
    } catch (err) {
      results.push({
        id: i,
        ok: false,
        error: err instanceof Error ? (err.stack || err.message) : String(err),
        stdout,
        stderr,
      });
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
      if (task.sourceFile !== undefined) {
        if (originalSourceFile === undefined) {
          delete process.env.BASCIK_SOURCE_FILE;
        } else {
          process.env.BASCIK_SOURCE_FILE = originalSourceFile;
        }
      }
    }
  }

  return results;
}

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("build-script-runner.js") ||
    process.argv[1].endsWith("build-script-runner.ts"));

if (isMain) {
  const tasks = process.argv.slice(2).map((argument): string | ScriptRunTask => {
    try {
      const parsed = JSON.parse(argument) as Partial<ScriptRunTask>;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.file === "string") {
        return { file: parsed.file, sourceFile: parsed.sourceFile };
      }
    } catch {
      // Backward-compatible plain file argument.
    }
    return argument;
  });
  const results = await runScriptFiles(tasks);
  process.stdout.write(JSON.stringify(results));
}
