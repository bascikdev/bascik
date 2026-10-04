import { Marked, type Tokens } from 'marked';
import { contentRoot } from './env.ts';
import { decodeEntities, escapeHtml, slugify } from './format.ts';
import { isExternal, resolveContentPath, relativeToContent } from './content-paths.ts';
import { describeImage, renderImg } from './images.ts';
import { highlightCode } from './highlight.ts';

// Markdown to HTML at build time. Authors are trusted: raw HTML in a post is passed through, so do
// not point this at text written by visitors. Everything else (ids, anchors, links, images, code)
// is generated here, and the page ships no JavaScript for any of it.

export interface RenderOptions {
  /** Path of the Markdown file relative to content/, used to resolve relative links and images. */
  file: string;
  /** Add the "#" links after h2-h6. The feed passes false. */
  anchors?: boolean;
  /** Ids already used elsewhere on the same page, such as the post title's id. */
  reservedIds?: Iterable<string>;
  /**
   * Public URLs of every page the Markdown may link to by `.md` path. A link to any other page,
   * such as a draft in a production build, fails the build.
   */
  published: ReadonlySet<string>;
  /** Map a content file to its public URL, or null when it is not a page. */
  urlForFile: (relativePath: string) => string | null;
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

function renderHeading(depth: number, innerHtml: string, ids: HeadingIds, anchors: boolean, counter: { n: number }): string {
  const id = ids.next(textOf(innerHtml));
  if (!anchors || depth < 2) return `<h${depth} id="${id}">${innerHtml}</h${depth}>\n`;
  const name = `--ha-${counter.n++}`;
  // The placeholder sits inside the heading but is hidden from assistive technology. The link is a
  // sibling, so the heading keeps its own accessible name. CSS anchor positioning puts the link
  // over the placeholder (see src/css/global.css); without it the link still works.
  return (
    `<h${depth} id="${id}">${innerHtml}<span class="ha-placeholder" aria-hidden="true" style="anchor-name: ${name}">#</span></h${depth}>` +
    `<a class="ha" href="#${id}" style="position-anchor: ${name}">` +
    `<span class="visually-hidden">Jump to section titled: ${escapeHtml(textOf(innerHtml))}</span><span aria-hidden="true">#</span></a>\n`
  );
}

/** Render a Markdown body to HTML. */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const root = contentRoot();
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
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link): string {
        const inner = this.parser.parseInline(tokens);
        let target = href;
        if (!isExternal(href) && !href.startsWith('#')) {
          const [path = '', fragment = ''] = href.split(/(?=#)/);
          if (/\.md$/i.test(path)) {
            const found = resolveContentPath(decodeURI(path), options.file, root);
            const url = found ? options.urlForFile(relativeToContent(found, root)) : null;
            if (!url || !options.published.has(url)) {
              throw new Error(
                `content/${options.file}: link "${href}" does not point at a published page. ` +
                'A link to a draft fails production builds for the same reason.',
              );
            }
            target = `${url}${fragment}`;
          }
        }
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
        const external = isExternal(target) && !target.startsWith('mailto:') && !target.startsWith('tel:');
        const rel = external ? ' rel="noopener"' : '';
        return `<a href="${escapeHtml(target)}"${titleAttribute}${rel}>${inner}</a>`;
      },
      image({ href, title, text }: Tokens.Image): string {
        // Images on other sites are written as authored. Local images must exist under content/
        // (relative to the post, or starting with `/` for the content root); they get their real
        // width and height and, when -<width>w copies sit beside them, a srcset.
        if (isExternal(href)) {
          return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" decoding="async">`;
        }
        const found = resolveContentPath(decodeURI(href), options.file, root);
        if (!found) throw new Error(`content/${options.file}: image "${href}" does not exist`);
        const img = renderImg(describeImage(found, root), text);
        return title ? `<figure>${img}<figcaption>${escapeHtml(title)}</figcaption></figure>` : img;
      },
    },
  });
  return marked.parse(source, { async: false });
}
