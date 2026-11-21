/**
 * @module templates/dashboard
 *
 * The `dashboard` template: the back office of an invented bookshop, done
 * without a client framework or a chart library.
 *
 * What renders where, and why:
 *
 * - **Build time.** Every page, the stat tiles, both charts (inline SVG from
 *   `src/lib/charts.ts`), every table row and the per-title pages
 *   (`src/pages/titles/[slug].html`, a dynamic route) come from build scripts
 *   reading the seeded data in `src/lib/shop.ts`. A plain `bascik --build`
 *   on a static host is a complete dashboard.
 * - **Per request.** One piece, `<live-orders>`: a `data-bascik-stream`
 *   script returns a `<stat-tile>` after the rest of the page has been sent.
 *   The build prints a snapshot tile before it, so where no server runs
 *   (a static host) the snapshot stays and nothing is broken. It runs under
 *   `bascik`, `bascik --server`, and the Cloudflare and Netlify adapters.
 * - **In the browser.** Small scoped scripts only: sorting, filtering and
 *   paging the orders table (rows the build already printed), the settings
 *   form (saved to localStorage, a demo), the header's phone menu and the
 *   theme toggle.
 *
 * No authentication: the generated `src/pages/index.html` says where a real
 * dashboard needs it. The template is the same with and without an adapter.
 */

import type {
  StarterTemplate,
  TemplateContext,
  TemplateFile,
} from "../scaffold.js";
import { E2E_FILES } from "./dashboard/e2e.js";
import { LIB_FILES } from "./dashboard/lib.js";
import { OVERVIEW_FILES } from "./dashboard/overview.js";
import { PAGE_FILES } from "./dashboard/pages.js";
import { SETTINGS_FILES } from "./dashboard/settings.js";
import { SHELL_FILES } from "./dashboard/shell.js";
import { TABLE_FILES } from "./dashboard/tables.js";

/**
 * `src/lib/site.ts`: the one place the site's name is written. It is a JSON
 * string in a TypeScript module, so any name is a valid literal, and the
 * pages print it through `html` from `@bascik/bascik/html`, which escapes it.
 * No page of this template holds the name as markup.
 */
export const siteModule = (
  siteName: string,
): string => `import { html, type SafeHtml } from "@bascik/bascik/html";

/** The site's name, written once. The header and every page title print it through \`html\`, which escapes it. */
export const SITE_NAME: string = ${JSON.stringify(siteName)};

/** A page's \`<title>\`: the page's own name, then the site's. */
export const pageTitle = (page: string): SafeHtml =>
  html\`<title>\${page} - \${SITE_NAME}</title>\`;
`;

const STATIC_FILES: readonly TemplateFile[] = [
  ...E2E_FILES,
  ...LIB_FILES,
  ...PAGE_FILES,
  ...SHELL_FILES,
  ...OVERVIEW_FILES,
  ...TABLE_FILES,
  ...SETTINGS_FILES,
];

const dashboardFiles = ({ siteName }: TemplateContext): TemplateFile[] => [
  ["src/lib/site.ts", siteModule(siteName)],
  ...STATIC_FILES,
];

/** The folder of each file the template writes, once each. The project root needs no entry. */
const dashboardDirectories = (context: TemplateContext): string[] => [
  ...new Set(
    dashboardFiles(context)
      .map(([path]) => path.slice(0, Math.max(0, path.lastIndexOf("/"))))
      .filter((folder) => folder !== ""),
  ),
];

/** An admin dashboard for a bookshop: stat tiles, SVG charts, a sortable orders table, and a settings form. */
export const DASHBOARD_TEMPLATE: StarterTemplate = {
  name: "dashboard",
  summary:
    "A dashboard: stat tiles, SVG charts, a sortable data table, and a settings page",
  scripts: {
    "db:seed": "node scripts/seed-database.ts",
    predev: "npm run db:seed",
    prebuild: "npm run db:seed",
  },
  gitignoreEntries: ["data/racing.db"],
  directories: dashboardDirectories,
  files: dashboardFiles,
};
