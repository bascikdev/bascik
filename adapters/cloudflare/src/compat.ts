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

/** The compatibility settings a Worker deploys with. */
export interface CompatSettings {
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
  /** Where they come from, for messages (`wrangler.jsonc env.staging`). */
  source?: string;
}

const PINNED: CompatSettings = {
  compatibilityDate: CLOUDFLARE_COMPATIBILITY_DATE,
  compatibilityFlags: CLOUDFLARE_COMPATIBILITY_FLAGS,
};

interface DateGate {
  /** The first compatibility date that provides the module. */
  since: string;
  /** The flag that provides it before then. */
  enable: string;
  /** The flag that removes it at any date. */
  disable: string;
}

const gate = (since: string, flag: string): DateGate => ({
  since,
  enable: `enable_${flag}`,
  disable: `disable_${flag}`,
});

/**
 * Supported modules that workerd (with `nodejs_compat`) provides only from a
 * compatibility date on: the dates and flags of `@cloudflare/unenv-preset`,
 * which Wrangler bundles with, checked against workerd itself
 * (authored-wrangler.test.ts loads each one at its date). An older date
 * fails at deploy or at the first request with `No such module`, so the
 * build classifies against the date the Worker deploys with.
 */
export const NODE_BUILTIN_DATE_GATES: Readonly<Record<string, DateGate>> = {
  http: gate("2025-08-15", "nodejs_http_modules"),
  https: gate("2025-08-15", "nodejs_http_modules"),
  fs: gate("2025-09-15", "nodejs_fs_module"),
  "fs/promises": gate("2025-09-15", "nodejs_fs_module"),
  os: gate("2025-09-15", "nodejs_os_module"),
  perf_hooks: gate("2026-03-17", "nodejs_perf_hooks_module"),
};

const bareName = (specifier: string): string =>
  specifier.startsWith("node:") ? specifier.slice(5) : specifier;

/** Whether `compat` provides a supported module (its date gate, if any). */
const providedAt = (bare: string, compat: CompatSettings): boolean => {
  const dateGate = NODE_BUILTIN_DATE_GATES[bare];
  if (!dateGate) return true;
  if (compat.compatibilityFlags.includes(dateGate.disable)) return false;
  return (
    compat.compatibilityDate >= dateGate.since ||
    compat.compatibilityFlags.includes(dateGate.enable)
  );
};

/**
 * Whether the Workers runtime provides a `node:*` import (or its bare
 * spelling) under `compat`, the adapter's pinned settings by default.
 */
export const classifyNodeBuiltin = (
  specifier: string,
  compat: CompatSettings = PINNED,
): NodeBuiltinClass => {
  const bare = bareName(specifier);
  if (!ALL_NODE_BUILTINS.has(bare)) return "not-builtin";
  return WORKERS_SUPPORTED_NODE_BUILTINS.has(bare) && providedAt(bare, compat)
    ? "provided"
    : "unsupported";
};

export const formatUnsupportedImport = (input: {
  specifier: string;
  importer: string;
  projectRoot: string;
  owners: string[];
  /** The settings the Worker deploys with; the pinned ones by default. */
  compat?: CompatSettings;
}): string => {
  const compat = input.compat ?? PINNED;
  const rel = relative(input.projectRoot, input.importer).replace(/\\/g, "/");
  const owners = input.owners.length
    ? `\n  Reached from: ${input.owners.join(", ")}`
    : "";
  const bare = bareName(input.specifier);
  const dateGate = WORKERS_SUPPORTED_NODE_BUILTINS.has(bare)
    ? NODE_BUILTIN_DATE_GATES[bare]
    : undefined;
  const needs = dateGate
    ? compat.compatibilityFlags.includes(dateGate.disable)
      ? `\n  "${input.specifier}" is turned off by the ${dateGate.disable} flag. Remove the flag.`
      : `\n  "${input.specifier}" needs compatibility_date "${dateGate.since}" or later, or the ${dateGate.enable} flag.`
    : "";
  const supported = Array.from(WORKERS_SUPPORTED_NODE_BUILTINS)
    .filter((name) => providedAt(name, compat))
    .sort();
  return (
    `[bascik] --target: "${input.specifier}" (imported by ${rel}) is not available in the Cloudflare Workers runtime ` +
    `for compatibility date ${compat.compatibilityDate}${compat.source ? ` (${compat.source})` : ""}.${owners}${needs}\n` +
    `  Supported node:* modules are: ${supported.join(", ")}.\n` +
    `  Replace it with a Web standard API or a pure-JS package.`
  );
};
