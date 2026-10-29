import { describe, expect, inject, it } from "vitest";
import {
  COST_RATIO_HEADROOM,
  EXTRA_SAMPLES,
  MAX_GROWTH,
  MAX_RUNS,
  RESAMPLE_ABOVE,
  SAMPLES,
  MIN_SAMPLE_MS,
  NOISE_FLOOR_MS,
  coverageEnabled,
  cpuMs,
  expectCostRatio,
  expectGrowth,
  expectLinearTime,
  expectLinearTimeAsync,
  LINEAR_TIME_TIMEOUT_MS,
  measureCostRatio,
  COST_MIN_SAMPLE_MS,
  measureGrowth,
  measureGrowthAsync,
  spliceCopies,
} from "./linear-time.test-helper.ts";

const SIZE = 200_000;

describe("measureGrowth", () => {
  // A fake clock charges each run a cost of its input length, and adds a
  // stall of 300 ms to every other full-size sample, the way a CPU-starved
  // runner loses the CPU to another process now and then.
  const fakeClock = (cost: (n: number) => number) => {
    let stalled = false;
    let spent = 0;
    let large = false;
    const start = () => {
      spent = 0;
      large = false;
    };
    const charge = (): number => {
      if (large && stalled) spent += 300;
      if (large) stalled = !stalled;
      return spent;
    };
    const clock = (fn: () => unknown): number => {
      start();
      fn();
      return charge();
    };
    const asyncClock = async (fn: () => Promise<unknown>): Promise<number> => {
      start();
      await fn();
      return charge();
    };
    const run = (html: string) => {
      spent += cost(html.length);
      large ||= html.length === SIZE;
    };
    const runAsync = async (html: string) => {
      await Promise.resolve();
      run(html);
    };
    return { clock, asyncClock, run, runAsync };
  };
  const input = (size: number) => "x".repeat(size);

  it("passes linear work even when a CPU-starved run stalls for 300 ms", () => {
    const { clock, run } = fakeClock((n) => n / 2_000);
    expect(measureGrowth(input, SIZE, run, clock)).toEqual({
      smallMs: 25,
      largeMs: 100,
      growth: 4,
      runs: 1,
      largeRuns: 1,
    });
  });

  it("the old fixed 250 ms bound failed that same stalled run", () => {
    // Without repeated samples the stalled run is the measurement.
    const { clock, run } = fakeClock((n) => n / 2_000);
    clock(() => run(input(SIZE)));
    expect(clock(() => run(input(SIZE)))).toBeGreaterThan(250);
  });

  it("fails quadratic work, whose time grows 16 times", () => {
    const { clock, run } = fakeClock((n) => (n / 2_000) ** 2 / 100);
    expect(measureGrowth(input, SIZE, run, clock).growth).toBe(16);
  });

  it("repeats a quarter-size run under the noise floor until the sample is measurable", () => {
    // 0.06 ms at a quarter size: a single run against the 5 ms floor would
    // put quadratic growth at 0.2, and linear work at 0.05.
    const quadratic = fakeClock((n) => (n / 2_000) ** 2 / 10_000);
    const q = measureGrowth(input, SIZE, quadratic.run, quadratic.clock);
    expect(q.smallMs).toBeLessThan(NOISE_FLOOR_MS / 50);
    expect(q.smallMs * q.runs).toBeGreaterThanOrEqual(MIN_SAMPLE_MS);
    expect(q.growth).toBeCloseTo(16, 9);
    const linear = fakeClock((n) => n / 2_000_000);
    const l = measureGrowth(input, SIZE, linear.run, linear.clock);
    expect(l.smallMs * l.runs).toBeGreaterThanOrEqual(MIN_SAMPLE_MS);
    expect(l.growth).toBeCloseTo(4, 9);
  });

  it("divides by the noise floor only when even MAX_RUNS runs stay under it", () => {
    const { clock, run } = fakeClock((n) => (n === SIZE ? 0.01 : 0.001));
    const { runs, growth } = measureGrowth(input, SIZE, run, clock);
    expect(runs).toBe(MAX_RUNS);
    expect(MAX_RUNS * 0.001).toBeLessThan(NOISE_FLOOR_MS);
    expect(growth).toBeCloseTo((MAX_RUNS * 0.01) / NOISE_FLOOR_MS, 9);
  });

  it("takes the growth over a baseline, which a fixed cost otherwise hides", () => {
    // 50 ms per run whatever the size, plus a quadratic term: 6.25 ms at a
    // quarter size, 100 ms at full size.
    const cost = (n: number) => 50 + (n / 2_000) ** 2 / 100;
    const plain = fakeClock(cost);
    const hidden = measureGrowth(input, SIZE, plain.run, plain.clock);
    expect(hidden.growth).toBeLessThan(MAX_GROWTH);
    const based = fakeClock(cost);
    const growth = measureGrowth(input, SIZE, based.run, based.clock, "");
    expect(growth.baseMs).toBe(50);
    expect(growth.growth).toBeCloseTo(16, 9);
    // Linear work over the same fixed cost reads 4.
    const linear = fakeClock((n) => 50 + n / 2_000);
    expect(
      measureGrowth(input, SIZE, linear.run, linear.clock, "").growth,
    ).toBeCloseTo(4, 9);
  });

  it("refuses a baseline that leaves the part that varies unmeasured", () => {
    // 1 ms over a 50 ms baseline at a quarter size.
    const { clock, run } = fakeClock((n) => 50 + n / 50_000);
    const growth = measureGrowth(input, SIZE, run, clock, "");
    expect(() => expectGrowth(growth)).toThrow(/\(baseline\)/);
  });

  it("takes more samples only while the growth is in the band noise reaches", () => {
    // The first three full-size samples run 60% slow, as on a loaded
    // machine: growth 6.4 after `SAMPLES` pairs, 4 once a clean one comes.
    let large = 0;
    let samples = 0;
    let spent = 0;
    let lastSize = 0;
    const run = (html: string) => {
      spent += html.length / 2_000;
      lastSize = html.length;
    };
    const noisy = (fn: () => unknown): number => {
      samples++;
      const before = spent;
      fn();
      const ms = spent - before;
      return lastSize === SIZE && large++ < SAMPLES ? ms * 1.6 : ms;
    };
    const linear = measureGrowth(input, SIZE, run, noisy);
    expect(linear.growth).toBeCloseTo(4, 9);
    expect(large).toBe(SAMPLES + 1);
    // Quadratic work is above the band: no extra samples.
    const quadratic = fakeClock((n) => (n / 2_000) ** 2 / 10);
    let count = 0;
    const counted = (fn: () => unknown) => (count++, quadratic.clock(fn));
    expect(measureGrowth(input, SIZE, quadratic.run, counted).growth).toBe(16);
    // A warm-up, one calibration step, then `SAMPLES` pairs less the step.
    expect(count).toBe(2 + 2 * SAMPLES - 1);
    // Noise that never goes away stops after `EXTRA_SAMPLES` more pairs,
    // and fails.
    large = -Infinity;
    samples = 0;
    const stuck = measureGrowth(input, SIZE, run, noisy);
    expect(stuck.growth).toBeGreaterThan(RESAMPLE_ABOVE);
    expect(samples).toBe(2 + 2 * (SAMPLES + EXTRA_SAMPLES) - 1);
  });

  it("measures a run that returns a promise the same way", async () => {
    const linear = fakeClock((n) => n / 2_000);
    expect(
      await measureGrowthAsync(input, SIZE, linear.runAsync, linear.asyncClock),
    ).toEqual({ smallMs: 25, largeMs: 100, growth: 4, runs: 1, largeRuns: 1 });
    const quadratic = fakeClock((n) => (n / 2_000) ** 2 / 10_000);
    const q = await measureGrowthAsync(
      input,
      SIZE,
      quadratic.runAsync,
      quadratic.asyncClock,
    );
    expect(q.runs).toBeGreaterThan(1);
    expect(q.growth).toBeCloseTo(16, 9);
  });
});

