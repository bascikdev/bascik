/**
 * @module templates/shop/data
 *
 * The shop template's data and logic files: the catalog, the modules under
 * `src/lib/`, the exec script that publishes three of them to the browser, and
 * the two root config files the site needs.
 */

/**
 * The catalog: the one file a shop owner edits to change what is for sale.
 * Every title and author is invented. Prices are whole cents.
 */
export const CATALOG_BOOKS_TS = `// The catalog: every book the shop sells. Add, remove or edit entries here and the
// home page, the catalog page, one page per book, the sitemap and the cart follow.
//
// Prices are whole cents (1499 is $14.99), so sums never pick up rounding errors.
// src/lib/catalog.ts checks every entry, and a mistake fails the build naming the entry.
// This file is also published to the browser as /js/books.js (scripts/browser-modules.ts),
// so keep it to plain data: no imports except types, and nothing private.
import type { Book } from "../src/lib/catalog.ts";

export const books: Book[] = [
  {
    slug: "the-lantern-orchard",
    title: "The Lantern Orchard",
    author: "Marisol Vance",
    format: "Hardcover",
    priceCents: 2400,
    rating: 4.7,
    tone: "plum",
    featured: true,
    description:
      "Three sisters inherit an orchard that only fruits at night, and a ledger of debts their grandmother never mentioned.",
  },
  {
    slug: "salt-and-cinder",
    title: "Salt and Cinder",
    author: "Tobias Renn",
    format: "Paperback",
    priceCents: 1650,
    rating: 4.3,
    tone: "rust",
    featured: true,
    description:
      "A lighthouse keeper and a runaway glassblower rebuild a harbor town one winter storm at a time.",
  },
  {
    slug: "a-field-guide-to-quiet-rivers",
    title: "A Field Guide to Quiet Rivers",
    author: "Ingrid Halloway",
    format: "Hardcover",
    priceCents: 2800,
    rating: 4.8,
    tone: "teal",
    featured: true,
    description:
      "Forty slow rivers, the birds that keep to them, and hand-drawn maps for walking each one from source to mouth.",
  },
  {
    slug: "night-trains-to-nowhere",
    title: "Night Trains to Nowhere",
    author: "Dev Okonjo",
    format: "Paperback",
    priceCents: 1499,
    rating: 4.1,
    tone: "ink",
    description:
      "Eleven linked stories set on sleeper trains whose timetables never quite agree with the stations.",
  },
  {
    slug: "the-cartographer-of-small-hours",
    title: "The Cartographer of Small Hours",
    author: "Priya Castellan",
    format: "Ebook",
    priceCents: 999,
    rating: 4.5,
    tone: "moss",
    description:
      "An insomniac mapmaker charts her city between midnight and dawn and finds a street that is only there at 3 a.m.",
  },
  {
    slug: "bread-for-the-long-winter",
    title: "Bread for the Long Winter",
    author: "Anselm Dray",
    format: "Hardcover",
    priceCents: 3200,
    rating: 4.9,
    tone: "sand",
    description:
      "Sixty loaves for cold months, from a two-day rye to a skillet flatbread, with a starter schedule that forgives a missed feeding.",
  },
  {
    slug: "seventeen-ways-to-fold-a-map",
    title: "Seventeen Ways to Fold a Map",
    author: "Odalys Finch",
    format: "Paperback",
    priceCents: 1500,
    rating: 3.9,
    tone: "rust",
    description:
      "Essays on getting lost on purpose, written across seventeen cities and one very long ferry crossing.",
  },
  {
    slug: "the-glass-tide",
    title: "The Glass Tide",
    author: "Rowan Achterberg",
    format: "Ebook",
    priceCents: 850,
    rating: 4.2,
    tone: "teal",
    description:
      "When the sea around an island freezes clear overnight, its children are the first to walk out and see what lies beneath.",
  },
];
`;

/** The site name, written once. `JSON.stringify` makes any name a valid string literal. */
export const siteTs = (
  siteName: string,
): string => `// Facts about the shop that several pages and components print.
// Build scripts print them with html from @bascik/bascik/html, which escapes them.

/** The shop's name: in the header, the footer, and every page title. */
export const siteName = ${JSON.stringify(siteName)};
`;

