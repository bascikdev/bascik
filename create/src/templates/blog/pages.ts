/**
 * @module templates/blog/pages
 *
 * The blog template's pages, its global stylesheet for post lists and rendered Markdown, and the Playwright
 * spec. A page is a list of component tags; the site name never appears in one, because the components and
 * `seo()` read it from `src/lib/site.ts`.
 */

/** `src/pages/css/blog.css`: global, because build scripts print the markup it styles. */
export const BLOG_CSS = `/* src/pages/css/blog.css: the blog's page column, post lists, and typography for rendered Markdown.
   A global stylesheet, on purpose: build scripts print this markup, and a component's element selectors only
   reach elements written in its own template. Uses the tokens from styles.css. */

/* ── Reading column ── */
html[data-theme="light"] { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }
body {
  display: grid;
  grid-template-columns: 240px minmax(0, 800px);
  grid-template-rows: 1fr auto;
  column-gap: 64px;
  max-width: 1160px;
  padding: 0 28px;
  margin: 0 auto;
}
body > main { min-width: 0; }
body > footer { grid-column: 2; }
nav a { text-decoration: none; }
.page {
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  padding: 48px 0 64px;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

/* ── Post lists (printed by postCards() in src/lib/posts.ts) ── */
.post-cards {
  list-style: none;
  display: grid;
  gap: 1.25rem;
  margin: 0;
  padding: 0;
}
.post-cards > li { margin: 0; padding: 0; }

/* Content is fully visible at first paint. Only CSS interaction feedback moves. */
.author-context { border-top: 1px solid var(--border); margin-top: 40px; padding-top: 24px; }
.author-context h2 { font-size: 1.2rem; }
.author-context p { max-width: 60ch; font-size: 0.95rem; }

/* ── A post's heading block (printed by <post-article>) ── */
.page h1,
.post-header h1 {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: clamp(2.2rem, 5vw, 3.5rem);
  letter-spacing: -0.04em;
  line-height: 1.08;
}
.post-header h1 { margin-bottom: 12px; }
.post-meta { font-size: 0.82rem; margin-bottom: 18px; letter-spacing: 0.035em; }
.post-tags {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 32px;
  padding: 0;
}
.post-tags a {
  display: block;
  padding: 0;
  font-size: 0.8rem;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.post-tags a:hover { opacity: 1; }

/* ── Rendered Markdown ── */
.prose { max-width: 68ch; font-size: 1.08rem; line-height: 1.8; }
.prose p,
.prose li { color: var(--text); }
.prose h2 { font-size: 1.4rem; margin: 40px 0 12px; }
.prose h3 { font-size: 1.15rem; margin: 32px 0 8px; }
.prose p,
.prose ul,
.prose ol,
.prose blockquote,
.prose pre,
.prose table { margin: 0 0 20px; }
.prose li + li { margin-top: 6px; }
.prose blockquote {
  padding: 4px 0 4px 20px;
  border-left: 3px solid var(--accent);
}
.prose blockquote p { color: var(--text-muted); margin: 0; }
.prose pre {
  overflow-x: auto;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface);
}
.prose pre code { padding: 0; border: none; background: none; color: var(--text); }
.prose img { max-width: 100%; height: auto; border-radius: var(--r); }
.prose table { display: block; overflow-x: auto; border-collapse: collapse; }
.prose th,
.prose td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
.prose th { background: var(--surface); }

@media (max-width: 900px) {
  body { display: flex; padding: 0 24px; }
  .page { padding: 36px 0 56px; }
}
@media (max-width: 640px) {
  body { padding: 0 20px; }
  .post-cards { gap: 0.75rem; }
}
`;

/** The home page: the introduction and the three newest posts. */
export const INDEX_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <script data-bascik-build type="text/typescript">
    import { seo } from "@/lib/seo.ts";
    import { SITE } from "@/lib/site.ts";
    export default () => seo({ description: SITE.description });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="home-main">
    <site-intro />
    <latest-posts />
  </main>
  <site-footer />
