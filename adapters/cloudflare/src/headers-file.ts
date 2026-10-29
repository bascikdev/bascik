/**
 * The generated public/_headers on Cloudflare.
 *
 * Static files are served by the asset layer without the Worker, so the
 * headers the Worker sends on what it answers have to be written here for
 * them: the security headers (`security.headers`, `security.hsts`) as one
 * site-wide `/*` rule, and the opt-in `contentSecurityPolicy` as one
 * exact-path rule per static page (from the same pkg function the Node
 * servers and the Worker use, with the build's hashes). Responses the Worker
 * makes itself never get `_headers` rules, and an asset it forwards gets them
 * once, from the asset layer, so no header is sent twice.
 *
 * How Cloudflare reads the file (workers-shared, which miniflare runs): rules
 * are a record keyed by path, so a second rule with a path the author used
 * replaces the author's, at the place of the first; the rules that match a
 * URL apply in file order; a header two of them set is joined with a comma;
 * `! Name` in a rule removes what earlier rules set, before that rule's own
 * values; a line over 2000 characters is skipped; and it stops reading at the
 * 101st path line.
 *
 * So, whenever Bascik writes anything into the file:
 *   1. the site-wide rule comes first (Bascik's, or the author's own `/*`
 *      moved to the top with Bascik's headers it does not set added);
 *   2. the static pages' CSP rules come next, never as a second rule for a
 *      path the author has (the line goes into the author's rule), and not at
 *      all for a page an author rule already sets or removes the CSP header
 *      on: the author's value wins there;
 *   3. the author's other rules follow, and each one that sets a security
 *      header (any Bascik can write, whatever the toggles say) or a header
 *      the author's `/*` sets gets a `! Name` line first: a later, more
 *      specific rule replaces the value instead of being joined to it, the
 *      same way under every security setting.
 * When Bascik writes nothing (headers, HSTS and CSP all off), the author's
 * file ships as written.
 */
import {
  contentSecurityPolicyHeader,
  DEFAULT_RESPONSE_SECURITY,
  SECURITY_HEADERS,
  type ContentSecurityPolicyConfig,
  type CspRouteHashes,
  type ResponseSecurity,
} from "@bascik/bascik/runtime";

/** Cloudflare reads at most this many rules (path lines) from _headers. */
export const CLOUDFLARE_HEADERS_RULE_LIMIT = 100;

/** Cloudflare skips any _headers line longer than this, with no error. */
export const CLOUDFLARE_HEADERS_LINE_LIMIT = 2000;

const SITE_WIDE_PATH = "/*";

/** How Cloudflare tells a path line from a header line (its own pattern). */
const PATH_LINE = /^([^\s]+:\/\/|\/)/;
const UNSET_PREFIX = "! ";

const CSP_NAMES = [
  "content-security-policy",
  "content-security-policy-report-only",
];

/**
 * Every header Bascik can write here, whatever `security` turns on or off:
 * an author's rule that sets one replaces the earlier value under every
 * setting, so a toggle never changes how the author's own rules combine.
 */
const MANAGED_HEADERS: ReadonlySet<string> = new Set([
  ...Object.keys(SECURITY_HEADERS),
  "strict-transport-security",
  ...CSP_NAMES,
]);

/** `x-frame-options` -> `X-Frame-Options`. Cloudflare matches names in any case. */
const headerName = (lower: string): string =>
  lower.replace(
    /(^|-)([a-z])/g,
    (_, dash: string, c: string) => `${dash}${c.toUpperCase()}`,
  );

interface Rule {
  path: string;
  /** Index of the path line in the authored lines. */
  line: number;
  /** Index just past the rule's last line. */
  end: number;
  /** Header names the rule sets, lowercased, in the order written. */
  sets: Set<string>;
  /** Header names the rule removes with `! Name`, lowercased. */
  unsets: Set<string>;
}

/** The rules of a _headers text, as Cloudflare reads them (indentation is not significant). */
const parseRules = (lines: string[]): Rule[] => {
  const rules: Rule[] = [];
  let rule: Rule | undefined;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (PATH_LINE.test(line)) {
      if (rule) rule.end = index;
      rule = {
        path: line,
        line: index,
        end: lines.length,
        sets: new Set(),
        unsets: new Set(),
      };
      rules.push(rule);
      return;
    }
    if (!rule) return;
    if (line.startsWith(UNSET_PREFIX))
      rule.unsets.add(line.slice(UNSET_PREFIX.length).trim().toLowerCase());
    else if (line.includes(":"))
      rule.sets.add(line.slice(0, line.indexOf(":")).trim().toLowerCase());
  });
  return rules;
};

const linesOf = (text: string): string[] =>
  text === "" ? [] : text.replace(/\s*$/, "").split(/\r?\n/);

/**
 * How many rules Cloudflare reads from a _headers text: one per path line
 * that has a header or a `! Name` under it. A path written twice counts
 * twice, because Cloudflare stops at a count of path lines, not of paths.
 */
export const countHeadersRules = (text: string): number =>
  parseRules(linesOf(text)).filter((rule) => rule.sets.size + rule.unsets.size)
    .length;

