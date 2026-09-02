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
import { escapeHtml } from "./escape-html.ts";

export { cleanStackTrace, escapeHtml };

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

// Strip ANSI terminal color sequences so server-side HTML injection never leaks terminal formatting.
const stripAnsiEscapeCodes = (value: string): string =>
  value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "");

const BARE_TOKEN = String.raw`[^\s"'=<>\`]+`;
const ATTR_VALUE = String.raw`(?:"[^"]*"|'[^']*'|${BARE_TOKEN})`;
const ATTR = String.raw`${BARE_TOKEN}(?:\s*=\s*${ATTR_VALUE})?`;
const BUILD_FLAG = String.raw`data-bascik-build(?:\s*=\s*${ATTR_VALUE})?`;
const ROUTES_FLAG = String.raw`data-bascik-routes(?:\s*=\s*${ATTR_VALUE})?`;

const SCRIPT_TAG_PREFIX = "<script\\b";

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
    const idMatch = fullTag.match(/\bdata-bascik-server-id=["']([^"']+)["']/i);
    let srcPath: string | undefined;
    const srcMatch = fullTag.match(/\bsrc=["']([^"']+)["']/i);
    if (srcMatch) {
      srcPath = srcMatch[1];
    }

    if (idMatch) {
      placeholderId = idMatch[1];
      const entry = serverSidecarRegistry.getScript(placeholderId);
      if (entry) {
        scriptContent = entry.source;
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
    };
  });

  await Promise.all(
    scriptJobs.map(async (job) => {
      let codeToExecute = job.scriptContent.trim();
      let moduleFilePath: string | undefined;

      if (job.srcPath) {
        const resolvedPath = filePath
          ? resolve(dirname(filePath), job.srcPath)
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

      const transformedCode = transformServerScriptSource(codeToExecute);
      const dataUri = `data:text/javascript;charset=utf-8,${encodeURIComponent(transformedCode)}`;
      const specifier = moduleFilePath ?? dataUri;

      const context: ServerScriptContext = {
        req: request,
      };

      const relPath = filePath ? relative(process.cwd(), filePath).replace(/\\/g, "/") : request.path;

      const result: ScriptExecutionResult<unknown> = await scriptRegistry.invoke(
        specifier,
        context,
        {
          timeoutMs,
          originalSourcePath: relPath,
          lineOffset: job.startLine,
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
        const cleanedMsg = cleanStackTrace(rawTrace, specifier, relPath, job.startLine);
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
