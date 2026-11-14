/**
 * @module templates/portfolio
 *
 * The `portfolio` template: the site of an invented author and her books. A home page with a short introduction
 * and a grid of featured books, a list of every book, one page per book, an about page, a contact page with a
 * form that checks its fields, a 404 page, and a title, description, canonical URL and Open Graph tags on
 * every page.
 *
 * How a book becomes a page, the way docs/content/scripts/dynamic-routes.md describes:
 *
 * 1. `src/lib/books.ts` is the collection: a typed array. For a handful of items with short text the docs keep
 *    data in a `.ts` module (docs/content/component-best-practices.md, "Keep Data with Its Component"); Markdown
 *    files are for long-form content. `checkBooks()` runs when the module loads, so an entry with a missing
 *    field or a slug used twice stops the build with an error that names it.
 * 2. `src/pages/work/[slug].html` is a dynamic route template. Its `data-bascik-routes` script returns one route
 *    per book with the book as the route's data, so the build writes `/work/<slug>` for each and lists it in
 *    `sitemap.xml`. The head script and `<book-detail>` read the book from `BASCIK_ROUTE`.
 * 3. The home page and `/work` build their cards from the same array (`src/lib/book-cards.ts`).
 *
 * Covers are drawn in CSS by `<book-cover>` (`role="img"` with a text alternative): no image files.
 *
 * The one file outside `src/` and `e2e/` is `bascik.config.ts`, for `pipeline.watchPaths: ["src/lib/"]`: the dev
 * server does not watch `src/lib/` by itself.
 *
 * With an adapter the site stays static: nothing here runs per request, and the shared `/api/hello` route is the
 * only request-time code. The contact form sends nothing in either case.
 */

import type {
  StarterTemplate,
  TemplateContext,
  TemplateFile,
} from "../scaffold.js";
import {
  AUTHOR_BIO_HTML,
  AUTHOR_BIO_TEST,
  BOOK_CARD_HTML,
  BOOK_CARD_TEST,
  BOOK_COVER_HTML,
  BOOK_COVER_TEST,
  BOOK_DETAIL_HTML,
  BOOK_DETAIL_TEST,
  BOOK_DETAIL_TS,
  BOOK_LIST_HTML,
  BOOK_LIST_TEST,
  CONTACT_FORM_HTML,
  CONTACT_FORM_TEST,
  FEATURED_BOOKS_HTML,
  FEATURED_BOOKS_TEST,
  HOME_INTRO_HTML,
  HOME_INTRO_TEST,
  PAGE_INTRO_HTML,
  PAGE_INTRO_TEST,
  SITE_FOOTER_HTML,
  SITE_FOOTER_TEST,
  SITE_HEADER_HTML,
  SITE_HEADER_TEST,
  SITE_META_HTML_PORTFOLIO,
  SITE_META_TEST,
} from "./portfolio/components.js";
import {
  BASCIK_CONFIG,
  BOOKS_TEST,
  BOOKS_TS,
  BOOK_CARDS_TEST,
  BOOK_CARDS_TS,
  SEO_TEST,
  SEO_TS,
  siteModule,
} from "./portfolio/lib.js";
import {
  ABOUT_PAGE,
  BOOK_PAGE,
  CONTACT_PAGE,
  INDEX_PAGE,
  NOT_FOUND_PAGE,
  PORTFOLIO_STYLES_CSS,
  WORK_PAGE,
  e2eAppSpec,
} from "./portfolio/pages.js";

/** The components, each in `src/components/<name>/` with its test beside it. */
const COMPONENTS: readonly (readonly [
  name: string,
  html: string,
  test: string,
])[] = [
  ["site-meta", SITE_META_HTML_PORTFOLIO, SITE_META_TEST],
  ["site-header", SITE_HEADER_HTML, SITE_HEADER_TEST],
  ["site-footer", SITE_FOOTER_HTML, SITE_FOOTER_TEST],
  ["page-intro", PAGE_INTRO_HTML, PAGE_INTRO_TEST],
  ["home-intro", HOME_INTRO_HTML, HOME_INTRO_TEST],
  ["book-cover", BOOK_COVER_HTML, BOOK_COVER_TEST],
  ["book-card", BOOK_CARD_HTML, BOOK_CARD_TEST],
  ["featured-books", FEATURED_BOOKS_HTML, FEATURED_BOOKS_TEST],
  ["book-list", BOOK_LIST_HTML, BOOK_LIST_TEST],
  ["book-detail", BOOK_DETAIL_HTML, BOOK_DETAIL_TEST],
  ["author-bio", AUTHOR_BIO_HTML, AUTHOR_BIO_TEST],
  ["contact-form", CONTACT_FORM_HTML, CONTACT_FORM_TEST],
];

/** The folders the portfolio creates under `src/`. */
const portfolioDirectories = (): string[] => [
  "src/lib",
  "src/pages/css",
  "src/pages/work",
  ...COMPONENTS.map(([name]) => `src/components/${name}`),
];

/** The files the portfolio writes as its own, relative to the project root. */
const portfolioFiles = ({
  siteName,
  adapter,
}: TemplateContext): TemplateFile[] => [
  // The project config: the dev server's watch on src/lib/
  ["bascik.config.ts", BASCIK_CONFIG],

  ["e2e/app.spec.ts", e2eAppSpec({ adapter: adapter !== undefined })],

  // Shared modules. site.ts is the only file that holds the site's name; books.ts is the collection.
  ["src/lib/site.ts", siteModule(siteName)],
  ["src/lib/books.ts", BOOKS_TS],
  ["src/lib/books.test.ts", BOOKS_TEST],
  ["src/lib/book-cards.ts", BOOK_CARDS_TS],
  ["src/lib/book-cards.test.ts", BOOK_CARDS_TEST],
  ["src/lib/seo.ts", SEO_TS],
  ["src/lib/seo.test.ts", SEO_TEST],

  // Global CSS: the default template's design tokens, then the portfolio's own rules
  ["src/pages/css/styles.css", PORTFOLIO_STYLES_CSS],

  // Pages. work/[slug].html becomes one page per book.
  ["src/pages/index.html", INDEX_PAGE],
  ["src/pages/work.html", WORK_PAGE],
  ["src/pages/work/[slug].html", BOOK_PAGE],
  ["src/pages/about.html", ABOUT_PAGE],
  ["src/pages/contact.html", CONTACT_PAGE],
  ["src/pages/404.html", NOT_FOUND_PAGE],

  // Components, and the module book-detail keeps beside its markup
  ...COMPONENTS.flatMap(([name, html, test]): TemplateFile[] => [
    [`src/components/${name}/${name}.html`, html],
    [`src/components/${name}/${name}.test.ts`, test],
  ]),
  ["src/components/book-detail/detail.ts", BOOK_DETAIL_TS],
];

/** `--template portfolio`: an author's site, with a page per book generated from one data file. */
export const PORTFOLIO_TEMPLATE: StarterTemplate = {
  name: "portfolio",
  summary:
    "A portfolio: a work grid, a page per item, and about and contact pages",
  directories: portfolioDirectories,
  files: portfolioFiles,
};
