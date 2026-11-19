/**
 * @module templates/portfolio
 *
 * The `portfolio` template: a racing professional portfolio. A home page with a short introduction
 * and a grid of featured projects, a list of every project, one page per project, an about page, a contact page with a
 * form that checks its fields, a 404 page, and a title, description, canonical URL and Open Graph tags on
 * every page.
 *
 * How a project becomes a page, the way docs/content/scripts/dynamic-routes.md describes:
 *
 * 1. `src/lib/projects.ts` reads `content/projects/*.md` as the one collection and validates frontmatter.
 *    data in Markdown files because project pages contain long-form race context.
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
  PROJECT_CARD_HTML,
  PROJECT_CARD_TEST,
  PROJECT_LIST_HTML,
  PROJECT_LIST_TEST,
  PROJECT_DETAIL_HTML,
  PROJECT_DETAIL_TEST,
  PROJECT_DETAIL_TS,
  FEATURED_PROJECTS_HTML,
  FEATURED_PROJECTS_TEST,
  RACING_BIO_HTML,
  RACING_BIO_TEST,
  CONTACT_FORM_HTML,
  CONTACT_FORM_TEST,
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
  PROJECT_MARKDOWN,
  PROJECTS_TEST,
  PROJECTS_TS,
  SEO_TEST,
  SEO_TS,
  siteModule,
} from "./portfolio/lib.js";
import {
  ABOUT_PAGE,
  PROJECT_PAGE,
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
  ["project-card", PROJECT_CARD_HTML, PROJECT_CARD_TEST],
  ["featured-projects", FEATURED_PROJECTS_HTML, FEATURED_PROJECTS_TEST],
  ["project-list", PROJECT_LIST_HTML, PROJECT_LIST_TEST],
  ["project-detail", PROJECT_DETAIL_HTML, PROJECT_DETAIL_TEST],
  ["racing-bio", RACING_BIO_HTML, RACING_BIO_TEST],
  ["contact-form", CONTACT_FORM_HTML, CONTACT_FORM_TEST],
];

/** The folders the portfolio creates under `src/`. */
const portfolioDirectories = (): string[] => [
  "src/lib",
  "src/pages/css",
  "src/pages/work",
  "content/projects",
  ...COMPONENTS.map(([name]) => `src/components/${name}`),
];

/** The files the portfolio writes as its own, relative to the project root. */
const portfolioFiles = ({
  siteName,
  adapter,
}: TemplateContext): TemplateFile[] => [
  // The project config: watch shared modules and Markdown content.
  ["bascik.config.ts", BASCIK_CONFIG],

  ["e2e/app.spec.ts", e2eAppSpec({ adapter: adapter !== undefined })],

  // Shared modules. site.ts is the only file that holds the site's name; projects.ts reads Markdown.
  ["src/lib/site.ts", siteModule(siteName)],
  ["src/lib/projects.ts", PROJECTS_TS],
  ["src/lib/projects.test.ts", PROJECTS_TEST],
  [
    "src/lib/project-cards.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";
import { projectPath, type Project } from "./projects.ts";

export const projectCards = (list: readonly Project[]): SafeHtml =>
  html\`<ul class="project-grid">
    \${list.map((project) => {
      const href = projectPath(project);
      return html\`<li>
        <project-card
          data-bascik-prop-title="\${project.title}"
          data-bascik-prop-meta="\${project.category} · \${String(project.year)}"
          data-bascik-prop-summary="\${project.summary}"
          data-bascik-prop-href="\${href}"
          data-bascik-prop-accent="\${project.accent}"
        />
      </li>\`;
    })}
  </ul>\`;`,
  ],
  ["src/lib/seo.ts", SEO_TS],
  ["src/lib/seo.test.ts", SEO_TEST],
  ...Object.entries(PROJECT_MARKDOWN).map(([slug, markdown]): TemplateFile => [
    `content/projects/${slug}.md`,
    markdown,
  ]),

  // Global CSS: the default template's design tokens, then the portfolio's own rules
  ["src/pages/css/styles.css", PORTFOLIO_STYLES_CSS],

  // Pages. work/[slug].html becomes one page per Markdown project.
  ["src/pages/index.html", INDEX_PAGE],
  ["src/pages/work.html", WORK_PAGE],
  ["src/pages/work/[slug].html", PROJECT_PAGE],
  ["src/pages/about.html", ABOUT_PAGE],
  ["src/pages/contact.html", CONTACT_PAGE],
  ["src/pages/404.html", NOT_FOUND_PAGE],

  // Components, and the project-detail module kept beside its markup
  ...COMPONENTS.flatMap(([name, html, test]): TemplateFile[] => [
    [`src/components/${name}/${name}.html`, html],
    [`src/components/${name}/${name}.test.ts`, test],
  ]),
  ["src/components/project-detail/detail.ts", PROJECT_DETAIL_TS],
];

/** `--template portfolio`: a racing portfolio, with one page per Markdown project. */
export const PORTFOLIO_TEMPLATE: StarterTemplate = {
  name: "portfolio",
  summary:
    "A portfolio: a work grid, a page per item, and about and contact pages",
  directories: portfolioDirectories,
  files: portfolioFiles,
};