/** Cloudflare's own pattern match (workers-shared generateRuleRegExp), for path rules. */
const ruleMatches = (rulePath: string, path: string): boolean => {
  if (!rulePath.startsWith("/")) return false;
  const source = rulePath
    .split("*")
    .map((part) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
    .join(".*")
    .replace(/:[A-Za-z]\w*/g, "[^/]+");
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
};

export interface HeadersFileCsp {
  policy: ContentSecurityPolicyConfig;
  hashes: Record<string, CspRouteHashes>;
  /** HTTP paths of the static pages (`/`, `/docs`, `/blog/`). */
  staticRoutes: readonly string[];
}

export interface HeadersFileInput {
  /** The author's _headers (copied from dist/), or "" when there is none. */
  authored: string;
  /** The build's resolved `security` headers. Absent: every default, as in the Worker. */
  security?: ResponseSecurity;
  /** Normalized base path (`/` or `/shop/`). */
  base: string;
  /** The opt-in `contentSecurityPolicy`, for the static pages. */
  csp?: HeadersFileCsp;
  /** Which deploy the file is for; it decides the fix an error suggests. */
  variant?: "pages" | "workers";
}

/** What to do when the static headers do not fit in _headers, for this variant. */
const remedy = (variant: "pages" | "workers"): string =>
  variant === "workers"
    ? `Let the Worker send the headers on every response instead: in your wrangler.jsonc (or wrangler.json or wrangler.toml) set ` +
      `"assets": { "run_worker_first": true }, and Bascik writes no _headers rules for them.`
    : `Cloudflare Pages cannot run the Worker before static files, so build with --target cloudflare-workers and set ` +
      `"assets": { "run_worker_first": true } in your wrangler.jsonc; the Worker then sends the headers on every response.`;

/**
 * The whole public/_headers text: the site-wide security rule, the static
 * pages' CSP rules, and the author's rules. The author's text unchanged when
 * Bascik has nothing to write; "" when there is no file at all.
 */
export const buildHeadersFile = ({
  authored,
  security = DEFAULT_RESPONSE_SECURITY,
  base,
  csp,
  variant = "workers",
}: HeadersFileInput): string => {
  const lines = linesOf(authored);
  const rules = parseRules(lines);
  // Cloudflare keeps the last rule written for a path, at the place of the first.
  const effective = new Map<string, Rule>();
  for (const rule of rules) effective.set(rule.path, rule);
  const authorSiteWide = effective.get(SITE_WIDE_PATH);

  // name (lowercase) -> value, in the order Node sends them.
  const siteWide = new Map<string, string>(Object.entries(security.headers));
  if (security.hsts !== null)
    siteWide.set("strict-transport-security", security.hsts);

  /** Lines to add right after a rule's path line, by that line's index. */
  const additions = new Map<number, string[]>();
  const add = (rule: Rule, line: string) => {
    const list = additions.get(rule.line) ?? [];
    list.push(line);
    additions.set(rule.line, list);
  };

  // The static pages' CSP.
  const prefix = base === "/" ? "" : base.replace(/\/$/, "");
  const cspRules: string[] = [];
  const cspInAuthorRules: [Rule, string][] = [];
  const cspRoutes = new Map<string, string>();
  if (csp) {
    for (const route of csp.staticRoutes) {
      const { name, value } = contentSecurityPolicyHeader(
        csp.policy,
        csp.hashes[route],
      );
      const path = `${prefix}${route}`;
      const line = `  ${headerName(name)}: ${value}`;
      // An author's rule that sets or removes this header on the page wins.
      const authorDecides = [...effective.values()].some(
        (rule) =>
          (rule.sets.has(name) || rule.unsets.has(name)) &&
          ruleMatches(rule.path, path),
      );
      if (authorDecides) continue;
      if (line.trim().length > CLOUDFLARE_HEADERS_LINE_LIMIT)
        throw new Error(
          `[bascik] --target cloudflare: the ${headerName(name)} line for the static page ${path} is ` +
            `${line.trim().length} characters (one hash for each of its inline scripts and styles), but Cloudflare ` +
            `skips any _headers line over ${CLOUDFLARE_HEADERS_LINE_LIMIT} characters, so the page would ship with no ` +
            `policy and no error. ${remedy(variant)} Or move some of the page's inline scripts and styles into files.`,
        );
      cspRoutes.set(path, route);
      const own = effective.get(path);
      // Never a second rule for the author's path: it would replace theirs.
      if (own) cspInAuthorRules.push([own, line]);
      else cspRules.push(path, line);
    }
  }

  if (siteWide.size === 0 && cspRoutes.size === 0) return authored;

  // A later rule replaces a security header (or one the author's `/*` sets)
  // instead of joining it.
  const replaced = new Set([
    ...MANAGED_HEADERS,
    ...siteWide.keys(),
    ...(authorSiteWide?.sets ?? []),
  ]);
  for (const rule of effective.values()) {
    if (rule === authorSiteWide) {
      // The author's own `/*`: their values and removals stand.
      for (const [name, value] of siteWide)
        if (!rule.sets.has(name) && !rule.unsets.has(name))
          add(rule, `  ${headerName(name)}: ${value}`);
      continue;
    }
    for (const name of rule.sets)
      if (replaced.has(name) && !rule.unsets.has(name))
        add(rule, `  ${UNSET_PREFIX}${headerName(name)}`);
  }
  for (const [rule, line] of cspInAuthorRules) add(rule, line);

  const skip = new Set<number>();
  const rendered = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (let i = from; i < to; i++) {
      if (skip.has(i)) continue;
      out.push(lines[i]);
      const extra = additions.get(i);
      if (extra) out.push(...extra);
    }
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    return out;
  };

  const blocks: string[][] = [];
  if (authorSiteWide) {
    // First: the author's `/*` (with the comments above it when it is their
    // first rule). An earlier `/*` rule Cloudflare already ignores (the last
    // one written wins) is left out, or it would take the moved rule's place.
    const from = authorSiteWide === rules[0] ? 0 : authorSiteWide.line;
    blocks.push(rendered(from, authorSiteWide.end));
    for (let i = from; i < authorSiteWide.end; i++) skip.add(i);
    for (const rule of rules)
      if (rule.path === SITE_WIDE_PATH)
        for (let i = rule.line; i < rule.end; i++) skip.add(i);
  } else if (siteWide.size > 0) {
    blocks.push([
      SITE_WIDE_PATH,
      ...[...siteWide].map(
        ([name, value]) => `  ${headerName(name)}: ${value}`,
      ),
    ]);
  }
  if (cspRules.length) blocks.push(cspRules);
  const rest = rendered(0, lines.length);
  if (rest.length) blocks.push(rest);
  const text = `${blocks.map((b) => b.join("\n")).join("\n\n")}\n`;

  const tooLong = text
    .split("\n")
    .findIndex((line) => line.trim().length > CLOUDFLARE_HEADERS_LINE_LIMIT);
  if (tooLong !== -1) {
    const line = text.split("\n")[tooLong].trim();
    throw new Error(
      `[bascik] --target cloudflare: a line in your _headers is ${line.length} characters ` +
        `(${line.slice(0, 60)}...), but Cloudflare skips any _headers line over ${CLOUDFLARE_HEADERS_LINE_LIMIT} ` +
        `characters with no error. Shorten it.`,
    );
  }

  const total = countHeadersRules(text);
  if (total > CLOUDFLARE_HEADERS_RULE_LIMIT) {
    const newSiteWide = !authorSiteWide && siteWide.size > 0 ? 1 : 0;
    const cspPages = cspRules.length / 2;
    const authoredRules = total - newSiteWide - cspPages;
    const parts = [
      ...(cspPages
        ? [`${cspPages} for contentSecurityPolicy, one for each static page`]
        : []),
      ...(newSiteWide
        ? ["1 site-wide rule for security.headers and security.hsts"]
        : []),
      ...(authoredRules ? [`${authoredRules} already in your _headers`] : []),
    ];
    throw new Error(
      `[bascik] --target cloudflare: public/_headers needs ${total} rules (${parts.join(", ")}), but Cloudflare ` +
        `reads at most ${CLOUDFLARE_HEADERS_RULE_LIMIT} and drops the rest with no error. ${remedy(variant)} ` +
        `Or remove rules from your _headers (a path written twice counts twice).`,
    );
  }
  return text;
};

