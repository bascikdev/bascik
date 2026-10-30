#!/usr/bin/env node
// Measures how long the docs site takes to build, and where that time goes, then writes
// docs/build-timings.json, which the /development-server page reads at build time. Page and component
// counts on that page are counted live; only the timings need a measurement, and this script is how they
// are refreshed.
//
// Run from docs/ on the machine the timings should describe: `yarn docs:measure-build`.
// It runs the production build three times: twice in the production config, once with the script cache
// cleared (cold) and once right after (warm), then once more on one worker thread (described below).
// Everything is read from what the CLI itself prints, so the numbers match what a developer sees in the
// terminal: the "pages transpiled" and "Build complete" lines, each exec script's "(completed) ... in X"
// line, and each page's "transpiled: ... in X" line. The number of build scripts that ran is the number of
// results the cold build left in the script cache.
//
// A third warm build runs on one worker thread, and only its per-page lines are kept. The production config
// compiles pages on every core, and a page's "transpiled:" time then includes waiting for a core it shares
// with the other workers and their script children: on an 8-core machine the same page reads 3-6x slower
// than it does alone. One thread at a time reports what the page itself costs.
// The dev edit is measured in private site copies with the compiler timeline's validated disk-output probe.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
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
const repositoryRoot = join(docsRoot, "..");

function measureDevContentEdit(): BuildTimings["devContentEdit"] {
  const reportDir = mkdtempSync(join(tmpdir(), "bascik-docs-edit-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "pkg", "bench", "compiler-timeline.ts"),
        "--tools",
        "control",
        "--modes",
        "dev",
        "--edits",
        "--seed-cache",
        "--rounds",
        "3",
        "--compiler",
        join(repositoryRoot, "pkg"),
        "--report-dir",
        reportDir,
      ],
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stdout + result.stderr);
      throw new Error(
        `Dev edit measurement failed with exit code ${result.status}`,
      );
    }
    const manifest = JSON.parse(
      readFileSync(join(reportDir, "timeline-manifest.json"), "utf8"),
    ) as {
      complete: boolean;
      failures: unknown[];
      runs: {
        cacheState: string;
        result: {
          edits: { kind: string; diskMs: number; observedPages: unknown[] }[];
        };
      }[];
    };
    if (
      !manifest.complete ||
      manifest.failures.length ||
      manifest.runs.length !== 6
    )
      throw new Error("Dev edit measurement did not complete all six runs");
    const samples = manifest.runs
      .filter((run) => run.cacheState === "warm")
      .map((run) => {
        const edit = run.result.edits.find((entry) => entry.kind === "content");
        if (
          !edit ||
          edit.observedPages.length !== 1 ||
          !Number.isFinite(edit.diskMs)
        )
          throw new Error("Dev edit did not rebuild exactly one page");
        return edit.diskMs;
      })
      .sort((a, b) => a - b);
    if (samples.length !== 3)
      throw new Error("Dev edit measurement needs three warm samples");
    return {
      medianDiskMs: Math.round(samples[1] * 100) / 100,
      samples: samples.length,
      measuredOn: new Date().toISOString().slice(0, 10),
    };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

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

function runBuild(label: string, env: Record<string, string> = {}): BuildRun {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cliPath, "--build"], {
    cwd: docsRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      BASCIK_SITE_URL: "https://bascik.dev",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...env,
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
// The worker pool is sized to at most the child-process budget, so a budget of one is one worker thread.
const oneWorkerRun = runBuild("warm, one worker", {
  BASCIK_MAX_CHILD_PROCESSES: "1",
});

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
const oneWorker = parseBuildLog(
  oneWorkerRun.log,
  oneWorkerRun.wallSeconds,
  execScripts,
);
if (oneWorker.pages !== pages)
  throw new Error(
    `The cold build compiled ${pages} pages and the one-worker build ${oneWorker.pages}`,
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
  oneWorker: {
    pageMedianMs: oneWorker.pageMedianMs,
    slowestPage: oneWorker.slowestPage,
  },
  devContentEdit: measureDevContentEdit(),
};

writeFileSync(outPath, JSON.stringify(timings, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
