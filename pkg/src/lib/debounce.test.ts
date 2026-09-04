import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "./debounce.ts";
import { type FrameworkClock } from "./clock.ts";

describe("debounce helper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("delays execution until delayMs has elapsed", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("a");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(49);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("coalesces rapid invocations and uses the latest arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("first");
    vi.advanceTimersByTime(30);
    debounced("second");
    vi.advanceTimersByTime(30);
    debounced("third");

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });

  it("supports cancellation via cancel()", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("test");
    debounced.cancel();

    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calling cancel() multiple times is harmless", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("test");
    debounced.cancel();
    expect(() => debounced.cancel()).not.toThrow();

    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("can be invoked again after cancel()", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("first");
    debounced.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();

    debounced("second");
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("supports flush() to immediately invoke scheduled callback with latest arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("immediate");
    expect(fn).not.toHaveBeenCalled();

    debounced.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("immediate");

    // Advancing time should not fire again
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush() does nothing if no call was scheduled", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts an injected FrameworkClock", () => {
    let clockTime = 0;
    const timeouts = new Map<number, { cb: () => void; time: number }>();
    let nextId = 1;

    const customClock: FrameworkClock = {
      now: () => clockTime,
      setTimeout: (cb, delay) => {
        const id = nextId++;
        timeouts.set(id, { cb, time: clockTime + delay });
        return id as any;
      },
      clearTimeout: (handle) => {
        timeouts.delete(handle as any);
      },
      setInterval: () => 0 as any,
      clearInterval: () => { },
    };

    const fn = vi.fn();
    const debounced = debounce(fn, 50, { clock: customClock });

    debounced("custom");
    expect(fn).not.toHaveBeenCalled();
    expect(timeouts.size).toBe(1);

    // Cancel removes from custom clock
    debounced.cancel();
    expect(timeouts.size).toBe(0);
  });
});