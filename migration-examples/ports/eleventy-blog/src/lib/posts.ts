import { readdir, readFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { contentRoot, includeDrafts, slugify } from './site.ts';

// Equivalent of Eleventy's `collections.posts`. Bascik has no content collections,
// so this reads content/blog/**/*.md, validates the front matter, and orders the
// result the way Eleventy does (by date, then by input path).

// Upstream validates only `draft` (`_data/eleventyDataSchema.js`). The other fields are
// validated here too because nothing else would catch a missing date.
const frontMatter = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  date: z.coerce.date(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  draft: z.boolean().optional(),
});

export interface Post {
  /** Path relative to content/, with forward slashes (for example `blog/firstpost.md`). */
  file: string;
  /** Public URL with a trailing slash, for example `/blog/firstpost/`. */
  url: string;
  /** The dynamic route parameter for src/pages/blog/[slug]/index.html. */
  slug: string;
  title: string | undefined;
  description: string | undefined;
  date: Date;
  tags: string[];
  draft: boolean;
  body: string;
}

export interface TagGroup {
  name: string;
  slug: string;
  posts: Post[];
}

// Upstream hides these from tag lists because Eleventy adds them to every post.
const RESERVED_TAGS = new Set(['all', 'posts']);

function routeFor(file: string): { url: string; slug: string } {
  const segments = file.split('/');
  const stem = basename(file, '.md');
  const directories = segments.slice(0, -1);
  // content/blog/name.md and content/blog/name/name.md both become /blog/name/. Eleventy
  // collapses a file whose name equals its folder the same way, and the folder is where a
  // post keeps its images.
  if (directories.length === 0 || (directories.length === 1 && directories[0] === stem)) {
    return { url: `/blog/${stem}/`, slug: stem };
  }
  throw new Error(
    `content/blog/${file}: only content/blog/name.md and content/blog/name/name.md are supported. ` +
    'A Bascik dynamic route has a fixed number of [params], so every extra directory level needs ' +
    'its own template under src/pages/blog/.',
  );
}

/** Every post, oldest first, with drafts removed outside development. */
export async function loadPosts(): Promise<Post[]> {
  const blogRoot = join(contentRoot(), 'blog');
  let entries: string[] = [];
  try {
    entries = await readdir(blogRoot, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const files = entries
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.split(sep).join('/'))
    .filter((entry) => !entry.split('/').some((segment) => segment.startsWith('.')))
    .sort();

  const posts: Post[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const parsed = matter(await readFile(join(blogRoot, file), 'utf8'));
    const result = frontMatter.safeParse(parsed.data);
    if (!result.success) {
      throw new Error(`Invalid front matter in content/blog/${file}: ${z.prettifyError(result.error)}`);
    }
    const data = result.data;
    const draft = data.draft === true;
    if (draft && !includeDrafts()) continue;
    const route = routeFor(file);
    const earlier = seen.get(route.url);
    if (earlier) throw new Error(`content/blog/${file} and content/blog/${earlier} both publish ${route.url}`);
    seen.set(route.url, file);
    posts.push({
      file: `blog/${file}`,
      ...route,
      title: draft ? `${data.title ?? basename(file, '.md')} (draft)` : data.title,
      description: data.description,
      date: data.date,
      tags: data.tags === undefined ? [] : Array.isArray(data.tags) ? data.tags : [data.tags],
      draft,
      body: parsed.content,
    });
  }
  return posts.sort((a, b) => a.date.getTime() - b.date.getTime() || a.file.localeCompare(b.file));
}

/** Tags a reader sees: the upstream `filterTagList` filter. */
export const visibleTags = (post: Post): string[] => post.tags.filter((tag) => !RESERVED_TAGS.has(tag));

/** Tag groups sorted alphabetically (`sortAlphabetically`). Two tags with one slug are an error. */
export function collectTags(posts: Post[]): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  for (const post of posts) {
    for (const name of visibleTags(post)) {
      const slug = slugify(name);
      if (!slug) throw new Error(`${post.file}: tag ${JSON.stringify(name)} has no letters or digits to build a URL from`);
      const group = groups.get(slug);
      if (group && group.name !== name) {
        throw new Error(`${post.file}: tags ${JSON.stringify(group.name)} and ${JSON.stringify(name)} would both publish /tags/${slug}/`);
      }
      if (group) group.posts.push(post);
      else groups.set(slug, { name, slug, posts: [post] });
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Route list for src/pages/blog/[slug]/index.html, as printed by `<script data-bascik-routes>`. */
export const postRoutes = (posts: Post[]): Array<{ params: { slug: string } }> =>
  posts.map((post) => ({ params: { slug: post.slug } }));

/** Find the post for a route's slug. */
export function findPost(posts: Post[], slug: string): Post {
  const post = posts.find((entry) => entry.slug === slug);
  if (!post) throw new Error(`No post for route /blog/${slug}/`);
  return post;
}
