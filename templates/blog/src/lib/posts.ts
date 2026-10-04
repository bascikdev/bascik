import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { contentRoot, includeDrafts } from './env.ts';
import { slugify } from './format.ts';
import { relativeToContent, resolveContentPath, toPosix } from './content-paths.ts';

// Bascik has no content collections, so this module is the collection: it reads
// content/blog/**/*.md, validates the front matter, and returns the posts in date order.
// Every page, the feed, and the tag pages call `loadPosts()`.

// Strict on purpose: a misspelled key (`tag:` for `tags:`) is an error instead of being ignored.
const frontMatter = z.strictObject({
  title: z.string().trim().min(1, 'title is required'),
  description: z.string().trim().min(1).optional(),
  date: z.coerce.date({ error: 'date is required and must look like 2026-01-31' }),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  draft: z.boolean().optional(),
  /** Hero image and link-preview image, a path relative to the post (or starting with `/` from content/). */
  image: z.string().trim().min(1).optional(),
  imageAlt: z.string().optional(),
});

export interface Post {
  /** Path relative to content/, with forward slashes (for example `blog/welcome.md`). */
  file: string;
  /** Public URL with a trailing slash, for example `/blog/welcome/`. */
  url: string;
  /** The dynamic route parameter for src/pages/blog/[slug]/index.html. */
  slug: string;
  title: string;
  description: string | undefined;
  date: Date;
  tags: string[];
  draft: boolean;
  /** Image path relative to content/ (`blog/welcome/lantern.png`), or null. */
  image: string | null;
  imageAlt: string;
  body: string;
}

export interface TagGroup {
  name: string;
  slug: string;
  posts: Post[];
}

/** `/blog/page/N/` is the archive, so a post may not take that slug. */
const RESERVED_SLUGS = new Set(['page']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function routeFor(file: string): { url: string; slug: string } {
  const stem = basename(file, '.md');
  const directories = file.split('/').slice(0, -1);
  // content/blog/name.md and content/blog/name/name.md both become /blog/name/. The folder form
  // is where a post keeps its images.
  if (directories.length > 1 || (directories.length === 1 && directories[0] !== stem)) {
    throw new Error(
      `content/blog/${file}: use content/blog/name.md or content/blog/name/name.md. ` +
      'A Bascik dynamic route has a fixed number of [params], so deeper folders would each need their own template.',
    );
  }
  if (!SLUG.test(stem)) {
    throw new Error(`content/blog/${file}: the file name becomes the URL, so use lowercase letters, digits, and single hyphens (for example "my-first-post")`);
  }
  if (RESERVED_SLUGS.has(stem)) {
    throw new Error(`content/blog/${file}: "${stem}" is reserved for /blog/${stem}/, choose another file name`);
  }
  return { url: `/blog/${stem}/`, slug: stem };
}

export interface LoadOptions {
  /** Keep drafts. Defaults to true in development and false in a production build. */
  drafts?: boolean;
}

/** Every post, oldest first. Drafts are removed unless this is the dev server (or `drafts: true`). */
export async function loadPosts(options: LoadOptions = {}): Promise<Post[]> {
  const keepDrafts = options.drafts ?? includeDrafts();
  const root = contentRoot();
  const blogRoot = join(root, 'blog');
  let entries: string[] = [];
  try {
    entries = await readdir(blogRoot, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const files = entries
    .map(toPosix)
    .filter((entry) => entry.endsWith('.md'))
    .filter((entry) => !entry.split('/').some((segment) => segment.startsWith('.')))
    .sort();

  const posts: Post[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const parsed = matter(await readFile(join(blogRoot, file), 'utf8'));
    const result = frontMatter.safeParse(parsed.data);
    if (!result.success) {
      throw new Error(`Invalid front matter in content/blog/${file}:\n${z.prettifyError(result.error)}`);
    }
    const data = result.data;
    const draft = data.draft === true;
    if (draft && !keepDrafts) continue;
    const route = routeFor(file);
    const earlier = seen.get(route.url);
    if (earlier) throw new Error(`content/blog/${file} and content/blog/${earlier} both publish ${route.url}`);
    seen.set(route.url, file);

    let image: string | null = null;
    if (data.image) {
      const found = resolveContentPath(data.image, `blog/${file}`, root);
      if (!found) throw new Error(`content/blog/${file}: image "${data.image}" does not exist`);
      image = relativeToContent(found, root);
    }
    const tags = (data.tags === undefined ? [] : Array.isArray(data.tags) ? data.tags : [data.tags]).map((tag) => tag.trim());
    if (tags.some((tag) => !tag)) throw new Error(`content/blog/${file}: tags cannot be empty`);

    posts.push({
      file: `blog/${file}`,
      ...route,
      title: draft ? `${data.title} (draft)` : data.title,
      description: data.description,
      date: data.date,
      tags,
      draft,
      image,
      imageAlt: data.imageAlt ?? '',
      body: parsed.content,
    });
  }
  return posts.sort((a, b) => a.date.getTime() - b.date.getTime() || a.file.localeCompare(b.file));
}

/** Newest first, for lists and the feed. */
export const newestFirst = (posts: readonly Post[]): Post[] => [...posts].reverse();

/** Tag groups sorted alphabetically. Two tags that share a slug are an error. */
export function collectTags(posts: readonly Post[]): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  for (const post of posts) {
    for (const name of new Set(post.tags)) {
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

/** Route list for src/pages/blog/[slug]/index.html. */
export const postRoutes = (posts: readonly Post[]): Array<{ params: { slug: string } }> =>
  posts.map((post) => ({ params: { slug: post.slug } }));

/** Find the post for a route's slug. */
export function findPost(posts: readonly Post[], slug: string): Post {
  const post = posts.find((entry) => entry.slug === slug);
  if (!post) throw new Error(`No post for route /blog/${slug}/`);
  return post;
}
