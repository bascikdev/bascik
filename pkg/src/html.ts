/**
 * @bascik/bascik/html: plain functions for server and stream scripts that
 * return safe HTML. See the HTML Helpers reference in the docs.
 */
export {
  html,
  raw,
  esc,
  safeUrl,
  json,
  isHtml,
  HtmlError,
  type SafeHtml,
  type JsonText,
  type SafeUrlOptions,
  type HtmlErrorCode,
} from "./lib/html-template.ts";
