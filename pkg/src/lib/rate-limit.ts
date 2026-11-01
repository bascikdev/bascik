import { isIPv6 } from "node:net";
import {
  nativeClock,
  type FrameworkClock,
  type IntervalHandle,
} from "./clock.ts";

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
  trustProxy: boolean,
): string => {
  if (!trustProxy) {
    return socketRemoteAddress;
  }
  const xForwardedFor = headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string") {
    const parts = xForwardedFor
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    const lastItem = xForwardedFor[xForwardedFor.length - 1];
    const parts = lastItem
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }
  return socketRemoteAddress;
};

/**
 * The identity a request is counted under. IPv4 addresses count one by one.
 * An IPv6 address counts by its /64 prefix: one host or LAN is routinely
 * handed a whole /64, so counting each address separately would let a
 * single sender rotate through its own prefix, dodge its limit, and churn the
 * tracking table (evicting other clients' counters). An IPv4-mapped IPv6
 * address (`::ffff:192.0.2.7`, what a dual-stack socket reports) counts as
 * its IPv4 address. Anything that is not an IP address is used as is.
 */
export const rateLimitKey = (ip: string): string => {
  if (!isIPv6(ip)) return ip;
  const address = ip.split("%")[0].toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1];
  const [head, tail] = address.includes("::")
    ? address.split("::")
    : [address, undefined];
  const hextets = (part: string | undefined): string[] =>
    part
      ? part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [group];
          // An embedded IPv4 tail (`64:ff9b::192.0.2.1`) is two hextets.
          const [a, b, c, d] = group.split(".").map(Number);
          return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
        })
      : [];
  const front = hextets(head);
  const back = hextets(tail);
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":")}::/64`;
};

interface IpBucketEntry {
  buckets: number[];
  bucketStartTime: number;
}

export interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  /** Identities tracked at once; a full table evicts the least recently seen. */
  maxTrackedIps?: number;
  clock?: FrameworkClock;
  /**
   * Receives the table-pressure line, at most once per window. Omitted: the
   * limiter evicts silently.
   */
  warn?: (message: string) => void;
}

export class RateLimiter {
  /** The sliding window, so a 429 can name how long to wait. */
  public readonly windowMs: number;
  private max: number;
  private maxTrackedIps: number;
  private bucketDurationMs: number;
  /**
   * Identity to counters, in least-recently-seen-first order: every request
   * deletes and reinserts its identity, so the first key is the eviction
   * candidate.
   */
  private trackedIps = new Map<string, IpBucketEntry>();
  private sweepTimer: IntervalHandle | null = null;
  private clock: FrameworkClock;
  private warn: ((message: string) => void) | undefined;
  private lastPressureWarningAt: number | null = null;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.max = options.max ?? DEFAULT_RATE_LIMIT_MAX;
    // A typo'd or nonsensical cap still tracks one identity (config
    // validation rejects it before a server starts; this guards direct use).
    this.maxTrackedIps = Math.max(
      1,
      Math.floor(options.maxTrackedIps ?? MAX_TRACKED_IPS) || 1,
    );
    this.bucketDurationMs = Math.max(
      1,
      Math.floor(this.windowMs / SUB_BUCKETS),
    );
    this.clock = options.clock ?? nativeClock;
    this.warn = options.warn;
  }

  /** How many identities the table holds right now. */
  public get trackedCount(): number {
    return this.trackedIps.size;
  }

  public isRateLimited(ip: string, now: number = this.clock.now()): boolean {
    const key = rateLimitKey(ip);
    let entry = this.trackedIps.get(key);
    if (entry) {
      // Touch: move the identity to the most-recently-seen end.
      this.trackedIps.delete(key);
      this.trackedIps.set(key, entry);
    } else {
      if (this.trackedIps.size >= this.maxTrackedIps) this.makeRoom(now);
      entry = {
        buckets: new Array(SUB_BUCKETS).fill(0),
        bucketStartTime: now,
      };
      this.trackedIps.set(key, entry);
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

  /**
   * Free one slot for a newcomer. Expired identities at the old end go
   * first; if the table is still full, the least recently seen live identity
   * is evicted. A full table never refuses a request (the bounded-zone
   * practice of nginx `limit_req` and CDNs): a flood of fresh addresses can
   * reset other clients' counters but cannot lock them out. The work is
   * amortized O(1), so a flood does not turn each newcomer into a full scan.
   */
  private makeRoom(now: number): void {
    for (const [oldestKey, oldest] of this.trackedIps) {
      if (now - oldest.bucketStartTime < this.windowMs) break;
      this.trackedIps.delete(oldestKey);
    }
    if (this.trackedIps.size < this.maxTrackedIps) return;
    const lruKey = this.trackedIps.keys().next().value;
    if (lruKey !== undefined) this.trackedIps.delete(lruKey);
    if (
      this.warn &&
      (this.lastPressureWarningAt === null ||
        now - this.lastPressureWarningAt >= this.windowMs ||
        now < this.lastPressureWarningAt)
    ) {
      this.lastPressureWarningAt = now;
      this.warn(
        `[bascik] rate limiter table full: ${this.maxTrackedIps} identities, evicting the least recently seen; raise http.rateLimit.maxTrackedIps or rate limit at the CDN`,
      );
    }
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
    this.lastPressureWarningAt = null;
  }

  public destroy(): void {
    if (this.sweepTimer) {
      this.clock.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.clear();
  }
}
