/**
 * @module templates/blog
 *
 * The `blog` template: Markdown posts with front matter, a home page with the newest posts, a post list, one
 * page per post and per tag, an Atom feed, per-page SEO tags, an about page and a 404 page.
 *
 * How a Markdown file becomes a page, all of it the layout the docs recommend for a content collection
 * (docs/content/how-to/markdown.md and docs/content/scripts/dynamic-routes.md):
 *
 * 1. `content/posts/<slug>.md` holds a post. `src/lib/posts.ts` is the only code that reads the folder; it
 *    validates the front matter and renders the body with `marked`.
 * 2. `src/pages/blog/[slug]/index.html` is a dynamic route template. Its `data-bascik-routes` script returns
 *    one route per post, so the build writes `/blog/<slug>/` for each and lists it in `sitemap.xml`.
 * 3. `scripts/feed.ts` is a `post` exec script that writes `feed.xml` into the output.
 *
 * That layout needs three things outside `src/`: `bascik.config.ts` (the watch paths, the build script cache
 * exclusions and the exec entry), `content/posts/` and `scripts/feed.ts`.
 *
 * With an adapter the site stays static: nothing here runs per request, and the shared `/api/hello` route is
 * the only request-time code.
 */

import {
  STYLES_CSS,
  type StarterTemplate,
  type TemplateContext,
  type TemplateFile,
} from "../scaffold.js";
import {
  LATEST_POSTS_HTML,
  LATEST_POSTS_TEST,
  POST_ARTICLE_BODY_TS,
  POST_ARTICLE_HTML,
  POST_ARTICLE_TEST,
  POST_CARD_HTML,
  POST_CARD_TEST,
  POST_LIST_HTML,
  POST_LIST_TEST,
  POST_LIST_YEARS_TS,
  SITE_FOOTER_HTML,
  SITE_FOOTER_TEST,
  SITE_HEADER_HTML,
  SITE_HEADER_TEST,
  SITE_INTRO_HTML,
  SITE_INTRO_TEST,
  SITE_META_HTML,
  SITE_META_TEST,
} from "./blog/components.js";
import { SAMPLE_POSTS } from "./blog/content.js";
import {
  BASCIK_CONFIG,
  FEED_SCRIPT,
  FEED_TEST,
  FEED_TS,
  POSTS_TEST,
  POSTS_TS,
  SEO_TEST,
  SEO_TS,
  siteModule,
} from "./blog/lib.js";
import {
  ABOUT_PAGE,
  API_ROUTE_E2E_TEST,
  BLOG_CSS,
  BLOG_INDEX_PAGE,
  INDEX_PAGE,
  NOT_FOUND_PAGE,
  POST_PAGE,
  TAG_PAGE,
  e2eAppSpec,
} from "./blog/pages.js";

/** The components, each in `src/components/<name>/` with its test beside it. */
const COMPONENTS: readonly (readonly [
  name: string,
  html: string,
  test: string,
])[] = [
  ["site-meta", SITE_META_HTML, SITE_META_TEST],
  ["site-header", SITE_HEADER_HTML, SITE_HEADER_TEST],
  ["site-footer", SITE_FOOTER_HTML, SITE_FOOTER_TEST],
  ["site-intro", SITE_INTRO_HTML, SITE_INTRO_TEST],
  ["post-card", POST_CARD_HTML, POST_CARD_TEST],
  ["latest-posts", LATEST_POSTS_HTML, LATEST_POSTS_TEST],
  ["post-list", POST_LIST_HTML, POST_LIST_TEST],
  ["post-article", POST_ARTICLE_HTML, POST_ARTICLE_TEST],
];

/** The folders the blog creates: the posts and the feed script at the project root, the rest under `src/`. */
const blogDirectories = (): string[] => [
  "content/posts",
  "scripts",
  "src/lib",
  "src/pages/css",
  "src/pages/blog/[slug]",
  "src/pages/blog/tags/[tag]",
  ...COMPONENTS.map(([name]) => `src/components/${name}`),
];

/** The files the blog writes as its own, relative to the project root. */
const blogFiles = ({ siteName, adapter }: TemplateContext): TemplateFile[] => [
  // The project config: watch paths, cache exclusions, and the feed's exec entry
  ["bascik.config.ts", BASCIK_CONFIG],

  // Content: one Markdown file per post
  ...SAMPLE_POSTS.map(([slug, markdown]): TemplateFile => [
    `content/posts/${slug}.md`,
    markdown,
  ]),

  // Runs after each build and writes feed.xml
  ["scripts/feed.ts", FEED_SCRIPT],

  ["e2e/app.spec.ts", e2eAppSpec(adapter ? API_ROUTE_E2E_TEST : "")],

  // Shared modules; site.ts is the only file that holds the site's name
  ["src/lib/site.ts", siteModule(siteName)],
  ["src/lib/posts.ts", POSTS_TS],
  ["src/lib/posts.test.ts", POSTS_TEST],
  ["src/lib/seo.ts", SEO_TS],
  ["src/lib/seo.test.ts", SEO_TEST],
  ["src/lib/feed.ts", FEED_TS],
  ["src/lib/feed.test.ts", FEED_TEST],

  // Global CSS: the default template's design tokens, and the blog's own stylesheet
  ["src/pages/css/styles.css", STYLES_CSS],
  ["src/pages/css/blog.css", BLOG_CSS],

  // Pages
  ["src/pages/index.html", INDEX_PAGE],
  ["src/pages/about.html", ABOUT_PAGE],
  ["src/pages/404.html", NOT_FOUND_PAGE],
  ["src/pages/blog/index.html", BLOG_INDEX_PAGE],
  ["src/pages/blog/[slug]/index.html", POST_PAGE],
  ["src/pages/blog/tags/[tag]/index.html", TAG_PAGE],

  // Components, and the modules two of them keep beside their markup
  ...COMPONENTS.flatMap(([name, html, test]): TemplateFile[] => [
    [`src/components/${name}/${name}.html`, html],
    [`src/components/${name}/${name}.test.ts`, test],
  ]),
  ["src/components/post-list/years.ts", POST_LIST_YEARS_TS],
  ["src/components/post-article/article-body.ts", POST_ARTICLE_BODY_TS],
];

/** `--template blog`: a blog whose posts are Markdown files. */
export const BLOG_TEMPLATE: StarterTemplate = {
  name: "blog",
  summary:
    "A blog: Markdown posts, a post list, an Atom feed, and an about page",
  directories: blogDirectories,
  files: blogFiles,
  dependencies: { marked: "^18.2.0" },
};
