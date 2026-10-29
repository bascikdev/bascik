#!/usr/bin/env node
// Presence by route: for every route, in a fresh browser context (no cookies, no storage) and again after dismissing,
// inventory the fixed, sticky and overlay layers: banners, notices, dialogs, live regions and anything covering a
// viewport edge. The target must match per route, including the routes where a layer is absent, and a dismissal must
// persist across routes as it does in production. Reports missing, extra and wrong trigger state per route.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
//
// Why: a cookie banner present on only a couple of pages was missed. A check that only looks at the routes someone
// opened, with whatever cookies the browser already had, never sees it.
import { contextOptions, routeUrl, settle } from "./lib/capture.mjs";
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  normalize,
  parseArgsFor,
  result,
  routesOf,
  runCli,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "presence-by-route";

/** Each route is inventoried fresh, then after every dismissible layer on every route was dismissed once. */
export const STATES = Object.freeze(["fresh", "dismissed"]);

/** Elements that are presence by what they are, wherever they sit. Fixed, sticky and edge layers are found by style. */
export const PRESENCE_SELECTOR =
  'dialog, [role="dialog"], [role="alertdialog"], [aria-live], [role="alert"], [role="status"], [aria-modal="true"]';

/** Accessible names of the controls that dismiss a banner or notice. "Manage preferences" and "Learn more" are not. */
export const DISMISS_NAME =
  /^(?:accept(?: all(?: cookies)?)?|accept and close|allow(?: all)?|agree|i agree|ok(?:ay)?|got it|close|dismiss|no,? thanks|reject all|decline|continue|[x×✕])$/i;

/** A layer must keep the page stable this long before the inventory counts (a banner that slides in late). */
const STABLE_MS = 750;
const MAX_WAIT_MS = 5000;

const HELP = `Usage: node presence-by-route.mjs --prod <url> --target <url> --route <path>... [options]

For every route and matrix case, opens the page in a fresh browser context (no cookies, no storage) and waits until
the page has been stable for ${STABLE_MS} ms, so a banner that slides in after load is seen. It inventories every
fixed or sticky element, dialog and alert dialog, live region and absolutely positioned layer along a viewport edge,
named by role and accessible name (never by class; a live region without a name by its test id, id or place, never
by the text it rotates through). Then, in one context per side, it dismisses each dismissible
layer once (a button named Accept, Accept all, Close, Got it, Dismiss and the like, or a --dismiss selector) on every
route, and inventories every route again: a dismissal that persists across routes in production must persist on the
target. Reports per route and case: missing, extra, and trigger (a layer that comes back after it was dismissed, or
the reverse). Exits 1 on any finding.

Options:
  --prod <url>           Live production origin
  --target <url>         Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>         Route to inventory (repeatable, required; pass every route, presence differs per route)
  --dismiss <selector>   Another control that dismisses a layer, such as '[data-consent="accept"]' (repeatable)
  --mask <selector>      A documented dynamic region to leave out (repeatable)
  --matrix <file>        Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>            Report folder (default artifacts/checks)
  --json                 Print the report as JSON
  --help                 Show this message`;

/**
 * Why an element counts as presence, from its measured facts ({ tag, position, role, ariaLive, visible, rect,
 * viewport }): fixed, sticky, dialog, live, or edge (absolutely positioned along a viewport edge). Hidden elements
 * and ordinary flow content never count.
 */
export function presenceReasons(info) {
  if (!info.visible) return [];
  const reasons = [];
  if (info.position === "fixed") reasons.push("fixed");
  if (info.position === "sticky") reasons.push("sticky");
  if (
    info.tag === "DIALOG" ||
    info.role === "dialog" ||
    info.role === "alertdialog"
  )
    reasons.push("dialog");
  const live =
    (info.ariaLive && info.ariaLive !== "off") ||
    info.role === "alert" ||
    info.role === "status";
  if (live) reasons.push("live");
  if (info.position === "absolute") {
    const { x, y, width, height } = info.rect;
    const vw = info.viewport.width;
    const vh = info.viewport.height;
    const near = (a, b) => Math.abs(a - b) <= 1;
    const wide = width >= vw / 2;
    const tall = height >= vh / 2;
    if (
      (wide && (near(y, 0) || near(y + height, vh))) ||
      (tall && (near(x, 0) || near(x + width, vw)))
    )
      reasons.push("edge");
  }
  return reasons;
}

