/**
 * Linear-time checks for the language server's tests, after
 * pkg/src/lib/linear-time.test-helper.ts (lsp builds from lsp/src only).
 * The `.test.util` name keeps it out of the published package
 * (`!dist/**\/*.test.*`) and out of Vitest's test files.
 *
 * It measures this thread's CPU time. Each sample spans sixteen steps of
 * the clock, since Windows counts CPU time in ticks of about 15.6 ms. It
 * keeps the fastest of interleaved samples, and takes more pairs while the
 * growth is in the band load reaches on linear work. The run cap rises with
 * the sample target: a run of microseconds capped at 64 runs reached only
 * one Windows tick and read a growth of 9.2.
 *
 * Tests that call `growthOf` go in `<name>.linear-time.test.ts`: the
 * `linear-time` Vitest project runs them (`yarn workspace
 * @bascik/language-server linear-time`), and the `unit` project skips them.
 */
import { TestRunner } from "vitest";

/**
 * A timeout for a test that calls `growthOf`: on Windows a sample spans
 * sixteen clock ticks, so a check takes seconds there and milliseconds on
 * macOS and Linux.
 */
export const LINEAR_TIME_TIMEOUT_MS = 60_000;

/**
 * Throws in a test whose timeout is under `LINEAR_TIME_TIMEOUT_MS`, on every
 * platform, so a missing timeout fails here rather than only on Windows CI.
 * Outside a test (a hook) it does nothing.
 */
const requireLinearTimeTimeout = (): void => {
  const timeout = TestRunner.getCurrentTest()?.timeout;
  if (timeout !== undefined && timeout < LINEAR_TIME_TIMEOUT_MS)
    throw new Error(
      `measures CPU time, which takes seconds on Windows: give this test LINEAR_TIME_TIMEOUT_MS (it has ${timeout} ms)`,
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

/**
 * CPU-time growth from `small()` to `large()`, where the large input is
 * four times the small one. Linear work reads about 4, quadratic about 16.
 */
export const growthOf = (
  small: () => unknown,
  large: () => unknown,
): number => {
  requireLinearTimeTimeout();
  const stepMs = clockStepMs();
  const targetMs = Math.max(MIN_SAMPLE_MS, TICKS_PER_SAMPLE * stepMs);
  const maxRuns = Math.ceil((MAX_RUNS * targetMs) / MIN_SAMPLE_MS);
  const floorMs = Math.max(NOISE_FLOOR_MS, stepMs);
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
      smallMs <= 0
        ? runs * 2
        : Math.max(runs * 2, Math.ceil((runs * targetMs * 1.5) / smallMs)),
    );
    smallMs = sample(small, runs);
  }
  let largeMs = Infinity;
  const growth = () => largeMs / Math.max(smallMs, floorMs);
  for (let i = 0; i < 9; i++) {
    if (i >= 3 && !(growth() > 5 && growth() < 12)) break;
    if (i > 0) smallMs = Math.min(smallMs, sample(small, runs));
    largeMs = Math.min(largeMs, sample(large, runs));
  }
  return growth();
};
