#!/usr/bin/env node
// Route comparison: capture production and the Bascik target with identical settings at every breakpoint matrix
// case, count differing pixels, diff element geometry, record evidence, and replay the route's interactions on both
// sides. Writes report.json and PNGs per route under --out (keep that folder in .gitignore).
// Dependency-free; Node.js 22.22+; needs playwright (or @playwright/test) and sharp in your project.
// Read-only toward both sites: it never submits forms; keep submit buttons out of interactions.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { contextOptions, openPage, routeUrl } from "./lib/capture.mjs";
import { loadMatrix } from "./lib/matrix.mjs";
import { loadPlaywright, loadSharp } from "./lib/project-deps.mjs";
import { collectNodes, diffGeometry } from "./geometry-diff.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export { contextOptions };

const HELP = `Usage: node compare-route.mjs --prod <url> --target <url> --route <path>... [options]

Compares a route on production and on the Bascik target at every breakpoint matrix case in three layers:
pixels (per-channel tolerance), geometry (collectNodes) and interactions (interactions.json). No route passes on
one screenshot or a Lighthouse score. Exits 1 when any case fails.

Options:
  --prod <url>            Live production origin
  --target <url>          Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>          Route to compare (repeatable, required)
  --matrix <file>         Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --interactions <file>   Interaction steps JSON (optional; see below)
  --mask <selector>       Element to paint over on both sides, such as a rotating carousel (repeatable)
  --evidence <selector>   Element whose box and computed styles go into the report (repeatable;
                          default: header, h1, main, footer)
  --tolerance <n>         Per-channel pixel tolerance 0-255 (default 10)
  --max-ratio <r>         Share of differing pixels a case may have (default 0.001)
  --accepted <file>       Accepted differences: decisions ledger rows turned into masks or budgets (see below)
  --out <dir>             Report folder (default artifacts/compare)
  --help                  Show this message

interactions.json is an array of steps run in order on one page per matrix case:
  { "name": "open menu", "route": "/", "testId": "menu-trigger", "panel": { "testId": "menu-panel" },
    "action": "click", "expect": { "ariaExpanded": true, "visible": true }, "minWidth": 1024 }
A step finds its trigger by "selector", "testId" or "role" plus "roleName"; add "nth" (0-based) when several elements
match. Actions: click, press (needs "key"), hover, keyboard (needs "key", pressed on the page), outside-click,
focus-out. A trigger or panel that is missing at a case fails that step at once, naming the locator.

accepted.json lets an intentional difference pass without hiding anything else. Each entry names its row in
docs/migration/decisions.md and narrows itself by route and width:
  [{ "id": "D-01", "route": "/", "mask": ["footer"] },
   { "id": "D-02", "maxWidth": 767, "maxRatio": 0.02 }]
"mask" paints those elements over on both sides; "maxRatio" replaces --max-ratio for matching cases. The report
lists the ids applied to each case. Never raise --max-ratio globally to make a difference pass.`;

export const ACTIONS = Object.freeze([
  "click",
  "press",
  "hover",
  "keyboard",
  "outside-click",
  "focus-out",
]);

/**
 * Counts pixels whose R, G, B or A differs by more than `tolerance` between two raw RGBA buffers of the same size.
 * Pixels inside `masks` ({ x, y, width, height }) are skipped and left out of `total`.
 */
export function pixelDiff(
  a,
  b,
  width,
  height,
  { tolerance = 10, masks = [] } = {},
) {
  const expected = width * height * 4;
  if (a.length !== expected || b.length !== expected)
    throw new Error(
      `pixelDiff: buffer size mismatch: ${width}x${height} needs ${expected} bytes, got ${a.length} and ${b.length}`,
    );
  const masked = (x, y) =>
    masks.some(
      (m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height,
    );
  let count = 0;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (masks.length && masked(x, y)) continue;
      total++;
      const i = (y * width + x) * 4;
      if (
        Math.abs(a[i] - b[i]) > tolerance ||
        Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
        Math.abs(a[i + 2] - b[i + 2]) > tolerance ||
        Math.abs(a[i + 3] - b[i + 3]) > tolerance
      )
        count++;
    }
  }
  return { count, total, ratio: total ? count / total : 0 };
}