export const CATALOG_TS = `// The catalog's types, its checks, and the lookups pages use.
// The data itself is in catalog/books.ts.
import { books as entries } from "../../catalog/books.ts";

export const FORMATS = ["Hardcover", "Paperback", "Ebook"] as const;
export type Format = (typeof FORMATS)[number];

/** Cover colors, defined in src/components/book-cover/book-cover.html. */
export const TONES = ["plum", "rust", "teal", "ink", "moss", "sand"] as const;
export type Tone = (typeof TONES)[number];

export interface Book {
  /** The last part of the book's URL (/books/<slug>) and its id in the cart. */
  slug: string;
  title: string;
  author: string;
  description: string;
  format: Format;
  /** The price in whole cents: 1499 is $14.99. */
  priceCents: number;
  /** From 0 to 5. */
  rating: number;
  tone: Tone;
  /** Shown on the home page. */
  featured?: boolean;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT_FIELDS = ["slug", "title", "author", "description"] as const;

/**
 * The catalog, checked. A bad entry throws an error that names it, which fails
 * \`bascik --build\` (and shows on the page in dev) before a broken product page ships.
 */
export function validateCatalog(entries: unknown): Book[] {
  if (!Array.isArray(entries)) {
    throw new Error("catalog/books.ts: \\"books\\" must be an array of books.");
  }
  const seen = new Set<string>();
  return entries.map((entry: unknown, index): Book => {
    const item = (
      typeof entry === "object" && entry !== null ? entry : {}
    ) as Record<string, unknown>;
    const label = JSON.stringify(item.slug ?? item.title ?? "no slug or title");
    const fail = (problem: string): never => {
      throw new Error(\`catalog/books.ts: item \${index + 1} (\${label}) \${problem}\`);
    };
    for (const field of TEXT_FIELDS) {
      const value = item[field];
      if (typeof value !== "string" || value.trim() === "") {
        fail(\`is missing "\${field}".\`);
      }
    }
    const slug = item.slug as string;
    if (!SLUG.test(slug)) {
      fail("has a slug that is not lowercase letters, digits and single hyphens.");
    }
    if (seen.has(slug)) {
      fail("repeats the slug of an earlier item. Each book needs its own.");
    }
    seen.add(slug);
    const price = item.priceCents;
    if (typeof price !== "number" || !Number.isSafeInteger(price) || price <= 0) {
      fail(
        \`needs "priceCents" as a whole number of cents above zero, such as 1499 for $14.99. Got \${JSON.stringify(price)}.\`,
      );
    }
    if (!(FORMATS as readonly unknown[]).includes(item.format)) {
      fail(\`needs "format" to be one of: \${FORMATS.join(", ")}.\`);
    }
    const rating = item.rating;
    if (typeof rating !== "number" || !(rating >= 0 && rating <= 5)) {
      fail('needs "rating" as a number from 0 to 5.');
    }
    if (!(TONES as readonly unknown[]).includes(item.tone)) {
      fail(\`needs "tone" to be one of: \${TONES.join(", ")}.\`);
    }
    return item as unknown as Book;
  });
}

export const books: Book[] = validateCatalog(entries);

export const findBook = (slug: string | undefined): Book | undefined =>
  books.find((book) => book.slug === slug);

/** The book's page. Build the path here so every link agrees. */
export const bookPath = (book: Pick<Book, "slug">): string =>
  \`/books/\${book.slug}\`;
`;

export const MONEY_TS = `// The one place a price becomes text. Prices are whole cents everywhere else.
// scripts/browser-modules.ts publishes this file to the browser as /js/money.js,
// so it must not import anything.

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** 1499 becomes "$14.99". */
export const formatCents = (cents: number): string =>
  dollars.format(cents / 100);
`;

