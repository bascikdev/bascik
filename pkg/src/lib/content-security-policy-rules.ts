/**
 * What config validation knows about `contentSecurityPolicy` directives and
 * sources. Kept out of content-security-policy.ts, which the portable
 * runtime exports, because only the build-time validator needs it.
 */

/** CSP Level 3 directives (and the reporting and navigation ones browsers still read). */
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "fenced-frame-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "sandbox",
  "report-uri",
  "report-to",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
  "require-trusted-types-for",
  "trusted-types",
  "webrtc",
];

/** Keywords a source list must quote. */
export const CSP_KEYWORDS: ReadonlySet<string> = new Set([
  "self",
  "none",
  "unsafe-inline",
  "unsafe-eval",
  "unsafe-hashes",
  "strict-dynamic",
  "report-sample",
  "wasm-unsafe-eval",
  "unsafe-allow-redirects",
  "inline-speculation-rules",
]);

/** Directives whose values are source lists (where keywords need quotes). */
export const isSourceListDirective = (name: string): boolean =>
  name.endsWith("-src") ||
  name === "base-uri" ||
  name === "form-action" ||
  name === "frame-ancestors";
