/**
 * @module templates/shop/pages
 *
 * The shop template's pages. Each is a shell that reads like a list of
 * component tags; its title and description come from `seo()` in a build script.
 */

interface PageOptions {
  /** Names the page's `<main>` for tests: `data-testid="<name>-main"`. */
  name: string;
  title: string;
  description: string;
  /** Keep the page out of search results and the sitemap. */
  noindex?: boolean;
  /** The content of `<main>`, indented six spaces. */
  body: string;
}

/**
 * A page: the shared head tags, the page's own title and description, the
 * header, one `<main id="main">`, and the footer. The title and description are
 * this template's own text, written as string literals with `JSON.stringify`.
 */
const page = ({
  name,
  title,
  description,
  noindex,
  body,
}: PageOptions): string => `<!doctype html>
<html lang="en">
  <head>
    <site-meta />${
      noindex
        ? `
    <!-- Bascik reads this tag from the source to leave the page out of sitemap.xml. -->
    <meta name="bascik-sitemap" content="exclude" />`
        : ""
    }
    <script data-bascik-build type="text/typescript">
      import { seo } from "@/lib/seo.ts";
      export default () =>
        seo({
          title: ${JSON.stringify(title)},
          description: ${JSON.stringify(description)},${
            noindex
              ? `
          noindex: true,`
              : ""
          }
        });
    </script>
  </head>
  <body>
    <site-header />
    <main id="main" data-testid="${name}-main">
${body}
    </main>
    <site-footer />
  </body>
</html>
`;

export const SHOP_INDEX_PAGE = page({
  name: "home",
  title: "Porsche parts and racewear",
  description:
    "Porsche-inspired parts, racewear and accessories shaped by 917, 935, 962 and 963 racing history.",
  body: `      <home-hero />
      <featured-books />`,
});

export const SHOP_BOOKS_PAGE = page({
  name: "books",
  title: "All racing products",
  description:
    "Browse Porsche racing products. Sort by name, price or rating, or filter by parts, racewear and accessories.",
  body: `      <book-catalog />`,
});

/**
 * One page per book. The routes script lists the catalog, and the two build
 * scripts print the head tags and the `<book-detail>` for the route being built.
 */
export const SHOP_BOOK_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
    <script data-bascik-build type="text/typescript">
      import { bookHead } from "./book-page.ts";
      export default bookHead;
    </script>
  </head>
  <body>
    <site-header />
    <main id="main" data-testid="book-main">
      <script data-bascik-routes type="text/typescript">
        import { books } from "@/lib/catalog.ts";
        // One page per book in catalog/books.ts, at /books/<slug>.
        export default () => books.map((book) => ({ params: { slug: book.slug } }));
      </script>
      <div class="page">
        <p><a href="/books/" data-testid="book-back">← All products</a></p>
        <script data-bascik-build type="text/typescript">
          import { bookBody } from "./book-page.ts";
          export default bookBody;
        </script>
      </div>
    </main>
    <site-footer />
  </body>
</html>
`;

export const SHOP_BOOK_PAGE_TS = `// What src/pages/books/[slug].html prints for each book: its head tags and its <book-detail>.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { bookCover } from "../../components/book-cover/cover.ts";
import { findBook, type Book } from "../../lib/catalog.ts";
import { formatCents } from "../../browser/money.ts";
import { absoluteUrl, jsonLd, seo } from "../../lib/seo.ts";

/** The book for the route being built. BASCIK_ROUTE holds the params the routes script returned. */
export function routeBook(): Book {
  const route = JSON.parse(process.env.BASCIK_ROUTE || "{}") as {
    params?: { slug?: string };
  };
  const book = findBook(route.params?.slug);
  if (!book) {
    throw new Error(
      \`No book in the catalog for \${process.env.BASCIK_PAGE_PATH ?? "this route"}.\`,
    );
  }
  return book;
}

/** The title, description and Product structured data. It describes only what the page shows. */
export function bookHead(): SafeHtml {
  const book = routeBook();
  const url = absoluteUrl(process.env.BASCIK_PAGE_PATH || "/");
  return html\`\${seo({
    title: \`\${book.title} by \${book.author}\`,
    description: book.description,
  })}\${jsonLd({
    "@type": "Product",
    name: book.title,
    description: book.description,
    sku: book.slug,
    offers: {
      "@type": "Offer",
      price: (book.priceCents / 100).toFixed(2),
      priceCurrency: "USD",
      ...(url ? { url } : {}),
    },
  })}\`;
}

export function bookBody(): SafeHtml {
  const book = routeBook();
  return html\`<book-detail
    data-bascik-prop-slug="\${book.slug}"
    data-bascik-prop-title="\${book.title}"
    data-bascik-prop-author="\${book.author}"
    data-bascik-prop-format="\${book.format}"
    data-bascik-prop-price="\${formatCents(book.priceCents)}"
    data-bascik-prop-rating="\${book.rating.toFixed(1)}"
    data-bascik-prop-description="\${book.description}"
  >\${bookCover(book)}</book-detail>\`;
}
`;

export const SHOP_CART_PAGE = page({
  name: "cart",
  title: "Your cart",
  description:
    "The racing products in your cart, kept in this browser. Change a quantity, remove a product, or go on to the demo checkout.",
  noindex: true,
  body: `      <cart-list />`,
});

export const SHOP_CHECKOUT_PAGE = page({
  name: "checkout",
  title: "Checkout",
  description:
    "Enter a delivery address and review your order. This is a demo checkout: no payment is taken.",
  noindex: true,
  body: `      <div class="page">
        <h1>Checkout</h1>
        <div class="checkout-columns">
          <checkout-form />
          <order-summary />
        </div>
      </div>`,
});

export const SHOP_ORDER_CONFIRMED_PAGE = page({
  name: "order-confirmed",
  title: "Demo order confirmed",
  description:
    "The end of the demo checkout. No payment was taken and nothing was ordered: connect a payment provider to sell for real.",
  noindex: true,
  body: `      <order-confirmation />`,
});

export const SHOP_NOT_FOUND_PAGE = page({
  name: "404",
  title: "Page not found",
  description:
    "This page is not in the paddock. Head back to the catalog to find a racing product.",
  noindex: true,
  body: `      <div class="container">
        <section class="section not-found">
          <p class="section-label">Error</p>
          <p class="not-found-code">404</p>
          <h1>Page not found</h1>
          <p class="not-found-text">That page is not in the paddock.</p>
          <a href="/books/" class="btn btn-primary">Browse the products</a>
        </section>
      </div>`,
});
