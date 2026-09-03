/**
 * @module clock
 *
 * Internal Clock Contract & Native Adapter
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Provides a minimal, explicit abstraction over process time and timer scheduling
 * for Bascik internal runtime systems (such as request/script deadlines).
 *
 * The native adapter resolves current ambient timer functions at invocation time
 * so that test environments (e.g., Vitest fake timers) installed before consumer
 * instantiation or execution are cleanly observed without custom virtual queues.
 */

export type TimeoutHandle = ReturnType<typeof setTimeout>;
export type IntervalHandle = ReturnType<typeof setInterval>;

export interface FrameworkClock {
  /** Returns the current time in milliseconds since the Unix epoch. */
  now(): number;
  /** Schedules execution of a callback after a specified delay in milliseconds. */
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  /** Cancels a scheduled timeout. */
  clearTimeout(handle: TimeoutHandle): void;
  /** Schedules repeated execution of a callback every intervalMs milliseconds. */
  setInterval(callback: () => void, intervalMs: number): IntervalHandle;
  /** Cancels a scheduled interval. */
  clearInterval(handle: IntervalHandle): void;
}

/**
 * Frozen native implementation of FrameworkClock backed by Node.js globals.
 * Resolves global functions dynamically per call to respect fake timers in tests.
 */
export const nativeClock: FrameworkClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: TimeoutHandle) => clearTimeout(handle),
  setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
  clearInterval: (handle: IntervalHandle) => clearInterval(handle),
});