/**
 * The name of a layer on both sides: role and accessible name when it has both, otherwise tag and name or text.
 * Whitespace is normalized and class names are never used, so a div and a section with one role match. A live region
 * without a name ({ live: true }) is named by its anchor (its data-testid, its id, or its place among the live regions)
 * and never by its text: a ticker or a status line changes its text by design, and reading it at another moment on
 * each side must not make two layers out of one.
 */
export function presenceKey({ tag, role, name, text, live, anchor }) {
  if (role && normalize(name)) return `${role}:${normalize(name)}`;
  if (normalize(name)) return `${tag}:${normalize(name)}`;
  if (live) return `${role ?? tag}#${anchor ?? "live"}`;
  return `${tag}:${normalize(text).slice(0, 60).trim()}`;
}

const snapshotId = (s) => `${s.route} ${s.width} ${s.state}`;

/**
 * Compares inventories ([{ route, width, state, items: [{ key, reasons }] }]). Kinds: missing (production shows it,
 * the target does not), extra (the reverse) and trigger (it comes back after a dismissal production keeps, or the
 * reverse). A layer already reported in the fresh state is not reported again after dismissal. A route, case or state
 * production has and the target lacks is an error naming it.
 */
export function diffPresence(prod, target) {
  const byId = new Map(target.map((s) => [snapshotId(s), s]));
  const findings = [];
  const reported = new Set();
  const order = [...prod].sort(
    (a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state),
  );
  for (const p of order) {
    const t = byId.get(snapshotId(p));
    if (!t)
      throw new Error(
        `presence-by-route: the target has no "${p.state}" inventory for ${p.route} at ${p.width} px`,
      );
    const where = { route: p.route, width: p.width, state: p.state };
    const fresh = (snapshots, s) =>
      snapshots.find(
        (x) =>
          x.route === s.route && x.width === s.width && x.state === "fresh",
      );
    const has = (snap, key) => snap?.items.some((i) => i.key === key) ?? false;
    const pKeys = new Set(p.items.map((i) => i.key));
    const tKeys = new Set(t.items.map((i) => i.key));
    const id = (key) => `${p.route} ${p.width} ${key}`;
    for (const key of pKeys) {
      if (tKeys.has(key) || reported.has(id(key))) continue;
      reported.add(id(key));
      const dismissedHere =
        p.state === "dismissed" && has(fresh(target, t), key);
      findings.push(
        dismissedHere
          ? finding(
              CHECK,
              "trigger",
              `${key} on ${p.route} at ${p.width} px: production shows it again after the dismissal; the target keeps it dismissed`,
              { ...where, key },
            )
          : finding(
              CHECK,
              "missing",
              `${key} is on ${p.route} at ${p.width} px (${p.state}) in production, but not on the target`,
              { ...where, key },
            ),
      );
    }
    for (const key of tKeys) {
      if (pKeys.has(key) || reported.has(id(key))) continue;
      reported.add(id(key));
      const cameBack = p.state === "dismissed" && has(fresh(prod, p), key);
      findings.push(
        cameBack
          ? finding(
              CHECK,
              "trigger",
              `${key} on ${p.route} at ${p.width} px: production keeps it dismissed once it was dismissed, but on the target it comes back after the dismissal`,
              { ...where, key },
            )
          : finding(
              CHECK,
              "extra",
              `${key} is on ${p.route} at ${p.width} px (${p.state}) on the target, but production has no such layer there`,
              { ...where, key },
            ),
      );
    }
  }
  return findings;
}