/**
 * The author's _headers rules that set or remove a security header on a page
 * the Worker renders. `_headers` reaches static files only, so on those pages
 * the Worker keeps `security.headers`' value: one warning per rule, naming a
 * page, so the author can move the value into the config.
 */
export const workerPageHeaderOverrides = ({
  authored,
  security = DEFAULT_RESPONSE_SECURITY,
  base,
  workerPages,
}: {
  authored: string;
  security?: ResponseSecurity;
  base: string;
  /** HTTP paths of the pages the Worker renders, without the base. */
  workerPages: readonly string[];
}): string[] => {
  const prefix = base === "/" ? "" : base.replace(/\/$/, "");
  const watched = new Set([
    ...MANAGED_HEADERS,
    ...Object.keys(security.headers),
  ]);
  const warnings: string[] = [];
  const effective = new Map<string, Rule>();
  for (const rule of parseRules(linesOf(authored)))
    effective.set(rule.path, rule);
  for (const rule of effective.values()) {
    const names = [...rule.sets, ...rule.unsets].filter((n) => watched.has(n));
    if (!names.length) continue;
    const page = workerPages
      .map((p) => `${prefix}${p}`)
      .find((p) => ruleMatches(rule.path, p));
    if (!page) continue;
    warnings.push(
      `[bascik] --target cloudflare: your _headers rule ${rule.path} sets ${[...new Set(names)].map(headerName).join(", ")}, ` +
        `but ${page} is rendered by the Worker and _headers rules reach static files only, so that page keeps ` +
        `Bascik's value. To change the header on every page, set it in security.headers.`,
    );
  }
  return warnings;
};
