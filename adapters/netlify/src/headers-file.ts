/**
 * @module headers-file
 *
 * The generated `publish/_headers`. Netlify's CDN serves static files without
 * the function, so the headers the function sends on what it renders are
 * written here for them: the security headers (`security.headers`) as one
 * site-wide `/*` rule, and the opt-in `contentSecurityPolicy` as one rule per
 * URL of each static page (with the build's hashes for that page).
 *
 * Netlify combines the values of a header that several matching rules set,
 * and has no way to remove one, so Bascik never edits an authored `_headers`:
 * when the site ships its own, it is kept as written and the build says which
 * headers the author now owns. HSTS is left to Netlify, which sends it on
 * every HTTPS response of a site with a certificate.
 */

import { pageAliasesFor, type SiteGraph } from "@bascik/bascik/adapter";
import {
  contentSecurityPolicyHeader,
  DEFAULT_RESPONSE_SECURITY,
} from "@bascik/bascik/runtime";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** `x-frame-options` -> `X-Frame-Options`. */
const headerName = (lower: string): string =>
  lower.replace(
    /(^|-)([a-z])/g,
    (_, dash: string, c: string) => `${dash}${c.toUpperCase()}`,
  );

/** The `_headers` text Bascik writes for a graph, or "" when there is nothing to send. */
export function headersFileText(
  graph: Pick<SiteGraph, "base" | "responseSecurity" | "contentSecurityPolicy">,
): string {
  const security = graph.responseSecurity ?? DEFAULT_RESPONSE_SECURITY;
  const rules: string[] = [];
  const siteWide = Object.entries(security.headers);
  if (siteWide.length) {
    const prefix = graph.base === "/" ? "" : graph.base.replace(/\/$/, "");
    rules.push(
      [
        `${prefix}/*`,
        ...siteWide.map(([name, value]) => `  ${headerName(name)}: ${value}`),
      ].join("\n"),
    );
  }
  const csp = graph.contentSecurityPolicy;
  for (const route of csp?.staticRoutes ?? []) {
    const { name, value } = contentSecurityPolicyHeader(
      csp!.policy,
      csp!.hashes[route],
    );
    for (const alias of pageAliasesFor(route, graph.base))
      rules.push(`${alias}\n  ${headerName(name.toLowerCase())}: ${value}`);
  }
  return rules.length ? `${rules.join("\n\n")}\n` : "";
}

/**
 * Write `publishDir/_headers` for the static files, unless the site ships
 * its own. Returns the warnings to log.
 */
export async function buildHeadersFile(
  graph: Pick<SiteGraph, "base" | "responseSecurity" | "contentSecurityPolicy">,
  publishDir: string,
): Promise<{ written: boolean; warnings: string[] }> {
  const text = headersFileText(graph);
  if (!text) return { written: false, warnings: [] };
  const path = join(publishDir, "_headers");
  if (existsSync(path)) {
    return {
      written: false,
      warnings: [
        "[bascik] --target netlify: the site has its own _headers file, so Bascik's security headers" +
          (graph.contentSecurityPolicy ? " and Content-Security-Policy" : "") +
          " for static pages are not written. Netlify combines values from rules that match the same URL, " +
          "so add the headers you want to your _headers file (the function still sends them on the pages it renders).",
      ],
    };
  }
  await writeFile(path, text, "utf8");
  return { written: true, warnings: [] };
}
