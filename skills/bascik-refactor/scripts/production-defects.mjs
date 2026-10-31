#!/usr/bin/env node
// Production defects: run ON PRODUCTION at every matrix case, before parity, and find what production gets wrong:
// images squished or stretched (rendered aspect ratio off the natural one by more than 2 percent with object-fit fill
// or none; lazy images are loaded first; an inline svg drawn with preserveAspectRatio="none" off its viewBox ratio),
// an icon off the vertical center of its heading or its text label by more than 4 px, or wrapped to its own line, text that overflows or is
// clipped by its box, overlapping text, and horizontal page scroll. Each defect becomes a decisions ledger row
// ("production defect: fix in target"), and the parity checks then compare the target with the corrected expectation
// for that element instead of with production. With --target, a target that copies a defect fails.
// Dependency-free; Node.js 22.22+; needs playwright (or @playwright/test) in your project.
//
// Why: the refactor faithfully copied production bugs, an icon and a section heading misaligned at small widths and
// images squished at some widths, because every check treated production as the truth.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inPage } from "./lib/dom.mjs";
import {
  keyMatch,
  casesOf,
  finding,
  masksOf,
  parseArgsFor,
  result,
  routesOf,
  settleOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";
import { cachedProd } from "./lib/prod-cache.mjs";
import { DEFECT_ID, loadAccepted } from "./compare-route.mjs";

export const CHECK = "production-defects";

/** An image may differ this much (2 percent) from its natural aspect ratio before it counts as squished. */
export const ASPECT_TOLERANCE = 0.02;

/** An icon's vertical center may sit this many CSS pixels off its heading's. */
export const ICON_CENTER_TOLERANCE = 4;

/** The ledger wording for a defect the target fixes on purpose. */
export const LEDGER_NOTE = "production defect: fix in target";

const HELP = `Usage: node production-defects.mjs --prod <url> --route <path>... [--target <url>] [options]

Runs on production at every matrix case, before any parity check, and lists what production gets wrong:
  squished          an image drawn at another aspect ratio than its file (over ${ASPECT_TOLERANCE * 100} percent) with object-fit fill or none
                    (loading="lazy" images are loaded first), or an inline svg with preserveAspectRatio="none" drawn
                    at another ratio than its viewBox
  icon-misaligned   an icon whose vertical center is over ${ICON_CENTER_TOLERANCE} px off its heading's, or off its text label's (a
                    paragraph, span or list item beside it, or the text of its own row), in the same row
  icon-wrapped      an icon on its own line above or below its heading at some widths (an icon above its heading at
                    every width of a route is the design)
  text-overflow     text wider than its box, or taller by at least half a line (glyphs past a tight line-height,
                    such as a logotype at 0.9, cut nothing off while overflow is visible)
  text-clipped      text cut off by overflow hidden (without an intended ellipsis or line clamp)
  text-overlap      two text boxes on top of each other (a fixed, sticky or dialog layer such as a cookie banner covers
                    the page by design and is left to presence-by-route)
  horizontal-scroll the page scrolls sideways
Visually hidden text (an sr-only label clipped to 1 px) and the face of a flip card turned away (backface-visibility
hidden) are left out. Running animations are finished (infinite ones canceled) before the page is measured, and
overflow that comes only from a --mask region is not blamed on its parent.
Each defect is appended once to the decisions ledger as "${LEDGER_NOTE}": one row per element and kind, with its
routes and width range, and the parity checks (run-checks.mjs) compare the target with the corrected expectation for
that element at each of those cases. A row a reviewer finds is not a defect is rejected by its id: --reject PD-xxxxxx,
or a "defect" list in accepted.json ({ "id": "D-07", "defect": ["PD-xxxxxx"], "reason": "..." }). A rejected defect is
neither a fix target nor a copied-defect.
With --target, the target is measured too: a copied defect or a defect only the target has is a finding.
Without --target, exits 0 after writing the ledger rows; with it, exits 1 on any finding.

Options:
  --prod <url>       Live production origin
  --target <url>     Bascik origin, such as http://localhost:8080 (optional: production alone lists the defects)
  --route <path>     Route to check (repeatable, required)
  --ledger <file>    Decisions ledger to append to (default docs/migration/decisions.md)
  --mask <selector>  A documented dynamic region to skip, such as a carousel (repeatable)
  --reject <id>      A reviewed false positive, by its ledger id such as PD-1a2b3c (repeatable)
  --accepted <file>  accepted.json whose "defect" lists are rejected too (default docs/migration/accepted.json when
                     it exists)
  --settle-ms <ms>   Least time after navigation before measuring (default 5000)
  --matrix <file>    Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>        Report folder (default artifacts/checks)
  --json             Print the report as JSON
  --help             Show this message`;

/** A ratio as a short reading: 4:3 when small whole numbers express it, otherwise 1.33:1. */
function ratioText(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) {
    const g = gcd(w, h);
    if (w / g <= 32 && h / g <= 32) return `${w / g}:${h / g}`;
  }
  return `${(w / h).toFixed(2)}:1`;
}

