/**
 * @module compat
 *
 * Pinned Cloudflare runtime constants and node builtin classifications.
 */

import { relative } from "node:path";

export const CLOUDFLARE_COMPATIBILITY_DATE = "2026-08-01";
export const CLOUDFLARE_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;
export const PAGES_ROUTES_LIMIT = 100;

export const WORKERS_SUPPORTED_NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "crypto",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "querystring",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "url",
  "util",
  "util/types",
  "zlib",
]);

const ALL_NODE_BUILTINS: ReadonlySet<string> = new Set([
  ...WORKERS_SUPPORTED_NODE_BUILTINS,
  "child_process",
  "cluster",
  "console",
  "constants",
  "dgram",
  "domain",
  "http2",
  "inspector",
  "module",
  "punycode",
  "readline",
  "readline/promises",
  "repl",
  "sys",
  "trace_events",
  "tty",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);

export type NodeBuiltinClass = "provided" | "unsupported" | "not-builtin";

export const classifyNodeBuiltin = (specifier: string): NodeBuiltinClass => {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (!ALL_NODE_BUILTINS.has(bare)) return "not-builtin";
  return WORKERS_SUPPORTED_NODE_BUILTINS.has(bare) ? "provided" : "unsupported";
};

export const formatUnsupportedImport = (input: {
  specifier: string;
  importer: string;
  projectRoot: string;
  owners: string[];
}): string => {
  const rel = relative(input.projectRoot, input.importer).replace(/\\/g, "/");
  const owners = input.owners.length ? `\n  Reached from: ${input.owners.join(", ")}` : "";
  return (
    `[bascik] --target: "${input.specifier}" (imported by ${rel}) is not available in the Cloudflare Workers runtime ` +
    `for compatibility date ${CLOUDFLARE_COMPATIBILITY_DATE}.${owners}\n` +
    `  Supported node:* modules are: ${Array.from(WORKERS_SUPPORTED_NODE_BUILTINS).sort().join(", ")}.\n` +
    `  Replace it with a Web standard API or a pure-JS package.`
  );
};
