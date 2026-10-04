import type { Post } from "../interfaces/post.ts";
import fs from "node:fs";
import matter from "gray-matter";
import { join } from "node:path";
import { z } from "zod";

// Adapted from the upstream src/lib/api.ts. Differences: helper-to-helper imports are relative
// with explicit extensions (Node runs this file directly; tsconfig `paths` do not apply), only
// `.md` files count as posts, and front matter is validated so a broken post fails the build
// with its file name instead of rendering `undefined`.

const postsDirectory = join(process.cwd(), "_posts");

const frontMatter = z.object({
  title: z.string().min(1),
  excerpt: z.string(),
  coverImage: z.string().startsWith("/"),
  date: z.iso.datetime(),
  author: z.object({ name: z.string().min(1), picture: z.string().startsWith("/") }),
  ogImage: z.object({ url: z.string().startsWith("/") }),
});

export function getPostSlugs() {
  return fs.readdirSync(postsDirectory).filter((file) => file.endsWith(".md"));
}

export function getPostBySlug(slug: string): Post {
  const realSlug = slug.replace(/\.md$/, "");
  const fullPath = join(postsDirectory, `${realSlug}.md`);
  const fileContents = fs.readFileSync(fullPath, "utf8");
  const { data, content } = matter(fileContents);
  const parsed = frontMatter.safeParse(data);
  if (!parsed.success) {
    throw new Error(`_posts/${realSlug}.md: ${z.prettifyError(parsed.error)}`);
  }
  return { ...parsed.data, slug: realSlug, content };
}

export function getAllPosts(): Post[] {
  const slugs = getPostSlugs();
  const posts = slugs
    .map((slug) => getPostBySlug(slug))
    // sort posts by date in descending order; equal dates fall back to the slug so the order
    // never depends on the file system
    .sort((post1, post2) => post2.date.localeCompare(post1.date) || post1.slug.localeCompare(post2.slug));
  return posts;
}
