/**
 * md-renderer.ts
 *
 * Renders a Markdown file to HTML for use inside a Bascik docs page.
 * Call this from a `data-bascik-build` script block in a page using a
 * standard ESM import:
 *
 *   <script data-bascik-build>
 *     import { renderMd } from '@/lib/md-renderer.ts';
 *     export default async () => await renderMd('./content/16-performance.md');
 *   </script>
 *
 * Transformations applied on top of standard marked output:
 *   - Fenced code blocks  →  <code-block data-bascik-prop-lang="..."> component, highlighted (highlight.ts)
 *   - Blockquotes         →  <div class="callout">
 *   - Blockquotes opening with **See it live** → <div class="callout callout-live">
 *     (a more prominent link box pointing at a running deployment)
 *
 * Because `data-bascik-build` output is processed before component resolution,
 * the emitted <code-block> tags are resolved normally by Bascik.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { marked } from "marked";
import { headingPlainText, slugFromHeadingHtml } from "./heading-slug.ts";
import { escapeCode, highlightCode, unescapeCode } from "./highlight.ts";

/** Pixel size of a PNG or WebP header, or null when the bytes are neither. */
function readImageHeader(
  header: Buffer,
): { width: number; height: number } | null {
  if (
    header.length >= 24 &&
    header.toString("latin1", 1, 4) === "PNG" &&
    header.toString("latin1", 12, 16) === "IHDR"
  ) {
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  }
  if (
    header.length >= 30 &&
    header.toString("latin1", 0, 4) === "RIFF" &&
    header.toString("latin1", 8, 12) === "WEBP"
  ) {
    const format = header.toString("latin1", 12, 16);
    if (format === "VP8 ") {
      return {
        width: header.readUInt16LE(26) & 0x3fff,
        height: header.readUInt16LE(28) & 0x3fff,
      };
    }
    if (format === "VP8L") {
      const bits = header.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (format === "VP8X") {
      return {
        width: header.readUIntLE(24, 3) + 1,
        height: header.readUIntLE(27, 3) + 1,
      };
    }
  }
  return null;
}

/**
 * Display size of a PNG or WebP in docs/src/pages, read from its header, or null when the file is
 * missing or is neither. Giving the browser both numbers reserves the space before the image loads,
 * so the page does not shift. A file name ending in `@2x` holds twice the pixels it displays, so its
 * size is halved: the image then renders at its intended size on high-density screens and is only
 * ever scaled down to fit the column.
 */
function imageSize(sitePath: string): { width: number; height: number } | null {
  if (!sitePath.startsWith("/") || sitePath.includes("..")) return null;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(process.cwd(), "src/pages", sitePath), "r");
    const header = Buffer.alloc(32);
    const bytesRead = readSync(descriptor, header, 0, 32, 0);
    const size = readImageHeader(header.subarray(0, bytesRead));
    if (!size) return null;
    const density = /@2x\.[a-z]+$/i.test(sitePath) ? 2 : 1;
    return {
      width: Math.round(size.width / density),
      height: Math.round(size.height / density),
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Site path of the still copy that goes with an animated image, or null when there is none. The copy sits
 * beside the animation with `-still` before the density suffix: `demo@2x.webp` pairs with `demo-still@2x.webp`.
 */
function stillCopyPath(sitePath: string): string | null {
  if (!sitePath.startsWith("/") || sitePath.includes("..")) return null;
  const still = sitePath.replace(/(@\dx)?(\.[a-z0-9]+)$/i, "-still$1$2");
  if (still === sitePath) return null;
  return existsSync(join(process.cwd(), "src/pages", still)) ? still : null;
}

/**
 * Site folder for the recordings made by scripts/capture-demos.ts. Their windows have rounded, transparent
 * corners. The square VS Code screenshots in /assets/vscode/ keep the default image border.
 */
const DEMO_FOLDERS = ["/assets/demos/"];

/**
 * Site folders whose images are served with a content-hash query string and cached for a year. These are the
 * large recordings and screenshots. Every reference to them goes through `renderImage`, so every URL carries
 * the hash. scripts/generate-pages-headers.ts reads this list to write the matching `immutable` rule, so a
 * folder is only ever cached forever when its URLs are versioned.
 */
export const VERSIONED_IMAGE_FOLDERS = [
  "/assets/demos/",
  "/assets/vscode/",
] as const;

const versionCache = new Map<string, { stamp: string; version: string }>();

/**
 * `?v=<content hash>` when the site path names an image in a versioned folder, otherwise an empty string
 * (including when the file is missing). The query string changes whenever the bytes change, so a far-future
 * cache can never serve a stale image, and the file keeps its name: nothing is renamed or rewritten after the
 * build. Hashes are cached per file and recomputed when its size or modified time changes.
 */
function versionQuery(sitePath: string): string {
  if (!sitePath.startsWith("/") || sitePath.includes("..")) return "";
  if (!VERSIONED_IMAGE_FOLDERS.some((folder) => sitePath.startsWith(folder)))
    return "";
  try {
    const file = join(process.cwd(), "src/pages", sitePath);
    const { mtimeMs, size } = statSync(file);
    const stamp = `${mtimeMs}:${size}`;
    const cached = versionCache.get(file);
    if (cached?.stamp === stamp) return `?v=${cached.version}`;
    const version = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex")
      .slice(0, 10);
    versionCache.set(file, { stamp, version });
    return `?v=${version}`;
  } catch {
    return "";
  }
}

/** A path segment decoded, or null when it holds a malformed escape such as `%E0`. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * An image reference split into the file it names and the URL to emit for it.
 *
 * Workers static assets answers a path that differs from its per-segment `encodeURIComponent` form with a 307 to
 * that form, so a raw `demo@2x.webp` costs every visitor an extra round trip. The URL is therefore emitted with
 * each segment encoded (`demo%402x.webp`), which Pages served too. A reference written already encoded is
 * decoded first, so it is never encoded twice (`%2540`). A segment with a malformed escape is kept as written.
 *
 * `file` is the decoded site path used to find the file in src/pages, or null when the reference is not a plain
 * site path: an absolute or protocol-relative URL, or one that carries its own query string or fragment, which
 * is kept as written and never versioned.
 */
function imageReference(src: string): { file: string | null; url: string } {
  if (!src.startsWith("/") || src.startsWith("//"))
    return { file: null, url: src };
  const suffixAt = src.search(/[?#]/);
  const path = suffixAt === -1 ? src : src.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : src.slice(suffixAt);
  const decoded: string[] = [];
  const encoded: string[] = [];
  for (const segment of path.split("/")) {
    const plain = decodeSegment(segment);
    decoded.push(plain ?? segment);
    encoded.push(plain === null ? segment : encodeURIComponent(plain));
  }
  const url = encoded.join("/") + suffix;
  return { file: suffix ? null : decoded.join("/"), url };
}

/**
 * The URL to emit for a site image, escaped for the double-quoted attribute it goes in: per-segment encoded, plus
 * its content hash in a versioned folder. Escaping matters only for a query string the author wrote, since an
 * encoded path holds no `&`, `"` or `<`.
 */
function imageUrl(src: string): string {
  const { file, url } = imageReference(src);
  return escapeAttribute(file === null ? url : url + versionQuery(file));
}

/** The entities marked writes into an attribute (its `escape` helper), mapped back to their characters. */
const MARKED_ATTRIBUTE_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * A `src` from marked's HTML read back to the path the author wrote. marked escapes it, so `a&b.webp` arrives as
 * `a&amp;b.webp` and `it's.webp` as `it&#39;s.webp`, whose `#` would otherwise start a fragment. One pass, so a
 * name that really contains `&amp;` (escaped by marked as `&amp;amp;`) comes back as `&amp;`, not `&`.
 */
const unescapeMarkedAttribute = (text: string) =>
  text.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => MARKED_ATTRIBUTE_ENTITIES[entity] ?? entity,
  );

/**
 * The HTML for one site image: lazy loading, the display size when the file is a PNG or WebP that ships with
 * the docs, and a `demo-shot` class for the recorded demos so their rounded window corners are not boxed in.
 *
 * `eager` is for the one image that is likely the Largest Contentful Paint element (see `_transformMd`).
 *
 * Do not add a 1x `srcset` for the demo recordings: resizing the lossless animations to 1x makes every one of
 * them larger (lint 47 KB to 69 KB, error-overlay 150 KB to 217 KB), whatever Lighthouse's image delivery
 * estimate says.
 *
 * An animated image with a `-still` copy is wrapped in <picture> so visitors who prefer reduced motion get the
 * still instead. The animation loops forever and cannot be paused, so it must not be their default.
 *
 * `rest` is whatever follows `src` in the original tag, such as ` alt="..."`.
 */
function renderImage(
  src: string,
  rest: string,
  narrow?: { src: string; maxWidth: number },
  eager = false,
): string {
  const file = imageReference(src).file;
  const size = file === null ? null : imageSize(file);
  const dimensions = size
    ? ` width="${size.width}" height="${size.height}"`
    : "";
  const demoClass = DEMO_FOLDERS.some((folder) => src.startsWith(folder))
    ? ' class="demo-shot"'
    : "";
  // The likely LCP image loads eagerly and decodes in step with paint. Lazy loading it would hold the request
  // until layout, after the HTML is parsed, which delays the Largest Contentful Paint on a laptop. It gets no
  // fetchpriority="high": on a phone the text or code block above it is the largest paint, and a high-priority
  // download of an animated recording competed with it (sitemap mobile LCP 1.5 s to 2.4 s in Lighthouse). The
  // browser raises the priority of an image in the viewport on its own.
  const loading = eager ? 'loading="eager"' : 'loading="lazy" decoding="async"';
  const image = `<img ${loading}${demoClass}${dimensions} src="${imageUrl(src)}"${rest}>`;
  const sources: string[] = [];
  // The narrow image has a different shape from the default one, so its sources say how big it is. Without
  // that, the browser would reserve the default image's shape and the page would jump when the real one loads.
  const narrowFile = narrow ? imageReference(narrow.src).file : null;
  const narrowSize = narrowFile === null ? null : imageSize(narrowFile);
  const narrowDimensions = narrowSize
    ? ` width="${narrowSize.width}" height="${narrowSize.height}"`
    : "";
  // Reduced motion wins over screen size, so these sources come first: the browser uses the first match.
  const still = file === null ? null : stillCopyPath(file);
  const narrowStill = narrowFile === null ? null : stillCopyPath(narrowFile);
  if (narrow && narrowStill) {
    sources.push(
      `<source media="(max-width: ${narrow.maxWidth}px) and (prefers-reduced-motion: reduce)" srcset="${imageUrl(narrowStill)}"${narrowDimensions}>`,
    );
  }
  if (still)
    sources.push(
      `<source media="(prefers-reduced-motion: reduce)" srcset="${imageUrl(still)}">`,
    );
  if (narrow)
    sources.push(
      `<source media="(max-width: ${narrow.maxWidth}px)" srcset="${imageUrl(narrow.src)}"${narrowDimensions}>`,
    );
  if (sources.length === 0) return image;
  return `<picture>${sources.join("")}${image}</picture>`;
}

/** Escapes text for use inside a double-quoted HTML attribute. */
const escapeAttribute = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Renders a site image for an HTML page, with the same sizing, lazy loading, and reduced-motion handling as
 * images in Markdown. Call it from a `data-bascik-build` script.
 *
 * `narrow` swaps in a different image on screens up to `maxWidth` pixels wide. A wide side-by-side recording
 * would shrink to unreadable on a phone, so a stacked recording is served there instead.
 */
export function demoImage(
  src: string,
  alt: string,
  narrow?: { src: string; maxWidth: number },
): string {
  return renderImage(src, ` alt="${escapeAttribute(alt)}"`, narrow);
}

/**
 * Most characters of text that may come before an image for it to count as the likely LCP image. Measured on
 * the pages that open with a recording: getting-started has 499, stream-scripts 725 and sitemap 961, while
 * developer-experience, whose largest paint is its intro text, has 1,680.
 */
const LCP_IMAGE_MAX_TEXT_BEFORE = 1000;

interface RenderMdOptions {
  skipFirstHeading?: boolean;
  /**
   * The rendered Markdown is the top of its page, so its first image above the second `<h2>` is likely the
   * Largest Contentful Paint element and loads eagerly. Set by `renderMd` and by `renderMdRange` without `from`.
   */
  pageTop?: boolean;
  stripDemoBlocks?: boolean;
  skipToFirstH2?: boolean;
}

interface RenderRange {
  from?: string;
  to?: string;
}

/**
 * Reads a Markdown file and returns the rendered HTML string.
 *
 * @param {string} filePath - Path relative to process.cwd() (the project root).
 * @param {object} [options]
 * @param {boolean} [options.skipFirstHeading=false] - Strip the first <h1>–<h6> from
 *   the output. Useful when the page HTML shell already contains a <h1> that matches
 *   the section heading at the top of the MD file (needed for llms.txt consistency).
 */
/**
 * Extracts a specific named code block from a Markdown file, highlighted in the language of its fence (see
 * highlight.ts), or HTML-escaped when the highlighter does not know that language.
 *
 * Code blocks are identified by an HTML comment marker placed immediately
 * before the fenced code block in the MD source:
 *
 *   <!-- demo:source-html -->
 *   ```html
 *   <div class="fcard">…</div>
 *   ```
 *
 * Use inside a `data-bascik-build` script in a slot to keep code examples
 * in MD (so they feed llms.txt / SKILL.md) rather than writing raw
 * &lt;/&gt; entities directly in the HTML page.
 *
 * @param {string} filePath - Path relative to process.cwd().
 * @param {string} markerId - The marker identifier, e.g. 'source-html'.
 * @returns {Promise<string>} Highlighted, escaped code ready for a <code-block> slot.
 */
export async function extractDemoBlock(
  filePath: string,
  markerId: string,
): Promise<string> {
  const block = await readDemoBlock(filePath, markerId);
  if (block.code === undefined) {
    // readDemoBlock already warned about an unreadable file. A missing marker or fence would otherwise ship an
    // empty code block with only an HTML comment to show for it (demo-markers.test.ts fails on one in the docs).
    if (block.reason !== "file")
      console.warn(
        `[md-renderer] Warning: ${block.message}; the code block is empty.`,
      );
    return block.problem;
  }
  return highlightCode(block.code, block.lang);
}

/** Escapes source code for a <code-block> slot. */
export { escapeCode };

/**
 * A readDemoBlock failure: the message for the build log, and the same text as the HTML comment that stands in
 * for the code block in the page. A marker id or path holding `<` or `>` is escaped inside the comment, so a
 * `-->` or `--!>` in it (both end a comment in the HTML parser) cannot close the comment early.
 */
const demoBlockProblem = (
  message: string,
): { problem: string; message: string } => ({
  problem: `<!-- ${message.replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"))} -->`,
  message,
});

/**
 * The raw, unescaped text of a named code block, for printing it as live markup (an example preview).
 * `problem` is an HTML comment describing why the block could not be read; `message` is its text, for a log.
 */
export async function readDemoBlock(
  filePath: string,
  markerId: string,
): Promise<
  | {
      code: string;
      lang: string;
      problem?: undefined;
      message?: undefined;
      reason?: undefined;
    }
  | {
      code?: undefined;
      problem: string;
      message: string;
      reason: "file" | "marker" | "fence";
    }
> {
  let md: string;
  try {
    md = await readFile(filePath, "utf8");
  } catch (err) {
    console.warn(
      `[md-renderer] Warning: Could not read file "${filePath}": ${(err as Error).message}`,
    );
    return {
      ...demoBlockProblem(`[md-renderer] File not found: ${filePath}`),
      reason: "file",
    };
  }
  const markerRe = new RegExp(`<!--\\s*demo:${markerId}\\s*-->`, "i");
  const markerMatch = markerRe.exec(md);
  if (!markerMatch)
    return {
      ...demoBlockProblem(`demo:${markerId} not found in ${filePath}`),
      reason: "marker",
    };

  const rest = md.slice(markerMatch.index + markerMatch[0].length);
  // Match the next fenced code block (``` ... ```)
  const codeRe = /^```(\w*)\n([\s\S]*?)\n^```/m;
  const codeMatch = codeRe.exec(rest);
  if (!codeMatch)
    return {
      ...demoBlockProblem(
        `no code block after demo:${markerId} in ${filePath}`,
      ),
      reason: "fence",
    };
  return { code: codeMatch[2], lang: codeMatch[1] || "text" };
}

export async function renderMd(
  filePath: string,
  {
    skipFirstHeading = false,
    stripDemoBlocks = false,
    skipToFirstH2 = false,
  }: RenderMdOptions = {},
): Promise<string> {
  let md: string;
  try {
    md = await readFile(filePath, "utf8");
  } catch (err) {
    console.warn(
      `[md-renderer] Warning: Could not read file "${filePath}": ${(err as Error).message}`,
    );
    return `<div class="callout"><p><strong>File not found:</strong> <code>${filePath}</code></p></div>`;
  }
  if (skipToFirstH2) {
    const firstH2 = md.match(/^## .+$/m);
    // No H2 means no release entries yet; render nothing rather than the
    // file header (which the page intro already covers).
    if (!firstH2) return "";
    md = md.slice(firstH2.index);
  }
  return _transformMd(
    md,
    { skipFirstHeading, stripDemoBlocks, pageTop: true },
    filePath,
  );
}

/**
 * Renders a slice of a Markdown file between two heading texts.
 *
 * @param {string} filePath
 * @param {object} [range]
 * @param {string} [range.from] - Start from this heading text (inclusive). Omit to start from file beginning.
 * @param {string} [range.to]   - Stop before this heading text (exclusive). Omit to go to end of file.
 * @param {object} [options]    - Same options as renderMd.
 */
export async function renderMdRange(
  filePath: string,
  { from, to }: RenderRange = {},
  options: RenderMdOptions = {},
): Promise<string> {
  let md: string;
  try {
    md = await readFile(filePath, "utf8");
  } catch (err) {
    console.warn(
      `[md-renderer] Warning: Could not read file "${filePath}": ${(err as Error).message}`,
    );
    return `<div class="callout"><p><strong>File not found:</strong> <code>${filePath}</code></p></div>`;
  }

  if (from) {
    const idx = _headingIndex(md, from);
    if (idx === -1) {
      throw new Error(
        `[md-renderer] Heading "from: ${from}" not found in ${filePath}`,
      );
    }
    md = md.slice(idx);
  }
  if (to) {
    const idx = _headingIndex(md, to);
    if (idx === -1) {
      throw new Error(
        `[md-renderer] Heading "to: ${to}" not found in ${filePath}`,
      );
    }
    md = md.slice(0, idx);
  }

  return _transformMd(md, { ...options, pageTop: !from }, filePath);
}

function _headingIndex(md: string, headingText: string): number {
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n)(#{1,6} ${escaped}[ \\t]*)(?=\\n|$)`);
  const m = re.exec(md);
  if (!m) return -1;
  return m[1] === "" ? m.index : m.index + 1;
}

function _transformMd(
  md: string,
  {
    skipFirstHeading = false,
    stripDemoBlocks = false,
    pageTop = false,
  }: RenderMdOptions = {},
  filePath = "Markdown",
): string {
  if (stripDemoBlocks) {
    md = md
      // Formatters put a blank line between the marker and its fence, so any whitespace may separate them. A
      // verbatim block may carry a `<!-- prettier-ignore -->` line between the two; it goes with the block.
      .replace(
        /<!--\s*demo:[\w-]+\s*-->\s*\n(?:\s*<!--\s*prettier-ignore\s*-->\s*\n)?\s*```[\w-]*\n[\s\S]*?\n```/g,
        "",
      )
      .trim();
  }

  let html = marked.parse(md, { async: false });
  // Optionally strip the first heading (h1–h6)
  if (skipFirstHeading) {
    html = html.replace(/^<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>\n?/, "");
  }

  // Add id attributes to h2 and h3 headings and wrap text in a copyable anchor link.
  // Two headings with one id send the second one's anchor link, its "On this page" entry and its search result
  // to the first, so a repeat is reported (heading-ids.test.ts fails on one in docs/content too).
  const headingsById = new Map<string, string>();
  html = html.replace(/<h([23])>(.*?)<\/h\1>/g, (_, level, text) => {
    const slug = slugFromHeadingHtml(text);
    const first = headingsById.get(slug);
    if (first === undefined) headingsById.set(slug, headingPlainText(text));
    else
      console.warn(
        `[md-renderer] Warning: ${filePath}: heading "${headingPlainText(text)}" has the same id #${slug} as "${first}"; rename one so its link and table of contents entry reach it.`,
      );
    return `<h${level} id="${slug}"><a class="anchor-link" href="#${slug}">${text}</a></h${level}>`;
  });

  // Convert <pre><code class="language-X"> → <code-block data-bascik-prop-lang="X">, highlighted at build time.
  // marked HTML-escapes code content; a language the highlighter does not know keeps that escaped text.
  html = html.replace(
    /<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_, lang: string, code: string) => {
      const source = unescapeCode(code);
      const highlighted = highlightCode(source, lang);
      const body = highlighted === escapeCode(source) ? code : highlighted;
      return `<code-block data-bascik-prop-lang="${lang}">${body}</code-block>\n`;
    },
  );
  // Code blocks with no language tag
  html = html.replace(
    /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    (_, code) =>
      `<code-block data-bascik-prop-lang="text">${code}</code-block>\n`,
  );

  // Wrap all prose code-blocks in a spacing div so global CSS can add margin-bottom
  // without fighting bascik's component CSS scoping (which hashes .cblock class names).
  html = html.replace(
    /(<code-block[^>]*>[\s\S]*?<\/code-block>)/g,
    '<div class="prose-codeblock">$1</div>',
  );

  // Convert <blockquote> → <div class="callout">. A blockquote whose first paragraph opens with
  // **See it live** gets the live-demo variant so links to running deployments stand out.
  html = html.replace(
    /<blockquote>\n?(?=<p><strong>See it live\b)/g,
    '<div class="callout callout-live">',
  );
  html = html.replace(/<blockquote>\n?/g, '<div class="callout">');
  html = html.replace(/\n?<\/blockquote>/g, "</div>");

  // Wrap all tables in <doc-table> component and ensure table header cells have scope="col"
  // The whole opening tag, so an aligned column's <th align="center"> gets it too; <thead> is not a match.
  html = html.replace(
    /<th\b(?![^>]*\bscope=)([^>]*)>/g,
    (_, attributes: string) => `<th scope="col"${attributes}>`,
  );
  html = html.replace(
    /(<table[\s\S]*?<\/table>)/g,
    "<doc-table>$1</doc-table>",
  );

  // Images: lazy loading, the display size, and a reduced-motion still for animated demos. At the top of a
  // page, the first image above the second <h2> is likely the Largest Contentful Paint element, so it loads
  // eagerly, unless more than LCP_IMAGE_MAX_TEXT_BEFORE characters of text come first: then the text is the
  // largest paint on a laptop screen and the image is below the fold on a phone. Only one image gets that,
  // however many an author places above the fold.
  const h2Offsets = [...html.matchAll(/<h2[\s>]/g)].map((match) => match.index);
  const foldOffset = h2Offsets[1] ?? Infinity;
  const textBefore = (offset: number) =>
    html
      .slice(0, offset)
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ").length;
  let eagerUsed = !pageTop;
  html = html.replace(
    /<img src="(\/[^"]+)"([^>]*)>/g,
    (_, src: string, rest: string, offset: number) => {
      const eager =
        !eagerUsed &&
        offset < foldOffset &&
        textBefore(offset) <= LCP_IMAGE_MAX_TEXT_BEFORE;
      if (eager) eagerUsed = true;
      return renderImage(unescapeMarkedAttribute(src), rest, undefined, eager);
    },
  );

  // Open external links in a new tab
  html = html.replace(
    /<a href="(https?:\/\/[^"]+)"/g,
    '<a target="_blank" rel="noopener noreferrer" href="$1"',
  );

  return html;
}
