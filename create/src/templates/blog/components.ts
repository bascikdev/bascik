/**
 * @module templates/blog/components
 *
 * The blog template's components and their tests. The header and footer reuse the default template's
 * stylesheets; their markup differs (the blog's navigation, and the site name read from `src/lib/site.ts`).
 */

import { SITE_FOOTER_CSS, SITE_HEADER_CSS } from "../../scaffold.js";

/** Head component: charset, viewport, icons, both stylesheets and the feed link. Each page adds its own title and description with `seo()`, so there is no description here. */
export const SITE_META_HTML = `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png" />
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
<link rel="stylesheet" href="/css/styles.css" />
<link rel="stylesheet" href="/css/blog.css" />
<link rel="alternate" type="application/atom+xml" title="Posts" href="/feed.xml" />
`;

export const SITE_META_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("site-meta component", () => {
  const path = join(process.cwd(), "src/components/site-meta/site-meta.html");

  it("holds the charset, viewport, icons, stylesheets, and the feed link", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("favicon.ico");
    expect(html).toContain("favicon.svg");
    expect(html).toContain("apple-touch-icon.png");
    expect(html).toContain('href="/css/styles.css"');
    expect(html).toContain('href="/css/blog.css"');
    expect(html).toContain(
      '<link rel="alternate" type="application/atom+xml" title="Posts" href="/feed.xml" />',
    );
  });

  it("leaves the title and description to each page's seo() call", async () => {
    const html = await readFile(path, "utf8");
    expect(html).not.toContain("<title");
    expect(html).not.toContain('name="description"');
  });
});
`;

/** Sticky header: the skip link first, the site name, and the navigation with its mobile toggle. */
export const SITE_HEADER_HTML = `<style>
${SITE_HEADER_CSS}</style>
<header data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav aria-label="Main" data-testid="site-header-nav">
      <a href="/" class="logo" data-testid="site-header-logo">
        <script data-bascik-build-once type="text/typescript">
          import { html } from "@bascik/bascik/html";
          import { SITE } from "@/lib/site.ts";
          export default () => html\`\${SITE.name}\`;
        </script>
      </a>
      <button id="nav-toggle" type="button" class="toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle">
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="menu" data-testid="site-header-nav-menu">
        <li><a href="/" data-testid="site-header-home">Home</a></li>
        <li><a href="/blog/" data-testid="site-header-blog">Blog</a></li>
        <li><a href="/about" data-testid="site-header-about">About</a></li>
      </ul>
    </nav>
  </div>
</header>
<script type="text/typescript">
  const toggle = document.getElementById('nav-toggle') as HTMLButtonElement;
  const menu = document.getElementById('nav-menu') as HTMLUListElement;
  toggle.addEventListener('click', (): void => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    menu.classList.toggle('is-open');
  });
</script>
`;

export const SITE_HEADER_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("site-header component", () => {
  const path = join(
    process.cwd(),
    "src/components/site-header/site-header.html",
  );

  it("starts with the skip link, before the navigation", async () => {
    const html = await readFile(path, "utf8");
    const skip = html.indexOf('href="#main"');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(html.indexOf("<nav"));
  });

  it("links to the home page, the blog, and the about page", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/blog/"');
    expect(html).toContain('href="/about"');
    expect(html).toContain('id="nav-toggle"');
  });

  it("prints the site name from src/lib/site.ts, escaped by html", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain("data-bascik-build-once");
    expect(html).toContain('import { SITE } from "@/lib/site.ts"');
    expect(html).toContain("html\`\${SITE.name}\`");
  });
});
`;

/** Footer: the year and site name, printed once at build time, and links to the pages and the feed. */
export const SITE_FOOTER_HTML = `<style>
${SITE_FOOTER_CSS}</style>
<footer data-testid="site-footer">
  <div class="container">
    <div class="inner">
      <span class="copy">
        <script data-bascik-build-once type="text/typescript">
          import { html } from "@bascik/bascik/html";
          import { SITE } from "@/lib/site.ts";
          export default () => html\`&copy; \${new Date().getFullYear()} \${SITE.name}\`;
        </script>
      </span>
      <nav aria-label="Footer" data-testid="site-footer-nav">
        <a href="/" data-testid="site-footer-home">Home</a>
        <a href="/blog/" data-testid="site-footer-blog">Blog</a>
        <a href="/about" data-testid="site-footer-about">About</a>
        <a href="/feed.xml" data-testid="site-footer-feed">Feed</a>
      </nav>
    </div>
  </div>
</footer>
`;

