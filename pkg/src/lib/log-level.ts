/**
 * @module log-level
 *
 * The log levels and the one rule for comparing them. It imports nothing, so the CLI parser, the config validator,
 * and the config module can all use the same list without importing each other.
 */

export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The level `--quiet` selects: warnings and errors, none of the routine progress lines. */
export const QUIET_LOG_LEVEL: LogLevel = "warn";

export const shouldLog = (
  configuredLevel: LogLevel | undefined,
  eventLevel: LogLevel = "info",
  defaultLevel: LogLevel = "info",
): boolean => {
  const resolvedLevel = configuredLevel ?? defaultLevel;
  return LOG_LEVELS.indexOf(resolvedLevel) >= LOG_LEVELS.indexOf(eventLevel);
};
