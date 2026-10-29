#!/usr/bin/env node
// Spacing diff: inside each section, compare the vertical gap between consecutive visible block siblings, each
// child's offset from its section's top and each child's height, at a 2 px default tolerance; between sections,
// compare each section's height and the space between it and the section before it. Measuring inside each section
// resets the cumulative drift that hides a local spacing error in absolute geometry.
// Dependency-free; Node.js 22.22+; needs playwright (or @playwright/test) in your project.
//
// Why: vertical spacing between elements was off by tens of pixels, and an absolute |dy| > 12 threshold never saw it.
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  masksOf,
  parseArgsFor,
  pixels,
  result,
  routesOf,
  settleOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "spacing-diff";
export const DEFAULT_TOLERANCE = 2;

const HELP = `Usage: node spacing-diff.mjs --prod <url> --target <url> --route <path>... [options]

For every section (section, header, footer, main, aside, article, nav, and BODY for content outside them), measures
each block of content at any depth (an element with its own text that is not inline, an image, svg or video, a
control): its offset from the section's top and the vertical gap to the block above it, on both sides at every
matrix case, and flags differences above the tolerance. A gap finding names the pair; an offset finding names a block
that moved without a gap that explains it (the section's top padding, a block beside another, or small gap errors
that add up); a height finding names a block that grew or shrank (a taller button moves everything below it). Between
sections it compares the space between each section and the one before it (margins that stop collapsing) and each
section's height (a bottom padding halved), unless a finding inside the section already explains the height. Hidden
elements, fixed layers and masked regions do not count. Exits 1 on any finding.

Options:
  --prod <url>          Live production origin
  --target <url>        Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>        Route to compare (repeatable, required)
  --tolerance <px>      Allowed difference in CSS pixels (default 2)
  --mask <selector>     A documented dynamic region to skip, such as a carousel (repeatable)
  --settle-ms <ms>      Least time after navigation before measuring (default 5000)
  --matrix <file>       Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>           Report folder (default artifacts/checks)
  --json                Print the report as JSON
  --help                Show this message`;

const sign = (n) => `${n > 0 ? "+" : ""}${n}`;
const tenth = (n) => Math.round(n * 10) / 10;

/**
 * Compares sections ([{ key, children: [{ key, offset, gap, height }], height?, gap?, within? }]) on both sides. A child
 * is a block of content (text, an image, a control) at any depth in the section; gap is the space between it and the
 * block above it, or null when it sits beside that block (a grid or flex row). A section's own gap is the space
 * between it and the previous section with the same parent section (null for the first), and `within` lists the keys
 * of the sections it sits in. Finding kinds:
 *   gap              the space above a block differs
 *   offset           a block moved within its section with no gap finding to explain it: the section's top padding,
 *                    a block beside another that moved on its own, or small gap errors that add up past the tolerance
 *   height           a block is taller or shorter (a button with more padding moves everything below it)
 *   section-gap      the space between a section and the one before it differs (margins that stop collapsing)
 *   section-height   a section is taller or shorter with no finding inside it to explain it (its bottom padding)
 *   missing          a block the target lacks
 *   missing-section  a section the target lacks
 * Findings never spill from one section into another, and one wrong gap is reported once, not again for every block
 * below it or beside it, nor again as the height of every section around it.
 */
