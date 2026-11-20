/**
 * @module templates/reports
 *
 * The `reports` template: a reporting site. Each JSON file in `data/reports/`
 * is one period (the demo data is four months of fictional Bascik endurance racing) and
 * becomes one report page through a dynamic route, with an executive summary,
 * inline SVG charts, data tables and notes. A home page
 * lists the reports, a comparison page adds them up, a post-phase exec script
 * writes a CSV file per report into the build output, and the stylesheet
 * prints a report as a document.
 *
 * The report bodies render from SQLite on Node and D1 on Cloudflare. The
 * Netlify variant stays static; all variants build their URLs and CSVs from JSON.
 *
 * The site's files are text in `reports/lib.ts`, `reports/components.ts` and
 * `reports/site.ts`; the demo data is built by `reports/data.ts`.
 */

import type {
  StarterTemplate,
  TemplateContext,
  TemplateFile,
} from "../scaffold.js";
import { componentFiles } from "./reports/components.js";
import {
  DATA_FILES,
  RACING_DB_TS,
  RACING_DB_TEST_TS,
  RACING_SQL,
  SEED_DATABASE_TS,
} from "./reports/data.js";
import { SITE_META_HTML_WITHOUT_DESCRIPTION } from "./reports/derived.js";
import { LIB_FILES } from "./reports/lib.js";
import { siteFiles } from "./reports/site.js";

/**
 * `src/lib/site.ts`: the one place the site name is written. It is a JSON
 * string, which is a valid TypeScript string whatever the name contains, and
 * the site prints it through `html` from `@bascik/bascik/html`, which escapes
 * it for the page. No page of this template carries the name itself.
 */
export const siteModule = (siteName: string): string =>
  `// src/lib/site.ts: the facts every page shares. Print the name with html from @bascik/bascik/html.

/** The site's name, shown in the header, the footer and every page title. */
export const siteName: string = ${JSON.stringify(siteName)};

/** Where the report data lives, relative to the project root: one JSON file per period. */
export const REPORTS_DIR = "data/reports";
`;

const reportsFiles = ({
  siteName,
  adapter,
}: TemplateContext): TemplateFile[] => [
  ["data/racing.sql", RACING_SQL],
  ["scripts/seed-database.ts", SEED_DATABASE_TS],
  ["src/lib/racing-db.ts", RACING_DB_TS],
  ["src/lib/racing-db.test.ts", RACING_DB_TEST_TS],
  ...DATA_FILES,
  ["src/lib/site.ts", siteModule(siteName)],
  ...LIB_FILES,
  [
    "src/components/site-meta/site-meta.html",
    SITE_META_HTML_WITHOUT_DESCRIPTION,
  ],
  ...componentFiles(adapter === "netlify"),
  ...siteFiles(adapter === "netlify"),
];

/** Every folder a file of the template sits in. */
const reportsDirectories = (context: TemplateContext): string[] => [
  ...new Set(
    reportsFiles(context)
      .map(([path]) => path.slice(0, path.lastIndexOf("/")))
      .filter((folder) => folder !== ""),
  ),
];

/** A reporting site: one report page per data file, with charts, tables, CSV downloads and print styles. */
export const REPORTS_TEMPLATE: StarterTemplate = {
  name: "reports",
  gitignoreEntries: ["data/racing.db"],
  scripts: {
    "db:seed": "node scripts/seed-database.ts",
    predev: "npm run db:seed",
    prebuild: "npm run db:seed",
    pree2e: "npm run db:seed",
  },
  summary:
    "A reporting site: dated reports from data files, SVG charts, CSV downloads, and print styles",
  directories: reportsDirectories,
  files: reportsFiles,
};