/** Throws a located error for a step that cannot run. `index` is its position in interactions.json. */
export function validateStep(step, index) {
  const label = `interactions[${index}] "${step?.name ?? "(unnamed)"}"`;
  if (!ACTIONS.includes(step?.action))
    throw new Error(
      `${label}: unknown action "${step?.action}"; use one of ${ACTIONS.join(", ")}`,
    );
  if (!step.selector && !step.testId && !step.role)
    throw new Error(
      `${label}: needs a selector, testId or role (with roleName) to find its trigger`,
    );
  if ((step.action === "press" || step.action === "keyboard") && !step.key)
    throw new Error(
      `${label}: action "${step.action}" needs a key, such as "Enter" or "Escape"`,
    );
  for (const [where, spec] of [
    ["", step],
    ["panel ", step.panel ?? {}],
  ])
    if (spec.nth !== undefined && (!Number.isInteger(spec.nth) || spec.nth < 0))
      throw new Error(
        `${label}: ${where}nth must be a 0-based index such as 0 or 1 (got ${JSON.stringify(spec.nth)})`,
      );
}

/** How a target spec reads in an error: testId "menu-trigger", role button "Menu", selector "#menu". */
function describeTarget(target) {
  if (target.testId) return `testId "${target.testId}"`;
  if (target.role)
    return `role ${target.role}${target.roleName ? ` "${target.roleName}"` : ""}`;
  return `selector "${target.selector}"`;
}

/**
 * A locator from a target spec: { selector } | { testId } | { role, roleName }, plus an optional "nth". Checks the
 * match count first, so a typo fails at once instead of waiting for Playwright's 30 s timeout, and a name that matches
 * several elements asks for "nth" instead of a strict-mode error. Classes are hashed in production builds, so prefer
 * roles and test ids.
 */
async function locate(page, target, what, at) {
  let locator;
  if (target.testId) locator = page.getByTestId(target.testId);
  else if (target.role)
    locator = page.getByRole(
      target.role,
      target.roleName ? { name: target.roleName, exact: true } : {},
    );
  else locator = page.locator(target.selector);
  const where = at ? ` at ${at}` : "";
  const count = await locator.count();
  if (count === 0)
    throw new Error(`${what} ${describeTarget(target)} not found${where}`);
  if (target.nth !== undefined) {
    if (target.nth >= count)
      throw new Error(
        `${what} ${describeTarget(target)} has ${count} match(es)${where}; nth ${target.nth} is out of range`,
      );
    return locator.nth(target.nth);
  }
  if (count > 1)
    throw new Error(
      `${what} ${describeTarget(target)} matches ${count} elements${where}; add "nth" (0-based) to the step`,
    );
  return locator;
}

const asBool = (value) =>
  value === "true" ? true : value === "false" ? false : value;

/**
 * Runs one interaction step and checks its expectations. Returns { name, action, ok, failures, before, after }, where
 * before and after are { ariaExpanded, visible, focused }: the trigger's aria-expanded, whether the panel (or the
 * trigger, without a panel) is visible, and whether focus is on or inside the trigger.
 */
export async function runInteraction(page, step, index = 0, { label } = {}) {
  validateStep(step, index);
  const trigger = await locate(page, step, "trigger", label);
  const panel = step.panel
    ? await locate(page, step.panel, "panel", label)
    : null;
  const state = async () => ({
    ariaExpanded: asBool(await trigger.getAttribute("aria-expanded")),
    visible: await (panel ?? trigger).isVisible(),
    focused: await trigger.evaluate(
      (el) =>
        el === document.activeElement || el.contains(document.activeElement),
    ),
  });
  const before = await state();
  switch (step.action) {
    case "click":
      await trigger.click();
      break;
    case "press":
      await trigger.press(step.key);
      break;
    case "hover":
      await trigger.hover();
      break;
    case "keyboard":
      await page.keyboard.press(step.key);
      break;
    case "outside-click":
      await page.mouse.click(step.x ?? 1, step.y ?? 1);
      break;
    case "focus-out":
      await trigger.blur();
      break;
  }
  if (typeof page.waitForTimeout === "function")
    await page.waitForTimeout(step.waitMs ?? 100);
  const after = await state();
  const failures = [];
  for (const [key, expected] of Object.entries(step.expect ?? {})) {
    if (after[key] !== expected)
      failures.push(`${key}: expected ${expected}, got ${after[key]}`);
  }
  return {
    name: step.name,
    action: step.action,
    ok: failures.length === 0,
    failures,
    before,
    after,
  };
}

