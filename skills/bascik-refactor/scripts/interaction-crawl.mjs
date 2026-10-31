#!/usr/bin/env node
// Interaction crawl: find every interactive element on a production route, activate each one, record what it did,
// and replay it on the Bascik target by stable anchors. Reports effects that are missing or different.
// Dependency-free; Node.js 22.22+; needs playwright (or @playwright/test) in your project. Read-only toward both
// sites: plain navigation links and submit buttons are never activated.
//
// Why: a hero button that scrolls to a section did nothing on the target, and a hand-written interactions.json only
// compared open and closed states for the steps someone remembered to write down.
import { inPage, onElementSource } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  normalize,
  parseArgsFor,
  reload,
  result,
  routesOf,
  DEFAULT_SETTLE_MS,
  settleOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { routeUrl, settle } from "./lib/capture.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "interaction-crawl";

const HELP = `Usage: node interaction-crawl.mjs --prod <url> --target <url> --route <path>... [options]

Discovers every interactive element on each production route (the selector below; any element with a click or
hover listener, found with CDP DOMDebugger.getEventListeners; with a delegated click listener on document, body or
window, the elements with a pointer cursor or a data attribute naming an in-page target; and the triggers of menus
that open on CSS :hover), activates each one from a fresh load (a click, or a hover) and records the effect: scroll
distance, the heading scrolled to and where it lands (a heading under a sticky header is a finding), location.hash,
URL, aria-expanded, open and hidden changes, form values (a quantity stepper), content moved inside a clipped region
(a carousel track that slides), newly visible elements and the focused element. A control that opens something (a
dialog, a menu, a disclosure) is opened again and the controls inside it are crawled too, one level deep (a dialog's
Close). What the page changes on its own with no activation (a carousel, a ticker, a late banner, a modal on a timer)
is not counted as any control's effect. Then it finds the same element on the target by test id, role and accessible
name, in-page href or text, does the same, and reports missing elements and missing or different effects. An element
whose selector finds nothing after the fresh load (an id that changes per load) is found again by the same anchors; a
target element that still cannot be activated is reported as unmeasured, never passed. Exits 1 on any finding.

Options:
  --prod <url>      Live production origin
  --target <url>    Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>    Route to crawl (repeatable, required)
  --mask <selector> A documented dynamic region to leave out, such as a carousel (repeatable)
  --settle-ms <ms>  Least time after navigation before measuring (default 5000)
  --matrix <file>   Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>       Report folder (default artifacts/checks)
  --json            Print the report as JSON
  --help            Show this message`;

/**
 * Elements the crawl activates without needing a listener. Plain links (a[href] to another page) and submit buttons
 * are left out: activating them would navigate away or post a form.
 */
export const INTERACTIVE_SELECTOR = [
  "button",
  "summary",
  'a[href^="#"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  "[aria-controls]",
  "[aria-expanded]",
  '[tabindex="0"]',
].join(", ");

/** Event types that make an element interactive when a listener sits on the element itself. */
const LISTENER_TYPES = new Set([
  "click",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "touchstart",
  "keydown",
]);

/** Event types that make an element a hover target: the crawl moves the pointer onto it instead of clicking. */
const HOVER_TYPES = new Set([
  "mouseenter",
  "mouseover",
  "pointerenter",
  "pointerover",
]);

/** How long the crawl watches a page with no activation, to learn what changes on its own (a carousel, a ticker). */
export const VOLATILE_MS = 2500;

/** A scroll smaller than this many CSS pixels is not an effect (sub-pixel focus scrolls, rounding). */
const SCROLL_MIN = 8;

/**
 * Where the heading an in-page link scrolls to lands may differ by this many CSS pixels (a sticky header that shrinks
 * while the page scrolls) before it is a finding; a scroll-padding-top lost under a sticky header is far more.
 */
export const LANDING_TOLERANCE = 24;

/** The most controls crawled inside one opened dialog, menu or disclosure. */
const NESTED_MAX = 12;

/** Elements whose appearance counts as an effect: text a visitor reads, images and dialogs, not wrappers. */
const SHOWN_SELECTOR =
  'a, button, h1, h2, h3, h4, h5, h6, p, label, summary, img, dialog, [role="dialog"], [role="menu"], [role="menuitem"], [role="tabpanel"], [role="tooltip"]';

/** In the page: the anchor that finds `el` again on the other side, and how it is activated (click or hover). */
function anchorOf(el, mode) {
  const href = el.getAttribute("href");
  return {
    mode: mode ?? "click",
    tag: tagOf(el),
    role: roleOf(el),
    name: accName(el),
    text: norm(el.textContent).slice(0, 70),
    href: href && href.startsWith("#") ? href : null,
    testId: el.getAttribute("data-testid"),
  };
}