export function diffSpacing(
  prod,
  target,
  { tolerance = DEFAULT_TOLERANCE } = {},
) {
  const findings = [];
  const bySection = new Map(target.map((s) => [s.key, s]));
  for (const section of prod) {
    const other = bySection.get(section.key);
    if (!other) {
      findings.push(
        finding(
          CHECK,
          "missing-section",
          `${section.key} is in production but not on the target`,
          { section: section.key },
        ),
      );
      continue;
    }
    const children = new Map(other.children.map((c) => [c.key, c]));
    // drift: small gap errors under the tolerance since the last finding, which add up along a column.
    // explained: the largest shift already reported in this section, which moves the blocks beside and below it.
    let drift = 0;
    let explained = 0;
    let previous = null;
    for (const child of section.children) {
      const t = children.get(child.key);
      if (!t) {
        findings.push(
          finding(
            CHECK,
            "missing",
            `${child.key} in ${section.key} is in production but not on the target`,
            { section: section.key, key: child.key },
          ),
        );
        previous = child.key;
        explained = Infinity;
        continue;
      }
      const where = { section: section.key, key: child.key };
      if (
        child.height !== undefined &&
        t.height !== undefined &&
        Math.abs(t.height - child.height) > tolerance
      ) {
        const delta = tenth(t.height - child.height);
        findings.push(
          finding(
            CHECK,
            "height",
            `${section.key}: ${child.key} is ${child.height} px tall in production and ${t.height} px on the target (${sign(delta)} px moves everything below it)`,
            { ...where, prod: child.height, target: t.height, delta },
          ),
        );
      }
      if (child.gap !== null && t.gap !== null) {
        const delta = tenth(t.gap - child.gap);
        if (Math.abs(delta) > tolerance) {
          findings.push(
            finding(
              CHECK,
              "gap",
              `${section.key}: the gap between ${previous} and ${child.key} is ${child.gap} px in production and ${t.gap} px on the target (${sign(delta)} px)`,
              { ...where, previous, prod: child.gap, target: t.gap, delta },
            ),
          );
          explained = Math.max(explained, Math.abs(delta));
          drift = 0;
        } else {
          drift = tenth(drift + delta);
          if (Math.abs(drift) > tolerance) {
            findings.push(
              finding(
                CHECK,
                "offset",
                `${section.key}: ${child.key} sits ${child.offset} px below the section top in production and ${t.offset} px on the target (${sign(drift)} px of small gap differences above it add up)`,
                {
                  ...where,
                  prod: child.offset,
                  target: t.offset,
                  delta: drift,
                },
              ),
            );
            explained = Math.max(explained, Math.abs(drift));
            drift = 0;
          }
        }
      } else {
        // The first block, or one beside the block above it: its own offset from the section top must match.
        const delta = tenth(t.offset - child.offset);
        drift = 0;
        if (
          Math.abs(delta) > tolerance &&
          Math.abs(delta) > explained + tolerance
        ) {
          findings.push(
            finding(
              CHECK,
              "offset",
              `${section.key}: ${child.key} sits ${child.offset} px below the section top in production and ${t.offset} px on the target (${sign(delta)} px not explained by a gap above it)`,
              { ...where, prod: child.offset, target: t.offset, delta },
            ),
          );
          explained = Math.max(explained, Math.abs(delta));
        }
      }
      previous = child.key;
    }
  }
  return [
    ...findings,
    ...diffSectionSpacing(prod, target, findings, tolerance),
  ];
}

/**
 * The space between sections and their heights (see diffSpacing). A section's height is reported only when nothing
 * inside it (a block finding in it, or a finding on a section within it) already explains the difference.
 */
function diffSectionSpacing(prod, target, inner, tolerance) {
  const findings = [];
  const bySection = new Map(target.map((s) => [s.key, s]));
  for (const section of prod) {
    const t = bySection.get(section.key);
    if (!t) continue;
    if (
      section.gap !== undefined &&
      section.gap !== null &&
      t.gap !== undefined &&
      t.gap !== null &&
      Math.abs(t.gap - section.gap) > tolerance
    ) {
      const delta = tenth(t.gap - section.gap);
      findings.push(
        finding(
          CHECK,
          "section-gap",
          `the space between ${section.previous} and ${section.key} is ${section.gap} px in production and ${t.gap} px on the target (${sign(delta)} px moves every section below it)`,
          {
            section: section.key,
            previous: section.previous,
            prod: section.gap,
            target: t.gap,
            delta,
          },
        ),
      );
    }
  }
  const explained = new Set();
  for (const f of [...inner, ...findings]) {
    explained.add(f.section);
    const s = prod.find((p) => p.key === f.section);
    for (const outer of s?.within ?? []) explained.add(outer);
  }
  const heights = [];
  for (const section of prod) {
    const t = bySection.get(section.key);
    if (!t || section.height === undefined || t.height === undefined) continue;
    if (Math.abs(t.height - section.height) <= tolerance) continue;
    heights.push({ section, t });
  }
  // A section whose inner section grew is explained by that one; report the innermost.
  for (const { section } of heights)
    for (const outer of section.within ?? []) explained.add(outer);
  for (const { section, t } of heights) {
    if (explained.has(section.key)) continue;
    const delta = tenth(t.height - section.height);
    findings.push(
      finding(
        CHECK,
        "section-height",
        `${section.key} is ${section.height} px tall in production and ${t.height} px on the target (${sign(delta)} px with no block inside it that moved: check its padding)`,
        {
          section: section.key,
          prod: section.height,
          target: t.height,
          delta,
        },
      ),
    );
  }
  return findings;
}

/**
 * In the page: every section with the blocks of content inside it. A section is a landmark (section, header, footer,
 * main, aside, article, nav); content outside every landmark belongs to BODY, so a page built from plain divs is
 * measured too. A block is an element with its own text that is not laid out inline, an image, svg, video, canvas or
 * iframe, or a control, at any depth: the wrappers between it and its section do not matter, so an error three
 * wrappers deep is still a local gap. Fixed layers, masked regions and hidden elements do not count.
 */
