/**
 * @module templates/shop
 *
 * `--template shop`: a small bookshop. A typed catalog file becomes the home
 * page's featured books, a catalog page with client-side sort and filter, and
 * one page per book through a dynamic route. The cart lives in the browser's
 * localStorage, and the checkout is a validated address form that ends on a
 * demo confirmation page: no payment is taken.
 *
 * With an adapter the site also gets `POST /api/cart`, which prices the cart
 * from the catalog on the server; the checkout's order summary asks it instead
 * of pricing in the browser. Without one the site is fully static.
 *
 * The content is split by kind under `./shop/`: data and logic, components,
 * pages, and the tests the scaffolded project gets.
 */

import type {
  StarterTemplate,
  TemplateContext,
  TemplateFile,
} from "../scaffold.js";
import {
  BOOK_CARD_HELPER_TS,
  BOOK_CARD_HTML,
  BOOK_CATALOG_HELPER_TS,
  BOOK_CATALOG_HTML,
  BOOK_DETAIL_HTML,
  BOOK_DETAIL_TS,
  CART_LIST_HELPER_TS,
  CART_LIST_HTML,
  CART_LIST_TS,
  CHECKOUT_FORM_HTML,
  CHECKOUT_FORM_TS,
  FEATURED_BOOKS_HELPER_TS,
  FEATURED_BOOKS_HTML,
  FORM_FIELD_HTML,
  HOME_HERO_HTML,
  ORDER_CONFIRMATION_HTML,
  ORDER_SUMMARY_HELPER_TS,
  ORDER_SUMMARY_HTML,
  SHOP_SITE_FOOTER_HTML,
  SHOP_SITE_HEADER_HTML,
  SHOP_SITE_HEADER_TS,
  SHOP_SITE_META_HTML,
  SHOP_STYLES_CSS,
  PRODUCT_ART_HELPER_TS,
  PRODUCT_ART_HTML,
  orderSummaryTs,
} from "./shop/components.js";
import {
  BASCIK_CONFIG_TS,
  BROWSER_MODULES_TS,
  RACING_DB_TS,
  RACING_SQL,
  CART_API_ROUTE,
  CART_TS,
  CATALOG_BOOKS_TS,
  CATALOG_TS,
  MONEY_TS,
  SEO_TS,
  SEED_DATABASE_TS,
  SHOP_BRAND,
  TSCONFIG_JSON,
  siteTs,
} from "./shop/data.js";
import {
  SHOP_BOOK_PAGE,
  SHOP_BOOK_PAGE_TS,
  SHOP_BOOKS_PAGE,
  SHOP_CART_PAGE,
  SHOP_CHECKOUT_PAGE,
  SHOP_INDEX_PAGE,
  SHOP_NOT_FOUND_PAGE,
  SHOP_ORDER_CONFIRMED_PAGE,
} from "./shop/pages.js";
import {
  CART_TEST_TS,
  CATALOG_TEST_TS,
  MONEY_TEST_TS,
  componentTest,
  shopE2eSpec,
} from "./shop/tests.js";

/** One component: its template, the files beside it, and what its unit test checks. */
interface ShopComponent {
  name: string;
  html: string;
  /** Other files in the component's folder, by file name. */
  companions?: Record<string, string>;
  /** What the component's unit test says it does. */
  claim: string;
  /** Strings the unit test expects in the template. */
  parts: readonly string[];
}

