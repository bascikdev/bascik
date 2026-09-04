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
import { rewriteRelativeModuleSpecifiers } from "./module-specifiers.ts";
import {
  ATTR,
  BUILD_FLAG,
  ROUTES_FLAG,
  SCRIPT_TAG_PREFIX,
  getHtmlAttributeValue,
} from "./html-patterns.ts";

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

// Match <script data-bascik-server …> … </script> or <script type="text/bascik-server" …> … </script>
const createServerScriptRegex = (): RegExp =>
  /<script\b(?:[^>"']|"[^"]*"|'[^']*')*\sdata-bascik-server\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>|<script\b(?:[^>"']|"[^"]*"|'[^']*')*type=["']text\/bascik-server["'](?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>/gi;

// ─── Conflict regexes ────────────────────────────────────────────────────────
const SERVER_BUILD_CONFLICT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`,
  "i",
);

const SERVER_ROUTES_CONFLICT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${ROUTES_FLAG}(?:\\s+${ATTR})*\\s*>`,
  "i",
);

/** Return `true` if `html` contains at least one `data-bascik-server` block or placeholder. */
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
  output?: string;
  placeholderId?: string;
  srcPath?: string;
  sourceFile?: string;
  sourceLine?: number;
}

/**
 * Find every `<script data-bascik-server>` block or placeholder in `html`, execute each
 * in-process via ScriptRegistry with the supplied request context, and replace the tag
 * with the script's output.
 */
export const executeServerScripts = async (
  html: string,
  request: ServerRequest,
  timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
  filePath?: string,
): Promise<string> => {
  const matches = [...html.matchAll(createServerScriptRegex())];
  if (matches.length === 0) return html;

  const scriptJobs: ScriptJob[] = matches.map((match) => {
    const fullTag = match[0];
    let scriptContent = match[1] ?? match[2] ?? "";
    const index = match.index!;
    const length = fullTag.length;

    let placeholderId: string | undefined;
    const placeholderValue = getHtmlAttributeValue(fullTag, "data-bascik-server-id");
    let srcPath: string | undefined;
    let sourceFile: string | undefined;
    let sourceLine: number | undefined;
    srcPath = getHtmlAttributeValue(fullTag, "src");
    const annotatedSourceFile = getHtmlAttributeValue(fullTag, "data-bascik-source-file");
    if (annotatedSourceFile) sourceFile = decodeURIComponent(annotatedSourceFile);
    const annotatedSourceLine = getHtmlAttributeValue(fullTag, "data-bascik-source-line");
    if (annotatedSourceLine) sourceLine = Number.parseInt(annotatedSourceLine, 10);

    if (placeholderValue) {
      placeholderId = placeholderValue;
      const entry = serverSidecarRegistry.getScript(placeholderId);
      if (entry) {
        scriptContent = entry.source;
        sourceFile = entry.sourceFile;
        sourceLine = entry.sourceLine;
        if (entry.modulePath && !srcPath) {
          srcPath = entry.modulePath;
        }
      } else {
        throw new Error(
          `[bascik] Server script placeholder "${placeholderId}" could not be resolved from sidecar. ` +
          `Run \`bascik --build\` to regenerate dist/.bascik/server-scripts.json.`,
        );
      }
    }

    const prefix = html.slice(0, index);
    const lines = prefix.split(/\r?\n/);
    const lineOffset = lines.length;

    const openTag = fullTag.slice(0, fullTag.length - (match[1] ?? match[2] ?? "").length - "</script>".length);
    if (SERVER_BUILD_CONFLICT_RE.test(openTag)) {
      let errorMsg = `[bascik] error: <script> tag has both data-bascik-server and data-bascik-build`;
      if (filePath) {
        errorMsg += ` in "${filePath}"`;
      }
      throw new Error(`${errorMsg}. A script can only run at build time or at request time — not both. Remove one of the attributes.`);
    }
    if (SERVER_ROUTES_CONFLICT_RE.test(openTag)) {
      let errorMsg = `[bascik] error: <script> tag has both data-bascik-server and data-bascik-routes`;
      if (filePath) {
        errorMsg += ` in "${filePath}"`;
      }
      throw new Error(`${errorMsg}. A script cannot be both a server script and a routes script. Remove one of the attributes.`);
    }

    const openTagLines = openTag.split(/\r?\n/).length - 1;
    const startLine = lineOffset + openTagLines;

    return {
      fullTag,
      scriptContent,
      openTag,
      index,
      length,
      startLine,
      placeholderId,
      srcPath,
      sourceFile,
      sourceLine,
    };
  });

  await Promise.all(
    scriptJobs.map(async (job) => {
      let codeToExecute = job.scriptContent.trim();
      let moduleFilePath: string | undefined;

      if (job.srcPath) {
        const containingFile = job.sourceFile ?? filePath;
        const resolvedPath = containingFile
          ? resolve(dirname(containingFile), job.srcPath)
          : resolve(process.cwd(), job.srcPath);
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
      const rewrittenCode = rewriteRelativeModuleSpecifiers(codeToExecute, scriptBaseDir);
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

      const context: ServerScriptContext = {
        req: request,
      };

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
        },
      );

      if (result.ok) {
        const val = result.value;
        const strVal = typeof val === "string" ? val : (val !== undefined && val !== null ? String(val) : "");
        job.output = stripAnsiEscapeCodes(strVal);
      } else {
        const behavior = BascikConfig.scripts?.onServerScriptError ?? "error";
        const err = result.error ?? new Error("Server script error");

        if (result.isNetworkReset) {
          job.output = "";
          return;
        }

        const rawTrace = err.stack || err.message;
        const cleanedMsg = cleanStackTrace(rawTrace, specifier, originalSourcePath, lineOffset);
        const errorMsg = `[bascik] server script error at "${request.path}":\n${cleanedMsg}`;

        if (behavior === "error") {
          throw new Error(errorMsg);
        } else {
          console.warn(errorMsg);
        }
        job.output = "";
      }
    }),
  );

  let result = html;
  const sortedJobs = scriptJobs.slice().sort((a, b) => b.index - a.index);
  for (const job of sortedJobs) {
    result =
      result.slice(0, job.index) +
      (job.output ?? "") +
      result.slice(job.index + job.length);
  }
  return result;
};
