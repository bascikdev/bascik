#!/usr/bin/env node
// State capture: open every disclosure the interaction crawl finds (dropdowns, drawers, accordions, tabs) on
// production and on the Bascik target, wait for the opening animation, and compare the open state: geometry,
// computed styles, a pixel crop, and the icons in the panel (svg, img, picture, CSS background-image and mask-image,
// ::before and ::after). Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
//
// Why: main-nav dropdowns shipped with the wrong style and without their icons, because no check ever looked at a
// menu in its open state.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  parseArgsFor,
  reload,
  result,
  routeSlug,
  routesOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import {
  discover,
  matchAnchor,
  observeVolatile,
} from "./interaction-crawl.mjs";
import { loadSharp } from "./lib/project-deps.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "state-capture";

/** The open panel may sit this many CSS pixels off production's place relative to its trigger. */
export const POSITION_TOLERANCE = 1;

/** Two crop pixels match when no channel differs by more than this (of 255): anti-aliasing, never a color change. */
export const PIXEL_CHANNEL_TOLERANCE = 8;

const HELP = `Usage: node state-capture.mjs --prod <url> --target <url> --route <path>... [options]

Opens every disclosure on each route (an element whose click or hover flips aria-expanded or open, or shows new
content, including a menu that opens on CSS :hover) on both sides, waits for the opening animation to finish, and
compares the open panel: its computed styles and size, its place relative to its trigger (within 1 px), the styles of
each item in it, its icons (kind and file; for an inline svg its drawing and its fill and stroke colors; a glyph drawn
with ::before or ::after content), and a pixel crop of the panel (a channel may differ by ${PIXEL_CHANNEL_TOLERANCE} of 255, no more).
Writes both crops to --out for the review page. Exits 1 on any finding.

Options:
  --prod <url>      Live production origin
  --target <url>    Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>    Route to check (repeatable, required)
  --mask <selector> A documented dynamic region to leave out, such as a carousel (repeatable)
  --matrix <file>   Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>       Report folder; crops go to <out>/states/ (default artifacts/checks)
  --json            Print the report as JSON
  --help            Show this message`;

/** Computed styles captured on the open panel; the items in it get the text subset (ITEM_PROPS). */
export const STATE_PROPS = Object.freeze([
  "display",
  "position",
  "width",
  "height",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "background-color",
  "background-image",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-radius",
  "box-shadow",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "gap",
  "z-index",
]);

const ITEM_PROPS = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "padding-top",
  "padding-left",
  "gap",
  "text-decoration-line",
];

/** Every way a page draws an icon. */
export const ICON_KINDS = Object.freeze([
  "svg",
  "img",
  "picture",
  "background",
  "mask",
  "pseudo",
]);

/**
 * The comparable part of an icon source: the file name without folders, query, hash or a build fingerprint
 * (timeline.4f3a2b1c.svg, timeline-DyLk3nQ2.svg -> timeline.svg). Inline svg sources ("svg:circle") stay as they are.
 */
