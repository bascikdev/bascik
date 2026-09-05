import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RateLimiter,
  getClientIp,
} from "./rate-limit.ts";
import { nativeClock } from "./clock.ts";

describe("getClientIp", () => {
  it("off by default: ignores X-Forwarded-For and uses socket remote address", () => {
    const headers = { "x-forwarded-for": "203.0.113.195, 70.41.3.18" };
    const ip = getClientIp("192.168.1.1", headers, false);
    expect(ip).toBe("192.168.1.1");
  });

  it("off by default: spoofed X-Forwarded-For cannot change the client IP", () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };
    const ip = getClientIp("10.0.0.1", headers, false);
    expect(ip).toBe("10.0.0.1");
  });

  it("on: derives the client IP from the rightmost (last) entry of X-Forwarded-For", () => {
    const headers = { "x-forwarded-for": "203.0.113.195, 70.41.3.18, 198.51.100.1" };
    const ip = getClientIp("127.0.0.1", headers, true);
    expect(ip).toBe("198.51.100.1");
  });

  it("on: handles array-valued X-Forwarded-For headers", () => {
    const headers = { "x-forwarded-for": ["203.0.113.195", "70.41.3.18"] };
    const ip = getClientIp("127.0.0.1", headers, true);
    expect(ip).toBe("70.41.3.18");
  });

  it("on: falls back to socket address if X-Forwarded-For is missing or empty", () => {
    expect(getClientIp("127.0.0.1", {}, true)).toBe("127.0.0.1");
    expect(getClientIp("127.0.0.1", { "x-forwarded-for": "   " }, true)).toBe("127.0.0.1");
  });
});

describe("RateLimiter sliding window", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ windowMs: 10_000, max: 10 });
  });

  afterEach(() => {
    limiter.destroy();
  });

  it("allows requests below the maximum count", () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.isRateLimited("1.1.1.1", 1000 + i * 100)).toBe(false);
    }
  });

  it("rejects requests exceeding the maximum count", () => {
    for (let i = 0; i < 10; i++) {
      limiter.isRateLimited("1.1.1.1", 1000);
    }
    expect(limiter.isRateLimited("1.1.1.1", 1000)).toBe(true);
  });

  it("sliding window: boundary bursts straddling sub-windows are smoothed", () => {
    // 10 requests allowed per 10s. Sub-windows = 10 (1s each).
    // Send 8 requests at t = 9.5s (in bucket 9).
    for (let i = 0; i < 8; i++) {
      expect(limiter.isRateLimited("2.2.2.2", 9500)).toBe(false);
    }
    // At t = 10.5s (in bucket 0 of next cycle, but within 10s window of previous bucket),
    // sending 8 more requests should exceed the 10 limit (8 old weight + new requests > 10).
    // With a fixed window at 10s, all 8 would pass. With sliding window, it trips!
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      if (limiter.isRateLimited("2.2.2.2", 10500)) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
  });

  it("recovers after the window has completely passed", () => {
    for (let i = 0; i < 10; i++) {
      limiter.isRateLimited("3.3.3.3", 1000);
    }
    expect(limiter.isRateLimited("3.3.3.3", 1000)).toBe(true);
    // After 11s (past 10s window):
    expect(limiter.isRateLimited("3.3.3.3", 12000)).toBe(false);
  });

  it("config object form honors custom window and max", () => {
    const custom = new RateLimiter({ windowMs: 2000, max: 3 });
    expect(custom.isRateLimited("4.4.4.4", 1000)).toBe(false);
    expect(custom.isRateLimited("4.4.4.4", 1000)).toBe(false);
    expect(custom.isRateLimited("4.4.4.4", 1000)).toBe(false);
    expect(custom.isRateLimited("4.4.4.4", 1000)).toBe(true);
    // Recovers after 2s
    expect(custom.isRateLimited("4.4.4.4", 3100)).toBe(false);
    custom.destroy();
  });

  it("tracking structure is bounded and fails closed (rejects) when capacity is reached", () => {
    const smallLimiter = new RateLimiter({ windowMs: 10_000, max: 5, maxTrackedIps: 3 });
    // Add 3 distinct IPs at t = 1000
    smallLimiter.isRateLimited("10.0.0.1", 1000);
    smallLimiter.isRateLimited("10.0.0.2", 1000);
    smallLimiter.isRateLimited("10.0.0.3", 1000);

    // 4th IP exceeds bound while all 3 are active -> fails closed (true = rate limited / blocked)
    expect(smallLimiter.isRateLimited("10.0.0.4", 1000)).toBe(true);
    smallLimiter.destroy();
  });

  it("reclaims expired entries under capacity pressure without requiring manual sweep", () => {
    const smallLimiter = new RateLimiter({ windowMs: 100, max: 5, maxTrackedIps: 2 });
    expect(smallLimiter.isRateLimited("a", 0)).toBe(false);
    expect(smallLimiter.isRateLimited("b", 0)).toBe(false);

    // At t = 10000 (well past 100ms windowMs), previous entries are expired.
    // A new identity 'c' arrives: capacity pressure triggers automatic expiry reclamation.
    expect(smallLimiter.isRateLimited("c", 10000)).toBe(false);
    expect(smallLimiter.isRateLimited("d", 10000)).toBe(false);
    // Now 'c' and 'd' are active; 3rd identity 'e' at t = 10000 should fail closed.
    expect(smallLimiter.isRateLimited("e", 10000)).toBe(true);
    smallLimiter.destroy();
  });

  it("does not discard active entries prematurely during capacity pressure", () => {
    const smallLimiter = new RateLimiter({ windowMs: 1000, max: 5, maxTrackedIps: 2 });
    smallLimiter.isRateLimited("a", 100);
    smallLimiter.isRateLimited("b", 500);

    // At t = 600, 'a' (age 500) and 'b' (age 100) are both active (< 1000ms).
    // Capacity is full of live entries -> new identity 'c' fails closed.
    expect(smallLimiter.isRateLimited("c", 600)).toBe(true);

    // At t = 1200, 'a' (started at 100, age 1100) has expired (> 1000ms), but 'b' (started at 500, age 700) is still active.
    // 'c' should be admitted by reclaiming 'a'.
    expect(smallLimiter.isRateLimited("c", 1200)).toBe(false);
    // 'b' is still tracked and active
    expect(smallLimiter.isRateLimited("b", 1200)).toBe(false);
    smallLimiter.destroy();
  });

  it("sweep does not run during build (no auto timer if not started or when destroyed)", () => {
    const cleanLimiter = new RateLimiter({ windowMs: 10_000, max: 5 });
    expect(cleanLimiter.isTimerActive()).toBe(false);
    cleanLimiter.startSweep();
    expect(cleanLimiter.isTimerActive()).toBe(true);
    cleanLimiter.destroy();
    expect(cleanLimiter.isTimerActive()).toBe(false);
  });
});

