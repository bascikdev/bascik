/**
 * build-stats.ts
 *
 * The numbers the /development-server page quotes about this website's own build, so they
 * never go stale in the prose.
 *
 * - Page and component counts are counted live from `src/pages` and the component folders on every build.
 *   They cannot drift.
 * - The timings cannot be computed during the build that prints them, so they come from
 *   `docs/build-timings.json`, written by `yarn docs:measure-build` (scripts/measure-build.ts). The file
 *   records the machine and date, and the page shows both. Re-run the script when the site or the compiler
 *   changes enough to move the numbers; `build-stats.test.ts` fails once the recorded page count falls too
 *   far behind the live one.
 *
 * The same module parses the CLI's own output into those timings, so the measurement script and its tests
 * share one definition of what each line means.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export type ExecPhase = "pre" | "parallel" | "post";

/** One entry of `pipeline.exec`, as far as the timings care. */
export interface ExecEntry {
  script: string;
  phase?: ExecPhase;
}

export interface ExecTiming {
  script: string;
  phase: ExecPhase;
  seconds: number;
}

/** The per-page figures of one build: the median `transpiled:` line and the slowest. */
export interface PageTimings {
  /** The median of the per-page `transpiled:` lines, in milliseconds. */
  pageMedianMs: number;
  slowestPage: { path: string; ms: number };
}

/** One production build, in seconds unless the name says otherwise. */
export interface BuildRunTimings extends PageTimings {
  /** Wall time of the whole command, including Node starting up and loading the config. */
  wallSeconds: number;
  /** The "Build complete in" figure the CLI prints. */
  totalSeconds: number;
  /** Wall time before the build proper began: `wallSeconds - totalSeconds`. */
  startupSeconds: number;
  /** `pre` exec scripts, which run one after another before any page compiles. */
  preScriptsSeconds: number;
  /** The "pages transpiled in" figure: components, scoping, and every build script in every page. */
  pagesSeconds: number;
  /** `post` exec scripts, which run one after another once every page is written. */
  postScriptsSeconds: number;
  /** Everything else inside the build: asset copying, the sitemap, writing the manifest. */
  otherSeconds: number;
  /** Every exec script with how long it took. `parallel` ones overlap page compilation. */
  execScripts: ExecTiming[];
}