export function iconSource(src) {
  const s = String(src ?? "");
  if (s.startsWith("svg:") || s.startsWith("data:") || s.startsWith("glyph:"))
    return s;
  const file = s.split(/[?#]/, 1)[0].split("/").pop() ?? "";
  return file
    .replace(
      /[.-](?:[0-9a-f]{6,}|(?=[A-Za-z0-9_]*[0-9A-Z])[A-Za-z0-9_]{8})(?=\.[a-z0-9]+$)/,
      "",
    )
    .toLowerCase();
}

/** One style finding per property whose open-state value differs. */
export function diffStateStyles(anchor, prod, target) {
  const findings = [];
  for (const property of Object.keys(prod)) {
    const a = prod[property];
    const b = target[property];
    if (a === b) continue;
    findings.push(
      finding(
        CHECK,
        "style",
        `${anchor} open: ${property} is "${a}" in production and "${b ?? "(missing)"}" on the target`,
        { anchor, property, prod: a, target: b },
      ),
    );
  }
  return findings;
}

const iconId = (icon) => `${icon.kind}:${iconSource(icon.src)}`;
const shapeId = (icon) => `${iconId(icon)}|${icon.shape ?? ""}`;
const paintId = (icon) => `${shapeId(icon)}|${icon.paint ?? ""}`;

/** The ids of `prod` with no equal id left in `target` (a multiset difference), and what is left of `target`. */
function unmatched(prod, target, id) {
  const rest = target.map(id);
  const missing = [];
  for (const value of prod.map(id)) {
    const i = rest.indexOf(value);
    if (i >= 0) rest.splice(i, 1);
    else missing.push(value);
  }
  return { missing, rest };
}

/**
 * Compares two icon inventories ([{ kind, src, shape?, paint? }]). Order does not matter. One finding, at the first
 * level that differs:
 *   icons        a different count
 *   icon-source  another kind or file
 *   icon-shape   an inline svg with the same element names but another drawing (a chevron that became a plus)
 *   icon-color   the same drawing in another fill or stroke color
 */
export function diffIcons(anchor, prod, target) {
  if (prod.length !== target.length)
    return [
      finding(
        CHECK,
        "icons",
        `${anchor} open: production shows ${prod.length} icon(s) (${prod.map(iconId).join(", ") || "none"}), the target ${target.length} (${target.map(iconId).join(", ") || "none"})`,
        { anchor, prod: prod.length, target: target.length },
      ),
    ];
  const source = unmatched(prod, target, iconId);
  if (source.missing.length)
    return [
      finding(
        CHECK,
        "icon-source",
        `${anchor} open: production icons ${source.missing.join(", ")} are ${source.rest.join(", ")} on the target`,
        { anchor, prod: source.missing, target: source.rest },
      ),
    ];
  const shape = unmatched(prod, target, shapeId);
  if (shape.missing.length)
    return [
      finding(
        CHECK,
        "icon-shape",
        `${anchor} open: ${shape.missing.length} icon(s) are drawn differently on the target (the same kind and elements, another drawing: ${shape.missing.map((id) => id.split("|")[1] || "(none)").join(", ")} in production, ${shape.rest.map((id) => id.split("|")[1] || "(none)").join(", ")} on the target)`,
        { anchor, prod: shape.missing, target: shape.rest },
      ),
    ];
  const paint = unmatched(prod, target, paintId);
  if (paint.missing.length)
    return [
      finding(
        CHECK,
        "icon-color",
        `${anchor} open: icon colors ${paint.missing.map((id) => id.split("|")[2] || "(none)").join(", ")} in production are ${paint.rest.map((id) => id.split("|")[2] || "(none)").join(", ")} on the target`,
        { anchor, prod: paint.missing, target: paint.rest },
      ),
    ];
  return [];
}

/**
 * Compares where the open panel sits relative to its trigger ({ dx, dy }: the panel's top left corner minus the
 * trigger's) on both sides. More than POSITION_TOLERANCE px off is one position finding.
 */
export function diffPosition(anchor, prod, target) {
  if (!prod || !target) return [];
  const ddx = Math.round((target.dx - prod.dx) * 10) / 10;
  const ddy = Math.round((target.dy - prod.dy) * 10) / 10;
  if (
    Math.abs(ddx) <= POSITION_TOLERANCE &&
    Math.abs(ddy) <= POSITION_TOLERANCE
  )
    return [];
  return [
    finding(
      CHECK,
      "position",
      `${anchor} open: the panel sits ${ddx} px across and ${ddy} px down from where production puts it relative to its trigger (${prod.dx},${prod.dy} px in production, ${target.dx},${target.dy} px on the target)`,
      { anchor, dx: ddx, dy: ddy },
    ),
  ];
}

/** Pixels of two same-size PNG crops where a channel differs by more than PIXEL_CHANNEL_TOLERANCE; null on a size mismatch. */
async function cropDiff(sharp, a, b) {
  const [x, y] = await Promise.all(
    [a, b].map((file) =>
      sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  if (x.info.width !== y.info.width || x.info.height !== y.info.height)
    return null;
  let count = 0;
  for (let i = 0; i < x.data.length; i += 4)
    for (let k = 0; k < 4; k++)
      if (Math.abs(x.data[i + k] - y.data[i + k]) > PIXEL_CHANNEL_TOLERANCE) {
        count++;
        break;
      }
  return count;
}

/** In the page: the panel a trigger opens: its aria-controls target, its details element, or the shown content. */
function panelOf(arg) {
  const trigger = document.querySelector(arg.trigger);
  if (!trigger) return null;
  const controls = trigger.getAttribute("aria-controls");
  let panel = controls
    ? document.getElementById(controls.split(/\s+/)[0])
    : null;
  if (!panel && tagOf(trigger) === "SUMMARY") panel = trigger.parentElement;
  if (!panel) {
    const shown = [...document.querySelectorAll(arg.shownSelector)].filter(
      (el) => isRendered(el) && arg.shown.includes(textKey(el)),
    );
    if (!shown.length) return null;
    panel = shown[0];
    while (
      panel.parentElement &&
      panel.parentElement !== document.body &&
      !shown.every((el) => panel.contains(el))
    )
      panel = panel.parentElement;
  }
  if (!isRendered(panel)) return null;
  return panel;
}

/**
 * In the page: styles, box, place relative to the trigger and icons of the open panel. An inline svg is identified by
 * its element names (src), its drawing (shape: a short hash of its geometry attributes) and its colors (paint: the
 * computed fill and stroke of its shapes); a ::before or ::after with text content (an arrow, an icon-font glyph) is a
 * "pseudo" icon with src "glyph:<text>".
 */
function capturePanel(arg) {
  const panel = panelOfInPage(arg);
  if (!panel) return null;
  const pick = (el, props) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
  };
  const styles = pick(panel, arg.props);
  for (const el of panel.querySelectorAll("a, button, [role=menuitem], li")) {
    if (!isRendered(el)) continue;
    const key = textKey(el);
    for (const [p, v] of Object.entries(pick(el, arg.itemProps))) {
      const name = `${key} ${p}`;
      if (!(name in styles)) styles[name] = v;
    }
  }
  const urls = (value) =>
    [...String(value).matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map(
      (m) => m[2],
    );
  const hash = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const GEOMETRY = [
    "d",
    "points",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "width",
    "height",
    "transform",
    "href",
    "viewBox",
  ];
  const SHAPES =
    "path, circle, rect, line, polyline, polygon, ellipse, use, image, text";
  const icons = [];
  for (const el of [panel, ...panel.querySelectorAll("*")]) {
    if (!isRendered(el)) continue;
    const tag = tagOf(el);
    if (tag === "SVG" && !el.parentElement.closest("svg")) {
      const shapes = [...el.querySelectorAll(SHAPES)];
      const geometry = [el, ...shapes]
        .map(
          (s) =>
            `${s.localName}(${GEOMETRY.filter((a) => s.hasAttribute(a))
              .map(
                (a) =>
                  `${a}=${norm(
                    s
                      .getAttribute(a)
                      .replace(/,/g, " ")
                      .replace(/\s*([a-zA-Z])\s*/g, "$1"),
                  )}`,
              )
              .join(";")})`,
        )
        .join("");
      const paints = new Set();
      for (const s of shapes) {
        const cs = getComputedStyle(s);
        if (cs.fill && cs.fill !== "none") paints.add(`fill ${cs.fill}`);
        if (cs.stroke && cs.stroke !== "none")
          paints.add(`stroke ${cs.stroke}`);
      }
      icons.push({
        kind: "svg",
        src: `svg:${[...new Set(shapes.map((s) => s.localName))].join(",")}`,
        shape: hash(geometry),
        paint: [...paints].sort().join(", "),
      });
    } else if (tag === "IMG" && !el.closest("picture"))
      icons.push({ kind: "img", src: el.currentSrc || el.src });
    else if (tag === "PICTURE") {
      const img = el.querySelector("img");
      icons.push({ kind: "picture", src: img?.currentSrc || img?.src || "" });
    }
    const cs = getComputedStyle(el);
    for (const src of urls(cs.backgroundImage))
      icons.push({ kind: "background", src });
    for (const src of urls(cs.maskImage || cs.webkitMaskImage))
      icons.push({ kind: "mask", src });
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(el, pseudo);
      if (
        ps.content === "none" ||
        ps.content === "normal" ||
        ps.display === "none"
      )
        continue;
      const found = [
        ...urls(ps.content),
        ...urls(ps.backgroundImage),
        ...urls(ps.maskImage || ps.webkitMaskImage),
      ];
      for (const src of found) icons.push({ kind: "pseudo", src });
      // Text content is a glyph: an arrow, a bullet, an icon-font character. Quotes and counters are not icons.
      const text = /^(["'])(.*)\1$/.exec(ps.content)?.[2] ?? "";
      if (!found.length && norm(text))
        icons.push({
          kind: "pseudo",
          src: `glyph:${text}`,
          paint: `color ${ps.color}`,
        });
    }
  }
  const trigger = document.querySelector(arg.trigger);
  const box = boxOf(panel);
  const at = trigger ? boxOf(trigger) : null;
  return {
    styles,
    icons,
    box,
    position: at
      ? {
          dx: Math.round((box.x - at.x) * 10) / 10,
          dy: Math.round((box.y - at.y) * 10) / 10,
        }
      : null,
  };
}

const SHOWN = "a, button, h1, h2, h3, h4, h5, h6, p, li, img";

/**
 * Opens one disclosure on a loaded page (a click, or a hover for a hover target) and captures it, or returns null
 * when nothing opens. Texts the page shows on its own (`volatile`, a carousel) and masked regions do not count as
 * the panel. The crop is cut from a viewport screenshot when the panel is in view, the way a visitor sees it.
 */
async function openState(page, origin, route, item, file, { masks, volatile }) {
  await reload(page, origin, route);
  await page.mouse.move(0, 0).catch(() => {});
  const locator = page.locator(item.selector).first();
  if ((await locator.count()) === 0) return null;
  const visible = (arg) =>
    [...document.querySelectorAll(arg.selector)]
      .filter((el) => isRendered(el) && !isMasked(el, arg.masks))
      .map((el) => textKey(el));
  const shownBefore = await inPage(page, visible, { selector: SHOWN, masks });
  if (item.anchor?.mode === "hover")
    await locator.hover({ timeout: 2000 }).catch(() => {});
  else
    try {
      await locator.click({ timeout: 2000 });
    } catch {
      await locator.evaluate((el) => el.click()).catch(() => {});
    }
  // The opening animation: wait for it, never for a fixed time alone.
  await inPage(page, async () => {
    await scrollSettled(2000);
    await animationsDone(3000);
  });
  const skip = new Set([...shownBefore, ...(volatile?.shown ?? [])]);
  const shown = (
    await inPage(page, visible, { selector: SHOWN, masks })
  ).filter((key) => !skip.has(key));
  const captured = await inPage(
    page,
    `function (arg) { const panelOfInPage = ${panelOf}; return (${capturePanel})(arg); }`,
    {
      trigger: item.selector,
      shown,
      shownSelector: SHOWN,
      props: STATE_PROPS,
      itemProps: ITEM_PROPS,
    },
  );
  if (!captured) return null;
  const { x, y, width, height } = captured.box;
  if (width >= 1 && height >= 1) {
    const view = await inPage(page, () => ({
      x: scrollX,
      y: scrollY,
      width: innerWidth,
      height: innerHeight,
    }));
    const inView =
      x >= view.x &&
      y >= view.y &&
      x + width <= view.x + view.width &&
      y + height <= view.y + view.height;
    const clip = {
      x: Math.max(0, Math.floor(inView ? x - view.x : x)),
      y: Math.max(0, Math.floor(inView ? y - view.y : y)),
      width: Math.ceil(width),
      height: Math.ceil(height),
    };
    await page.screenshot({
      path: file,
      fullPage: !inView,
      animations: "disabled",
      caret: "hide",
      clip,
    });
    captured.crop = file;
  }
  return captured;
}

/** Compares the open states of every disclosure on one route and case. */
async function compareCase(browser, options, route, c, dir, states, extra) {
  const { sharp, masks } = extra;
  const findings = [];
  await withPage(
    browser,
    options.prod,
    route,
    c,
    async (prodPage) =>
      withPage(
        browser,
        options.target,
        route,
        c,
        async (targetPage) => {
          const [prodItems, targetItems] = await Promise.all([
            discover(prodPage, masks),
            discover(targetPage, masks),
          ]);
          const [prodVolatile, targetVolatile] = await Promise.all([
            observeVolatile(prodPage, options.prod, route, masks),
            observeVolatile(targetPage, options.target, route, masks),
          ]);
          const used = new Set();
          let n = 0;
          for (const item of prodItems) {
            const label = `${item.anchor.tag}:${item.anchor.name || item.anchor.text}${item.anchor.mode === "hover" ? " (hover)" : ""}`;
            const stem = join(dir, `${routeSlug(route)}-${c.width}-${n}`);
            const prod = await openState(
              prodPage,
              options.prod,
              route,
              item,
              `${stem}-prod.png`,
              { masks, volatile: prodVolatile },
            );
            if (!prod) continue;
            n++;
            const i = matchAnchor(
              item.anchor,
              targetItems.map((t) => t.anchor),
              used,
            );
            const at = { anchor: label, route, width: c.width };
            if (i < 0) {
              findings.push(
                finding(
                  CHECK,
                  "missing-state",
                  `${label} opens a panel in production; the target has no matching element to open`,
                  at,
                ),
              );
              continue;
            }
            used.add(i);
            const target = await openState(
              targetPage,
              options.target,
              route,
              targetItems[i],
              `${stem}-target.png`,
              { masks, volatile: targetVolatile },
            );
            if (!target) {
              findings.push(
                finding(
                  CHECK,
                  "missing-state",
                  `${label} opens a panel in production; on the target it opens nothing`,
                  at,
                ),
              );
              continue;
            }
            states.push({
              anchor: label,
              route,
              width: c.width,
              height: c.height,
              prod: { crop: prod.crop, box: prod.box },
              target: { crop: target.crop, box: target.box },
            });
            const own = [
              ...diffStateStyles(label, prod.styles, target.styles),
              ...diffPosition(label, prod.position, target.position),
              ...diffIcons(label, prod.icons, target.icons),
            ];
            // The crop catches what no property list names (an icon's stroke width, a divider, a badge). Two crops of
            // another size already differ in width or height above.
            if (prod.crop && target.crop) {
              const count = await cropDiff(sharp, prod.crop, target.crop);
              if (count)
                own.push(
                  finding(
                    CHECK,
                    "pixels",
                    `${label} open: ${count} pixel(s) of the ${Math.round(prod.box.width)}x${Math.round(prod.box.height)} panel differ from production (see the two crops on the review page)`,
                    { anchor: label, count },
                  ),
                );
            }
            for (const f of own) findings.push({ ...f, route, width: c.width });
          }
        },
        masks,
      ),
    masks,
  );
  return findings;
}

/** Resolves to { check, ok, findings, states }, where states lists the crops of each open state on both sides. */
export async function runCheck(browser, options) {
  const dir = join(options.out ?? "artifacts/checks", "states");
  mkdirSync(dir, { recursive: true });
  const sharp = await loadSharp();
  const masks = masksOf(options);
  const findings = [];
  const states = [];
  for (const route of routesOf(options))
    for (const c of casesOf(options))
      findings.push(
        ...(await compareCase(browser, options, route, c, dir, states, {
          sharp,
          masks,
        })),
      );
  return result(CHECK, findings, { states });
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