describe("RateLimiter - deterministic clock-driven bucket and sweep boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no hidden interval exists unless startSweep() is explicitly called", () => {
    const limiter = new RateLimiter({ windowMs: 10_000, max: 5 });
    expect(vi.getTimerCount()).toBe(0);
    limiter.destroy();
  });

  it("admission and sweep use the same injected clock consistently", () => {
    const limiter = new RateLimiter({ windowMs: 10_000, max: 3 });
    for (let i = 0; i < 3; i++) {
      expect(limiter.isRateLimited("5.5.5.5", nativeClock.now())).toBe(false);
    }
    expect(limiter.isRateLimited("5.5.5.5", nativeClock.now())).toBe(true);

    // Advance the injected clock past the window; sweep() defaults to the
    // same clock the admission calls used.
    vi.advanceTimersByTime(10_001);
    limiter.sweep(nativeClock.now());
    expect(limiter.isRateLimited("5.5.5.5", nativeClock.now())).toBe(false);
    limiter.destroy();
  });

  it("startSweep() drives a real interval that removes stale entries at the window boundary", () => {
    const limiter = new RateLimiter({ windowMs: 10_000, max: 5, clock: nativeClock });
    limiter.isRateLimited("6.6.6.6", nativeClock.now());
    limiter.startSweep();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(10_000);
    // The sweep interval fired using the same injected clock; the bucket for
    // 6.6.6.6 is exactly windowMs old and is pruned.
    expect(limiter.isRateLimited("6.6.6.6", nativeClock.now())).toBe(false);

    limiter.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clear()/destroy() removes tracked state and cancels an active sweep", () => {
    const limiter = new RateLimiter({ windowMs: 10_000, max: 5, clock: nativeClock });
    limiter.isRateLimited("7.7.7.7", nativeClock.now());
    limiter.startSweep();
    expect(vi.getTimerCount()).toBe(1);

    limiter.destroy();
    expect(vi.getTimerCount()).toBe(0);
    // A fresh entry after destroy proves internal tracking was cleared, not
    // merely that the timer stopped.
    expect(limiter.isRateLimited("7.7.7.7", nativeClock.now())).toBe(false);
  });
});
