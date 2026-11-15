/**
 * Differential check of the built-in JavaScript minifier against its own input.
 *
 * For every JavaScript file under the given paths, the source and `minifyJs(source)` are
 * each parsed and printed by esbuild in one canonical form. Equal text means the minifier
 * kept the program; a difference, or minified text that does not parse, is a finding. The
 * reference is the source itself, not an earlier minifier, so this finds bugs that have
 * always been there.
 *
 * Usage (from the repository root):
 *   yarn workspace @bascik/bascik profile:minify <file-or-directory>... [options]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";

type Minify = (code: string) => string;
export type Verdict =
  "same" | "unparsable-source" | "syntax" | "differs" | "threw";

/**
 * The program as esbuild prints it: comments, whitespace, optional semicolons and empty
 * statements gone. Two passes, because a legal comment (`/*! ... *\/`, `@license`) is a
 * statement to esbuild's syntax pass and changes what it merges: the first pass prints the
 * code without comments, the second drops empty statements. `ignoreAnnotations` keeps a
 * dropped `@__PURE__` comment from counting as a difference. Returns undefined when the code
 * does not parse.
 */
export const canonicalProgram = (code: string): string | undefined => {
  const options = {
    loader: "js",
    legalComments: "none",
    minifyWhitespace: true,
    ignoreAnnotations: true,
    charset: "utf8",
    logLevel: "silent",
  } as const;
  try {
    const withoutComments = transformSync(code, options).code;
    return transformSync(withoutComments, { ...options, minifySyntax: true })
      .code;
  } catch {
    return undefined;
  }
};

export const compareWithSource = (source: string, minify: Minify): Verdict => {
  const expected = canonicalProgram(source);
  if (expected === undefined) return "unparsable-source";
  let minified: string;
  try {
    minified = minify(source);
  } catch {
    return "threw";
  }
  const actual = canonicalProgram(minified);
  if (actual === undefined) return "syntax";
  return actual === expected ? "same" : "differs";
};

/** Delta debugging over `parts`: drop chunks while `fails` still holds. */
const dropChunks = (
  parts: string[],
  separator: string,
  fails: (code: string) => boolean,
): string[] => {
  let chunks = 2;
  while (parts.length >= 2) {
    const size = Math.ceil(parts.length / chunks);
    let dropped = false;
    for (let start = 0; start < parts.length; start += size) {
      const candidate = [
        ...parts.slice(0, start),
        ...parts.slice(start + size),
      ];
      if (candidate.length > 0 && fails(candidate.join(separator))) {
        parts = candidate;
        chunks = Math.max(chunks - 1, 2);
        dropped = true;
        break;
      }
    }
    if (!dropped) {
      if (chunks >= parts.length) break;
      chunks = Math.min(chunks * 2, parts.length);
    }
  }
  return parts;
};

const TOKEN_REDUCTION_LIMIT = 4000;

/**
 * Shrink a failing source to a small one with the same verdict: whole lines first, then
 * pieces of lines once the text is short enough. The result still parses, because the
 * verdict requires it.
 */
export const shrinkFailure = (
  source: string,
  verdict: Verdict,
  minify: Minify,
): string => {
  const fails = (code: string): boolean =>
    compareWithSource(code, minify) === verdict;
  let current = source;
  for (;;) {
    let next = dropChunks(current.split("\n"), "\n", fails).join("\n");
    if (next.length < TOKEN_REDUCTION_LIMIT) {
      next = dropChunks(next.split(/(?<=[\s;{}(),])/), "", fails).join("");
    }
    if (next.length >= current.length) return current;
    current = next;
  }
};

// Deep enough for nested `node_modules`, shallow enough to end on a symlink cycle.
const MAX_DEPTH = 24;

const collectFiles = (
  path: string,
  maxBytes: number,
  files: string[],
  depth = 0,
): void => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      collectFiles(join(path, name), maxBytes, files, depth + 1);
    }
  } else if (
    /\.(?:c|m)?js$/.test(path) &&
    stats.size > 0 &&
    stats.size <= maxBytes
  ) {
    files.push(path);
  }
};

const pathHash = (path: string): number => {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  }
  return hash;
};

/** An option that counts something: a whole number of at least `minimum`. */
export const countOption = (
  value: string,
  name: string,
  minimum: 0 | 1,
): number => {
  const parsed = Number(value);
  if (
    value.trim() === "" ||
    !Number.isSafeInteger(parsed) ||
    parsed < minimum
  ) {
    throw new Error(
      `--${name} must be ${minimum === 0 ? "zero or a positive integer" : "a positive integer"}, got "${value}"`,
    );
  }
  return parsed;
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      minifier: { type: "string" },
      sample: { type: "string" },
      "max-bytes": { type: "string", default: "300000" },
      shrink: { type: "string", default: "20" },
      json: { type: "boolean", default: false },
    },
  });
  if (positionals.length === 0) {
    throw new Error("pass at least one file or directory to check");
  }
  const minifierPath = values.minifier
    ? resolve(values.minifier)
    : resolve(import.meta.dirname, "../src/lib/js-minifier.ts");
  const { minifyJs } = (await import(pathToFileURL(minifierPath).href)) as {
    minifyJs: Minify;
  };
  const maxBytes = countOption(values["max-bytes"], "max-bytes", 1);
  const shrinkLimit = countOption(values.shrink, "shrink", 0);

  let files: string[] = [];
  for (const path of positionals) {
    collectFiles(resolve(path), maxBytes, files);
  }
  const found = files.length;
  if (found === 0) {
    throw new Error(
      `no .js, .mjs or .cjs file of at most ${maxBytes} bytes under the given paths`,
    );
  }
  if (values.sample !== undefined) {
    // By path hash, so two runs check the same files even when others come and go.
    const step = Math.ceil(found / countOption(values.sample, "sample", 1));
    if (step > 1) files = files.filter((file) => pathHash(file) % step === 0);
  }

  const counts: Record<Verdict, number> = {
    same: 0,
    "unparsable-source": 0,
    syntax: 0,
    differs: 0,
    threw: 0,
  };
  const failures: {
    file: string;
    verdict: Verdict;
    source?: string;
    minified?: string;
  }[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const verdict = compareWithSource(source, minifyJs);
    counts[verdict]++;
    if (verdict === "same" || verdict === "unparsable-source") continue;
    const failure: (typeof failures)[number] = { file, verdict };
    if (failures.length < shrinkLimit && verdict !== "threw") {
      failure.source = shrinkFailure(source, verdict, minifyJs);
      failure.minified = minifyJs(failure.source);
    }
    failures.push(failure);
  }

  if (values.json) {
    console.log(
      JSON.stringify(
        { found, checked: files.length, counts, failures },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `${files.length} of ${found} files checked: ${counts.same} same, ` +
        `${counts.syntax} no longer parse, ${counts.differs} differ, ` +
        `${counts.threw} threw, ${counts["unparsable-source"]} skipped (source does not parse)`,
    );
    for (const failure of failures) {
      console.log(`\n${failure.verdict}: ${failure.file}`);
      if (failure.source !== undefined) {
        console.log(`  source:   ${JSON.stringify(failure.source)}`);
        console.log(`  minified: ${JSON.stringify(failure.minified)}`);
      }
    }
  }
  if (failures.length > 0) process.exitCode = 1;
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
