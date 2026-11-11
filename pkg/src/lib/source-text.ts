/**
 * Source text as the build reads it: without a leading UTF-8 byte order mark.
 * Windows editors (Notepad, Visual Studio, PowerShell `Set-Content`) save one,
 * and U+FEFF is not HTML whitespace, so a BOM copied into a page closes
 * `<head>` early or sits before the doctype. Only the first character is a
 * BOM; a U+FEFF later in the file is content and stays.
 */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** Decode a source file buffer as UTF-8 without its byte order mark. */
export const decodeSource = (buffer: Buffer): string =>
  stripBom(buffer.toString("utf8"));
