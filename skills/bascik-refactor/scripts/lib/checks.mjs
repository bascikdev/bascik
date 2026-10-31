// Shared plumbing for the parity checks (interaction-crawl.mjs through production-defects.mjs and run-checks.mjs).
// Dependency-free; Node.js 22.22+. Nothing here imports Playwright: the browser comes from the caller.
//
// Every check module exports CHECK (its name) and runCheck(browser, options), which resolves to
// { check, ok, findings, ... } where each finding is { check, kind, message, ... } and ok is findings.length === 0.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openPage, routeUrl, settle } from "./capture.mjs";
import { loadMatrix } from "./matrix.mjs";
import { loadPlaywright } from "./project-deps.mjs";

export const DEFAULT_MATRIX = "docs/migration/breakpoints.json";
export const DEFAULT_OUT = "artifacts/checks";

/** A finding: the check that made it, its kind, a sentence a person can act on, and any located fields. */
export function finding(check, kind, message, fields = {}) {
  return { check, kind, message, ...fields };
}

/** A check result; ok is derived from the findings so the two never disagree. */
export function result(check, findings, extra = {}) {
  return { check, ok: findings.length === 0, findings, ...extra };
}

/** Collapses whitespace and trims, the same way the in-page helper does. */
export const normalize = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The file and folder name of a route under --out and in docs/migration/review: "/" -> "index", "/pricing/team/" ->
 * "pricing_team". A route the readable name cannot tell apart from another ("/index", "/docs/a_b" next to
 * "/docs/a/b", upper case, non-ASCII) gets a hash of the route appended, as compare-route.mjs does for every folder.
 * A route and the same route with a trailing slash ("/pricing", "/pricing/") share the name: validateRouteSet rejects
 * the pair, so two routes of one run never share a report, a review page or a sign-off.
 */
