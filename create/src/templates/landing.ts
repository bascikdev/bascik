/**
 * @module templates/landing
 *
 * The `landing` template: a one-page product landing page for an invented
 * monthly book box. The home page is a list of section components (hero,
 * features, steps, testimonials, pricing, questions, sign-up form); a privacy
 * placeholder and a 404 page sit beside it.
 *
 * Three things differ from the default template:
 *
 * - The site name is written once, as a JSON string in `src/lib/site.ts`. The
 *   header, the footer and every page's head tags read it there at build time
 *   and print it with `html` from `@bascik/bascik/html`, so no page holds the
 *   name as markup and there is nothing for `escapeHtml` to escape.
 * - Repeated content (features, steps, quotes, plans, questions) is typed data
 *   in a `.ts` module beside the component that prints it. An empty list
 *   throws, which fails the build with the file to edit and the tag to remove.
 * - It writes a `bascik.config.ts`, because `src/lib/` is outside the folders
 *   the dev server watches.
 *
 * With an adapter the sign-up form posts JSON to `src/api/waitlist.ts`, which
 * validates it again; without one the form's script only confirms, and no
 * build has a form `action` pointing at a route that is not there.
 */

import type {
  StarterTemplate,
  TemplateContext,
  TemplateFile,
} from "../scaffold.js";
import {
  FAQ_LIST_HTML,
  FAQ_LIST_TEST_TS,
  FAQS_TS,
  FEATURE_LIST_HTML,
  FEATURE_LIST_TEST_TS,
  FEATURES_TS,
  HOME_HERO_HTML,
  HOME_HERO_TEST_TS,
  HOW_IT_WORKS_HTML,
  HOW_IT_WORKS_TEST_TS,
  PLANS_TS,
  PRICING_PLANS_HTML,
  PRICING_PLANS_TEST_TS,
  QUOTES_TS,
  READER_QUOTES_HTML,
  READER_QUOTES_TEST_TS,
  SECTION_HEAD_HTML,
  SECTION_HEAD_TEST_TS,
  SITE_FOOTER_HTML,
  SITE_FOOTER_TEST_TS,
  SITE_HEAD_HTML,
  SITE_HEAD_TEST_TS,
  SITE_HEADER_HTML,
  SITE_HEADER_TEST_TS,
  STEPS_TS,
  WAITLIST_SEND_API,
  WAITLIST_SEND_STATIC,
  WAITLIST_SIGNUP_TEST_TS,
  waitlistSignupHtml,
} from "./landing/components.js";
import { E2E_API_TESTS, e2eAppSpec } from "./landing/e2e.js";
import {
  BASCIK_CONFIG_TS,
  INDEX_HTML,
  LANDING_STYLES_CSS,
  NOT_FOUND_HTML,
  PRIVACY_HTML,
  SEO_TEST_TS,
  SEO_TS,
  WAITLIST_API_TEST_TS,
  WAITLIST_API_TS,
  siteModule,
} from "./landing/pages.js";

/** The components, in the order the home page uses them. */
const COMPONENTS = [
  "site-head",
  "site-header",
  "section-head",
  "home-hero",
  "feature-list",
  "how-it-works",
  "reader-quotes",
  "pricing-plans",
  "faq-list",
  "waitlist-signup",
  "site-footer",
] as const;

const landingDirectories = (): string[] => [
  "src/lib",
  "src/pages/css",
  ...COMPONENTS.map((name) => `src/components/${name}`),
];

/** A component's files: its template, its test, and the data module it prints, if it has one. */
const component = (
  name: (typeof COMPONENTS)[number],
  html: string,
  test: string,
  data?: [file: string, text: string],
): TemplateFile[] => [
  [`src/components/${name}/${name}.html`, html],
  [`src/components/${name}/${name}.test.ts`, test],
  ...(data
    ? ([[`src/components/${name}/${data[0]}`, data[1]]] as TemplateFile[])
    : []),
];

const landingFiles = ({
  siteName,
  adapter,
}: TemplateContext): TemplateFile[] => [
  ["bascik.config.ts", BASCIK_CONFIG_TS],
  ["e2e/app.spec.ts", e2eAppSpec(adapter ? E2E_API_TESTS : "")],

  // Shared modules: the site's facts and the head tags built from them
  ["src/lib/site.ts", siteModule(siteName)],
  ["src/lib/seo.ts", SEO_TS],
  ["src/lib/seo.test.ts", SEO_TEST_TS],

  // Global CSS and pages
  ["src/pages/css/styles.css", LANDING_STYLES_CSS],
  ["src/pages/index.html", INDEX_HTML],
  ["src/pages/privacy.html", PRIVACY_HTML],
  ["src/pages/404.html", NOT_FOUND_HTML],

  // With an adapter: the route the sign-up form posts to, next to the shared /api/hello
  ...(adapter
    ? ([
        ["src/api/waitlist.ts", WAITLIST_API_TS],
        ["src/api/waitlist.test.ts", WAITLIST_API_TEST_TS],
      ] as TemplateFile[])
    : []),

  ...component("site-head", SITE_HEAD_HTML, SITE_HEAD_TEST_TS),
  ...component("site-header", SITE_HEADER_HTML, SITE_HEADER_TEST_TS),
  ...component("section-head", SECTION_HEAD_HTML, SECTION_HEAD_TEST_TS),
  ...component("home-hero", HOME_HERO_HTML, HOME_HERO_TEST_TS),
  ...component("feature-list", FEATURE_LIST_HTML, FEATURE_LIST_TEST_TS, [
    "features.ts",
    FEATURES_TS,
  ]),
  ...component("how-it-works", HOW_IT_WORKS_HTML, HOW_IT_WORKS_TEST_TS, [
    "steps.ts",
    STEPS_TS,
  ]),
  ...component("reader-quotes", READER_QUOTES_HTML, READER_QUOTES_TEST_TS, [
    "quotes.ts",
    QUOTES_TS,
  ]),
  ...component("pricing-plans", PRICING_PLANS_HTML, PRICING_PLANS_TEST_TS, [
    "plans.ts",
    PLANS_TS,
  ]),
  ...component("faq-list", FAQ_LIST_HTML, FAQ_LIST_TEST_TS, [
    "faqs.ts",
    FAQS_TS,
  ]),
  ...component(
    "waitlist-signup",
    waitlistSignupHtml(adapter ? WAITLIST_SEND_API : WAITLIST_SEND_STATIC),
    WAITLIST_SIGNUP_TEST_TS,
  ),
  ...component("site-footer", SITE_FOOTER_HTML, SITE_FOOTER_TEST_TS),
];

/** `--template landing`: a one-page product landing page with a sign-up form. */
export const LANDING_TEMPLATE: StarterTemplate = {
  name: "landing",
  summary:
    "A product landing page: hero, features, pricing, FAQ, and a sign-up form",
  directories: landingDirectories,
  files: landingFiles,
};
