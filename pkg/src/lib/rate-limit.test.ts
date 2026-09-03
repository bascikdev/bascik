import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RateLimiter,
  getClientIp,
} from "./rate-limit.ts";

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
    // Add 3 distinct IPs
    smallLimiter.isRateLimited("10.0.0.1", 1000);
    smallLimiter.isRateLimited("10.0.0.2", 1000);
    smallLimiter.isRateLimited("10.0.0.3", 1000);

    // 4th IP exceeds bound -> fails closed (true = rate limited / blocked)
    expect(smallLimiter.isRateLimited("10.0.0.4", 1000)).toBe(true);
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
