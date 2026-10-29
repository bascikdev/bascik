#!/usr/bin/env node
// Production defects: run ON PRODUCTION at every matrix case, before parity, and find what production gets wrong:
// images squished or stretched (rendered aspect ratio off the natural one by more than 2 percent with object-fit fill
// or none), an icon off its heading's center by more than 4 px or wrapped to its own line, text that overflows or is
// clipped by its box, overlapping text, and horizontal page scroll. Each defect becomes a decisions ledger row
// ("production defect: fix in target"), and the parity checks then compare the target with the corrected expectation
// for that element instead of with production. With --target, a target that copies a defect fails.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
//
// Why: the refactor faithfully copied production bugs, an icon and a section heading misaligned at small widths and
// images squished at some widths, because every check treated production as the truth.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  parseArgsFor,
  result,
  routesOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";

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
  icon-misaligned   an icon whose vertical center is over ${ICON_CENTER_TOLERANCE} px off its heading's, in the same row
  icon-wrapped      an icon on its own line above or below its heading
  text-overflow     text wider or taller than its box
  text-clipped      text cut off by overflow hidden (without an intended ellipsis or line clamp)
  text-overlap      two text boxes on top of each other (a fixed, sticky or dialog layer such as a cookie banner covers
                    the page by design and is left to presence-by-route)
  horizontal-scroll the page scrolls sideways
Each defect is appended once to the decisions ledger as "${LEDGER_NOTE}" with its route, width and selector, and
the parity checks (run-checks.mjs) compare the target with the corrected expectation for that element at that case.
With --target, the target is measured too: a copied defect or a defect only the target has is a finding.
Without --target, exits 0 after writing the ledger rows; with it, exits 1 on any finding.

Options:
  --prod <url>       Live production origin
  --target <url>     Bascik origin, such as http://localhost:8080 (optional: production alone lists the defects)
  --route <path>     Route to check (repeatable, required)
  --ledger <file>    Decisions ledger to append to (default docs/migration/decisions.md)
  --mask <selector>  A documented dynamic region to skip, such as a carousel (repeatable)
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
    add(
      "squished",
      img,
      `${img.key} at ${width} px is drawn ${Math.round(rendered.width)}x${Math.round(rendered.height)} (${got.toFixed(2)}:1), but the file is ${ratioText(natural.width, natural.height)} (${want.toFixed(2)}:1) and object-fit is ${objectFit}: ${got < want ? "squished" : "stretched"}`,
    );
  }
  for (const row of snapshot.iconRows ?? []) {
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
  const texts = snapshot.texts ?? [];
  for (const t of texts) {
    const wide = t.scrollWidth - t.clientWidth > 1;
    const tall = t.scrollHeight - t.clientHeight > 1;
    if (!wide && !tall) continue;
    const clipped = ["hidden", "clip"].includes(t.overflow);
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

const defectId = (d) =>
  `${d.kind}|${d.route}|${d.width}|${d.key ?? d.selector}${d.other ? `|${d.other}` : ""}`;

/**
 * Compares the target's defects with production's at the same cases. A defect on both sides is copied-defect (the
 * target must fix it, not copy it); one only the target has is target-defect. A fixed defect passes.
 */
export function diffDefects(prod, target) {
  const prodIds = new Set(prod.map(defectId));
  const findings = [];
  for (const d of target) {
    const copied = prodIds.has(defectId(d));
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
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

/** One decisions-ledger row per defect, in the template's columns, with a stable id. */
export function ledgerRows(defects) {
  return defects.map((d) => {
    const id = `PD-${createHash("sha256").update(defectId(d)).digest("hex").slice(0, 6)}`;
    return `| ${id} | ${cell(d.route)} | ${d.width} px wide | ${cell(d.kind)}: ${cell(d.message)} (\`${cell(d.selector)}\`) | ${LEDGER_NOTE} | the target fixes what production gets wrong | ${CHECK}.mjs | |`;
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
export function appendLedger(file, defects) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const ids = new Set(
    [...text.matchAll(/^\|\s*(PD-[0-9a-f]+)\s*\|/gm)].map((m) => m[1]),
  );
  const rows = [];
  for (const row of ledgerRows(defects)) {
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
          ((d.key && (f.key === d.key || f.section === d.key)) ||
            (d.selector && f.selector === d.selector)),
      );
    (hit ? corrected : kept).push(f);
  }
  return { kept, corrected };
}

/** In the page: images, icon rows, text boxes and page scroll, as detectDefects reads them. */
function measureDefects(arg) {
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
    texts.push({
      key: textKey(el),
      selector: selectorOf(el),
      path: pathOf(el),
      rect: { x, y: y + scrollY, width: right - x, height: bottom - y },
      scrollWidth: intended ? el.clientWidth : el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: intended ? el.clientHeight : el.scrollHeight,
      clientHeight: el.clientHeight,
      overflow: overflowX === "visible" ? cs.overflowY : overflowX,
      layer: layerOf(el) !== null,
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

async function measure(browser, origin, route, c, masks) {
  return withPage(
    browser,
    origin,
    route,
    c,
    async (page) => ({
      route,
      width: c.width,
      height: c.height,
      ...(await inPage(page, measureDefects, { masks })),
    }),
    masks,
  );
}

/**
 * Resolves to { check, ok, findings, defects, ledger }: production's defects, their ledger rows, and with a target,
 * the copied and target-only defects as findings. Options: prod, target (optional), routes, cases, ledger (a file to
 * append the rows to; nothing is written without it).
 */
export async function runCheck(browser, options) {
  const masks = masksOf(options);
  const defects = [];
  const findings = [];
  for (const route of routesOf(options))
    for (const c of casesOf(options)) {
      const [prodSnap, targetSnap] = await Promise.all([
        measure(browser, options.prod, route, c, masks),
        options.target
          ? measure(browser, options.target, route, c, masks)
          : null,
      ]);
      const prod = detectDefects(prodSnap);
      defects.push(...prod);
      if (targetSnap)
        findings.push(...diffDefects(prod, detectDefects(targetSnap)));
    }
  const written = options.ledger ? appendLedger(options.ledger, defects) : 0;
  return result(CHECK, findings, {
    defects,
    ledger: ledgerRows(defects),
    ledgerFile: options.ledger,
    written,
  });
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: { ledger: { type: "string" } },
    need: ["prod", "route"],
  });
  if (args.help) return args;
  return { ...args, ledger: args.ledger ?? "docs/migration/decisions.md" };
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
          ? `      ${report.defects.length} production defect(s); ${report.written} new row(s) written to ${report.ledgerFile} as "${LEDGER_NOTE}". The target must fix each one; the parity checks compare it with the corrected expectation there.`
          : "      no production defects found",
      ],
    });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
