/**
 * press-logo.ts
 *
 * Reads the two authored logo SVGs (src/pages/assets/bascik-logo.svg for the wordmark and
 * src/pages/assets/favicon.svg for the mark) into plain artwork that the press kit generator
 * (scripts/generate-press-kit.ts) and the /press page's clear-space diagram both draw from, so the
 * page always shows the same shapes the kit ships.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const COLORS = {
  lime: "#d3ff8d",
  ink: "#0e0f10",
  charcoal: "#18191b",
  paper: "#f2f3f0",
} as const;

export type Tone = "color" | "black" | "white";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LogoArtwork {
  /** Final view box, after any crop. */
  viewBox: Box;
  /** Points of the lime tile polygon. */
  points: string;
  /** Ink elements (cursor and letters) with animation and comments removed. */
  ink: string;
}

/** The mark source has a 2 unit margin inside its 32 unit square; the kit crops to the artwork. */
export const MARK_CROP: Box = { x: 2, y: 2, width: 28, height: 28 };

/** The source file of each logo, in src/pages/assets. */
export const LOGO_SOURCES = {
  wordmark: "bascik-logo.svg",
  mark: "favicon.svg",
} as const;

export type LogoName = keyof typeof LOGO_SOURCES;

/** Clear space on every side of a logo, as a share of the logo's height (the full height of the lime tile). */
export const CLEAR_SPACE_RATIO = 0.25;

function round(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Extracts the tile polygon and ink elements from a logo SVG. The sources must
 * follow the brand contract: one lime polygon, and every other shape filled with
 * the ink color. Anything else fails loudly instead of producing a wrong kit.
 */
export function parseLogo(source: string, crop?: Box): LogoArtwork {
  const svg = /<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/.exec(
    source,
  );
  if (!svg) throw new Error("press-kit: logo source has no <svg viewBox>");
  const [x, y, width, height] = svg[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) {
    throw new Error(`press-kit: unreadable viewBox "${svg[1]}"`);
  }

  let inner = svg[2];
  let previous: string;
  do {
    previous = inner;
    inner = inner.replace(/<!--[\s\S]*?-->/g, "");
  } while (inner !== previous);
  inner = inner.replace(/<animate\b[\s\S]*?\/>/g, "");
  const polygon = /<polygon\b[^>]*\bpoints="([^"]+)"[^>]*\/?>/.exec(inner);
  if (!polygon) throw new Error("press-kit: logo source has no <polygon> tile");
  if (!polygon[0].includes(COLORS.lime)) {
    throw new Error(`press-kit: logo tile is not filled with ${COLORS.lime}`);
  }

  const ink = inner
    .replace(polygon[0], () => "")
    .trim()
    .replace(
      /<rect\b([^>]*[^/])>\s*<\/rect>/g,
      (_match, attrs: string) => `<rect${attrs} />`,
    )
    .replace(/>\s+</g, () => ">\n  <");
  if (!ink.includes(`fill="${COLORS.ink}"`)) {
    throw new Error(`press-kit: logo ink is not filled with ${COLORS.ink}`);
  }

  return { viewBox: crop ?? { x, y, width, height }, points: polygon[1], ink };
}

/** Shapes for one logo tone, ready to place inside any SVG that uses the logo's own coordinates. */
export function renderLogoBody(art: LogoArtwork, tone: Tone): string {
  if (tone === "color") {
    return `<polygon points="${art.points}" fill="${COLORS.lime}" />\n  ${art.ink}`;
  }
  // Single-color versions: a solid tile with the cursor and letters knocked out, so the page behind shows through.
  const { x, y, width, height } = art.viewBox;
  const fill = tone === "black" ? COLORS.ink : "#ffffff";
  const knockout = art.ink.replaceAll(`fill="${COLORS.ink}"`, 'fill="#000000"');
  return [
    "<defs>",
    `    <mask id="bascik-knockout" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}">`,
    `      <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff" />`,
    `      ${knockout}`,
    "    </mask>",
    "  </defs>",
    `  <polygon points="${art.points}" fill="${fill}" mask="url(#bascik-knockout)" />`,
  ].join("\n  ");
}

/** Reads one logo's source from `assetsDir` and returns its artwork, cropped as the kit crops it. */
export async function readLogo(
  logo: LogoName,
  assetsDir: string = join(process.cwd(), "src/pages/assets"),
): Promise<LogoArtwork> {
  if (!Object.hasOwn(LOGO_SOURCES, logo)) {
    throw new Error(
      `press-logo: unknown logo "${String(logo)}"; use "wordmark" or "mark"`,
    );
  }
  const source = await readFile(join(assetsDir, LOGO_SOURCES[logo]), "utf8");
  return parseLogo(source, logo === "mark" ? MARK_CROP : undefined);
}

/**
 * An inline SVG of the full-color logo with its clear space drawn around it: a faint zone and a dashed
 * boundary one quarter of the logo's height outside the artwork's edges, which are where the kit files
 * are cropped. Lines use currentColor, so the page sets their color for each theme. It has no ids, so
 * several can share a page.
 */
export async function clearSpaceSvg(
  logo: LogoName,
  assetsDir?: string,
): Promise<string> {
  const art = await readLogo(logo, assetsDir);
  const { x, y, width, height } = art.viewBox;
  const space = round(height * CLEAR_SPACE_RATIO);
  // A little room past the boundary, so its stroke is drawn whole.
  const bleed = round(space / 7);
  const zone = {
    x: round(x - space),
    y: round(y - space),
    width: round(width + 2 * space),
    height: round(height + 2 * space),
  };
  const name = logo === "mark" ? "Bascik mark" : "Bascik wordmark";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(zone.x - bleed)} ${round(zone.y - bleed)} ${round(zone.width + 2 * bleed)} ${round(zone.height + 2 * bleed)}" role="img">
  <title>${name} with its clear space: one quarter of the logo's height on every side</title>
  <rect x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.height}" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 4" vector-effect="non-scaling-stroke" />
  <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1" vector-effect="non-scaling-stroke" />
  ${renderLogoBody(art, "color")}
</svg>`;
}
