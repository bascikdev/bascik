/**
 * @module escape-html
 *
 * HTML Escaping Utility for Server Scripts and Templating
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Encodes the five standard HTML metacharacters (&, <, >, ", ') into their
 * safe HTML character entity equivalents.
 */

const ESCAPE_HTML_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const ESCAPE_HTML_REGEX = /[&<>"']/g;

/**
 * HTML-escape a value for safe interpolation into HTML markup.
 * Non-string values are converted to string; null/undefined yield empty string.
 */
export const escapeHtml = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  const str = String(value);
  return str.replace(ESCAPE_HTML_REGEX, (char) => ESCAPE_HTML_MAP[char]);
};