export const SITE_FOOTER_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("site-footer component", () => {
  const path = join(
    process.cwd(),
    "src/components/site-footer/site-footer.html",
  );

  it("prints the year and the site name once, at build time", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain("data-bascik-build-once");
    expect(html).toContain("getFullYear");
    expect(html).toContain("SITE.name");
  });

  it("links to the pages and the feed in a labeled nav", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain('<nav aria-label="Footer"');
    for (const href of ["/", "/blog/", "/about", "/feed.xml"])
      expect(html).toContain(\`href="\${href}"\`);
  });
});
`;

/** The home page's opening: the site name as the `<h1>` and its description. */
export const SITE_INTRO_HTML = `<style>
section {
  padding: 72px 0 24px;
}
.container { max-width: 760px; margin: 0 auto; padding: 0 28px; }
h1 { margin-bottom: 12px; }
p { font-size: 1.1rem; max-width: 56ch; margin-bottom: 0; }
</style>
<section data-testid="site-intro">
  <div class="container">
    <script data-bascik-build-once type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { SITE } from "@/lib/site.ts";
      export default () => html\`<h1>\${SITE.name}</h1>
        <p>\${SITE.description}</p>\`;
    </script>
  </div>
</section>
`;

export const SITE_INTRO_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("site-intro component", () => {
  const path = join(process.cwd(), "src/components/site-intro/site-intro.html");

  it("prints the site name as the page's h1 and the description under it", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain('<section data-testid="site-intro">');
    expect(html).toContain("<h1>\${SITE.name}</h1>");
    expect(html).toContain("<p>\${SITE.description}</p>");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
`;

/** One post in a list: an `<article>` whose title, link, date, author and summary arrive as props from `postCards()` in `src/lib/posts.ts`. */
export const POST_CARD_HTML = `<style>
article {
  padding: 20px 0;
  border-bottom: 1px solid var(--border);
}
h3 { margin: 0 0 4px; font-size: 1.2rem; }
h3 a { color: var(--text); }
h3 a:hover { color: var(--accent); opacity: 1; }
.meta { margin: 0 0 8px; font-size: 0.85rem; }
.summary { margin: 0; }
</style>
<article data-testid="post-card">
  <h3><a data-bascik-attr-href="href" data-bascik-prop-title data-testid="post-card-link">Post title</a></h3>
  <p class="meta">
    <time data-bascik-attr-datetime="date" data-bascik-prop-shown>January 1, 2026</time>
    by <span data-bascik-prop-author>Author</span>
  </p>
  <p class="summary" data-bascik-prop-description>One or two sentences about the post.</p>
</article>
`;

export const POST_CARD_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { postCards, toPost } from "../../lib/posts.ts";

describe("post-card component", () => {
  const path = join(process.cwd(), "src/components/post-card/post-card.html");

  it("is an article with a linked title, a machine-readable date, an author, and a summary", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain('<article data-testid="post-card">');
    expect(html).toContain('data-bascik-attr-href="href"');
    expect(html).toContain("data-bascik-prop-title");
    expect(html).toContain('<time data-bascik-attr-datetime="date"');
    expect(html).toContain("data-bascik-prop-author");
    expect(html).toContain("data-bascik-prop-description");
  });

  it("has a receiver for every prop postCards() passes", async () => {
    const html = await readFile(path, "utf8");
    const post = toPost(
      "low-tide",
      "---\\ntitle: Low Tide\\ndescription: A review.\\ndate: 2026-08-02\\nauthor: Maren Okafor\\n---\\n\\nBody.\\n",
    );
    const passed = [
      ...String(postCards([post])).matchAll(/data-bascik-prop-([a-z]+)=/g),
    ].map((match) => match[1]);
    expect(passed).toHaveLength(6);
    for (const prop of passed)
      expect(
        html.includes(\`data-bascik-prop-\${prop}\`) ||
          html.includes(\`="\${prop}"\`),
        prop,
      ).toBe(true);
  });
});
`;

/** The home page's list of the three newest posts. Its script prints `<post-card>` tags, which Bascik expands. */
export const LATEST_POSTS_HTML = `<style>
section { padding: 24px 0 72px; }
.container { max-width: 760px; margin: 0 auto; padding: 0 28px; }
h2 { margin-bottom: 4px; }
.more { margin: 24px 0 0; }
</style>
<section aria-labelledby="latest-heading" data-testid="latest-posts">
  <div class="container">
    <h2 id="latest-heading">Latest posts</h2>
    <!-- The three newest posts, as <post-card> tags that Bascik expands. The list is the same on every page, so the script runs once. -->
    <script data-bascik-build-once type="text/typescript">
      import { getPosts, postCards } from "@/lib/posts.ts";
      export default async () => postCards((await getPosts()).slice(0, 3));
    </script>
    <p class="more"><a href="/blog/" data-testid="latest-posts-all">All posts →</a></p>
  </div>
</section>
`;

export const LATEST_POSTS_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("latest-posts component", () => {
  const path = join(
    process.cwd(),
    "src/components/latest-posts/latest-posts.html",
  );

  it("is a section named by its heading, with a link to every post", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain(
      '<section aria-labelledby="latest-heading" data-testid="latest-posts">',
    );
    expect(html).toContain('<h2 id="latest-heading">Latest posts</h2>');
    expect(html).toContain('href="/blog/"');
  });

  it("prints the three newest posts from the shared reader", async () => {
    const html = await readFile(path, "utf8");
    expect(html).toContain(
      'import { getPosts, postCards } from "@/lib/posts.ts"',
    );
    expect(html).toContain("postCards((await getPosts()).slice(0, 3))");
  });
});
`;

/** Every post grouped by year, or one tag's posts on a tag page. */
export const POST_LIST_HTML = `<style>
section { padding-bottom: 72px; }
h2 {
  margin: 40px 0 0;
  font-size: 0.8rem;
  letter-spacing: 0.1em;
  color: var(--accent);
}
</style>
<section aria-label="Posts" data-testid="post-list">
  <!-- Every post, grouped by year. On a tag page (/blog/tags/<tag>/) only the posts with that tag. -->
  <script data-bascik-build type="text/typescript">
    import { yearSections } from "./years.ts";
    export default () => yearSections(process.env.BASCIK_ROUTE);
  </script>
</section>
`;

/** `years.ts`, beside `<post-list>`: the markup its build script returns. */
export const POST_LIST_YEARS_TS = `// The markup <post-list> prints: one heading and one list of <post-card> tags per year.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { getPosts, groupByYear, postCards } from "../../lib/posts.ts";

/**
 * \`route\` is BASCIK_ROUTE, the JSON a dynamic route page is built with. The tag pages carry \`{ tag }\` as
 * their data, so there the list holds only that tag's posts; on any other page it holds every post.
 */
export async function yearSections(route?: string): Promise<SafeHtml> {
  const tag = (JSON.parse(route || "{}") as { data?: { tag?: string } }).data
    ?.tag;
  const posts = (await getPosts()).filter(
    (post) => !tag || post.tags.includes(tag),
  );
  if (posts.length === 0) return postCards(posts);
  return html\`\${groupByYear(posts).map(
    (group) =>
      html\`<h2>\${group.year}</h2>
        \${postCards(group.posts)}\`,
  )}\`;
}
`;

export const POST_LIST_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPosts, groupByTag } from "../../lib/posts.ts";
import { yearSections } from "./years.ts";

const count = (text: string, part: string): number =>
  text.split(part).length - 1;

describe("post-list component", () => {
  it("is a labeled section that hands the route to yearSections()", async () => {
    const html = await readFile(
      join(process.cwd(), "src/components/post-list/post-list.html"),
      "utf8",
    );
    expect(html).toContain(
      '<section aria-label="Posts" data-testid="post-list">',
    );
    expect(html).toContain("yearSections(process.env.BASCIK_ROUTE)");
  });

  it("prints every post under a heading for its year, newest first", async () => {
    const posts = await getPosts();
    const markup = String(await yearSections());
    expect(count(markup, "<post-card")).toBe(posts.length);
    const years = [...markup.matchAll(/<h2>(\\d{4})<\\/h2>/g)].map(
      (match) => match[1],
    );
    expect(years).toEqual([...new Set(posts.map((p) => p.date.slice(0, 4)))]);
    const order = posts.map((p) => markup.indexOf(\`/blog/\${p.slug}/\`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("prints only a tag's posts on that tag's page", async () => {
    const [group] = groupByTag(await getPosts());
    const markup = String(
      await yearSections(
        JSON.stringify({ params: { tag: group.tag }, data: { tag: group.tag } }),
      ),
    );
    expect(count(markup, "<post-card")).toBe(group.posts.length);
  });

  it("says there are no posts for a tag nothing uses", async () => {
    const markup = String(
      await yearSections(JSON.stringify({ data: { tag: "no-such-tag" } })),
    );
    expect(markup).toContain("No posts yet.");
    expect(markup).not.toContain("<h2>");
  });
});
`;

/** One post: its build script reads the post the dynamic route page was generated for. */
export const POST_ARTICLE_HTML = `<style>
article { padding: 72px 0 40px; }
.back { margin: 40px 0 0; }
</style>
<article data-testid="post-article">
  <!-- The post this page was generated for: src/pages/blog/[slug]/index.html hands it over in BASCIK_ROUTE. -->
  <script data-bascik-build type="text/typescript">
    import { articleBody } from "./article-body.ts";
    export default () => articleBody(JSON.parse(process.env.BASCIK_ROUTE || "{}").data);
  </script>
  <p class="back"><a href="/blog/" data-testid="post-article-all">← All posts</a></p>
</article>
`;

/** `article-body.ts`, beside `<post-article>`: the heading, date, author, tags and rendered Markdown of one post. */
export const POST_ARTICLE_BODY_TS = `// The markup <post-article> prints for one post: its heading, date, author, tags, and rendered Markdown.
import { html, raw, type SafeHtml } from "@bascik/bascik/html";
import { formatDate, type Post } from "../../lib/posts.ts";

export function articleBody(post: Post | undefined): SafeHtml {
  if (!post)
    throw new Error(
      "<post-article> needs a post: use it on a dynamic route page whose routes script passes one as data",
    );
  const tags = post.tags.map(
    (tag) =>
      html\`<li><a href="/blog/tags/\${tag}/" data-testid="post-article-tag">\${tag}</a></li>\`,
  );
  // html escapes the front matter. post.html is the site's own Markdown, already rendered, so raw() inserts
  // it as it is. Sanitize HTML that comes from a CMS or from visitors before passing it to raw().
  return html\`<header class="post-header">
      <h1>\${post.title}</h1>
      <p class="post-meta">
        <time datetime="\${post.date}">\${formatDate(post.date)}</time> by
        \${post.author}
      </p>
      \${tags.length ? html\`<ul class="post-tags" aria-label="Tags">\${tags}</ul>\` : ""}
    </header>
    <div class="prose">\${raw(post.html)}</div>\`;
}
`;

export const POST_ARTICLE_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toPost } from "../../lib/posts.ts";
import { articleBody } from "./article-body.ts";

const source = (title: string, extra = ""): string =>
  \`---\\ntitle: \${title}\\ndescription: A review.\\ndate: 2026-08-02\\nauthor: Maren Okafor\\n\${extra}---\\n\\nA **short** novel.\\n\`;

describe("post-article component", () => {
  it("is an article that reads its post from the route and links back to the list", async () => {
    const html = await readFile(
      join(process.cwd(), "src/components/post-article/post-article.html"),
      "utf8",
    );
    expect(html).toContain('<article data-testid="post-article">');
    expect(html).toContain("process.env.BASCIK_ROUTE");
    expect(html).toContain('href="/blog/"');
  });

  it("prints the title, a machine-readable date, the author, the tags, and the rendered Markdown", () => {
    const markup = String(
      articleBody(toPost("low-tide", source("Low Tide", "tags: [craft]\\n"))),
    );
    expect(markup).toContain("<h1>Low Tide</h1>");
    expect(markup).toContain(
      '<time datetime="2026-08-02">August 2, 2026</time>',
    );
    expect(markup).toContain("Maren Okafor");
    expect(markup).toContain('href="/blog/tags/craft/"');
    expect(markup).toContain(
      '<div class="prose"><p>A <strong>short</strong> novel.</p>',
    );
  });

  it("leaves the tag list out of a post with no tags", () => {
    expect(
      String(articleBody(toPost("low-tide", source("Low Tide")))),
    ).not.toContain("post-tags");
  });

  it("escapes the front matter but keeps the post's own HTML", () => {
    const markup = String(
      articleBody(toPost("markup", source("<img src=x onerror=alert(1)>"))),
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("<strong>short</strong>");
  });

  it("says what is wrong when the page has no post to give it", () => {
    expect(() => articleBody(undefined)).toThrow(
      "<post-article> needs a post",
    );
  });
});
`;
