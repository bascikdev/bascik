import { readFile } from "node:fs/promises";
import { deepReadDirFlat } from "./file-system.ts";
import { SERVER_ATTR_NAME, STREAM_ATTR_NAME } from "./html-patterns.ts";
import { BascikConfig } from "./config.ts";
import { minifyCss } from "./css-minifier.ts";
import { memoizedMinifyJs } from "./js-minifier.ts";
import { isJavaScriptScript } from "./script-types.ts";

type AsyncMinifier = (code: string) => Promise<string>;

interface InlineScriptReplacement {
  index: number;
  len: number;
  open: string;
  code: string;
  sourceUrl: string | null;
  close: string;
}

// Request-time script directives as whole attribute names (prompt 65 step 0).
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const SERVER_OR_STREAM_SCRIPT_RE = new RegExp(
  String.raw`\s(?:${SERVER_ATTR_NAME}|${STREAM_ATTR_NAME})`,
  "i",
);

const TRAILING_SOURCE_URL_RE = /(?:^|\n)[ \t]*(\/\/# sourceURL=[^\n]*?)[ \t]*$/;

const resolveInlineStyles = async (): Promise<string[]> => {
  const inlineStyles = BascikConfig.assets?.inlineStyles;
  if (inlineStyles === true) {
    return (
      await deepReadDirFlat(BascikConfig.directory.pages, /\.css$/i)
    ).sort();
  }
  if (Array.isArray(inlineStyles)) {
    return inlineStyles;
  }
  return [];
};

/**
 * Resolve the `minify.css` config value to a concrete async minifier
 * function, or `null` when minification is disabled.
 */
export const resolveCssMinifier = (): AsyncMinifier | null => {
  const cfg = BascikConfig.minify?.css ?? false;
  if (!cfg) return null;
  const fn = cfg === true ? minifyCss : cfg;
  return async (code: string) => {
    try {
      return await fn(code);
    } catch (err) {
      const behavior = BascikConfig.onMinifyError ?? "error";
      if (behavior === "error") {
        console.error("[bascik] CSS minification failed:", err);
        throw err;
      }
      console.warn(
        "[bascik] CSS minification failed, falling back to unminified CSS:",
        err,
      );
      return code;
    }
  };
};

export const resolveInlineStylesHtml = async (): Promise<string> => {
  const inlineStyles = await resolveInlineStyles();
  if (!inlineStyles.length) return "";
  const cssMinifier = resolveCssMinifier();
  const sheets = await Promise.all(
    inlineStyles.map(async (filePath) => {
      let css: string;
      try {
        css = (await readFile(filePath)).toString();
      } catch (error) {
        console.warn(
          "[bascik] inlineStyles: could not read %s:",
          filePath,
          (error as Error).message,
        );
        return "";
      }
      return cssMinifier ? await cssMinifier(css) : css;
    }),
  );
  const combined = sheets.filter(Boolean).join(" ");
  return combined ? `<style>${combined}</style>` : "";
};

/**
 * Resolve the `minify.js` config value to a concrete async minifier
 * function, or `null` when minification is disabled.
 */
export const resolveScriptMinifier = (): AsyncMinifier | null => {
  const cfg = BascikConfig.minify?.js ?? false;
  if (!cfg) return null;
  // Only the built-in minifier is memoized: it is pure. A custom minifier may not be.
  const fn = cfg === true ? memoizedMinifyJs : cfg;
  return async (code: string) => {
    try {
      return await fn(code);
    } catch (err) {
      const behavior = BascikConfig.onMinifyError ?? "error";
      if (behavior === "error") {
        console.error("[bascik] JS minification failed:", err);
        throw err;
      }
      console.warn(
        "[bascik] JS minification failed, falling back to unminified JS:",
        err,
      );
      return code;
    }
  };
};

/**
 * Split a script body into the code the minifier should see and the
 * `//# sourceURL` directive Bascik owns. Minifiers (the built-in one, esbuild,
 * terser, `stripTypeScriptTypes` on a one-line result) legitimately drop or
 * re-flow comments, so the directive must never be handed to them and must be
 * re-attached on its own line afterwards. A directive glued onto the same line
 * as `})();` turns the rest of the line into a comment and breaks the script.
 */
export const splitTrailingSourceUrl = (
  code: string,
): { code: string; sourceUrl: string | null } => {
  const m = TRAILING_SOURCE_URL_RE.exec(code);
  if (!m) return { code, sourceUrl: null };
  return { code: code.slice(0, m.index), sourceUrl: m[1] };
};

/** Re-attach a directive so it always starts on a fresh line. */
export const appendSourceUrl = (
  code: string,
  sourceUrl: string | null,
): string => {
  if (!sourceUrl) return code;
  const trimmed = code.replace(/[ \t]+$/, "");
  const separator = trimmed.endsWith("\n") ? "" : "\n";
  return `${trimmed}${separator}${sourceUrl}`;
};

/**
 * Minify the content of every inline `<script>` tag in `html` (excluding
 * external scripts and non-JS types such as application/ld+json).
 */
export const minifyScriptTagsInHtml = async (
  html: string,
  minifyFn: (code: string) => string | Promise<string>,
): Promise<string> => {
  const scannable = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => " ".repeat(comment.length))
    .replace(
      /<(textarea|title|noscript|xmp)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/\1(?:[\t\n\f\r /][^>]*)?>)/gi,
      (_match, tag: string, attrs: string, inner: string, close: string) =>
        `<${tag}${attrs}>${" ".repeat(inner.length)}${close}`,
    );
  const regex =
    /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script(?:[\t\n\f\r /][^>]*)?>)/gi;
  const ops: InlineScriptReplacement[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(scannable)) !== null) {
    const [full, open, body, close] = m as unknown as [
      string,
      string,
      string,
      string,
    ];
    // Skip non-JS types (e.g. application/ld+json, text/template)
    if (!isJavaScriptScript(open)) continue;
    // Server and stream scripts run at request time in Node.js, skip them here
    if (SERVER_OR_STREAM_SCRIPT_RE.test(open)) continue;
    // Skip external scripts — no inline content to minify
    if (/\s+src\s*=/i.test(open)) continue;
    const { code, sourceUrl } = splitTrailingSourceUrl(body);
    ops.push({
      index: m.index,
      len: full.length,
      open,
      code,
      sourceUrl,
      close,
    });
  }
  if (!ops.length) return html;
  const minified = await Promise.all(ops.map(({ code }) => minifyFn(code)));
  const parts: string[] = [];
  let cursor = 0;
  ops.forEach(({ index, len, open, sourceUrl, close }, i) => {
    parts.push(
      html.slice(cursor, index),
      open,
      appendSourceUrl(minified[i], sourceUrl),
      close,
    );
    cursor = index + len;
  });
  parts.push(html.slice(cursor));
  return parts.join("");
};
