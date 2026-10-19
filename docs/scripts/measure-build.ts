#!/usr/bin/env node
// Measures how long the docs site takes to build, and where that time goes, then writes
// docs/build-timings.json, which the /development-server page reads at build time. Page and component
// counts on that page are counted live; only the timings need a measurement, and this script is how they
// are refreshed.
//
// Run from docs/ on the machine the timings should describe: `yarn docs:measure-build`.
// It runs the production build twice: once with the script cache cleared (cold) and once right after (warm).
// Everything is read from what the CLI itself prints, so the numbers match what a developer sees in the
// terminal: the "pages transpiled" and "Build complete" lines, each exec script's "(completed) ... in X"
// line, and each page's "transpiled: ... in X" line. The number of build scripts that ran is the number of
// results the cold build left in the script cache.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseBuildLog,
  type BuildRunTimings,
  type BuildTimings,
  type ExecEntry,
} from "../src/lib/build-stats.ts";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(docsRoot, "..", "pkg", "bin", "bascik.js");
const cachePath = join(docsRoot, "node_modules", ".cache", "bascik");
const scriptCachePath = join(cachePath, "script-cache");
const outPath = join(docsRoot, "build-timings.json");

/** The exec scripts a production build runs, with their phases, read from the docs config. */
async function readBuildExecScripts(): Promise<ExecEntry[]> {
  const config = (await import(
    pathToFileURL(join(docsRoot, "bascik.config.ts")).href
  )) as {
    build?: { pipeline?: { exec?: ExecEntry[] } };
  };
  return config.build?.pipeline?.exec ?? [];
}

interface BuildRun {
  log: string;
  wallSeconds: number;
}

function runBuild(label: string): BuildRun {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cliPath, "--build"], {
    cwd: docsRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      BASCIK_SITE_URL: "https://bascik.dev",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    maxBuffer: 256 * 1024 * 1024,
  });
  const wallSeconds = (performance.now() - started) / 1000;
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`${label} build failed with exit code ${result.status}`);
  }
  console.log(`${label}: ${wallSeconds.toFixed(2)}s`);
  return { log: result.stdout, wallSeconds };
}

const execScripts = await readBuildExecScripts();

rmSync(cachePath, { recursive: true, force: true });
const coldRun = runBuild("cold");
const buildScripts = readdirSync(scriptCachePath).filter((file) =>
  file.endsWith(".json"),
).length;
const warmRun = runBuild("warm");

const { pages, ...cold }: BuildRunTimings & { pages: number } = parseBuildLog(
  coldRun.log,
  coldRun.wallSeconds,
  execScripts,
);
const { pages: warmPages, ...warm }: BuildRunTimings & { pages: number } =
  parseBuildLog(warmRun.log, warmRun.wallSeconds, execScripts);
if (warmPages !== pages)
  throw new Error(
    `The cold build compiled ${pages} pages and the warm build ${warmPages}`,
  );

const version = (
  JSON.parse(
    readFileSync(join(docsRoot, "..", "pkg", "package.json"), "utf8"),
  ) as { version: string }
).version;

const timings: BuildTimings = {
  measuredOn: new Date().toISOString().slice(0, 10),
  bascikVersion: version,
  nodeVersion: process.versions.node,
  machine: `${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores`,
  pages,
  buildScripts,
  cold,
  warm,
};

writeFileSync(outPath, JSON.stringify(timings, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