/** In the page: the presence layers now, outermost only, with their dismiss controls. */
function inventory(arg) {
  const items = [];
  const viewport = { width: innerWidth, height: innerHeight };
  const candidates = new Set(document.querySelectorAll(arg.selector));
  for (const el of document.body.querySelectorAll("*")) {
    const p = getComputedStyle(el).position;
    if (p === "fixed" || p === "sticky" || p === "absolute") candidates.add(el);
  }
  const layers = [];
  for (const el of candidates) {
    if (isMasked(el, arg.masks)) continue;
    const r = el.getBoundingClientRect();
    const inView =
      r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    const info = {
      tag: tagOf(el),
      position: getComputedStyle(el).position,
      role: el.getAttribute("role"),
      ariaLive: el.getAttribute("aria-live"),
      visible: isRendered(el) && inView,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport,
    };
    const reasons = presenceReasonsInPage(info);
    if (!reasons.length) continue;
    layers.push({ el, info, reasons });
  }
  const liveRegions = [
    ...document.querySelectorAll(
      '[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"]',
    ),
  ];
  for (const layer of layers) {
    if (layers.some((o) => o !== layer && o.el.contains(layer.el))) continue;
    const el = layer.el;
    const ariaName =
      norm(el.getAttribute("aria-label")) ||
      norm(
        (el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
    const dismiss = [];
    if (!layer.reasons.every((r) => r === "sticky"))
      for (const control of [
        ...(el.matches("button, [role=button]") ? [el] : []),
        ...el.querySelectorAll("button, [role=button], a"),
      ])
        if (
          isRendered(control) &&
          new RegExp(arg.dismissName, "i").test(accName(control))
        )
          dismiss.push(selectorOf(control));
    const live = layer.reasons.includes("live");
    items.push({
      tag: tagOf(el),
      role:
        el.getAttribute("role") ?? (tagOf(el) === "DIALOG" ? "dialog" : null),
      name: ariaName,
      // A live region's text changes by design: it neither names the layer nor counts toward a stable page.
      text: live ? "" : norm(el.textContent).slice(0, 60),
      live,
      anchor: live
        ? el.getAttribute("data-testid") ||
          el.id ||
          String(liveRegions.indexOf(el) + 1)
        : undefined,
      reasons: layer.reasons,
      dismiss,
    });
  }
  return items;
}

/** Waits until the inventory has not changed for STABLE_MS, at most MAX_WAIT_MS, and returns it. */
async function stableInventory(page, dismissSelectors, masks = []) {
  await settle(page);
  const read = () =>
    inPage(
      page,
      `function (arg) { const presenceReasonsInPage = ${presenceReasons}; return (${inventory})(arg); }`,
      {
        selector: PRESENCE_SELECTOR,
        dismissName: DISMISS_NAME.source,
        masks,
      },
    );
  const start = Date.now();
  let last = await read();
  let stableSince = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    await page.waitForTimeout(150);
    const now = await read();
    if (JSON.stringify(now) !== JSON.stringify(last)) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= STABLE_MS) break;
  }
  const extra = [];
  for (const selector of dismissSelectors)
    if (
      await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false)
    )
      extra.push(selector);
  return last.map((item, i) => ({
    ...item,
    dismiss: i === 0 ? [...item.dismiss, ...extra] : item.dismiss,
  }));
}

const toItems = (raw) =>
  raw.map((i) => ({ key: presenceKey(i), reasons: i.reasons }));

/** Inventories one side: each route fresh, then each route after dismissing everything once. */
async function inventorySide(
  browser,
  origin,
  routes,
  c,
  dismissSelectors,
  masks,
) {
  const snapshots = [];
  for (const route of routes) {
    const context = await browser.newContext(contextOptions(c));
    try {
      const page = await context.newPage();
      await page.goto(routeUrl(origin, route), { waitUntil: "load" });
      const raw = await stableInventory(page, dismissSelectors, masks);
      snapshots.push({
        route,
        width: c.width,
        state: "fresh",
        items: toItems(raw),
      });
    } finally {
      await context.close();
    }
  }
  const context = await browser.newContext(contextOptions(c));
  try {
    const page = await context.newPage();
    for (const route of routes) {
      await page.goto(routeUrl(origin, route), { waitUntil: "load" });
      const raw = await stableInventory(page, dismissSelectors, masks);
      for (const selector of new Set(raw.flatMap((i) => i.dismiss))) {
        const control = page.locator(selector).first();
        if (!(await control.isVisible().catch(() => false))) continue;
        await control.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(200);
      }
    }
    for (const route of routes) {
      await page.goto(routeUrl(origin, route), { waitUntil: "load" });
      const raw = await stableInventory(page, [], masks);
      snapshots.push({
        route,
        width: c.width,
        state: "dismissed",
        items: toItems(raw),
      });
    }
  } finally {
    await context.close();
  }
  return snapshots;
}

/** Resolves to { check, ok, findings, inventory }. Options: prod, target, routes, cases, dismiss. */
export async function runCheck(browser, options) {
  const routes = routesOf(options);
  const dismiss = options.dismiss ?? [];
  const masks = masksOf(options);
  const findings = [];
  const inventories = [];
  for (const c of casesOf(options)) {
    const [prod, target] = await Promise.all([
      inventorySide(browser, options.prod, routes, c, dismiss, masks),
      inventorySide(browser, options.target, routes, c, dismiss, masks),
    ]);
    inventories.push({ width: c.width, prod, target });
    findings.push(...diffPresence(prod, target));
  }
  return result(CHECK, findings, { inventory: inventories });
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: { dismiss: { type: "string", multiple: true } },
  });
  if (args.help) return args;
  return { ...args, dismiss: args.dismiss ?? [] };
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
