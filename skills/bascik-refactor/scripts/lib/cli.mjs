// Shared CLI helpers for the bascik-refactor scripts. Dependency-free; Node.js 22.22+.
// Each skill ships as its own archive, so these are copies, not imports from the bascik skill.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `metaUrl` is the script Node was asked to run. Both sides are compared as real paths:
 * Node resolves symlinks in the main module's path before setting import.meta.url, so comparing it with argv[1] as
 * typed made the script a silent no-op (exit 0, no output) whenever a folder on the path was a symlink or junction.
 */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}

/** Prints `message` to stderr and exits with `code`. */
export function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** A positive finite number from a flag value, or an error naming the flag. */
export function positiveNumber(flag, value) {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n) || n <= 0)
    throw new Error(`${flag} must be a positive number (got "${value}")`);
  return n;
}
