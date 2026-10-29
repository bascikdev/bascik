/**
 * Linear-time checks for tests that guard against super-linear work on
 * hostile input. Test-only; never imported by production code.
 *
 * A fixed wall-clock bound flakes on shared CI runners under coverage (a
 * 250 ms bound saw 251, 257 and 300 ms; a 1000 ms one saw 2187 ms), and
 * locally under CPU load, on work that takes a fraction of the bound when the
 * machine is idle. Growth does not depend on the machine's speed: quadrupling
 * the input roughly quadruples linear work, while quadratic work grows about
 * 16 times and cubic work about 64. So each check times a quarter-size and a
 * full-size input, in CPU time, several times interleaved, keeps the fastest
 * of each, and requires the ratio to stay under `MAX_GROWTH`. A run too fast
 * to time on its own is repeated within each sample (`MIN_SAMPLE_MS`). A
 * generous ceiling on the full-size time still fails catastrophic
 * regressions, and catches amplification that a cap keeps linear in the input
 * (a pass repeated once per instance, up to an instance limit, is linear in
 * the input once the limit is reached, yet takes seconds).
 */
import { appendFileSync } from "node:fs";
import { expect } from "vitest";

/** Linear work grows about 4 times when the input quadruples. */
export const MAX_GROWTH = 8;
/**
 * Each quarter-size sample repeats the run until it takes at least this long,
 * and each full-size sample repeats it a quarter as many times. Timed once, a
 * 200k-character masking check took about 1 ms at a quarter size: under the
 * noise floor, so its growth was its full-size time over 5 ms, which a
 * quadratic scan passes (16 ms at full size, a growth of 3.2). Repeating a run
 * leaves its growth as it was, and 10 ms is twice the floor, so a millisecond
 * of timer and GC jitter moves the growth by about a tenth.
 */
export const MIN_SAMPLE_MS = 10;
/**
 * The most runs per sample. A run this cheap is microseconds even at full
 * size, and the noise floor below decides its growth.
 */
export const MAX_RUNS = 2_000;
/**
 * Below this, a sample is timer and scheduling noise, not work: ratios are
 * taken against at least this many milliseconds. Only a sample of `MAX_RUNS`
 * runs of a few microseconds each can fall under it.
 */
export const NOISE_FLOOR_MS = 5;
/**
 * Catastrophic regressions fail outright: the quadratic scans these checks
 * guard against took seconds at a quarter of the sizes the tests use. It
 * bounds one full-size run.
 */
export const CEILING_MS = 2_000;
export const SAMPLES = 3;
/**
 * A timeout for a test that measures growth: it calibrates on the
 * quarter-size input, then runs `SAMPLES` samples at each size, which on a
 * slow shared runner under coverage takes longer than Vitest's default 5 s.
 */
export const LINEAR_TIME_TIMEOUT_MS = 60_000;

/** This thread's CPU time (Node 23.9 and later), else the process's. */
const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage =
  process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);

/** `unit` repeated to at least `size` characters. */
export const repeatTo = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length));

/**
 * The CPU time `run` takes, in milliseconds. Wall-clock time also counts the
 * time the process waits for a CPU: under load a 100 ms run is preempted
 * about as often as the machine is oversubscribed, while a 10 ms run often
 * fits in one scheduler slice, which doubled the measured growth of linear
 * scans with eight busy processes on eight cores. A synchronous run does its
 * work on this thread, so this counts this thread only: the process's CPU
 * time also counts V8's background GC and compiler threads, whose share moved
 * the growth of linear checks between 4.2 and 6.8 from run to run.
 */
export const cpuMs = (run: () => unknown): number => {
  const start = threadCpuUsage();
  run();
  const { user, system } = threadCpuUsage(start);
  return (user + system) / 1000;
};

/**
 * `cpuMs` for a run that returns a promise: the process's CPU time until it
 * settles, since an asynchronous run can do its work on other threads.
 * Vitest runs each test file in its own process.
 */
export const cpuMsAsync = async (
  run: () => Promise<unknown>,
): Promise<number> => {
  const start = process.cpuUsage();
  await run();
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
};

export interface Growth {
  /** CPU time of one run at a quarter size, fastest sample. */
  smallMs: number;
  /** CPU time of one run at full size, fastest sample. */
  largeMs: number;
  /**
   * `largeMs` over `smallMs`, where a quarter-size sample under the noise
   * floor counts as the floor.
   */
  growth: number;
  /** Runs per quarter-size sample, so it reaches `MIN_SAMPLE_MS`. */
  runs: number;
  /**
   * Runs per full-size sample: a quarter of `runs`, so that it too takes
   * about `MIN_SAMPLE_MS` for linear work, and no less than one.
   */
  largeRuns: number;
}

const growthOf = (
  smallSampleMs: number,
  largeSampleMs: number,
  runs: number,
  largeRuns: number,
): Growth => ({
  smallMs: smallSampleMs / runs,
  largeMs: largeSampleMs / largeRuns,
  growth:
    largeSampleMs /
    largeRuns /
    (Math.max(smallSampleMs, NOISE_FLOOR_MS) / runs),
  runs,
  largeRuns,
});

