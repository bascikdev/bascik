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

export async function runScriptFiles(files: string[]): Promise<ScriptRunResult[]> {
  const results: ScriptRunResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let stdout = "";
    let stderr = "";
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;

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
      await import(pathToFileURL(resolve(process.cwd(), file)).href);
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
  const files = process.argv.slice(2);
  const results = await runScriptFiles(files);
  process.stdout.write(JSON.stringify(results));
}
