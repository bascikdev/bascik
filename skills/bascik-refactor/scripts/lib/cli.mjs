// Shared CLI helpers for the bascik-refactor scripts. Dependency-free; Node.js 22.18+.
// Each skill ships as its own archive, so these are copies, not imports from the bascik skill.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** True when the module at `metaUrl` is the script Node was asked to run. */
export function isMain(metaUrl) {
  return (
    Boolean(process.argv[1]) &&
    pathToFileURL(resolve(process.argv[1])).href === metaUrl
  );
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
