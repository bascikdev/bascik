import { nativeClock, type FrameworkClock, type IntervalHandle } from "./clock.ts";

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 10_000;
export const DEFAULT_RATE_LIMIT_MAX = 500;
export const MAX_TRACKED_IPS = 10_000;
const SUB_BUCKETS = 10;

/**
 * Derive the client IP address.
 * When `trustProxy` is false, X-Forwarded-For is strictly ignored to prevent spoofing.
 * When `trustProxy` is true, takes the rightmost (last) entry of X-Forwarded-For
 * representing the address added by the immediate reverse proxy/load balancer.
 */
export const getClientIp = (
  socketRemoteAddress: string,
  headers: Record<string, string | string[] | undefined>,
  trustProxy: boolean
): string => {
  if (!trustProxy) {
    return socketRemoteAddress;
  }
  const xForwardedFor = headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string") {
    const parts = xForwardedFor.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    const lastItem = xForwardedFor[xForwardedFor.length - 1];
    const parts = lastItem.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }
  return socketRemoteAddress;
};

interface IpBucketEntry {
  buckets: number[];
  bucketStartTime: number;
}

export interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  maxTrackedIps?: number;
  clock?: FrameworkClock;
}

export class RateLimiter {
  private windowMs: number;
  private max: number;
  private maxTrackedIps: number;
  private bucketDurationMs: number;
  private trackedIps = new Map<string, IpBucketEntry>();
  private sweepTimer: IntervalHandle | null = null;
  private clock: FrameworkClock;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.max = options.max ?? DEFAULT_RATE_LIMIT_MAX;
    this.maxTrackedIps = options.maxTrackedIps ?? MAX_TRACKED_IPS;
    this.bucketDurationMs = Math.max(1, Math.floor(this.windowMs / SUB_BUCKETS));
    this.clock = options.clock ?? nativeClock;
  }

  public isRateLimited(ip: string, now: number = this.clock.now()): boolean {
    let entry = this.trackedIps.get(ip);
    if (!entry) {
      if (this.trackedIps.size >= this.maxTrackedIps) {
        // Attempt to reclaim expired entries before rejecting
        this.sweep(now);
      }
      if (this.trackedIps.size >= this.maxTrackedIps) {
        // Bound reached: fail closed when capacity is genuinely occupied by live identities
        return true;
      }
      entry = {
        buckets: new Array(SUB_BUCKETS).fill(0),
        bucketStartTime: now,
      };
      this.trackedIps.set(ip, entry);
    }

    // Advance sliding window buckets
    const elapsed = now - entry.bucketStartTime;
    const bucketsToAdvance = Math.floor(elapsed / this.bucketDurationMs);

    if (bucketsToAdvance >= SUB_BUCKETS) {
      // Entire window passed
      entry.buckets.fill(0);
      entry.bucketStartTime = now;
    } else if (bucketsToAdvance > 0) {
      // Shift out old sub-buckets
      for (let i = 0; i < bucketsToAdvance; i++) {
        entry.buckets.shift();
        entry.buckets.push(0);
      }
      entry.bucketStartTime += bucketsToAdvance * this.bucketDurationMs;
    }

    // Current bucket is the newest (last) bucket
    entry.buckets[SUB_BUCKETS - 1]++;

    // Calculate total count over sliding sub-windows
    const totalCount = entry.buckets.reduce((sum, count) => sum + count, 0);
    return totalCount > this.max;
  }

  public startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = this.clock.setInterval(() => {
      this.sweep();
    }, this.windowMs);
    if (typeof (this.sweepTimer as any)?.unref === "function") {
      (this.sweepTimer as any).unref();
    }
  }

  public sweep(now: number = this.clock.now()): void {
    for (const [ip, entry] of this.trackedIps.entries()) {
      const elapsed = now - entry.bucketStartTime;
      if (elapsed >= this.windowMs) {
        this.trackedIps.delete(ip);
      }
    }
  }

  public isTimerActive(): boolean {
    return this.sweepTimer !== null;
  }

  public clear(): void {
    this.trackedIps.clear();
  }

  public destroy(): void {
    if (this.sweepTimer) {
      this.clock.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.clear();
  }
}
