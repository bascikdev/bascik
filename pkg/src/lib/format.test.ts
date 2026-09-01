import { describe, it, expect } from "vitest";
import { formatDuration } from "./format.ts";

describe("formatDuration", () => {
  it("formats zero and negative durations as 0ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(-10)).toBe("0ms");
  });

  it("formats sub-millisecond durations with up to 2 decimals without trailing zeros", () => {
    expect(formatDuration(0.4)).toBe("0.4ms");
    expect(formatDuration(0.40)).toBe("0.4ms");
    expect(formatDuration(0.09)).toBe("0.09ms");
    expect(formatDuration(0.42)).toBe("0.42ms");
    expect(formatDuration(0.456)).toBe("0.46ms");
  });

  it("formats very small sub-millisecond durations gracefully", () => {
    expect(formatDuration(0.004)).toBe("<0.01ms");
    expect(formatDuration(0.001)).toBe("<0.01ms");
    expect(formatDuration(0.009)).toBe("0.01ms");
  });

  it("formats 1-10ms durations with up to 1 decimal", () => {
    expect(formatDuration(1.0)).toBe("1ms");
    expect(formatDuration(1.23)).toBe("1.2ms");
    expect(formatDuration(4.56)).toBe("4.6ms");
    expect(formatDuration(9.94)).toBe("9.9ms");
  });

  it("formats 10-1000ms durations as rounded whole milliseconds", () => {
    expect(formatDuration(10.0)).toBe("10ms");
    expect(formatDuration(12.3)).toBe("12ms");
    expect(formatDuration(150.8)).toBe("151ms");
    expect(formatDuration(999.4)).toBe("999ms");
  });

  it("formats durations >= 1000ms in seconds", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(1250)).toBe("1.25s");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(12345)).toBe("12.35s");
  });
});