/**
 * The route report. A case passes when its pixel ratio is within maxRatio (or the budget its accepted entries set), its geometry diff (when present) is ok
 * and every interaction passes. The report passes when every case passes; an empty case list never passes.
 */
export function buildReport({
  route,
  prod,
  target,
  tolerance,
  maxRatio,
  cases,
}) {
  const failures = [];
  const checked = cases.map((c) => {
    const label = `${c.width}x${c.height}`;
    const own = [];
    const budget = c.accepted?.maxRatio ?? maxRatio;
    const ids = c.accepted?.ids?.length
      ? `, accepted ${c.accepted.ids.join(", ")}`
      : "";
    if (c.pixels && c.pixels.ratio > budget)
      own.push(
        `${label}: ${(c.pixels.ratio * 100).toFixed(2)}% of pixels differ (${c.pixels.count} of ${c.pixels.total}; budget ${(budget * 100).toFixed(2)}%${ids})`,
      );
    for (const problem of c.problems ?? []) own.push(`${label}: ${problem}`);
    if (c.geometry && !c.geometry.ok)
      own.push(
        `${label}: geometry: ${c.geometry.moved.length} moved, ${c.geometry.missing.length} missing, ${c.geometry.extra.length} extra`,
      );
    for (const i of c.interactions ?? [])
      if (!i.ok)
        own.push(
          `${label}: interaction "${i.name}" failed: ${i.failures.join("; ")}`,
        );
    failures.push(...own);
    return { ...c, ok: own.length === 0 };
  });
  if (checked.length === 0) failures.push("no matrix cases were compared");
  return {
    route,
    prod,
    target,
    tolerance,
    maxRatio,
    ok: failures.length === 0,
    failures,
    cases: checked,
  };
}

/**
 * Rejects a route that is not a path on the site: it must start with "/", and a "." or ".." segment (which the
 * browser would resolve to another page) is refused rather than compared under a name that is not its own.
 */
