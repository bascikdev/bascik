#!/usr/bin/env node
// Overlap diff: find the element pairs that overlap in production (boxes intersect and at least one is positioned or
// is an svg or img), record each pair's center-to-center offset and size ratio, require the same on the target within
// 1 px, and pixel-diff each overlap rectangle with zero tolerance.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) and sharp in your project.
//
// Why: a timeline had an SVG over one of its circles that was not perfectly aligned. A 2 px offset is far below any
// whole-page pixel budget, so only a check that knows the two elements overlap catches it.
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  parseArgsFor,
  pixels,
  result,
  routesOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { loadSharp } from "./lib/project-deps.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "overlap-diff";
export const DEFAULT_TOLERANCE = 1;

/** A size ratio may differ by this much (2 percent) before it is a finding. */
const RATIO_TOLERANCE = 0.02;

const HELP = `Usage: node overlap-diff.mjs --prod <url> --target <url> --route <path>... [options]

Finds every pair of elements that overlap in production, where at least one is positioned or is an svg or img (an
icon on a dot, a badge on an avatar, a label over an image), including a positioned ::before or ::after and the
parts of a large inline svg, and requires the same pair on the target, in document order, with the same
center-to-center offset (within the tolerance) and size ratio. The area of each pair is then compared pixel for pixel
with zero tolerance. Fixed and sticky layers (a cookie banner, a sticky header) pair only with their own parts.
Exits 1 on any finding.

Options:
  --prod <url>          Live production origin
  --target <url>        Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>        Route to compare (repeatable, required)
  --tolerance <px>      Allowed offset difference in CSS pixels (default 1)
  --mask <selector>     A documented dynamic region to skip, such as a carousel (repeatable)
  --matrix <file>       Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>           Report folder (default artifacts/checks)
  --json                Print the report as JSON
  --help                Show this message`;

const round = (v) => Math.round(v * 100) / 100;
const isAncestor = (a, b) => b.startsWith(`${a}.`);

/**
 * The overlapping pairs among boxes ([{ key, path, rect, positioned, media, layer }]): intersecting with a positive
 * area, at least one positioned or media, neither an ancestor of the other, both in the same layer (a fixed or sticky
 * layer such as a cookie banner covers the page by design and pairs only with its own parts; presence-by-route owns
 * it). Each pair has the keys, the center offset of b from
 * a (dx, dy), the size ratios of b to a, the intersection rectangle and the union of both boxes.
 */
export function findOverlaps(boxes) {
  const pairs = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!(a.positioned || a.media || b.positioned || b.media)) continue;
      if ((a.layer ?? null) !== (b.layer ?? null)) continue;
      if (isAncestor(a.path, b.path) || isAncestor(b.path, a.path)) continue;
      const x = Math.max(a.rect.x, b.rect.x);
      const y = Math.max(a.rect.y, b.rect.y);
      const right = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width);
      const bottom = Math.min(
        a.rect.y + a.rect.height,
        b.rect.y + b.rect.height,
      );
      if (right <= x || bottom <= y) continue;
      pairs.push({
        a: a.key,
        b: b.key,
        layer: a.layer ?? null,
        dx: round(b.rect.x + b.rect.width / 2 - (a.rect.x + a.rect.width / 2)),
        dy: round(
          b.rect.y + b.rect.height / 2 - (a.rect.y + a.rect.height / 2),
        ),
        wRatio: round(b.rect.width / a.rect.width),
        hRatio: round(b.rect.height / a.rect.height),
        rect: { x, y, width: right - x, height: bottom - y },
        union: {
          x: Math.min(a.rect.x, b.rect.x),
          y: Math.min(a.rect.y, b.rect.y),
          width:
            Math.max(a.rect.x + a.rect.width, b.rect.x + b.rect.width) -
            Math.min(a.rect.x, b.rect.x),
          height:
            Math.max(a.rect.y + a.rect.height, b.rect.y + b.rect.height) -
            Math.min(a.rect.y, b.rect.y),
        },
      });
    }
  return pairs;
}

/** The pair's name in a finding: both keys, with their shared part said once. */
const pairName = (p) => `${p.a} and ${p.b}`;

/**
 * For each production pair, the index of its target pair, or -1: the first unused target pair with the same two keys,
 * so pairs that share their keys (the dots of a timeline whose labels sit elsewhere) pair up in document order.
 */
export function pairUp(prod, target) {
  const used = new Set();
  return prod.map((p) => {
    const i = target.findIndex(
      (q, index) => !used.has(index) && q.a === p.a && q.b === p.b,
    );
    if (i >= 0) used.add(i);
    return i;
  });
}

/**
 * Compares production's pairs with the target's, matched by both keys in document order (pairUp). Kinds: offset (the
 * center offset moved more than the tolerance), size (a size ratio changed) and missing-overlap (the pair no longer
 * overlaps on the target).
 */
