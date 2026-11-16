import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
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
import { describeNonErrorThrow } from "./thrown-value.ts";

export type DirectiveKind = "build" | "routes";

export interface DirectiveHandlerResult<T = unknown> {
  result: T;
  stdout: string;
  stderr: string;
  /**
   * Whether the script looked at the page it ran for: read, tested for, or
   * enumerated `BASCIK_PAGE_PATH`, `BASCIK_PAGE_FILE`, or `BASCIK_ROUTE`.
   * When it did not, its output is the same on every page.
   */
  readsPageContext: boolean;
}

/**
 * The error a failed directive script rejects with. `readsPageContext` is
 * true when the script had looked at its page context before it failed.
 */
export type DirectiveHandlerError = Error & {
  stdout?: string;
  stderr?: string;
  readsPageContext?: boolean;
};

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
const killSignal = "SIGTERM";

/**
 * The runner each child process starts with. It is the same for every script
 * (the script to run comes in the environment), so it is written once per
 * process and Node's compile cache can reuse its compiled code.
 */
const RUNNER_CODE = `
import { writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const resultFile = process.env.BASCIK_DIRECTIVE_RESULT_FILE;
const kind = process.env.BASCIK_DIRECTIVE_KIND;
const maxBytes = parseInt(process.env.BASCIK_DIRECTIVE_MAX_BYTES || "10485760", 10);
const target = process.env.BASCIK_DIRECTIVE_TARGET;

// Record whether the script looks at the page it runs for. Enumerating the
// environment (spreading it, passing it to a child process) counts as a look.
const PAGE_CONTEXT = new Set(["BASCIK_PAGE_PATH", "BASCIK_PAGE_FILE", "BASCIK_ROUTE"]);
let readsPageContext = false;
const watch = (key) => {
  if (PAGE_CONTEXT.has(key)) readsPageContext = true;
};
process.env = new Proxy(process.env, {
  get(target, key) {
    watch(key);
    return Reflect.get(target, key);
  },
  has(target, key) {
    watch(key);
    return Reflect.has(target, key);
  },
  getOwnPropertyDescriptor(target, key) {
    watch(key);
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
  ownKeys(target) {
    readsPageContext = true;
    return Reflect.ownKeys(target);
  },
});
// A script that fails writes no result, so a failed run says here whether it
// had looked at its page. The component manifest runs a script with no page:
// one that needs a page and throws without it is page-dependent, not broken.
process.on("exit", (code) => {
  if (code === 0 || !readsPageContext) return;
  try {
    writeFileSync(resultFile + ".page-context", "", { mode: 0o600 });
  } catch {
    // best effort
  }
});

// Bascik holds the other end of stdin for as long as it lives and never
// writes to it. Its end therefore means Bascik is gone (stopped, killed, or
// its page worker ended): nothing will read this script's result, and the
// timeout that would have stopped it is gone too. Stop instead of running on.
// Unref'd, so stdin alone never keeps a finished script alive. Only for the
// pipe Bascik starts a script with: a terminal or a file says nothing about
// who started the script.
try {
  const stdin = process.stdin;
  if (!stdin.isTTY && typeof stdin.unref === "function") {
    stdin.unref();
    stdin.on("end", () => process.exit(1));
    stdin.resume();
  }
} catch {
  // No usable stdin: nothing to watch.
}

// A thrown string, null or empty rejection: what it was, since it names no line.
${describeNonErrorThrow.toString()}

let mod;
try {
  mod = await import(target);
} catch (err) {
  // A caught SyntaxError carries no location. Left uncaught at the top level,
  // Node prints the file, the line, and a caret under the offending token.
  if (err instanceof SyntaxError) throw err;
  console.error(err && (err.stack || err.message) ? err.stack || err.message : describeNonErrorThrow(err));
  process.exit(1);
}

async function main() {
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
    console.error(err && (err.stack || err.message) ? err.stack || err.message : describeNonErrorThrow(err));
    process.exit(1);
  }

  if (kind === "build") {
    // An html\`...\` value from @bascik/bascik/html (a registered-symbol brand)
    // is HTML a shared helper built; it stringifies to that HTML.
    if (
      result !== null &&
      typeof result === "object" &&
      typeof result[Symbol.for("bascik.html")] === "string"
    )
      result = String(result);
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
    result,
    readsPageContext
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
  console.error(err && (err.stack || err.message) ? err.stack || err.message : describeNonErrorThrow(err));
  process.exit(1);
});
`;