const centerY = (r) => r.y + r.height / 2;
const overlapsY = (a, b) => a.y < b.y + b.height && b.y < a.y + a.height;
const isAncestor = (a, b) => Boolean(a && b && b.startsWith(`${a}.`));

/**
 * The defects in one matrix case of one route, from the browser's measurements:
 * { route, width, height, images, iconRows, texts, page: { scrollWidth, clientWidth } }.
 * Each defect is { check, kind, route, width, key, selector, message }.
 */
export function detectDefects(snapshot) {
  const { route, width } = snapshot;
  const defects = [];
  const add = (kind, item, message, extra = {}) =>
    defects.push(
      finding(CHECK, kind, message, {
        route,
        width,
        key: item.key,
        selector: item.selector,
        ...extra,
      }),
    );
  for (const img of snapshot.images ?? []) {
    const { natural, rendered, objectFit } = img;
    if (!(natural.width > 0 && natural.height > 0)) continue;
    if (!(rendered.width > 0 && rendered.height > 0)) continue;
    if (objectFit !== "fill" && objectFit !== "none") continue;
    const want = natural.width / natural.height;
    const got = rendered.width / rendered.height;
    if (Math.abs(got / want - 1) <= ASPECT_TOLERANCE) continue;
    const source =
      img.source === "viewBox"
        ? `its viewBox is ${ratioText(natural.width, natural.height)} (${want.toFixed(2)}:1) and preserveAspectRatio is none`
        : `the file is ${ratioText(natural.width, natural.height)} (${want.toFixed(2)}:1) and object-fit is ${objectFit}`;
    add(
      "squished",
      img,
      `${img.key} at ${width} px is drawn ${Math.round(rendered.width)}x${Math.round(rendered.height)} (${got.toFixed(2)}:1), but ${source}: ${got < want ? "squished" : "stretched"}`,
    );
  }
  for (const row of snapshot.iconRows ?? []) {
    if (row.label) {
      // An icon beside a text label: off the label's center, and off its first line's when the label wraps.
      const off = (box) =>
        Math.round(Math.abs(centerY(row.icon) - centerY(box)) * 10) / 10;
      const offs = [off(row.label), ...(row.line ? [off(row.line)] : [])];
      const least = Math.min(...offs);
      if (overlapsY(row.icon, row.label) && least > ICON_CENTER_TOLERANCE)
        add(
          "icon-misaligned",
          row,
          `the icon beside ${row.key} at ${width} px is ${least} px off the vertical center of its text`,
        );
      continue;
    }
    if (!overlapsY(row.icon, row.heading)) {
      add(
        "icon-wrapped",
        row,
        `the icon of ${row.key} at ${width} px sits on its own line, ${row.icon.y < row.heading.y ? "above" : "below"} its heading`,
      );
      continue;
    }
    const off =
      Math.round(Math.abs(centerY(row.icon) - centerY(row.heading)) * 10) / 10;
    if (off > ICON_CENTER_TOLERANCE)
      add(
        "icon-misaligned",
        row,
        `the icon of ${row.key} at ${width} px is ${off} px off its heading's vertical center`,
      );
  }
  // Visually hidden text (an sr-only label) and a flip card's face turned away are not drawn.
  const texts = (snapshot.texts ?? []).filter(
    (t) => !t.visuallyHidden && !t.facingAway,
  );
  for (const t of texts) {
    const clipped = ["hidden", "clip"].includes(t.overflow);
    const wide = t.scrollWidth - t.clientWidth > 1;
    // With overflow visible, glyphs a few px past a tight line-height (a logotype at 0.9, a display font) cut nothing
    // off; only text taller by half a line or more (a line the box has no room for) overflows. A clipped box loses
    // whatever passes it.
    const tallLimit =
      clipped || !(t.lineHeight > 0) ? 1 : Math.max(1, t.lineHeight / 2);
    const tall = t.scrollHeight - t.clientHeight > tallLimit;
    if (!wide && !tall) continue;
    add(
      clipped ? "text-clipped" : "text-overflow",
      t,
      `${t.key} at ${width} px ${clipped ? "is cut off by its box" : "overflows its box"}: content ${t.scrollWidth}x${t.scrollHeight}, box ${t.clientWidth}x${t.clientHeight}`,
    );
  }
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (isAncestor(a.path, b.path) || isAncestor(b.path, a.path)) continue;
      // A fixed, sticky or dialog layer (a cookie banner, a sticky bar) covers the page by design.
      if (a.layer || b.layer) continue;
      const w =
        Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) -
        Math.max(a.rect.x, b.rect.x);
      const h =
        Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) -
        Math.max(a.rect.y, b.rect.y);
      if (w > 1 && h > 1)
        add(
          "text-overlap",
          a,
          `${a.key} and ${b.key} at ${width} px overlap by ${Math.round(w)}x${Math.round(h)} px`,
          { other: b.key },
        );
    }
  const { scrollWidth, clientWidth } = snapshot.page ?? {};
  if (scrollWidth - clientWidth > 1)
    add(
      "horizontal-scroll",
      { key: "page", selector: "html" },
      `the page at ${width} px scrolls ${scrollWidth - clientWidth} px horizontally`,
    );
  return defects;
}

