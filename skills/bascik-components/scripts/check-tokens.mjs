#!/usr/bin/env node
// Check that components only use CSS custom properties (design tokens) that are declared somewhere.
// Dependency-free; Node.js 22.22+. Run from the project root.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Usage: node check-tokens.mjs [--json] [--unused] [--root <dir>]

Finds var(--token) references in component CSS that no global stylesheet and no rule in that component declares
(usually a typo or a missing token), and component tokens declared on :root or html, which Bascik renames to the
component, so other components cannot read them.

Global sources: every .css file under directory.pages, assets.inlineStyles, and <style> blocks in pages.
Exit code 1 when an undeclared token has no fallback.

Options:
  --unused      Also list global tokens no component or page uses
  --json        Print JSON
  --root <dir>  Project root (default: nearest directory with a bascik config or package.json)
  --help        Show this message`;

const DECLARATION = /(--[A-Za-z0-9_-]+)\s*:/g;
const USE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

const stripComments = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function walk(dir, extensions, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/** CSS text of a file: the whole file for .css, the <style> blocks for .html (line positions preserved). */
export function cssOf(path, source = readFileSync(path, "utf8")) {
  if (path.endsWith(".css")) return stripComments(source);
  let css = source.replace(/[^\n]/g, " ");
  for (const match of source.matchAll(STYLE_BLOCK)) {
    const start = match.index + match[0].indexOf(match[1]);
    css =
      css.slice(0, start) +
      stripComments(match[1]) +
      css.slice(start + match[1].length);
  }
  return css;
}

/** Analyze sources. `globals` and `components` are arrays of { file, css }. Exported for tests. */
export function analyzeTokens({ globals, components }) {
  const declared = new Set();
  for (const { css } of globals)
    for (const m of css.matchAll(DECLARATION)) declared.add(m[1]);

  const findings = [];
  const used = new Set();
  for (const { css } of globals)
    for (const m of css.matchAll(USE)) used.add(m[1]);

  for (const { file, css } of components) {
    const local = new Set([...css.matchAll(DECLARATION)].map((m) => m[1]));
    for (const m of css.matchAll(USE)) {
      used.add(m[1]);
      if (declared.has(m[1]) || local.has(m[1])) continue;
      findings.push({
        level: m[2] ? "info" : "error",
        file,
        line: lineOf(css, m.index),
        token: m[1],
        message: m[2]
          ? `${m[1]} is not declared anywhere; its fallback value always applies`
          : `${m[1]} is not declared in any global stylesheet or in this component (typo or missing token?)`,
      });
    }
    for (const rule of css.matchAll(/(^|[},;\s])(:root|html)\s*\{([^}]*)\}/g)) {
      for (const m of rule[3].matchAll(DECLARATION)) {
        findings.push({
          level: "warn",
          file,
          line: lineOf(css, rule.index + rule[0].indexOf(m[0])),
          token: m[1],
          message: `${m[1]} is declared on ${rule[2]} inside a component, so Bascik renames it to this component. Move shared tokens to the global stylesheet.`,
        });
      }
    }
  }
  const unused = [...declared].filter((token) => !used.has(token)).sort();
  return { declared: [...declared].sort(), findings, unused };
}

function findRoot(start) {
  let dir = resolve(start);
  while (true) {
    if (
      ["bascik.config.js", "bascik.config.ts", "package.json"].some((f) =>
        existsSync(join(dir, f)),
      )
    )
      return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

async function loadConfig(root) {
  for (const file of ["bascik.config.js", "bascik.config.ts"]) {
    const path = join(root, file);
    if (existsSync(path))
      return (await import(pathToFileURL(path).href)).default ?? {};
  }
  return {};
}

async function main() {
  const { values } = parseCliArgs("check-tokens", {
    options: {
      json: { type: "boolean", default: false },
      unused: { type: "boolean", default: false },
      root: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const root = findRoot(values.root ?? process.cwd());
  const config = await loadConfig(root);
  const pagesDir = resolve(root, config.directory?.pages ?? "src/pages");
  const componentDirs = [config.directory?.components ?? "src/components"]
    .flat()
    .map((dir) => resolve(root, dir));
  const inline = Array.isArray(config.assets?.inlineStyles)
    ? config.assets.inlineStyles.map((p) => resolve(root, p))
    : [];

  const read = (file) => ({
    file: relative(root, file).replace(/\\/g, "/"),
    css: cssOf(file),
  });
  const globals = [
    ...new Set([...walk(pagesDir, [".css", ".html"]), ...inline]),
  ]
    .filter((file) => existsSync(file) && statSync(file).isFile())
    .map(read);
  const components = componentDirs
    .flatMap((dir) => walk(dir, [".css", ".html"]))
    .map(read);

  const result = analyzeTokens({ globals, components });
  if (values.json)
    return console.log(JSON.stringify({ root, ...result }, null, 2));

  console.log(
    `${result.declared.length} global tokens declared; ${components.length} component files checked.`,
  );
  for (const f of result.findings)
    console.log(`  ${f.level.padEnd(5)}  ${f.file}:${f.line}  ${f.message}`);
  if (values.unused && result.unused.length)
    console.log(`\nUnused global tokens:\n  ${result.unused.join("\n  ")}`);
  if (result.findings.length === 0) console.log("No token problems found.");
  process.exitCode = result.findings.some((f) => f.level === "error") ? 1 : 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
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
