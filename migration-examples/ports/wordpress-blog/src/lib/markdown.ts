import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import matter from 'gray-matter';
import { imageSize } from 'image-size';
import { marked } from 'marked';
import { z } from 'zod';
import { htmlToText, sanitizeContent } from './html.ts';
import type { Image, Page, Post, Snapshot, Term } from './model.ts';
import { pagePath, postPath } from './model.ts';

// Reads content converted from a WordPress export (Tools > Export, a WXR file) by the community
// tool `wordpress-export-to-markdown`. Its layout is:
//
//   content/posts/<slug>/index.md        front matter: title, date, categories, tags, coverImage
//   content/posts/<slug>/images/*.png    images saved from the post
//   content/posts/_drafts/<slug>/...     drafts (left out of production builds)
//   content/pages/<slug>/index.md
//   content/site.json                    written by hand: things the export does not carry
//
// The converter drops a page's parent and menu order, the site name, the display names of
// categories and tags, and the author. `site.json` and the optional front matter fields
// `parent`, `order`, and `author` restore them.

const slug = z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits, and hyphens');

const siteSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().default(''),
  /** The old site's address. Absolute links to it inside content become local paths. */
  origin: z.url().optional(),
  author: z.string().default(''),
  categories: z.record(slug, z.string().min(1)).default({}),
  tags: z.record(slug, z.string().min(1)).default({}),
});