/**
 * The defects of every matrix case of every route (detectDefects on each snapshot), less what needs all of a route's
 * cases to judge: an icon on its own line above or below its heading at every case of a route is the design, so
 * icon-wrapped is kept only where the icon sits beside its heading at another case (one case alone cannot tell).
 */
export function detectAcross(snapshots) {
  const defects = snapshots.flatMap((s) => detectDefects(s));
  const rowKey = (route, key) => `${route}|${keyMatch(key)}`;
  const measured = new Map();
  for (const s of snapshots)
    for (const row of s.iconRows ?? [])
      if (!row.label) {
        const k = rowKey(s.route, row.key);
        measured.set(k, (measured.get(k) ?? 0) + 1);
      }
  const wrapped = new Map();
  for (const d of defects)
    if (d.kind === "icon-wrapped") {
      const k = rowKey(d.route, d.key);
      wrapped.set(k, (wrapped.get(k) ?? 0) + 1);
    }
  return defects.filter(
    (d) =>
      d.kind !== "icon-wrapped" ||
      wrapped.get(rowKey(d.route, d.key)) <
        measured.get(rowKey(d.route, d.key)),
  );
}

// Keys are compared with whitespace removed (keyMatch): React markup and formatted HTML key one element alike.
const elementId = (d) =>
  `${d.kind}|${keyMatch(d.key ?? d.selector)}${d.other ? `|${keyMatch(d.other)}` : ""}`;
const caseId = (d) => `${d.route}|${d.width}|${elementId(d)}`;

/**
 * The ledger id of a defect: PD- and 6 hex characters from its kind and element (and the other element of an
 * overlap), not its route or width, so one row, and one --reject, covers the element at every case.
 */
export function ledgerId(d) {
  return `PD-${createHash("sha256").update(elementId(d)).digest("hex").slice(0, 6)}`;
}

/**
 * Splits defects by the ids a reviewer rejected as false positives: { kept, rejected, unused }, where unused lists the
 * ids that matched no defect (a typo, or a defect production no longer has).
 */