/** In the page: whether the crawl may activate `el` at all (a hover never leaves the page, so any link may be hovered). */
export function activatable(el, mode, masks) {
  if (!isRendered(el)) return false;
  if (isMasked(el, masks)) return false;
  if (el.closest("[disabled], [inert]")) return false;
  const tag = tagOf(el);
  const type = String(el.getAttribute("type") ?? "").toLowerCase();
  if (tag === "BUTTON" && el.form && (type === "" || type === "submit"))
    return false;
  if (tag === "INPUT" && ["submit", "image", "reset"].includes(type))
    return false;
  const link = el.closest("a[href]");
  if (link && mode !== "hover") {
    // A javascript: link runs in this page. A data: or vbscript: link, like any other scheme, opens another document
    // or nothing, so the crawl never clicks it. The parsed protocol is lower case, whatever the author wrote.
    if (!link.getAttribute("href").startsWith("#")) {
      const to = new URL(link.href, location.href);
      if (to.protocol === "data:" || to.protocol === "vbscript:") return false;
      if (
        to.protocol !== "javascript:" &&
        to.origin + to.pathname !== location.origin + location.pathname
      )
        return false;
    }
  }
  return true;
}

/**
 * In the page: every activatable element matching the selector, with its anchor; with `delegated`, also the elements a
 * click listener on document, body or window handles through event delegation (they show a pointer cursor or name an
 * in-page target in a data attribute); and the triggers of menus that open on CSS :hover (a hidden list inside nav or
 * header next to a link or button), to hover.
 */
