/**
 * @module templates/shop/data
 *
 * The shop template's data and logic files: the catalog, the modules under
 * `src/lib/`, the exec script that publishes three of them to the browser, and
 * the two root config files the site needs.
 */

/** The shop's own brand, independent of the scaffold folder name. */
export const SHOP_BRAND = "shop";

/**
 * The catalog: the one file a shop owner edits to change what is for sale.
 * The demo products and collection names are fictional and unendorsed.
 * Prices are whole cents.
 */
export const CATALOG_BOOKS_TS = `// The racing catalog. Add, remove or edit entries here and the home page,
// catalog page, one page per product, the sitemap and the cart follow.
//
// Prices are whole cents (1499 is $14.99), so sums never pick up rounding errors.
// src/lib/catalog.ts checks every entry, and a mistake fails the build naming the entry.
// This file is also published to the browser as /js/books.js for compatibility.
import type { Book } from "../src/lib/catalog.ts";

export const books: Book[] = [
  {
    slug: "pit-lane-coach-jacket",
    title: "Pit Lane Coach Jacket",
    material: "Recycled nylon shell with a cotton jersey lining.",
    fit: "Relaxed unisex cut; demo size M, chest 112 cm, back length 72 cm.",
    specification: "Two welt pockets, snap front and adjustable hem. Machine wash cold.",
    availability: "Demo stock: 12 jackets. No real inventory or shipment.",
    format: "Racewear",
    priceCents: 24000,
    rating: 4.9,
    tone: "plum",
    featured: true,
    description:
      "A lightweight coach jacket with a clean trackside silhouette and considered everyday details.",
  },
  {
    slug: "gridline-driver-suit",
    title: "Gridline Driver Suit",
    material: "280 g/m² cotton twill with reinforced seams.",
    fit: "Relaxed one-piece cut; demo size M, inseam 78 cm.",
    specification: "Six utility pockets and a two-way zip. Casual apparel, not protective racewear.",
    availability: "Demo stock: 8 suits. No real inventory or shipment.",
    format: "Racewear",
    priceCents: 16500,
    rating: 4.8,
    tone: "rust",
    featured: true,
    description:
      "A relaxed-fit one-piece suit in durable cotton twill, finished with a subtle contrast seam.",
  },
  {
    slug: "brake-cooling-duct-kit",
    title: "Brake Cooling Duct Kit",
    material: "Powder-coated aluminum display ducts with silicone hose.",
    fit: "Illustrative 76 mm connection; no vehicle compatibility is asserted.",
    specification: "Two ducts, two 1 m hoses and four clamps. Display use only, not tested for road use.",
    availability: "Demo stock: 6 kits. No real inventory or shipment.",
    format: "Parts",
    priceCents: 28000,
    rating: 4.7,
    tone: "teal",
    featured: true,
    description:
      "A precision-finished cooling duct set designed for a tidy, functional garage installation.",
  },
  {
    slug: "aero-display-panel",
    title: "Aero Display Panel",
    material: "Satin-finished composite display panel.",
    fit: "Wall display, 60 × 24 cm; allow 8 cm clearance.",
    specification: "Two mounting brackets included. Decorative only; not a vehicle aero part.",
    availability: "Demo stock: 10 panels. No real inventory or shipment.",
    format: "Parts",
    priceCents: 14999,
    rating: 4.6,
    tone: "ink",
    description:
      "A sculptural composite panel for a workshop wall, with a satin finish and mounting hardware.",
  },
  {
    slug: "helmet-number-decal-set",
    title: "Helmet Number Decal Set",
    material: "Matte removable vinyl with paper backing.",
    fit: "Numbers are 60 mm tall; check surface compatibility before applying.",
    specification: "Two sheets of digits 0–9. Decorative only; no safety certification.",
    availability: "Demo stock: 24 sets. No real inventory or shipment.",
    format: "Accessories",
    priceCents: 9999,
    rating: 4.5,
    tone: "moss",
    description:
      "A set of durable, removable helmet decals in a restrained palette for a personal finish.",
  },
  {
    slug: "interval-chronograph",
    title: "Interval Chronograph",
    material: "Brushed stainless steel case with an acrylic lens.",
    fit: "52 mm handheld case with a detachable wrist cord.",
    specification: "60-minute analog dial with start, stop and reset controls. Illustrative specifications.",
    availability: "Demo stock: 9 timers. No real inventory or shipment.",
    format: "Accessories",
    priceCents: 32000,
    rating: 4.9,
    tone: "sand",
    description:
      "A compact analog stopwatch with a brushed steel case, tactile crown and clear elapsed-time dial.",
  },
  {
    slug: "door-number-decal-pack",
    title: "Door Number Decal Pack",
    material: "Weather-resistant removable vinyl.",
    fit: "Two 30 × 30 cm sheets for flat display surfaces.",
    specification: "Matched number panels with application guide. Decorative display use.",
    availability: "Demo stock: 18 packs. No real inventory or shipment.",
    format: "Parts",
    priceCents: 15000,
    rating: 4.4,
    tone: "rust",
    description:
      "Weather-resistant number decals for display builds and track-day projects, supplied as a matched pair.",
  },
  {
    slug: "wheel-fastener-kit",
    title: "Wheel Fastener Kit",
    material: "Zinc-finished steel display fasteners.",
    fit: "Illustrative M12 × 1.5 thread; no vehicle fitment is asserted.",
    specification: "20 fasteners in a reusable tray. Display only; not approved for vehicle installation.",
    availability: "Demo stock: 7 kits. No real inventory or shipment.",
    format: "Parts",
    priceCents: 8500,
    rating: 4.3,
    tone: "teal",
    description:
      "A neatly packed set of durable wheel fasteners with a corrosion-resistant finish for the garage.",
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

export const FORMATS = ["Racewear", "Parts", "Accessories"] as const;
export type Format = (typeof FORMATS)[number];

/** Product artwork colors, defined in src/components/product-art/product-art.html. */
export const TONES = ["plum", "rust", "teal", "ink", "moss", "sand"] as const;
export type Tone = (typeof TONES)[number];

export interface Book {
  /** The last part of the product URL (/products/<slug>) and its id in the cart. */
  slug: string;
  title: string;
  description: string;
  /** Optional for custom catalogs; the demo supplies all four detail fields. */
  material?: string;
  fit?: string;
  specification?: string;
  availability?: string;
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
const TEXT_FIELDS = ["slug", "title", "description"] as const;

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
      fail("repeats the slug of an earlier item. Each product needs its own.");
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
  \`/products/\${book.slug}\`;
`;

