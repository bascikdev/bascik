/**
 * What a file is, decided by its bytes: binary signatures, strict UTF-8
 * text, and the refusal of anything that claims or looks like markup.
 */
import { DEFAULT_FILE_TYPES } from "./limits.ts";
import { cleanName } from "./names.ts";

const startsWith = (bytes: Uint8Array, signature: number[], at = 0): boolean =>
  bytes.length >= at + signature.length &&
  signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

/** The binary type the leading bytes say a file is, or null. */
export function sniffBinary(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, ascii("GIF87a")) ||
    startsWith(bytes, ascii("GIF89a"))
  ) {
    return "image/gif";
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  return null;
}

// Tab, line feed and carriage return are text; the other controls are not.
// eslint-disable-next-line no-control-regex
const BINARY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MARKUP_START =
  /^\s*(?:<\?xml|<!doctype|<html|<svg|<script|<head|<body|<iframe|<!--)/i;

/**
 * The text of a file, when it is text: valid UTF-8 with no control
 * characters besides tab, line feed and carriage return. A file with a NUL
 * byte, or any binary format, is not.
 */
export function strictText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    // ignoreBOM is spelled out (false is the default): Cloudflare's Workers
    // types require it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  return BINARY_CONTROL.test(text) ? null : text;
}

const MARKUP_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
]);
const MARKUP_NAME = /\.(?:html?|xhtml|svg|svgz|xml)$/i;
const BINARY_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export const mediaTypeOf = (claimed: string): string =>
  claimed.toLowerCase().split(";")[0]!.trim();

/**
 * A name as the extension check reads it: without invisible and control
 * characters, and without the trailing dots and spaces that Windows drops
 * when it saves a file. Otherwise `report.html` followed by a zero-width
 * space passes the check and is then stored as `report.html` by `cleanName`.
 * Combining marks and the Hangul fillers draw nothing either. The stored
 * name is given its checked type's extension anyway (`storedName`); this
 * keeps the refusal saying what the reader tried.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0]/gu;
const bareName = (name: string): string =>
  name.replace(INVISIBLE, "").replace(/[\s.]+$/u, "");

/**
 * True when the file says it is HTML, SVG or XML, by its type or its name.
 * The name is checked both as sent and as it will be stored (`cleanName`
 * also shortens it, which can leave a new extension at the end).
 */
export const claimsMarkup = (claimedType: string, name: string): boolean =>
  MARKUP_TYPES.has(mediaTypeOf(claimedType)) ||
  MARKUP_NAME.test(bareName(name)) ||
  MARKUP_NAME.test(bareName(cleanName(name)));

export type Sniffed =
  { mediaType: string } | { refused: "type" | "markup" | "mismatch" | "empty" };

/**
 * What a file is, decided by its bytes. A file's own claim (the type the
 * browser sent, the extension) never makes a file acceptable: it is only
 * used to say which text kind a plain text file is, and to refuse a file
 * that says one thing and is another.
 */
export function sniffFile(
  bytes: Uint8Array,
  claimedType: string,
  name: string,
  types: readonly string[] = DEFAULT_FILE_TYPES,
): Sniffed {
  if (bytes.byteLength === 0) return { refused: "empty" };
  const claimed = mediaTypeOf(claimedType);
  if (claimsMarkup(claimed, name)) return { refused: "markup" };
  const binary = sniffBinary(bytes);
  if (binary) {
    // A file that says it is a PNG and is a PDF is not what it says, but a
    // PNG renamed `.txt` is simply a PNG: the bytes decide.
    if (BINARY_TYPES.has(claimed) && claimed !== binary) {
      return { refused: "mismatch" };
    }
    return types.includes(binary) ? { mediaType: binary } : { refused: "type" };
  }
  if (BINARY_TYPES.has(claimed)) return { refused: "mismatch" };
  const text = strictText(bytes);
  if (text === null) return { refused: "type" };
  if (MARKUP_START.test(text.replace(/^\uFEFF/, "").slice(0, 1000))) {
    return { refused: "markup" };
  }
  const kind =
    claimed === "text/markdown" || /\.(?:md|markdown)$/i.test(name)
      ? "text/markdown"
      : claimed === "text/csv" || /\.csv$/i.test(name)
        ? "text/csv"
        : "text/plain";
  return types.includes(kind) ? { mediaType: kind } : { refused: "type" };
}
