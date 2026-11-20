/**
 * @module templates
 *
 * The kinds of site `--template` can scaffold. To add one, write its module in
 * `create/src/templates/<name>.ts` and add it to `TEMPLATES` below; the CLI's
 * choices, its help text and the tests that scaffold and build every template
 * read this list. See "Adding a template" in docs/content/internals/create-app.md.
 */

import { DEFAULT_TEMPLATE, type StarterTemplate } from "./scaffold.js";
import { BLOG_TEMPLATE } from "./templates/blog.js";
import { DOCS_TEMPLATE } from "./templates/docs.js";
import { LANDING_TEMPLATE } from "./templates/landing.js";
import { PORTFOLIO_TEMPLATE } from "./templates/portfolio.js";
import { CORPORATE_TEMPLATE } from "./templates/corporate.js";
import { SHOP_TEMPLATE } from "./templates/shop.js";
import { REPORTS_TEMPLATE } from "./templates/reports.js";

/** Every template, the default first. Keep one entry per line: each template is added in its own change. */
export const TEMPLATES: readonly StarterTemplate[] = [
  DEFAULT_TEMPLATE,
  BLOG_TEMPLATE,
  DOCS_TEMPLATE,
  LANDING_TEMPLATE,
  PORTFOLIO_TEMPLATE,
  CORPORATE_TEMPLATE,
  SHOP_TEMPLATE,
  REPORTS_TEMPLATE,
];

/** Other names a template answers to. `static` is the default: it is a plain static site. */
export const TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  static: "default",
};

/** The template with this name or alias, compared without case, or undefined. */
export const templateNamed = (name: string): StarterTemplate | undefined => {
  const wanted = name.toLowerCase();
  const resolved = Object.hasOwn(TEMPLATE_ALIASES, wanted)
    ? TEMPLATE_ALIASES[wanted]
    : wanted;
  return TEMPLATES.find((template) => template.name === resolved);
};
