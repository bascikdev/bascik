#!/usr/bin/env node
// Spacing diff: inside each section, compare the vertical gap between consecutive visible block siblings and each
// child's offset from its section's top, at a 2 px default tolerance. Measuring inside each section resets the
// cumulative drift that hides a local spacing error in absolute geometry.
// Dependency-free; Node.js 22.18+; needs playwright (or @playwright/test) in your project.
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
that add up). Hidden elements, fixed layers and masked regions do not count. Exits 1 on any finding.

Options:
  --prod <url>          Live production origin
  --target <url>        Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>        Route to compare (repeatable, required)
  --tolerance <px>      Allowed difference in CSS pixels (default 2)
  --mask <selector>     A documented dynamic region to skip, such as a carousel (repeatable)
  --matrix <file>       Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>           Report folder (default artifacts/checks)
  --json                Print the report as JSON
  --help                Show this message`;

const sign = (n) => `${n > 0 ? "+" : ""}${n}`;
const tenth = (n) => Math.round(n * 10) / 10;

/**
 * Compares sections ([{ key, children: [{ key, offset, gap }] }]) on both sides. A child is a block of content (text,
 * an image, a control) at any depth in the section; gap is the space between it and the block above it, or null when
 * it sits beside that block (a grid or flex row). Finding kinds:
 *   gap              the space above a block differs
 *   offset           a block moved within its section with no gap finding to explain it: the section's top padding,
 *                    a block beside another that moved on its own, or small gap errors that add up past the tolerance
 *   missing          a block the target lacks
 *   missing-section  a section the target lacks
 * Findings never spill from one section into another, and one wrong gap is reported once, not again for every block
 * below it or beside it.
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
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(tagOf(el)))
      continue;
    if (el.parentElement?.closest("svg")) continue;
    if (!isBlock(el) || !isRendered(el) || isMasked(el, arg.masks)) continue;
    // Text inside a control belongs to the control.
    if (!MEDIA.has(tagOf(el)) && el.parentElement?.closest("button, select"))
      continue;
    let fixed = false;
    for (let n = el; n && n !== document.body; n = n.parentElement)
      if (getComputedStyle(n).position === "fixed") {
        fixed = true;
        break;
      }
    if (fixed) continue;
    const section = sectionOf(el);
    const key = sectionKey(section);
    if (!sections.has(key))
      sections.set(key, { el: section, key, children: [], keys: new Set() });
    const entry = sections.get(key);
    const r = el.getBoundingClientRect();
    const text = norm(el.textContent) || accName(el);
    let childKey = `${tagOf(el)}:${text.slice(0, 40).trim()}`;
    for (let n = 2; entry.keys.has(childKey); n++)
      childKey = `${tagOf(el)}:${text.slice(0, 40).trim()} #${n}`;
    entry.keys.add(childKey);
    entry.children.push({ key: childKey, rect: r });
  }
  const out = [];
  for (const { el, key, children } of sections.values()) {
    const top = el.getBoundingClientRect().top;
    let previous = null;
    out.push({
      key,
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