let runnerDirectory: Promise<string> | undefined;
let resultCounter = 0;

/**
 * A private directory holding the runner, made once per process (or thread)
 * and removed at exit. A directory a temp-file cleaner deleted is made again
 * once; a temp directory that cannot be written is an error, not a retry loop.
 */
const getRunnerDirectory = async (recreated = false): Promise<string> => {
  const pending = (runnerDirectory ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-handler-"));
    await writeFile(join(dir, "runner.mjs"), RUNNER_CODE, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.once("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });
    return dir;
  })());
  let dir: string;
  try {
    dir = await pending;
  } catch (err) {
    if (runnerDirectory === pending) runnerDirectory = undefined;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[bascik] Cannot create the script runner directory in "${tmpdir()}": ${reason}. Build and routes scripts run from a temporary directory; point TMPDIR (TEMP on Windows) at a writable directory.`,
      { cause: err },
    );
  }
  // A temp-file cleaner can delete the directory during a long dev session.
  const present = await stat(join(dir, "runner.mjs")).then(
    () => true,
    () => false,
  );
  if (present) return dir;
  if (runnerDirectory === pending) runnerDirectory = undefined;
  if (recreated)
    throw new Error(
      `[bascik] The script runner directory "${dir}" disappeared right after it was created. Check what is removing files from "${tmpdir()}".`,
    );
  return getRunnerDirectory(true);
};

/** A byte count as the limit reads in prose: whole megabytes, or bytes. */
const formatLimit = (bytes: number): string =>
  bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0
    ? `${bytes / (1024 * 1024)} MB`
    : `${bytes} bytes`;

/**
 * Print what a build or routes script wrote, once, before anything Bascik
 * prints about it. Text that does not end with a newline ("Loading...")
 * gets one, so the next line (a located error header, a page count) starts
 * on a line of its own.
 */
export const echoScriptOutput = (output: {
  stdout?: unknown;
  stderr?: unknown;
}): void => {
  for (const [text, stream] of [
    [output.stdout, process.stdout],
    [output.stderr, process.stderr],
  ] as const) {
    if (typeof text !== "string" || text === "") continue;
    stream.write(text.endsWith("\n") ? text : `${text}\n`);
  }
};

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

  const runDir = await getRunnerDirectory();
  const runnerScriptPath = join(runDir, "runner.mjs");
  const resultFilePath = join(runDir, `${++resultCounter}.result.json`);
  const pageContextMarkerPath = `${resultFilePath}.page-context`;

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    BASCIK_BUILD: BascikConfig.isBuild ? "1" : "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extraEnv,
    BASCIK_DIRECTIVE_RESULT_FILE: resultFilePath,
    BASCIK_DIRECTIVE_TARGET: pathToFileURL(modulePath).href,
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
  if (
    childEnv.NODE_COMPILE_CACHE === undefined &&
    childEnv.NODE_DISABLE_COMPILE_CACHE === undefined
  ) {
    childEnv.NODE_COMPILE_CACHE = join(
      process.cwd(),
      "node_modules",
      ".cache",
      "bascik",
      "compile-cache",
    );
  }

  // The runner's own frames (`at main (file:///…/runner.mjs:29:31)`) sit under
  // every error the user's script throws. They are Bascik's, so they are removed.
  const runnerReferences = [
    runnerScriptPath,
    pathToFileURL(runnerScriptPath).href,
  ];
  const withoutRunnerFrames = (text: string): string =>
    text
      .split("\n")
      .filter(
        (line) =>
          !(
            line.trimStart().startsWith("at ") &&
            runnerReferences.some((ref) => line.includes(ref))
          ),
      )
      .join("\n");

  await semaphore.acquire();
  let cleanupSpill: () => Promise<void> = async () => {};

  try {
    const spill = await spillLargeEnv(childEnv);
    cleanupSpill = spill.cleanup;

    const { stdout, stderr } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      let settled = false;

      const settle = (
        err: Error | null,
        rawStdout: string,
        rawStderr: string,
      ): void => {
        if (settled) return;
        settled = true;
        const cleanedStdout = rawStdout ? stripAnsiEscapeCodes(rawStdout) : "";
        const cleanedStderr = rawStderr
          ? withoutRunnerFrames(stripAnsiEscapeCodes(rawStderr))
          : "";
        if (err) {
          // One message carries the whole report: what the script wrote to
          // stderr (its error, and anything it logged first). Callers print
          // the message once and do not print stderr separately.
          const failure = err as Error & {
            killed?: boolean;
            signal?: string;
            code?: unknown;
          };
          const report = cleanedStderr.trim();
          const timedOut =
            failure.killed === true && failure.signal === killSignal;
          // A string code (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, `ENOENT`) means Node
          // itself stopped the child, so the script's stderr is not the reason. A
          // numeric code is the script's exit code, and stderr is its report.
          // Checked before the timeout: Node also kills the child, with the same
          // signal, when its output goes over maxBuffer.
          const stoppedByNode = typeof failure.code === "string";
          // Over the output limit, Node stops the child and hands back the
          // first `maxBuffer` bytes of that stream: megabytes of it, with no
          // newline, that would bury the error report. None of it is shown.
          const overLimit =
            failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const overStream = /^stderr\b/.test(failure.message)
            ? "stderr"
            : "stdout";
          const withReport = (reason: string): string =>
            report ? `${reason}\n${report}` : reason;
          // Exit code 13 is Node's "unsettled top-level await": the script
          // awaited a promise that never settled and the event loop emptied.
          // Node's warning names Bascik's runner file and line, not the
          // script, so it is replaced by a sentence about the script; what the
          // script logged before is kept (audit 159 finding 52).
          const unsettledWarning =
            /(?:^|\n)Warning: Detected unsettled top-level await at [^\n]*(?:\n[^\n]*\n[ \t]*\^[^\n]*)?/;
          const unsettled =
            failure.code === 13 && unsettledWarning.test(report);
          const overLimitReason = `Directive script (data-bascik-${kind}) failed: it wrote more than ${formatLimit(maxBuffer)} to ${overStream}, so it was stopped and its output is not shown. Write large data to a file, or return it, instead of logging it.`;
          // Its stderr is still its report when only stdout overflowed.
          failure.message = overLimit
            ? overStream === "stdout"
              ? withReport(overLimitReason)
              : overLimitReason
            : unsettled
              ? (() => {
                  const logged = report.replace(unsettledWarning, "").trim();
                  const reason = `Directive script (data-bascik-${kind}) ended without finishing its top-level await: a promise it awaited never settled (resolved or rejected), so the script stopped before returning any output. Make sure every awaited promise resolves or rejects.`;
                  return logged ? `${reason}\n${logged}` : reason;
                })()
              : stoppedByNode
                ? withReport(
                    `Directive script (data-bascik-${kind}) failed: ${withoutRunnerFrames(failure.message).split("\n")[0]}`,
                  )
                : timedOut
                  ? withReport(
                      `Directive script (data-bascik-${kind}) timed out after ${timeoutMs}ms`,
                    )
                  : report || withoutRunnerFrames(failure.message);
          reject(
            Object.assign(failure, {
              stdout: overLimit ? "" : cleanedStdout,
              stderr: "",
            }),
          );
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
          killSignal,
        },
        (err, rawStdout, rawStderr) => {
          settle(err, rawStdout ?? "", rawStderr ?? "");
        },
      );
    }).catch(async (err: DirectiveHandlerError) => {
      // The runner leaves this marker when a failed script had read its page.
      err.readsPageContext = await stat(pageContextMarkerPath).then(
        () => true,
        () => false,
      );
      throw err;
    });

    // Verify result file exists and is within limit before reading into parent
    let fileStats;
    try {
      fileStats = await stat(resultFilePath);
    } catch {
      throw Object.assign(
        new Error(
          `Directive script (data-bascik-${kind}) exited successfully but produced no result file.`,
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
    let envelope: {
      version: number;
      kind: string;
      result: T;
      readsPageContext?: boolean;
    };
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
      // Unknown counts as a look, so output is never shared on a guess.
      readsPageContext: envelope.readsPageContext !== false,
    };
  } finally {
    await cleanupSpill().catch(() => {});
    await rm(resultFilePath, { force: true }).catch(() => {});
    await rm(pageContextMarkerPath, { force: true }).catch(() => {});
    semaphore.release();
  }
};
