/**
 * Frame composition: browser window chrome and side-by-side layouts, so one animation can show an editor and
 * the page it changes at the same time.
 */
import sharp from 'sharp';

const SCALE = 2;
const BAR = 36;
const BACKGROUND = { r: 22, g: 24, b: 26, alpha: 1 };

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Wraps a page screenshot in a browser window: a title bar with the three window dots and an address pill.
 * `png` is a screenshot at 2x pixel density.
 */
export async function browserWindow(png: Buffer, url: string): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const width = meta.width!;
  const height = meta.height! + BAR * SCALE;
  const barHeight = BAR * SCALE;
  const pillX = 86 * SCALE;
  const pillHeight = 22 * SCALE;
  const pillY = (barHeight - pillHeight) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${barHeight}">
    <rect width="${width}" height="${barHeight}" fill="#1e2022"/>
    <rect y="${barHeight - 2}" width="${width}" height="2" fill="#2e3032"/>
    <circle cx="${18 * SCALE}" cy="${barHeight / 2}" r="${5 * SCALE}" fill="#ff5f56"/>
    <circle cx="${36 * SCALE}" cy="${barHeight / 2}" r="${5 * SCALE}" fill="#ffbd2e"/>
    <circle cx="${54 * SCALE}" cy="${barHeight / 2}" r="${5 * SCALE}" fill="#27c93f"/>
    <rect x="${pillX}" y="${pillY}" width="${width - pillX - 18 * SCALE}" height="${pillHeight}" rx="${pillHeight / 2}" fill="#16181a"/>
    <text x="${pillX + 14 * SCALE}" y="${barHeight / 2 + 4.5 * SCALE}" font-family="Helvetica, Arial, sans-serif" font-size="${12.5 * SCALE}" fill="#9aa0a6">${escapeXml(url)}</text>
  </svg>`;
  return sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
    .composite([
      { input: Buffer.from(svg), left: 0, top: 0 },
      { input: png, left: 0, top: barHeight },
    ])
    .png()
    .toBuffer();
}

/** Rounds the corners of a 2x frame, leaving the corners transparent. */
export async function roundCorners(png: Buffer, radiusCssPx = 10): Promise<Buffer> {
  const { width, height } = await sharp(png).metadata();
  const radius = radiusCssPx * SCALE;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></svg>`,
  );
  return sharp(png).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/** Stacks two frames, top then bottom, with a gap between them. */
export async function stacked(top: Buffer, bottom: Buffer, gapCssPx = 12): Promise<Buffer> {
  const [a, b] = await Promise.all([sharp(top).metadata(), sharp(bottom).metadata()]);
  const gap = gapCssPx * SCALE;
  const width = Math.max(a.width!, b.width!);
  const height = a.height! + gap + b.height!;
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: top, left: 0, top: 0 },
      { input: bottom, left: 0, top: a.height! + gap },
    ])
    .png()
    .toBuffer();
}

/**
 * Places two frames next to each other, top aligned, with a gap between them. The shorter one is padded with
 * the window background.
 */
export async function sideBySide(left: Buffer, right: Buffer, gapCssPx = 12): Promise<Buffer> {
  const [a, b] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()]);
  const gap = gapCssPx * SCALE;
  const width = a.width! + gap + b.width!;
  const height = Math.max(a.height!, b.height!);
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: a.width! + gap, top: 0 },
    ])
    .png()
    .toBuffer();
}
