/**
 * @module templates/blog/lib
 *
 * The blog template's TypeScript: the project config, the modules in `src/lib/` that read the posts and build
 * head tags and the feed, the exec script that writes the feed, and their tests. This is the layout the docs
 * recommend for a Markdown collection (docs/content/how-to/markdown.md, "Building a Content Collection", and
 * the "Blogs and Markdown collections" rules in skills/bascik-scripts/SKILL.md).
 */

/**
 * `src/lib/site.ts`: the one file that holds the site's name. Every page, the header, the footer and the feed
 * read it from there and print it through `html` or `esc`, so the name is written as a string literal here
 * and escaped where it lands, whatever characters it has.
 */
export const siteModule = (
  siteName: string,
): string => `// src/lib/site.ts: the site's identity. The header, the footer, every page's head tags, and the feed read it from
// here, so a new name or description is one edit.
export const SITE = {
  name: ${JSON.stringify(siteName)},
  /** A few words after the name in the home page's title. */
  tagline: "Notes on novels and the people who write them",
  /** One or two sentences: the home page's introduction and description, and the feed's subtitle. */
  description:
    "Reviews of short novels, reading lists, and notes on the habits that get a book finished.",
} as const;
`;

/** `bascik.config.ts`: watch the posts, keep the pages that list them out of the build script cache, and run the feed script after each build. */
export const BASCIK_CONFIG = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // Rebuild pages in the dev server when a post or a shared helper changes.
    watchPaths: ["content/", "src/lib/"],
    // Reads the posts and writes feed.xml into the finished output, so it runs after compilation.
    exec: [{ script: "scripts/feed.ts", phase: "post", watch: ["content/"] }],
  },
  scripts: {
    cache: {
      // These scripts call getPosts(), which reads a folder. The build script cache keys on files a script names
      // literally, so it cannot see a new or edited post. Exclude everything that lists or renders posts.
      exclude: [
        "src/pages/blog/**",
        "src/components/latest-posts/**",
        "src/components/post-list/**",
      ],
    },
  },
});
`;

/** `src/lib/posts.ts`: the only code that reads `content/posts/`. A post with missing or malformed front matter throws an error naming its file, which fails `bascik --build`. */
export const POSTS_TS = `// src/lib/posts.ts: the one place that reads, validates, and sorts the Markdown posts in content/posts/.
// The home page, the post list, the post and tag pages, and the feed all call getPosts(), so they always agree.
//
// A post is content/posts/<slug>.md, and its file name is its URL (/blog/<slug>/). It starts with front matter:
//
//   ---
//   title: The Second Chapter Problem
//   description: One or two sentences for the post list, search results, and the feed.
//   date: 2026-10-28
//   author: Maren Okafor
//   tags: [craft, reviews]   (optional)
//   draft: true              (optional: shown by the dev server, left out of bascik --build)
//   ---
//
// A post with a missing or unreadable field throws an error that names the file, so it fails the build
// instead of publishing a broken page.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { html, type SafeHtml } from "@bascik/bascik/html";
import { marked } from "marked";

export const POSTS_DIR = "content/posts";

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD). A string, not a Date, so a post survives the JSON a dynamic route carries it in. */
  date: string;
  author: string;
  tags: string[];
  draft: boolean;
  /** The Markdown body, rendered to HTML. */
  html: string;
}

type FrontMatterValue = string | boolean | number | string[];

/**
 * Parse a front matter block of \`key: value\` lines: quoted strings, booleans, numbers, inline lists (\`[a, b]\`),
 * and dash lists. Use the gray-matter package instead when posts need nested YAML.
 */
