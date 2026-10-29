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
 * regressions.
 *
 * A fixed cost that both sizes share (a substitution limit both reach) hides
 * a quadratic term under a growth near 1: such a check passes a `baseline`
 * input with that cost alone, and the growth is taken over it. Amplification
 * that a cap keeps linear in the input (a pass repeated once per instance,
 * up to an instance limit, is linear in the input once the limit is
 * reached, yet takes seconds) passes any growth check: a calibrated cost
 * ratio against reference work in the same process fails it
 * (`expectCostRatio`).
 */
import { appendFileSync } from "node:fs";
import { expect, inject } from "vitest";

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
 * More pairs of samples, taken one at a time while the growth so far is in
 * the band that load reaches on linear work (`RESAMPLE_ABOVE` up to
 * `RESAMPLE_BELOW`). Every sample of a size is its work plus noise, so the
 * fastest only gets closer to the work: an extra pair can lower a growth
 * that noise raised, never one that the work has. In isolation the linear
 * checks read 5.2 at most; under a loaded machine (other test workers, busy
 * processes, a thread moved to an efficiency core) some read 6 to 7 after
 * three pairs, and about 4 after more. Quadratic work reads 16, above the
 * band, and fails without them.
 */
export const EXTRA_SAMPLES = 6;
export const RESAMPLE_ABOVE = 5;
export const RESAMPLE_BELOW = 12;
const inResampleBand = (growth: number): boolean =>
  growth > RESAMPLE_ABOVE && growth < RESAMPLE_BELOW;
/**
 * A timeout for a test that measures growth: it calibrates on the
 * quarter-size input, then runs `SAMPLES` samples at each size, which on a
 * slow shared runner under coverage takes longer than Vitest's default 5 s.
 */
export const LINEAR_TIME_TIMEOUT_MS = 60_000;

/** This thread's CPU time (Node 23.9 and later), else the process's. */
const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage =
  process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);

/**
 * Whether this run collects coverage, from the resolved Vitest
 * configuration (vitest.coverage-setup.ts, a global setup of both projects).
 * Coverage slows the code under test and not plain JavaScript, so a
 * calibrated cost ratio needs a limit for each. It throws rather than guess:
 * a run that took the looser limit by mistake would let through what the
 * tighter one fails.
 */
export const coverageEnabled = (): boolean => {
  const enabled: unknown = inject("bascikCoverage");
  if (typeof enabled !== "boolean")
    throw new Error(
      `coverageEnabled: the run did not say whether it collects coverage (got ${String(enabled)}); vite.config.js must list vitest.coverage-setup.ts in the project's globalSetup`,
    );
  return enabled;
};

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
   * CPU time of one run of the baseline input, fastest sample: only for a
   * check given one (`LinearTimeOptions.baseline`).
   */
  baseMs?: number;
  /**
   * `largeMs` over `smallMs`, less `baseMs` from each when there is a
   * baseline, where a quarter-size sample (or its part over the baseline)
   * under the noise floor counts as the floor.
   */
  growth: number;
  /**
   * Runs per quarter-size sample, so it (or its part over the baseline)
   * reaches `MIN_SAMPLE_MS`.
   */
  runs: number;
  /**
   * Runs per full-size sample: a quarter of `runs`, so that it too takes
   * about `MIN_SAMPLE_MS` for linear work, and no less than one.
   */
  largeRuns: number;
}

/**
 * The most a calibration step may take: a run with a baseline repeats until
 * its part over the baseline reaches `MIN_SAMPLE_MS`, which a run that is
 * nearly all baseline would otherwise take `MAX_RUNS` runs of tens of
 * milliseconds to do.
 */
export const MAX_SAMPLE_MS = 1_000;

const growthOf = (
  smallSampleMs: number,
  largeSampleMs: number,
  runs: number,
  largeRuns: number,
  baseSampleMs: number | undefined,
): Growth => {
  const smallMs = smallSampleMs / runs;
  const largeMs = largeSampleMs / largeRuns;
  if (baseSampleMs === undefined)
    return {
      smallMs,
      largeMs,
      growth: largeMs / (Math.max(smallSampleMs, NOISE_FLOOR_MS) / runs),
      runs,
      largeRuns,
    };
  const baseMs = baseSampleMs / runs;
  return {
    smallMs,
    largeMs,
    baseMs,
    growth:
      (largeMs - baseMs) /
      (Math.max(smallSampleMs - baseSampleMs, NOISE_FLOOR_MS) / runs),
    runs,
    largeRuns,
  };
};

