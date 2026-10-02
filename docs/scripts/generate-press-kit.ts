#!/usr/bin/env node
/**
 * generate-press-kit.ts
 *
 * Builds the Bascik brand kit from the two authored logo SVGs and writes it to
 * <out>/assets/press/ (default docs/dist/assets/press/). It lives under assets/ so
 * it never collides with the /press page route:
 *
 *   logo/svg/*.svg      static vector logos (mark + wordmark; color, black, white)
 *   logo/png/*.png      transparent full-color PNG exports at fixed sizes
 *   avatar/*.png        square profile images
 *   social/*.png        link preview and banner images
 *   README.txt          short usage summary
 *   bascik-press-kit.zip  all of the above inside a bascik-press-kit/ folder
 *
 * Inputs are src/pages/assets/bascik-logo.svg (wordmark) and
 * src/pages/assets/favicon.svg (mark). Nothing is written outside the output
 * directory. The zip is byte-for-byte reproducible: entries are sorted and use a
 * fixed timestamp.
 *
 * Run via pipeline.exec in bascik.config.ts (dev and build), or directly:
 *   node scripts/generate-press-kit.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const KIT_ROOT = 'bascik-press-kit';
export const ZIP_NAME = 'bascik-press-kit.zip';
/** Role alias that forwards to the maintainer. Never publish a personal address. */
export const PRESS_EMAIL = 'press@bascik.dev';

export const COLORS = {
  lime: '#d3ff8d',
  ink: '#0e0f10',
  charcoal: '#18191b',
  paper: '#f2f3f0',
} as const;

export type Tone = 'color' | 'black' | 'white';
export type Background = 'dark' | 'dark-glow' | 'light';

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

export interface KitFile {
  /** Path relative to the kit root, using forward slashes. */
  path: string;
  data: Buffer;
}

export interface CanvasSpec {
  file: string;
  width: number;
  height: number;
  background: Background;
  tone: Tone;
  logo: 'mark' | 'wordmark';
  /** Rendered width of the logo inside the canvas, in canvas pixels. */
  logoWidth: number;
}

export const WORDMARK_PNG_WIDTHS = [600, 1200, 2400] as const;
export const MARK_PNG_SIZES = [256, 512, 1024] as const;

/** The mark source has a 2 unit margin inside its 32 unit square; the kit crops to the artwork. */
const MARK_CROP: Box = { x: 2, y: 2, width: 28, height: 28 };

export const CANVASES: CanvasSpec[] = [
  { file: 'avatar/bascik-avatar-dark-1024.png', width: 1024, height: 1024, background: 'dark', tone: 'color', logo: 'mark', logoWidth: 594 },
  { file: 'avatar/bascik-avatar-light-1024.png', width: 1024, height: 1024, background: 'light', tone: 'black', logo: 'mark', logoWidth: 594 },
  { file: 'social/bascik-social-1200x630.png', width: 1200, height: 630, background: 'dark-glow', tone: 'color', logo: 'wordmark', logoWidth: 640 },
  { file: 'social/bascik-github-social-1280x640.png', width: 1280, height: 640, background: 'dark-glow', tone: 'color', logo: 'wordmark', logoWidth: 680 },
  { file: 'social/bascik-banner-1500x500.png', width: 1500, height: 500, background: 'dark-glow', tone: 'color', logo: 'wordmark', logoWidth: 640 },
  { file: 'social/bascik-banner-1584x396.png', width: 1584, height: 396, background: 'dark-glow', tone: 'color', logo: 'wordmark', logoWidth: 560 },
];

function round(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Extracts the tile polygon and ink elements from a logo SVG. The sources must
 * follow the brand contract: one lime polygon, and every other shape filled with
 * the ink color. Anything else fails loudly instead of producing a wrong kit.
 */
export function parseLogo(source: string, crop?: Box): LogoArtwork {
  const svg = /<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/.exec(source);
  if (!svg) throw new Error('press-kit: logo source has no <svg viewBox>');
  const [x, y, width, height] = svg[1].trim().split(/[\s,]+/).map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) {
    throw new Error(`press-kit: unreadable viewBox "${svg[1]}"`);
  }

  const inner = svg[2]
    .replace(/<!--[\s\S]*?-->/g, () => '')
    .replace(/<animate\b[\s\S]*?\/>/g, () => '');
  const polygon = /<polygon\b[^>]*\bpoints="([^"]+)"[^>]*\/?>/.exec(inner);
  if (!polygon) throw new Error('press-kit: logo source has no <polygon> tile');
  if (!polygon[0].includes(COLORS.lime)) {
    throw new Error(`press-kit: logo tile is not filled with ${COLORS.lime}`);
  }

  const ink = inner
    .replace(polygon[0], () => '')
    .trim()
    .replace(/<rect\b([^>]*[^/])>\s*<\/rect>/g, (_match, attrs: string) => `<rect${attrs} />`)
    .replace(/>\s+</g, () => '>\n  <');
  if (!ink.includes(`fill="${COLORS.ink}"`)) {
    throw new Error(`press-kit: logo ink is not filled with ${COLORS.ink}`);
  }

  return { viewBox: crop ?? { x, y, width, height }, points: polygon[1], ink };
}