// The converter writes a YAML date. Quoted (`--quote-date=true`) it stays a string with the site's
// own offset, so the local date that WordPress used for the permalink is kept. Unquoted, YAML turns
// it into a UTC Date, which is correct only for a site whose timezone is UTC.
const date = z.union([z.date(), z.string()]).transform((value, context) => {
  const text = value instanceof Date ? value.toISOString() : value;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(text) ?? /^(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (!local) {
    context.addIssue({ code: 'custom', message: `not a date: ${text}` });
    return z.NEVER;
  }
  return `${local[1]}T${local[2] ?? '00:00:00'}`;
});

const postSchema = z.strictObject({
  title: z.string().min(1),
  // WordPress assigns a draft's date when it is published, so an exported draft has none.
  date: date.optional(),
  categories: z.array(slug).default([]),
  tags: z.array(slug).default([]),
  coverImage: z.string().optional(),
  coverImageAlt: z.string().optional(),
  draft: z.boolean().optional(),
  excerpt: z.string().optional(),
  author: z.string().optional(),
});

const pageSchema = z.strictObject({
  title: z.string().min(1),
  date: date.optional(),
  parent: slug.optional(),
  order: z.number().int().default(0),
  excerpt: z.string().optional(),
  draft: z.boolean().optional(),
});

async function entries(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readItem<T extends z.ZodType>(file: string, schema: T): Promise<{ data: z.infer<T>; body: string }> {
  const parsed = matter(await readFile(file, 'utf8'));
  const result = schema.safeParse(parsed.data);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(front matter)'}: ${issue.message}`);
    throw new Error(`${file}: ${issues.join('; ')}`);
  }
  return { data: result.data, body: parsed.content };
}

/** The first paragraph of the body as plain text, which is what WordPress uses for an empty excerpt. */
function excerptOf(html: string): string {
  const first = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
  return htmlToText(first);
}

interface Content { root: string; outDirectory: string; includeDrafts: boolean }

export async function snapshotFromMarkdown({ root, outDirectory, includeDrafts }: Content): Promise<Snapshot> {
  let siteText: string;
  try {
    siteText = await readFile(join(root, 'site.json'), 'utf8');
  } catch {
    throw new Error(`${join(root, 'site.json')} is missing. Create it with at least {"name": "..."}; see the README.`);
  }
  const site = siteSchema.parse(JSON.parse(siteText));
  const termOf = (names: Record<string, string>) => (value: string): Term => ({ slug: value, name: names[value] ?? value });

  const copies: Array<{ from: string; to: string }> = [];
  const publish = (file: string, urlPath: string) => copies.push({ from: file, to: join(outDirectory, urlPath) });

  // Pass 1: front matter, so every permalink is known before bodies are rendered.
  type Draft = { kind: 'post'; folder: string; data: z.infer<typeof postSchema> & { date: string }; body: string; path: string; slug: string }
    | { kind: 'page'; folder: string; data: z.infer<typeof pageSchema>; body: string; path: string; slug: string };
  const items: Draft[] = [];
  const seen = new Map<string, string>();
  const claim = (path: string, folder: string) => {
    const other = seen.get(path);
    if (other) throw new Error(`${folder} and ${other} both produce ${path}`);
    seen.set(path, folder);
  };

  const postFolders = [
    ...(await entries(join(root, 'posts'))).filter((name) => name !== '_drafts').map((name) => join(root, 'posts', name)),
    ...(includeDrafts ? (await entries(join(root, 'posts', '_drafts'))).map((name) => join(root, 'posts', '_drafts', name)) : []),
  ];
  for (const folder of postFolders) {
    const name = slug.parse(folder.split('/').pop());
    const { data, body } = await readItem(join(folder, 'index.md'), postSchema);
    if (data.draft && !includeDrafts) continue;
    if (!data.date) {
      if (!data.draft) throw new Error(`${join(folder, 'index.md')}: date: a published post needs a date`);
      console.warn(`wordpress: skipped draft ${name}, it has no date (add one to preview it)`);
      continue;
    }
    const path = postPath({ date: data.date, slug: name });
    claim(path, folder);
    items.push({ kind: 'post', folder, data: { ...data, date: data.date }, body, path, slug: name });
  }
  for (const name of await entries(join(root, 'pages'))) {
    const folder = join(root, 'pages', name);
    const { data, body } = await readItem(join(folder, 'index.md'), pageSchema);
    if (data.draft && !includeDrafts) continue;
    const path = pagePath({ slug: slug.parse(name), parent: data.parent });
    claim(path, folder);
    items.push({ kind: 'page', folder, data, body, path, slug: name });
  }
  const permalinks = new Map(items.map((item) => [item.path, item.path]));
  const pageSlugs = new Set(items.filter((item) => item.kind === 'page').map((item) => item.slug));
  for (const item of items) {
    if (item.kind === 'page' && item.data.parent && !pageSlugs.has(item.data.parent)) {
      throw new Error(`${item.folder}: parent "${item.data.parent}" is not a page in content/pages/`);
    }
  }

  // Pass 2: bodies. Images beside a post are published under the post's own URL.
  const render = (item: Draft): string => {
    const html = marked.parse(item.body, { async: false, gfm: true });
    return sanitizeContent(html, (url, kind) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) {
        if (!site.origin) return undefined;
        let parsed: URL;
        try { parsed = new URL(url); } catch { return undefined; }
        if (parsed.origin !== new URL(site.origin).origin) return undefined;
        return (permalinks.get(parsed.pathname) ?? parsed.pathname) + parsed.search + parsed.hash;
      }
      if (kind !== 'image') return undefined;
      const relative = posix.normalize(decodeURIComponent(url));
      if (relative.startsWith('..')) throw new Error(`${item.folder}: image ${url} is outside the post folder`);
      const urlPath = `${item.path}${relative}`;
      publish(join(item.folder, relative), urlPath);
      return urlPath;
    });
  };

  const posts: Post[] = [];
  const pages: Page[] = [];
  for (const item of items) {
    const html = render(item);
    if (item.kind === 'post') {
      let featured: Image | undefined;
      if (item.data.coverImage) {
        const file = join(item.folder, 'images', item.data.coverImage);
        const size = imageSize(await readFile(file));
        const urlPath = `${item.path}images/${item.data.coverImage}`;
        publish(file, urlPath);
        featured = { src: urlPath, width: size.width, height: size.height, alt: item.data.coverImageAlt ?? '' };
      }
      posts.push({
        slug: item.slug,
        title: item.data.title,
        date: item.data.date,
        excerpt: item.data.excerpt ?? excerptOf(html),
        html,
        author: item.data.author ?? site.author,
        categories: item.data.categories.map(termOf(site.categories)),
        tags: item.data.tags.map(termOf(site.tags)),
        featured,
      });
    } else {
      pages.push({
        slug: item.slug,
        parent: item.data.parent,
        title: item.data.title,
        excerpt: item.data.excerpt ?? excerptOf(html),
        html,
        order: item.data.order,
      });
    }
  }

  for (const { from, to } of copies) {
    await mkdir(dirname(to), { recursive: true });
    try {
      await copyFile(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The converter keeps the image link even when the download failed.
      throw new Error(`${from} is missing. The converter could not save it; add the file or remove the image from the post.`);
    }
  }
  return { source: 'markdown', site: { name: site.name, description: site.description }, posts, pages };
}
