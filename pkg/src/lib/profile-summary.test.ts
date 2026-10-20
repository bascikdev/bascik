import { describe, expect, it } from "vitest";
import { summarizeCpuProfile } from "../../bench/profile-summary.ts";

const frame = (
  functionName: string,
  url = "file:///pkg/a.js",
  lineNumber = 0,
) => ({ functionName, url, lineNumber, columnNumber: 0 });

const profile = () => ({
  nodes: [
    { id: 1, callFrame: frame("(root)", ""), children: [2] },
    {
      id: 2,
      callFrame: frame("expand"),
      children: [3],
      positionTicks: [{ line: 8, ticks: 2 }],
    },
    {
      id: 3,
      callFrame: frame("scan"),
      positionTicks: [{ line: 12, ticks: 3 }],
    },
  ],
  samples: [2, 3, 3],
  timeDeltas: [1000, 2000, 3000],
});

describe("CPU profile summary", () => {
  it("calculates self and inclusive sampled time and keeps hot source lines", () => {
    const summary = summarizeCpuProfile(profile());
    expect(summary.totalMs).toBe(6);
    expect(
      summary.functions.find(({ name }) => name === "expand"),
    ).toMatchObject({
      selfMs: 1,
      inclusiveMs: 6,
      lines: [{ line: 8, ticks: 2 }],
    });
    expect(summary.functions.find(({ name }) => name === "scan")).toMatchObject(
      {
        selfMs: 5,
        inclusiveMs: 5,
        lines: [{ line: 12, ticks: 3 }],
      },
    );
  });

  it("counts recursive function frames once per inclusive sample", () => {
    const input = profile();
    input.nodes[2].callFrame = frame("expand");
    const summary = summarizeCpuProfile(input);
    expect(
      summary.functions.find(({ name }) => name === "expand"),
    ).toMatchObject({
      selfMs: 6,
      inclusiveMs: 6,
    });
  });

  it("does not merge functions in different directories or at different source columns", () => {
    const input = profile();
    input.nodes[2].callFrame = frame("expand", "file:///other/a.js");
    expect(
      summarizeCpuProfile(input).functions.filter(
        ({ name }) => name === "expand",
      ),
    ).toHaveLength(2);
    input.nodes[2].callFrame = { ...frame("expand"), columnNumber: 20 };
    expect(
      summarizeCpuProfile(input).functions.filter(
        ({ name }) => name === "expand",
      ),
    ).toHaveLength(2);
  });

  it("clamps negative sampler deltas and handles empty samples", () => {
    const input = profile();
    input.timeDeltas = [-1, 0, 2000];
    expect(summarizeCpuProfile(input).totalMs).toBe(2);
    input.samples = [];
    input.timeDeltas = [];
    expect(summarizeCpuProfile(input).totalMs).toBe(0);
  });

  it("rejects missing nodes, mismatched arrays, duplicate IDs, and cyclic parent graphs", () => {
    const unknownSample = profile();
    unknownSample.samples[0] = 99;
    const mismatch = profile();
    mismatch.timeDeltas.pop();
    const duplicate = profile();
    duplicate.nodes[2].id = 2;
    const cycle = profile();
    cycle.nodes[2].children = [1];
    for (const input of [null, {}, unknownSample, mismatch, duplicate, cycle])
      expect(() => summarizeCpuProfile(input)).toThrow();
  });
});
