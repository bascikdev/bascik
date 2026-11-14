/**
 * The corporate template's root config and shared modules (`src/lib/`): the company facts, the services, the
 * navigation, the head tags and the check every data list goes through. Each string is a file of the generated
 * site, written as it ships.
 */

import type { TemplateFile } from "../../scaffold.js";

export const LIB_FILES: TemplateFile[] = [
  [
    "bascik.config.ts",
    `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // The services, the navigation and the head tags live in src/lib/. Rebuild pages in dev when one changes.
    watchPaths: ["src/lib/"],
  },
});
`,
  ],
  [
    "src/lib/collection.ts",
    `// collection.ts: checks a data list (services, open roles, news) before any page prints it. A mistake in the data
// throws here with the list, the entry and the field, so \`bascik --build\` fails instead of shipping a page with a
// hole in it. Node strips the types without checking them, so the check has to run.

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

/**
 * The entries, unchanged, once each has every required field and its own slug. \`name\` is what the error calls the
 * list, such as "services"; \`file\` is where to fix it.
 */
export function checked<T extends { slug: string }>(
  name: string,
  file: string,
  entries: readonly T[],
  required: readonly (keyof T & string)[],
): T[] {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const fields = (entry ?? {}) as Record<string, unknown>;
    const { slug } = fields;
    const where =
      typeof slug === "string" && slug
        ? \`\${name}[\${index}] ("\${slug}")\`
        : \`\${name}[\${index}]\`;
    for (const field of ["slug", ...required]) {
      if (isEmpty(fields[field])) {
        throw new Error(
          \`\${where}: "\${field}" is missing or empty. Fill it in \${file}.\`,
        );
      }
    }
    if (typeof slug !== "string" || !SLUG.test(slug)) {
      throw new Error(
        \`\${where}: the slug must be lowercase letters, digits and single hyphens, because it becomes part of a URL. Fix it in \${file}.\`,
      );
    }
    const first = seen.get(slug);
    if (first !== undefined) {
      throw new Error(
        \`\${name}[\${index}]: the slug "\${slug}" is already used by \${name}[\${first}]. Give each entry its own slug in \${file}.\`,
      );
    }
    seen.set(slug, index);
  });
  return [...entries];
}
`,
  ],
  [
    "src/lib/navigation.ts",
    `// navigation.ts: every link the header and the footer show, and the breadcrumb trail of each page. Edit the lists
// here; the header menu, the footer columns, the breadcrumbs and the BreadcrumbList structured data all follow.
// navigation.test.ts fails when a link here points at a page that does not exist.
import { SERVICES, servicePath } from "./services.ts";

export interface NavLink {
  label: string;
  href: string;
}

/** A top-level link. With \`children\` the header shows them in a menu under it. */
export interface NavItem extends NavLink {
  children?: NavLink[];
}

export interface FooterGroup {
  heading: string;
  links: NavLink[];
}

const SERVICE_LINKS: NavLink[] = SERVICES.map((service) => ({
  label: service.name,
  href: servicePath(service),
}));

export const PRIMARY_NAV: NavItem[] = [
  { label: "Services", href: "/services/", children: SERVICE_LINKS },
  { label: "About", href: "/about" },
  { label: "Careers", href: "/careers" },
  { label: "News", href: "/news" },
  { label: "Contact", href: "/contact" },
];

export const FOOTER_GROUPS: FooterGroup[] = [
  { heading: "Services", links: SERVICE_LINKS },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Careers", href: "/careers" },
      { label: "News", href: "/news" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

/** "/services/" and "/services" compare equal; "/" stays "/". */
export const normalizePath = (path: string): string =>
  path.length > 1 ? path.replace(/\\/+$/, "") : path;

/** Every link in the header and the footer, once per page it points at. */
export function allLinks(
  primary: NavItem[] = PRIMARY_NAV,
  footer: FooterGroup[] = FOOTER_GROUPS,
): NavLink[] {
  const links = [
    ...primary.flatMap((item) => [item, ...(item.children ?? [])]),
    ...footer.flatMap((group) => group.links),
  ];
  const byPath = new Map<string, NavLink>();
  for (const { label, href } of links) {
    const path = normalizePath(href);
    if (!byPath.has(path)) byPath.set(path, { label, href });
  }
  return [...byPath.values()];
}

/** "page" when \`href\` is the page being built, "true" when it is the section that page is in. */
export function currentState(
  href: string,
  pagePath: string,
): "page" | "true" | undefined {
  const target = normalizePath(href);
  const current = normalizePath(pagePath);
  if (target === current) return "page";
  return target !== "/" && current.startsWith(\`\${target}/\`)
    ? "true"
    : undefined;
}

/**
 * The breadcrumb trail of a page, from the home page down: "/services/distribution" gives Home, Services,
 * Distribution. Labels come from the links above, so a page that is in no list throws with its path.
 */
export function trail(pagePath: string, links = allLinks()): NavLink[] {
  const crumbs: NavLink[] = [{ label: "Home", href: "/" }];
  let path = "";
  for (const segment of normalizePath(pagePath).split("/").filter(Boolean)) {
    path += \`/\${segment}\`;
    const link = links.find(({ href }) => normalizePath(href) === path);
    if (!link) {
      throw new Error(
        \`No navigation entry for "\${path}", so the breadcrumb of "\${pagePath}" has no label for it. Add the page to PRIMARY_NAV or FOOTER_GROUPS in src/lib/navigation.ts.\`,
      );
    }
    crumbs.push(link);
  }
  return crumbs;
}
`,
  ],
  [
    "src/lib/seo.ts",
    `// seo.ts: the head tags of every page, written at build time. A page calls pageHead() from its <head>:
//
//   <script data-bascik-build type="text/typescript">
//     import { pageHead } from "@/lib/seo.ts";
//     export default () => pageHead({ title: "About", description: "Who we are and how we work." });
//   </script>
//
// Absolute URLs come from BASCIK_SITE_URL (set it per deployment or in .env, never in bascik.config.ts). The tags
// are built with html from @bascik/bascik/html, which escapes every value for where it lands.
import { html, json, type SafeHtml } from "@bascik/bascik/html";
import { trail } from "./navigation.ts";
import { SITE } from "./site.ts";

export interface PageHeadOptions {
  /** The page's name, such as "About". The site name is added after it. */
  title: string;
  /** One or two sentences for search results, roughly 50 to 160 characters. */
  description: string;
  /** The whole <title>, for the home page, where the site name leads. */
  fullTitle?: string;
  /**
   * Keep the page out of search results. Also write <meta name="bascik-sitemap" content="exclude" /> in the page
   * source: Bascik reads the source file, not this script's output, to decide what sitemap.xml lists.
   */
  noindex?: boolean;
  /** Structured data for this page, beyond its breadcrumb. */
  schema?: Record<string, unknown>[];
}

/** The site origin without a trailing slash, or undefined when BASCIK_SITE_URL is not set, as in dev. */
export const siteUrl = (): string | undefined =>
  process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "") || undefined;

/** The path of the page being built, such as "/" or "/services/distribution". */
export const pagePath = (): string => process.env.BASCIK_PAGE_PATH || "/";

/** The absolute URL of a site path. Without a site URL it is the root-relative path, base included. */
export function absoluteUrl(path: string): string {
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  const withBase = \`\${base}\${path.startsWith("/") ? path : \`/\${path}\`}\`;
  return \`\${siteUrl() ?? ""}\${withBase}\`;
}

/** One JSON-LD block. json() escapes <, > and &, so a value can never close the script tag. */
export function jsonLd(data: Record<string, unknown>): SafeHtml {
  const body = json({ "@context": "https://schema.org", ...data });
  return html\`<script type="application/ld+json">
    \${body}
  </script>\`;
}

/** BreadcrumbList data for a page below the home page, or undefined for the home page itself. */
export function breadcrumbList(
  path: string,
): Record<string, unknown> | undefined {
  const crumbs = trail(path);
  if (crumbs.length < 2) return undefined;
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.label,
      item: absoluteUrl(crumb.href),
    })),
  };
}

/** Organization data for the home page. It repeats only what the footer shows on that page. */
export function organization(): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: SITE.name,
    description: SITE.description,
    email: SITE.email,
    telephone: SITE.phone.display,
    ...(siteUrl() ? { url: absoluteUrl("/") } : {}),
  };
}

/** The title, description, canonical URL, social tags and structured data of one page. */
export function pageHead(options: PageHeadOptions): SafeHtml {
  const title = options.fullTitle ?? \`\${options.title} - \${SITE.name}\`;
  const { description } = options;
  // A canonical URL must be absolute, so it is written only when the site URL is known. A page kept out of
  // search results, such as the 404 page, has no address of its own to name and no place in the breadcrumbs.
  const url =
    siteUrl() && !options.noindex ? absoluteUrl(pagePath()) : undefined;
  const breadcrumbs = options.noindex ? undefined : breadcrumbList(pagePath());
  const schema = [
    ...(options.schema ?? []),
    ...(breadcrumbs ? [breadcrumbs] : []),
  ];
  return html\`<title>\${title}</title>
    <meta name="description" content="\${description}" />
    \${options.noindex ? html\`<meta name="robots" content="noindex" />\` : ""}
    \${url ? html\`<link rel="canonical" href="\${url}" />\` : ""}
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="\${SITE.name}" />
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${description}" />
    \${url ? html\`<meta property="og:url" content="\${url}" />\` : ""}
    <meta name="twitter:card" content="summary" />
    \${schema.map((data) => jsonLd(data))}\`;
}
`,
  ],
  [
    "src/lib/services.ts",
    `// services.ts: the services the company sells. Each entry becomes a card on the home page and on /services/, a
// link in the header menu and the footer, and its own page at /services/<slug> (src/pages/services/[slug].html).
// To add a service, add an entry: nothing else needs editing.
import { checked } from "./collection.ts";

export interface ServiceStep {
  title: string;
  text: string;
}

export interface Service {
  /** The last part of the page's URL: lowercase letters, digits and hyphens. */
  slug: string;
  name: string;
  /** One or two sentences: the card text, the page's intro and its meta description (50 to 160 characters). */
  summary: string;
  /** A paragraph for the service's own page. */
  description: string;
  includes: string[];
  steps: ServiceStep[];
  turnaround: string;
}

export const SERVICES: Service[] = checked<Service>(
  "services",
  "src/lib/services.ts",
  [
    {
      slug: "manuscript-editing",
      name: "Manuscript editing",
      summary:
        "Developmental edits, line edits and proofreading from editors who read in your genre, with every change tracked.",
      description:
        "An editor matched to your genre reads the whole manuscript before suggesting a single change. You get an editorial letter, tracked changes you can accept one by one, and a final proofread after typesetting.",
      includes: [
        "An editorial letter on structure, pacing and character",
        "A line edit with every change tracked",
        "A style sheet for names, places and spelling choices",
        "A proofread of the typeset pages",
      ],
      steps: [
        {
          title: "Sample edit",
          text: "We edit your first chapter so you can see the approach before you commit.",
        },
        {
          title: "Full edit",
          text: "Your editor works through the manuscript and sends the letter and tracked changes.",
        },
        {
          title: "Revision call",
          text: "You talk through the notes together and agree on what to change.",
        },
      ],
      turnaround: "Four to six weeks for a novel of 90,000 words.",
    },
    {
      slug: "book-design",
      name: "Cover and interior design",
      summary:
        "A cover that reads at thumbnail size and pages that are comfortable to read, in print and e-book formats.",
      description:
        "A designer builds the cover and the interior together, so the title page, chapter openers and spine belong to the same book. Files are delivered ready for print-on-demand, offset printing and e-book stores.",
      includes: [
        "Three cover concepts and two rounds of revisions",
        "A typeset interior for print and a reflowable e-book",
        "Print-ready files with the spine width set for your page count",
        "Store graphics sized for retailer listings",
      ],
      steps: [
        {
          title: "Brief",
          text: "You share comparable titles, your audience and anything you already love or dislike.",
        },
        {
          title: "Concepts",
          text: "We present three directions and refine the one you choose.",
        },
        {
          title: "Typesetting",
          text: "The interior is set, proofread and exported for each format.",
        },
      ],
      turnaround: "Three weeks from brief to final files.",
    },
    {
      slug: "distribution",
      name: "Distribution",
      summary:
        "Your book listed with online stores, libraries and independent bookshops, with metadata that helps readers find it.",
      description:
        "We register the book, write its metadata and deliver it to retailers, library suppliers and wholesalers. You keep the rights and the accounts: we manage the listings and keep them accurate.",
      includes: [
        "ISBN registration and a complete metadata record",
        "Delivery to online stores and library suppliers",
        "Wholesale terms that independent bookshops can order on",
        "Price and category changes within two working days",
      ],
      steps: [
        {
          title: "Setup",
          text: "We collect your files, categories and pricing for each market.",
        },
        {
          title: "Delivery",
          text: "Listings go out to every channel and we check each one once it is live.",
        },
        {
          title: "Upkeep",
          text: "We handle price changes, new editions and seasonal promotions.",
        },
      ],
      turnaround: "Listings are live within ten working days.",
    },
    {
      slug: "royalty-accounting",
      name: "Royalty accounting",
      summary:
        "One clear statement each quarter across every store and format, with co-author and illustrator splits calculated for you.",
      description:
        "Sales reports arrive from each channel in a different shape. We reconcile them into one statement per title, apply the splits in your contracts and prepare the year-end figures your accountant asks for.",
      includes: [
        "A quarterly statement per title and per format",
        "Splits for co-authors, illustrators and translators",
        "Currency conversion at the rate on the payment date",
        "A year-end summary for your tax return",
      ],
      steps: [
        {
          title: "Connect",
          text: "You give us read-only access to each sales channel.",
        },
        {
          title: "Reconcile",
          text: "We match every payment to the units sold and flag anything that does not add up.",
        },
        {
          title: "Report",
          text: "Statements arrive within three weeks of the quarter closing.",
        },
      ],
      turnaround: "Your first statement covers the current quarter.",
    },
  ],
  ["name", "summary", "description", "includes", "steps", "turnaround"],
);

/** The URL of a service's own page. */
export const servicePath = (service: Pick<Service, "slug">): string =>
  \`/services/\${service.slug}\`;
`,
  ],
];

/**
 * `src/lib/site.ts`, the one file the site name is written into. It is a JSON string there, which is also a valid
 * TypeScript string for any name, and the site prints it through `@bascik/bascik/html`.
 */
export const siteModule = (siteName: string): string =>
  `// site.ts: the facts several components show, written once. The header, the footer, the contact page and the
// head tags all read this file, so a new phone number is one edit. Components print these values with html from
// @bascik/bascik/html, which escapes them for where they land.

/** The company name, shown in the header, the footer, every page title and the structured data. */
export const SITE_NAME: string = ${JSON.stringify(siteName)};

export const SITE = {
  name: SITE_NAME,
  tagline: "Publishing services for independent authors",
  description:
    "Editing, design, distribution and royalty accounting for independent authors and small presses, from one team.",
  email: "hello@example.com",
  phone: { display: "+1 (555) 010-0142", href: "tel:+15550100142" },
  address: {
    street: "48 Bindery Lane, Suite 3",
    city: "Portland",
    region: "OR",
    postalCode: "97209",
    country: "United States",
  },
  hours: "Monday to Friday, 9 a.m. to 5 p.m. Pacific",
};
`;