/**
 * Runs for the next step after one that read no time at all. Windows counts
 * a thread's CPU time in 15.625 ms scheduler ticks, so a run shorter than a
 * tick reads 0: that says nothing about how short it is, and taken as
 * "too fast to time" it sent calibration straight to `MAX_RUNS` of a run
 * that took milliseconds. Doubling reaches one tick in a few steps.
 */
const growRuns = (runs: number): number => Math.min(MAX_RUNS, runs * 2);

/**
 * Runs for the next calibration step, after `runs` runs took `ms`, of which
 * `varyingMs` over the baseline: enough for `MIN_SAMPLE_MS` of it with room
 * for a run that gets faster once compiled, at least twice as many, at most
 * `MAX_RUNS`, and no more than fit in `MAX_SAMPLE_MS`.
 */
const nextRuns = (runs: number, ms: number, varyingMs: number): number =>
  ms <= 0
    ? growRuns(runs)
    : Math.max(
        runs,
        Math.min(
          MAX_RUNS,
          Math.floor((runs * MAX_SAMPLE_MS) / Math.max(ms, 0.001)),
          Math.max(
            runs * 2,
            Math.ceil(
              (runs * MIN_SAMPLE_MS * 1.5) / Math.max(varyingMs, 0.001),
            ),
          ),
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

/** One sample to take: `runs` runs of `subject`. */
interface Step<T> {
  subject: T;
  runs: number;
}

/**
 * The samples a measurement takes, each answered with its CPU time, then the
 * growth. Shared by the synchronous and the asynchronous drivers.
 */
function* samplesOf<T>(
  small: T,
  large: T,
  baseline: T | undefined,
): Generator<Step<T>, Growth, number> {
  const based = baseline !== undefined;
  const base = (runs: number) => ({ subject: baseline as T, runs });
  // A first run compiles the code it calls, and can take the minimum on
  // its own.
  yield { subject: small, runs: 1 };
  if (based) yield base(1);
  let runs = 1;
  let ms = yield { subject: small, runs };
  let baseMs = based ? yield base(runs) : 0;
  let calibrated = false;
  for (;;) {
    while (ms - baseMs < MIN_SAMPLE_MS) {
      const more = nextRuns(runs, ms, ms - baseMs);
      if (more === runs) break;
      runs = more;
      ms = yield { subject: small, runs };
      if (based) baseMs = yield base(runs);
    }
    const largeRuns = Math.ceil(runs / 4);
    // The last calibration step is the first quarter-size sample.
    let smallMs = ms;
    let largeMs = Infinity;
    const growth = () =>
      growthOf(smallMs, largeMs, runs, largeRuns, based ? baseMs : undefined);
    for (let i = 0; i < SAMPLES + EXTRA_SAMPLES; i++) {
      // Past `SAMPLES`, only a growth in the band noise reaches goes on.
      if (i >= SAMPLES && !inResampleBand(growth().growth)) break;
      if (i > 0) {
        smallMs = Math.min(smallMs, yield { subject: small, runs });
        if (based) baseMs = Math.min(baseMs, yield base(runs));
      }
      largeMs = Math.min(largeMs, yield { subject: large, runs: largeRuns });
    }
    // A calibration step slowed by a collection or a deoptimization can set
    // too few runs, leaving the fastest sample under the noise floor: once,
    // calibrate again from the fastest sample.
    if (calibrated || smallMs - baseMs >= MIN_SAMPLE_MS / 2) return growth();
    calibrated = true;
    ms = smallMs;
  }
}

/**
 * Times `run` on `input(size / 4)` and `input(size)`. After one run to warm
 * the JIT up, it runs the quarter-size input more times each step until one
 * step takes `MIN_SAMPLE_MS`, which sets the runs per sample (a quarter as
 * many at full size). Then it takes `SAMPLES` interleaved samples of each
 * size, the last step counting as the first quarter-size one, and keeps the
 * fastest of each. `size` is whatever `input` scales by: characters,
 * repetitions, instances.
 *
 * With a `baseline`, an input that costs what both sizes cost whatever their
 * size (a fixed number of usages, each substituted once), it is timed at the
 * quarter size's runs next to each quarter-size sample, and the growth is
 * that of the time over it: a fixed cost that dominates both sizes would
 * otherwise hide a quadratic term under a growth near 1.
 */
export const measureGrowth = <T>(
  input: (size: number) => T,
  size: number,
  run: (input: T) => unknown,
  clock: (run: () => unknown) => number = cpuMs,
  baseline?: T,
): Growth => {
  const steps = samplesOf(input(size / 4), input(size), baseline);
  const sample = ({ subject, runs }: Step<T>): number =>
    clock(() => {
      for (let i = 0; i < runs; i++) run(subject);
    });
  let step = steps.next();
  while (!step.done) step = steps.next(sample(step.value));
  return log(step.value);
};

/** `measureGrowth` for a run that returns a promise. */
export const measureGrowthAsync = async <T>(
  input: (size: number) => T,
  size: number,
  run: (input: T) => Promise<unknown>,
  clock: (run: () => Promise<unknown>) => Promise<number> = cpuMsAsync,
  baseline?: T,
): Promise<Growth> => {
  const steps = samplesOf(input(size / 4), input(size), baseline);
  const sample = ({ subject, runs }: Step<T>): Promise<number> =>
    clock(async () => {
      for (let i = 0; i < runs; i++) await run(subject);
    });
  let step = steps.next();
  while (!step.done) step = steps.next(await sample(step.value));
  return log(step.value);
};

export interface LinearTimeOptions<T = unknown> {
  /** Defaults to `CEILING_MS`. */
  ceilingMs?: number;
  /** Named in the failure message, for a check run over several inputs. */
  label?: string;
  /**
   * An input with the cost both sizes share and none of the work that
   * grows with the size, such as the same number of usages with no text
   * around them: the growth is measured over it (`measureGrowth`).
   */
  baseline?: T;
}

/** The failure message's account of a measurement. */
export const describeGrowth = (
  { smallMs, largeMs, baseMs, runs, largeRuns }: Growth,
  label?: string,
): string =>
  `${label ? `${label}: ` : ""}${smallMs.toFixed(2)} ms at a quarter size, ${largeMs.toFixed(2)} ms at full size, ${baseMs === undefined ? "" : `${baseMs.toFixed(2)} ms of baseline, `}${runs}/${largeRuns} runs per sample`;

/**
 * Fails a measurement whose growth reaches `MAX_GROWTH`, or whose full-size
 * run reaches the ceiling, with a message that names the check, both times
 * (and the baseline's) and the runs per sample.
 */
export const expectGrowth = (
  growth: Growth,
  { ceilingMs = CEILING_MS, label }: LinearTimeOptions<unknown> = {},
): void => {
  const what = describeGrowth(growth, label);
  if (growth.baseMs !== undefined)
    // Under the baseline's noise, the part that varies is not measured.
    expect(
      growth.smallMs - growth.baseMs,
      `${what}: the baseline is most of the quarter-size run; raise the size until the part that varies is at least a quarter of it (baseline)`,
    ).toBeGreaterThanOrEqual(growth.baseMs / 4);
  expect(growth.growth, `${what} (growth)`).toBeLessThan(MAX_GROWTH);
  expect(growth.largeMs, `${what} (ceiling)`).toBeLessThan(ceilingMs);
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
  options: LinearTimeOptions<T> = {},
): void =>
  expectGrowth(
    measureGrowth(input, size, run, undefined, options.baseline),
    options,
  );

/** `expectLinearTime` for a run that returns a promise. */
export const expectLinearTimeAsync = async <T>(
  input: (size: number) => T,
  size: number,
  run: (input: T) => Promise<unknown>,
  options: LinearTimeOptions<T> = {},
): Promise<void> =>
  expectGrowth(
    await measureGrowthAsync(input, size, run, undefined, options.baseline),
    options,
  );

// ─── Calibrated cost ratios ─────────────────────────────────────────────────
//
// Some amplification is linear in the input once a limit is reached: a pass
// over the whole output repeated once per instance, up to the instance
// limit, grows with the output like the work it replaced, so growth cannot
// see it. Such a check compares the run's CPU time with that of a reference
// workload timed in the same process, plain JavaScript that does the work
// the run is made of (or a fixed multiple of it), and requires the ratio to
// stay under twice the ratio calibrated for it. Both sides slow down
// together on a loaded or slower machine, so the ratio holds where an
// absolute bound flakes, and it is far tighter than such a bound.

/** The headroom over a calibrated ratio before a check fails. */
export const COST_RATIO_HEADROOM = 2;

/**
 * A calibrated ratio for each coverage mode: coverage instruments the code
 * under test, not the reference workload (test helpers are excluded from
 * coverage in vite.config.js), so it raises the ratio.
 */
export interface CalibratedRatio {
  /** Measured without coverage. */
  plain: number;
  /** Measured with coverage (`yarn pkg:test:ci`). */
  coverage: number;
}

export interface CostRatio {
  /** CPU time of one run, fastest sample. */
  runMs: number;
  /** CPU time of one reference run, fastest sample. */
  referenceMs: number;
  /** `runMs` over `referenceMs`. */
  ratio: number;
  /**
   * Runs of each per sample, so the reference's reaches
   * `COST_MIN_SAMPLE_MS`.
   */
  runs: number;
}

/**
 * Each reference sample repeats the reference until it takes at least this
 * long. At 10 ms a reference of 5 to 16 ms ran once or a few times per
 * sample, and the same check read 22 and 67 from run to run.
 */
export const COST_MIN_SAMPLE_MS = 30;

/** The samples of a cost ratio, each answered with its CPU time. */
function* costSamplesOf(): Generator<
  { reference: boolean; runs: number },
  CostRatio,
  number
> {
  // A first run of each compiles the code it calls.
  yield { reference: false, runs: 1 };
  let runs = 1;
  let referenceMs = yield { reference: true, runs };
  while (referenceMs < COST_MIN_SAMPLE_MS && runs < MAX_RUNS) {
    runs =
      referenceMs <= 0
        ? growRuns(runs)
        : Math.min(
            MAX_RUNS,
            Math.max(
              runs * 2,
              Math.ceil(
                (runs * COST_MIN_SAMPLE_MS * 1.5) /
                  Math.max(referenceMs, 0.001),
              ),
            ),
          );
    referenceMs = yield { reference: true, runs };
  }
  let runMs = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    runMs = Math.min(runMs, yield { reference: false, runs });
    if (i > 0)
      referenceMs = Math.min(referenceMs, yield { reference: true, runs });
  }
  return {
    runMs: runMs / runs,
    referenceMs: referenceMs / runs,
    ratio: runMs / referenceMs,
    runs,
  };
}

const logRatio = (ratio: CostRatio): CostRatio => {
  if (LOG) {
    const test = expect.getState().currentTestName ?? "";
    appendFileSync(LOG, `${JSON.stringify({ test, ...ratio })}\n`);
  }
  return ratio;
};

/**
 * The CPU time of `run` over that of `reference`, fastest of `SAMPLES` each.
 * Both are timed with the same clock, the process's CPU time for an
 * asynchronous run, so the share of V8's GC threads counts on both sides.
 */
export const measureCostRatioAsync = async (
  run: () => Promise<unknown>,
  reference: () => unknown,
  clock: (run: () => Promise<unknown>) => Promise<number> = cpuMsAsync,
): Promise<CostRatio> => {
  const steps = costSamplesOf();
  let step = steps.next();
  while (!step.done) {
    const { reference: isReference, runs } = step.value;
    step = steps.next(
      await clock(async () => {
        for (let i = 0; i < runs; i++)
          if (isReference) reference();
          else await run();
      }),
    );
  }
  return logRatio(step.value);
};

/** `measureCostRatioAsync` for a synchronous run. */
export const measureCostRatio = (
  run: () => unknown,
  reference: () => unknown,
  clock: (run: () => unknown) => number = cpuMs,
): CostRatio => {
  const steps = costSamplesOf();
  let step = steps.next();
  while (!step.done) {
    const { reference: isReference, runs } = step.value;
    step = steps.next(
      clock(() => {
        for (let i = 0; i < runs; i++) (isReference ? reference : run)();
      }),
    );
  }
  return logRatio(step.value);
};

/**
 * Fails a cost ratio at `COST_RATIO_HEADROOM` times its calibrated value for
 * this run's coverage mode, naming the check and both times.
 */
export const expectCostRatio = (
  { runMs, referenceMs, ratio, runs }: CostRatio,
  calibrated: CalibratedRatio,
  label = "",
): void => {
  const coverage = coverageEnabled();
  const limit =
    COST_RATIO_HEADROOM * (coverage ? calibrated.coverage : calibrated.plain);
  expect(
    ratio,
    `${label ? `${label}: ` : ""}${runMs.toFixed(2)} ms against ${referenceMs.toFixed(2)} ms of reference work, ${runs} runs per sample, ratio ${ratio.toFixed(2)} against ${limit.toFixed(2)} (twice the ${coverage ? "coverage" : "plain"} calibration)`,
  ).toBeLessThan(limit);
};

/**
 * Reference work for request-time expansion: `count` splices of `text` and
 * of a mask as long as it, spread evenly, each spliced string then read so
 * V8 copies it whole. That is the copying a substitution in one fragment
 * does (expandComponents, spliceRawTextMask).
 */
export const spliceCopies = (text: string, count: number): number => {
  const tag = `<p class="p">v</p>`;
  let page = text;
  let mask = text.replaceAll("x", " ");
  let read = 0;
  for (let i = 0; i < count; i++) {
    const at = Math.floor((i * page.length) / count);
    page = page.slice(0, at) + tag + page.slice(at + 8);
    mask = mask.slice(0, at) + tag + mask.slice(at + 8);
    // Taking a piece of a joined string flattens it: one copy each.
    if (page.slice(at, at + 1) === mask.slice(at, at + 1)) read++;
  }
  return read;
};
