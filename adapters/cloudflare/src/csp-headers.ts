/**
 * Opt-in `contentSecurityPolicy` for static pages on Cloudflare.
 *
 * Pages the Worker renders get the header from the runtime. Static pages are
 * served by the asset layer without the Worker, so the build writes one
 * exact-path rule per static page into the generated public/_headers, after
 * any rules the author wrote. The value comes from the same pkg function
 * the Node servers and the Worker use, from the build's hashes.
 */
import {
  contentSecurityPolicyHeader,
  type ContentSecurityPolicyConfig,
  type CspRouteHashes,
} from "@bascik/bascik/runtime";

/** Cloudflare reads at most this many rules from _headers. */
export const CLOUDFLARE_HEADERS_RULE_LIMIT = 100;

const HEADER_NAMES: Record<string, string> = {
  "content-security-policy": "Content-Security-Policy",
  "content-security-policy-report-only": "Content-Security-Policy-Report-Only",
};

/** How many rules (unindented, non-comment lines) an authored _headers file has. */
export const countHeadersRules = (text: string): number =>
  text
    .split(/\r?\n/)
    .filter((line) => /^\S/.test(line) && !line.startsWith("#")).length;

export interface CspHeadersRulesInput {
  policy: ContentSecurityPolicyConfig;
  hashes: Record<string, CspRouteHashes>;
  /** HTTP paths of the static pages (`/`, `/docs`, `/blog/`). */
  staticRoutes: readonly string[];
  /** Normalized base path (`/` or `/shop/`). */
  base: string;
  /** Rules already in the author's _headers, which count toward the limit. */
  authoredRules?: number;
}

/** The _headers text for every static page, one exact-path rule each. */
export const buildCspHeadersRules = ({
  policy,
  hashes,
  staticRoutes,
  base,
  authoredRules = 0,
}: CspHeadersRulesInput): string => {
  // Kept below the limit, not at it, so one rule stays free for a later edit.
  const total = staticRoutes.length + authoredRules;
  if (total >= CLOUDFLARE_HEADERS_RULE_LIMIT)
    throw new Error(
      `[bascik] --target cloudflare: contentSecurityPolicy needs one _headers rule per static page (${staticRoutes.length}` +
        `${authoredRules ? `, plus ${authoredRules} rules already in your _headers` : ""}), ` +
        `but Cloudflare reads at most ${CLOUDFLARE_HEADERS_RULE_LIMIT} rules. ` +
        `Serve every page through the Worker instead, which sends the header itself: in wrangler.jsonc set ` +
        `"assets": { "run_worker_first": true }, or remove rules from public/_headers.`,
    );
  const prefix = base === "/" ? "" : base.replace(/\/$/, "");
  const lines: string[] = [];
  for (const route of staticRoutes) {
    const { name, value } = contentSecurityPolicyHeader(policy, hashes[route]);
    lines.push(`${prefix}${route}`, `  ${HEADER_NAMES[name]}: ${value}`);
  }
  return `${lines.join("\n")}\n`;
};