const shopComponents = ({ adapter }: TemplateContext): ShopComponent[] => [
  {
    name: "site-meta",
    html: SHOP_SITE_META_HTML,
    claim:
      "has the shared head tags and leaves the title and description to each page",
    parts: ['charset="UTF-8"', 'name="viewport"', "favicon.svg", "styles.css"],
  },
  {
    name: "site-header",
    html: SHOP_SITE_HEADER_HTML,
    companions: { "site-header.ts": SHOP_SITE_HEADER_TS },
    claim:
      "starts with the skip link and links to the catalog and the cart with a count",
    parts: [
      'href="#main"',
      'href="/books/"',
      'href="/cart"',
      'data-testid="site-header-cart-count"',
      'src="site-header.ts"',
    ],
  },
  {
    name: "site-footer",
    html: SHOP_SITE_FOOTER_HTML,
    claim: "prints the year and the shop's name at build time",
    parts: ["data-bascik-build-once", "getFullYear", "siteName"],
  },
  {
    name: "home-hero",
    html: HOME_HERO_HTML,
    claim: "has the page's heading and a link to the catalog",
    parts: ["<h1>", 'href="/books/"'],
  },
  {
    name: "product-art",
    html: PRODUCT_ART_HTML,
    companions: { "art.ts": PRODUCT_ART_HELPER_TS },
    claim: "draws product-specific original artwork and has a text alternative",
    parts: [
      'role="img"',
      'data-bascik-attr-aria-label="label"',
      'aria-hidden="true"',
      'data-bascik-attr-data-format="format"',
      'data-bascik-attr-data-product="product"',
      'class="jacket"',
      'class="suit"',
      'class="duct"',
      'class="panel"',
      'class="chronograph"',
      'class="fasteners"',
    ],
  },
  {
    name: "book-card",
    html: BOOK_CARD_HTML,
    companions: { "card.ts": BOOK_CARD_HELPER_TS },
    claim:
      "shows a book's facts, links to its page, and takes the cover in its slot",
    parts: [
      "data-bascik-slot",
      'data-bascik-attr-href="href"',
      "data-bascik-prop-price",
      "data-bascik-prop-rating",
    ],
  },
  {
    name: "featured-books",
    html: FEATURED_BOOKS_HTML,
    companions: { "featured.ts": FEATURED_BOOKS_HELPER_TS },
    claim: "lists the featured books from the catalog at build time",
    parts: ['data-bascik-build-once src="./featured.ts"', "<h2>"],
  },
  {
    name: "book-catalog",
    html: BOOK_CATALOG_HTML,
    companions: { "listing.ts": BOOK_CATALOG_HELPER_TS },
    claim:
      "lists every product at build time and keeps its controls hidden until the script runs",
    parts: [
      'id="controls" class="controls" aria-label="Sort and filter" hidden',
      '<label for="sort">',
      '<label for="format">',
      "catalogItems",
      'role="status"',
    ],
  },
  {
    name: "book-detail",
    html: BOOK_DETAIL_HTML,
    companions: { "book-detail.ts": BOOK_DETAIL_TS },
    claim: "shows a book and an add-to-cart button that waits for its script",
    parts: [
      "<h1 data-bascik-prop-title>",
      'data-bascik-attr-data-book="slug"',
      'data-testid="book-detail-add" hidden',
      'role="status"',
      "<noscript>",
    ],
  },
  {
    name: "cart-list",
    html: CART_LIST_HTML,
    companions: {
      "lines.ts": CART_LIST_HELPER_TS,
      "cart-list.ts": CART_LIST_TS,
    },
    claim:
      "writes its lines at build time and announces changes in a live region",
    parts: [
      'data-bascik-build-once src="./lines.ts"',
      'role="status"',
      'href="/checkout"',
      "<noscript>",
    ],
  },
  {
    name: "form-field",
    html: FORM_FIELD_HTML,
    claim: "labels its input and points it at its error message",
    parts: [
      '<label for="input"',
      'aria-describedby="error"',
      "required",
      'data-bascik-attr-name="name"',
    ],
  },
  {
    name: "checkout-form",
    html: CHECKOUT_FORM_HTML,
    companions: { "checkout-form.ts": CHECKOUT_FORM_TS },
    claim: "asks for a full address and says that it is a demo",
    parts: [
      "novalidate",
      'data-bascik-prop-autocomplete="street-address"',
      'data-bascik-prop-autocomplete="postal-code"',
      'data-bascik-prop-type="email"',
      "No payment is taken",
      'role="alert"',
      'type="submit"',
    ],
  },
  {
    name: "order-summary",
    html: ORDER_SUMMARY_HTML,
    companions: {
      "lines.ts": ORDER_SUMMARY_HELPER_TS,
      "order-summary.ts": orderSummaryTs(adapter),
    },
    claim: "writes its lines at build time and links back to the cart",
    parts: [
      'data-bascik-build-once src="./lines.ts"',
      'href="/cart"',
      'role="status"',
    ],
  },
  {
    name: "order-confirmation",
    html: ORDER_CONFIRMATION_HTML,
    claim: "says plainly that no payment was taken and where to add a provider",
    parts: [
      "No payment is taken; connect a payment provider here.",
      "checkout-form.ts",
    ],
  },
];