/** Shapes for one logo tone, ready to place inside any SVG that uses the logo's own coordinates. */
function logoBody(art: LogoArtwork, tone: Tone): string {
  if (tone === 'color') {
    return `<polygon points="${art.points}" fill="${COLORS.lime}" />\n  ${art.ink}`;
  }
  // Single-color versions: a solid tile with the cursor and letters knocked out, so the page behind shows through.
  const { x, y, width, height } = art.viewBox;
  const fill = tone === 'black' ? COLORS.ink : '#ffffff';
  const knockout = art.ink.replaceAll(`fill="${COLORS.ink}"`, 'fill="#000000"');
  return [
    '<defs>',
    `    <mask id="bascik-knockout" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}">`,
    `      <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff" />`,
    `      ${knockout}`,
    '    </mask>',
    '  </defs>',
    `  <polygon points="${art.points}" fill="${fill}" mask="url(#bascik-knockout)" />`,
  ].join('\n  ');
}

/** A standalone, static (non-animated) logo SVG. */
export function renderLogoSvg(
  art: LogoArtwork,
  tone: Tone,
  { title, width, height }: { title: string; width: number; height: number },
): string {
  const { x, y, width: vw, height: vh } = art.viewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${vw} ${vh}" width="${width}" height="${height}" role="img">
  <title>${title}</title>
  ${logoBody(art, tone)}
</svg>
`;
}

/** A fixed-size canvas with the logo centered on a brand background. */
export function renderCanvasSvg(
  art: LogoArtwork,
  tone: Tone,
  { width, height, background, logoWidth }: { width: number; height: number; background: Background; logoWidth: number },
): string {
  const scale = logoWidth / art.viewBox.width;
  const logoHeight = art.viewBox.height * scale;
  const tx = round((width - logoWidth) / 2 - art.viewBox.x * scale);
  const ty = round((height - logoHeight) / 2 - art.viewBox.y * scale);

  let defs = '';
  let backdrop: string;
  if (background === 'light') {
    backdrop = `<rect width="${width}" height="${height}" fill="${COLORS.paper}" />`;
  } else if (background === 'dark') {
    backdrop = `<rect width="${width}" height="${height}" fill="${COLORS.charcoal}" />`;
  } else {
    defs = `<defs>
    <linearGradient id="bascik-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${COLORS.charcoal}" />
      <stop offset="100%" stop-color="#121314" />
    </linearGradient>
    <radialGradient id="bascik-glow" cx="50%" cy="0%" r="80%">
      <stop offset="0%" stop-color="${COLORS.lime}" stop-opacity="0.14" />
      <stop offset="100%" stop-color="${COLORS.lime}" stop-opacity="0" />
    </radialGradient>
  </defs>
  `;
    backdrop = `<rect width="${width}" height="${height}" fill="url(#bascik-bg)" />
  <rect width="${width}" height="${height}" fill="url(#bascik-glow)" />`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  ${defs}${backdrop}
  <g transform="translate(${tx} ${ty}) scale(${round(scale)})">
  ${logoBody(art, tone)}
  </g>
</svg>
`;
}

