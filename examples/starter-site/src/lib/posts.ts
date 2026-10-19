// src/lib/posts.ts: the one place that reads, validates, and sorts Markdown posts from content/posts/.
// The blog index, post pages, tag pages, the home page, and the feed all call getPosts(), so they always agree.
//
// Requires: npm install marked
// Posts live in content/posts/<slug>.md with front matter:
//
//   ---
//   title: Hello, world
//   description: One sentence for listings, search results, and social cards.
//   date: 2026-01-15
//   updated: 2026-02-01      (optional)
//   tags: [news, release]    (optional)
//   draft: true              (optional: shown by the dev server, left out of bascik --build)
//   ---
//
// Pages that call this helper read a directory, which the build script cache cannot see. Exclude them from the
// cache and watch content/ (see this example's bascik.config.ts).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { marked } from "marked";

export const POSTS_DIR = "content/posts";

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD). Strings, not Date objects, so posts survive JSON in dynamic routes. */
  date: string;
  updated?: string;
  tags: string[];
  draft: boolean;
  /** Rendered HTML of the Markdown body. */
  html: string;
}

type FrontMatterValue = string | boolean | number | string[];

/**
 * Parse a front matter block of `key: value` lines. Supports quoted strings, booleans, numbers, inline lists
 * (`[a, b]`), and dash lists. Use gray-matter instead if posts need nested YAML.
 */
export function parseFrontMatter(source: string): {
  data: Record<string, FrontMatterValue>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, FrontMatterValue> = {};
  let listKey: string | undefined;
  const scalar = (raw: string): string | boolean | number => {
    const value = raw.trim();
    if (/^".*"$/.test(value)) return JSON.parse(value) as string;
    if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
    if (value === "true" || value === "false") return value === "true";
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
  };
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(String(scalar(item[1])));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`unreadable front matter line: ${line}`);
    const [, key, value] = pair;
    listKey = undefined;
    if (value === "") {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value.trim())) {
      const inner = value.trim().slice(1, -1).trim();
      data[key] = inner
        ? inner.split(",").map((part) => String(scalar(part)))
        : [];
    } else {
      data[key] = scalar(value);
    }
  }
  return { data, body: source.slice(match[0].length) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate one post's front matter. Throws with the file name so a bad post fails the build loudly. */
export function toPost(slug: string, source: string): Post {
  const where = `${POSTS_DIR}/${slug}.md`;
  if (!SLUG.test(slug))
    throw new Error(
      `${where}: file names must be lowercase words joined by hyphens (they become URLs)`,
    );
  const { data, body } = parseFrontMatter(source);
  const text = (key: string) =>
    typeof data[key] === "string" ? (data[key] as string).trim() : "";
  const title = text("title");
  const description = text("description");
  const date = text("date");
  const updated = text("updated") || undefined;
  if (!title) throw new Error(`${where}: front matter needs a title`);
  if (!description)
    throw new Error(`${where}: front matter needs a description`);
  const isValidIsoDate = (value: string): boolean => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return (
      ISO_DATE.test(value) &&
      !Number.isNaN(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === value
    );
  };
  if (!isValidIsoDate(date))
    throw new Error(`${where}: date must be YYYY-MM-DD`);
  if (updated && !isValidIsoDate(updated))
    throw new Error(`${where}: updated must be YYYY-MM-DD`);
  const tags = Array.isArray(data.tags)
    ? data.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
    : [];
  for (const tag of tags) {
    if (!SLUG.test(tag))
      throw new Error(
        `${where}: tag "${tag}" must be lowercase words joined by hyphens`,
      );
  }
  return {
    slug,
    title,
    description,
    date,
    updated,
    tags,
    draft: data.draft === true,
    html: marked.parse(body, { async: false }) as string,
  };
}

/** Every published post, newest first. Drafts are included only in the dev server (BASCIK_BUILD is not "1"). */
export async function getPosts(): Promise<Post[]> {
  const files = (await readdir(POSTS_DIR)).filter((file) =>
    file.endsWith(".md"),
  );
  const posts = await Promise.all(
    files.map(async (file) =>
      toPost(file.slice(0, -3), await readFile(join(POSTS_DIR, file), "utf8")),
    ),
  );
  const includeDrafts = process.env.BASCIK_BUILD !== "1";
  return posts
    .filter((post) => includeDrafts || !post.draft)
    .sort((a, b) =>
      a.date === b.date
        ? a.slug.localeCompare(b.slug)
        : a.date < b.date
          ? 1
          : -1,
    );
}

/** Tags with their posts, sorted by name. */
export function groupByTag(
  posts: Post[],
): Array<{ tag: string; posts: Post[] }> {
  const map = new Map<string, Post[]>();
  for (const post of posts)
    for (const tag of post.tags) map.set(tag, [...(map.get(tag) ?? []), post]);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, list]) => ({ tag, posts: list }));
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for HTML content and quoted attributes. Use it on every value you interpolate. */
export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ENTITIES[ch]);

/** "January 15, 2026" for display. UTC, so the date never shifts with the build machine's time zone. */
export const formatDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  });

/** A post list as HTML. Classes are global unless the calling component's CSS defines them. */
export function postList(posts: Post[]): string {
  if (posts.length === 0) return "<p>No posts yet.</p>";
  const items = posts.map(
    (post) => `<li>
  <a href="/blog/${post.slug}/">${escapeHtml(post.title)}</a>
  <time datetime="${post.date}">${formatDate(post.date)}</time>
  <p>${escapeHtml(post.description)}</p>
</li>`,
  );
  return `<ul class="post-list">\n${items.join("\n")}\n</ul>`;
}
