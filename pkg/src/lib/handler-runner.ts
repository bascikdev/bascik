import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  Semaphore,
  sharedChildSemaphore,
  spillLargeEnv,
  stripAnsiEscapeCodes,
  SPILLED_ENV_FILE_VAR,
} from "./script-runner.ts";
import { BascikConfig } from "./config.ts";

export type DirectiveKind = "build" | "routes";

export interface DirectiveHandlerResult<T = unknown> {
  result: T;
  stdout: string;
  stderr: string;
}

export interface DirectiveHandlerOptions {
  extraEnv?: Record<string, string>;
  args?: string[];
  timeoutMs?: number;
  maxBuffer?: number;
  maxResultBytes?: number;
  semaphore?: Semaphore;
}

const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024; // 10 MiB budget
const ENVELOPE_VERSION = 1;

/**
 * Executes a prepared user module in a fresh Node.js child process, invoking its default export
 * once with zero arguments and transferring the result across a private result file.
 */
export const runDirectiveHandler = async <T = unknown>(
  modulePath: string,
  kind: DirectiveKind,
  options: DirectiveHandlerOptions = {},
): Promise<DirectiveHandlerResult<T>> => {
  const {
    extraEnv = {},
    args = [],
    timeoutMs = 60_000,
    maxBuffer = 10 * 1024 * 1024,
    maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
    semaphore = sharedChildSemaphore,
  } = options;

  const runDir = await mkdtemp(join(tmpdir(), "bascik-handler-"));
  const runnerScriptPath = join(runDir, "runner.mjs");
  const resultFilePath = join(runDir, "result.json");

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    BASCIK_BUILD: BascikConfig.isBuild ? "1" : "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extraEnv,
    BASCIK_DIRECTIVE_RESULT_FILE: resultFilePath,
    BASCIK_DIRECTIVE_KIND: kind,
    BASCIK_DIRECTIVE_MAX_BYTES: String(maxResultBytes),
  };
  if (!extraEnv.BASCIK_ROUTE) {
    delete childEnv.BASCIK_ROUTE;
  }
  delete childEnv[SPILLED_ENV_FILE_VAR];
  // Each script still runs in its own fresh process. Sharing Node's on-disk
  // compile cache only lets later children skip recompiling the same modules
  // (the runner, shared helpers, packages). A user's own setting always wins.
  if (childEnv.NODE_COMPILE_CACHE === undefined && childEnv.NODE_DISABLE_COMPILE_CACHE === undefined) {
    childEnv.NODE_COMPILE_CACHE = join(process.cwd(), "node_modules", ".cache", "bascik", "compile-cache");
  }

  const targetFileUrl = pathToFileURL(modulePath).href;

  const runnerCode = `
import { writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const resultFile = process.env.BASCIK_DIRECTIVE_RESULT_FILE;
const kind = process.env.BASCIK_DIRECTIVE_KIND;
const maxBytes = parseInt(process.env.BASCIK_DIRECTIVE_MAX_BYTES || "10485760", 10);

async function main() {
  let mod;
  try {
    mod = await import(${JSON.stringify(targetFileUrl)});
  } catch (err) {
    console.error(err && (err.stack || err.message) ? err.stack || err.message : String(err));
    process.exit(1);
  }

  if (typeof mod.default !== "function") {
    const hasDefault = "default" in mod;
    const msg = hasDefault
      ? \`Directive script (data-bascik-\${kind}) default export must be a callable function, received \${typeof mod.default}. Expected: export default async function() { ... }\`
      : \`Directive script (data-bascik-\${kind}) missing default export. Expected: export default async function() { ... }\`;
    console.error(msg);
    process.exit(1);
  }

  let result;
  try {
    result = await mod.default();
  } catch (err) {
    console.error(err && (err.stack || err.message) ? err.stack || err.message : String(err));
    process.exit(1);
  }

  if (kind === "build") {
    if (typeof result !== "string") {
      console.error(\`Directive script (data-bascik-build) must return a string (or Promise resolving to a string). Received \${result === null ? "null" : typeof result}.\`);
      process.exit(1);
    }
  } else if (kind === "routes") {
    if (!Array.isArray(result)) {
      console.error(\`Directive script (data-bascik-routes) must return an array (or Promise resolving to an array). Received \${result === null ? "null" : typeof result}.\`);
      process.exit(1);
    }
  }

  const envelope = {
    version: ${ENVELOPE_VERSION},
    kind,
    result
  };

  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch (err) {
    console.error(\`Directive script (data-bascik-\${kind}) result serialization failed: \${err?.message || String(err)}\`);
    process.exit(1);
  }

  const byteLength = Buffer.byteLength(serialized, "utf8");
  // Envelope metadata overhead (~60 bytes) is accounted for separately from user payload
  const envelopeOverhead = 100;
  if (byteLength > maxBytes + envelopeOverhead) {
    console.error(\`Directive script (data-bascik-\${kind}) result exceeded limit of \${maxBytes} bytes (size: \${byteLength} bytes).\`);
    process.exit(1);
  }

  writeFileSync(resultFile, serialized, { encoding: "utf8", mode: 0o600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

  await writeFile(runnerScriptPath, runnerCode, { encoding: "utf8", mode: 0o600 });

  await semaphore.acquire();
  let cleanupSpill: () => Promise<void> = async () => {};

  try {
    const spill = await spillLargeEnv(childEnv);
    cleanupSpill = spill.cleanup;

    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        let settled = false;

        const settle = (err: Error | null, rawStdout: string, rawStderr: string): void => {
          if (settled) return;
          settled = true;
          const cleanedStdout = rawStdout ? stripAnsiEscapeCodes(rawStdout) : "";
          const cleanedStderr = rawStderr ? stripAnsiEscapeCodes(rawStderr) : "";
          if (err) {
            reject(Object.assign(err, { stdout: cleanedStdout, stderr: cleanedStderr }));
          } else {
            resolve({ stdout: cleanedStdout, stderr: cleanedStderr });
          }
        };

        execFile(
          process.execPath,
          [...spill.execArgv, runnerScriptPath, ...args],
          {
            cwd: process.cwd(),
            env: childEnv as Record<string, string>,
            timeout: timeoutMs,
            maxBuffer,
            killSignal: "SIGTERM",
          },
          (err, rawStdout, rawStderr) => {
            settle(err, rawStdout ?? "", rawStderr ?? "");
          },
        );
      },
    );

    // Verify result file exists and is within limit before reading into parent
    let fileStats;
    try {
      fileStats = await stat(resultFilePath);
    } catch {
      throw Object.assign(
        new Error(
          `Directive script (data-bascik-${kind}) exited successfully but produced no result file.\n${stderr}`,
        ),
        { stdout, stderr },
      );
    }

    const envelopeOverhead = 100;
    if (fileStats.size > maxResultBytes + envelopeOverhead) {
      throw Object.assign(
        new Error(
          `Directive script (data-bascik-${kind}) result size (${fileStats.size} bytes) exceeds limit of ${maxResultBytes} bytes.`,
        ),
        { stdout, stderr },
      );
    }

    const rawFile = await readFile(resultFilePath, "utf8");
    let envelope: { version: number; kind: string; result: T };
    try {
      envelope = JSON.parse(rawFile);
    } catch (err: any) {
      throw Object.assign(
        new Error(
          `Directive script (data-bascik-${kind}) produced a malformed result envelope: ${err?.message}`,
        ),
        { stdout, stderr },
      );
    }

    if (envelope.version !== ENVELOPE_VERSION || envelope.kind !== kind) {
      throw Object.assign(
        new Error(
          `Directive script (data-bascik-${kind}) result envelope mismatch (version: ${envelope.version}, kind: ${envelope.kind}).`,
        ),
        { stdout, stderr },
      );
    }

    return {
      result: envelope.result,
      stdout,
      stderr,
    };
  } finally {
    await cleanupSpill().catch(() => {});
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    semaphore.release();
  }
};
