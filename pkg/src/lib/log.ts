import { BascikConfig } from "./config.ts";
import { shouldLog } from "./log-level.ts";

/**
 * Prints a routine progress line (a script started, a file generated) unless the configured level hides `info`.
 * `--quiet` and `--log-level warn` hide these. The lines that say the work is done and where the server is,
 * such as `Server running at` and `✓ N pages transpiled`, are not routed through here and always print.
 */
export const logInfo = (...args: unknown[]): void => {
  if (shouldLog(BascikConfig.logging?.level, "info")) console.log(...args);
};
