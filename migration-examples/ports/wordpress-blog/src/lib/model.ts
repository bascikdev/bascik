import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// One normalized snapshot of the site, written by scripts/sync-wordpress.ts (a `pre` exec step)
// and read by every page. It is built either from the WordPress REST API or from Markdown files
// converted out of a WordPress export. All HTML in it has already been sanitized and every URL
// rewritten to its local path, so pages only print it. This module has no dependencies: every
// build script runs in a fresh Node process, so the helpers pages import must stay light.
// The snapshot is validated (src/lib/schema.ts) once, when it is written.

export interface Term { slug: string; name: string }
export interface Image { src: string; srcset?: string; width: number; height: number; alt: string }
export interface Post {
  slug: string;
  title: string;
  /** Site-local date and time as WordPress stores it, `YYYY-MM-DDTHH:MM:SS`. Drives the permalink. */
  date: string;
  excerpt: string;
  html: string;
  author: string;
  categories: Term[];
  tags: Term[];
  featured?: Image;
}
export interface Page { slug: string; parent?: string; title: string; excerpt: string; html: string; order: number }
export interface Snapshot {
  source: 'rest' | 'markdown';
  site: { name: string; description: string };
  posts: Post[];
  pages: Page[];
}

/** Outside `src/` and `dist/`: neither a watched source nor a published file. */
export const SNAPSHOT_PATH = join('node_modules', '.cache', 'bascik-wordpress', 'snapshot.json');

/** Posts per listing page. WordPress's own setting (Settings > Reading) is not public over REST. */
export const POSTS_PER_PAGE = 3;

let cached: Snapshot | undefined;

/** Read the snapshot for this build. Posts are sorted newest first, as WordPress lists them. */
export async function loadSnapshot(): Promise<Snapshot> {
  if (cached) return cached;
  let text: string;
  try {
    text = await readFile(join(process.cwd(), SNAPSHOT_PATH), 'utf8');
  } catch {
    throw new Error(`${SNAPSHOT_PATH} is missing. It is written by scripts/sync-wordpress.ts, a pipeline.exec 'pre' step.`);
  }
  const snapshot = JSON.parse(text) as Snapshot;
  snapshot.posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  cached = snapshot;
  return snapshot;
}

/** `/2026/03/15/raised-beds/`, the default WordPress "Day and name" permalink. */
export function postPath(item: Pick<Post, 'date' | 'slug'>): string {
  const [year, month, day] = item.date.slice(0, 10).split('-');
  return `/${year}/${month}/${day}/${item.slug}/`;
}

export function pagePath(item: Pick<Page, 'slug' | 'parent'>): string {
  return item.parent ? `/${item.parent}/${item.slug}/` : `/${item.slug}/`;
}

export function termPath(taxonomy: 'category' | 'tag', slug: string, page = 1): string {
  return page > 1 ? `/${taxonomy}/${slug}/page/${page}/` : `/${taxonomy}/${slug}/`;
}

export function listingPath(page: number): string {
  return page > 1 ? `/page/${page}/` : '/';
}

export function pageCount(items: number): number {
  return Math.max(1, Math.ceil(items / POSTS_PER_PAGE));
}

export function pageOf<T>(items: T[], page: number): T[] {
  return items.slice((page - 1) * POSTS_PER_PAGE, page * POSTS_PER_PAGE);
}

/** Every term of one taxonomy that has at least one post, with its posts newest first. */
export function termsWithPosts(snapshot: Snapshot, taxonomy: 'category' | 'tag'): Array<{ term: Term; posts: Post[] }> {
  const map = new Map<string, { term: Term; posts: Post[] }>();
  for (const item of snapshot.posts) {
    for (const entry of taxonomy === 'category' ? item.categories : item.tags) {
      const group = map.get(entry.slug) ?? { term: entry, posts: [] };
      group.posts.push(item);
      map.set(entry.slug, group);
    }
  }
  return [...map.values()].sort((a, b) => a.term.slug.localeCompare(b.term.slug));
}
