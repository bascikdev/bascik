import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

// Equivalent of the upstream `content.config.ts` collection schema. Bascik has no
// content-collection feature, so a build helper validates front matter itself.
const schema = z.object({
  title: z.string(),
  description: z.string(),
  // gray-matter parses unquoted YAML dates into Date values, quoted ones stay strings.
  pubDate: z.coerce.date(),
  updatedDate: z.coerce.date().optional(),
  heroImage: z.string().optional(),
});

export type PostData = z.infer<typeof schema>;
export interface Post {
  id: string;
  data: PostData;
  body: string;
}

const CONTENT_DIRECTORY = join(process.cwd(), 'content/blog');

export async function getPosts(): Promise<Post[]> {
  const files = (await readdir(CONTENT_DIRECTORY)).filter((name) => name.endsWith('.md')).sort();
  const posts: Post[] = [];
  for (const file of files) {
    const parsed = matter(await readFile(join(CONTENT_DIRECTORY, file), 'utf8'));
    const result = schema.safeParse(parsed.data);
    if (!result.success) {
      throw new Error(`Invalid front matter in content/blog/${file}: ${z.prettifyError(result.error)}`);
    }
    posts.push({ id: file.replace(/\.md$/, ''), data: result.data, body: parsed.content });
  }
  return posts;
}

// Newest first, the order the upstream blog index uses.
export async function getSortedPosts(): Promise<Post[]> {
  return (await getPosts()).sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export async function getPost(id: string): Promise<Post> {
  const post = (await getPosts()).find((entry) => entry.id === id);
  if (!post) throw new Error(`No post with id "${id}" in content/blog`);
  return post;
}
