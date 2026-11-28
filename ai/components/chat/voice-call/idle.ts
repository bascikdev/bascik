/*
 * When a call nobody is speaking on ends itself. An open call holds a
 * connection, and every turn on it is billed with all that came before, so
 * a call that was forgotten is told so, and then ended. Pure: the component
 * reads the clock and draws what these functions return.
 */

/** How long nobody may speak before the reader is asked, in seconds. */
export const IDLE_SECONDS = 120;
/** How long the reader then has to answer, in seconds. */
export const IDLE_WARNING_SECONDS = 30;

/**
 * How often, at most, the provider is told that a call is in use, in
 * milliseconds: well inside the shortest time a relay waits on a quiet call.
 */
export const ALIVE_EVERY_MS = 20_000;

/** Whether it is time to tell the provider again, having last told it at `toldAt`. */
export const aliveDue = (now: number, toldAt: number): boolean =>
  now - toldAt >= ALIVE_EVERY_MS;

export interface IdleLimits {
  /** Quiet for this long, the reader is asked. 0 never asks, and never ends. */
  idleMs: number;
  /** Asked for this long, the call ends. */
  warningMs: number;
}

/** A number of seconds from an attribute, or `fallback` when it is not one. */
function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const given = Number(value);
  return Number.isFinite(given) && given >= 0 ? given : fallback;
}

/** The limits a component's `idle-seconds` and `idle-warning-seconds` props set. */
export const idleLimits = (dataset: {
  idleSeconds?: string;
  idleWarningSeconds?: string;
}): IdleLimits => ({
  idleMs: seconds(dataset.idleSeconds, IDLE_SECONDS) * 1000,
  warningMs: seconds(dataset.idleWarningSeconds, IDLE_WARNING_SECONDS) * 1000,
});

/**
 * Where a call is, `now`, when something last happened on it at `activeAt`
 * (both in milliseconds on one clock): going on, asking the reader, or over.
 */
export function idlePhase(
  now: number,
  activeAt: number,
  limits: IdleLimits,
): "active" | "warning" | "over" {
  if (limits.idleMs <= 0) return "active";
  const quiet = now - activeAt;
  if (quiet < limits.idleMs) return "active";
  return quiet < limits.idleMs + limits.warningMs ? "warning" : "over";
}
