// ─────────────────────────────────────────────────────────────────────────────
// Opt-in Content-Security-Policy header (`contentSecurityPolicy` config)
//
// Nothing is sent by default. With the option set, every HTML response gets
// one header built from the configured directives and the route's BUILD
// hashes (csp-hashes.json, already widened for request-time components). It
// never hashes a response body, so a reflected <script> never gets a hash.
// Portable: the Node servers and the Cloudflare Worker build the same header.
// ─────────────────────────────────────────────────────────────────────────────

/** The `contentSecurityPolicy` option in bascik.config. */
export interface ContentSecurityPolicyConfig {
  /** Directive name to its sources, written as in a CSP header ('self' quoted). */
  directives: Record<string, readonly string[]>;
  /**
   * Append each route's inline script and style hashes (default true).
   * `{ scripts: true, styles: false }` hashes one kind only. A directive
   * that lists 'unsafe-inline' never gets hashes: a hash would turn it off.
   * Hashes extend script-src and style-src (and script-src-elem and
   * style-src-elem when written). A missing script-src or style-src is
   * created from default-src's sources plus the hashes, or not at all when
   * default-src is not written either.
   */
  hashes?: boolean | { scripts?: boolean; styles?: boolean };
  /** Send Content-Security-Policy-Report-Only instead, to try a policy first. */
  reportOnly?: boolean;
}

/** One route's hashes, as csp-hashes.json stores them (quoted or not). */
export interface CspRouteHashes {
  scripts: readonly string[];
  styles: readonly string[];
}

const quote = (source: string): string =>
  source.startsWith("'") ? source : `'${source}'`;

/** The header name and value for one HTML response. */
export const contentSecurityPolicyHeader = (
  policy: ContentSecurityPolicyConfig,
  hashes: CspRouteHashes | undefined,
): { name: string; value: string } => {
  const directives = new Map<string, string[]>();
  for (const [name, sources] of Object.entries(policy.directives))
    directives.set(name.toLowerCase(), [...sources]);
  const kinds = policy.hashes;
  const wants = (kind: "scripts" | "styles"): boolean =>
    kinds === undefined ||
    kinds === true ||
    (typeof kinds === "object" && kinds[kind] !== false);
  if (kinds !== false && hashes !== undefined) {
    const unsafeInline = (sources: readonly string[]): boolean =>
      sources.some((s) => s.toLowerCase() === "'unsafe-inline'");
    const isNone = (source: string): boolean =>
      source.toLowerCase() === "'none'";
    /**
     * Add hashes to one directive. A directive the author wrote is only
     * extended. A missing one is created only when `seedFrom` (default-src)
     * is written, starting from its sources, so the merge never allows what
     * the author's policy blocked. `'none'` is dropped beside the hashes: it
     * may not share a source list, and its meaning (nothing but these
     * hashes) is kept.
     */
    const add = (
      name: string,
      list: readonly string[],
      seedFrom?: string,
    ): void => {
      if (list.length === 0) return;
      const written = directives.get(name);
      const base =
        written ??
        (seedFrom === undefined ? undefined : directives.get(seedFrom));
      // No directive and no default-src: inline content already runs, and an
      // invented source list would block the author's own files.
      if (base === undefined) return;
      if (unsafeInline(base)) return;
      const sources = base.filter((s) => !isNone(s));
      for (const hash of list) {
        const quoted = quote(hash);
        if (!sources.includes(quoted)) sources.push(quoted);
      }
      directives.set(name, sources);
    };
    if (wants("scripts")) {
      add("script-src", hashes.scripts, "default-src");
      add("script-src-elem", hashes.scripts);
    }
    if (wants("styles")) {
      add("style-src", hashes.styles, "default-src");
      add("style-src-elem", hashes.styles);
    }
  }
  const value = Array.from(directives, ([name, sources]) =>
    sources.length === 0 ? name : `${name} ${sources.join(" ")}`,
  ).join("; ");
  return {
    name: policy.reportOnly
      ? "content-security-policy-report-only"
      : "content-security-policy",
    value,
  };
};

/**
 * `own` plus `extra` (a page's component hashes), each list in first-seen
 * order with no repeats. The Node servers and the Worker widen the same way,
 * so a header is byte-identical on both hosts.
 */
export const widenCspRouteHashes = (
  own: CspRouteHashes | undefined,
  extra: CspRouteHashes | undefined,
): CspRouteHashes | undefined => {
  if (extra === undefined) return own;
  return {
    scripts: [...new Set([...(own?.scripts ?? []), ...extra.scripts])],
    styles: [...new Set([...(own?.styles ?? []), ...extra.styles])],
  };
};