export function diffOverlaps(
  prod,
  target,
  { tolerance = DEFAULT_TOLERANCE } = {},
) {
  const findings = [];
  const matched = pairUp(prod, target);
  prod.forEach((p, n) => {
    const t = matched[n] >= 0 ? target[matched[n]] : null;
    if (!t) {
      findings.push(
        finding(
          CHECK,
          "missing-overlap",
          `${pairName(p)} overlap in production but not on the target`,
          { a: p.a, b: p.b },
        ),
      );
      return;
    }
    const ddx = round(t.dx - p.dx);
    const ddy = round(t.dy - p.dy);
    if (Math.abs(ddx) > tolerance || Math.abs(ddy) > tolerance)
      findings.push(
        finding(
          CHECK,
          "offset",
          `${pairName(p)}: the second sits ${ddx} px across and ${ddy} px down from where production puts it (center offset ${p.dx},${p.dy} in production, ${t.dx},${t.dy} on the target)`,
          { a: p.a, b: p.b, dx: ddx, dy: ddy },
        ),
      );
    if (
      Math.abs(t.wRatio - p.wRatio) > RATIO_TOLERANCE ||
      Math.abs(t.hRatio - p.hRatio) > RATIO_TOLERANCE
    )
      findings.push(
        finding(
          CHECK,
          "size",
          `${pairName(p)}: size ratio ${p.wRatio}x${p.hRatio} in production and ${t.wRatio}x${t.hRatio} on the target`,
          { a: p.a, b: p.b },
        ),
      );
  });
  return findings;
}

/**
 * In the page: the box of every rendered element, with whether it is positioned or media and the fixed or sticky layer
 * it sits in. Also: a positioned ::before or ::after (a timeline dot's inner circle is often one), measured from its
 * host's padding box, as a sibling of its host; and the shapes and groups directly inside a large inline svg (a
 * timeline drawn as one svg). Masked regions are left out.
 */
function collectBoxes(arg) {
  const keyOf = (el) => {
    if (norm(el.textContent) && !["SVG", "IMG"].includes(tagOf(el)))
      return textKey(el);
    let n = el.parentElement;
    while (n && n !== document.body && !norm(n.textContent))
      n = n.parentElement;
    const base = n && n !== document.body ? textKey(n) : "BODY";
    const same = el.parentElement
      ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName)
      : [el];
    const nth = same.length > 1 ? `:${same.indexOf(el) + 1}` : "";
    return `${base} > ${tagOf(el)}${nth}`;
  };
  const px = (v) => Number.parseFloat(v) || 0;
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(tagOf(el)))
      continue;
    const svg = el.parentElement?.closest("svg");
    if (svg) {
      // Only the direct parts of a large svg: an icon's own paths are one picture, a diagram's parts are not.
      const r = svg.getBoundingClientRect();
      if (el.parentElement !== svg || (r.width <= 64 && r.height <= 64))
        continue;
    }
    if (!isRendered(el) || isMasked(el, arg.masks)) continue;
    const cs = getComputedStyle(el);
    const key = keyOf(el);
    const path = pathOf(el);
    const layer = layerOf(el);
    out.push({
      key,
      path,
      rect: boxOf(el),
      positioned: cs.position !== "static",
      media:
        Boolean(svg) ||
        ["SVG", "IMG", "PICTURE", "VIDEO", "CANVAS"].includes(tagOf(el)),
      layer,
    });
    if (cs.position === "static" || svg) continue;
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(el, pseudo);
      if (
        ps.content === "none" ||
        ps.content === "normal" ||
        ps.display === "none"
      )
        continue;
      if (ps.position !== "absolute") continue;
      const host = el.getBoundingClientRect();
      const width =
        ps.boxSizing === "border-box"
          ? px(ps.width)
          : px(ps.width) +
            px(ps.paddingLeft) +
            px(ps.paddingRight) +
            px(ps.borderLeftWidth) +
            px(ps.borderRightWidth);
      const height =
        ps.boxSizing === "border-box"
          ? px(ps.height)
          : px(ps.height) +
            px(ps.paddingTop) +
            px(ps.paddingBottom) +
            px(ps.borderTopWidth) +
            px(ps.borderBottomWidth);
      if (!(width > 0 && height > 0)) continue;
      const x =
        host.left + px(cs.borderLeftWidth) + px(ps.left) + px(ps.marginLeft);
      const y =
        host.top + px(cs.borderTopWidth) + px(ps.top) + px(ps.marginTop);
      const round = (v) => Math.round(v * 10) / 10;
      out.push({
        key: `${key}${pseudo}`,
        // A sibling of its host, not a child: the pseudo-element is compared with the host it sits on.
        path: `${path}~${pseudo.slice(2)}`,
        rect: {
          x: round(x + scrollX),
          y: round(y + scrollY),
          width: round(width),
          height: round(height),
        },
        positioned: true,
        media: false,
        layer,
      });
    }
  }
  return out;
}

