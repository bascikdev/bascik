import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { imageSize } from 'image-size';
import { Marked, type Tokens } from 'marked';
import { highlightCode } from './highlight.ts';
import { contentRoot, decodeEntities, escapeHtml, slugify } from './site.ts';

// Replaces the upstream Markdown pipeline: markdown-it + Prism highlighting, heading ids
// (`IdAttributePlugin`), the `<heading-anchors>` web component, relative link and image
// handling (`InputPathToUrlTransformPlugin`, the image transform) and the feed's absolute
// URLs. Everything here runs at build time and emits plain HTML.

export interface RenderOptions {
  /** Path of the Markdown file relative to content/, used to resolve relative links and images. */
  file: string;
  /** Add the build-time "#" links after h2-h6. The feed passes false. */
  anchors?: boolean;
  /** Ids already used elsewhere on the same page, such as the post title's id. */
  reservedIds?: Iterable<string>;
  /** URLs that exist in this build. A link to any other page, such as a draft in production, fails. */
  published: ReadonlySet<string>;
}

/** Hands out unique heading ids per page: `title`, `title-2`, ... */
export class HeadingIds {
  private readonly used = new Set<string>();
  constructor(reserved: Iterable<string> = []) {
    for (const id of reserved) this.used.add(id);
  }
  next(text: string): string {
    const base = slugify(text) || 'section';
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}-${n}`;
    this.used.add(id);
    return id;
  }
}

/** Plain text of rendered inline HTML. */
const textOf = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, '')).trim();

/** The heading id for a title that sits outside the Markdown, such as a post's h1. */
export const headingId = (ids: HeadingIds, text: string): string => ids.next(text);

function renderHeading(depth: number, innerHtml: string, ids: HeadingIds, anchors: boolean, counter: { n: number }): string {
  const text = textOf(innerHtml);
  const id = ids.next(text);
  // Same selector the web component uses: h2 through h6.
  if (!anchors || depth < 2) return `<h${depth} id="${id}">${innerHtml}</h${depth}>\n`;
  const name = `--ha-${counter.n++}`;
  // The placeholder sits inside the heading but is hidden from assistive technology. The link
  // is a sibling, so the heading keeps its own accessible name. CSS anchor positioning puts the
  // link over the placeholder (see the end of src/css/global.css).
  return (
    `<h${depth} id="${id}">${innerHtml}<span class="ha-placeholder" aria-hidden="true" style="anchor-name: ${name}">#</span></h${depth}>` +
    `<a class="ha" href="#${id}" style="position-anchor: ${name}">` +
    `<span class="visually-hidden">Jump to section titled: ${escapeHtml(text)}</span><span aria-hidden="true">#</span></a>\n`
  );
}

const isExternal = (value: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);

/** Resolve a link or image target written in a Markdown file to a path under content/. */
function resolveContentPath(target: string, file: string): string | null {
  const root = resolve(contentRoot());
  const candidates = target.startsWith('/')
    ? [join(root, target)]
    // Eleventy resolves relative to the page, then to the input directory. The base blog's
    // second post depends on the second form (`blog/thirdpost.md` from content/blog/).
    : [resolve(root, dirname(file), target), resolve(root, target)];
  for (const candidate of candidates) {
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error(`content/${file}: "${target}" points outside content/`);
    }
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Map an input file to its public URL, using the same rules as src/lib/posts.ts. */
function urlForInput(path: string): string | null {
  const relative = posix.normalize(path.slice(resolve(contentRoot()).length + 1).split(sep).join('/'));
  if (relative === 'about.md') return '/about/';
  const match = /^blog\/(?:([^/]+)\/)?([^/]+)\.md$/.exec(relative);
  if (!match) return null;
  if (match[1] !== undefined && match[1] !== match[2]) return null;
  return `/blog/${match[2]}/`;
}

/** `href="x.md#frag"` to the page that file becomes. Broken targets fail the build. */
export function rewriteMarkdownLinks(html: string, file: string, published: ReadonlySet<string>): string {
  return html.replace(/(<a\b[^>]*?\shref=)(["'])([^"']*)\2/gi, (whole, prefix: string, quote: string, value: string) => {
    if (isExternal(value) || value.startsWith('#')) return whole;
    const [target, hash = ''] = value.split(/(?=#)/);
    if (!/\.md$/i.test(target)) return whole;
    const path = resolveContentPath(decodeURI(target), file);
    const url = path ? urlForInput(path) : null;
    if (!url || !published.has(url)) {
      throw new Error(
        `content/${file}: link "${value}" does not point at a published page. ` +
        'A link to a draft fails in production builds for the same reason.',
      );
    }
    return `${prefix}${quote}${url}${hash}${quote}`;
  });
}

/**
 * Local images get an absolute URL, width/height, lazy loading, and async decoding, which is
 * what the upstream image transform emits for the original format. It does not create AVIF or
 * WebP variants.
 */
export function rewriteImages(html: string, file: string): string {
  return html.replace(/<img\b([^>]*?)\/?>/gi, (whole, attributes: string) => {
    const src = /\ssrc=(["'])([^"']*)\1/i.exec(` ${attributes}`)?.[2];
    if (!src || isExternal(src) || src.startsWith('/')) return whole;
    const path = resolveContentPath(decodeURI(src), file);
    if (!path) throw new Error(`content/${file}: image "${src}" does not exist`);
    const size = imageSize(readFileSync(path));
    if (!size.width || !size.height) throw new Error(`content/${file}: cannot read the size of "${src}"`);
    // Post images live beside the post, and scripts/copy-content-assets.ts publishes them at
    // the same path under dist/.
    const relativeToContent = path.slice(resolve(contentRoot()).length + 1).split(sep).join('/');
    const alt = /\salt=(["'])([^"']*)\1/i.exec(` ${attributes}`)?.[2] ?? '';
    return `<img loading="lazy" decoding="async" src="/${escapeHtml(relativeToContent)}" alt="${alt}" width="${size.width}" height="${size.height}">`;
  });
}

/** Make links and images absolute for the feed, including same-page `#fragment` links. */
export function absolutizeForFeed(html: string, origin: string, pageUrl: string): string {
  return html.replace(/(\s(?:href|src)=)(["'])([^"']*)\2/gi, (whole, prefix: string, quote: string, value: string) => {
    if (isExternal(value)) return whole;
    if (value.startsWith('#')) return `${prefix}${quote}${origin}${pageUrl}${value}${quote}`;
    if (value.startsWith('/')) return `${prefix}${quote}${origin}${value}${quote}`;
    return whole;
  });
}

/** Render a Markdown body to HTML. */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const ids = new HeadingIds(options.reservedIds);
  const counter = { n: 0 };
  const anchors = options.anchors !== false;
  const marked = new Marked({
    renderer: {
      code({ text, lang }: Tokens.Code): string {
        return highlightCode(text, lang);
      },
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { tokens, depth }: Tokens.Heading): string {
        return renderHeading(depth, this.parser.parseInline(tokens), ids, anchors, counter);
      },
    },
  });
  const html = marked.parse(source, { async: false });
  return rewriteImages(rewriteMarkdownLinks(html, options.file, options.published), options.file);
}