function validateRoute(route) {
  const path = route.split(/[?#]/, 1)[0];
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
 * The report folder under --out for a route: a readable slug of the path plus a hash of the exact route. The slug
 * keeps only lowercase letters, digits, "-" and "_", so no route names a folder outside --out, and the hash keeps
 * distinct routes (/a/b and /a_b, /A and /a, /a and /a/) in distinct folders, also on a case-insensitive disk.
 */
export function reportDirName(route) {
  const slug =
    route
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "_")
      .slice(0, 60) || "index";
  const hash = createHash("sha256").update(route).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      prod: { type: "string" },
      target: { type: "string" },
      route: { type: "string", multiple: true },
      matrix: { type: "string" },
      interactions: { type: "string" },
      mask: { type: "string", multiple: true },
      accepted: { type: "string" },
      evidence: { type: "string", multiple: true },
      tolerance: { type: "string" },
      "max-ratio": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (!values.prod) throw new Error("--prod <url> is required");
  if (!values.target) throw new Error("--target <url> is required");
  if (!values.route?.length)
    throw new Error("--route <path> is required (repeatable)");
  const seen = new Set();
  for (const route of values.route) {
    validateRoute(route);
    if (seen.has(route))
      throw new Error(
        `--route ${route} is given twice; its second report would overwrite the first`,
      );
    seen.add(route);
  }
  const tolerance =
    values.tolerance === undefined ? 10 : Number(values.tolerance);
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255)
    throw new Error(
      `--tolerance must be an integer from 0 to 255 (got "${values.tolerance}")`,
    );
  const maxRatio =
    values["max-ratio"] === undefined ? 0.001 : Number(values["max-ratio"]);
  if (!Number.isFinite(maxRatio) || maxRatio < 0 || maxRatio > 1)
    throw new Error(
      `--max-ratio must be a number from 0 to 1 (got "${values["max-ratio"]}")`,
    );
  return {
    prod: values.prod,
    target: values.target,
    route: values.route,
    matrix: values.matrix ?? "docs/migration/breakpoints.json",
    interactions: values.interactions,
    mask: values.mask ?? [],
    accepted: values.accepted,
    evidence: values.evidence ?? ["header", "h1", "main", "footer"],
    tolerance,
    maxRatio,
    out: values.out ?? "artifacts/compare",
  };
}

/** Reads interactions.json and validates every step up front, so a typo fails before any browser starts. */
export function loadInteractions(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: cannot read interactions (${error.message})`);
  }
  const steps = Array.isArray(data) ? data : data?.interactions;
  if (!Array.isArray(steps))
    throw new Error(`${file}: expected an array of steps`);
  steps.forEach((step, i) => {
    try {
      validateStep(step, i);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  });
  return steps;
}

const ACCEPTED_KEYS = new Set([
  "id",
  "route",
  "minWidth",
  "maxWidth",
  "mask",
  "maxRatio",
  "reason",
]);

/**
 * Reads accepted.json: an array of { id, route?, minWidth?, maxWidth?, mask?: [selector], maxRatio?, reason? }, each
 * tied to a row of the decisions ledger by id. Errors name the file and the entry index.
 */
export function loadAccepted(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${file}: cannot read accepted differences (${error.message})`,
    );
  }
  if (!Array.isArray(data))
    throw new Error(`${file}: expected an array of accepted differences`);
  data.forEach((entry, i) => {
    const at = `${file}: [${i}]`;
    if (typeof entry?.id !== "string" || !entry.id)
      throw new Error(
        `${at}: needs an "id" naming its row in docs/migration/decisions.md`,
      );
    for (const key of Object.keys(entry))
      if (!ACCEPTED_KEYS.has(key))
        throw new Error(
          `${at} ${entry.id}: unknown key "${key}"; use ${[...ACCEPTED_KEYS].join(", ")}`,
        );
    if (
      entry.mask !== undefined &&
      (!Array.isArray(entry.mask) ||
        entry.mask.some((m) => typeof m !== "string"))
    )
      throw new Error(`${at} ${entry.id}: mask must be an array of selectors`);
    if (
      entry.maxRatio !== undefined &&
      (typeof entry.maxRatio !== "number" ||
        entry.maxRatio < 0 ||
        entry.maxRatio > 1)
    )
      throw new Error(
        `${at} ${entry.id}: maxRatio must be a number from 0 to 1 (got ${JSON.stringify(entry.maxRatio)})`,
      );
    if (!entry.mask?.length && entry.maxRatio === undefined)
      throw new Error(
        `${at} ${entry.id}: accepts nothing; give it a mask or a maxRatio`,
      );
  });
  return data;
}

const inRange = (entry, route, c) =>
  (entry.route === undefined || entry.route === route) &&
  (entry.minWidth === undefined || c.width >= entry.minWidth) &&
  (entry.maxWidth === undefined || c.width <= entry.maxWidth);

/** The accepted entries for one route and case: their ids, the selectors to mask, and the largest budget they set. */
export function acceptedFor(accepted, route, c) {
  const hits = accepted.filter((entry) => inRange(entry, route, c));
  const ratios = hits
    .map((entry) => entry.maxRatio)
    .filter((r) => r !== undefined);
  return {
    ids: hits.map((entry) => entry.id),
    masks: [...new Set(hits.flatMap((entry) => entry.mask ?? []))],
    maxRatio: ratios.length ? Math.max(...ratios) : undefined,
  };
}

const appliesTo = (step, route, c) =>
  (step.route === undefined || step.route === route) &&
  (step.minWidth === undefined || c.width >= step.minWidth) &&
  (step.maxWidth === undefined || c.width <= step.maxWidth);

