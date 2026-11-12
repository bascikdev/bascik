/**
 * responsive-images.ts
 *
 * Writes the width variants of every still image the docs site shows, so `renderImage` (src/lib/md-renderer.ts)
 * can give each one a `srcset`: a phone or a 1x screen then downloads a file near the size it displays instead of
 * the full 2x original.
 *
 * Run from docs/ after adding or re-recording a still image, and commit what it writes:
 *
 *   node scripts/responsive-images.ts
 *
 * Photographs are encoded with `responsive-webp.mjs`, the script the bascik-images skill gives every Bascik
 * project, and every variant uses its names: `<name>-<width>.webp` beside `<name>.webp`. Screenshots are encoded
 * here, because they need a choice that script does not make: a screenshot is flat color and small text, which
 * lossless WebP often stores in fewer bytes than lossy, so each width is written both ways and the smaller kept.
 * A variant that is not clearly smaller than the file it stands in for is not written at all.
 *
 * What gets variants:
 * - the showcase screenshots and the hero's video thumbnails (photographs), from the committed file;
 * - the reduced-motion `-still` copy of every recording (screenshots), from the committed file.
 *
 * The committed file is always the widest: add a new image at the largest size it will be shown at on a dense
 * screen, and this script makes the narrower ones.
 *
 * What does not: the animated recordings. They are lossless, and a resized lossless animation is larger than
 * the original (lint 56 KB to 82 KB at half size), so each is served as its one file.
 *
 * src/lib/responsive-images.test.ts fails when a still image has no variants or a variant is not the width its
 * name says.
 */
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateResponsive } from "../../skills/bascik-images/scripts/responsive-webp.mjs";

const ASSETS = "src/pages/assets";
/** The folders whose images are versioned and cached for a year (md-renderer.ts, VERSIONED_IMAGE_FOLDERS). */
export const IMAGE_FOLDERS = ["demos", "vscode"] as const;

/** A variant's file name: `<name>-<width>.webp`. */
export const VARIANT = /-(\d+)\.webp$/;

/** Narrower than this share of the source, or a variant would be a near copy of the file itself. */
const WIDEST_SHARE = 0.85;

/**
 * Showcase cards are 302 to 528 pixels wide and the screenshots are photographs of whole pages, so they get a
 * fine-grained list at the default quality.
 */
const SHOWCASE = { widths: [320, 480, 640, 960], quality: 80 };
/**
 * A docs content image is 312 to 664 pixels wide (1084 for the widest recording on the home page). The stills are
 * screenshots with small text, so they get a higher quality and fewer steps.
 */
const STILL = { widths: [480, 800, 1200], quality: 85 };
/** A screenshot variant must be at most this share of the original's bytes to be worth a request choice. */
const SMALLER_SHARE = 0.85;
/** The hero's video thumbnails are at most 300 pixels wide; the committed file is 960, for a 3x phone. */
const VIDEO = { widths: [320, 480, 640], quality: 80 };

/** Whether a WebP file holds more than one frame. */
async function isAnimated(file: string): Promise<boolean> {
  return ((await sharp(file, { animated: true }).metadata()).pages ?? 1) > 1;
}

async function encode(
  src: string[],
  out: string,
  { widths, quality }: { widths: number[]; quality: number },
  manifestDir: string,
): Promise<number> {
  let written = 0;
  // One source at a time: each has its own width, and so its own list of narrower widths.
  for (const file of src) {
    const { width } = await sharp(file).metadata();
    const narrower = widths.filter((w) => w < (width ?? 0) * WIDEST_SHARE);
    if (narrower.length === 0) continue;
    const result = await generateResponsive({
      src: [file],
      out,
      widths: narrower,
      quality,
      // The renderer finds variants by name, so the manifest is not kept.
      manifest: join(manifestDir, `manifest-${written}.json`),
      sharp,
    });
    written += Object.values(result.images as Record<string, unknown[]>).reduce(
      (count, entries) => count + entries.length,
      0,
    );
  }
  return written;
}

/**
 * Screenshot variants: each width as lossless and as lossy WebP, the smaller one kept, and none kept that is not
 * clearly smaller than the original. A stale variant from an earlier run is removed.
 */
async function encodeScreenshots(src: string[]): Promise<number> {
  let written = 0;
  for (const file of src) {
    const { width } = await sharp(file).metadata();
    const originalBytes = statSync(file).size;
    for (const target of STILL.widths) {
      const out = file.replace(/\.webp$/, `-${target}.webp`);
      rmSync(out, { force: true });
      if (target >= (width ?? 0) * WIDEST_SHARE) continue;
      const resized = () => sharp(file).resize({ width: target });
      const [lossless, lossy] = await Promise.all([
        resized().webp({ lossless: true, effort: 6 }).toBuffer(),
        resized().webp({ quality: STILL.quality, effort: 6 }).toBuffer(),
      ]);
      const best = lossless.length <= lossy.length ? lossless : lossy;
      if (best.length > originalBytes * SMALLER_SHARE) continue;
      writeFileSync(out, best);
      written++;
    }
  }
  return written;
}

async function main(): Promise<void> {
  const manifestDir = mkdtempSync(join(tmpdir(), "bascik-responsive-"));
  try {
    let total = 0;
    for (const folder of IMAGE_FOLDERS) {
      const dir = join(ASSETS, folder);
      const names = readdirSync(dir).filter(
        (name) => name.endsWith(".webp") && !VARIANT.test(name),
      );
      const showcase: string[] = [];
      const videos: string[] = [];
      const stills: string[] = [];
      for (const name of names) {
        const file = join(dir, name);
        if (await isAnimated(file)) continue;
        if (name.startsWith("showcase-")) showcase.push(file);
        else if (name.startsWith("video-")) videos.push(file);
        else stills.push(file);
      }
      total += await encode(showcase, dir, SHOWCASE, manifestDir);
      total += await encode(videos, dir, VIDEO, manifestDir);
      total += await encodeScreenshots(stills);
    }
    console.log(`[responsive-images] wrote ${total} width variants`);
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) await main();