export const CART_TS = `// The cart's rules, shared by the browser, the unit tests and (with a deploy adapter) the server.
// A cart is a list of { id, quantity } lines kept in localStorage. It never stores a price or a
// title: those are looked up in the catalog each time, so nothing a visitor edits in storage can
// change what a book costs.
// scripts/browser-modules.ts publishes this file to the browser as /js/cart.js,
// so it must not import anything.

export interface CartLine {
  /** A book's slug. */
  id: string;
  quantity: number;
}

/** What the cart needs to know about a product. The books in catalog/books.ts fit. */
export interface Priced {
  slug: string;
  priceCents: number;
}

export interface PricedLine extends CartLine {
  unitCents: number;
  lineCents: number;
}

export interface PricedCart {
  lines: PricedLine[];
  totalCents: number;
}

/** The localStorage key. */
export const CART_KEY = "cart";
/** Dispatched on \`document\` after the cart is saved, so every component showing it can update. */
export const CART_CHANGED = "cart:changed";
/** The most copies of one book in a cart. */
export const MAX_QUANTITY = 99;
/** The most lines a request may send. */
export const MAX_LINES = 50;

const isQuantity = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= MAX_QUANTITY;

/** Why a value cannot be a cart line, or undefined when it can. */
function lineProblem(
  entry: unknown,
  known: ReadonlySet<string>,
): string | undefined {
  if (typeof entry !== "object" || entry === null) return "is not an object";
  const { id, quantity } = entry as Record<string, unknown>;
  if (typeof id !== "string" || !known.has(id)) {
    return "names a product that is not in the catalog";
  }
  if (!isQuantity(quantity)) {
    return \`needs a whole quantity from 1 to \${MAX_QUANTITY}\`;
  }
  return undefined;
}

/** One line per product, with only the two fields a line has. */
function merge(entries: readonly CartLine[]): CartLine[] {
  const quantities = new Map<string, number>();
  for (const { id, quantity } of entries) {
    quantities.set(
      id,
      Math.min(MAX_QUANTITY, (quantities.get(id) ?? 0) + quantity),
    );
  }
  return Array.from(quantities, ([id, quantity]) => ({ id, quantity }));
}

const slugs = (catalog: readonly Priced[]): Set<string> =>
  new Set(catalog.map((item) => item.slug));

/**
 * The cart lines in untrusted data, such as what localStorage holds. Anything that
 * is not a line for a product in the catalog is dropped, so this never throws.
 */
export function sanitizeCart(
  data: unknown,
  catalog: readonly Priced[],
): CartLine[] {
  if (!Array.isArray(data)) return [];
  const known = slugs(catalog);
  return merge(
    data.filter(
      (entry): entry is CartLine => lineProblem(entry, known) === undefined,
    ),
  );
}

/**
 * The strict version, for a request body: the lines, or the first problem found.
 * The message never repeats what was sent.
 */
export function checkCart(
  data: unknown,
  catalog: readonly Priced[],
): { lines: CartLine[] } | { error: string } {
  if (!Array.isArray(data)) return { error: '"lines" must be an array.' };
  if (data.length > MAX_LINES) {
    return { error: \`A cart holds at most \${MAX_LINES} lines.\` };
  }
  const known = slugs(catalog);
  for (const [index, entry] of data.entries()) {
    const problem = lineProblem(entry, known);
    if (problem) return { error: \`Line \${index + 1} \${problem}.\` };
  }
  return { lines: merge(data as CartLine[]) };
}

/** The cart with \`quantity\` more of a product. A quantity that is not a whole number above zero changes nothing. */
export function addToCart(
  lines: readonly CartLine[],
  id: string,
  quantity = 1,
): CartLine[] {
  if (!Number.isInteger(quantity) || quantity < 1) return [...lines];
  return merge([...lines, { id, quantity: Math.min(quantity, MAX_QUANTITY) }]);
}

/**
 * The cart with a product's quantity replaced. Zero or less removes the line, more than
 * MAX_QUANTITY is capped, and a value that is not a whole number changes nothing.
 */
export function setQuantity(
  lines: readonly CartLine[],
  id: string,
  quantity: number,
): CartLine[] {
  if (!Number.isInteger(quantity)) return [...lines];
  if (quantity < 1) return removeFromCart(lines, id);
  return lines.map((line) =>
    line.id === id
      ? { id, quantity: Math.min(quantity, MAX_QUANTITY) }
      : line,
  );
}

export const removeFromCart = (
  lines: readonly CartLine[],
  id: string,
): CartLine[] => lines.filter((line) => line.id !== id);

/** How many books are in the cart, counting copies. */
export const cartCount = (lines: readonly CartLine[]): number =>
  lines.reduce((count, line) => count + line.quantity, 0);

/** Each line with its price from the catalog, and the total, in cents. A line for an unknown product is left out. */
export function priceCart(
  lines: readonly CartLine[],
  catalog: readonly Priced[],
): PricedCart {
  const prices = new Map(catalog.map((item) => [item.slug, item.priceCents]));
  const priced: PricedLine[] = [];
  for (const { id, quantity } of lines) {
    const unitCents = prices.get(id);
    if (unitCents === undefined) continue;
    priced.push({ id, quantity, unitCents, lineCents: unitCents * quantity });
  }
  return {
    lines: priced,
    totalCents: priced.reduce((total, line) => total + line.lineCents, 0),
  };
}

/** localStorage, or undefined where the browser refuses it (private modes, blocked site data). */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The saved cart. Missing, unreadable or damaged storage is an empty cart. */
export function loadCart(catalog: readonly Priced[]): CartLine[] {
  try {
    const saved = storage()?.getItem(CART_KEY);
    return saved ? sanitizeCart(JSON.parse(saved), catalog) : [];
  } catch {
    return [];
  }
}

/**
 * Save the cart and tell the page. Returns false when the browser would not store it
 * (storage blocked or full), so the caller can say so instead of pretending.
 */
export function saveCart(lines: readonly CartLine[]): boolean {
  try {
    const store = storage();
    if (!store) return false;
    if (lines.length > 0) store.setItem(CART_KEY, JSON.stringify(lines));
    else store.removeItem(CART_KEY);
  } catch {
    return false;
  }
  globalThis.document?.dispatchEvent(new Event(CART_CHANGED));
  return true;
}
`;