/** Box, image source and a fixed list of computed styles for the first element matching each selector. */
async function evidence(page, selectors) {
  return page.evaluate((list) => {
    const PROPS = [
      "display",
      "position",
      "box-sizing",
      "width",
      "height",
      "margin",
      "padding",
      "gap",
      "align-items",
      "justify-content",
      "overflow",
      "color",
      "background-color",
      "background-image",
      "border",
      "border-radius",
      "box-shadow",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "text-align",
      "white-space",
      "transform",
      "z-index",
    ];
    const out = { fonts: document.fonts.status, elements: {}, images: [] };
    for (const selector of list) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.elements[selector] = {
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
        styles: Object.fromEntries(
          PROPS.map((p) => [p, cs.getPropertyValue(p)]),
        ),
      };
    }
    for (const img of [...document.images].slice(0, 50))
      out.images.push({
        alt: img.alt,
        currentSrc: img.currentSrc,
        natural: [img.naturalWidth, img.naturalHeight],
      });
    return out;
  }, selectors);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cases = loadMatrix(args.matrix);
  const steps = args.interactions ? loadInteractions(args.interactions) : [];
  const accepted = args.accepted ? loadAccepted(args.accepted) : [];
  const { chromium } = await loadPlaywright();
  const sharp = await loadSharp();
  const browser = await chromium.launch();
  let allOk = true;
  try {
    for (const route of args.route) {
      const dir = join(args.out, reportDirName(route));
      mkdirSync(dir, { recursive: true });
      const reportCases = [];
      for (const c of cases) {
        const label = `${c.width}x${c.height}`;
        const allowed = acceptedFor(accepted, route, c);
        const masks = [...new Set([...args.mask, ...allowed.masks])];
        const side = async (name, origin) => {
          const { context, page } = await openPage(
            browser,
            routeUrl(origin, route),
            c,
          );
          try {
            const file = join(dir, `${name}-${label}.png`);
            const png = await page.screenshot({
              path: file,
              fullPage: true,
              animations: "disabled",
              mask: masks.map((s) => page.locator(s)),
              maskColor: "#ff00ff",
            });
            const nodes = await page.evaluate(collectNodes);
            const facts = await evidence(page, args.evidence);
            const interactions = [];
            for (const [i, step] of steps.entries())
              if (appliesTo(step, route, c)) {
                try {
                  interactions.push(
                    await runInteraction(page, step, i, { label }),
                  );
                } catch (error) {
                  interactions.push({
                    name: step.name,
                    action: step.action,
                    ok: false,
                    failures: [error.message.split("\n")[0]],
                  });
                }
              }
            return { file, png, nodes, facts, interactions };
          } finally {
            await context.close();
          }
        };
        const prod = await side("prod", args.prod);
        const target = await side("target", args.target);
        const [a, b] = await Promise.all(
          [prod.png, target.png].map((png) =>
            sharp(png)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true }),
          ),
        );
        const problems = [];
        if (a.info.height !== b.info.height)
          problems.push(
            `page height differs: production ${a.info.height}px, target ${b.info.height}px`,
          );
        const height = Math.min(a.info.height, b.info.height);
        const width = Math.min(a.info.width, b.info.width);
        const crop = async (img) =>
          img.info.width === width && img.info.height === height
            ? img.data
            : sharp(img.data, { raw: img.info })
                .extract({ left: 0, top: 0, width, height })
                .raw()
                .toBuffer();
        const pixels = pixelDiff(await crop(a), await crop(b), width, height, {
          tolerance: args.tolerance,
        });
        const interactions = target.interactions.map((t, i) => {
          const p = prod.interactions[i];
          const failures = [...t.failures];
          if (p?.after && t.after)
            for (const key of ["ariaExpanded", "visible", "focused"])
              if (p.after[key] !== t.after[key])
                failures.push(
                  `${key}: production ${p.after[key]}, target ${t.after[key]}`,
                );
          return {
            name: t.name,
            ok: failures.length === 0,
            failures,
            prod: p,
            target: t,
          };
        });
        reportCases.push({
          width: c.width,
          height: c.height,
          context: contextOptions(c),
          accepted: allowed,
          pixels,
          problems,
          geometry: diffGeometry(prod.nodes, target.nodes),
          interactions,
          evidence: { prod: prod.facts, target: target.facts },
          screenshots: { prod: prod.file, target: target.file },
        });
      }
      const report = buildReport({
        route,
        prod: args.prod,
        target: args.target,
        tolerance: args.tolerance,
        maxRatio: args.maxRatio,
        cases: reportCases,
      });
      writeFileSync(
        join(dir, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(
        `${report.ok ? "ok  " : "FAIL"}  ${route}  (${join(dir, "report.json")})`,
      );
      for (const f of report.failures) console.log(`        ${f}`);
      allOk &&= report.ok;
    }
  } finally {
    await browser.close();
  }
  if (!allOk) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(`compare-route: ${error.message}`);
  }
}
