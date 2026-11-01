#!/usr/bin/env node
// Audit a project's bascik.config for values that restate defaults and for common mistakes.
// Dependency-free; Node.js 22.22+ (loads bascik.config.ts natively). Run from the project root.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELP = `Usage: node audit-config.mjs [--json] [--strict] [--root <dir>]

Reports, for bascik.config.ts / bascik.config.js:
  error  mistakes that break builds or change behavior unintentionally
  warn   values that restate a built-in default (delete them)
  info   settings worth double-checking

Exit code 1 when there are errors (or warnings with --strict).

Options:
  --json        Print findings as JSON
  --strict      Treat warnings as failures
  --root <dir>  Project root (default: the current directory, or the nearest parent with a config)
  --help        Show this message`;

/**
 * Built-in defaults that do not depend on the CLI mode. Values set to these in any export are redundant.
 * Kept in sync with pkg/src/lib/config.ts by pkg/src/lib/agent-skill-config-defaults.test.ts.
 */
export const KNOWN_DEFAULTS = {
  "directory.pages": "src/pages",
  "directory.components": ["src/components"],
  "directory.out": "dist",
  "directory.api": "src/api",
  "components.external": [],
  "components.expansionLimits.maxInstances": 10000,
  "components.expansionLimits.maxPageLength": 52428800,
  "scoping.scriptBlocks": true,
  "scoping.inheritAttributes": true,
  "scoping.attributes.class": true,
  "scoping.attributes.id": true,
  "scoping.attributes.name": false,
  "scoping.preserve": ["code"],
  "scoping.deduplicateCss": true,
  "assets.inlineStyles": false,
  "assets.exclude": [],
  "assets.symlink": false,
  "generate.sitemap": true,
  "generate.robots": true,
  "generate.sitemapLastmod": false,
  "generate.cspHashes": false,
  "generate.manifest": false,
  "pipeline.watchPaths": [],
  "pipeline.exec": [],
  "pipeline.workers": false,
  "scripts.cache.enabled": true,
  "scripts.typescript": true,
  "scripts.onBuildScriptError": "error",
  "scripts.onRoutesScriptError": "error",
  "scripts.onServerScriptError": "error",
  "scripts.timeout": 30000,
  "scripts.importRoot": "src",
  "scripts.stripAnsi": true,
  "scripts.renderLimits.maxInstances": 1000,
  "scripts.renderLimits.maxOutputLength": 4194304,
  "scripts.renderLimits.maxNestedScripts": 64,
  "scripts.renderLimits.maxDepth": 4,
  "scripts.renderLimits.rescanFactor": 16,
  "scripts.renderLimits.rescanBase": 33554432,
  "http.hostname": "localhost",
  "http.tls.enabled": false,
  "http.rateLimit": true,
  "http.trustProxy": false,
  "http.cacheControl": "public, max-age=3600",
  "http.compression": true,
  "http.precompress": false,
  "http.maxBodySize": 1048576,
  "http.apiTimeout": 10000,
  "http.timeouts.request": 30000,
  "http.timeouts.keepAlive": 5000,
  "logging.level": "info",
  "logging.requests": true,
  "logging.copies": true,
  "logging.deletes": true,
  "logging.transpiles": true,
  base: "/",
  "security.blockScriptUrls": true,
  "security.blockCodeBindings": true,
  "security.headers": true,
  "security.hsts": true,
  "security.privateDynamicPages": true,
  "security.stripDirectiveScripts": true,
  "security.hideDotfiles": true,
};

/**
 * Defaults that differ by mode. Setting one of these in the default export applies it to every mode,
 * so it is never redundant there; in a mode export it is redundant when it equals that mode's value.
 */
export const MODE_DEFAULTS = {
  dev: {
    "minify.html": false,
    "minify.css": false,
    "minify.js": false,
    "minify.identifiers": false,
    onMinifyError: "warn",
    "http.httpCache": false,
    "pipeline.onExecError": "warn",
  },
  build: {
    "minify.html": true,
    "minify.css": true,
    "minify.js": true,
    "minify.identifiers": true,
    onMinifyError: "error",
    "pipeline.onExecError": "error",
  },
  server: {
    "minify.html": true,
    "minify.css": true,
    "minify.js": true,
    "minify.identifiers": true,
    onMinifyError: "error",
    "http.httpCache": true,
  },
};

const EXPORTS = ["default", "dev", "build", "server"];
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function flatten(value, prefix = "", out = {}) {
  if (!isPlainObject(value)) {
    out[prefix] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child === undefined) continue;
    if (isPlainObject(child)) {
      if (Object.keys(child).length > 0) flatten(child, path, out);
      continue;
    }
    out[path] = child;
  }
  return out;
}

function sameValue(a, b) {
  if (typeof a === "function" || typeof b === "function") return false;
  const normalize = (v) => (Array.isArray(v) ? JSON.stringify(v) : v);
  return normalize(a) === normalize(b);
}

/** Expand shorthand forms so they compare with the flattened defaults. */
function normalizeLeaves(flat) {
  const out = { ...flat };
  if (typeof out["minify"] === "boolean") {
    for (const key of ["html", "css", "js", "identifiers"])
      out[`minify.${key}`] = out["minify"];
    delete out["minify"];
  }
  if (typeof out["scripts.cache"] === "boolean") {
    out["scripts.cache.enabled"] = out["scripts.cache"];
    delete out["scripts.cache"];
  }
  if (typeof out["directory.components"] === "string")
    out["directory.components"] = [out["directory.components"]];
  for (const key of [
    "directory.pages",
    "directory.out",
    "directory.api",
    "scripts.importRoot",
  ]) {
    if (typeof out[key] === "string")
      out[key] = out[key].replace(/^\.\//, "").replace(/\/+$/, "");
  }
  if (Array.isArray(out["directory.components"])) {
    out["directory.components"] = out["directory.components"].map((p) =>
      String(p).replace(/^\.\//, "").replace(/\/+$/, ""),
    );
  }
  if (typeof out.base === "string" && /^\/?$/.test(out.base.trim()))
    out.base = "/";
  return out;
}

const inside = (child, parent) =>
  child === parent || child.startsWith(parent + sep);

/** Audit loaded config exports. Pure: filesystem access goes through `exists`. Exported for tests. */
export function auditConfig(module, { root, exists = existsSync } = {}) {
  const findings = [];
  const add = (level, where, message) =>
    findings.push({ level, where, message });
  const layers = Object.fromEntries(
    EXPORTS.map((name) => [
      name,
      isPlainObject(module?.[name]) ? module[name] : undefined,
    ]),
  );
  const flatDefault = layers.default
    ? normalizeLeaves(flatten(layers.default))
    : {};
  let meaningful = 0;

  for (const name of EXPORTS) {
    const layer = layers[name];
    if (!layer) continue;
    const label = name;
    if ("siteUrl" in layer) {
      add(
        "error",
        `${label}.siteUrl`,
        "siteUrl is not a config option. Set BASCIK_SITE_URL, pass --site-url, or add it to .env.",
      );
    }
    const flat = normalizeLeaves(flatten(layer));
    for (const [path, value] of Object.entries(flat)) {
      if (path === "siteUrl") continue;
      let baseline;
      let hasBaseline = false;
      if (name === "default") {
        if (Object.hasOwn(KNOWN_DEFAULTS, path)) {
          baseline = KNOWN_DEFAULTS[path];
          hasBaseline = true;
        }
      } else if (Object.hasOwn(flatDefault, path)) {
        baseline = flatDefault[path];
        hasBaseline = true;
      } else if (Object.hasOwn(MODE_DEFAULTS[name], path)) {
        baseline = MODE_DEFAULTS[name][path];
        hasBaseline = true;
      } else if (Object.hasOwn(KNOWN_DEFAULTS, path)) {
        baseline = KNOWN_DEFAULTS[path];
        hasBaseline = true;
      }
      if (hasBaseline && sameValue(value, baseline)) {
        add(
          "warn",
          `${label}.${path}`,
          `restates the ${name === "default" ? "built-in default" : `effective ${name} value`} (${JSON.stringify(value)}); remove it.`,
        );
        continue;
      }
      meaningful++;
      if (
        name === "default" &&
        path.startsWith("minify.") &&
        typeof value === "boolean"
      ) {
        add(
          "info",
          `default.${path}`,
          value
            ? "turns minification on in the dev server too. --build and --server already minify; remove it unless dev minification is intended."
            : "also turns this minification off for --build and --server. Keep it only if production output should stay unminified; otherwise remove it (dev never minifies).",
        );
      }
    }
  }

  // Lifecycle scripts and watched paths.
  const outDir = resolve(root, flatDefault["directory.out"] ?? "dist");
  for (const name of EXPORTS) {
    const pipeline = layers[name]?.pipeline;
    if (!isPlainObject(pipeline)) continue;
    for (const watched of Array.isArray(pipeline.watchPaths)
      ? pipeline.watchPaths
      : []) {
      if (inside(resolve(root, String(watched)), outDir)) {
        add(
          "error",
          `${name}.pipeline.watchPaths`,
          `"${watched}" is inside the output directory. Never watch generated output; it causes rebuild loops.`,
        );
      }
    }
    const entries = Array.isArray(pipeline.exec) ? pipeline.exec : [];
    entries.forEach((entry, index) => {
      const where = `${name}.pipeline.exec[${index}]`;
      if (!isPlainObject(entry) || typeof entry.script !== "string") {
        add(
          "error",
          where,
          'each exec entry needs a { script: "path/to/script.ts" } object.',
        );
        return;
      }
      // Bascik resolves `script` from the project root; `cwd` only sets the
      // directory the script starts in.
      const script = isAbsolute(entry.script)
        ? entry.script
        : resolve(root, entry.script);
      if (!exists(script)) {
        add(
          "error",
          where,
          `script "${entry.script}" does not exist. Only reference lifecycle scripts that are already in the project (the path is relative to the project root, not to cwd).`,
        );
      }
      // A cwd inside the output directory (a post script in dist/) is made
      // by the build; any other missing cwd is only a warning, since an
      // earlier step may create it. Bascik itself warns the same way.
      const cwd =
        typeof entry.cwd === "string" ? resolve(root, entry.cwd) : undefined;
      if (cwd && !inside(cwd, outDir) && !exists(cwd)) {
        add(
          "warn",
          where,
          `cwd "${entry.cwd}" does not exist. It is the directory the script starts in, relative to the project root; the script fails to start unless an earlier step creates it.`,
        );
      }
      if (
        entry.phase !== undefined &&
        !["pre", "parallel", "post"].includes(entry.phase)
      ) {
        add(
          "error",
          where,
          `phase must be "pre", "parallel", or "post" (got ${JSON.stringify(entry.phase)}).`,
        );
      }
      for (const watched of Array.isArray(entry.watch) ? entry.watch : []) {
        if (inside(resolve(root, String(watched)), outDir)) {
          add(
            "error",
            `${where}.watch`,
            `"${watched}" is inside the output directory. Watch the script's inputs, never its outputs.`,
          );
        }
      }
      if ("outputs" in entry)
        add(
          "error",
          `${where}.outputs`,
          "there is no outputs option. Write generated files to BASCIK_OUT_DIR.",
        );
    });
  }
  const defaultExec = layers.default?.pipeline?.exec;
  const buildExec = layers.build?.pipeline?.exec;
  if (Array.isArray(defaultExec) && Array.isArray(buildExec)) {
    const buildScripts = new Set(buildExec.map((entry) => entry?.script));
    const missing = defaultExec
      .map((entry) => entry?.script)
      .filter((script) => script && !buildScripts.has(script));
    if (missing.length > 0) {
      add(
        "info",
        "build.pipeline.exec",
        `arrays replace instead of merging, so these default exec scripts do not run in --build: ${missing.join(", ")}. Add them to build.pipeline.exec if they should.`,
      );
    }
  }

  if (flatDefault["scoping.attributes.class"] === false) {
    add(
      "info",
      "default.scoping.attributes.class",
      "class scoping is off for the whole project (expected for Tailwind). IDs and names stay scoped.",
    );
  }
  if (flatDefault["scoping.deduplicateCss"] === false) {
    add(
      "info",
      "default.scoping.deduplicateCss",
      "emits one <style> per component instance. Prefer the default and target elements by id.",
    );
  }
  if (
    typeof layers.default?.base === "string" &&
    /^https?:/i.test(layers.default.base)
  ) {
    add(
      "error",
      "default.base",
      'base must be a path prefix such as "/docs/", not a URL.',
    );
  }

  const anyLayer = EXPORTS.some((name) => layers[name]);
  if (
    anyLayer &&
    meaningful === 0 &&
    !findings.some((f) => f.level === "error")
  ) {
    add(
      "warn",
      "file",
      "every value equals a default. Delete bascik.config entirely; Bascik is zero-config.",
    );
  }
  return findings;
}