export const SEO_TS = `// Head tags for a page, built at build time. A page calls seo() from a build script in its <head>.
// URLs come from BASCIK_SITE_URL (set it per deployment in .env or CI, never in bascik.config.ts)
// and BASCIK_BASE. html escapes every value for where it lands.
import { html, json, type SafeHtml } from "@bascik/bascik/html";
import { siteName } from "./site.ts";

export interface SeoOptions {
  /** The page's own title. The shop's name is added after it. */
  title: string;
  /** One or two sentences for search results. */
  description: string;
  /**
   * Keep the page out of search results (the cart, the checkout). Also write
   * <meta name="bascik-sitemap" content="exclude" /> in the page itself: Bascik reads
   * the source file, not this output, to decide what sitemap.xml lists.
   */
  noindex?: boolean;
}

/** The absolute URL of a site path, or undefined when BASCIK_SITE_URL is not set, as in dev. */
export function absoluteUrl(path: string): string | undefined {
  const origin = process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "");
  if (!origin) return undefined;
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  return \`\${origin}\${base}\${path}\`;
}

/** The title, description, canonical and Open Graph tags for the page being built. */
export function seo(options: SeoOptions): SafeHtml {
  const title = \`\${options.title} - \${siteName}\`;
  // A canonical URL must be absolute, so it is only written when the site URL is known.
  const url = absoluteUrl(process.env.BASCIK_PAGE_PATH || "/");
  return html\`<title>\${title}</title>
    <meta name="description" content="\${options.description}" />
    \${options.noindex ? html\`<meta name="robots" content="noindex" />\` : ""}
    \${url ? html\`<link rel="canonical" href="\${url}" />\` : ""}
    <meta property="og:type" content="website" />
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${options.description}" />
    \${url ? html\`<meta property="og:url" content="\${url}" />\` : ""}
    <meta property="og:site_name" content="\${siteName}" />
    <meta name="twitter:card" content="summary" />\`;
}

/** A JSON-LD block. json() escapes <, > and &, so a value can never close the script tag. */
export function jsonLd(data: Record<string, unknown>): SafeHtml {
  const body = json({ "@context": "https://schema.org", ...data });
  return html\`<script type="application/ld+json">
    \${body}
  </script>\`;
}
`;

