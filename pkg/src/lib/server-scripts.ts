/**
 * @module server-scripts
 *
 * In-Process Server-time Script Execution
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `<script data-bascik-server>` blocks are executed at request time in-process
 * as Node.js ESM modules using the ScriptRegistry. Whatever the script function
 * returns (or exports as default) is injected into the page in place of the
 * script tag on every request.
 *
 * @example
 * ```html
 * <script data-bascik-server>
 * import { escapeHtml } from '@bascik/bascik';
 * export default function({ req }) {
 *   const name = escapeHtml(req.headers['x-display-name'] ?? 'Guest');
 *   return `<p>Welcome, ${name}</p>`;
 * }
 * </script>
 * ```
 */

import { resolve, relative, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { BascikConfig } from "./config.ts";
import { cleanStackTrace } from "./stack-trace.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { scriptRegistry, type ScriptExecutionResult } from "./script-registry.ts";
import { stripAnsiEscapeCodes } from "./script-runner.ts";
import { LeadingSlashSpecifierError, resolveScriptSrcPath, rewriteModuleSpecifiers } from "./module-specifiers.ts";
import { getImportRoot } from "./import-root.ts";
import {
  ATTR,
  BUILD_FLAG,
  ROUTES_FLAG,
  SERVER_FLAG,
  STREAM_FLAG,
  SCRIPT_TAG_PREFIX,
  SERVER_ATTR_NAME,
  STREAM_ATTR_NAME,
  getHtmlAttributeValue,
} from "./html-patterns.ts";
import type { ServerScriptMode } from "./server-sidecar.ts";

/** Request context passed to every `data-bascik-server` script. */
export interface ServerRequest {
  /** URL path without the query string, e.g. `"/about"`. */
  path: string;
  /** HTTP method in uppercase, e.g. `"GET"`. */
  method: string;
  /**
   * Request headers as a plain object.
   * HTTP/2 pseudo-headers (`:path`, `:method`, etc.) are excluded.
   */
  headers: Record<string, string>;
  /** Parsed query parameters as a plain string-to-string object. */
  searchParams: Record<string, string>;
}

export interface ServerScriptContext extends Record<string, unknown> {
  req: ServerRequest;
}

// Match <script data-bascik-server …> … </script> or <script type="text/bascik-server" …> … </script>.
// The attribute is matched as a whole name (SERVER_ATTR_NAME) so
// `data-bascik-server-id` alone is never a script; the placeholder form is
// matched by the `type=` alternative only.
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const createServerScriptRegex = (): RegExp =>
  new RegExp(
    String.raw`<script\b(?:[^>"']|"[^"]*"|'[^']*')*\s(?:${SERVER_ATTR_NAME}|${STREAM_ATTR_NAME})(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>|<script\b(?:[^>"']|"[^"]*"|'[^']*')*type=["']text\/bascik-server["'](?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>`,
    "gi",
  );

// ─── Directive presence and conflict detection ─────────────────────────────────────────
const tagHas = (flag: string): RegExp =>
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  new RegExp(`${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${flag}(?:\\s+${ATTR})*\\s*>`, "i");
const HAS_BUILD_RE = tagHas(BUILD_FLAG);
const HAS_ROUTES_RE = tagHas(ROUTES_FLAG);
const HAS_SERVER_RE = tagHas(SERVER_FLAG);
const HAS_STREAM_RE = tagHas(STREAM_FLAG);

/** The four script directives are mutually exclusive; name the offending pair. */
const findDirectiveConflict = (openTag: string): [string, string] | undefined => {
  const present: string[] = [];
  if (HAS_SERVER_RE.test(openTag)) present.push("data-bascik-server");
  if (HAS_STREAM_RE.test(openTag)) present.push("data-bascik-stream");
  if (HAS_BUILD_RE.test(openTag)) present.push("data-bascik-build");
  if (HAS_ROUTES_RE.test(openTag)) present.push("data-bascik-routes");
  return present.length >= 2 ? [present[0], present[1]] : undefined;
};

/**
 * Return `true` if `html` contains at least one `data-bascik-server` block or placeholder.
 *
 * The Buffer path is a deliberately loose PRE-FILTER (`includes`), not a
 * decision: a false positive only costs one regex run downstream. The string
 * path is exact.
 */
export const htmlHasServerScripts = (html: string | Buffer): boolean => {
  if (Buffer.isBuffer(html)) {
    return html.includes("data-bascik-server") || html.includes("text/bascik-server");
  }
  return createServerScriptRegex().test(html);
};

/** Default execution timeout per server-script (ms). */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Transforms authored server script source into a valid ESM module that exports a default handler.
 * Supports:
 * 1. Authored `export default function({ req }) { ... }` or `export default async ({ req }) => ...`
 * 2. Authored `return <markup>;` top-level body statements
 * 3. Legacy `process.stdout.write(...)` or `console.log(...)` inside the script body (intercepted per-invocation)
 */
export const transformServerScriptSource = (source: string): string => {
  const trimmed = source.trim();

  const escapeHtmlHelper = `const escapeHtml = (val) => {
  if (val === null || val === undefined) return "";
  return String(val).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
};`;

  // If already exports a default function/object
  if (/^\s*export\s+default\b/m.test(trimmed)) {
    return `${escapeHtmlHelper}\n${trimmed}`;
  }

  // Wrap in default async export function with escapeHtml available in scope
  return `${escapeHtmlHelper}
export default async function({ req }, { signal } = {}) {
  let __bascik_out = "";
  const process = {
    ...globalThis.process,
    env: {
      ...globalThis.process?.env,
      BASCIK_REQUEST: JSON.stringify(req),
    },
    stdout: {
      ...globalThis.process?.stdout,
      write: (chunk) => {
        if (chunk !== undefined && chunk !== null) {
          __bascik_out += String(chunk);
        }
        return true;
      },
    },
  };
  const console = {
    ...globalThis.console,
    log: (...args) => {
      __bascik_out += args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\\n";
    },
    warn: globalThis.console?.warn?.bind(globalThis.console),
    error: globalThis.console?.error?.bind(globalThis.console),
  };

  const __result = await (async () => {
${trimmed}
  })();

  if (__result !== undefined && __result !== null) {
    return String(__result);
  }
  return __bascik_out;
};`;
};

interface ScriptJob {
  fullTag: string;
  scriptContent: string;
  openTag: string;
  index: number;
  length: number;
  startLine: number;
  mode: ServerScriptMode;
  output?: string;
  placeholderId?: string;
  srcPath?: string;
  sourceFile?: string;
  sourceLine?: number;
}

export interface StaticSegment {
  kind: "static";
  bytes: Buffer;
}

export interface ScriptSegment {
  kind: "script";
  mode: ServerScriptMode;
  job: ScriptJob;
}

/**
 * A page split into static byte ranges and script jobs, in document order.
 * Built before any byte is written so every predictable error (conflicting
 * directives, unresolvable sidecar id, stale mode marker) throws before the
 * response commits. Segment boundaries fall at `<script` and `</script>`
 * tag edges, which are ASCII, so no multi-byte character straddles one.
 */
export interface ServerScriptPlan {
  segments: Array<StaticSegment | ScriptSegment>;
  /** Index into `segments` of the first `stream` script, or -1 when none. */
  firstStreamIndex: number;
}

/**
 * Locate every `data-bascik-server` / `data-bascik-stream` block or sidecar
 * placeholder in `html` and build the response plan. Pure with respect to the
 * request: no script runs here.
 */
export const planServerScripts = (html: string, filePath?: string): ServerScriptPlan => {
  const matches = [...html.matchAll(createServerScriptRegex())];
  const segments: Array<StaticSegment | ScriptSegment> = [];
  let firstStreamIndex = -1;
  let cursor = 0;

  for (const match of matches) {
    const fullTag = match[0];
    let scriptContent = match[1] ?? match[2] ?? "";
    const index = match.index!;
    const length = fullTag.length;
    const openTag = fullTag.slice(0, fullTag.length - scriptContent.length - "</script>".length);

    const conflict = findDirectiveConflict(openTag);
    if (conflict) {
      const where = filePath ? ` in "${filePath}"` : "";
      throw new Error(
        `[bascik] error: <script> tag has both ${conflict[0]} and ${conflict[1]}${where}. ` +
        `A script can carry only one of data-bascik-build, data-bascik-routes, data-bascik-server, ` +
        `data-bascik-stream. Remove one of the attributes.`,
      );
    }

    let mode: ServerScriptMode = HAS_STREAM_RE.test(openTag) ? "stream" : "server";
    let placeholderId: string | undefined;
    const placeholderValue = getHtmlAttributeValue(fullTag, "data-bascik-server-id");
    let srcPath: string | undefined = getHtmlAttributeValue(fullTag, "src");
    let sourceFile: string | undefined;
    let sourceLine: number | undefined;
    const annotatedSourceFile = getHtmlAttributeValue(fullTag, "data-bascik-source-file");
    if (annotatedSourceFile) sourceFile = decodeURIComponent(annotatedSourceFile);
    const annotatedSourceLine = getHtmlAttributeValue(fullTag, "data-bascik-source-line");
    if (annotatedSourceLine) sourceLine = Number.parseInt(annotatedSourceLine, 10);

    if (placeholderValue) {
      placeholderId = placeholderValue;
      const entry = serverSidecarRegistry.getScript(placeholderId);
      if (!entry) {
        throw new Error(
          `[bascik] Server script placeholder "${placeholderId}" could not be resolved from sidecar. ` +
          `Run \`bascik --build\` to regenerate dist/.bascik/server-scripts.json.`,
        );
      }
      // The sidecar entry is the source of truth for the mode; the marker on
      // the placeholder is a consistency check against a stale sidecar.
      const markerMode: ServerScriptMode = HAS_STREAM_RE.test(openTag) ? "stream" : "server";
      if (entry.mode !== markerMode) {
        throw new Error(
          `[bascik] Server script placeholder "${placeholderId}" is marked ${markerMode} in the HTML but ` +
          `${entry.mode} in the sidecar (stale sidecar). Run \`bascik --build\` to regenerate dist/.`,
        );
      }
      mode = entry.mode;
      scriptContent = entry.source;
      sourceFile = entry.sourceFile;
      sourceLine = entry.sourceLine;
      if (entry.modulePath && !srcPath) srcPath = entry.modulePath;
    }

    const prefix = html.slice(0, index);
    const lineOffset = prefix.split(/\r?\n/).length;
    const openTagLines = openTag.split(/\r?\n/).length - 1;
    const startLine = lineOffset + openTagLines;

    if (index > cursor) {
      segments.push({ kind: "static", bytes: Buffer.from(html.slice(cursor, index), "utf8") });
    }
    if (mode === "stream" && firstStreamIndex === -1) firstStreamIndex = segments.length;
    segments.push({
      kind: "script",
      mode,
      job: { fullTag, scriptContent, openTag, index, length, startLine, mode, placeholderId, srcPath, sourceFile, sourceLine },
    });
    cursor = index + length;
  }

  if (cursor < html.length) {
    segments.push({ kind: "static", bytes: Buffer.from(html.slice(cursor), "utf8") });
  }
  return { segments, firstStreamIndex };
};

/**
 * Load and invoke one script job. Returns its output string, or `""` under
 * `onServerScriptError: warn | ignore`. Throws under `"error"`. The caller
 * decides what a throw means: a 500 before commit, an empty slot after.
 */
export const runServerScriptJob = async (
  job: ScriptJob,
  request: ServerRequest,
  timeoutMs: number,
  filePath?: string,
  signal?: AbortSignal,
): Promise<string> => {
  const importRoot = getImportRoot();
  let codeToExecute = job.scriptContent.trim();
  let moduleFilePath: string | undefined;

  // A leading-slash specifier or src= is a hard error regardless of
  // onServerScriptError: it is a syntax mistake in the author's HTML, not
  // a runtime failure of their script.
  const rethrowLeadingSlash = (err: unknown): never => {
    if (err instanceof LeadingSlashSpecifierError) {
      const where = job.sourceFile ?? filePath;
      const location = where
        ? ` (in "${relative(process.cwd(), where).replace(/\\/g, "/")}"${job.sourceLine !== undefined ? ` at line ${job.sourceLine}` : ""})`
        : "";
      throw new Error(`[bascik] error: ${err.message}${location}`, { cause: err });
    }
    throw err;
  };

  if (job.srcPath) {
    const containingFile = job.sourceFile ?? filePath;
    const containingDir = containingFile
      ? dirname(resolve(process.cwd(), containingFile))
      : process.cwd();
    let resolvedPath: string;
    try {
      resolvedPath = resolveScriptSrcPath(job.srcPath, containingDir, importRoot);
    } catch (err) {
      return rethrowLeadingSlash(err);
    }
    moduleFilePath = resolvedPath;
    if (!codeToExecute) {
      try {
        codeToExecute = await readFile(resolvedPath, "utf8");
      } catch (err) {
        console.warn('[bascik] warning: Failed to read server script src "%s":', job.srcPath, err);
      }
    }
  }

  const containingFile = job.sourceFile ?? filePath;
  const scriptBaseDir = moduleFilePath
    ? dirname(moduleFilePath)
    : containingFile
      ? dirname(resolve(process.cwd(), containingFile))
      : process.cwd();
  let rewrittenCode: string;
  try {
    rewrittenCode = rewriteModuleSpecifiers(codeToExecute, scriptBaseDir, { importRoot });
  } catch (err) {
    return rethrowLeadingSlash(err);
  }
  const trimmedCode = rewrittenCode.trim();
  const transformedCode = transformServerScriptSource(rewrittenCode);
  const transformedSourceIndex = transformedCode.indexOf(trimmedCode);
  const generatedPrefixLines = transformedSourceIndex < 0
    ? 0
    : (transformedCode.slice(0, transformedSourceIndex).match(/\n/g) ?? []).length;
  const authoredLeadingLines = (rewrittenCode.slice(0, rewrittenCode.indexOf(trimmedCode)).match(/\n/g) ?? []).length;
  const lineOffset = job.sourceLine === undefined || moduleFilePath
    ? job.startLine
    : job.sourceLine + authoredLeadingLines - generatedPrefixLines;
  const dataUri = `data:text/javascript;charset=utf-8,${encodeURIComponent(transformedCode)}`;
  const specifier = moduleFilePath ?? dataUri;

  const context: ServerScriptContext = { req: request };

  const originalSourcePath = containingFile
    ? relative(process.cwd(), containingFile).replace(/\\/g, "/")
    : request.path;

  const result: ScriptExecutionResult<unknown> = await scriptRegistry.invoke(
    specifier,
    context,
    {
      timeoutMs,
      originalSourcePath,
      lineOffset,
      exportName: "default",
      ...(signal ? { signal } : {}),
    },
  );

  if (result.ok) {
    const val = result.value;
    const strVal = typeof val === "string" ? val : (val !== undefined && val !== null ? String(val) : "");
    return stripAnsiEscapeCodes(strVal);
  }

  const behavior = BascikConfig.scripts?.onServerScriptError ?? "error";
  const err = result.error ?? new Error("Server script error");
  if (result.isNetworkReset) return "";

  const rawTrace = err.stack || err.message;
  const cleanedMsg = cleanStackTrace(rawTrace, specifier, originalSourcePath, lineOffset);
  const errorMsg = `[bascik] server script error at "${request.path}":\n${cleanedMsg}`;
  if (behavior === "error") throw new Error(errorMsg);
  if (behavior === "warn") console.warn(errorMsg);
  return "";
};

/**
 * Buffered execution of a plan: every job runs (concurrently), then outputs are
 * joined with the static segments into one Buffer. This is the byte-for-byte
 * behavior every `data-bascik-server` page has always had.
 */
export const executeServerScriptPlan = async (
  plan: ServerScriptPlan,
  request: ServerRequest,
  timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
  filePath?: string,
): Promise<Buffer> => {
  const outputs = await Promise.all(
    plan.segments.map((segment) =>
      segment.kind === "script" ? runServerScriptJob(segment.job, request, timeoutMs, filePath) : undefined,
    ),
  );
  return Buffer.concat(
    plan.segments.map((segment, i) =>
      segment.kind === "static" ? segment.bytes : Buffer.from(outputs[i] ?? "", "utf8"),
    ),
  );
};

/**
 * Find every `<script data-bascik-server>` block or placeholder in `html`, execute each
 * in-process via ScriptRegistry with the supplied request context, and replace the tag
 * with the script's output. Thin wrapper over plan-then-execute; observable behavior
 * is unchanged from before the planner existed.
 */
export const executeServerScripts = async (
  html: string,
  request: ServerRequest,
  timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
  filePath?: string,
): Promise<string> => {
  const plan = planServerScripts(html, filePath);
  if (plan.segments.every((segment) => segment.kind === "static")) return html;
  return (await executeServerScriptPlan(plan, request, timeoutMs, filePath)).toString("utf8");
};

/** Where streamed bytes go. Prompt 66 gives this backpressure; here it is a plain write. */
export interface ResponseSink {
  write(buf: Buffer): Promise<void>;
}

export interface ServerScriptStreamer {
  /** Resolves once every `server` job has resolved; rejects if one throws (caller has not committed). */
  ready: Promise<void>;
  /**
   * The caller invokes this exactly once, after `ready` resolves and after it
   * has sent headers. Phase two (writing to the sink) does not start before it.
   */
  commit(): void;
  /** Resolves once every segment has been written to the sink (or the signal aborted). */
  done: Promise<void>;
}

/**
 * Two-phase streaming execution (prompt 65).
 *
 * Phase one: start every `server` job and await all of them. A throw
 * propagates through `ready`; the caller has not yet committed headers, so it
 * can still respond with a 500.
 *
 * Phase two (after the caller commits): walk the segments in document order.
 * Static bytes are written as reached; `server` outputs are already known;
 * `stream` jobs are started eagerly when phase two begins and their bytes are
 * awaited when their turn comes, so a fast later script waits for an earlier
 * slow one. A `stream` job that throws under `"error"` cannot become a 500
 * (headers are sent): it is logged at error severity and written as empty.
 * If `signal` aborts, the walk stops and the sink is not called again.
 */
export const streamServerScripts = (
  plan: ServerScriptPlan,
  request: ServerRequest,
  timeoutMs: number,
  filePath: string | undefined,
  sink: ResponseSink,
  signal?: AbortSignal,
): ServerScriptStreamer => {
  const serverOutputs = new Map<number, Promise<string>>();
  for (let i = 0; i < plan.segments.length; i++) {
    const segment = plan.segments[i];
    if (segment.kind === "script" && segment.mode === "server") {
      serverOutputs.set(i, runServerScriptJob(segment.job, request, timeoutMs, filePath, signal));
    }
  }
  const ready = Promise.all(serverOutputs.values()).then(() => undefined);

  let releaseCommit!: () => void;
  const committed = new Promise<void>((resolveCommit) => {
    releaseCommit = resolveCommit;
  });

  const runStreamJob = async (segment: ScriptSegment): Promise<string> => {
    try {
      return await runServerScriptJob(segment.job, request, timeoutMs, filePath, signal);
    } catch (err) {
      if (signal?.aborted) return "";
      // Status is already committed; this can never be a 500. Same message
      // shape `warn` uses, at error severity.
      console.error(err instanceof Error ? err.message : String(err));
      return "";
    }
  };

  const done = (async () => {
    // A phase-one failure is reported through `ready`; `done` then resolves
    // quietly so a caller that never commits is not left with a second,
    // unhandled rejection.
    try {
      await ready;
    } catch {
      return;
    }
    await committed;
    // Start every stream job now; bytes still wait their turn.
    const streamOutputs = new Map<number, Promise<string>>();
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[i];
      if (segment.kind === "script" && segment.mode === "stream") {
        streamOutputs.set(i, runStreamJob(segment));
      }
    }
    for (let i = 0; i < plan.segments.length; i++) {
      if (signal?.aborted) return;
      const segment = plan.segments[i];
      if (segment.kind === "static") {
        await sink.write(segment.bytes);
        continue;
      }
      const output = await (segment.mode === "server" ? serverOutputs.get(i)! : streamOutputs.get(i)!);
      if (signal?.aborted) return;
      if (output) await sink.write(Buffer.from(output, "utf8"));
    }
  })();

  return { ready, commit: releaseCommit, done };
};
