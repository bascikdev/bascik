/**
 * @module slashes
 *
 * Linear-time slash trimming. The anchored regex `/\/+$/` looks equivalent but
 * V8 retries a slash run from every start position, so a long run that does
 * not end the string costs time proportional to the square of its length.
 * Host-neutral: no `node:` imports, safe for the serverless core.
 */

const SLASH = 47; // "/"

/** `value` without any trailing "/" characters. */
export const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH) end--;
  return end === value.length ? value : value.slice(0, end);
};

/** `value` without any leading or trailing "/" characters. */
export const trimSlashes = (value: string): string => {
  const trimmed = trimTrailingSlashes(value);
  let start = 0;
  while (start < trimmed.length && trimmed.charCodeAt(start) === SLASH) start++;
  return start === 0 ? trimmed : trimmed.slice(start);
};
