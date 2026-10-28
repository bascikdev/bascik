// The breakpoint matrix: find the widths where a legacy site's layout switches, and expand them into the viewport
// cases every route is compared at. Dependency-free; Node.js 22.18+.
//
// The rule: for every width threshold B, test B - 1, B and B + 1 CSS pixels, plus one width inside every interval
// and the narrowest and widest supported widths. Width and height are a pair.
import { readFileSync } from "node:fs";

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