export function routeSlug(route) {
  const value = String(route);
  const slug =
    value
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "_")
      .slice(0, 60) || "index";
  const plain =
    /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?)?$/.test(value) &&
    !/^\/index\/?$/.test(value) &&
    value.length <= 61;
  if (plain) return slug;
  return `${slug}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

/**
 * Rejects a list of routes that names one route twice, or two routes whose routeSlug is the same ("/pricing" and
 * "/pricing/"): their reports, crops, review pages and sign-offs would overwrite each other.
 */
export function validateRouteSet(routes) {
  const bySlug = new Map();
  const seen = new Set();
  for (const route of routes ?? []) {
    if (seen.has(route)) throw new Error(`--route ${route} is given twice`);
    seen.add(route);
    const slug = routeSlug(route);
    const other = bySlug.get(slug);
    if (other !== undefined)
      throw new Error(
        `--route ${other} and --route ${route} would share the report name "${slug}", so one would overwrite the other; they are usually one page (one redirects to the other), so pass one`,
      );
    bySlug.set(slug, route);
  }
}

/** Rejects a route that is not a path on the site, as compare-route.mjs does. */
export function validateRoute(route) {
  const path = String(route).split(/[?#]/, 1)[0];
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error(
      `--route ${route}: pass a path on the site that starts with "/", such as /pricing`,
    );
  if (path.split("/").some((segment) => segment === "." || segment === ".."))
    throw new Error(
      `--route ${route}: a "." or ".." segment is not a page of its own; pass the path it resolves to`,
    );
}

/**
 * Rejects a --mask value that cannot be a CSS selector (empty, or brackets, parentheses or quotes that do not close),
 * because the page would ignore it and the region it was meant to hide would be compared after all. `flag` names the
 * option in the message (--skip-control takes selectors too).
 */
export function validateMask(selector, flag = "--mask") {
  const value = String(selector ?? "").trim();
  if (!value)
    throw new Error(
      flag === "--mask"
        ? "--mask needs a CSS selector for a documented dynamic region, such as '[data-testid=\"carousel\"]'"
        : `${flag} needs a CSS selector for a control with side effects, such as '[data-testid="add-to-cart"]'`,
    );
  const stack = [];
  let quote = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(") stack.push(ch);
    else if (ch === "]" || ch === ")") {
      const open = stack.pop();
      if ((ch === "]" && open !== "[") || (ch === ")" && open !== "("))
        throw new Error(
          `${flag} ${value}: not a CSS selector ("${ch}" closes nothing)`,
        );
    }
  }
  if (quote || stack.length)
    throw new Error(
      `${flag} ${value}: not a CSS selector (${quote ? `the ${quote} quote` : `"${stack.at(-1)}"`} is never closed)`,
    );
}

/** The routes a runCheck call covers: options.routes, or options.route, or "/". */
export function routesOf(options) {
  if (Array.isArray(options.routes) && options.routes.length)
    return options.routes;
  if (Array.isArray(options.route) && options.route.length)
    return options.route;
  if (typeof options.route === "string") return [options.route];
  return ["/"];
}

/** The matrix cases a runCheck call covers: options.cases, or the matrix file. */
export function casesOf(options) {
  if (Array.isArray(options.cases) && options.cases.length)
    return options.cases;
  return loadMatrix(options.matrix ?? DEFAULT_MATRIX);
}

/**
 * The --skip-control option for the checks that activate controls (interaction-crawl, state-capture): the parseArgs
 * option, and the validated list of its values.
 */
export const SKIP_CONTROL_OPTION = Object.freeze({
  "skip-control": { type: "string", multiple: true },
});
export function skipControlsFrom(list) {
  for (const selector of list ?? []) validateMask(selector, "--skip-control");
  return list ?? [];
}

/**
 * The controls a runCheck call must never activate, from `skipControls` (API and run-checks) or `skip-control`
 * (a check's own CLI): a button whose handler posts to the live site (add to cart, subscribe, vote, start a chat).
 */
export function skipControlsOf(options) {
  return [
    ...(options?.skipControls ?? []),
    ...(options?.["skip-control"] ?? []),
  ];
}

/** The masks a runCheck call takes, from `masks` (API) or `mask` (CLI). */
export function masksOf(options) {
  return [...(options.masks ?? []), ...(options.mask ?? [])];
}

/** How long the page must go without a DOM change outside the masks before a check measures it, and the cap. */
export const QUIET_MS = 750;
export const QUIET_CAP_MS = 4000;

/**
 * How long after navigation starts a check waits, at least, before it measures a page: a newsletter modal or a promo
 * that opens on a timer (3 s after load is common) is then on the page on both sides, every time, instead of on
 * whichever side happened to load slower. Pass --settle-ms for a layer on a longer timer, or 0 for a site with none.
 */
export const DEFAULT_SETTLE_MS = 5000;

/** The settle time a runCheck call takes: options.settleMs, or DEFAULT_SETTLE_MS. */
export function settleOf(options) {
  const n = Number(options?.settleMs);
  return options?.settleMs === undefined || !Number.isFinite(n) || n < 0
    ? DEFAULT_SETTLE_MS
    : n;
}

/**
 * Waits until `settleMs` after navigation started (see DEFAULT_SETTLE_MS), then until no DOM change happens outside
 * the masked regions for QUIET_MS, at most QUIET_CAP_MS: a banner that slides in a moment after load, a modal on a
 * timer, or content a script fills in late, is on the page before anything is measured on either side. A region that
 * never stops changing (a ticker, a carousel) runs into the cap; mask it.
 */
export async function quiet(page, masks = [], settleMs = DEFAULT_SETTLE_MS) {
  await page.evaluate(
    async ({ quietMs, cap, masks, settleMs }) => {
      const wait = settleMs - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const inMask = (node) => {
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (!el) return false;
        return masks.some((m) => {
          try {
            return Boolean(el.closest(m));
          } catch {
            return false;
          }
        });
      };
      await new Promise((done) => {
        let timer = setTimeout(finish, quietMs);
        const end = setTimeout(finish, cap);
        const observer = new MutationObserver((records) => {
          if (records.every((r) => inMask(r.target))) return;
          clearTimeout(timer);
          timer = setTimeout(finish, quietMs);
        });
        function finish() {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(end);
          done();
        }
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      window.scrollTo(0, 0);
    },
    { quietMs: QUIET_MS, cap: QUIET_CAP_MS, masks, settleMs },
  );
}

/**
 * Opens `route` on `origin` for one case, settled and quiet (see quiet()), runs `fn(page)` and closes the context.
 * `masks` are the documented dynamic regions the quiet wait ignores; `settleMs` is the least time after navigation
 * before `fn` runs (DEFAULT_SETTLE_MS when undefined).
 */
export async function withPage(
  browser,
  origin,
  route,
  matrixCase,
  fn,
  masks,
  settleMs,
) {
  const { context, page } = await openPage(
    browser,
    routeUrl(origin, route),
    matrixCase,
  );
  try {
    await quiet(page, masks ?? [], settleMs ?? DEFAULT_SETTLE_MS);
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

/**
 * Leaves the masked regions out of every screenshot that follows on this page: each is made invisible (its box stays,
 * so nothing moves, and what is drawn above it, such as an open menu over an autoplay video, still shows), and a
 * masked dialog draws no ::backdrop. Done with a constructed stylesheet, which a page's Content-Security-Policy does
 * not block. Playwright's own screenshot mask paints over everything in the region, open menus included.
 */
export async function hideMasks(page, masks = []) {
  if (!masks.length) return;
  await page
    .evaluate((masks) => {
      const sheet = new CSSStyleSheet();
      for (const m of masks) {
        try {
          sheet.insertRule(
            `:is(${m}), :is(${m}) * { visibility: hidden !important; }`,
          );
          sheet.insertRule(
            `:is(${m})::backdrop { background: transparent !important; backdrop-filter: none !important; }`,
          );
        } catch {
          // An invalid selector is reported by the check's argument parsing.
        }
      }
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }, masks)
    .catch(() => {});
}

/** Navigates an open page back to the route and settles it, so each activation starts from the same state. */
export async function reload(page, origin, route) {
  await page.goto(routeUrl(origin, route), { waitUntil: "load" });
  await settle(page);
}

/** A non-negative number (of CSS pixels, unless `unit` says otherwise) from a flag, or an error naming the flag. */
export function pixels(flag, value, fallback, unit = "CSS pixels") {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value === "" || !Number.isFinite(n) || n < 0)
    throw new Error(
      `${flag} must be a number of ${unit}, 0 or more (got "${value}")`,
    );
  return n;
}

/**
 * Parses the flags every check shares (--prod, --target, --route, --matrix, --out, --json, --help) plus `extra`
 * parseArgs options. `need` lists the flags that must be present.
 */
export function parseArgsFor(
  argv,
  { extra = {}, need = ["prod", "target", "route"] } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      prod: { type: "string" },
      target: { type: "string" },
      route: { type: "string", multiple: true },
      matrix: { type: "string" },
      out: { type: "string" },
      mask: { type: "string", multiple: true },
      "settle-ms": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      ...extra,
    },
  });
  if (values.help) return { help: true };
  for (const flag of need) {
    if (flag === "route") {
      if (!values.route?.length)
        throw new Error("--route <path> is required (repeatable)");
    } else if (!values[flag]) throw new Error(`--${flag} <url> is required`);
  }
  for (const selector of values.mask ?? []) validateMask(selector);
  for (const route of values.route ?? []) validateRoute(route);
  validateRouteSet(values.route);
  const { "settle-ms": settle, ...rest } = values;
  return {
    ...rest,
    settleMs: pixels("--settle-ms", settle, DEFAULT_SETTLE_MS, "milliseconds"),
    route: values.route ?? [],
    mask: values.mask ?? [],
    matrix: values.matrix ?? DEFAULT_MATRIX,
    out: values.out ?? DEFAULT_OUT,
  };
}

/** One line per finding, for the terminal. */
export function formatFinding(f) {
  const where = [
    f.route,
    f.width !== undefined ? `${f.width}px` : undefined,
    f.state,
  ]
    .filter((p) => p !== undefined && p !== "")
    .join(" ");
  return `${f.check}  ${f.kind}${where ? `  ${where}` : ""}  ${f.message}`;
}

/**
 * The CLI of one check: parse, load the matrix before any browser starts, run, print, write
 * <out>/<check>.json and exit 1 on any finding.
 */
export async function runCli({ check, help, parseCliArgs, runCheck, summary }) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(help);
    return;
  }
  const cases = loadMatrix(args.matrix);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  let report;
  try {
    report = await runCheck(browser, {
      ...args,
      routes: args.route,
      cases,
    });
  } finally {
    await browser.close();
  }
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `${check}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.ok ? "ok  " : "FAIL"}  ${check}  (${file})`);
    for (const f of report.findings) console.log(`      ${formatFinding(f)}`);
  }
  for (const line of summary?.(report, args) ?? []) console.log(line);
  if (!report.ok) process.exitCode = 1;
}
