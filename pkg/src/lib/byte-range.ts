/**
 * Single byte ranges for static files (RFC 9110 section 14).
 *
 * The static branch of the server answers `Range: bytes=…` with 206 and the
 * requested slice, so audio and video can seek and Safari, which needs byte
 * ranges for media, plays them (audit 159 finding 34). Only one range is
 * honored: a multi-range request, a malformed one, or another unit is
 * ignored, which RFC 9110 allows, and the client gets the whole file with 200.
 */

export type ByteRange = { start: number; end: number };

const SINGLE_RANGE = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;

/**
 * The inclusive byte range a `Range` header asks for in a file of `size`
 * bytes; `"unsatisfiable"` when it starts past the end (answer 416), and
 * `undefined` when the header is absent or not a single byte range (ignore it
 * and send the whole file).
 */
export const parseByteRange = (
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined => {
  if (!header) return undefined;
  const match = SINGLE_RANGE.exec(header);
  if (!match) return undefined;
  const [, first, last] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    // A suffix range: the last `last` bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { start, end };
};

/** `Content-Range` for a 206 answer. */
export const contentRange = ({ start, end }: ByteRange, size: number): string =>
  `bytes ${start}-${end}/${size}`;

/** `Content-Range` for a 416 answer. */
export const unsatisfiedContentRange = (size: number): string =>
  `bytes */${size}`;

/**
 * True when a `Range` should be honored given its `If-Range`: absent, or the
 * strong validator the response would carry. A weak validator never matches
 * (RFC 9110 section 13.1.5), so the client gets the whole, current file.
 */
export const ifRangeAllows = (
  ifRange: string | undefined,
  etag: string | undefined,
): boolean => {
  if (ifRange === undefined) return true;
  if (!etag || etag.startsWith("W/")) return false;
  return ifRange.trim() === etag;
};
