/**
 * What an upload is allowed to be: the accepted types, the size and count
 * limits with their defaults, and how an app's own limits are resolved.
 */
import type { ResolvedFileLimits } from "./types.ts";

/** The types accepted unless an app chooses fewer. */
export const DEFAULT_FILE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
];

export interface FileLimits {
  /** The largest one file may be, in bytes. Default 5 MB. */
  maxFileBytes?: number;
  /** The most files one message may carry. Default 4. */
  maxFiles?: number;
  /** The most all of one message's files may add up to, in bytes. Default 10 MB. */
  maxTotalBytes?: number;
  /**
   * The most bytes of files one model request may carry, counted from the
   * newest file back; older files are named to the model instead. The
   * newest message's files are always sent, so this cannot be below
   * `maxTotalBytes`. `Infinity` means no cap. Default 20 MB, or
   * `maxTotalBytes` when that is larger.
   */
  maxAttachedBytes?: number;
  /**
   * The media types accepted: a subset of `DEFAULT_FILE_TYPES`. A type that
   * is not one of those cannot be added, because the library only knows how
   * to check these; in particular SVG and HTML are never accepted.
   */
  types?: readonly string[];
}

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 4;
export const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHED_BYTES = 20 * 1024 * 1024;

/**
 * The limits with their defaults filled in. A `maxAttachedBytes` the app
 * sets must be a positive whole number of bytes, or `Infinity` for no cap,
 * and not below `maxTotalBytes` (so a message the app accepted could always
 * be sent to the model); a mistake throws when the app starts. Left unset,
 * it is 20 MB or `maxTotalBytes` when that is larger, whatever
 * `maxTotalBytes` is, so lifting the per-message cap never throws.
 */
export function resolveLimits(limits: FileLimits = {}): ResolvedFileLimits {
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const set = limits.maxAttachedBytes;
  let maxAttachedBytes: number;
  if (set === undefined) {
    // `>` rather than Math.max, so a total that is not a number keeps the
    // default instead of making the cap NaN.
    maxAttachedBytes =
      maxTotalBytes > DEFAULT_MAX_ATTACHED_BYTES
        ? maxTotalBytes
        : DEFAULT_MAX_ATTACHED_BYTES;
  } else {
    if (!(set === Infinity || (Number.isInteger(set) && set > 0))) {
      throw new RangeError(
        `fileLimits.maxAttachedBytes must be a positive whole number of bytes, or Infinity for no cap, not ${set}.`,
      );
    }
    if (set < maxTotalBytes) {
      throw new RangeError(
        `fileLimits.maxAttachedBytes (${set}) cannot be below fileLimits.maxTotalBytes (${maxTotalBytes}): the newest message's files are always sent.`,
      );
    }
    maxAttachedBytes = set;
  }
  return {
    maxFileBytes: limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxFiles: limits.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes,
    maxAttachedBytes,
    types: (limits.types ?? DEFAULT_FILE_TYPES).filter((type) =>
      DEFAULT_FILE_TYPES.includes(type),
    ),
  };
}
