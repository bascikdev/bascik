/**
 * Unit tests for the `shop` template: what it writes, the rules its markup and
 * scripts follow, and the catalog and cart logic of the generated site, which is
 * loaded from a temporary folder and called directly.
 *
 * The rules every template shares (paths, declared folders, shared files) are in
 * `template registry` in scaffold.test.ts; building the site is in
 * scaffold.integration.test.ts and shop.integration.test.ts.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ADAPTERS,
  SITE_HEADER_CSS,
  type Adapter,
  type TemplateFile,
} from "../scaffold.ts";
import { TEMPLATES, templateNamed } from "../templates.ts";
import { SHOP_TEMPLATE } from "./shop.ts";

const filesFor = (adapter?: Adapter, siteName = "My Shop"): TemplateFile[] =>
  SHOP_TEMPLATE.files({ siteName, adapter });

/** Every generated file as text, by path. The template writes no binary files. */
const textFiles = (adapter?: Adapter, siteName?: string): Map<string, string> =>
  new Map(
    filesFor(adapter, siteName).map(([path, data]) => [path, String(data)]),
  );

const file = (path: string, adapter?: Adapter): string => {
  const content = textFiles(adapter).get(path);
  if (content === undefined) throw new Error(`The template has no ${path}`);
  return content;
};

const ANY_ADAPTER = [undefined, ...ADAPTERS] as const;
const COMPONENTS = [
  "site-meta",
  "site-header",
  "site-footer",
  "home-hero",
  "book-cover",
  "book-card",
  "featured-books",
  "book-catalog",
  "book-detail",
  "cart-list",
  "form-field",
  "checkout-form",
  "order-summary",
  "order-confirmation",
];
const PAGES = [
  "src/pages/index.html",
  "src/pages/books/index.html",
  "src/pages/books/[slug].html",
  "src/pages/cart.html",
  "src/pages/checkout.html",
  "src/pages/order-confirmed.html",
  "src/pages/404.html",
];