/**
 * Captures each pair's union as raw pixels. The pair is scrolled into the viewport, without smooth scrolling, and cut
 * from a viewport screenshot: a full-page capture clipped below the fold is not pixel-stable in Chromium, and this
 * comparison has zero tolerance. A pair in a fixed or sticky layer is captured where it sits at the top of the page.
 * A pair larger than the viewport is not pixel-compared (its offset and size still are): `png` stays null and
 * `skipped` says why.
 */
async function capture(browser, origin, route, c, sharp, masks) {
  return withPage(
    browser,
    origin,
    route,
    c,
    async (page) => {
      const pairs = findOverlaps(await inPage(page, collectBoxes, { masks }));
      const viewport = page.viewportSize();
      for (const pair of pairs) {
        pair.png = null;
        // Both elements, so an icon moved inside its dot shows up even where the overlap itself looks the same.
        const { x, y, width, height } = pair.union;
        if (width > viewport.width || height > viewport.height) {
          pair.skipped = "larger than the viewport";
          continue;
        }
        const top = pair.layer
          ? 0
          : Math.max(0, Math.floor(y - (viewport.height - height) / 2));
        const scrolled = await inPage(
          page,
          async (arg) => {
            document.documentElement.style.scrollBehavior = "auto";
            scrollTo({ top: arg.top, left: 0, behavior: "instant" });
            await scrollSettled(2000);
            await new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            );
            return { x: scrollX, y: scrollY };
          },
          { top },
        );
        const left = Math.round(x - (pair.layer ? 0 : scrolled.x));
        const upper = Math.round(y - (pair.layer ? 0 : scrolled.y));
        if (
          left < 0 ||
          upper < 0 ||
          left + Math.round(width) > viewport.width ||
          upper + Math.round(height) > viewport.height
        ) {
          pair.skipped = "not inside the viewport after scrolling";
          continue;
        }
        const shot = await page.screenshot({
          animations: "disabled",
          caret: "hide",
        });
        pair.png = await sharp(shot)
          .extract({
            left,
            top: upper,
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
          })
          .png()
          .toBuffer();
      }
      await inPage(page, () => scrollTo({ top: 0, behavior: "instant" }));
      return pairs;
    },
    masks,
  );
}

/** Counts pixels that differ at all between two PNG crops; a size difference counts every pixel. */
async function cropDiff(sharp, a, b) {
  const [x, y] = await Promise.all(
    [a, b].map((png) =>
      sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  if (x.info.width !== y.info.width || x.info.height !== y.info.height)
    return x.info.width * x.info.height;
  let count = 0;
  for (let i = 0; i < x.data.length; i += 4)
    if (
      x.data[i] !== y.data[i] ||
      x.data[i + 1] !== y.data[i + 1] ||
      x.data[i + 2] !== y.data[i + 2] ||
      x.data[i + 3] !== y.data[i + 3]
    )
      count++;
  return count;
}

/** Resolves to { check, ok, findings }. Options: prod, target, routes, cases, tolerance. */
export async function runCheck(browser, options) {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const masks = masksOf(options);
  const sharp = await loadSharp();
  const findings = [];
  for (const route of routesOf(options))
    for (const c of casesOf(options)) {
      const [prod, target] = await Promise.all([
        capture(browser, options.prod, route, c, sharp, masks),
        capture(browser, options.target, route, c, sharp, masks),
      ]);
      const strip = (pairs) => pairs.map(({ png, ...rest }) => rest);
      for (const f of diffOverlaps(strip(prod), strip(target), { tolerance }))
        findings.push({ ...f, route, width: c.width });
      const matched = pairUp(prod, target);
      for (const [n, p] of prod.entries()) {
        const t = matched[n] >= 0 ? target[matched[n]] : null;
        if (!t) continue;
        const where = { a: p.a, b: p.b, route, width: c.width };
        if (!p.png && !t.png) continue;
        if (!p.png || !t.png) {
          findings.push(
            finding(
              CHECK,
              "pixels",
              `${pairName(p)}: could not be captured ${p.png ? "on the target" : "in production"} (${(p.png ? t : p).skipped}), so the two cannot be compared pixel for pixel`,
              where,
            ),
          );
          continue;
        }
        const count = await cropDiff(sharp, p.png, t.png);
        if (count > 0)
          findings.push(
            finding(
              CHECK,
              "pixels",
              `${pairName(p)}: ${count} pixel(s) of the ${Math.round(p.union.width)}x${Math.round(p.union.height)} area they cover differ from production (zero tolerance)`,
              { ...where, count },
            ),
          );
      }
    }
  return result(CHECK, findings);
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: { tolerance: { type: "string" } },
  });
  if (args.help) return args;
  return {
    ...args,
    tolerance: pixels("--tolerance", args.tolerance, DEFAULT_TOLERANCE),
  };
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