/** Rasterizes an SVG at an exact pixel width. Logo artwork is outlined paths, so no fonts are needed. */
export function renderPng(svg: string, width: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

export function readmeText(): string {
  return `Bascik brand kit
================

Official logos, colors, and usage guidelines for Bascik.
Full guidelines: https://bascik.dev/press

Folders
  logo/svg   Master vector artwork. Use these whenever the destination supports SVG.
  logo/png   Full-color PNG exports with transparent backgrounds.
  avatar     Square profile images, 1024 x 1024.
  social     Link preview images and profile banners.

Colors
  Lime       ${COLORS.lime}   logo tile and accents
  Ink        ${COLORS.ink}   logo cursor and letters
  Charcoal   ${COLORS.charcoal}   dark backgrounds
  Paper      ${COLORS.paper}   light backgrounds

Quick rules
  - Use the full-color logo on dark or mid-tone backgrounds.
    Use the black logo on white or very light backgrounds.
  - Keep clear space of at least one quarter of the logo height on every side.
  - Display the logo at least 24 px tall on screen or 1/8 inch (3 mm) tall in print.
  - Do not recolor, stretch, rotate, add effects to, crop, or retype the logo.
  - Do not use the logo as your own app, website, or company icon, or inside your own logo.
  - Do not use the logo in a way that suggests Bascik endorses your product.
  - Do not sell products featuring the logo without permission.
  - Write the name as "Bascik" in running text.

Tagline:  HTML components. Zero runtime.
Website:  https://bascik.dev
Source:   https://github.com/bascikdev/bascik
Press:    ${PRESS_EMAIL}
`;
}

/** Builds every kit file (except the zip) from the two logo SVG sources. */
export function buildKitFiles(markSource: string, wordmarkSource: string): KitFile[] {
  const mark = parseLogo(markSource, MARK_CROP);
  const wordmark = parseLogo(wordmarkSource);
  const files: KitFile[] = [];
  const add = (path: string, data: Buffer | string) => {
    files.push({ path, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data });
  };

  add('README.txt', readmeText());

  const tones: Array<[Tone, string, string]> = [
    ['color', '', ''],
    ['black', '-black', ' (black)'],
    ['white', '-white', ' (white)'],
  ];
  for (const [tone, suffix, titleSuffix] of tones) {
    add(`logo/svg/bascik-wordmark${suffix}.svg`, renderLogoSvg(wordmark, tone, { title: `Bascik${titleSuffix}`, width: 1140, height: 280 }));
    add(`logo/svg/bascik-mark${suffix}.svg`, renderLogoSvg(mark, tone, { title: `Bascik mark${titleSuffix}`, width: 512, height: 512 }));
  }

  const wordmarkColor = renderLogoSvg(wordmark, 'color', { title: 'Bascik', width: 1140, height: 280 });
  const markColor = renderLogoSvg(mark, 'color', { title: 'Bascik mark', width: 512, height: 512 });
  for (const width of WORDMARK_PNG_WIDTHS) add(`logo/png/bascik-wordmark-${width}.png`, renderPng(wordmarkColor, width));
  for (const size of MARK_PNG_SIZES) add(`logo/png/bascik-mark-${size}.png`, renderPng(markColor, size));

  for (const spec of CANVASES) {
    const art = spec.logo === 'mark' ? mark : wordmark;
    const svg = renderCanvasSvg(art, spec.tone, spec);
    add(spec.file, renderPng(svg, spec.width));
  }

  return files;
}

// ZIP ----------------------------------------------------------------------

/** 1980-01-01 00:00:00, the earliest representable DOS timestamp. Keeps archives reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Minimal ZIP writer: deflate (or store when that is smaller), UTF-8 names, fixed timestamps. */
export function createZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const deflate = deflated.length < data.length;
    const body = deflate ? deflated : data;
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // general purpose flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    parts.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk number, and internal attributes stay zero
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: regular file, rw-r--r--
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, centralBytes, end]);
}

/** Zips kit files under the kit root folder, in a stable order. */
export function zipKit(files: KitFile[]): Buffer {
  const entries = files
    .map((file) => ({ name: `${KIT_ROOT}/${file.path}`, data: file.data }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createZip(entries);
}

// Entry point ---------------------------------------------------------------

export function defaultPressDir(): string {
  return join(process.env.BASCIK_OUT_DIR ?? join(docsDir, 'dist'), 'assets', 'press');
}

/**
 * Generates the kit into `outDir` and returns the written paths relative to it
 * (kit files plus the zip).
 */
export async function generatePressKit(outDir: string = defaultPressDir()): Promise<string[]> {
  const assets = join(docsDir, 'src', 'pages', 'assets');
  const [markSource, wordmarkSource] = await Promise.all([
    readFile(join(assets, 'favicon.svg'), 'utf8'),
    readFile(join(assets, 'bascik-logo.svg'), 'utf8'),
  ]);

  const files = buildKitFiles(markSource, wordmarkSource);
  files.push({ path: ZIP_NAME, data: zipKit(files) });

  await Promise.all(
    files.map(async ({ path, data }) => {
      const target = join(outDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }),
  );
  return files.map((file) => file.path).sort();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await generatePressKit();
}