function findConfig(start) {
  let dir = resolve(start);
  while (true) {
    for (const file of [
      "bascik.config.js",
      "bascik.config.mjs",
      "bascik.config.ts",
    ]) {
      if (existsSync(join(dir, file)))
        return { root: dir, path: join(dir, file) };
    }
    if (existsSync(join(dir, "package.json")))
      return { root: dir, path: undefined };
    const parent = dirname(dir);
    if (parent === dir) return { root: resolve(start), path: undefined };
    dir = parent;
  }
}

async function main() {
  const { values } = parseCliArgs("audit-config", {
    options: {
      json: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      root: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const { root, path } = findConfig(values.root ?? process.cwd());
  if (!path) {
    const message =
      "No bascik.config.js, bascik.config.mjs, or bascik.config.ts: the zero-config defaults apply. Nothing to audit.";
    console.log(
      values.json
        ? JSON.stringify({ root, config: null, findings: [] }, null, 2)
        : message,
    );
    return;
  }

  let module;
  try {
    module = await import(pathToFileURL(path).href);
  } catch (error) {
    const message = `Could not load ${relative(root, path)}: ${error.message}`;
    if (values.json)
      console.log(
        JSON.stringify({ root, config: path, error: message }, null, 2),
      );
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  const findings = auditConfig(module, { root });
  if (values.json) {
    console.log(JSON.stringify({ root, config: path, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`${relative(root, path)}: no issues found.`);
  } else {
    console.log(`${relative(root, path)}:`);
    for (const f of findings)
      console.log(`  ${f.level.padEnd(5)}  ${f.where}  ${f.message}`);
  }
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warn").length;
  process.exitCode = errors > 0 || (values.strict && warnings > 0) ? 1 : 0;
}

// Compare real paths: Node resolves symlinks in the main module's path before it sets import.meta.url, so comparing it
// with argv[1] as typed made the script a silent no-op (exit 0, no output) whenever a folder on the path was a symlink
// or junction, such as the skills CLI's install into .claude/skills.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  }
})();
if (invokedDirectly) await main();

/**
 * `parseArgs`, with a short message naming the flag and the valid ones, and
 * exit code 2, in place of Node's stack trace on a mistyped or missing flag.
 */
function parseCliArgs(name, config) {
  try {
    return parseArgs(config);
  } catch (error) {
    if (!String(error?.code).startsWith("ERR_PARSE_ARGS_")) throw error;
    const valid = Object.entries(config.options ?? {})
      .map(
        ([long, option]) =>
          `${option.short ? `-${option.short}, ` : ""}--${long}`,
      )
      .join(", ");
    const flag = /'([^']+)'/.exec(error.message)?.[1];
    const problem =
      error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && flag
        ? `unknown option "${flag}"`
        : error.message.split(". ")[0].replace(/\.$/, "");
    process.stderr.write(
      `${name}: ${problem}. Valid options: ${valid}. Run with --help.\n`,
    );
    process.exit(2);
  }
}