export function rejectDefects(defects, ids = []) {
  const wanted = new Set(ids);
  const hit = new Set();
  const kept = [];
  const rejected = [];
  for (const d of defects) {
    const id = ledgerId(d);
    if (wanted.has(id)) {
      hit.add(id);
      rejected.push(d);
    } else kept.push(d);
  }
  return { kept, rejected, unused: [...wanted].filter((id) => !hit.has(id)) };
}

/** The production-defects ids rejected in accepted.json entries ({ "id": "D-07", "defect": ["PD-1a2b3c"] }). */
export function rejectedFrom(accepted) {
  return [...new Set(accepted.flatMap((entry) => entry.defect ?? []))];
}

/**
 * Compares the target's defects with production's at the same cases. A defect on both sides is copied-defect (the
 * target must fix it, not copy it); one only the target has is target-defect. A fixed defect passes, and so does one
 * whose ledger id is in `rejected` (a reviewed false positive).
 */
export function diffDefects(prod, target, { rejected = [] } = {}) {
  const prodIds = new Set(prod.map(caseId));
  const skip = new Set(rejected);
  const findings = [];
  for (const d of target) {
    if (skip.has(ledgerId(d))) continue;
    const copied = prodIds.has(caseId(d));
    findings.push(
      finding(
        CHECK,
        copied ? "copied-defect" : "target-defect",
        copied
          ? `the target copies a production defect (${LEDGER_NOTE}): ${d.message}`
          : `the target has a defect production does not: ${d.message}`,
        {
          defect: d.kind,
          route: d.route,
          width: d.width,
          key: d.key,
          selector: d.selector,
          ...(d.other ? { other: d.other } : {}),
        },
      ),
    );
  }
  return findings;
}

const cell = (v) =>
  String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

/**
 * The widths as ranges over the measured widths: [320, 375, 1280] of [320, 375, 768, 1280] is "320-375, 1280". A
 * range never spans a measured width the defect does not have.
 */
function widthRanges(widths, measured) {
  const have = new Set(widths);
  const all = [...new Set([...measured, ...widths])].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let last = null;
  for (const w of all) {
    if (have.has(w)) {
      if (start === null) start = w;
      last = w;
      continue;
    }
    if (start !== null)
      ranges.push(start === last ? `${start}` : `${start}-${last}`);
    start = null;
  }
  if (start !== null)
    ranges.push(start === last ? `${start}` : `${start}-${last}`);
  return ranges.join(", ");
}

/**
 * One decisions-ledger row per element and kind (ledgerId), in the template's columns: its routes, its width range
 * over `widths` (every width the run measured; the defects' own widths without it), the first message and every
 * selector it was found at.
 */
export function ledgerRows(defects, { widths = [] } = {}) {
  const groups = new Map();
  for (const d of defects) {
    const id = ledgerId(d);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(d);
  }
  return [...groups].map(([id, list]) => {
    const routes = [...new Set(list.map((d) => d.route))];
    const selectors = [...new Set(list.map((d) => d.selector))];
    const range = widthRanges(
      list.map((d) => d.width),
      widths,
    );
    const first = list[0];
    return `| ${id} | ${cell(routes.join(", "))} | ${range} px wide | ${cell(first.kind)}: ${cell(first.message)} (${selectors.map((sel) => `\`${cell(sel)}\``).join(", ")}) | ${LEDGER_NOTE} | the target fixes what production gets wrong | ${CHECK}.mjs | |`;
  });
}

/** The ledger's title and table header, written when the file does not exist yet (templates/decisions-ledger.md). */
export const LEDGER_HEADER = `# Differences and decisions

Every intentional difference between production and the Bascik site. See the bascik-refactor decisions ledger
template for the columns and for docs/migration/accepted.json.