const shopDirectories = (context: TemplateContext): string[] => [
  "catalog",
  "data",
  "scripts",
  "src/lib",
  "src/browser",
  "src/pages/css",
  "src/pages/books",
  ...shopComponents(context).map(({ name }) => `src/components/${name}`),
];

const shopFiles = (context: TemplateContext): TemplateFile[] => [
  // Root: the exec step that publishes the browser modules, and editor types
  ["bascik.config.ts", BASCIK_CONFIG_TS],
  ["tsconfig.json", TSCONFIG_JSON],
  ["scripts/browser-modules.ts", BROWSER_MODULES_TS],
  ["scripts/seed-database.ts", SEED_DATABASE_TS],
  ["data/racing.sql", RACING_SQL],

  // The catalog, and the logic every page shares
  ["catalog/books.ts", CATALOG_BOOKS_TS],
  ["src/lib/site.ts", siteTs(SHOP_BRAND)],
  ["src/lib/catalog.ts", CATALOG_TS],
  ["src/lib/catalog.test.ts", CATALOG_TEST_TS],
  ["src/lib/seo.ts", SEO_TS],
  ["src/lib/racing-db.ts", RACING_DB_TS],

  // The cart and price rules, which the browser gets too (/js/cart.js, /js/money.js)
  ["src/browser/cart.ts", CART_TS],
  ["src/browser/cart.test.ts", CART_TEST_TS],
  ["src/browser/money.ts", MONEY_TS],
  ["src/browser/money.test.ts", MONEY_TEST_TS],

  // With an adapter: the server prices the cart, next to the shared /api/hello route
  ...(context.adapter
    ? ([["src/api/cart.ts", CART_API_ROUTE]] as TemplateFile[])
    : []),

  // Global CSS
  ["src/pages/css/styles.css", SHOP_STYLES_CSS],

  // Pages
  ["src/pages/index.html", SHOP_INDEX_PAGE],
  ["src/pages/books/index.html", SHOP_BOOKS_PAGE],
  ["src/pages/books/[slug].html", SHOP_BOOK_PAGE],
  ["src/pages/books/book-page.ts", SHOP_BOOK_PAGE_TS],
  ["src/pages/cart.html", SHOP_CART_PAGE],
  ["src/pages/checkout.html", SHOP_CHECKOUT_PAGE],
  ["src/pages/order-confirmed.html", SHOP_ORDER_CONFIRMED_PAGE],
  ["src/pages/404.html", SHOP_NOT_FOUND_PAGE],

  // Components, each with its unit test
  ...shopComponents(context).flatMap(
    ({ name, html, companions = {}, claim, parts }): TemplateFile[] => [
      [`src/components/${name}/${name}.html`, html],
      ...Object.entries(companions).map(([file, data]): TemplateFile => [
        `src/components/${name}/${file}`,
        data,
      ]),
      [
        `src/components/${name}/${name}.test.ts`,
        componentTest(name, claim, parts),
      ],
    ],
  ),

  ["e2e/app.spec.ts", shopE2eSpec(context.adapter)],
];

/** `--template shop`: a racing-inspired retail store with a catalog, cart and demo checkout. */
export const SHOP_TEMPLATE: StarterTemplate = {
  name: "shop",
  scripts: {
    "db:seed": "node scripts/seed-database.ts",
    predev: "npm run db:seed",
    prebuild: "npm run db:seed",
  },
  summary:
    "A shop: a product catalog, product pages, a cart, and a demo checkout",
  directories: shopDirectories,
  files: shopFiles,
};