function discoverBySelector(arg) {
  const items = [];
  const seen = new Set();
  const add = (el, reason, mode) => {
    const selector = selectorOf(el);
    const id = `${mode} ${selector}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ selector, anchor: anchorOf(el, mode), reason });
  };
  const found = [...document.querySelectorAll(arg.selector)].filter((el) =>
    activatable(el, "click", arg.masks),
  );
  for (const el of found) add(el, "selector", "click");
  if (arg.delegated) {
    const pointer = (el) => getComputedStyle(el).cursor === "pointer";
    for (const el of document.body.querySelectorAll("*")) {
      if (found.some((f) => f === el || f.contains(el) || el.contains(f)))
        continue;
      if (el.closest("a[href], label")) continue;
      const namesTarget = [...el.attributes].some(
        (a) => a.name.startsWith("data-") && /^#[\w-]+$/.test(a.value),
      );
      const ownPointer =
        pointer(el) && !(el.parentElement && pointer(el.parentElement));
      if (!namesTarget && !ownPointer) continue;
      if (!activatable(el, "click", arg.masks)) continue;
      add(el, "delegated", "click");
    }
  }
  for (const list of document.querySelectorAll(
    'nav ul, nav ol, nav [role="menu"], header ul, header ol, header [role="menu"]',
  )) {
    if (isRendered(list) || isMasked(list, arg.masks)) continue;
    const parent = list.parentElement;
    if (!parent) continue;
    const trigger = [...parent.querySelectorAll("a, button")].find(
      (t) => !list.contains(t) && isRendered(t),
    );
    if (trigger && activatable(trigger, "hover", arg.masks))
      add(trigger, "css-hover", "hover");
  }
  return items;
}

/**
 * Every interactive element of the loaded page: selector matches in document order, elements a delegated click
 * listener handles, triggers of CSS :hover menus, then elements whose only sign of interactivity is a click or hover
 * listener on the element itself (found through CDP DOMDebugger.getEventListeners). Each item is
 * { selector, anchor: { mode: "click" | "hover", ... }, reason: "selector" | "delegated" | "css-hover" | "listener" }.
 * Elements inside a mask are left out.
 */
export async function discover(page, masks = []) {
  const cdp = await page.context().newCDPSession(page);
  const listenerItems = [];
  let delegated = false;
  try {
    const { result: doc } = await cdp.send("Runtime.evaluate", {
      expression: "document",
      objectGroup: CHECK,
    });
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: doc.objectId,
      depth: -1,
      pierce: true,
    });
    const { result: win } = await cdp.send("Runtime.evaluate", {
      expression: "window",
      objectGroup: CHECK,
    });
    const { listeners: windowListeners } = await cdp.send(
      "DOMDebugger.getEventListeners",
      { objectId: win.objectId },
    );
    if (windowListeners.some((l) => LISTENER_TYPES.has(l.type)))
      delegated = true;
    const nodes = new Map();
    for (const l of listeners) {
      const mode = LISTENER_TYPES.has(l.type)
        ? "click"
        : HOVER_TYPES.has(l.type)
          ? "hover"
          : null;
      if (!mode || !l.backendNodeId) continue;
      const modes = nodes.get(l.backendNodeId) ?? new Set();
      modes.add(mode);
      nodes.set(l.backendNodeId, modes);
    }
    for (const [backendNodeId, modes] of nodes) {
      const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId,
        objectGroup: CHECK,
      });
      if (!object?.objectId || object.subtype !== "node") continue;
      const { result: described } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: onElementSource(
          `function (el, arg) { ${anchorOf}\n${activatable}\nif (el.nodeType !== 1 || el === document.body || el === document.documentElement) return { delegated: arg.modes.includes("click") }; return arg.modes.filter((mode) => activatable(el, mode, arg.masks)).map((mode) => ({ selector: selectorOf(el), anchor: anchorOf(el, mode), reason: "listener" })); }`,
          { modes: [...modes], masks },
        ),
      });
      const value = described?.value;
      if (Array.isArray(value)) listenerItems.push(...value);
      else if (value?.delegated) delegated = true;
    }
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: CHECK });
  } finally {
    await cdp.detach().catch(() => {});
  }
  const found = await inPage(
    page,
    `function (arg) { ${anchorOf}\n${activatable}\nreturn (${discoverBySelector})(arg); }`,
    { selector: INTERACTIVE_SELECTOR, masks, delegated },
  );
  const seen = new Set(
    found.map((item) => `${item.anchor.mode} ${item.selector}`),
  );
  for (const item of listenerItems) {
    const id = `${item.anchor.mode} ${item.selector}`;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(item);
  }
  return found;
}

/** In the page: the state an activation can change. Masked regions and the headings in `arg.skip` do not count. */
function captureState(arg) {
  const attrs = {};
  for (const el of document.querySelectorAll(
    "[aria-expanded], [aria-selected], [aria-pressed], details, dialog, [hidden], [popover]",
  )) {
    if (isMasked(el, arg.masks)) continue;
    attrs[selectorOf(el)] = {
      "aria-expanded": el.getAttribute("aria-expanded"),
      "aria-selected": el.getAttribute("aria-selected"),
      "aria-pressed": el.getAttribute("aria-pressed"),
      open:
        tagOf(el) === "DETAILS" || tagOf(el) === "DIALOG"
          ? String(el.open)
          : null,
      hidden: String(el.hidden),
    };
  }
  // Form values (a quantity stepper) and content moved inside a clipped region (a carousel track translated or
  // scrolled), keyed by element like the attributes above.
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (isMasked(el, arg.masks)) continue;
    const type = String(el.type ?? "").toLowerCase();
    if (type === "password" || type === "hidden" || type === "file") continue;
    const entry = (attrs[selectorOf(el)] ??= {});
    entry.value =
      type === "checkbox" || type === "radio"
        ? String(el.checked)
        : String(el.value);
  }
  const translation = (el) => {
    const t = getComputedStyle(el).transform;
    if (!t || t === "none") return [0, 0];
    const m = new DOMMatrixReadOnly(t);
    return [Math.round(m.m41), Math.round(m.m42)];
  };
  for (const box of document.body.querySelectorAll("*")) {
    if (box.closest("svg") || isMasked(box, arg.masks)) continue;
    const cs = getComputedStyle(box);
    if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    if (!isRendered(box)) continue;
    const entry = (attrs[selectorOf(box)] ??= {});
    entry.scroll = `${Math.round(box.scrollLeft)},${Math.round(box.scrollTop)}`;
    for (const child of box.querySelectorAll(":scope > *, :scope > * > *")) {
      const [x, y] = translation(child);
      (attrs[selectorOf(child)] ??= {}).shift = `${x},${y}`;
    }
  }
  const shown = [
    ...new Set(
      [...document.querySelectorAll(arg.shown)]
        .filter((el) => isRendered(el) && !isMasked(el, arg.masks))
        .map((el) => textKey(el)),
    ),
  ];
  const trigger = arg.trigger ? document.querySelector(arg.trigger) : null;
  const active = document.activeElement;
  let focused = null;
  if (
    active &&
    active !== document.body &&
    active !== document.documentElement &&
    active !== trigger &&
    !isMasked(active, arg.masks)
  )
    focused = textKey(active);
  let scrollTarget = null;
  let landing = null;
  const skip = new Set(arg.skip ?? []);
  for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (!isRendered(h) || isMasked(h, arg.masks) || skip.has(textKey(h)))
      continue;
    const r = h.getBoundingClientRect();
    if (r.top >= -2 && r.top < innerHeight) {
      scrollTarget = textKey(h);
      // Where it lands, and whether a fixed or sticky layer covers it there (a sticky header without scroll-padding).
      // A modal dialog and its backdrop are looked through: a modal covers the whole page, not the spot the scroll
      // landed on (a newsletter modal on a timer opens mid-measurement on whichever side loaded slower).
      const modal = (el) => {
        try {
          return Boolean(el.closest(":modal"));
        } catch {
          return Boolean(el.closest("dialog[open]"));
        }
      };
      const hit = document
        .elementsFromPoint(
          Math.min(
            innerWidth - 1,
            Math.max(0, r.left + Math.min(r.width, 40) / 2),
          ),
          Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)),
        )
        .find((el) => !modal(el));
      const cover =
        hit && !h.contains(hit) && !hit.contains(h) ? layerOf(hit) : null;
      landing = { top: Math.round(r.top), covered: Boolean(cover), cover };
      break;
    }
  }
  const href = location.href.split("#")[0];
  return {
    attrs,
    shown,
    focused,
    scrollY,
    scrollTarget,
    landing,
    hash: location.hash,
    url: href.startsWith(arg.base) ? `/${href.slice(arg.base.length)}` : href,
  };
}

/**
 * Where a scrolled-to heading landed, without a cover the page puts up by itself: a layer whose attributes change with
 * no activation (a cookie banner that slides in, a modal on a timer) is not what the scroll forgot to clear.
 */
function landingOf(landing, skipSelectors) {
  if (!landing) return null;
  const { cover, ...rest } = landing;
  if (cover && skipSelectors.has(cover)) return { ...rest, covered: false };
  return rest;
}

/**
 * Compares two captureState results into the effect of one activation. `volatile` ({ selectors, shown }) is what the
 * page changes on its own with no activation (a carousel, a ticker, a banner that slides in late): those elements'
 * attribute changes and those texts are not the control's effect.
 */
export function effectOf(before, after, volatile = {}) {
  const skipSelectors = new Set(volatile.selectors ?? []);
  const skipShown = new Set(volatile.shown ?? []);
  const changed = [];
  for (const selector of new Set([
    ...Object.keys(before.attrs),
    ...Object.keys(after.attrs),
  ])) {
    if (skipSelectors.has(selector)) continue;
    const a = before.attrs[selector] ?? {};
    const b = after.attrs[selector] ?? {};
    for (const attr of [
      "aria-expanded",
      "aria-selected",
      "aria-pressed",
      "open",
      "hidden",
    ]) {
      const from = a[attr] ?? (attr === "hidden" ? "false" : null);
      const to = b[attr] ?? (attr === "hidden" ? "false" : null);
      if (from !== to) changed.push(`${attr}: ${from} -> ${to}`);
    }
    if ((a.value ?? null) !== (b.value ?? null) && a.value !== undefined)
      changed.push(`value: "${a.value}" -> "${b.value ?? ""}"`);
    // Content moved in a clipped region: the direction only, so a slide of another width still matches.
    for (const [attr, what] of [
      ["shift", "content of a clipped region moves"],
      ["scroll", "a clipped region scrolls"],
    ]) {
      if (a[attr] === undefined || b[attr] === undefined) continue;
      const [x0, y0] = a[attr].split(",").map(Number);
      const [x1, y1] = b[attr].split(",").map(Number);
      const sign = attr === "scroll" ? -1 : 1;
      const dx = (x1 - x0) * sign;
      const dy = (y1 - y0) * sign;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      const way =
        Math.abs(dx) >= Math.abs(dy)
          ? dx < 0
            ? "left"
            : "right"
          : dy < 0
            ? "up"
            : "down";
      changed.push(`${what} ${way}`);
    }
  }
  const was = new Set(before.shown);
  const scrollDelta = Math.round(after.scrollY - before.scrollY);
  return {
    scrollDelta,
    scrollTarget:
      Math.abs(scrollDelta) >= SCROLL_MIN && !skipShown.has(after.scrollTarget)
        ? after.scrollTarget
        : null,
    landing:
      Math.abs(scrollDelta) >= SCROLL_MIN && !skipShown.has(after.scrollTarget)
        ? landingOf(after.landing, skipSelectors)
        : null,
    hash: after.hash,
    url: after.url,
    changed: changed.sort(),
    shown: after.shown
      .filter((key) => !was.has(key) && !skipShown.has(key))
      .sort(),
    focused: skipShown.has(after.focused) ? null : after.focused,
  };
}

/** In the page: lets smooth scrolling, transitions and a short timer run out after an activation. */
async function afterActivation(arg) {
  await scrollSettled(3000);
  await animationsDone(2000);
  // Then until every fixed or sticky layer stops moving (at most 1 s): a sticky header that shrinks once the scroll
  // passes a threshold starts its transition a frame late, and where a heading lands is measured against its final box.
  const layers = [...document.body.querySelectorAll("*")].filter((el) => {
    const position = getComputedStyle(el).position;
    return position === "fixed" || position === "sticky";
  });
  const boxes = () =>
    layers
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${Math.round(r.top)},${Math.round(r.bottom)},${Math.round(r.left)},${Math.round(r.right)}`;
      })
      .join(";");
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const end = performance.now() + 1000;
  let last = boxes();
  for (let still = 0; layers.length && still < 3 && performance.now() < end;) {
    await frame();
    const now = boxes();
    still = now === last ? still + 1 : 0;
    last = now;
  }
  await animationsDone(1000);
  // Then until the DOM outside the masks has been still for 400 ms (at most 2.5 s): a banner that hides itself with a
  // timer once its slide-out transition ends is hidden on both sides before the state is read.
  await new Promise((done) => {
    let timer = setTimeout(finish, 400);
    const cap = setTimeout(finish, 2500);
    const observer = new MutationObserver((records) => {
      if (
        records.every((r) =>
          isMasked(
            r.target.nodeType === 1 ? r.target : r.target.parentElement,
            arg?.masks,
          ),
        )
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(finish, 400);
    });
    function finish() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      done();
    }
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await animationsDone(1000);
}

/** Moves the pointer off the page content, so a hover left over from the last activation opens nothing. */
async function parkPointer(page) {
  await page.mouse.move(0, 0).catch(() => {});
}

/**
 * What the page does on its own, with no activation: loads the route fresh, records its state and watches it for
 * VOLATILE_MS, and at least until `settleMs` after load (see DEFAULT_SETTLE_MS in lib/checks.mjs). Resolves to { selectors, shown }: the elements whose attributes changed and the texts that appeared
 * or went away. A carousel that advances on a timer, a ticker or a late banner then does not count as the effect of
 * whichever control the crawl happened to activate. A region that changes more slowly than this is masked instead.
 */
export async function observeVolatile(
  page,
  origin,
  route,
  masks = [],
  settleMs = DEFAULT_SETTLE_MS,
) {
  const arg = { shown: SHOWN_SELECTOR, base: routeUrl(origin, "/"), masks };
  // The attributes as the document is parsed, before any timer runs: a banner that unhides itself 600 ms after load
  // changes after this on both sides, however long the page takes to settle.
  await page.goto(routeUrl(origin, route), { waitUntil: "domcontentloaded" });
  const early = await inPage(page, captureState, arg).catch(() => null);
  await page.waitForLoadState("load").catch(() => {});
  await settle(page);
  await parkPointer(page);
  // Then as after an activation: a section in view at load fades in once its IntersectionObserver fires, a frame or a
  // slow machine's moment after load. Read before that, its heading counts as changing by itself on one side only,
  // and an in-page link there scrolls to the next heading instead.
  await inPage(page, afterActivation, { masks }).catch(() => {});
  const first = await inPage(page, captureState, arg);
  const selectors = new Set();
  const shown = new Set();
  // At least VOLATILE_MS, and on until the settle time after load, so a modal on a timer is seen to open by itself.
  const sinceLoad = await page.evaluate(() => performance.now());
  const end = Date.now() + Math.max(VOLATILE_MS, settleMs - sinceLoad + 500);
  while (Date.now() < end) {
    await page.waitForTimeout(250);
    const now = await inPage(page, captureState, arg);
    for (const base of early ? [early, first] : [first])
      for (const selector of new Set([
        ...Object.keys(base.attrs),
        ...Object.keys(now.attrs),
      ]))
        if (
          JSON.stringify(base.attrs[selector]) !==
          JSON.stringify(now.attrs[selector])
        )
          selectors.add(selector);
    const before = new Set(first.shown);
    const after = new Set(now.shown);
    for (const key of now.shown) if (!before.has(key)) shown.add(key);
    for (const key of first.shown) if (!after.has(key)) shown.add(key);
  }
  return { selectors: [...selectors], shown: [...shown] };
}

/** Clicks or hovers one element; a covered or animating element gets a DOM click, which still runs its handlers. */
async function press(locator, mode) {
  if (mode === "hover") {
    await locator.hover({ timeout: 2000 }).catch(() => {});
    return;
  }
  try {
    await locator.click({ timeout: 2000 });
  } catch {
    await locator.evaluate((el) => el.click()).catch(() => {});
  }
}

/**
 * In the page: the selector of the one rendered element whose anchor is `arg.anchor` (the same test id; else the same
 * role and accessible name; else the same in-page href; else the same text, always on the same tag), or null when no
 * element or more than one matches (repeated cards whose ids change per load cannot be told apart).
 */
function relocate(arg) {
  const want = arg.anchor;
  const els = [...document.querySelectorAll("*")].filter(
    (el) =>
      tagOf(el) === want.tag && isRendered(el) && !isMasked(el, arg.masks),
  );
  const anchors = els.map((el) => anchorOf(el, want.mode));
  const tries = [
    (c) => want.testId && c.testId === want.testId,
    (c) =>
      norm(want.name) && c.role === want.role && c.name === norm(want.name),
    (c) => want.href && c.href === want.href,
    (c) => norm(want.text) && c.text === norm(want.text),
  ];
  for (const test of tries) {
    const hits = els.filter((_, i) => test(anchors[i]));
    if (hits.length === 1) return selectorOf(hits[0]);
    if (hits.length > 1) return null;
  }
  return null;
}

/**
 * Activates `item` (a click, or a hover for anchor.mode "hover") from a fresh load of the route and returns its
 * effect. When its selector finds nothing after the reload, the element is found again by its anchor (relocate); the
 * effect is null when that fails too (it rendered late, or is one of several look-alikes whose ids change per load). An item found inside an
 * opened layer carries the controls that open it in `via`; they are activated first, without being measured. The
 * element is scrolled into view before the state is recorded, so the scroll a click causes is measured from where the
 * visitor clicks it (a "Back to top" link in the footer), and content that fades in as it scrolls into view is not
 * counted as the click's effect.
 */
export async function activate(page, origin, route, item, options = {}) {
  const { masks = [], volatile = {}, settleMs = DEFAULT_SETTLE_MS } = options;
  const selector = typeof item === "string" ? item : item.selector;
  const mode =
    typeof item === "string" ? "click" : (item.anchor?.mode ?? "click");
  const base = routeUrl(origin, "/");
  await reload(page, origin, route);
  await parkPointer(page);
  for (const step of (typeof item === "string" ? [] : item.via) ?? []) {
    const opener = page.locator(step.selector).first();
    if ((await opener.count()) === 0) return null;
    await press(opener, step.anchor?.mode ?? "click");
    await inPage(page, afterActivation, { masks }).catch(() => {});
  }
  let target = selector;
  if ((await page.locator(target).count()) === 0) {
    // The selector changed between loads (an id a script randomizes per load): find the element by its anchor.
    const again =
      typeof item === "string"
        ? null
        : await inPage(
            page,
            `function (arg) { ${anchorOf}\nreturn (${relocate})(arg); }`,
            { anchor: item.anchor, masks },
          ).catch(() => null);
    if (!again) return null;
    target = again;
  }
  const locator = page.locator(target).first();
  // An element production showed on a timer (a cookie banner's button, a timed modal's Close) is clicked once it shows,
  // on both sides, not before.
  await locator
    .waitFor({ state: "visible", timeout: Math.max(1000, settleMs) })
    .catch(() => {});
  await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await inPage(page, afterActivation, { masks }).catch(() => {});
  const arg = {
    shown: SHOWN_SELECTOR,
    trigger: target,
    base,
    masks,
    skip: volatile.shown ?? [],
  };
  const before = await inPage(page, captureState, arg);
  await press(locator, mode);
  await page.waitForLoadState("load").catch(() => {});
  await inPage(page, afterActivation, { masks }).catch(() => {});
  const after = await inPage(page, captureState, arg);
  return effectOf(before, after, volatile);
}

/**
 * In the page, after a control opened something: for each selector in arg.selectors, whether its element sits in what
 * is open now (an open dialog or details, the element the trigger's aria-controls names, a rendered menu, listbox or
 * popover), so only the controls of the opened layer are crawled next, not content that faded in as the page scrolled.
 */
function insideOpened(arg) {
  const out = [];
  const trigger = document.querySelector(arg.trigger);
  const ids = String(trigger?.getAttribute("aria-controls") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const candidates = [
    ...document.querySelectorAll(
      'dialog[open], details[open], [role="dialog"], [role="menu"], [role="listbox"], [popover]',
    ),
    ...ids.map((id) => document.getElementById(id)).filter(Boolean),
  ];
  for (const el of candidates)
    if (isRendered(el) && !el.contains(trigger)) out.push(el);
  return arg.selectors.map((selector) => {
    const el = document.querySelector(selector);
    return Boolean(el) && out.some((o) => o.contains(el));
  });
}

/** Whether an effect opens something whose controls the crawl should try too (a dialog, a menu, a disclosure). */
export function opensLayer(effect) {
  return Boolean(
    effect?.changed.some(
      (c) =>
        c === "open: false -> true" ||
        c === "aria-expanded: false -> true" ||
        c === "hidden: true -> false",
    ),
  );
}

/**
 * How an anchor reads in a finding: BUTTON "See features", with "(hover)" for a hover target and the control that
 * opens it for one inside a dialog or menu.
 */
const describe = (a) =>
  `${a.tag} "${a.name || a.text}"${a.mode === "hover" ? " (hover)" : ""}${a.via ? ` (inside what ${a.via} opens)` : ""}`;
const anchorKey = (a) =>
  `${a.tag}:${a.name || a.text}${a.mode === "hover" ? " (hover)" : ""}${a.via ? ` in ${a.via}` : ""}`;

/**
 * The index in `candidates` of the target element that is the same as the production `anchor`, or -1. Only a
 * candidate activated the same way (click or hover) matches. Tried in order: the same data-testid, the same role and
 * accessible name, the same in-page href, the same tag and text, then the same text on another tag (a card that
 * became a link). Whitespace is normalized; class names are never used. Indexes in `used` are skipped, so repeated
 * elements pair up in document order.
 */
export function matchAnchor(anchor, candidates, used = new Set()) {
  const mode = anchor.mode ?? "click";
  const free = (c, i) =>
    !used.has(i) &&
    (c.mode ?? "click") === mode &&
    (c.via ?? null) === (anchor.via ?? null);
  const tries = [
    (c) => anchor.testId && c.testId === anchor.testId,
    (c) =>
      normalize(anchor.name) &&
      c.role === anchor.role &&
      normalize(c.name) === normalize(anchor.name),
    (c) => anchor.href && c.href === anchor.href,
    (c) =>
      normalize(anchor.text) &&
      c.tag === anchor.tag &&
      normalize(c.text) === normalize(anchor.text),
    (c) =>
      normalize(anchor.name || anchor.text) &&
      normalize(c.name || c.text) === normalize(anchor.name || anchor.text),
  ];
  for (const test of tries) {
    const i = candidates.findIndex((c, index) => free(c, index) && test(c));
    if (i >= 0) return i;
  }
  return -1;
}

const scrolls = (e) => Math.abs(e.scrollDelta) >= SCROLL_MIN;

/** What an effect does, in words, for a finding about an element the target lacks. */
function effectText(e) {
  if (!e) return "";
  const parts = [];
  if (scrolls(e))
    parts.push(
      `scrolls ${e.scrollDelta} px${e.scrollTarget ? ` to ${e.scrollTarget}` : ""}`,
    );
  if (e.hash) parts.push(`sets location.hash to "${e.hash}"`);
  if (e.changed.length) parts.push(`changes ${e.changed.join(", ")}`);
  if (e.shown.length) parts.push(`shows ${e.shown.join(", ")}`);
  if (e.focused) parts.push(`moves focus to ${e.focused}`);
  return parts.length ? ` (in production it ${parts.join("; ")})` : "";
}

/**
 * Compares production's recorded effects with the target's: [{ anchor, effect }] on each side. Returns findings of
 * kind missing-element (no matching target element), unmeasured (the target element was matched but could not be
 * activated after a fresh load, effect null), missing-effect (production does something the target does not) and
 * different-effect (both act, differently, or the target acts where production does not).
 */
export function diffEffects(prod, target) {
  const findings = [];
  const used = new Set();
  const candidates = target.map((t) => t.anchor);
  for (const p of prod) {
    const i = matchAnchor(p.anchor, candidates, used);
    const fields = { anchor: anchorKey(p.anchor) };
    const who = describe(p.anchor);
    if (i < 0) {
      findings.push(
        finding(
          CHECK,
          "missing-element",
          `${who} is interactive in production${effectText(p.effect)}, but nothing on the target with its test id, role and name, href or text responds to a ${p.anchor.mode === "hover" ? "hover" : "click"}`,
          fields,
        ),
      );
      continue;
    }
    used.add(i);
    const a = p.effect;
    const b = target[i].effect;
    // Production unmeasured (its element was gone after the reload): nothing recorded to hold the target to. The target
    // unmeasured while production did something is not a pass: its effect was never seen.
    if (!a) continue;
    if (!b) {
      findings.push(
        finding(
          CHECK,
          "unmeasured",
          `${who} is on the target, but after a fresh load the crawl found it neither by its selector nor by its test id, role and name, href or text, so its effect was never measured${effectText(a)}; give it a stable id or data-testid`,
          fields,
        ),
      );
      continue;
    }
    const add = (kind, message) =>
      findings.push(finding(CHECK, kind, `${who}: ${message}`, fields));
    if (scrolls(a) && !scrolls(b))
      add(
        "missing-effect",
        `scrolls ${a.scrollDelta} px${a.scrollTarget ? ` to ${a.scrollTarget}` : ""} in production; on the target it does not scroll`,
      );
    else if (!scrolls(a) && scrolls(b))
      add(
        "different-effect",
        `scrolls ${b.scrollDelta} px${b.scrollTarget ? ` to ${b.scrollTarget}` : ""} on the target; production does not scroll`,
      );
    else if (
      scrolls(a) &&
      (a.scrollTarget !== b.scrollTarget ||
        Math.sign(a.scrollDelta) !== Math.sign(b.scrollDelta))
    )
      add(
        "different-effect",
        `scrolls to ${a.scrollTarget ?? `${a.scrollDelta} px`} in production and to ${b.scrollTarget ?? `${b.scrollDelta} px`} on the target`,
      );
    else if (scrolls(a) && a.landing && b.landing) {
      const covered = b.landing.covered && !a.landing.covered;
      if (
        covered ||
        Math.abs(b.landing.top - a.landing.top) > LANDING_TOLERANCE
      )
        add(
          "different-effect",
          `scrolls ${a.scrollTarget ?? "the page"} to ${a.landing.top} px from the top of the viewport in production and to ${b.landing.top} px on the target${covered ? ", where a fixed or sticky layer covers it (check scroll-padding-top or scroll-margin-top)" : ""}`,
        );
    }
    if (a.hash !== b.hash)
      add(
        a.hash && !b.hash ? "missing-effect" : "different-effect",
        `sets location.hash to "${a.hash}" in production and "${b.hash}" on the target`,
      );
    if (a.url !== b.url)
      add(
        "different-effect",
        `leaves the page at ${a.url} in production and at ${b.url} on the target`,
      );
    const lost = (x, y) => x.filter((v) => !y.includes(v));
    const missingChanges = lost(a.changed, b.changed);
    if (missingChanges.length)
      add(
        "missing-effect",
        `production changes ${missingChanges.join(", ")}; the target does not`,
      );
    const extraChanges = lost(b.changed, a.changed);
    if (extraChanges.length)
      add(
        "different-effect",
        `the target changes ${extraChanges.join(", ")}; production does not`,
      );
    const missingShown = lost(a.shown, b.shown);
    if (missingShown.length)
      add(
        "missing-effect",
        `production shows ${missingShown.join(", ")}; the target does not`,
      );
    const extraShown = lost(b.shown, a.shown);
    if (extraShown.length)
      add(
        "different-effect",
        `the target shows ${extraShown.join(", ")}; production does not`,
      );
    if (a.focused !== b.focused)
      add(
        a.focused && !b.focused ? "missing-effect" : "different-effect",
        `moves focus to ${a.focused ?? "nothing"} in production and to ${b.focused ?? "nothing"} on the target`,
      );
  }
  return findings;
}

/**
 * Discovers and activates every interactive element of one side for one route and case, after learning what the page
 * changes on its own (observeVolatile).
 */
export async function crawl(
  browser,
  origin,
  route,
  matrixCase,
  masks = [],
  settleMs = DEFAULT_SETTLE_MS,
) {
  return withPage(
    browser,
    origin,
    route,
    matrixCase,
    async (page) => {
      const items = await discover(page, masks);
      const volatile = await observeVolatile(
        page,
        origin,
        route,
        masks,
        settleMs,
      );
      const out = [];
      const known = new Set(
        items.map((item) => `${item.anchor.mode} ${item.selector}`),
      );
      for (const item of items) {
        const effect = await activate(page, origin, route, item, {
          masks,
          volatile,
          settleMs,
        });
        out.push({ ...item, effect });
        if (!opensLayer(effect)) continue;
        // Open it again and crawl the controls that only exist while it is open (a dialog's Close), one level deep.
        const via = [{ selector: item.selector, anchor: item.anchor }];
        await activate(
          page,
          origin,
          route,
          { ...item, via: [] },
          { masks, settleMs },
        );
        const fresh = (await discover(page, masks)).filter(
          (n) => !known.has(`${n.anchor.mode} ${n.selector}`),
        );
        const keep = await inPage(page, insideOpened, {
          trigger: item.selector,
          selectors: fresh.map((n) => n.selector),
        });
        const inside = fresh.filter((_, i) => keep[i]).slice(0, NESTED_MAX);
        for (const nested of inside) {
          const anchor = { ...nested.anchor, via: anchorKey(item.anchor) };
          out.push({
            ...nested,
            anchor,
            via,
            effect: await activate(
              page,
              origin,
              route,
              { ...nested, via },
              { masks, volatile, settleMs },
            ),
          });
        }
      }
      return out;
    },
    masks,
    settleMs,
  );
}

/**
 * Runs the crawl on both sides (at once) for every route and case. Resolves to { check, ok, findings, crawled }.
 * Options: prod, target, routes, cases, masks.
 */
export async function runCheck(browser, options) {
  const masks = masksOf(options);
  const findings = [];
  const crawled = [];
  for (const route of routesOf(options))
    for (const c of casesOf(options)) {
      const [prod, target] = await Promise.all([
        crawl(browser, options.prod, route, c, masks, settleOf(options)),
        crawl(browser, options.target, route, c, masks, settleOf(options)),
      ]);
      crawled.push({ route, width: c.width, prod, target });
      for (const f of diffEffects(prod, target))
        findings.push({ ...f, route, width: c.width });
    }
  return result(CHECK, findings, { crawled });
}

export function parseCliArgs(argv) {
  return parseArgsFor(argv);
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
