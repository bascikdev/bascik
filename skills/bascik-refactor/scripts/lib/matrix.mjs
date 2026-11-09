// The breakpoint matrix: find the widths where a legacy site's layout switches, and expand them into the viewport
// cases every route is compared at. Dependency-free; Node.js 24.21+.
//
// The rule: for every width threshold B, test B - 1, B and B + 1 CSS pixels, plus one width inside every interval
// and the narrowest and widest supported widths. Width and height are a pair.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PX_PER_EM = 16;

const toPx = (value, unit) =>
  Math.floor(Number(value) * (unit === "px" ? 1 : PX_PER_EM));

/** Width thresholds in a media query prelude or a matchMedia string: min-width, max-width and range syntax. */
function mediaWidths(text) {
  const found = [];
  for (const m of text.matchAll(
    /\b(?:min|max)-width\s*:\s*([\d.]+)(px|em|rem)\b/g,
  ))
    found.push(toPx(m[1], m[2]));
  for (const m of text.matchAll(/\bwidth\s*[<>]=?\s*([\d.]+)(px|em|rem)\b/g))
    found.push(toPx(m[1], m[2]));
  for (const m of text.matchAll(/([\d.]+)(px|em|rem)\s*[<>]=?\s*width\b/g))
    found.push(toPx(m[1], m[2]));
  return found;
}

/**
 * Width thresholds in CSS, Sass, Less or script text:
 * - `@media` preludes, and any quoted string holding a media query: `matchMedia("(min-width: ...)")`, image
 *   `sizes="(max-width: 600px) 100vw"`, `useMediaQuery({ query: "..." })`, CSS-in-JS template literals;
 * - react-responsive object queries and props: `useMediaQuery({ maxWidth: 767 })`, `<MediaQuery minWidth={1024}>`;
 * - Sass and Less variables named like a breakpoint ($bp-md, $screen-lg, @screen-md, $breakpoint-tablet, $mq-wide);
 * - theme tokens and constants named like one (screenMD: 768, screenLGMin: 992, tabletBreakpoint = 840);
 * - `innerWidth` comparisons.
 * Declarations such as `width: 1100px` or `min-width: 120px` inside a rule are not breakpoints and are ignored.
 * A component library's own grid breakpoints live in its package, not in your source: pass production's compiled
 * stylesheets too, or add the library's documented breakpoints by hand.
 * Returns sorted unique CSS pixel values; fractional values (1439.98px) are floored.
 */
