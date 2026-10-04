import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { imageSize } from 'image-size';
import { escapeHtml } from './format.ts';
import { relativeToContent } from './content-paths.ts';

// Responsive images without a native image library. The author resizes an image once and saves
// the copies beside it as `name-480w.png`, `name-960w.png`. Every copy is checked here (its real
// width must match its name and its shape must match the original), and the page gets a
// `srcset` that lists them with the original. Images with no copies get plain width and height.

export interface ImageInfo {
  /** Public path of the original, percent-encoded. */
  src: string;
  width: number;
  height: number;
  /** `srcset` value, present only when at least one `-<width>w` copy exists. */
  srcset?: string;
}

/** Layout width of the article column. Keep in step with `--measure` in src/css/global.css. */
export const DEFAULT_SIZES = '(min-width: 44rem) 41rem, calc(100vw - 2.5rem)';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/blog/my post/a b.png` becomes `/blog/my%20post/a%20b.png`. */
export const publicPath = (contentRelative: string): string =>
  '/' + contentRelative.split('/').map(encodeURIComponent).join('/');

function measure(path: string, relative: string): { width: number; height: number } {
  let size;
  try {
    size = imageSize(readFileSync(path));
  } catch (error) {
    throw new Error(`content/${relative}: cannot read the image size (${(error as Error).message})`);
  }
  if (!size.width || !size.height) throw new Error(`content/${relative}: cannot read the image size`);
  return { width: size.width, height: size.height };
}

/** Describe the image at `absolutePath` (inside `root`) and any `-<width>w` copies beside it. */
export function describeImage(absolutePath: string, root: string): ImageInfo {
  const relative = relativeToContent(absolutePath, root);
  const original = measure(absolutePath, relative);
  const extension = extname(absolutePath);
  const stem = basename(absolutePath, extension);
  const variantName = new RegExp(`^${escapeRegExp(stem)}-(\\d+)w${escapeRegExp(extension)}$`);

  const candidates: Array<{ width: number; path: string }> = [{ width: original.width, path: relative }];
  const directory = dirname(absolutePath);
  const prefix = dirname(relative);
  for (const name of readdirSync(directory).sort()) {
    const match = variantName.exec(name);
    if (!match) continue;
    const declared = Number(match[1]);
    const variantRelative = prefix === '.' ? name : `${prefix}/${name}`;
    const size = measure(join(directory, name), variantRelative);
    if (size.width !== declared) {
      throw new Error(`content/${variantRelative}: the name says ${declared}w but the image is ${size.width}px wide`);
    }
    const expectedHeight = (original.height * size.width) / original.width;
    if (Math.abs(size.height - expectedHeight) > Math.max(2, expectedHeight * 0.01)) {
      throw new Error(
        `content/${variantRelative}: ${size.width}x${size.height} does not have the same shape as ` +
        `${basename(absolutePath)} (${original.width}x${original.height}). Resize without cropping so srcset can swap them.`,
      );
    }
    if (size.width !== original.width) candidates.push({ width: size.width, path: variantRelative });
  }

  const info: ImageInfo = { src: publicPath(relative), ...original };
  if (candidates.length > 1) {
    info.srcset = candidates
      .sort((a, b) => a.width - b.width)
      .map((candidate) => `${publicPath(candidate.path)} ${candidate.width}w`)
      .join(', ');
  }
  return info;
}

export interface ImgOptions {
  /** Above the fold: load immediately and hint high priority. Default is lazy. */
  eager?: boolean;
  sizes?: string;
}

export function renderImg(info: ImageInfo, alt: string, options: ImgOptions = {}): string {
  const attributes = [
    `src="${escapeHtml(info.src)}"`,
    ...(info.srcset ? [`srcset="${escapeHtml(info.srcset)}"`, `sizes="${escapeHtml(options.sizes ?? DEFAULT_SIZES)}"`] : []),
    `alt="${escapeHtml(alt)}"`,
    `width="${info.width}"`,
    `height="${info.height}"`,
    ...(options.eager ? ['fetchpriority="high"'] : ['loading="lazy"', 'decoding="async"']),
  ];
  return `<img ${attributes.join(' ')}>`;
}
