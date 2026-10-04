import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Feed } from "feed";
import { getAllPosts } from "../src/lib/api.ts";
import { SITE_DESCRIPTION, SITE_TITLE } from "../src/lib/constants.ts";
import { siteOrigin } from "../src/lib/site.ts";

// The upstream root layout advertises <link rel="alternate" href="/feed.xml"> but the example has
// no route that produces it, so /feed.xml is a 404 there. This post-build step writes the feed the
// port links to. It is an addition, not a parity item.
const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error("BASCIK_OUT_DIR is required");
const origin = siteOrigin();

const feed = new Feed({
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  id: `${origin}/`,
  link: `${origin}/`,
  copyright: "",
});

const posts = getAllPosts();
for (const post of posts) {
  const link = `${origin}/posts/${post.slug}`;
  feed.addItem({
    title: post.title,
    id: link,
    link,
    description: post.excerpt,
    date: new Date(post.date),
    author: [{ name: post.author.name }],
  });
}

await mkdir(outDirectory, { recursive: true });
await writeFile(join(outDirectory, "feed.xml"), feed.rss2());
console.log(`wrote feed.xml (${posts.length} items)`);