// On the real clock: a quadratic scan of a few thousand items, against a
// linear one over the same input. Each is sized from a calibration so that a
// single quarter-size run is well above the noise floor, and checked again at
// a size where a single quarter-size run is well under it, which only the
// repeated samples make measurable.
describe("expectLinearTime", () => {
  const items = (count: number) => Array.from({ length: count }, (_, i) => i);
  const quadratic = (list: number[]) => {
    let pairs = 0;
    for (let i = 0; i < list.length; i++)
      for (let j = i; j < list.length; j++) pairs += list[i] ^ list[j];
    return pairs;
  };
  const linear = (list: number[]) => {
    let sum = 0;
    for (let k = 0; k < 200; k++) for (const n of list) sum += n ^ k;
    return sum;
  };
  /**
   * The smallest power-of-two count whose quarter takes `ms` in one run of
   * `work`, compiled.
   */
  const countFor = (work: (list: number[]) => unknown, ms: number): number => {
    for (let count = 256; ; count *= 2) {
      const quarter = items(count / 4);
      work(quarter);
      if (cpuMs(() => work(quarter)) >= ms) return count;
    }
  };
  const ABOVE = 4 * NOISE_FLOOR_MS;
  const quadraticAbove = countFor(quadratic, ABOVE);
  const linearAbove = countFor(linear, ABOVE);
  const BELOW = 1_000; // a quarter of 250 items: microseconds

  it("passes linear work", () => {
    expectLinearTime(items, linearAbove, linear);
    expectLinearTime(items, BELOW, linear);
  });

  it(
    "fails quadratic work on its growth, well under the ceiling",
    () => {
      expect(MAX_GROWTH).toBeLessThan(16);
      for (const count of [quadraticAbove, BELOW]) {
        expect(() => expectLinearTime(items, count, quadratic)).toThrow(
          /\(growth\)/,
        );
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it("fails work that is linear in the input but over the ceiling", () => {
    expect(() =>
      expectLinearTime(items, linearAbove, linear, { ceilingMs: 1 }),
    ).toThrow(/\(ceiling\)/);
  });

  it(
    "names the label, both times and the runs per sample in the failure",
    async () => {
      for (const count of [quadraticAbove, BELOW]) {
        await expect(
          expectLinearTimeAsync(items, count, async (list) => quadratic(list), {
            label: "pairs",
          }),
        ).rejects.toThrow(
          /^pairs: [\d.]+ ms at a quarter size, [\d.]+ ms at full size, \d+\/\d+ runs per sample \(growth\)/,
        );
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("coverageEnabled", () => {
  // A calibrated cost ratio takes its limit from this (request-render-
  // security.test.ts G), so an unknown answer must fail, not fall back.
  it("answers from the run's resolved configuration, never unknown", () => {
    expect(inject("bascikCoverage")).toBeTypeOf("boolean");
    expect(coverageEnabled()).toBe(inject("bascikCoverage"));
    // Vitest's own worker state, where it still has it, agrees.
    const internal = (
      globalThis as {
        __vitest_worker__?: { config?: { coverage?: { enabled?: unknown } } };
      }
    ).__vitest_worker__?.config?.coverage?.enabled;
    if (internal !== undefined) expect(coverageEnabled()).toBe(internal);
  });
});

describe("cost ratios", () => {
  it("measures a run against reference work in the same process", () => {
    const text = "x".repeat(200_000);
    const once = () => spliceCopies(text, 100);
    const twice = () => {
      spliceCopies(text, 100);
      spliceCopies(text, 100);
    };
    const { ratio, runs, referenceMs } = measureCostRatio(twice, once);
    expect(referenceMs * runs).toBeGreaterThanOrEqual(COST_MIN_SAMPLE_MS / 2);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.7);
  });

  it(`fails at ${COST_RATIO_HEADROOM} times the calibration for this run's coverage mode, and names the check and both times`, () => {
    const calibrated = coverageEnabled()
      ? { plain: 100, coverage: 1.5 }
      : { plain: 1.5, coverage: 100 };
    const at = (ratio: number) => ({
      runMs: ratio * 10,
      referenceMs: 10,
      ratio,
      runs: 1,
    });
    expect(() => expectCostRatio(at(2.9), calibrated, "cap")).not.toThrow();
    expect(() => expectCostRatio(at(3.1), calibrated, "cap")).toThrow(
      /^cap: 31\.00 ms against 10\.00 ms of reference work, 1 runs per sample, ratio 3\.10 against 3\.00/,
    );
  });

  it("repeats a cheap reference until its sample is measurable", () => {
    let spent = 0;
    const clock = (fn: () => unknown) => {
      spent = 0;
      fn();
      return spent;
    };
    const { runs, ratio } = measureCostRatio(
      () => (spent += 0.3),
      () => (spent += 0.1),
      clock,
    );
    expect(runs * 0.1).toBeGreaterThanOrEqual(COST_MIN_SAMPLE_MS);
    expect(ratio).toBeCloseTo(3, 9);
  });
});
