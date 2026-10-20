import { describe, expect, it } from "vitest";
import {
  FUZZ_TARGETS,
  parseFuzzArguments,
  runDifferentialFuzz,
  type CompilerProbe,
} from "../../bench/compiler-fuzz.ts";

const probe = (): CompilerProbe => ({
  expansion: (input) => ({ html: input.html, names: [] }),
  props: (input) => input.html,
  slots: (input) => ({ default: input.html, named: {} }),
  tags: (input) => ({ content: input.html, startIndex: input.searchFrom }),
  masking: (input) => input.html,
  javascript: (input) => input.javascript,
});

describe("compiler differential fuzzing", () => {
  it("compares all targets, including a second warm candidate call", () => {
    let calls = 0;
    const candidate = probe();
    candidate.props = (input) => {
      calls++;
      return input.html;
    };
    const results = runDifferentialFuzz(probe(), candidate, {
      runs: 50,
      seed: 31337,
      targets: [...FUZZ_TARGETS],
    });
    expect(results.map(({ target }) => target)).toEqual(FUZZ_TARGETS);
    expect(results.every(({ failed, runs }) => !failed && runs === 50)).toBe(
      true,
    );
    expect(calls).toBe(100);
  });

  it("reports and replays a shrunk mismatch without normalizing output", () => {
    const candidate = probe();
    candidate.props = () => "\x00BASCIK_SHIELD_999\x00";
    const options = { runs: 50, seed: 777, targets: ["props"] as const };
    const [failure] = runDifferentialFuzz(probe(), candidate, options);
    expect(failure.failed).toBe(true);
    expect(failure.counterexample).not.toBeNull();
    expect(failure.error).toContain("BASCIK_SHIELD_999");
    const [replayed] = runDifferentialFuzz(probe(), candidate, {
      ...options,
      path: failure.path,
    });
    expect(replayed.failed).toBe(true);
    expect(replayed.counterexample).toEqual(failure.counterexample);
  });

  it("catches cache-dependent output that changes only on a warm call", () => {
    const candidate = probe();
    let calls = 0;
    candidate.javascript = (input) =>
      ++calls % 2 ? input.javascript : `${input.javascript}changed`;
    const [result] = runDifferentialFuzz(probe(), candidate, {
      runs: 10,
      seed: 42,
      targets: ["javascript"],
    });
    expect(result.failed).toBe(true);
  });

  it("compares thrown errors instead of treating every throw as equivalent", () => {
    const baseline = probe();
    const candidate = probe();
    baseline.tags = candidate.tags = () => {
      throw new Error("same");
    };
    const options = { runs: 10, seed: 42, targets: ["tags"] as const };
    expect(runDifferentialFuzz(baseline, candidate, options)[0].failed).toBe(
      false,
    );
    candidate.tags = () => {
      throw new TypeError("different");
    };
    expect(runDifferentialFuzz(baseline, candidate, options)[0].failed).toBe(
      true,
    );
  });

  it("validates CLI options and requires one target when replaying a path", () => {
    const options = parseFuzzArguments([
      "--baseline",
      "/baseline/pkg",
      "--candidate",
      "/candidate/pkg",
      "--runs",
      "200",
      "--seed",
      "777",
      "--targets",
      "props",
      "--path",
      "0:0",
    ]);
    expect(options).toMatchObject({
      runs: 200,
      seed: 777,
      targets: ["props"],
      path: "0:0",
    });
    for (const args of [
      [],
      ["--baseline", "/b", "--runs", "0"],
      ["--baseline", "/b", "--runs", "NaN"],
      ["--baseline", "/b", "--seed", "1.5"],
      ["--baseline", "/b", "--targets", "unknown"],
      ["--baseline", "/b", "--path", "0:0"],
    ])
      expect(() => parseFuzzArguments(args)).toThrow();
  });
});