export interface BuildTimings {
  measuredOn: string;
  bascikVersion: string;
  nodeVersion: string;
  machine: string;
  /** Pages in the measured build. */
  pages: number;
  /** Distinct build scripts the cold build ran, counted from the script cache. */
  buildScripts: number;
  /** No script cache. */
  cold: BuildRunTimings;
  /** Right after a cold build, with every cacheable build script result on disk. */
  warm: BuildRunTimings;
  /**
   * The per-page figures from a warm build on one worker thread. With `pipeline.workers` on, a page's
   * `transpiled:` time includes waiting for a core it shares with the other workers and their script
   * children, which inflates it several times over; one thread at a time reports what the page itself
   * costs. Absent from timings measured before this run was added, and the panel then says so.
   */
  oneWorker?: PageTimings;
  /** Median milliseconds from a warm-cache dev-server Markdown edit to updated disk output, not browser reload. */
  devContentEdit?: {
    medianDiskMs: number;
    samples: number;
    measuredOn: string;
  };
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Parses what `formatDuration` prints (`84ms`, `0.4ms`, `<0.01ms`, `1.25s`) into seconds. */
export function parseDuration(text: string): number {
  const match = /^(<)?([\d.]+)(ms|s)$/.exec(text.trim());
  if (!match) throw new Error(`Cannot read the duration "${text}"`);
  const amount = Number(match[2]);
  return match[3] === "s" ? amount : amount / 1000;
}

/** Reads the CLI's output from one `bascik --build` into timings. Throws when a line it needs is missing. */
export function parseBuildLog(
  rawLog: string,
  wallSeconds: number,
  execEntries: ExecEntry[],
): BuildRunTimings & { pages: number } {
  const log = stripVTControlCharacters(rawLog);

  // Both lines may end in a parenthetical about build scripts ("(969 build scripts ran, 0 from cache)",
  // "(+5.1s in 52 build scripts)"); the duration before it is the figure wanted here.
  const pagesLine = /^✓ (\d+) pages? transpiled in (\S+)(?: \(.*\))?$/m.exec(
    log,
  );
  if (!pagesLine)
    throw new Error('The build log has no "pages transpiled" line');
  const totalLine = /^✓ Build complete in (\S+)$/m.exec(log);
  if (!totalLine) throw new Error('The build log has no "Build complete" line');
  const pages = Number(pagesLine[1]);
  const pagesSeconds = parseDuration(pagesLine[2]);
  const totalSeconds = parseDuration(totalLine[1]);

  const phases = new Map(
    execEntries.map(
      (entry) => [entry.script, entry.phase ?? "parallel"] as const,
    ),
  );
  const execScripts: ExecTiming[] = [
    ...log.matchAll(/^\(completed\) exec: (\S+) in (\S+)$/gm),
  ].map((match) => ({
    script: match[1],
    phase: phases.get(match[1]) ?? "parallel",
    seconds: round(parseDuration(match[2])),
  }));
  const phaseSeconds = (phase: ExecPhase) =>
    execScripts
      .filter((script) => script.phase === phase)
      .reduce((sum, script) => sum + script.seconds, 0);
  const preScriptsSeconds = phaseSeconds("pre");
  const postScriptsSeconds = phaseSeconds("post");

  const perPage = [
    ...log.matchAll(/^transpiled: (\S+) in (\S+)(?: \(.*\))?$/gm),
  ]
    .map((match) => ({
      path: match[1],
      ms: Math.round(parseDuration(match[2]) * 1000),
    }))
    .sort((a, b) => a.ms - b.ms);
  const slowestPage = perPage.at(-1) ?? { path: "", ms: 0 };
  const pageMedianMs =
    perPage.length > 0 ? perPage[Math.floor(perPage.length / 2)].ms : 0;

  return {
    pages,
    wallSeconds: round(wallSeconds),
    totalSeconds: round(totalSeconds),
    startupSeconds: round(Math.max(0, wallSeconds - totalSeconds)),
    preScriptsSeconds: round(preScriptsSeconds),
    pagesSeconds: round(pagesSeconds),
    postScriptsSeconds: round(postScriptsSeconds),
    otherSeconds: round(
      Math.max(
        0,
        totalSeconds - preScriptsSeconds - pagesSeconds - postScriptsSeconds,
      ),
    ),
    execScripts,
    pageMedianMs,
    slowestPage,
  };
}

const listFiles = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

/** Counts the page sources. A bracketed route file is one source however many pages it expands to. */
export async function countSourcePages(
  pagesDir: string = join(process.cwd(), "src/pages"),
): Promise<number> {
  return (await listFiles(pagesDir)).filter((name) => name.endsWith(".html"))
    .length;
}

/** Counts component files (`.html`) across the component folders. */
export async function countComponents(
  componentDirs: string[] = [
    join(process.cwd(), "src/components"),
    join(process.cwd(), "../examples/components"),
  ],
): Promise<number> {
  const counts = await Promise.all(
    componentDirs.map(
      async (dir) =>
        (await listFiles(dir)).filter((name) => name.endsWith(".html")).length,
    ),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

/** Reads the measured timings, with an error that says how to produce them when the file is missing. */
export async function readBuildTimings(
  path: string = join(process.cwd(), "build-timings.json"),
): Promise<BuildTimings> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BuildTimings;
  } catch (error) {
    throw new Error(
      `Cannot read ${path} (${(error as Error).message}). Run \`yarn docs:measure-build\` to measure the docs build and write it.`,
    );
  }
}

/** `4` becomes "4", `22.5` stays "22.5": whole seconds read better without a trailing ".0". */
export function formatSeconds(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/** Milliseconds of page compilation per page, rounded to a whole number. */
export function millisecondsPerPage(
  pagesSeconds: number,
  pages: number,
): number {
  return pages > 0 ? Math.round((pagesSeconds * 1000) / pages) : 0;
}

export interface BuildStatPaths {
  pagesDir?: string;
  componentDirs?: string[];
  timingsPath?: string;
}