/** POST /api/cart, written only with a deploy adapter. */
export const CART_API_ROUTE = `// POST /api/cart: the cart, priced by the server.
// The browser sends only ids and quantities, { "lines": [{ "id": "the-glass-tide", "quantity": 2 }] },
// and every price in the answer comes from the catalog on the server. A real checkout must
// charge these totals, never a number the browser sent.
// An API route is a module file, so its imports are relative: the @/ alias is for <script> blocks.
import { checkCart, priceCart } from "../browser/cart.ts";
import { books } from "../lib/catalog.ts";

const refuse = (error: string): Response =>
  Response.json({ error }, { status: 400 });

export const POST = async (request: Request): Promise<Response> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("Send the cart as JSON.");
  }
  if (typeof body !== "object" || body === null) {
    return refuse('Send an object with a "lines" array.');
  }
  const checked = checkCart((body as { lines?: unknown }).lines, books);
  if ("error" in checked) return refuse(checked.error);
  return Response.json(priceCart(checked.lines, books));
};
`;

/** The browser modules: `dist/js/<name>` from a source file that imports nothing. */
export const BROWSER_MODULES_TS = `// Publishes the modules that browser scripts import: /js/books.js, /js/cart.js and /js/money.js.
//
// Bascik inlines a component's script into the page and does not bundle it, so a browser
// script cannot import "../../browser/cart.ts". This script strips the types from three
// source files and writes them to dist/js/, where a script imports them by URL:
//
//   import { loadCart } from "/js/cart.js";
//
// That keeps one copy of the cart rules for the browser, the unit tests and the server.
// It runs before the pages build (bascik.config.ts, pipeline.exec) and again in dev when
// one of the sources changes. To import an npm package in the browser, swap this for a
// bundler: https://bascik.dev/how-to/bundling-npm-packages
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

/** The published name of each module, and the source it comes from. */
const MODULES: Record<string, string> = {
  "books.js": "catalog/books.ts",
  "cart.js": "src/browser/cart.ts",
  "money.js": "src/browser/money.ts",
};

// Node marks stripTypeScriptTypes as experimental and says so once per process. Keep the build log quiet.
process.removeAllListeners("warning");

const outDir = join(process.env.BASCIK_OUT_DIR ?? "dist", "js");
await mkdir(outDir, { recursive: true });

for (const [name, source] of Object.entries(MODULES)) {
  const code = stripTypeScriptTypes(await readFile(source, "utf8"), {
    mode: "strip",
  });
  // A type-only import is gone by now. Any import left would be fetched by the browser and fail.
  if (/^\\s*import\\s/m.test(code)) {
    throw new Error(
      \`\${source} is published to the browser as written, so it cannot import another module.\`,
    );
  }
  await writeFile(join(outDir, name), code);
}
`;

export const BASCIK_CONFIG_TS = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // Rebuild pages in dev when the catalog or a shared helper changes.
    watchPaths: ["catalog/", "src/lib/", "src/browser/"],
    exec: [
      {
        // Publishes /js/books.js, /js/cart.js and /js/money.js for browser scripts.
        script: "scripts/browser-modules.ts",
        phase: "pre",
        watch: ["catalog/", "src/browser/"],
      },
    ],
  },
});
`;

/**
 * For the editor and `tsc --noEmit`. `paths` maps each published browser module
 * back to its source, so a component script that imports `/js/cart.js` is typed.
 */
export const TSCONFIG_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: ["node"],
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        paths: {
          "@/*": ["./src/*"],
          "/js/books.js": ["./catalog/books.ts"],
          "/js/cart.js": ["./src/browser/cart.ts"],
          "/js/money.js": ["./src/browser/money.ts"],
        },
      },
      include: ["*.ts", "catalog", "e2e", "scripts", "src"],
      exclude: ["node_modules", "dist"],
    },
    null,
    2,
  ) + "\n";
