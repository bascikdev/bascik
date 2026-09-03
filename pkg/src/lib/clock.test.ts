import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nativeClock, type FrameworkClock, type TimeoutHandle, type IntervalHandle } from "./clock.ts";

describe("FrameworkClock & nativeClock adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("satisfies FrameworkClock interface contract and is frozen", () => {
    const clock: FrameworkClock = nativeClock;
    expect(Object.isFrozen(clock)).toBe(true);
    expect(typeof clock.now).toBe("function");
    expect(typeof clock.setTimeout).toBe("function");
    expect(typeof clock.clearTimeout).toBe("function");
    expect(typeof clock.setInterval).toBe("function");
    expect(typeof clock.clearInterval).toBe("function");
  });

  it("returns current timestamp via now() using current globals", () => {
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    expect(nativeClock.now()).toBe(new Date("2026-09-03T12:00:00.000Z").getTime());

    vi.advanceTimersByTime(5000);
    expect(nativeClock.now()).toBe(new Date("2026-09-03T12:00:05.000Z").getTime());
  });

  it("schedules and executes setTimeout callbacks via current globals", () => {
    let fired = false;
    const handle: TimeoutHandle = nativeClock.setTimeout(() => {
      fired = true;
    }, 1000);
    expect(handle).toBeDefined();

    expect(fired).toBe(false);
    vi.advanceTimersByTime(999);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(true);
  });

  it("cancels pending timeouts via clearTimeout", () => {
    let fired = false;
    const handle: TimeoutHandle = nativeClock.setTimeout(() => {
      fired = true;
    }, 1000);

    nativeClock.clearTimeout(handle);
    vi.advanceTimersByTime(2000);
    expect(fired).toBe(false);
  });

  it("schedules and repeats setInterval callbacks", () => {
    let count = 0;
    const handle: IntervalHandle = nativeClock.setInterval(() => {
      count++;
    }, 500);

    expect(count).toBe(0);
    vi.advanceTimersByTime(500);
    expect(count).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(count).toBe(3);

    nativeClock.clearInterval(handle);
    vi.advanceTimersByTime(1000);
    expect(count).toBe(3);
  });
});
