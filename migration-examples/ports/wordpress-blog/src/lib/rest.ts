import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { htmlToText, sanitizeContent, type UrlMapper } from './html.ts';
import type { Image, Page, Post, Snapshot, Term } from './model.ts';
import { pagePath, postPath } from './model.ts';

// Reads a WordPress site through its public REST API (`/wp-json/wp/v2/`). Only published content
// is public, so drafts, private posts, and password-protected bodies never reach the build.
// Media files under `/wp-content/uploads/` are downloaded into the output directory at the same
// path, so image URLs keep working after the move.

const PER_PAGE = 100; // The REST API rejects larger pages with 400.

interface RestTerm { id: number; slug: string; name: string; taxonomy: string }
interface RestMediaSize { source_url: string; width: number; height: number }
interface RestMedia {
  source_url: string;
  alt_text: string;
  media_details?: { width?: number; height?: number; sizes?: Record<string, RestMediaSize> };
}
interface RestPost {
  id: number;
  slug: string;
  date: string;
  link: string;
  status: string;
  title: { rendered: string };
  excerpt: { rendered: string; protected: boolean };
  content: { rendered: string; protected: boolean };
  parent?: number;
  menu_order?: number;
  _embedded?: {
    author?: Array<{ name: string }>;
    'wp:featuredmedia'?: RestMedia[];
    'wp:term'?: RestTerm[][];
  };
}

/** GET every page of a collection, following `X-WP-TotalPages`. */
async function fetchAll<T>(origin: string, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1, total = 1; page <= total; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${origin}/wp-json/wp/v2/${path}${separator}per_page=${PER_PAGE}&page=${page}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`WordPress REST request failed: ${response.status} ${url}`);
    total = Number(response.headers.get('x-wp-totalpages') ?? '1');
    items.push(...(await response.json()) as T[]);
  }
  return items;
}

/** Map WordPress URLs to local paths, collecting the media files to download. */
function urlMapper(origin: string, downloads: Map<string, string>, permalinks: Map<string, string>): UrlMapper {
  return (url, kind) => {
    let parsed: URL;
    try { parsed = new URL(url, origin); } catch { return undefined; }
    if (parsed.origin !== origin) return undefined;
    if (parsed.pathname.startsWith('/wp-content/uploads/')) {
      downloads.set(parsed.pathname, parsed.href);
      return parsed.pathname;
    }
    if (kind === 'link') return (permalinks.get(parsed.pathname) ?? parsed.pathname) + parsed.search + parsed.hash;
    return undefined;
  };
}

function featuredImage(media: RestMedia | undefined, map: UrlMapper): Image | undefined {
  const width = media?.media_details?.width;
  const height = media?.media_details?.height;
  if (!media || !width || !height) return undefined;
  // WordPress lists only sizes with the original aspect ratio in srcset; cropped sizes such as the
  // 150x150 thumbnail are left out. Same rule here.
  const ratio = width / height;
  const candidates = Object.values(media.media_details?.sizes ?? {})
    .filter((size) => Math.abs(size.width / size.height - ratio) < 0.01)
    .sort((a, b) => a.width - b.width)
    .map((size) => `${map(size.source_url, 'image') ?? size.source_url} ${size.width}w`);
  return {
    src: map(media.source_url, 'image') ?? media.source_url,
    srcset: [...new Set(candidates)].join(', ') || undefined,
    width,
    height,
    alt: media.alt_text,
  };
}

function termsOf(item: RestPost, taxonomy: string): Term[] {
  return (item._embedded?.['wp:term'] ?? []).flat()
    .filter((entry) => entry.taxonomy === taxonomy)
    .map((entry) => ({ slug: entry.slug, name: htmlToText(entry.name) }));
}

/** Download every referenced upload into `outDirectory`, keeping its path. */
async function download(downloads: Map<string, string>, outDirectory: string): Promise<void> {
  for (const [pathname, href] of downloads) {
    const response = await fetch(href, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Media download failed: ${response.status} ${href}`);
    const target = join(outDirectory, decodeURIComponent(pathname));
    if (!target.startsWith(outDirectory + '/')) throw new Error(`Unsafe media path: ${pathname}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
  }
}

export async function snapshotFromRest(origin: string, outDirectory: string): Promise<Snapshot> {
  const base = new URL(origin).origin;
  const index = await fetch(`${base}/wp-json/`, { signal: AbortSignal.timeout(60000) });
  if (!index.ok) throw new Error(`WordPress REST index failed: ${index.status} ${base}/wp-json/`);
  const site = await index.json() as { name: string; description: string };
  const embed = '_embed=author,wp:featuredmedia,wp:term';
  const [restPosts, restPages] = await Promise.all([
    fetchAll<RestPost>(base, `posts?${embed}&orderby=date&order=desc`),
    fetchAll<RestPost>(base, 'pages?orderby=menu_order&order=asc'),
  ]);

  const pageSlugs = new Map(restPages.map((item) => [item.id, item.slug]));
  const pageParents = new Map(restPages.map((item) => [item.id, item.parent ?? 0]));
  for (const item of restPages) {
    if (item.parent && pageParents.get(item.parent)) {
      throw new Error(`Page "${item.slug}" is nested three levels deep. This port supports top-level pages and their children only.`);
    }
  }
  // Internal links in content point at WordPress permalinks; map each to the port's path.
  const permalinks = new Map<string, string>();
  const downloads = new Map<string, string>();
  const map = urlMapper(base, downloads, permalinks);

  const posts: Post[] = restPosts.map((item) => {
    const date = item.date.slice(0, 19);
    const local = postPath({ date, slug: item.slug });
    permalinks.set(new URL(item.link).pathname, local);
    return {
      slug: item.slug,
      title: htmlToText(item.title.rendered) || '(no title)',
      date,
      excerpt: item.excerpt.protected ? '' : htmlToText(item.excerpt.rendered),
      html: '',
      author: item._embedded?.author?.[0]?.name ?? '',
      categories: termsOf(item, 'category').filter((entry) => entry.slug !== 'uncategorized'),
      tags: termsOf(item, 'post_tag'),
      featured: featuredImage(item._embedded?.['wp:featuredmedia']?.[0], map),
    };
  });
  const pages: Page[] = restPages.map((item) => {
    const parent = item.parent ? pageSlugs.get(item.parent) : undefined;
    permalinks.set(new URL(item.link).pathname, pagePath({ slug: item.slug, parent }));
    return {
      slug: item.slug,
      parent,
      title: htmlToText(item.title.rendered) || '(no title)',
      excerpt: item.excerpt.protected ? '' : htmlToText(item.excerpt.rendered),
      html: '',
      order: item.menu_order ?? 0,
    };
  });
  // Bodies are sanitized after every permalink is known, so links between posts resolve.
  restPosts.forEach((item, i) => {
    posts[i].html = item.content.protected ? '' : sanitizeContent(item.content.rendered, map);
  });
  restPages.forEach((item, i) => {
    pages[i].html = item.content.protected ? '' : sanitizeContent(item.content.rendered, map);
  });

  await download(downloads, outDirectory);
  return {
    source: 'rest',
    site: { name: htmlToText(site.name), description: htmlToText(site.description) },
    posts,
    pages,
  };
}
