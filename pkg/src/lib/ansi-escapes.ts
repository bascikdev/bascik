/**
 * @module ansi-escapes
 *
 * The terminal escape sequences a server or stream script's output is
 * stripped of before it reaches a page (CSI, OSC and two-character escapes).
 * Portable (prompt 157), so the Cloudflare Worker strips exactly what
 * `runServerScriptJob` strips on Node and the two hosts send the same bytes,
 * component scripts included.
 */
export const stripAnsiEscapeCodes = (value: string): string =>
  value
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "");