function measureSections(arg) {
  const LANDMARKS = "section, header, footer, main, aside, article, nav";
  const MEDIA = new Set(["IMG", "SVG", "VIDEO", "CANVAS", "IFRAME", "PICTURE"]);
  const CONTROLS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
  const round = (v) => Math.round(v * 10) / 10;
  const isBlock = (el) => {
    const tag = tagOf(el);
    if (MEDIA.has(tag) || CONTROLS.has(tag)) return true;
    const own = [...el.childNodes].some(
      (n) => n.nodeType === 3 && norm(n.textContent),
    );
    if (!own) return false;
    return getComputedStyle(el).display !== "inline";
  };
  const sections = new Map();
  const sectionOf = (el) =>
    el.parentElement?.closest(LANDMARKS) ?? document.body;
  const keyOfSection = new Map();
  const seen = new Set();
  const sectionKey = (el) => {
    if (keyOfSection.has(el)) return keyOfSection.get(el);
    let key;
    if (el === document.body) key = "BODY";
    else {
      const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
      const label = (norm(heading?.textContent) || accName(el))
        .slice(0, 40)
        .trim();
      key = `${tagOf(el)}:${label}`;
      for (let n = 2; seen.has(key); n++) key = `${tagOf(el)}:${label} #${n}`;
    }
    seen.add(key);
    keyOfSection.set(el, key);
    return key;
  };
  const inFixed = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement)
      if (getComputedStyle(n).position === "fixed") return true;
    return false;
  };
  // Every rendered landmark, in document order, keyed before any block so keys do not depend on content.
  const landmarks = [...document.body.querySelectorAll(LANDMARKS)].filter(
    (el) => isRendered(el) && !isMasked(el, arg.masks) && !inFixed(el),
  );
  for (const el of landmarks) sectionKey(el);
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(tagOf(el)))
      continue;
    if (el.parentElement?.closest("svg")) continue;
    if (!isBlock(el) || !isRendered(el) || isMasked(el, arg.masks)) continue;
    // Text inside a control belongs to the control.
    if (!MEDIA.has(tagOf(el)) && el.parentElement?.closest("button, select"))
      continue;
    if (inFixed(el)) continue;
    const section = sectionOf(el);
    const key = sectionKey(section);
    if (!sections.has(key))
      sections.set(key, { el: section, key, children: [], keys: new Set() });
    const entry = sections.get(key);
    const r = el.getBoundingClientRect();
    const text = textOf(el) || accName(el);
    let childKey = `${tagOf(el)}:${text.slice(0, 40).trim()}`;
    for (let n = 2; entry.keys.has(childKey); n++)
      childKey = `${tagOf(el)}:${text.slice(0, 40).trim()} #${n}`;
    entry.keys.add(childKey);
    entry.children.push({ key: childKey, rect: r });
  }
  // Each landmark's height, the space to the previous landmark with the same parent landmark, and its outer landmarks.
  const geometry = new Map();
  const lastIn = new Map();
  for (const el of landmarks) {
    const parent = el.parentElement?.closest(LANDMARKS) ?? document.body;
    const r = el.getBoundingClientRect();
    const before = lastIn.get(parent);
    const within = [];
    for (let n = parent; n && n !== document.body;) {
      within.push(sectionKey(n));
      n = n.parentElement?.closest(LANDMARKS) ?? document.body;
    }
    // A landmark beside the one before it (an article in a grid row) has no vertical space to it.
    const below = before && r.top >= before.rect.bottom - 1;
    geometry.set(el, {
      height: round(r.height),
      gap: below ? round(r.top - before.rect.bottom) : null,
      previous: before ? sectionKey(before.el) : null,
      within,
    });
    lastIn.set(parent, { el, rect: r });
  }
  const out = [];
  for (const el of landmarks)
    if (!sections.has(keyOfSection.get(el)))
      sections.set(keyOfSection.get(el), {
        el,
        key: keyOfSection.get(el),
        children: [],
        keys: new Set(),
      });
  for (const { el, key, children } of sections.values()) {
    const top = el.getBoundingClientRect().top;
    let previous = null;
    out.push({
      key,
      ...(geometry.get(el) ?? {}),
      children: children.map(({ key: childKey, rect }) => {
        // A block beside the one above it (its top above that block's bottom) has no vertical gap to it.
        const below = previous && rect.top >= previous.bottom - 1;
        const child = {
          key: childKey,
          offset: round(rect.top - top),
          gap: below ? round(rect.top - previous.bottom) : null,
          height: round(rect.height),
        };
        previous = rect;
        return child;
      }),
    });
  }
  return out;
}

/** Resolves to { check, ok, findings }. Options: prod, target, routes, cases, tolerance. */
export async function runCheck(browser, options) {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const masks = masksOf(options);
  const findings = [];
  for (const route of routesOf(options))
    for (const c of casesOf(options)) {
      const measure = (origin) =>
        withPage(
          browser,
          origin,
          route,
          c,
          (page) => inPage(page, measureSections, { masks }),
          masks,
          settleOf(options),
        );
      const [prod, target] = await Promise.all([
        measure(options.prod),
        measure(options.target),
      ]);
      for (const f of diffSpacing(prod, target, { tolerance }))
        findings.push({ ...f, route, width: c.width });
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
