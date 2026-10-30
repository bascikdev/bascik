#!/usr/bin/env node
// Build docs/migration/breakpoints.json from a legacy site's CSS, Sass and scripts: every width where the layout
// switches, expanded into B - 1, B, B + 1 cases plus one width inside every interval and the narrowest and widest
// widths. Dependency-free; Node.js 22.22+. Run from the project root; it only reads the files you pass.
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { discoverThresholds, expandMatrix } from "./lib/matrix.mjs";
import { fail, isMain, positiveNumber } from "./lib/cli.mjs";

const HELP = `Usage: node breakpoint-matrix.mjs --css <file or glob>... [--add <px,...>] [--min 320] [--max 1920]
                                     [--height <px>] [--out <file>]

Finds width thresholds in @media queries, quoted media query strings (matchMedia, image sizes, useMediaQuery,
CSS-in-JS), react-responsive props, Sass and Less breakpoint variables, theme breakpoint tokens and innerWidth checks,
then prints the breakpoint matrix as JSON: { thresholds, sources, cases: [{ width, height }] }.

A component library keeps its grid breakpoints in its own package, which your globs do not read. Pass production's
compiled stylesheets as well (saved into a folder such as artifacts/prod-css/), or list the library's documented
breakpoints with --add. Review the result: add hover, orientation and reduced-motion cases by hand.

Options:
  --css <path>     A file or a quoted glob such as '../legacy/src/**/*.scss' (repeatable; extra arguments count too)
  --add <list>     Extra thresholds in CSS pixels, comma-separated, such as 576,768,992
  --min <px>       Narrowest supported width (default 320)
  --max <px>       Widest supported width (default 1920)
  --height <px>    One height for every case (default: 812 below 768, 1024 below 1024, else 900)
  --out <file>     Write the JSON to a file instead of stdout
  --help           Show this message

Example, run from the Bascik project with the legacy checkout next to it:
  node breakpoint-matrix.mjs --css '../legacy/src/**/*.{scss,css,less}' '../legacy/src/**/*.{ts,tsx,js,jsx}' \\
    'artifacts/prod-css/*.css' --out docs/migration/breakpoints.json`;

export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      css: { type: "string", multiple: true },
      add: { type: "string" },
      min: { type: "string" },
      max: { type: "string" },
      height: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  const css = [...(values.css ?? []), ...positionals];
  if (css.length === 0)
    throw new Error(
      "--css: pass at least one CSS, Sass or script file or glob",
    );
  let add = [];
  if (values.add !== undefined) {
    add = values.add.split(",").map((s) => Number(s.trim()));
    if (add.some((n) => !Number.isFinite(n) || n <= 0))
      throw new Error(
        `--add must be positive numbers such as 576,768,992 (got "${values.add}")`,
      );
  }
  return {
    css,
    add,
    min: values.min === undefined ? 320 : positiveNumber("--min", values.min),
    max: values.max === undefined ? 1920 : positiveNumber("--max", values.max),
    ...(values.height !== undefined && {
      height: positiveNumber("--height", values.height),
    }),
    ...(values.out !== undefined && { out: values.out }),
  };
}

/**
 * True for a path segment the glob should not enter: node_modules and dot folders (.git, .next, .cache). Node calls
 * this with bare names and with paths such as "../" or "../legacy/src", so only the last segment is checked, and
 * "." and ".." (a glob that starts outside the working directory) are allowed.
 */
export function skipSegment(name) {
  const last = String(name)
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  if (last === "." || last === ".." || last === "") return false;
  return last === "node_modules" || last.startsWith(".");
}

/** Expands globs; plain paths pass through so a missing file is reported by name. */
export function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    if (/[*?[{]/.test(input)) {
      files.push(...globSync(input, { exclude: skipSegment }).sort());
    } else files.push(input);
  }
  return [...new Set(files)];
}

/** The matrix for `files`: thresholds, which file each came from, and the expanded cases. */
export function buildMatrix(
  files,
  { min = 320, max = 1920, height, add = [] } = {},
) {
  const sources = {};
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.code ?? error.message}`);
    }
    for (const t of discoverThresholds(text)) (sources[t] ??= []).push(file);
  }
  for (const t of add) (sources[Math.floor(t)] ??= []).push("--add");
  const thresholds = Object.keys(sources)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    thresholds,
    sources,
    cases: expandMatrix(thresholds, { min, max, height }),
  };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const files = expandInputs(args.css);
  if (files.length === 0)
    throw new Error(`no files match ${args.css.join(" ")}`);
  const matrix = buildMatrix(files, args);
  const json = JSON.stringify(matrix, null, 2) + "\n";
  if (args.out) {
    writeFileSync(args.out, json);
    console.error(
      `breakpoint-matrix: ${matrix.thresholds.length} thresholds, ${matrix.cases.length} cases -> ${args.out}`,
    );
  } else process.stdout.write(json);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(`breakpoint-matrix: ${error.message}\n\n${HELP}`);
  }
}
