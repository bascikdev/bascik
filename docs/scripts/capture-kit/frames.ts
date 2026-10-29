/**
 * Frames and animated WebP output shared by the docs capture scripts.
 *
 * Capture scripts do not record live video. They step through a scene, take a picture after each step, and
 * say how long that picture stays on screen. Timing is therefore exact and does not depend on how fast the
 * machine renders.
 */
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export interface Frame {
  png: Buffer;
  /** How long the frame stays on screen, in milliseconds. */
  hold: number;
}

export type Clip = { x: number; y: number; width: number; height: number };

/** How long the first frame stays up before anything moves, and how long the last one stays before the loop. */
export const INTRO_HOLD = 1200;
export const OUTRO_HOLD = 4000;

/** Adds a frame, merging it into the previous one when the picture did not change. */
export function pushFrame(frames: Frame[], png: Buffer, hold: number): void {
  const previous = frames.at(-1);
  if (previous?.png.equals(png)) previous.hold += hold;
  else frames.push({ png, hold });
}

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

/**
 * The reduced-motion still for one frame, as WebP: lossless or lossy at quality 80, whichever is smaller. Flat UI
 * often compresses better without loss (the lint still was 90 KB lossy, twice its whole lossless animation),
 * while busy pictures compress better with it.
 */
export async function encodeStill(png: Buffer): Promise<Buffer> {
  const [lossless, lossy] = await Promise.all([
    sharp(png).webp({ lossless: true, effort: 6 }).toBuffer(),
    sharp(png).webp({ quality: 80, effort: 6 }).toBuffer(),
  ]);
  return lossless.length <= lossy.length ? lossless : lossy;
}

/**
 * Writes `<name>@2x.webp` into `outDir`: a still image for one frame, or a lossless animated WebP plus a
 * `<name>-still@2x.webp` copy of the last frame for several (see `encodeStill`). The docs serve the still copy
 * to visitors who prefer reduced motion.
 *
 * Lossless because lossy animations only re-encode the changed rectangle, so each frame leaves a faint ghost of
 * the one before it. Flat UI compresses well without loss anyway.
 */
export async function writeScene(
  outDir: string,
  name: string,
  frames: Frame[],
): Promise<void> {
  if (frames.length === 0) throw new Error(`Scene ${name} captured no frames`);
  await mkdir(outDir, { recursive: true });
  const animatedFile = join(outDir, `${name}@2x.webp`);
  const stillFile = join(outDir, `${name}-still@2x.webp`);
  const lossy = { quality: 80, effort: 6 };
  if (frames.length === 1) {
    await sharp(frames[0].png).webp(lossy).toFile(animatedFile);
    // A scene that stopped moving must not leave a stale reduced-motion copy behind.
    await rm(stillFile, { force: true });
    console.log(`captured ${name}`);
    return;
  }
  const { width = 0, height = 0 } = await sharp(frames[0].png).metadata();
  const raw = await Promise.all(
    frames.map(({ png }) => sharp(png).ensureAlpha().raw().toBuffer()),
  );
  await sharp(Buffer.concat(raw), {
    raw: {
      width,
      height: height * frames.length,
      channels: 4,
      pageHeight: height,
    },
  })
    .webp({
      lossless: true,
      effort: 6,
      loop: 0,
      delay: frames.map((frame) => frame.hold),
    })
    .toFile(animatedFile);
  await writeFile(stillFile, await encodeStill(frames[frames.length - 1].png));
  const seconds = (
    frames.reduce((total, frame) => total + frame.hold, 0) / 1000
  ).toFixed(1);
  const kilobytes = Math.round((await stat(animatedFile)).size / 1024);
  console.log(
    `captured ${name} (${frames.length} frames, ${seconds}s loop, ${kilobytes} KB)`,
  );
}
