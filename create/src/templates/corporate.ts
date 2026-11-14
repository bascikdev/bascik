/**
 * @module templates/corporate
 *
 * The `corporate` template: a multi-page company site for an invented
 * publishing-services firm. Home, a services index with one page per service
 * (a dynamic route over typed data), about, careers, news, contact, two legal
 * placeholders and a 404.
 *
 * The generated files live in `corporate/`, one module per area, each a list
 * of `[path, content]` pairs written as the file ships:
 *
 * - `lib.ts`: `bascik.config.ts` and `src/lib/` (company facts, services,
 *   navigation, head tags, the data check).
 * - `components.ts`: `src/components/`, with each component's data beside it.
 * - `pages.ts`: `src/pages/` and the CSS added to the default stylesheet.
 * - `tests.ts`: the generated project's Vitest files and Playwright spec.
 *
 * The site name is written once, as a JSON string in `src/lib/site.ts`; no
 * page holds it, so nothing here needs `escapeHtml`. The site is static, so an
 * adapter changes nothing: the shared `/api/hello` route is all it adds.
 */

import {
  STYLES_CSS,
  type StarterTemplate,
  type TemplateContext,
  type TemplateFile,
} from "../scaffold.js";
import { COMPONENT_FILES } from "./corporate/components.js";
import { LIB_FILES, siteModule } from "./corporate/lib.js";
import { CORPORATE_CSS, PAGE_FILES } from "./corporate/pages.js";
import { TEST_FILES } from "./corporate/tests.js";

/** The files the corporate template writes as its own, relative to the project root. */
const corporateFiles = ({ siteName }: TemplateContext): TemplateFile[] => [
  ...LIB_FILES,
  ["src/lib/site.ts", siteModule(siteName)],
  ["src/pages/css/styles.css", STYLES_CSS + CORPORATE_CSS],
  ...PAGE_FILES,
  ...COMPONENT_FILES,
  ...TEST_FILES,
];

/** Every folder a file sits in. `scaffold` makes `e2e/` itself, and root files need none. */
const corporateDirectories = (context: TemplateContext): string[] => [
  ...new Set(
    corporateFiles(context)
      .map(([path]) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)))
      .filter((folder) => folder !== "" && folder !== "e2e"),
  ),
];

/** `--template corporate`: a company site whose services, roles and news come from typed data. */
export const CORPORATE_TEMPLATE: StarterTemplate = {
  name: "corporate",
  summary: "A company site: services, about, careers, news, and contact pages",
  directories: corporateDirectories,
  files: corporateFiles,
};
