/**
 * @module templates/docs
 *
 * The `docs` template: a documentation site. Each Markdown file in
 * `content/docs/` becomes a page. The first guide is the root; the rest use a dynamic route template,
 * `src/pages/docs/[slug].html`, whose routes script reads the files with
 * `getDocs()` from `src/lib/docs.ts`. The sidebar order is `SIDEBAR` in
 * `src/lib/sidebar.ts`; search and the active table of contents come from each
 * page's content and headings.
 *
 * Its config inlines global CSS, watches content, and disables caching for directory readers.
 */

import {
  type StarterTemplate,
  type TemplateContext,
  type TemplateFile,
} from "../scaffold.js";
import { DOCS_SAMPLE_PAGES } from "./docs/content.js";
import {
  DOCS_BASCIK_CONFIG,
  DOCS_CONTENT_DIR,
  DOCS_MODULE,
  DOCS_MODULE_TEST,
  CURRENT_DOC_MODULE,
  CURRENT_DOC_MODULE_TEST,
  HEAD_MODULE,
  HEAD_MODULE_TEST,
  MARKDOWN_MODULE,
  MARKDOWN_MODULE_TEST,
  SIDEBAR_MODULE,
  siteModule,
} from "./docs/lib.js";
import {
  DOCS_ARTICLE_HTML,
  DOCS_ARTICLE_TEST,
  DOCS_INDEX_PAGE,
  DOCS_NOT_FOUND_PAGE,
  DOCS_PAGE_HTML,
  DOCS_PAGINATION_HTML,
  DOCS_PAGINATION_TEST,
  DOCS_SEARCH_HTML,
  DOCS_SEARCH_SCRIPT_TS,
  DOCS_SEARCH_TEST,
  DOCS_SIDEBAR_HTML,
  DOCS_SIDEBAR_TEST,
  DOCS_SITE_FOOTER_HTML,
  DOCS_SITE_FOOTER_TEST,
  DOCS_SITE_HEADER_HTML,
  DOCS_SITE_HEADER_TEST,
  DOCS_SITE_META_HTML,
  DOCS_SITE_META_TEST,
  DOCS_STYLES_CSS,
  DOCS_TOC_HTML,
  DOCS_TOC_SCRIPT_TS,
  DOCS_TOC_TEST,
  DOCS_THEME_TOGGLE_HTML,
  DOCS_THEME_TOGGLE_TEST,
  docsE2eSpec,
} from "./docs/site.js";

/** The template's components: each is a folder with its template and a test. */
const components = (): Record<string, [template: string, test: string]> => ({
  "site-meta": [DOCS_SITE_META_HTML, DOCS_SITE_META_TEST],
  "site-header": [DOCS_SITE_HEADER_HTML, DOCS_SITE_HEADER_TEST],
  "site-footer": [DOCS_SITE_FOOTER_HTML, DOCS_SITE_FOOTER_TEST],
  "theme-toggle": [DOCS_THEME_TOGGLE_HTML, DOCS_THEME_TOGGLE_TEST],
  "docs-search": [DOCS_SEARCH_HTML, DOCS_SEARCH_TEST],
  "docs-sidebar": [DOCS_SIDEBAR_HTML, DOCS_SIDEBAR_TEST],
  "docs-article": [DOCS_ARTICLE_HTML, DOCS_ARTICLE_TEST],
  "docs-toc": [DOCS_TOC_HTML, DOCS_TOC_TEST],
  "docs-pagination": [DOCS_PAGINATION_HTML, DOCS_PAGINATION_TEST],
});

const docsDirectories = (): string[] => [
  DOCS_CONTENT_DIR,
  "src/lib",
  "src/pages/css",
  "src/pages/docs",
  ...Object.keys(components()).map((name) => `src/components/${name}`),
];

const docsFiles = ({ siteName, adapter }: TemplateContext): TemplateFile[] => [
  ["bascik.config.ts", DOCS_BASCIK_CONFIG],
  ["e2e/app.spec.ts", docsE2eSpec({ adapter })],

  // Content: one Markdown file per page
  ...Object.entries(DOCS_SAMPLE_PAGES).map(([slug, markdown]): TemplateFile => [
    `${DOCS_CONTENT_DIR}/${slug}.md`,
    markdown,
  ]),

  // Build helpers
  ["src/lib/site.ts", siteModule(siteName)],
  ["src/lib/head.ts", HEAD_MODULE],
  ["src/lib/head.test.ts", HEAD_MODULE_TEST],
  ["src/lib/sidebar.ts", SIDEBAR_MODULE],
  ["src/lib/markdown.ts", MARKDOWN_MODULE],
  ["src/lib/markdown.test.ts", MARKDOWN_MODULE_TEST],
  ["src/lib/docs.ts", DOCS_MODULE],
  ["src/lib/docs.test.ts", DOCS_MODULE_TEST],
  ["src/lib/current-doc.ts", CURRENT_DOC_MODULE],
  ["src/lib/current-doc.test.ts", CURRENT_DOC_MODULE_TEST],
  ["src/components/docs-search/docs-search.ts", DOCS_SEARCH_SCRIPT_TS],
  ["src/components/docs-toc/docs-toc.ts", DOCS_TOC_SCRIPT_TS],

  // Global CSS
  ["src/pages/css/styles.css", DOCS_STYLES_CSS],

  // Pages
  ["src/pages/index.html", DOCS_INDEX_PAGE],
  ["src/pages/docs/[slug].html", DOCS_PAGE_HTML],
  ["src/pages/404.html", DOCS_NOT_FOUND_PAGE],

  // Components
  ...Object.entries(components()).flatMap(
    ([name, [template, test]]): TemplateFile[] => [
      [`src/components/${name}/${name}.html`, template],
      [`src/components/${name}/${name}.test.ts`, test],
    ],
  ),
];

/** `--template docs`: Markdown pages with searchable content, a sidebar, active table of contents, and pagination. */
export const DOCS_TEMPLATE: StarterTemplate = {
  name: "docs",
  summary:
    "A documentation site: searchable Markdown pages, responsive navigation, and an active table of contents",
  directories: docsDirectories,
  files: docsFiles,
  dependencies: { marked: "^18.1.3" },
};
