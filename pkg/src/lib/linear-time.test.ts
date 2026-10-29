import { describe, expect, it } from "vitest";
import {
  MAX_GROWTH,
  MAX_RUNS,
  MIN_SAMPLE_MS,
  NOISE_FLOOR_MS,
  cpuMs,
  expectLinearTime,
  expectLinearTimeAsync,
  LINEAR_TIME_TIMEOUT_MS,
  measureGrowth,
  measureGrowthAsync,
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
