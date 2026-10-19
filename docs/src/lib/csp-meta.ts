/**
 * csp-meta.ts
 *
 * Builds the per-page Content-Security-Policy `<meta>` for the built docs.
 *
 * The docs inline their component scripts, and they vary per page (a page can carry dozens of distinct
 * scripts, more than 1,000 across the site). Cloudflare Pages `_headers` allows 100 rules and 2,000
 * characters per line, so a hash allowlist cannot live in a header. A `<meta http-equiv>` policy can hold
 * the page's own hashes, so each page lists exactly the inline scripts it contains. The `_headers` policy
 * (see pages-headers.ts) adds the directives only a header can carry, plus `object-src` and `base-uri`.
 * Browsers enforce every policy, so the two combine into a stricter whole.
 *
 * `script-src` never gets `'unsafe-inline'` or `data:`. Scripts the page loads from another origin (the
 * Alpine and petite-vue demos on /libraries) add that origin, and `'unsafe-eval'`, because those libraries
 * compile directive expressions with `new Function`. Pages without third-party scripts never get it.
 *
 * The hash is computed from the emitted bytes, so this must run after every step that edits inline script
 * text. It runs in the `post` phase.
 */
import { createHash } from "node:crypto";

const META_MARKER = 'http-equiv="Content-Security-Policy"';

/** The `type` values of a `<script>` whose body runs, or is an import map. Other types are data. */
const EXECUTABLE_TYPES = new Set([
  "",
  "module",
  "importmap",
  "text/javascript",
  "application/javascript",
]);

const SCRIPT_RE =
  /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi;

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(
    `(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function sha256Source(body: string): string {
  // The HTML parser normalizes newlines before a browser hashes the body.
  const normalized = body.replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(normalized, "utf8").digest("base64")}'`;
}

export interface PageScripts {
  /** `'sha256-...'` source expressions for each distinct inline script, in sorted order. */
  hashes: string[];
  /** Origins that external `<script src>` tags load from, other than the page's own. */
  origins: string[];
}

/** Collects the inline script hashes and third-party script origins of a built page. */
export function collectPageScripts(html: string): PageScripts {
  const hashes = new Set<string>();
  const origins = new Set<string>();
  for (const match of html.matchAll(SCRIPT_RE)) {
    const attributes = match[1] ?? "";
    const type = (attribute(attributes, "type") ?? "").trim().toLowerCase();
    const src = attribute(attributes, "src");
    if (src !== null) {
      if (/^(?:https?:)?\/\//i.test(src.trim()))
        origins.add(new URL(src.trim(), "https://example.invalid").origin);
      continue;
    }
    if (!EXECUTABLE_TYPES.has(type)) continue;
    hashes.add(sha256Source(match[2] ?? ""));
  }
  return { hashes: [...hashes].sort(), origins: [...origins].sort() };
}

/** The policy text for a page: hashed inline scripts, same-origin files, no inline allowance. */
export function pagePolicy(scripts: PageScripts): string {
  const sources = ["'self'", ...scripts.origins, ...scripts.hashes];
  if (scripts.origins.length > 0) sources.push("'unsafe-eval'");
  return `script-src ${sources.join(" ")}; object-src 'none'; base-uri 'self'`;
}

/**
 * Adds the policy `<meta>` to a built page, right after `<meta charset>` so the encoding declaration stays
 * inside the first 1,024 bytes and the policy applies to every script after it. Returns the page unchanged
 * when it already has a policy or has no `<head>`.
 */
export function injectCspMeta(html: string): string {
  if (html.includes(META_MARKER)) return html;
  const meta = `<meta ${META_MARKER} content="${pagePolicy(collectPageScripts(html))}" />`;
  const charset = /<meta\s+charset\s*=[^>]*>/i.exec(html);
  if (charset) {
    const end = charset.index + charset[0].length;
    return html.slice(0, end) + meta + html.slice(end);
  }
  const head = /<head\b[^>]*>/i.exec(html);
  if (!head) return html;
  const end = head.index + head[0].length;
  return html.slice(0, end) + meta + html.slice(end);
}