</body>
</html>
`;

/** `/blog/`: every post, newest first. */
export const BLOG_INDEX_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <script data-bascik-build type="text/typescript">
    import { seo } from "@/lib/seo.ts";
    export default () =>
      seo({ title: "Blog", description: "Every illustrative endurance racing guide, car-class checklist, track notebook, and race-preview example, newest first." });
  </script>
</head>
<body>
  <site-header />
  <main id="main" class="page" data-testid="blog-main">
    <h1>Blog</h1>
    <p class="page-intro">Every post, newest first. Subscribe to the <a href="/feed.xml">feed</a> to get new ones in your reader.</p>
    <post-list />
  </main>
  <site-footer />
</body>
</html>
`;

/** `src/pages/blog/[slug]/index.html`: a dynamic route template. Its routes script returns one route per Markdown file, so each post gets a page at `/blog/<slug>/`. */
export const POST_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <!-- One page per post, at /blog/<slug>/. The routes script reads every post once and hands each page its own as data. -->
  <script data-bascik-routes type="text/typescript">
    import { getPosts } from "@/lib/posts.ts";
    export default async () =>
      (await getPosts()).map((post) => ({ params: { slug: post.slug }, data: post }));
  </script>
  <script data-bascik-build type="text/typescript">
    import { html } from "@bascik/bascik/html";
    import { articleJsonLd, seo } from "@/lib/seo.ts";
    import type { Post } from "@/lib/posts.ts";
    export default () => {
      const post: Post = JSON.parse(process.env.BASCIK_ROUTE || "{}").data;
      const tags = seo({
        title: post.title,
        description: post.description,
        type: "article",
        publishedTime: post.date,
        author: post.author,
      });
      return html\`\${tags}\${articleJsonLd(post)}\`;
    };
  </script>
</head>
<body>
  <site-header />
  <main id="main" class="page" data-testid="post-main">
    <post-article />
  </main>
  <site-footer />
</body>
</html>
`;

/** `src/pages/blog/tags/[tag]/index.html`: one page per tag, from the same mechanism. */
export const TAG_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <!-- One page per tag, at /blog/tags/<tag>/. <post-list> reads the tag from the route and lists its posts. -->
  <script data-bascik-routes type="text/typescript">
    import { getPosts, groupByTag } from "@/lib/posts.ts";
    export default async () =>
      groupByTag(await getPosts()).map(({ tag }) => ({ params: { tag }, data: { tag } }));
  </script>
  <script data-bascik-build type="text/typescript">
    import { seo } from "@/lib/seo.ts";
    export default () => {
      const { tag } = JSON.parse(process.env.BASCIK_ROUTE || "{}").data;
      return seo({ title: \`Posts tagged \${tag}\`, description: \`Every post on this blog tagged \${tag}, newest first.\` });
    };
  </script>
</head>
<body>
  <site-header />
  <main id="main" class="page" data-testid="tag-main">
    <script data-bascik-build type="text/typescript">
      import { html } from "@bascik/bascik/html";
      export default () => {
        const { tag } = JSON.parse(process.env.BASCIK_ROUTE || "{}").data;
        return html\`<h1>Posts tagged <span class="text-accent">\${tag}</span></h1>\`;
      };
    </script>
    <p class="page-intro"><a href="/blog/">← All posts</a></p>
    <post-list />
  </main>
  <site-footer />
</body>
</html>
`;

export const ABOUT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <script data-bascik-build type="text/typescript">
    import { seo } from "@/lib/seo.ts";
    export default () =>
      seo({ title: "About", description: "Who writes this blog, what it covers, and how its Markdown posts become pages." });
  </script>
</head>
<body>
  <site-header />
  <main id="main" class="page" data-testid="about-main">
    <h1>About</h1>
    <p class="page-intro">This is the about page. Tell readers who you are and what you write about.</p>
    <div class="prose">
      <h2>Who writes here</h2>
      <p>John Doe is a placeholder author. This starter uses illustrative endurance racing guides, not a real person's biography, reporting, or endorsement. Replace the author context in <code>src/lib/site.ts</code> and the sample bylines before publishing.</p>
      <h2>How this blog works</h2>
      <ul>
        <li>Each post is a Markdown file in <code>content/posts/</code>. Its file name is its URL.</li>
        <li><code>src/lib/posts.ts</code> reads and checks every post, and a post with a missing title or date stops the build.</li>
        <li><code>src/pages/blog/[slug]/index.html</code> turns each post into a page, and <code>scripts/feed.ts</code> writes the <a href="/feed.xml">feed</a>.</li>
      </ul>
      <p>To add a post, copy one of the files in <code>content/posts/</code>, rename it, and change its front matter.</p>
    </div>
  </main>
  <site-footer />
</body>
</html>
`;

export const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <!-- Served with status 404 for unknown URLs by the dev server, bascik --server, and most static hosts. -->
  <script data-bascik-build type="text/typescript">
    import { seo } from "@/lib/seo.ts";
    export default () =>
      seo({ title: "Page not found", description: "This page does not exist or has moved.", noindex: true });
  </script>
</head>
<body>
  <site-header />
  <main id="main" class="page not-found" data-testid="404-main">
    <p class="not-found-code">404</p>
    <h1>Page not found</h1>
    <p class="not-found-text">The page you're looking for doesn't exist or has moved.</p>
    <a href="/blog/" class="btn btn-primary" data-testid="404-posts">Read the blog</a>
  </main>
  <site-footer />
</body>
</html>
`;

/**
 * `e2e/app.spec.ts`: home, the post list, a post page, a tag page, the feed and the 404 page, against
 * `bascik --server`. `extraTests` is appended inside the `describe` block.
 */
export const e2eAppSpec = (
  extraTests = "",
): string => `import { test, expect } from '@playwright/test';

// The sample posts, newest first. Change these with the files in content/posts/.
const POSTS = [
  { slug: 'reading-an-endurance-stint', title: 'Reading an Endurance Stint', date: '2026-10-28' },
  { slug: 'understanding-racing-car-classes', title: 'Understanding Racing Car Classes', date: '2026-09-14' },
  { slug: 'laguna-seca-set-up-notes', title: 'Laguna Seca Set-Up Notes', date: '2026-08-02' },
  { slug: 'le-mans-spa-race-preview', title: 'Le Mans and Spa Race Preview', date: '2026-06-19' },
];

test.describe('Blog E2E Tests', () => {
  test('home page lists the three newest posts and links to the rest', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByTestId('post-card-link')).toHaveText(POSTS.slice(0, 3).map((post) => post.title));

    await page.getByTestId('latest-posts-all').click();
    await expect(page).toHaveURL('/blog/');
    await expect(page).toHaveTitle(/^Blog - /);
  });

  test('post list shows every post, newest first, with machine-readable dates', async ({ page }) => {
    await page.goto('/blog/');
    await expect(page.getByTestId('post-card-link')).toHaveText(POSTS.map((post) => post.title));
    const dates = await page
      .getByTestId('post-card')
      .locator('time')
      .evaluateAll((times) => times.map((time) => time.getAttribute('datetime')));
    expect(dates).toEqual(POSTS.map((post) => post.date));
  });

  test('a post page renders its Markdown and its own head tags', async ({ page }) => {
    const [post] = POSTS;
    await page.goto('/blog/');
    await page.getByTestId('post-card-link').filter({ hasText: post.title }).click();
    await expect(page).toHaveURL(\`/blog/\${post.slug}/\`);
    await expect(page).toHaveTitle(new RegExp(\`^\${post.title} - \`));

    const article = page.getByTestId('post-article');
    await expect(article.getByRole('heading', { level: 1 })).toHaveText(post.title);
    await expect(article.locator('time')).toHaveAttribute('datetime', post.date);
    await expect(article.getByRole('heading', { level: 2, name: 'Look beyond the fastest lap' })).toBeVisible();
    await expect(page.getByTestId('post-author-context')).toContainText('John Doe is a placeholder author');

    // The canonical URL and og:url are this post's, built from the site URL the build was given.
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(new RegExp(\`^https?://[^/]+/blog/\${post.slug}/$\`));
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonical!);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', new RegExp(\`^\${post.title}\`));
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /illustrative guide/);
  });

  test('a tag page lists only the posts with that tag', async ({ page }) => {
    await page.goto(\`/blog/\${POSTS[0].slug}/\`);
    await page.getByTestId('post-article-tag').filter({ hasText: 'imsa' }).click();
    await expect(page).toHaveURL('/blog/tags/imsa/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Posts tagged imsa');
    await expect(page.getByTestId('post-card-link')).toHaveText([POSTS[0].title]);
  });

  test('feed is Atom with an absolute link for every post', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="alternate"][type="application/atom+xml"]')).toHaveAttribute('href', '/feed.xml');

    const response = await request.get('/feed.xml');
    expect(response.status()).toBe(200);
    const xml = await response.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    const links = [...xml.matchAll(/<entry>\\s*<title>[^<]*<\\/title>\\s*<link href="([^"]+)"/g)].map((match) => match[1]);
    expect(links).toHaveLength(POSTS.length);
    links.forEach((link, index) => {
      expect(link).toMatch(new RegExp(\`^https?://[^/]+/blog/\${POSTS[index].slug}/$\`));
    });
  });

  test('an unknown URL gets the 404 page with a 404 status', async ({ page }) => {
    const response = await page.goto('/blog/no-such-post/');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await page.getByTestId('404-posts').click();
    await expect(page).toHaveURL('/blog/');
  });

  test('skip link is the first stop and jumps to the main content', async ({ page }) => {
    await page.goto('/about');
    await page.keyboard.press('Tab');
    const skip = page.getByTestId('site-header-skip-link');
    await expect(skip).toBeFocused();
    await skip.press('Enter');
    await expect(page).toHaveURL('/about#main');
  });

  test('mobile navigation opens from the menu button and ends with the theme switch', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const toggle = page.getByTestId('site-header-nav-toggle');
    const menu = page.getByTestId('site-header-nav-menu');
    await expect(page.getByTestId('author-sidebar')).toContainText('John Doe');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
    // At phone width the theme switch is a row in the menu, not an icon in the bar.
    await expect(page.getByTestId('theme-toggle')).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    const themeRow = page.getByTestId('site-header-mobile-theme');
    const before = await themeRow.innerText();
    await themeRow.click();
    await expect(themeRow).not.toHaveText(before);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await page.getByTestId('site-header-blog').click();
    await expect(page).toHaveURL('/blog/');
  });

  test('mobile navigation stays visible without JavaScript', async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, javaScriptEnabled: false, viewport: { width: 375, height: 667 } });
    try {
      await page.goto('/');
      await expect(page.getByTestId('site-header-nav-toggle')).toBeHidden();
      await page.getByTestId('site-header-blog').click();
      await expect(page).toHaveURL('/blog/');
    } finally {
      await page.close();
    }
  });

  test('icon-only dark-mode button toggles and persists the theme', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toHaveAccessibleName('Dark mode');
    await expect(toggle).toHaveText('');
    const before = await toggle.getAttribute('aria-pressed');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', String(before !== 'true'));
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-pressed', String(before !== 'true'));
  });
${extraTests}});
`;

/** With an adapter, the shared `/api/hello` route is there too; `bascik --server` answers it on Node. */
export const API_ROUTE_E2E_TEST = `
  test('API route answers on the server', async ({ request }) => {
    const response = await request.get('/api/hello?name=Runa');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ hello: 'Runa', platform: 'node' });
  });
`;