export function parseFrontMatter(source: string): {
  data: Record<string, FrontMatterValue>;
  body: string;
} {
  const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/.exec(source);
  if (!match) {
    if (/^---\\r?\\n/.test(source))
      throw new Error("front matter is not closed with a --- line");
    return { data: {}, body: source };
  }
  const data: Record<string, FrontMatterValue> = {};
  let listKey: string | undefined;
  const scalar = (raw: string): string | boolean | number => {
    const value = raw.trim();
    if (/^".*"$/.test(value)) return JSON.parse(value) as string;
    if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
    if (value === "true" || value === "false") return value === "true";
    if (/^-?\\d+(\\.\\d+)?$/.test(value)) return Number(value);
    return value;
  };
  for (const line of match[1].split(/\\r?\\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^\\s+-\\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(String(scalar(item[1])));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\\s*(.*)$/.exec(line);
    if (!pair) throw new Error(\`unreadable front matter line: \${line}\`);
    const [, key, value] = pair;
    listKey = undefined;
    if (value === "") {
      data[key] = [];
      listKey = key;
    } else if (/^\\[.*\\]$/.test(value.trim())) {
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

const ISO_DATE = /^\\d{4}-\\d{2}-\\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isIsoDate = (value: string): boolean => {
  const parsed = Date.parse(\`\${value}T00:00:00Z\`);
  return (
    ISO_DATE.test(value) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
};

/** Validate one post. Every error starts with the file name, so a bad post fails the build and says where. */
export function toPost(slug: string, source: string): Post {
  const where = \`\${POSTS_DIR}/\${slug}.md\`;
  if (!SLUG.test(slug))
    throw new Error(
      \`\${where}: file names must be lowercase words joined by hyphens (they become URLs)\`,
    );
  let parsed: ReturnType<typeof parseFrontMatter>;
  try {
    parsed = parseFrontMatter(source);
  } catch (err) {
    throw new Error(\`\${where}: \${(err as Error).message}\`);
  }
  const { data, body } = parsed;
  const text = (key: string): string =>
    typeof data[key] === "string" ? (data[key] as string).trim() : "";
  for (const key of ["title", "description", "author"])
    if (!text(key)) throw new Error(\`\${where}: front matter needs \${key}\`);
  const date = text("date");
  if (!isIsoDate(date))
    throw new Error(
      \`\${where}: front matter needs date as YYYY-MM-DD\${date ? \`, not "\${date}"\` : ""}\`,
    );
  const tags = Array.isArray(data.tags)
    ? data.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
    : [];
  for (const tag of tags)
    if (!SLUG.test(tag))
      throw new Error(
        \`\${where}: tag "\${tag}" must be lowercase words joined by hyphens (it becomes a URL)\`,
      );
  return {
    slug,
    title: text("title"),
    description: text("description"),
    date,
    author: text("author"),
    tags,
    draft: data.draft === true,
    html: marked.parse(body, { async: false }) as string,
  };
}

/** Newest first; posts from the same day sort by file name, so the order never depends on the file system. */
export const byNewest = (a: Post, b: Post): number =>
  a.date === b.date ? a.slug.localeCompare(b.slug) : a.date < b.date ? 1 : -1;

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
  return posts.filter((post) => includeDrafts || !post.draft).sort(byNewest);
}

/** Tags with their posts, sorted by name. */
export function groupByTag(
  posts: Post[],
): Array<{ tag: string; posts: Post[] }> {
  const groups = new Map<string, Post[]>();
  for (const post of posts)
    for (const tag of post.tags)
      groups.set(tag, [...(groups.get(tag) ?? []), post]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, list]) => ({ tag, posts: list }));
}

/** Years with their posts, in the order the posts came in. */
export function groupByYear(
  posts: Post[],
): Array<{ year: string; posts: Post[] }> {
  const groups = new Map<string, Post[]>();
  for (const post of posts) {
    const year = post.date.slice(0, 4);
    groups.set(year, [...(groups.get(year) ?? []), post]);
  }
  return [...groups.entries()].map(([year, list]) => ({ year, posts: list }));
}

/** "October 28, 2026" for display. UTC, so the date never shifts with the build machine's time zone. */
export const formatDate = (iso: string): string =>
  new Date(\`\${iso}T00:00:00Z\`).toLocaleDateString("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  });

/** The URL path of a post, relative to the site's base. */
export const postPath = (post: Pick<Post, "slug">): string =>
  \`/blog/\${post.slug}/\`;

/**
 * A list of <post-card> tags, one per post. Bascik expands the tags after the build script returns them, and
 * html escapes every front matter value into its prop.
 */
export function postCards(posts: Post[]): SafeHtml {
  if (posts.length === 0) return html\`<p>No posts yet.</p>\`;
  const cards = posts.map(
    (post) =>
      html\`<li>
        <post-card
          data-bascik-prop-title="\${post.title}"
          data-bascik-prop-href="\${postPath(post)}"
          data-bascik-prop-date="\${post.date}"
          data-bascik-prop-shown="\${formatDate(post.date)}"
          data-bascik-prop-author="\${post.author}"
          data-bascik-prop-description="\${post.description}"
        ></post-card>
      </li>\`,
  );
  return html\`<ul class="post-cards">
    \${cards}
  </ul>\`;
}
`;

export const POSTS_TEST = `import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import {
  POSTS_DIR,
  formatDate,
  getPosts,
  groupByTag,
  groupByYear,
  parseFrontMatter,
  postCards,
  toPost,
} from "./posts.ts";

const post = (frontMatter: string, body = "Body text."): string =>
  \`---\\n\${frontMatter}\\n---\\n\\n\${body}\\n\`;

const VALID = [
  "title: The Second Chapter Problem",
  "description: Where a novel decides whether you will finish it.",
  "date: 2026-10-28",
  "author: Maren Okafor",
].join("\\n");

describe("toPost", () => {
  it("reads the front matter and renders the Markdown body", () => {
    const result = toPost(
      "second-chapter",
      post(\`\${VALID}\\ntags: [Craft, reviews]\`, "A **bold** claim."),
    );
    expect(result).toMatchObject({
      slug: "second-chapter",
      title: "The Second Chapter Problem",
      date: "2026-10-28",
      author: "Maren Okafor",
      tags: ["craft", "reviews"],
      draft: false,
    });
    expect(result.html).toContain("<strong>bold</strong>");
  });

  it("keeps a colon and quotes inside a value", () => {
    const result = toPost(
      "quoted",
      post(
        VALID.replace(
          "title: The Second Chapter Problem",
          'title: "Low Tide: a \\\\"quiet\\\\" novel"',
        ),
      ),
    );
    expect(result.title).toBe('Low Tide: a "quiet" novel');
  });

  it.each(["title", "description", "author", "date"])(
    "names the file when %s is missing",
    (field) => {
      const lines = VALID.split("\\n").filter(
        (line) => !line.startsWith(\`\${field}:\`),
      );
      expect(() => toPost("no-field", post(lines.join("\\n")))).toThrow(
        new RegExp(\`^content/posts/no-field\\\\.md: front matter needs \${field}\`),
      );
    },
  );

  it("names the file when there is no front matter at all", () => {
    expect(() => toPost("bare", "Just a paragraph.\\n")).toThrow(
      "content/posts/bare.md: front matter needs title",
    );
  });

  it("names the file when the front matter is never closed", () => {
    expect(() => toPost("open", \`---\\n\${VALID}\\n\\nBody.\\n\`)).toThrow(
      "content/posts/open.md: front matter is not closed with a --- line",
    );
  });

  it("names the file and the line when a front matter line is not key: value", () => {
    expect(() => toPost("typo", post(\`\${VALID}\\ntags [craft]\`))).toThrow(
      "content/posts/typo.md: unreadable front matter line: tags [craft]",
    );
  });

  it.each(["28 October 2026", "2026-13-01", "2026-02-30", "2026-1-5"])(
    "refuses the date %s",
    (date) => {
      expect(() =>
        toPost("bad-date", post(VALID.replace("2026-10-28", date))),
      ).toThrow(
        \`content/posts/bad-date.md: front matter needs date as YYYY-MM-DD, not "\${date}"\`,
      );
    },
  );

  it("refuses a file name or a tag that would not make a clean URL", () => {
    expect(() => toPost("My Post", post(VALID))).toThrow(
      "content/posts/My Post.md: file names must be lowercase words joined by hyphens",
    );
    expect(() =>
      toPost("spaced-tag", post(\`\${VALID}\\ntags: [book reviews]\`)),
    ).toThrow('content/posts/spaced-tag.md: tag "book reviews"');
  });
});

describe("parseFrontMatter", () => {
  it("reads dash lists, booleans, and Windows line endings", () => {
    const { data, body } = parseFrontMatter(
      "---\\r\\ntitle: Low Tide\\r\\ndraft: true\\r\\ntags:\\r\\n  - craft\\r\\n  - authors\\r\\n---\\r\\nBody\\r\\n",
    );
    expect(data).toEqual({
      title: "Low Tide",
      draft: true,
      tags: ["craft", "authors"],
    });
    expect(body).toBe("Body\\r\\n");
  });
});

describe("getPosts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns every post in content/posts, newest first", async () => {
    const posts = await getPosts();
    const files = readdirSync(POSTS_DIR).filter((file) => file.endsWith(".md"));
    expect(posts).toHaveLength(files.length);
    const dates = posts.map((entry) => entry.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("leaves drafts out of a production build only", async () => {
    vi.stubEnv("BASCIK_BUILD", "1");
    const built = await getPosts();
    expect(built.every((entry) => !entry.draft)).toBe(true);
  });
});

describe("grouping and display", () => {
  const sample = [
    toPost("b", post(\`\${VALID}\\ntags: [craft]\`)),
    toPost("a", post(\`\${VALID.replace("2026", "2025")}\\ntags: [authors, craft]\`)),
  ];

  it("groups by tag in name order and by year in the order given", () => {
    expect(
      groupByTag(sample).map((group) => [group.tag, group.posts.length]),
    ).toEqual([
      ["authors", 1],
      ["craft", 2],
    ]);
    expect(groupByYear(sample).map((group) => group.year)).toEqual([
      "2026",
      "2025",
    ]);
  });

  it("formats a date in UTC, whatever the machine's time zone", () => {
    expect(formatDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("escapes front matter values in the cards it prints", () => {
    const cards = String(
      postCards([
        toPost(
          "markup",
          post(
            VALID.replace(
              "The Second Chapter Problem",
              '<script>alert("x")</script> & Sons',
            ),
          ),
        ),
      ]),
    );
    expect(cards).not.toContain("<script>");
    expect(cards).toContain("&lt;script&gt;");
    expect(cards).toContain("&amp; Sons");
    expect(cards).toContain('data-bascik-prop-href="/blog/markup/"');
  });

  it("says so when there are no posts", () => {
    expect(String(postCards([]))).toContain("No posts yet.");
  });
});
`;

/** `src/lib/seo.ts`: the per-page head tags (title, description, canonical, Open Graph) and a post's JSON-LD. */
export const SEO_TS = `// src/lib/seo.ts: the head tags that differ per page. Call seo() from a build script in each page's <head>:
//
//   <script data-bascik-build type="text/typescript">
//     import { seo } from "@/lib/seo.ts";
//     export default () => seo({ title: "About", description: "Who writes this blog and why." });
//   </script>
//
// Absolute URLs come from BASCIK_SITE_URL (set it per deployment or in .env) and BASCIK_BASE, never from a
// domain written here. The tags are built with html from @bascik/bascik/html, which escapes every value for
// where it lands, so a title from a post's front matter is safe to pass in.
import { html, json, type SafeHtml } from "@bascik/bascik/html";
import { SITE } from "./site.ts";

export interface SeoOptions {
  /** The page's own title; the site name is added after it. Leave it out on the home page. */
  title?: string;
  /** One or two sentences for search results, roughly 50 to 160 characters. */
  description: string;
  /** "article" for a post, otherwise "website". */
  type?: "website" | "article";
  /** A post's date (YYYY-MM-DD). */
  publishedTime?: string;
  /** A post's author. */
  author?: string;
  /**
   * Keep the page out of search results. A page that is not the 404 page also needs
   * <meta name="bascik-sitemap" content="exclude" /> written in its source to leave sitemap.xml.
   */
  noindex?: boolean;
}

/** The site's origin without a trailing slash, or undefined when BASCIK_SITE_URL is not set (the dev server). */
export const siteUrl = (): string | undefined =>
  process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "") || undefined;

/**
 * The absolute URL of a site path such as "/blog/", with the deployment base. Without a site URL the result is
 * the root-relative path.
 */
export function absoluteUrl(path: string): string {
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  return \`\${siteUrl() ?? ""}\${base}\${path.startsWith("/") ? path : \`/\${path}\`}\`;
}

/** "About - My Blog", or the site name and its tagline for the home page. */
export const pageTitle = (title?: string): string =>
  title ? \`\${title} - \${SITE.name}\` : \`\${SITE.name} - \${SITE.tagline}\`;

/** The title, description, canonical URL, and Open Graph tags for the page being built. */
export function seo(options: SeoOptions): SafeHtml {
  const title = pageTitle(options.title);
  // A canonical URL must be absolute, so it is written only when the site URL is known.
  const url = siteUrl()
    ? absoluteUrl(process.env.BASCIK_PAGE_PATH || "/")
    : undefined;
  const tags = [
    html\`<title>\${title}</title>\`,
    html\`<meta name="description" content="\${options.description}" />\`,
    options.noindex ? html\`<meta name="robots" content="noindex" />\` : "",
    url ? html\`<link rel="canonical" href="\${url}" />\` : "",
    html\`<meta property="og:type" content="\${options.type ?? "website"}" />\`,
    html\`<meta property="og:title" content="\${title}" />\`,
    html\`<meta property="og:description" content="\${options.description}" />\`,
    url ? html\`<meta property="og:url" content="\${url}" />\` : "",
    html\`<meta property="og:site_name" content="\${SITE.name}" />\`,
    options.publishedTime
      ? html\`<meta
          property="article:published_time"
          content="\${options.publishedTime}"
        />\`
      : "",
    options.author
      ? html\`<meta property="article:author" content="\${options.author}" />\`
      : "",
    html\`<meta name="twitter:card" content="summary" />\`,
  ].filter((tag) => tag !== "");
  // An array of html values is inserted as it is, with no separator and no .join("").
  return html\`\${tags}\`;
}

/**
 * BlogPosting structured data for a post page. json() writes <, > and & as JSON escapes, so a title can never
 * close the script tag early.
 */
export function articleJsonLd(post: {
  title: string;
  description: string;
  date: string;
  author: string;
}): SafeHtml {
  const data = json({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    author: { "@type": "Person", name: post.author },
  });
  return html\`<script type="application/ld+json">
    \${data}
  </script>\`;
}
`;

export const SEO_TEST = `import { afterEach, describe, expect, it, vi } from "vitest";
import { absoluteUrl, articleJsonLd, pageTitle, seo } from "./seo.ts";
import { SITE } from "./site.ts";

describe("seo", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("writes the title, description, canonical URL, and Open Graph tags for the page being built", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/blog/low-tide/");
    const tags = String(
      seo({
        title: "Low Tide",
        description: "A review of the first Harbor Quartet novel.",
        type: "article",
        publishedTime: "2026-08-02",
        author: "Maren Okafor",
      }),
    );
    expect(tags).toContain(\`<title>\${pageTitle("Low Tide")}</title>\`);
    expect(tags).toContain(
      '<link rel="canonical" href="https://example.com/blog/low-tide/" />',
    );
    expect(tags).toContain('property="og:type" content="article"');
    expect(tags).toContain(
      'property="og:url" content="https://example.com/blog/low-tide/"',
    );
    expect(tags).toContain('content="2026-08-02"');
    expect(tags).toContain('property="article:author" content="Maren Okafor"');
  });

  it("uses the site name and tagline as the home page title", () => {
    expect(pageTitle()).toBe(\`\${SITE.name} - \${SITE.tagline}\`);
    expect(pageTitle("About")).toBe(\`About - \${SITE.name}\`);
  });

  it("writes no canonical URL without a site URL, because it would not be absolute", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    const tags = String(seo({ description: "The home page." }));
    expect(tags).not.toContain("canonical");
    expect(tags).not.toContain("og:url");
  });

  it("escapes a title and a description taken from a post", () => {
    const tags = String(
      seo({
        title: '</title><script>alert("x")</script>',
        description: 'Tom & "Runa" <3',
      }),
    );
    expect(tags).not.toContain("<script>");
    expect(tags).toContain("&lt;script&gt;");
    expect(tags).toContain("Tom &amp; &quot;Runa&quot; &lt;3");
  });

  it("marks a page noindex only when asked", () => {
    expect(String(seo({ description: "x", noindex: true }))).toContain(
      '<meta name="robots" content="noindex" />',
    );
    expect(String(seo({ description: "x" }))).not.toContain("noindex");
  });
});

describe("absoluteUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds the site URL and the deployment base", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    vi.stubEnv("BASCIK_BASE", "/books/");
    expect(absoluteUrl("/blog/")).toBe("https://example.com/books/blog/");
  });
});

describe("articleJsonLd", () => {
  it("cannot be closed early by a title", () => {
    const block = String(
      articleJsonLd({
        title: "</script><script>alert(1)</script>",
        description: "A description.",
        date: "2026-08-02",
        author: "Maren Okafor",
      }),
    );
    expect(block.match(/<\\/script>/g)).toHaveLength(1);
    expect(block).toContain('"@type":"BlogPosting"');
  });
});
`;

/** `src/lib/feed.ts`: the Atom feed as a string, kept apart from the exec script so the project's tests can call it. */
export const FEED_TS = `// src/lib/feed.ts: the Atom feed as a string. scripts/feed.ts writes it to feed.xml after each build.
//
// A feed is XML, not HTML, so it is built as a string and not with html. esc() from @bascik/bascik/html escapes
// & < > " and ', which is what XML text and attribute values need, so there is no escaper to write here.
import { esc } from "@bascik/bascik/html";
import { postPath, type Post } from "./posts.ts";
import { SITE } from "./site.ts";

/** How many posts the feed carries, newest first. */
export const FEED_SIZE = 20;

/**
 * An Atom 1.0 feed of the newest posts. \`siteUrl\` is the site's origin and \`base\` its deployment base ("/" at
 * the root of the domain): a feed reader needs absolute URLs. An empty \`siteUrl\` gives root-relative ones,
 * which scripts/feed.ts allows only in the dev server.
 */
export function atomFeed(
  posts: Post[],
  { siteUrl, base = "/" }: { siteUrl: string; base?: string },
): string {
  const root = \`\${siteUrl.replace(/\\/+$/, "")}\${base.replace(/\\/$/, "")}\`;
  const url = (path: string): string => esc(\`\${root}\${path}\`);
  const stamp = (date: string): string => \`\${date}T00:00:00Z\`;
  const newest = posts.slice(0, FEED_SIZE);
  const updated = newest.map((post) => post.date).sort().at(-1) ?? "1970-01-01";
  const entries = newest.map(
    (post) => \`  <entry>
    <title>\${esc(post.title)}</title>
    <link href="\${url(postPath(post))}" />
    <id>\${url(postPath(post))}</id>
    <published>\${stamp(post.date)}</published>
    <updated>\${stamp(post.date)}</updated>
    <author><name>\${esc(post.author)}</name></author>
    <summary>\${esc(post.description)}</summary>
    <content type="html">\${esc(post.html)}</content>
  </entry>\`,
  );
  return \`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>\${esc(SITE.name)}</title>
  <subtitle>\${esc(SITE.description)}</subtitle>
  <link href="\${url("/")}" />
  <link rel="self" type="application/atom+xml" href="\${url("/feed.xml")}" />
  <id>\${url("/")}</id>
  <updated>\${stamp(updated)}</updated>
\${entries.join("\\n")}
</feed>
\`;
}
`;

export const FEED_TEST = `import { describe, expect, it } from "vitest";
import { FEED_SIZE, atomFeed } from "./feed.ts";
import { toPost, type Post } from "./posts.ts";

const post = (slug: string, date: string, title = "Low Tide"): Post =>
  toPost(
    slug,
    \`---\\ntitle: \${title}\\ndescription: A description.\\ndate: \${date}\\nauthor: Maren Okafor\\n---\\n\\nBody with <em>markup</em> & more.\\n\`,
  );

describe("atomFeed", () => {
  it("lists each post with an absolute URL, its date, and its author", () => {
    const xml = atomFeed(
      [post("low-tide", "2026-08-02"), post("salt-road", "2026-06-19")],
      { siteUrl: "https://example.com/" },
    );
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<link href="https://example.com/blog/low-tide/" />');
    expect(xml).toContain("<id>https://example.com/blog/salt-road/</id>");
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://example.com/feed.xml" />',
    );
    expect(xml).toContain("<published>2026-08-02T00:00:00Z</published>");
    expect(xml).toContain("<name>Maren Okafor</name>");
    // The feed's own date is its newest post's.
    expect(xml).toContain("<updated>2026-08-02T00:00:00Z</updated>\\n  <entry>");
  });

  it("puts the deployment base in every URL", () => {
    const xml = atomFeed([post("low-tide", "2026-08-02")], {
      siteUrl: "https://example.com",
      base: "/books/",
    });
    expect(xml).toContain("https://example.com/books/blog/low-tide/");
    expect(xml).toContain("https://example.com/books/feed.xml");
  });

  it("writes root-relative URLs without a site URL, for the dev server", () => {
    const xml = atomFeed([post("low-tide", "2026-08-02")], { siteUrl: "" });
    expect(xml).toContain('<link href="/blog/low-tide/" />');
    expect(xml).toContain('href="/feed.xml"');
  });

  it("escapes titles and post HTML, so the XML stays well formed", () => {
    const xml = atomFeed([post("amp", "2026-08-02", "Tom & <Runa>")], {
      siteUrl: "https://example.com",
    });
    expect(xml).toContain("<title>Tom &amp; &lt;Runa&gt;</title>");
    expect(xml).toContain("&lt;em&gt;markup&lt;/em&gt; &amp;amp; more.");
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
  });

  it("carries only the newest posts", () => {
    const many = Array.from({ length: FEED_SIZE + 5 }, (_, index) =>
      post(\`post-\${index}\`, \`2026-01-\${String(index + 1).padStart(2, "0")}\`),
    ).reverse();
    expect(
      atomFeed(many, { siteUrl: "https://example.com" }).match(/<entry>/g),
    ).toHaveLength(FEED_SIZE);
  });

  it("is still a feed with no posts", () => {
    const xml = atomFeed([], { siteUrl: "https://example.com" });
    expect(xml).toContain("<updated>1970-01-01T00:00:00Z</updated>");
    expect(xml).not.toContain("<entry>");
  });
});
`;

/** `scripts/feed.ts`: the post-phase exec script that writes `feed.xml` into the build output. */
export const FEED_SCRIPT = `// scripts/feed.ts: write feed.xml, an Atom feed of the newest posts, into the build output. bascik.config.ts
// runs it as a post-phase exec script, after every page is written and again when a post changes in the dev server.
//
// An exec script is a plain Node module, so it imports with relative paths (the @/ alias works only inside
// <script> tags) and writes to the output folder, never to src/.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomFeed } from "../src/lib/feed.ts";
import { getPosts } from "../src/lib/posts.ts";

const outDir = process.env.BASCIK_OUT_DIR ?? "dist";
const siteUrl = process.env.BASCIK_SITE_URL ?? "";

if (!siteUrl) {
  // A feed reader needs absolute URLs, so a production build never ships a feed without them.
  if (process.env.BASCIK_BUILD === "1")
    throw new Error(
      "scripts/feed.ts: set BASCIK_SITE_URL (in the environment or .env) so feed.xml can use absolute URLs",
    );
  // The dev server usually has no site URL: write the feed anyway, so /feed.xml can be read while writing.
  console.log(
    "[feed] BASCIK_SITE_URL is not set, so the links in feed.xml are root-relative in the dev server",
  );
}

const posts = await getPosts();
await writeFile(
  join(outDir, "feed.xml"),
  atomFeed(posts, { siteUrl, base: process.env.BASCIK_BASE }),
);
console.log(\`[feed] wrote feed.xml with \${posts.length} posts\`);
`;