export function discoverThresholds(text) {
  const found = [];
  for (const m of text.matchAll(/@media\b([^{;]*)[{;]/g))
    found.push(...mediaWidths(m[1]));
  for (const m of text.matchAll(/(["'`])((?:(?!\1)[^\n])*?)\1/g))
    if (
      /\(\s*(?:(?:min|max)-width\s*:|width\s*[<>]|[\d.]+(?:px|em|rem)\s*[<>])/.test(
        m[2],
      )
    )
      found.push(...mediaWidths(m[2]));
  for (const m of text.matchAll(
    /(?:useMediaQuery\(\s*\{([^}]*)\}|<MediaQuery\b([^>]*)>)/g,
  ))
    for (const n of (m[1] ?? m[2]).matchAll(
      /\b(?:min|max)(?:Device)?Width\s*[:=]\s*\{?\s*([\d.]+)/g,
    ))
      found.push(Math.floor(Number(n[1])));
  for (const m of text.matchAll(
    /[$@][\w-]*(?:bp|breakpoint|screen|mq|media)[\w-]*\s*:\s*([\d.]+)(px|em|rem)\b/gi,
  ))
    found.push(toPx(m[1], m[2]));
  for (const m of text.matchAll(
    /\b(?:screen(?:XS|SM|MD|LG|XL|XXL|XXXL)(?:Min|Max)?|[A-Za-z_$][\w$]*Breakpoint|breakpoint[A-Z][\w$]*)\s*[:=]\s*([\d.]+)(?:px)?\b/g,
  ))
    found.push(Math.floor(Number(m[1])));
  for (const m of text.matchAll(
    /\binnerWidth\s*(?:[<>]=?|===?|!==?)\s*([\d.]+)/g,
  ))
    found.push(Math.floor(Number(m[1])));
  for (const m of text.matchAll(
    /([\d.]+)\s*(?:[<>]=?|===?|!==?)\s*(?:window\.)?innerWidth\b/g,
  ))
    found.push(Math.floor(Number(m[1])));
  return [...new Set(found.filter((n) => Number.isFinite(n) && n > 0))].sort(
    (a, b) => a - b,
  );
}

/** A height for a width when the matrix does not name one: a phone, a portrait tablet, or a laptop. */
export function defaultHeight(width) {
  if (width < 768) return 812;
  if (width < 1024) return 1024;
  return 900;
}

function bound(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(
      `${name} must be a positive number of CSS pixels (got ${value})`,
    );
  return value;
}

/**
 * Expands thresholds into matrix cases: B - 1, B, B + 1 for each threshold inside [min, max], the midpoint of every
 * interval between them, and min and max themselves. Sorted by width, deduped. Each case gets `height` (fixed),
 * `heightFor(width)`, or defaultHeight(width).
 */
export function expandMatrix(thresholds, { min, max, height, heightFor } = {}) {
  bound("min", min);
  bound("max", max);
  if (min > max) throw new Error(`min (${min}) is greater than max (${max})`);
  const inside = [...new Set(thresholds.map(Math.floor))]
    .filter((t) => t >= min && t <= max)
    .sort((a, b) => a - b);
  const widths = new Set([min, max]);
  for (const t of inside)
    for (const w of [t - 1, t, t + 1]) if (w >= min && w <= max) widths.add(w);
  const points = [...new Set([min, ...inside, max])].sort((a, b) => a - b);
  for (let i = 1; i < points.length; i++)
    widths.add(Math.floor((points[i - 1] + points[i]) / 2));
  const pick =
    heightFor ??
    (height !== undefined ? () => bound("height", height) : defaultHeight);
  return [...widths]
    .sort((a, b) => a - b)
    .map((width) => ({ width, height: pick(width) }));
}

/**
 * Reads a breakpoints.json matrix: `{ "cases": [{ "width": 375, "height": 812 }, ...] }` or a bare array of cases.
 * Errors name the file and the case index.
 */
export function loadMatrix(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: cannot read the matrix (${error.message})`);
  }
  const cases = Array.isArray(data) ? data : data?.cases;
  if (!Array.isArray(cases) || cases.length === 0)
    throw new Error(
      `${file}: the matrix has no cases; expected { "cases": [{ "width": 375, "height": 812 }] }`,
    );
  cases.forEach((c, i) => {
    for (const key of ["width", "height"]) {
      const v = c?.[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
        throw new Error(
          `${file}: cases[${i}].${key} must be a positive number (got ${JSON.stringify(v)})`,
        );
    }
  });
  return cases;
}

/**
 * The id of a matrix case for --cases and the reports: "360x812", with a suffix for each variant the case sets:
 * "1408x900-dark" (colorScheme), "-motion" (reducedMotion other than reduce), "-mobile" (isMobile), "-touch" (hasTouch).
 */
export function caseId(c) {
  const parts = [`${c.width}x${c.height}`];
  if (c.colorScheme && c.colorScheme !== "light") parts.push(c.colorScheme);
  if (c.reducedMotion && c.reducedMotion !== "reduce") parts.push("motion");
  if (c.isMobile) parts.push("mobile");
  if (c.hasTouch) parts.push("touch");
  return parts.join("-");
}

/**
 * The cases --cases names, in matrix order: each value is a case id (caseId) or a bare width, which selects every case
 * of that width; values may be comma separated. No values selects every case. A value that matches no case is an
 * error listing the valid ids, so a typo never runs an empty or wrong subset.
 */
export function selectCases(cases, values) {
  const list = values ?? [];
  if (!list.length) return cases;
  const ids = list.flatMap((v) =>
    String(v)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!ids.length)
    throw new Error(
      `--cases needs case ids or widths, such as 360x812 or 360; this matrix has ${cases.map(caseId).join(", ")}`,
    );
  const picked = new Set();
  for (const id of ids) {
    const hits = cases.filter((c) =>
      /^\d+$/.test(id) ? c.width === Number(id) : caseId(c) === id,
    );
    if (!hits.length)
      throw new Error(
        `--cases ${id}: no such case in the matrix; use a case id or a width from ${cases.map(caseId).join(", ")}`,
      );
    for (const c of hits) picked.add(c);
  }
  return cases.filter((c) => picked.has(c));
}

/**
 * What a run checked, for report.json: the matrix file and its sha256, the ids of the cases run and the total and, when
 * `allChecks` is given (run-checks.mjs), the checks that ran, the checks left out (`skipped`) and the checks `waived`
 * ({ check: reason }: testid-carryover with --no-legacy-repo). A run is partial (an iteration result, never the gate)
 * when it ran a subset of the cases (--cases), a matrix file other than `defaultMatrix`
 * (docs/migration/breakpoints.json), or left out a check that is not waived (--only, --skip).
 */
export function gateRecord({
  file,
  cases,
  selected,
  defaultMatrix,
  checks,
  allChecks,
  waived = {},
}) {
  const record = {
    matrix: file,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    cases: selected.map(caseId),
    total: cases.length,
  };
  let skipped = [];
  if (allChecks) {
    skipped = allChecks.filter((c) => !checks.includes(c) && !(c in waived));
    record.checks = [...checks];
    record.skipped = skipped;
    if (Object.keys(waived).length) record.waived = { ...waived };
  }
  record.partial =
    selected.length !== cases.length ||
    resolve(file) !== resolve(defaultMatrix) ||
    skipped.length > 0;
  return record;
}

/** The terminal line for a partial run, or null for a full run of the default matrix with every check. */
export function gateLine(gate) {
  if (!gate?.partial) return null;
  const n = gate.cases.length;
  const skipped = gate.skipped ?? [];
  // Every case and every check ran, so the matrix file itself is not the default one.
  const other =
    n === gate.total && !skipped.length ? ` from ${gate.matrix}` : "";
  const ran = gate.checks?.length ?? 0;
  const checks = skipped.length
    ? `; ${ran} of ${ran + skipped.length} checks, without ${skipped.join(", ")}`
    : "";
  return `PARTIAL (${n} of ${gate.total} cases${other}${checks}): iteration result, not a gate`;
}
