/**
 * Linear-time checks for the skills' tests, after
 * lsp/src/linear-time.test.util.ts (itself after
 * pkg/src/lib/linear-time.test-helper.ts). The `.test-helper` name keeps it
 * out of Vitest's test files (`tests/**\/*.test.ts`).
 *
 * It measures this thread's CPU time. Each sample spans sixteen steps of
 * the clock, since Windows counts CPU time in ticks of about 15.6 ms. It
 * keeps the fastest of interleaved samples, and takes more pairs while the
 * growth is in the band load reaches on linear work. The run cap rises with
 * the sample target, so a run of microseconds still spans many ticks.
 *
 * Tests that call `growthOf` go in `<name>.linear-time.test.ts` with
 * `LINEAR_TIME_TIMEOUT_MS` as their timeout: the `linear-time` Vitest project
 * runs them (`yarn skills:linear-time`), and the `unit` project, which
 * coverage runs, skips them. A wall-clock ratio in a unit file read 3.79
 * against a bound of 2.5 under coverage instrumentation (R3-19).
 */
import { TestRunner } from "vitest";

/**
 * A timeout for a test that calls `growthOf`: on Windows a sample spans
 * sixteen clock ticks, so a check takes seconds there and milliseconds on
 * macOS and Linux.
 */
export const LINEAR_TIME_TIMEOUT_MS = 60_000;

/**
 * The bound on `growthOf` for linear work. Linear work reads about 4 when
 * the input quadruples, quadratic work about 16; 8 is the lsp checks' bound.
 */
export const MAX_GROWTH = 8;

/**
 * Throws in a test of the `unit` Vitest project (vite.config.js), which
 * coverage instruments and every pull request runs on Windows, and in a
 * test whose timeout is under `LINEAR_TIME_TIMEOUT_MS`, on every platform, so
 * a misplaced check or a missing timeout fails here rather than only under
 * coverage or on Windows CI. Outside a test (a hook) it does nothing.
 */
const requireLinearTimeTest = (): void => {
  const test = TestRunner.getCurrentTest();
  if (test === undefined) return;
  if (test.file.projectName === "unit")
    throw new Error(
      "measures CPU time, which takes seconds on Windows and reads high under coverage: move this test into a *.linear-time.test.ts file (the linear-time Vitest project)",
    );
  if (test.timeout < LINEAR_TIME_TIMEOUT_MS)
    throw new Error(
      `measures CPU time, which takes seconds on Windows: give this test LINEAR_TIME_TIMEOUT_MS (it has ${test.timeout} ms)`,
    );
};

const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage =
  process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);
const msOf = ({ user, system }: NodeJS.CpuUsage) => (user + system) / 1000;
const cpuMs = (run: () => unknown): number => {
  const start = threadCpuUsage();
  run();
  return msOf(threadCpuUsage(start));
};

const MIN_SAMPLE_MS = 25;
const TICKS_PER_SAMPLE = 16;
const MAX_RUNS = 2_000;
const NOISE_FLOOR_MS = 5;

/** The smallest step this thread's CPU clock moves by, or 0. */
const clockStepMs = (): number => {
  const deadline = performance.now() + 250;
  let smallest = Infinity;
  let last = msOf(threadCpuUsage());
  for (let steps = 0; steps < 5 && performance.now() < deadline;) {
    const now = msOf(threadCpuUsage());
    if (now === last) continue;
    smallest = Math.min(smallest, now - last);
    last = now;
    steps++;
  }
  return Number.isFinite(smallest) ? smallest : 0;
};

/** A growth measurement: the fastest sample at each size, in ms. */
export interface Growth {
  growth: number;
  smallMs: number;
  largeMs: number;
  runs: number;
}

/**
 * CPU-time growth from `small()` to `large()`, where the large input is
 * four times the small one. Linear work reads about 4, quadratic about 16.
 * A growth between 5 and `maxGrowth` plus a margin is sampled again, up to
 * nine pairs, since load raises a single pair.
 */
export const measureGrowth = (
  small: () => unknown,
  large: () => unknown,
  { maxGrowth = MAX_GROWTH }: { maxGrowth?: number } = {},
): Growth => {
  requireLinearTimeTest();
  const stepMs = clockStepMs();
  const targetMs = Math.max(MIN_SAMPLE_MS, TICKS_PER_SAMPLE * stepMs);
  const maxRuns = Math.ceil((MAX_RUNS * targetMs) / MIN_SAMPLE_MS);
  const floorMs = Math.max(NOISE_FLOOR_MS, stepMs);
  const resampleBelow = Math.max(12, maxGrowth + 2);
  small();
  large();
  const sample = (run: () => unknown, count: number) =>
    cpuMs(() => {
      for (let i = 0; i < count; i++) run();
    });
  let runs = 1;
  let smallMs = sample(small, runs);
  while (smallMs < targetMs && runs < maxRuns) {
    runs = Math.min(
      maxRuns,
      // A step that read nothing says nothing about how short the run is:
      // double rather than jump to the cap.
      smallMs <= 0
        ? runs * 2
        : Math.max(runs * 2, Math.ceil((runs * targetMs * 1.5) / smallMs)),
    );
    smallMs = sample(small, runs);
  }
  let largeMs = Infinity;
  const growth = () => largeMs / Math.max(smallMs, floorMs);
  for (let i = 0; i < 9; i++) {
    if (i >= 3 && !(growth() > 5 && growth() < resampleBelow)) break;
    if (i > 0) smallMs = Math.min(smallMs, sample(small, runs));
    largeMs = Math.min(largeMs, sample(large, runs));
  }
  return { growth: growth(), smallMs, largeMs, runs };
};

/**
 * CPU-time growth from `small()` to `large()`, where the large input is
 * four times the small one. Linear work reads about 4, quadratic about 16.
 */
export const growthOf = (small: () => unknown, large: () => unknown): number =>
  measureGrowth(small, large).growth;