export const RACING_SQL = `CREATE TABLE IF NOT EXISTS products (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  rating REAL NOT NULL,
  description TEXT NOT NULL,
  details_json TEXT NOT NULL
);
`;

export const RACING_DB_TS = `import { validateCatalog, type Book } from "./catalog.ts";

export interface CatalogContext {
  platform?: { env?: { DB?: {
    prepare(sql: string): { all<T>(): Promise<{ results: T[] }> };
  } } };
}
export const catalogQuery = "SELECT slug, title, category AS format, price_cents AS priceCents, rating, description, details_json FROM products";

export async function readCatalog(context: CatalogContext): Promise<Book[]> {
  const binding = context.platform?.env?.DB;
  let rows: Record<string, unknown>[];
  if (binding) {
    rows = (await binding.prepare(catalogQuery).all<Record<string, unknown>>()).results;
  } else {
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
    if (!sqlite) throw new Error("The shop requires a DB binding on Cloudflare or Node SQLite.");
    const db = new sqlite.DatabaseSync("data/racing.db", { readOnly: true });
    try { rows = db.prepare(catalogQuery).all(); }
    finally { db.close(); }
  }
  return validateCatalog(rows.map(({ details_json, ...fields }) => {
    if (typeof details_json !== "string") throw new Error("Catalog details_json must be JSON text.");
    const details: unknown = JSON.parse(details_json);
    if (typeof details !== "object" || details === null || Array.isArray(details))
      throw new Error("Catalog details_json must contain an object.");
    return { ...details, ...fields };
  }));
}
`;

export const SEED_DATABASE_TS = `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { books } from "../src/lib/catalog.ts";

const sql = await readFile(join(process.cwd(), "data", "racing.sql"), "utf8");
const insert = "INSERT INTO products (slug, title, category, price_cents, rating, description, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)";
const values = books.map(book => [book.slug, book.title, book.format, book.priceCents, book.rating, book.description, JSON.stringify(book)]);
if (process.argv.includes("--sql")) {
  const quote = (value: string | number): string => typeof value === "number" ? String(value) : "'" + value.replaceAll("'", "''") + "'";
  console.log(sql + "\\nDELETE FROM products;\\n" + values.map(row =>
    "INSERT INTO products (slug, title, category, price_cents, rating, description, details_json) VALUES (" + row.map(quote).join(", ") + ");"
  ).join("\\n"));
} else {
  const path = join(process.cwd(), "data", "racing.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
    db.exec("BEGIN; DELETE FROM products;");
    const statement = db.prepare(insert);
    for (const row of values) statement.run(...row);
    db.exec("COMMIT;");
    console.log(\`Seeded \${books.length} products in \${path}\`);
  } finally { db.close(); }
}
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
// The browser sends only ids and quantities, { "lines": [{ "id": "pit-lane-coach-jacket", "quantity": 2 }] },
// and every price in the answer comes from the catalog on the server. A real checkout must
// charge these totals, never a number the browser sent.
// An API route is a module file, so its imports are relative: the @/ alias is for <script> blocks.
import { checkCart, priceCart } from "../browser/cart.ts";
import { readCatalog, type CatalogContext } from "../lib/racing-db.ts";

const refuse = (error: string): Response =>
  Response.json({ error }, { status: 400 });

export const POST = async (request: Request, context: CatalogContext): Promise<Response> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("Send the cart as JSON.");
  }
  if (typeof body !== "object" || body === null) {
    return refuse('Send an object with a "lines" array.');
  }
  const books = await readCatalog(context);
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
  assets: { inlineStyles: ["src/pages/css/styles.css"] },
  pipeline: {
    // Rebuild pages in dev when the catalog or a shared helper changes.
    watchPaths: ["catalog/", "src/lib/", "src/browser/"],
    exec: [
      {
        // The demo seed is the only writer. Request handlers open SQLite read-only.
        script: "scripts/seed-database.ts",
        phase: "pre",
        watch: ["catalog/", "data/racing.sql"],
      },
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
