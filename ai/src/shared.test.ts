import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedContract } from "./shared.contract.ts";
import { inProcessShared } from "./shared.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

sharedContract(
  "inProcessShared",
  (bounds) => inProcessShared(bounds),
  { describe, it, expect },
  {
    advance: (ms) => vi.advanceTimersByTimeAsync(ms).then(() => {}),
    // inProcessShared sweeps every five seconds.
    sweepMs: 5000,
  },
);

describe("inProcessShared: housekeeping", () => {
  it("sweeps what nobody used again, and stops sweeping when empty", async () => {
    const shared = inProcessShared();
    await shared.set("k", "v", 1000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(await shared.get("k")).toBeUndefined();
  });
});