/**
 * Runs for the next calibration step, after `runs` runs took `ms`: enough
 * for `MIN_SAMPLE_MS` with room for a run that gets faster once compiled, at
 * least twice as many, at most `MAX_RUNS`.
 */
const nextRuns = (runs: number, ms: number): number =>
  Math.min(
    MAX_RUNS,
    Math.max(
      runs * 2,
      Math.ceil((runs * MIN_SAMPLE_MS * 1.5) / Math.max(ms, 0.001)),
    ),
  );

const LOG = process.env.BASCIK_LINEAR_TIME_LOG;
const log = (growth: Growth): Growth => {
  // Records every measurement when set, to compare margins across runs.
  if (LOG) {
    const test = expect.getState().currentTestName ?? "";
    appendFileSync(LOG, `${JSON.stringify({ test, ...growth })}\n`);
  }
  return growth;
};

/**
 * Times `run` on `input(size / 4)` and `input(size)`. After one run to warm
 * the JIT up, it runs the quarter-size input more times each step until one
 * step takes `MIN_SAMPLE_MS`, which sets the runs per sample (a quarter as
 * many at full size). Then it takes `SAMPLES` interleaved samples of each
 * size, the last step counting as the first quarter-size one, and keeps the
 * fastest of each. `size` is whatever `input` scales by: characters,
 * repetitions, instances.
 */
export const measureGrowth = <T>(
  input: (size: number) => T,
  size: number,
  run: (input: T) => unknown,
  clock: (run: () => unknown) => number = cpuMs,
): Growth => {
  const small = input(size / 4);
  const large = input(size);
  const sample = (subject: T, runs: number): number =>
    clock(() => {
      for (let i = 0; i < runs; i++) run(subject);
    });
  // A first run compiles the code it calls, and can take the minimum on
  // its own.
  sample(small, 1);
  let runs = 1;
  let ms = sample(small, runs);
  while (ms < MIN_SAMPLE_MS && runs < MAX_RUNS) {
    runs = nextRuns(runs, ms);
    ms = sample(small, runs);
  }
  const largeRuns = Math.ceil(runs / 4);
  // The last calibration step is the first quarter-size sample.
  let smallMs = ms;
  let largeMs = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) smallMs = Math.min(smallMs, sample(small, runs));
    largeMs = Math.min(largeMs, sample(large, largeRuns));
  }
  return log(growthOf(smallMs, largeMs, runs, largeRuns));
};

/** `measureGrowth` for a run that returns a promise. */
export const measureGrowthAsync = async <T>(
  input: (size: number) => T,
  size: number,
  run: (input: T) => Promise<unknown>,
  clock: (run: () => Promise<unknown>) => Promise<number> = cpuMsAsync,
): Promise<Growth> => {
  const small = input(size / 4);
  const large = input(size);
  const sample = (subject: T, runs: number): Promise<number> =>
    clock(async () => {
      for (let i = 0; i < runs; i++) await run(subject);
    });
  await sample(small, 1);
  let runs = 1;
  let ms = await sample(small, runs);
  while (ms < MIN_SAMPLE_MS && runs < MAX_RUNS) {
    runs = nextRuns(runs, ms);
    ms = await sample(small, runs);
  }
  const largeRuns = Math.ceil(runs / 4);
  let smallMs = ms;
  let largeMs = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) smallMs = Math.min(smallMs, await sample(small, runs));
    largeMs = Math.min(largeMs, await sample(large, largeRuns));
  }
  return log(growthOf(smallMs, largeMs, runs, largeRuns));
};

export interface LinearTimeOptions {
  /** Defaults to `CEILING_MS`. */
  ceilingMs?: number;
  /** Named in the failure message, for a check run over several inputs. */
  label?: string;
}

const expectGrowth = (
  { smallMs, largeMs, growth, runs, largeRuns }: Growth,
  { ceilingMs = CEILING_MS, label }: LinearTimeOptions,
): void => {
  const what = `${label ? `${label}: ` : ""}${smallMs.toFixed(2)} ms at a quarter size, ${largeMs.toFixed(2)} ms at full size, ${runs}/${largeRuns} runs per sample`;
  expect(growth, `${what} (growth)`).toBeLessThan(MAX_GROWTH);
  expect(largeMs, `${what} (ceiling)`).toBeLessThan(ceilingMs);
};

/**
 * Requires `run` to take linear time in `size`: its CPU time grows less than
 * `MAX_GROWTH` times from `input(size / 4)` to `input(size)`, and one
 * full-size run stays under the ceiling.
 */
export const expectLinearTime = <T>(
  input: (size: number) => T,
  size: number,
  run: (input: T) => unknown,
  options: LinearTimeOptions = {},
): void => expectGrowth(measureGrowth(input, size, run), options);

/** `expectLinearTime` for a run that returns a promise. */
export const expectLinearTimeAsync = async <T>(
  input: (size: number) => T,
  size: number,
  run: (input: T) => Promise<unknown>,
  options: LinearTimeOptions = {},
): Promise<void> =>
  expectGrowth(await measureGrowthAsync(input, size, run), options);