| id | route | matrix case | legacy behavior | new behavior | reason | evidence | approved by |
| -- | ----- | ----------- | --------------- | ------------ | ------ | -------- | ----------- |
`;

/**
 * Appends each defect's row to the ledger once, and returns how many rows it wrote; rows already there, and rows
 * people wrote, are left alone. A ledger that does not exist yet starts with LEDGER_HEADER.
 */
export function appendLedger(file, defects, { widths = [] } = {}) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const ids = new Set(
    [...text.matchAll(/^\|\s*(PD-[0-9a-f]+)\s*\|/gm)].map((m) => m[1]),
  );
  const rows = [];
  for (const row of ledgerRows(defects, { widths })) {
    const id = /^\|\s*(PD-[0-9a-f]+)/.exec(row)[1];
    if (ids.has(id)) continue;
    ids.add(id);
    rows.push(row);
  }
  if (!rows.length) return 0;
  mkdirSync(dirname(file), { recursive: true });
  const base = !text.trim()
    ? LEDGER_HEADER
    : text.endsWith("\n")
      ? text
      : `${text}\n`;
  writeFileSync(file, `${base}${rows.join("\n")}\n`);
  return rows.length;
}

/**
 * Splits parity findings into those kept and those on an element production got wrong at that route and width
 * (corrected: the target differs from production there on purpose). copied-defect findings are always kept.
 */
export function applyCorrections(findings, defects) {
  const kept = [];
  const corrected = [];
  for (const f of findings) {
    const hit =
      f.check !== CHECK &&
      defects.some(
        (d) =>
          d.route === f.route &&
          d.width === f.width &&
          ((d.key &&
            (keyMatch(f.key) === keyMatch(d.key) ||
              keyMatch(f.section) === keyMatch(d.key))) ||
            (d.selector && f.selector === d.selector)),
      );
    (hit ? corrected : kept).push(f);
  }
  return { kept, corrected };
}

/**
 * In the page: loads every loading="lazy" image that has not loaded (a browser never fetches one far below the fold
 * until it scrolls there), waits for them (at most 5 s) and scrolls back to the top, so a squished lazy image is
 * measured too.
 */
async function loadLazyImages(arg) {
  const lazy = [...document.images].filter(
    (img) => !img.complete && !isMasked(img, arg?.masks ?? []),
  );
  for (const img of lazy) img.loading = "eager";
  await Promise.race([
    Promise.all(
      lazy.map(
        (img) =>
          img.complete ||
          new Promise((r) => {
            img.addEventListener("load", r, { once: true });
            img.addEventListener("error", r, { once: true });
          }),
      ),
    ),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  scrollTo(0, 0);
}

/**
 * In the page: finishes every finite animation and transition running now and cancels every infinite one, so the
 * page is measured settled instead of mid-flight (a word rising into place on a loop adds to its paragraph's
 * scrollHeight only during the rise). Production and the target are settled alike.
 */
export function settleAnimations() {
  for (const a of document.getAnimations()) {
    try {
      if (a.effect?.getTiming?.().iterations === Infinity) a.cancel();
      else a.finish();
    } catch {
      // An animation that cannot finish (no end time) is canceled.
      try {
        a.cancel();
      } catch {
        // Nothing more to do for it.
      }
    }
  }
}

/** In the page: images, icon rows, text boxes and page scroll, as detectDefects reads them. */
export function measureDefects(arg) {
  const masks = arg?.masks ?? [];
  const images = [];
  for (const img of document.images) {
    if (!isRendered(img) || !img.complete || isMasked(img, masks)) continue;
    const r = img.getBoundingClientRect();
    images.push({
      key: textKey(img),
      selector: selectorOf(img),
      natural: { width: img.naturalWidth, height: img.naturalHeight },
      rendered: { width: r.width, height: r.height },
      objectFit: getComputedStyle(img).objectFit,
    });
  }
  // An inline svg stretched to its box: preserveAspectRatio="none" draws its viewBox at the box's ratio.
  for (const svg of document.querySelectorAll("svg[viewBox]")) {
    if (svg.parentElement?.closest("svg")) continue;
    if (!/^\s*none\b/.test(svg.getAttribute("preserveAspectRatio") ?? ""))
      continue;
    if (!isRendered(svg) || isMasked(svg, masks)) continue;
    const box = svg.viewBox?.baseVal;
    if (!box?.width || !box?.height) continue;
    const r = svg.getBoundingClientRect();
    images.push({
      key: textKey(svg),
      selector: selectorOf(svg),
      natural: { width: box.width, height: box.height },
      rendered: { width: r.width, height: r.height },
      objectFit: "fill",
      source: "viewBox",
    });
  }
  const isIcon = (el) => {
    if (!isRendered(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width > 64 || r.height > 64) return false;
    const tag = tagOf(el);
    if (tag === "SVG" || tag === "IMG") return true;
    if (norm(el.textContent)) return false;
    return (
      el.querySelector("svg, img") !== null ||
      getComputedStyle(el).backgroundImage !== "none"
    );
  };
  const iconRows = [];
  for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (!isRendered(h) || !h.parentElement || isMasked(h, masks)) continue;
    const icon = [...h.parentElement.children].find(
      (c) => c !== h && isIcon(c),
    );
    if (!icon) continue;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
    };
    iconRows.push({
      key: textKey(h),
      selector: selectorOf(h.parentElement),
      icon: rect(icon),
      heading: rect(h),
    });
  }
  // Icons beside a text label that is not a heading (a feature list, "In the box"): the first sibling with text, or the
  // text of the icon's own row.
  const LABELS = new Set([
    "P",
    "SPAN",
    "LI",
    "A",
    "LABEL",
    "DT",
    "DD",
    "STRONG",
    "EM",
    "DIV",
    "BUTTON",
  ]);
  const rows = new Set(iconRows.map((r) => r.selector));
  for (const icon of document.body.querySelectorAll("svg, img, i, span")) {
    if (icon.parentElement?.closest("svg") || isMasked(icon, masks)) continue;
    if (!isIcon(icon) || icon === document.body) continue;
    const parent = icon.parentElement;
    if (!parent || rows.has(selectorOf(parent)) || layerOf(icon)) continue;
    const firstLine = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = [...range.getClientRects()].find(
        (x) => x.width > 0 && x.height > 0,
      );
      return r
        ? { x: r.x, y: r.y + scrollY, width: r.width, height: r.height }
        : null;
    };
    let label = [...parent.children].find(
      (c) =>
        c !== icon &&
        LABELS.has(tagOf(c)) &&
        !c.contains(icon) &&
        isRendered(c) &&
        norm(c.textContent) &&
        !c.querySelector("svg, img"),
    );
    let box = null;
    let line = null;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
    };
    if (label) {
      box = rect(label);
      line = firstLine(label);
    } else {
      // The icon's own row: text nodes directly beside it.
      const text = [...parent.childNodes].filter(
        (n) => n.nodeType === 3 && norm(n.textContent),
      );
      if (!text.length) continue;
      const range = document.createRange();
      range.setStartBefore(text[0]);
      range.setEndAfter(text[text.length - 1]);
      const rs = [...range.getClientRects()].filter(
        (x) => x.width > 0 && x.height > 0,
      );
      if (!rs.length) continue;
      const top = Math.min(...rs.map((x) => x.top));
      const bottom = Math.max(...rs.map((x) => x.bottom));
      box = {
        x: rs[0].x,
        y: top + scrollY,
        width: rs[0].width,
        height: bottom - top,
      };
      line = {
        x: rs[0].x,
        y: rs[0].y + scrollY,
        width: rs[0].width,
        height: rs[0].height,
      };
      label = parent;
    }
    if (/^H[1-6]$/.test(tagOf(label))) continue;
    // Only a row: the icon sits beside its label, not above or below it.
    const i = rect(icon);
    if (!(i.x + i.width <= box.x + 1 || i.x >= box.x + box.width - 1)) continue;
    rows.add(selectorOf(parent));
    iconRows.push({
      key: textKey(label),
      selector: selectorOf(parent),
      icon: i,
      label: box,
      line,
    });
  }
  // Visually hidden on purpose: an sr-only label (a box of 1 px or less that clips its content) or clip-path inset(50%).
  const visuallyHidden = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/^inset\(\s*50%/.test(s.clipPath)) return true;
      const r = n.getBoundingClientRect();
      const clips =
        s.overflowX !== "visible" ||
        s.overflowY !== "visible" ||
        s.clip !== "auto" ||
        s.clipPath !== "none";
      if ((r.width <= 1 || r.height <= 1) && clips) return true;
    }
    return false;
  };
  // A face turned away: an element with backface-visibility hidden whose accumulated transform points its front away
  // from the viewer (the back of a flip card at rest).
  const facingAway = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).backfaceVisibility !== "hidden") continue;
      let m = new DOMMatrix();
      for (
        let a = n;
        a && a !== document.documentElement;
        a = a.parentElement
      ) {
        const t = getComputedStyle(a).transform;
        if (t && t !== "none") m = new DOMMatrix(t).multiply(m);
      }
      if (m.m33 < 0) return true;
    }
    return false;
  };
  const containsMasked = (el) =>
    masks.some((selector) => {
      try {
        return el.querySelector(selector) !== null;
      } catch {
        return false;
      }
    });
  // The extent of an element's content without its masked descendants (a dynamic region's motion or size is not the
  // parent's defect): the client box, grown by every unmasked descendant box and text line, plus the end padding.
  const unmaskedExtent = (el, cs) => {
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft - el.scrollLeft;
    const top = r.top + el.clientTop - el.scrollTop;
    let right = el.clientWidth;
    let bottom = el.clientHeight;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const grow = (box) => {
      if (!(box.width > 0 && box.height > 0)) return;
      right = Math.max(right, box.right - left + padRight);
      bottom = Math.max(bottom, box.bottom - top + padBottom);
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (!norm(child.textContent)) continue;
          const range = document.createRange();
          range.selectNodeContents(child);
          for (const box of range.getClientRects()) grow(box);
        } else if (child.nodeType === 1 && !isMasked(child, masks)) {
          grow(child.getBoundingClientRect());
          walk(child);
        }
      }
    };
    walk(el);
    return { width: Math.round(right), height: Math.round(bottom) };
  };
  const texts = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(tagOf(el)))
      continue;
    const own = [...el.childNodes].some(
      (n) => n.nodeType === 3 && norm(n.textContent),
    );
    if (!own || !isRendered(el) || isMasked(el, masks)) continue;
    const cs = getComputedStyle(el);
    if (cs.display.startsWith("inline") && cs.display !== "inline-block")
      continue;
    const intended =
      cs.textOverflow === "ellipsis" ||
      (cs.webkitLineClamp && cs.webkitLineClamp !== "none");
    const rects = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !norm(n.textContent)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects())
        if (r.width > 0 && r.height > 0) rects.push(r);
    }
    if (!rects.length) continue;
    const x = Math.min(...rects.map((r) => r.left));
    const y = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const overflowX = cs.overflowX;
    let scrollWidth = intended ? el.clientWidth : el.scrollWidth;
    let scrollHeight = intended ? el.clientHeight : el.scrollHeight;
    if (
      (scrollWidth - el.clientWidth > 1 ||
        scrollHeight - el.clientHeight > 1) &&
      containsMasked(el)
    ) {
      const extent = unmaskedExtent(el, cs);
      scrollWidth = Math.min(scrollWidth, extent.width);
      scrollHeight = Math.min(scrollHeight, extent.height);
    }
    const fontSize = parseFloat(cs.fontSize) || 16;
    texts.push({
      key: textKey(el),
      selector: selectorOf(el),
      path: pathOf(el),
      rect: { x, y: y + scrollY, width: right - x, height: bottom - y },
      scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight,
      clientHeight: el.clientHeight,
      lineHeight:
        cs.lineHeight === "normal"
          ? fontSize * 1.2
          : parseFloat(cs.lineHeight) || fontSize * 1.2,
      overflow: overflowX === "visible" ? cs.overflowY : overflowX,
      layer: layerOf(el) !== null,
      visuallyHidden: visuallyHidden(el),
      facingAway: facingAway(el),
    });
  }
  return {
    images,
    iconRows,
    texts,
    page: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
  };
}

async function measure(browser, origin, route, c, masks, settleMs) {
  return withPage(
    browser,
    origin,
    route,
    c,
    async (page) => {
      await inPage(page, loadLazyImages, { masks });
      await inPage(page, settleAnimations, { masks });
      return {
        route,
        width: c.width,
        height: c.height,
        ...(await inPage(page, measureDefects, { masks })),
      };
    },
    masks,
    settleMs,
  );
}

/**
 * Resolves to { check, ok, findings, defects, ledger }: production's defects, their ledger rows, and with a target,
 * the copied and target-only defects as findings. Options: prod, target (optional), routes, cases, ledger (a file to
 * append the rows to; nothing is written without it).
 */
export async function runCheck(browser, options) {
  const masks = masksOf(options);
  const rejectIds = [
    ...new Set([
      ...(options.reject ?? []),
      ...(options.accepted ? rejectedFrom(loadAccepted(options.accepted)) : []),
    ]),
  ];
  const prodSnaps = [];
  const targetSnaps = [];
  const cases = casesOf(options);
  for (const route of routesOf(options))
    for (const c of cases) {
      const [prodSnap, targetSnap] = await Promise.all([
        cachedProd(options, { check: CHECK, route, case: c }, () =>
          measure(browser, options.prod, route, c, masks, settleOf(options)),
        ),
        options.target
          ? measure(browser, options.target, route, c, masks, settleOf(options))
          : null,
      ]);
      prodSnaps.push(prodSnap);
      if (targetSnap) targetSnaps.push(targetSnap);
    }
  const {
    kept: defects,
    rejected,
    unused,
  } = rejectDefects(detectAcross(prodSnaps), rejectIds);
  const findings = options.target
    ? diffDefects(defects, detectAcross(targetSnaps), { rejected: rejectIds })
    : [];
  const widths = [...new Set(cases.map((c) => c.width))];
  const written = options.ledger
    ? appendLedger(options.ledger, defects, { widths })
    : 0;
  return result(CHECK, findings, {
    defects,
    rejected,
    unusedRejects: unused,
    ledger: ledgerRows(defects, { widths }),
    ledgerFile: options.ledger,
    written,
  });
}

/** accepted.json, read for its "defect" lists when it exists and --accepted names no other file. */
export const DEFAULT_ACCEPTED = "docs/migration/accepted.json";

/** Checks --reject values: each must be a production-defects ledger id (PD- and 6 lowercase hex characters). */
export function rejectIdsFrom(values) {
  for (const id of values ?? [])
    if (!DEFECT_ID.test(id))
      throw new Error(
        `--reject ${id}: not a production-defects ledger id; pass the PD- id of its decisions ledger row, such as PD-1a2b3c`,
      );
  return [...new Set(values ?? [])];
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: {
      ledger: { type: "string" },
      reject: { type: "string", multiple: true },
      accepted: { type: "string" },
    },
    need: ["prod", "route"],
  });
  if (args.help) return args;
  return {
    ...args,
    ledger: args.ledger ?? "docs/migration/decisions.md",
    reject: rejectIdsFrom(args.reject),
    accepted:
      args.accepted ??
      (existsSync(DEFAULT_ACCEPTED) ? DEFAULT_ACCEPTED : undefined),
  };
}

if (isMain(import.meta.url)) {
  try {
    await runCli({
      check: CHECK,
      help: HELP,
      parseCliArgs,
      runCheck,
      summary: (report) => [
        ...report.defects.map(
          (d) =>
            `      production defect  ${d.route} ${d.width}px  ${d.message}`,
        ),
        report.defects.length
          ? `      ${report.defects.length} production defect(s) in ${report.ledger.length} ledger row(s); ${report.written} new row(s) written to ${report.ledgerFile} as "${LEDGER_NOTE}". The target must fix each one; the parity checks compare it with the corrected expectation there. A row that is not a defect: --reject its id, or list it in an accepted.json "defect" entry.`
          : "      no production defects found",
        ...(report.rejected.length
          ? [
              `      ${report.rejected.length} defect(s) left out as rejected (reviewed false positives)`,
            ]
          : []),
        ...report.unusedRejects.map(
          (id) =>
            `      warning: rejected id ${id} matches no defect (a typo, or production no longer has it)`,
        ),
      ],
    });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