// ─── The generated site's modules, loaded from a temporary folder ─────────────

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Write some of the template's files into a new temporary folder, with replacements. */
async function writeSite(
  paths: readonly string[],
  replace: Record<string, string> = {},
  siteName?: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bascik-shop-template-"));
  tempDirs.push(root);
  const files = textFiles(undefined, siteName);
  for (const path of paths) {
    const content = replace[path] ?? files.get(path);
    if (content === undefined) throw new Error(`The template has no ${path}`);
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

const load = <T>(root: string, path: string): Promise<T> =>
  import(pathToFileURL(join(root, ...path.split("/"))).href) as Promise<T>;

interface Book {
  slug: string;
  title: string;
  author: string;
  description: string;
  format: string;
  priceCents: number;
  rating: number;
  featured?: boolean;
}

const CATALOG_FILES = ["catalog/books.ts", "src/lib/catalog.ts"];

/** The generated catalog module, with `catalog/books.ts` replaced when `books` is given. */
async function loadCatalog(books?: string): Promise<{ books: Book[] }> {
  const root = await writeSite(
    CATALOG_FILES,
    books === undefined ? {} : { "catalog/books.ts": books },
  );
  return load(root, "src/lib/catalog.ts");
}

/** `catalog/books.ts` with one edit, which must change the file. */
function editedCatalog(find: string | RegExp, replacement: string): string {
  const original = file("catalog/books.ts");
  const edited = original.replace(find, () => replacement);
  expect(edited, `nothing in catalog/books.ts matched ${find}`).not.toBe(
    original,
  );
  return edited;
}

interface CartModule {
  MAX_QUANTITY: number;
  sanitizeCart: (data: unknown, catalog: unknown[]) => unknown[];
  checkCart: (data: unknown, catalog: unknown[]) => Record<string, unknown>;
  addToCart: (lines: unknown[], id: string, quantity?: number) => unknown[];
  setQuantity: (lines: unknown[], id: string, quantity: number) => unknown[];
  priceCart: (
    lines: unknown[],
    catalog: unknown[],
  ) => { lines: unknown[]; totalCents: number };
}

// ─── What the template writes ─────────────────────────────────────────────────

describe("shop template", () => {
  it("is registered under the name shop with the summary --help prints", () => {
    expect(TEMPLATES).toContain(SHOP_TEMPLATE);
    expect(templateNamed("shop")).toBe(SHOP_TEMPLATE);
    expect(templateNamed("SHOP")).toBe(SHOP_TEMPLATE);
    expect(SHOP_TEMPLATE.summary).toBe(
      "A shop: a product catalog, product pages, a cart, and a demo checkout",
    );
    // Nothing beyond the starter's own packages: the site needs no install of its own.
    expect(SHOP_TEMPLATE.dependencies).toBeUndefined();
    expect(SHOP_TEMPLATE.devDependencies).toBeUndefined();
  });

  it("writes the catalog, the shared logic, every page, and each component with its test", () => {
    const paths = filesFor().map(([path]) => path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "bascik.config.ts",
        "tsconfig.json",
        "scripts/browser-modules.ts",
        "catalog/books.ts",
        "src/lib/site.ts",
        "src/lib/catalog.ts",
        "src/lib/catalog.test.ts",
        "src/lib/seo.ts",
        "src/browser/cart.ts",
        "src/browser/cart.test.ts",
        "src/browser/money.ts",
        "src/browser/money.test.ts",
        "src/pages/css/styles.css",
        "src/pages/books/book-page.ts",
        "e2e/app.spec.ts",
        ...PAGES,
        ...COMPONENTS.flatMap((name) => [
          `src/components/${name}/${name}.html`,
          `src/components/${name}/${name}.test.ts`,
        ]),
      ]),
    );
    // Every component folder is one this test knows, so a new component gets its checks.
    const folders = new Set(
      paths
        .filter((path) => path.startsWith("src/components/"))
        .map((path) => path.split("/")[2]),
    );
    expect([...folders].sort()).toEqual([...COMPONENTS].sort());
  });

  it("writes only text, in TypeScript, with no image files", () => {
    for (const [path, data] of filesFor("cloudflare")) {
      expect(typeof data, path).toBe("string");
      expect(path).toMatch(/\.(?:ts|html|css|json)$/);
    }
    const all = [...textFiles("cloudflare")];
    for (const [path, content] of all) {
      if (path.startsWith("e2e/")) continue;
      expect(content.length, path).toBeGreaterThan(0);
      expect(/<img\b|url\(|\.(?:jpe?g|webp|gif)\b/.test(content), path).toBe(
        false,
      );
    }
  });

  it.each(ANY_ADAPTER)(
    "marks every script tag as TypeScript or loads a .ts file (adapter %s)",
    (adapter) => {
      for (const [path, content] of textFiles(adapter)) {
        if (!path.endsWith(".html")) continue;
        const tags = content.match(/<script\b[^>]*>/g) ?? [];
        for (const tag of tags) {
          expect(tag, path).toMatch(/type="text\/typescript"|src="[^"]+\.ts"/);
        }
      }
    },
  );

  it("adds the server-priced cart only with an adapter, and no request without one", () => {
    const plain = textFiles();
    expect(plain.has("src/api/cart.ts")).toBe(false);
    for (const [path, content] of plain) {
      expect(content, path).not.toMatch(/\bfetch\(|\/api\//);
    }
    expect(
      plain.get("src/components/order-summary/order-summary.ts"),
    ).toContain("priceCart(cart, books)");

    for (const adapter of ADAPTERS) {
      const hosted = textFiles(adapter);
      const added = [...hosted.keys()].filter((path) => !plain.has(path));
      expect(added).toEqual(["src/api/cart.ts"]);
      expect(
        hosted.get("src/components/order-summary/order-summary.ts"),
      ).toContain('fetch("/api/cart"');
      expect(hosted.get("e2e/app.spec.ts")).toContain("/api/cart");
      // Everything else is the same site.
      const changed = [...plain.keys()].filter(
        (path) => plain.get(path) !== hosted.get(path),
      );
      expect(changed.sort()).toEqual([
        "e2e/app.spec.ts",
        "src/components/order-summary/order-summary.ts",
      ]);
    }
  });

  it("needs no secret, account or outside service", () => {
    for (const [path, content] of textFiles("netlify")) {
      // The only environment the site reads is what Bascik sets for a build.
      for (const [, name] of content.matchAll(/process\.env\.(\w+)/g)) {
        expect(name, path).toMatch(/^BASCIK_/);
      }
      // No URL but the docs link in a comment and the schema.org vocabulary.
      for (const [url] of content.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
        expect(url, path).toMatch(
          /^https:\/\/(?:bascik\.dev\/how-to\/bundling-npm-packages|schema\.org)$/,
        );
      }
      expect(content, path).not.toMatch(
        /stripe|printful|shopify|paypal|api[_-]?key|secret/i,
      );
    }
  });
});

// ─── Markup rules ─────────────────────────────────────────────────────────────

describe("shop template markup", () => {
  it.each(PAGES)(
    "%s has the shared head, one main landmark, and the header first",
    (path) => {
      const page = file(path);
      expect(page).toMatch(/^<!doctype html>\n<html lang="en">/);
      expect(page).toContain("<site-meta />");
      expect(page.match(/<main\b/g)).toHaveLength(1);
      expect(page).toContain('<main id="main" data-testid="');
      expect(page.indexOf("<site-header />")).toBeLessThan(
        page.indexOf("<main"),
      );
      expect(page.indexOf("<site-footer />")).toBeGreaterThan(
        page.indexOf("</main>"),
      );
      // The title and description come from seo(), never typed into the page.
      expect(page).not.toContain("<title>");
      expect(page).toMatch(/import \{ (?:seo|bookHead) \}/);
    },
  );

  it("keeps the cart, the checkout, the confirmation and the 404 out of search and the sitemap", () => {
    for (const path of [
      "src/pages/cart.html",
      "src/pages/checkout.html",
      "src/pages/order-confirmed.html",
      "src/pages/404.html",
    ]) {
      const page = file(path);
      expect(page, path).toContain(
        '<meta name="bascik-sitemap" content="exclude" />',
      );
      expect(page, path).toContain("noindex: true");
    }
    for (const path of ["src/pages/index.html", "src/pages/books/index.html"]) {
      expect(file(path), path).not.toContain("noindex");
    }
  });

  it("pages read as lists of component tags", () => {
    expect(file("src/pages/index.html")).toContain(
      "<home-hero />\n      <featured-books />",
    );
    expect(file("src/pages/books/index.html")).toContain("<book-catalog />");
    expect(file("src/pages/cart.html")).toContain("<cart-list />");
    expect(file("src/pages/checkout.html")).toMatch(
      /<h1>Checkout<\/h1>[\s\S]*<checkout-form \/>\s*<order-summary \/>/,
    );
    expect(file("src/pages/order-confirmed.html")).toContain(
      "<order-confirmation />",
    );
  });

  it("puts the skip link first in the header, hidden by clipping like the default starter's", () => {
    const header = file("src/components/site-header/site-header.html");
    expect(header).toContain(SITE_HEADER_CSS);
    expect(header).toMatch(
      /<header data-testid="site-header">\s*<a href="#main" class="skip-link"/,
    );
    expect(SITE_HEADER_CSS).toMatch(
      /\.skip-link:not\(:focus\) \{[^}]*clip-path: inset\(50%\)/,
    );
  });

  it("leaves each page's description to the page", () => {
    const meta = file("src/components/site-meta/site-meta.html");
    expect(meta).not.toContain('name="description"');
    expect(meta).toContain('<meta charset="UTF-8" />');
    expect(meta).toContain('<link rel="stylesheet" href="/css/styles.css" />');
  });

  it.each(COMPONENTS.filter((name) => name !== "site-meta"))(
    "<%s> has a semantic root with its data-testid",
    (name) => {
      const html = file(`src/components/${name}/${name}.html`)
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<style>[\s\S]*?<\/style>/g, "");
      const root = /<([a-z]+)\b[^>]*>/.exec(html);
      expect(root?.[0]).toContain(`data-testid="${name}"`);
      // A wrapper <div> is the root only where no element names the job (one form field).
      if (name !== "form-field") expect(root?.[1]).not.toBe("div");
    },
  );

  it("gives every button a type, and every control a test id", () => {
    for (const [path, content] of textFiles("cloudflare")) {
      if (!/\.html$|\/lines\.ts$/.test(path)) continue;
      for (const tag of content.match(/<(?:button|input|select)\b[^>]*>/g) ??
        []) {
        expect(tag, path).toMatch(/data-testid="[a-z-]+"/);
        if (tag.startsWith("<button")) {
          expect(tag, path).toMatch(/type="(?:button|submit)"/);
        }
      }
    }
  });

  it("labels every form control", () => {
    const catalog = file("src/components/book-catalog/book-catalog.html");
    for (const id of ["sort", "format"]) {
      expect(catalog).toContain(`<label for="${id}">`);
      expect(catalog).toContain(`<select id="${id}"`);
    }
    expect(file("src/components/form-field/form-field.html")).toMatch(
      /<label for="input"[^>]*><\/label>[\s\S]*<input id="input" required/,
    );
    // The quantity field sits inside its label, which names the book.
    expect(file("src/components/cart-list/lines.ts")).toMatch(
      /<label class="quantity">\s*Quantity<span class="visually-hidden"> of \$\{book\.title\}<\/span>\s*<input/,
    );
  });

  it("announces cart and form changes in live regions", () => {
    for (const name of [
      "book-detail",
      "cart-list",
      "order-summary",
      "book-catalog",
    ]) {
      expect(file(`src/components/${name}/${name}.html`), name).toMatch(
        /<p id="status"[^>]*role="status"/,
      );
    }
    expect(file("src/components/checkout-form/checkout-form.html")).toMatch(
      /<p id="alert"[^>]*role="alert"/,
    );
  });

  it("hides script-only controls until the script runs, so nothing is dead without JavaScript", () => {
    expect(file("src/components/book-catalog/book-catalog.html")).toMatch(
      /<form id="controls"[^>]*\bhidden\b/,
    );
    expect(file("src/components/book-detail/book-detail.html")).toMatch(
      /<button id="add"[^>]*\bhidden\b/,
    );
    expect(file("src/components/checkout-form/checkout-form.html")).toMatch(
      /<form id="form"[^>]*\bhidden\b/,
    );
    // Hidden with the attribute, which a component's display rule must not undo.
    expect(file("src/pages/css/styles.css")).toContain(
      "[hidden] { display: none !important; }",
    );
  });

  it("draws covers without image files and gives each a text alternative", () => {
    const cover = file("src/components/book-cover/book-cover.html");
    expect(cover).toMatch(
      /<span class="cover" role="img" data-bascik-attr-aria-label="label"/,
    );
    expect(cover).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(file("src/components/book-cover/cover.ts")).toContain(
      "const label = `Cover of ${book.title} by ${book.author}`;",
    );
  });

  it("labels the end of the checkout as a demo and says where a payment provider goes", () => {
    expect(
      file("src/components/order-confirmation/order-confirmation.html"),
    ).toContain("No payment is taken; connect a payment provider here.");
    expect(
      file("src/components/order-confirmation/order-confirmation.html"),
    ).toContain("src/components/checkout-form/checkout-form.ts");
    const submit = file("src/components/checkout-form/checkout-form.ts");
    expect(submit).toContain("Connect a payment provider here.");
    expect(submit).toContain('window.location.assign("/order-confirmed")');
    expect(file("src/components/checkout-form/checkout-form.html")).toContain(
      "No payment is taken",
    );
  });
});

// ─── Escaping and markup built in code ────────────────────────────────────────

describe("shop template output safety", () => {
  it("never builds markup in the browser or escapes by hand", () => {
    for (const [path, content] of textFiles("cloudflare")) {
      expect(content, path).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/,
      );
      expect(content, path).not.toMatch(
        /&amp;|&lt;|escapeHtml|\.replace\(\/[&<]/,
      );
    }
  });

  it("builds every piece of markup from data with html from @bascik/bascik/html", () => {
    const builders = [...textFiles("cloudflare")].filter(
      ([path, content]) =>
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.startsWith("e2e/") &&
        /html`/.test(content),
    );
    expect(builders.map(([path]) => path).sort()).toEqual([
      "src/components/book-card/card.ts",
      "src/components/book-catalog/listing.ts",
      "src/components/book-cover/cover.ts",
      "src/components/cart-list/lines.ts",
      "src/components/featured-books/featured.ts",
      "src/components/order-summary/lines.ts",
      "src/lib/seo.ts",
      "src/pages/books/book-page.ts",
    ]);
    for (const [path, content] of builders) {
      expect(content, path).toMatch(
        /import \{ html,[^}]*\} from "@bascik\/bascik\/html";/,
      );
      // An interpolated value only ever sits in an html template.
      expect(content, path).not.toMatch(/\.join\(/);
    }
    // No browser script imports the helper: it runs in Node.
    for (const name of [
      "site-header",
      "book-detail",
      "cart-list",
      "checkout-form",
      "order-summary",
    ]) {
      expect(
        file(`src/components/${name}/${name}.ts`, "cloudflare"),
        name,
      ).not.toContain("@bascik/bascik");
    }
  });

  it("browser scripts write text, never markup, from what the cart holds", () => {
    for (const name of [
      "site-header",
      "book-detail",
      "cart-list",
      "order-summary",
    ]) {
      const script = file(`src/components/${name}/${name}.ts`, "cloudflare");
      expect(script, name).toContain("textContent");
      expect(script, name).not.toMatch(/createElement|cloneNode/);
    }
  });

  it.each([
    `Tom & Jerry's "Books" <script>alert(1)</script>`,
    "</script><img src=x onerror=alert(1)>",
    "back\\slash `tick` ${dollar}",
    "line\nbreak separator",
  ])(
    "misuse: writes the site name %j once, as a string literal",
    async (siteName) => {
      const files = textFiles(undefined, siteName);
      expect(files.get("src/lib/site.ts")).toContain(
        `export const siteName = ${JSON.stringify(siteName)};`,
      );
      // No other file carries the name: pages print it through html, which escapes it.
      for (const [path, content] of files) {
        if (path === "src/lib/site.ts") continue;
        expect(content, path).toBe(textFiles(undefined, "My Shop").get(path));
      }
      const root = await writeSite(["src/lib/site.ts"], {}, siteName);
      const site = await load<{ siteName: string }>(root, "src/lib/site.ts");
      expect(site.siteName).toBe(siteName);
    },
  );

  it("prints the site name through html in the header, the footer and every title", () => {
    for (const path of [
      "src/components/site-header/site-header.html",
      "src/components/site-footer/site-footer.html",
    ]) {
      const component = file(path);
      expect(component).toContain('import { siteName } from "@/lib/site.ts";');
      expect(component).toMatch(
        /export default \(\) => html`[^`]*\$\{siteName\}`/,
      );
    }
    expect(file("src/lib/seo.ts")).toContain(
      "const title = `${options.title} - ${siteName}`;",
    );
  });
});

// ─── The catalog ──────────────────────────────────────────────────────────────

describe("shop template catalog", () => {
  it("has six to eight invented books with whole-cent prices and unique slugs", async () => {
    const { books } = await loadCatalog();
    expect(books.length).toBeGreaterThanOrEqual(6);
    expect(books.length).toBeLessThanOrEqual(8);
    expect(new Set(books.map((book) => book.slug)).size).toBe(books.length);
    expect(new Set(books.map((book) => book.title)).size).toBe(books.length);
    for (const book of books) {
      expect(Number.isInteger(book.priceCents), book.slug).toBe(true);
      expect(book.priceCents, book.slug).toBeGreaterThan(0);
      expect(book.rating, book.slug).toBeGreaterThanOrEqual(0);
      expect(book.rating, book.slug).toBeLessThanOrEqual(5);
      expect(["Hardcover", "Paperback", "Ebook"]).toContain(book.format);
      for (const text of [book.title, book.author, book.description]) {
        expect(text.trim().length, book.slug).toBeGreaterThan(0);
        // Nothing borrowed from this repository's own names.
        expect(text, book.slug).not.toMatch(/bascik|merch/i);
      }
      // A description doubles as the page's meta description.
      expect(book.description.length, book.slug).toBeGreaterThanOrEqual(50);
      expect(book.description.length, book.slug).toBeLessThanOrEqual(160);
    }
    expect(books.filter((book) => book.featured)).toHaveLength(3);
  });

  it("the E2E spec's sample books and totals match the catalog", async () => {
    const { books } = await loadCatalog();
    const spec = file("e2e/app.spec.ts");
    expect(spec).toContain(`const BOOK_COUNT = ${books.length};`);
    const price = (slug: string): number =>
      books.find((book) => book.slug === slug)!.priceCents;
    expect(price("the-glass-tide")).toBe(850);
    expect(price("bread-for-the-long-winter")).toBe(3200);
    expect(Math.min(...books.map((book) => book.priceCents))).toBe(850);
    expect(Math.max(...books.map((book) => book.priceCents))).toBe(3200);
    expect(books.filter((book) => book.format === "Ebook")).toHaveLength(2);
  });

  it("makes one page per book from the catalog with a dynamic route", () => {
    const page = file("src/pages/books/[slug].html");
    expect(page).toMatch(
      /<script data-bascik-routes type="text\/typescript">\s*import \{ books \} from "@\/lib\/catalog\.ts";/,
    );
    expect(page).toContain(
      "books.map((book) => ({ params: { slug: book.slug } }))",
    );
    const helper = file("src/pages/books/book-page.ts");
    expect(helper).toContain('"@type": "Product"');
    expect(helper).toContain("price: (book.priceCents / 100).toFixed(2),");
    expect(helper).toContain("<book-detail");
  });

  it("formats prices from whole cents with Intl.NumberFormat", async () => {
    const root = await writeSite(["src/browser/money.ts"]);
    const { formatCents } = await load<{
      formatCents: (cents: number) => string;
    }>(root, "src/browser/money.ts");
    expect(file("src/browser/money.ts")).toContain("new Intl.NumberFormat(");
    expect(formatCents(1499)).toBe("$14.99");
    expect(formatCents(850 * 2 + 3200)).toBe("$49.00");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("misuse: an item with a missing field fails, naming the item and the field", async () => {
    await expect(
      loadCatalog(editedCatalog(/\n\s+author: "Tobias Renn",/, "")),
    ).rejects.toThrow(
      'catalog/books.ts: item 2 ("salt-and-cinder") is missing "author".',
    );
    await expect(
      loadCatalog(editedCatalog('title: "The Glass Tide"', 'title: ""')),
    ).rejects.toThrow('item 8 ("the-glass-tide") is missing "title".');
  });

  it("misuse: an item with no slug is named by its title", async () => {
    await expect(
      loadCatalog(editedCatalog(/\n\s+slug: "night-trains-to-nowhere",/, "")),
    ).rejects.toThrow('item 4 ("Night Trains to Nowhere") is missing "slug".');
  });

  it.each([
    ["negative", "-1650"],
    ["zero", "0"],
    ["not a whole number of cents", "16.5"],
    ["a string", '"1650"'],
    ["not a number", "Number.NaN"],
  ])(
    "misuse: a price that is %s fails, naming the item",
    async (_kind, price) => {
      await expect(
        loadCatalog(editedCatalog("priceCents: 1650", `priceCents: ${price}`)),
      ).rejects.toThrow(
        /catalog\/books\.ts: item 2 \("salt-and-cinder"\) needs "priceCents" as a whole number of cents above zero/,
      );
    },
  );

  it("misuse: a duplicate slug fails, naming the second item", async () => {
    await expect(
      loadCatalog(
        editedCatalog('slug: "the-glass-tide"', 'slug: "the-lantern-orchard"'),
      ),
    ).rejects.toThrow(
      'catalog/books.ts: item 8 ("the-lantern-orchard") repeats the slug of an earlier item.',
    );
  });

  it("misuse: a slug that would not make a URL, or an unknown format, fails", async () => {
    await expect(
      loadCatalog(
        editedCatalog('slug: "the-glass-tide"', 'slug: "The Glass Tide"'),
      ),
    ).rejects.toThrow('item 8 ("The Glass Tide") has a slug that is not');
    await expect(
      loadCatalog(editedCatalog('format: "Ebook"', 'format: "Audiobook"')),
    ).rejects.toThrow(
      /item 5 .* needs "format" to be one of: Hardcover, Paperback, Ebook\./,
    );
  });
});

// ─── The cart ─────────────────────────────────────────────────────────────────

describe("shop template cart", () => {
  const catalog = [
    { slug: "alpha", priceCents: 1499 },
    { slug: "beta", priceCents: 850 },
  ];
  const loadCart = async (): Promise<CartModule> =>
    load(await writeSite(["src/browser/cart.ts"]), "src/browser/cart.ts");

  it("treats anything stored that is not a cart as an empty cart", async () => {
    const { sanitizeCart } = await loadCart();
    for (const data of [null, undefined, "{not json", 42, {}, { lines: [] }]) {
      expect(sanitizeCart(data, catalog)).toEqual([]);
    }
  });

  it("drops unknown products and quantities that are zero, negative, fractional or huge", async () => {
    const { sanitizeCart } = await loadCart();
    expect(
      sanitizeCart(
        [
          { id: "no-such-book", quantity: 1 },
          { id: "__proto__", quantity: 1 },
          { id: "alpha", quantity: 0 },
          { id: "alpha", quantity: -2 },
          { id: "alpha", quantity: 1.5 },
          { id: "alpha", quantity: "3" },
          { id: "alpha", quantity: 1e12 },
          null,
          { id: "beta", quantity: 2, priceCents: 1 },
        ],
        catalog,
      ),
    ).toEqual([{ id: "beta", quantity: 2 }]);
  });

  it("changes quantities within bounds", async () => {
    const { MAX_QUANTITY, addToCart, setQuantity } = await loadCart();
    const cart = [{ id: "alpha", quantity: 2 }];
    expect(setQuantity(cart, "alpha", 0)).toEqual([]);
    expect(setQuantity(cart, "alpha", -5)).toEqual([]);
    expect(setQuantity(cart, "alpha", 1e9)).toEqual([
      { id: "alpha", quantity: MAX_QUANTITY },
    ]);
    expect(setQuantity(cart, "alpha", 2.5)).toEqual(cart);
    expect(addToCart(cart, "alpha", 1e9)).toEqual([
      { id: "alpha", quantity: MAX_QUANTITY },
    ]);
    expect(addToCart(cart, "alpha", -1)).toEqual(cart);
  });

  it("prices from the catalog only, in whole cents", async () => {
    const { priceCart } = await loadCart();
    expect(
      priceCart(
        [
          { id: "alpha", quantity: 3, priceCents: 1 },
          { id: "gone", quantity: 1 },
        ],
        catalog,
      ),
    ).toEqual({
      lines: [{ id: "alpha", quantity: 3, unitCents: 1499, lineCents: 4497 }],
      totalCents: 4497,
    });
  });

  it("the server's check refuses bad input without repeating it", async () => {
    const { checkCart } = await loadCart();
    expect(checkCart("alpha", catalog)).toEqual({
      error: '"lines" must be an array.',
    });
    const refused = checkCart([{ id: "<b>", quantity: 1 }], catalog);
    expect(refused).toEqual({
      error: "Line 1 names a product that is not in the catalog.",
    });
    expect(checkCart([{ id: "alpha", quantity: -1 }], catalog)).toHaveProperty(
      "error",
    );
    expect(
      checkCart(
        Array.from({ length: 51 }, () => ({ id: "alpha", quantity: 1 })),
        catalog,
      ),
    ).toHaveProperty("error");
  });

  it("guards storage that is missing, blocked or damaged", () => {
    const cart = file("src/browser/cart.ts");
    // Reading the global can itself throw, and so can getItem, setItem and JSON.parse.
    expect(cart).toMatch(
      /try \{\s*return globalThis\.localStorage;\s*\} catch/,
    );
    expect(cart).toMatch(
      /export function loadCart[\s\S]*?try \{[\s\S]*?JSON\.parse\(saved\)[\s\S]*?\} catch \{\s*return \[\];/,
    );
    expect(cart).toMatch(
      /export function saveCart[\s\S]*?try \{[\s\S]*?setItem[\s\S]*?\} catch \{\s*return false;/,
    );
  });

  it("the API route validates on the server and prices from the server's catalog", () => {
    const route = file("src/api/cart.ts", "netlify");
    expect(route).toContain("export const POST = async");
    expect(route).toContain("await request.json()");
    expect(route).toContain(
      "checkCart((body as { lines?: unknown }).lines, books)",
    );
    expect(route).toContain("priceCart(checked.lines, books)");
    expect(route).toContain("{ status: 400 }");
  });

  it("publishes the browser's modules from the same sources the tests and the server use", () => {
    const publish = file("scripts/browser-modules.ts");
    for (const source of [
      "catalog/books.ts",
      "src/browser/cart.ts",
      "src/browser/money.ts",
    ]) {
      expect(publish).toContain(`"${source}"`);
      // A published module is served as written, so it imports nothing at run time.
      expect(file(source)).not.toMatch(/^import (?!type )/m);
    }
    expect(publish).toContain("process.env.BASCIK_OUT_DIR");
    expect(file("bascik.config.ts")).toContain(
      'script: "scripts/browser-modules.ts"',
    );
    const tsconfig = JSON.parse(file("tsconfig.json")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(tsconfig.compilerOptions.paths).toMatchObject({
      "/js/books.js": ["./catalog/books.ts"],
      "/js/cart.js": ["./src/browser/cart.ts"],
      "/js/money.js": ["./src/browser/money.ts"],
    });
    // Every /js/ import in a browser script names a module that is published.
    for (const [path, content] of textFiles("cloudflare")) {
      for (const [, name] of content.matchAll(/from "\/js\/([\w-]+\.js)"/g)) {
        expect(publish, path).toContain(`"${name}":`);
      }
    }
  });
});
