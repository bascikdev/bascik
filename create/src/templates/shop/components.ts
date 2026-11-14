/**
 * @module templates/shop/components
 *
 * The shop template's components: each one's HTML, and the TypeScript beside it.
 * A component that reads the cart loads a companion module (`<script type="module"
 * src="name.ts">`), which imports the cart rules from `/js/cart.js`; the modules
 * under `/js/` are published by the site's `scripts/browser-modules.ts`.
 */

import {
  SITE_FOOTER_CSS,
  SITE_HEADER_CSS,
  SITE_META_HTML,
  STYLES_CSS,
  type Adapter,
} from "../../scaffold.js";

// ─── Global CSS ───────────────────────────────────────────────────────────────

/** The default starter's design system, plus the few global rules the shop adds. */
export const SHOP_STYLES_CSS = `${STYLES_CSS}
/* ── Shop ── */
/* Keeps a focused field or a link target clear of the sticky header. */
html { scroll-padding-top: 76px; }

/* An element's own display rule would otherwise override the hidden attribute. */
[hidden] { display: none !important; }

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* A page whose content is not one full-width section: the book page and the checkout. */
.page { max-width: 1140px; margin: 0 auto; padding: 72px 28px; }
@media (max-width: 640px) {
  .page { padding: 48px 28px; }
}

.status { min-height: 1.7em; color: var(--accent); }
.checkout-columns {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 40px;
  align-items: start;
}
@media (max-width: 760px) {
  .checkout-columns { grid-template-columns: minmax(0, 1fr); }
}
`;

// ─── Layout components ────────────────────────────────────────────────────────

/**
 * The default starter's head tags without its fixed description: every shop page
 * writes its own title and description with `seo()`.
 */
export const SHOP_SITE_META_HTML = `<!-- @bascik
Head tags every page shares: charset, viewport, icons and the global stylesheet.
Put it first in <head>, then add the page's own title and description with seo()
from src/lib/seo.ts.
-->
${SITE_META_HTML.split("\n")
  .filter((line) => !line.includes('name="description"'))
  .join("\n")}`;

/** Prints the site name from `src/lib/site.ts`, escaped by `html`. */
const SITE_NAME_SCRIPT = `<script data-bascik-build-once type="text/typescript">
        import { html } from "@bascik/bascik/html";
        import { siteName } from "@/lib/site.ts";
        export default () => html\`\${siteName}\`;
      </script>`;

export const SHOP_SITE_HEADER_HTML = `<style>
${SITE_HEADER_CSS}
.count {
  display: inline-block;
  min-width: 1.6em;
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #18191b;
  font-size: 0.75rem;
  font-weight: 700;
  text-align: center;
}
</style>
<header data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav aria-label="Main" data-testid="site-header-nav">
      <a href="/" class="logo" data-testid="site-header-logo">${SITE_NAME_SCRIPT}</a>
      <button id="nav-toggle" type="button" class="toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle">
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="menu" data-testid="site-header-nav-menu">
        <li><a href="/books/" data-testid="site-header-books">Books</a></li>
        <!-- The link works without JavaScript. The count stays hidden until the saved cart is read. -->
        <li><a id="cart-link" href="/cart" data-testid="site-header-cart">Cart <span id="cart-count" class="count" data-testid="site-header-cart-count" hidden></span></a></li>
      </ul>
    </nav>
  </div>
</header>
<script type="module" src="site-header.ts"></script>
`;

export const SHOP_SITE_HEADER_TS = `import { books } from "/js/books.js";
import { CART_CHANGED, cartCount, loadCart } from "/js/cart.js";

const toggle = document.getElementById("nav-toggle") as HTMLButtonElement;
const menu = document.getElementById("nav-menu") as HTMLUListElement;
toggle.addEventListener("click", (): void => {
  const open = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!open));
  menu.classList.toggle("is-open");
});

const link = document.getElementById("cart-link") as HTMLAnchorElement;
const count = document.getElementById("cart-count") as HTMLSpanElement;

/** Show how many books the saved cart holds. An empty cart shows no count. */
function showCount(): void {
  const items = cartCount(loadCart(books));
  count.textContent = String(items);
  count.hidden = items === 0;
  if (items === 0) link.removeAttribute("aria-label");
  else link.setAttribute("aria-label", \`Cart, \${items} \${items === 1 ? "book" : "books"}\`);
}

// Another component saved the cart, another tab did, or the page came back from the back/forward cache.
document.addEventListener(CART_CHANGED, showCount);
window.addEventListener("storage", showCount);
window.addEventListener("pageshow", (event: PageTransitionEvent): void => {
  if (event.persisted) showCount();
});
showCount();
`;

export const SHOP_SITE_FOOTER_HTML = `<style>
${SITE_FOOTER_CSS}</style>
<footer data-testid="site-footer">
  <div class="container">
    <div class="inner">
      <span class="copy">
        &copy;
        <script data-bascik-build-once type="text/typescript">
          import { html } from "@bascik/bascik/html";
          import { siteName } from "@/lib/site.ts";
          export default () => html\`\${new Date().getFullYear()} \${siteName}\`;
        </script>
      </span>
      <nav aria-label="Footer navigation" data-testid="site-footer-nav">
        <a href="/" data-testid="site-footer-home">Home</a>
        <a href="/books/" data-testid="site-footer-books">Books</a>
        <a href="/cart" data-testid="site-footer-cart">Cart</a>
      </nav>
    </div>
  </div>
</footer>
`;

export const HOME_HERO_HTML = `<section class="hero" data-testid="home-hero">
  <div class="container">
    <p class="section-label">Independent bookshop</p>
    <h1>Books worth <span>reading twice</span></h1>
    <p>A small shelf, chosen by hand. Every title here is invented: put your own in <code>catalog/books.ts</code>.</p>
    <div class="hero-actions">
      <a href="/books/" class="btn btn-primary" data-testid="home-hero-browse">Browse the books</a>
    </div>
  </div>
</section>
`;

// ─── Books ────────────────────────────────────────────────────────────────────

/**
 * A cover drawn with CSS and one inline SVG ornament: no image files. The root
 * has `role="img"` and a label, so the title and author inside it are read once.
 */
export const BOOK_COVER_HTML = `<!-- @bascik
A book cover drawn with CSS: no image file. Scales with the space it is given.
@prop title - The book's title, printed on the cover
@prop author - The author, printed under it
@prop tone - The cover color: plum, rust, teal, ink, moss or sand (TONES in src/lib/catalog.ts)
@prop label - The text alternative, such as "Cover of The Glass Tide by Rowan Achterberg"
-->
<style>
  .cover {
    display: block;
    width: 100%;
    /* The face sizes its text from this width (cqi), so a small cover stays readable. */
    container-type: inline-size;
  }
  .face {
    --paper: #3b3f47;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    aspect-ratio: 2 / 3;
    padding: 11cqi 9cqi 9cqi 14cqi;
    border-radius: 2cqi 5cqi 5cqi 2cqi;
    background:
      linear-gradient(90deg, rgba(0, 0, 0, 0.3) 0 5%, transparent 5% 100%),
      var(--paper);
    color: #fff;
    overflow: hidden;
  }
  .face[data-tone="plum"] { --paper: #5a3566; }
  .face[data-tone="rust"] { --paper: #8a3f24; }
  .face[data-tone="teal"] { --paper: #1f5c63; }
  .face[data-tone="ink"] { --paper: #26324f; }
  .face[data-tone="moss"] { --paper: #3f5a2c; }
  .face[data-tone="sand"] { --paper: #74552a; }
  .title { font-size: 11cqi; font-weight: 700; line-height: 1.15; }
  .author { font-size: 6.5cqi; letter-spacing: 0.08em; text-transform: uppercase; }
  .ornament { width: 36cqi; height: auto; }
</style>
<span class="cover" role="img" data-bascik-attr-aria-label="label" data-testid="book-cover">
  <span class="face" data-bascik-attr-data-tone="tone">
    <span class="title" data-bascik-prop-title></span>
    <svg class="ornament" viewBox="0 0 36 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
      <path d="M1 6h10M25 6h10M18 1l5 5-5 5-5-5z" />
    </svg>
    <span class="author" data-bascik-prop-author></span>
  </span>
</span>
`;

export const BOOK_COVER_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import type { Book } from "../../lib/catalog.ts";

/** The <book-cover> tag for a book. html escapes the title and author. */
export const bookCover = (book: Book): SafeHtml => {
  const label = \`Cover of \${book.title} by \${book.author}\`;
  return html\`<book-cover
    data-bascik-prop-title="\${book.title}"
    data-bascik-prop-author="\${book.author}"
    data-bascik-prop-tone="\${book.tone}"
    data-bascik-prop-label="\${label}"
  />\`;
};
`;

export const BOOK_CARD_HTML = `<!-- @bascik
One book in a list, linking to its page. The cover goes in the default slot.
@prop title - The book's title
@prop author - The author
@prop format - Hardcover, Paperback or Ebook
@prop price - The price as text, such as "$14.99"
@prop rating - The rating out of 5, such as "4.5"
@prop href - The book's page
-->
<style>
  article {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    padding: 16px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r);
  }
  h3 { margin: 6px 0 0; font-size: 1rem; }
  h3 a { color: var(--text); }
  .meta { margin: 0; font-size: 0.85rem; }
  .buy {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin: auto 0 0;
    font-size: 0.9rem;
  }
  .price { font-weight: 700; color: var(--accent); }
</style>
<article data-testid="book-card">
  <div data-bascik-slot></div>
  <h3><a data-bascik-attr-href="href" data-bascik-prop-title data-testid="book-card-link"></a></h3>
  <p class="meta"><span data-bascik-prop-author></span> · <span data-bascik-prop-format></span></p>
  <p class="buy">
    <span class="price" data-bascik-prop-price data-testid="book-card-price"></span>
    <span><span aria-hidden="true">★</span> <span data-bascik-prop-rating></span><span class="visually-hidden"> out of 5</span></span>
  </p>
</article>
`;

export const BOOK_CARD_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { bookPath, type Book } from "../../lib/catalog.ts";
import { formatCents } from "../../browser/money.ts";
import { bookCover } from "../book-cover/cover.ts";

/** The <book-card> tag for a book, with its cover in the slot. */
export const bookCard = (book: Book): SafeHtml => {
  const href = bookPath(book);
  return html\`<book-card
    data-bascik-prop-title="\${book.title}"
    data-bascik-prop-author="\${book.author}"
    data-bascik-prop-format="\${book.format}"
    data-bascik-prop-price="\${formatCents(book.priceCents)}"
    data-bascik-prop-rating="\${book.rating.toFixed(1)}"
    data-bascik-prop-href="\${href}"
  >\${bookCover(book)}</book-card>\`;
};
`;

/** The grid both book lists use. The `<li>` items come from a build script, so they are styled through the list. */
const BOOK_GRID_CSS = `.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 20px;
    margin: 28px 0;
    padding: 0;
    list-style: none;
  }`;

export const FEATURED_BOOKS_HTML = `<style>
  ${BOOK_GRID_CSS}
</style>
<section class="section" data-testid="featured-books">
  <div class="container">
    <p class="section-label">Staff picks</p>
    <h2>Featured books</h2>
    <ul class="grid" data-testid="featured-books-list">
      <script data-bascik-build-once src="./featured.ts"></script>
    </ul>
    <a href="/books/" class="btn btn-ghost" data-testid="featured-books-all">See every book →</a>
  </div>
</section>
`;

export const FEATURED_BOOKS_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { books } from "../../lib/catalog.ts";
import { bookCard } from "../book-card/card.ts";

/** One list item per book marked \`featured\` in catalog/books.ts. */
export default (): SafeHtml =>
  html\`\${books
    .filter((book) => book.featured)
    .map((book) => html\`<li>\${bookCard(book)}</li>\`)}\`;
`;

export const BOOK_CATALOG_HTML = `<style>
  ${BOOK_GRID_CSS}
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
    margin-bottom: 32px;
  }
  label { font-size: 0.88rem; font-weight: 600; }
  select {
    padding: 8px 12px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
  }
</style>
<section class="section" data-testid="book-catalog">
  <div class="container">
    <p class="section-label">Catalog</p>
    <h1>Books</h1>
    <p class="page-intro">Everything on the shelf. Each book has its own page.</p>
    <!-- Hidden until the script runs: without JavaScript every book is listed and no control is dead. -->
    <form id="controls" class="controls" aria-label="Sort and filter" hidden data-testid="book-catalog-controls">
      <label for="sort">Sort by</label>
      <select id="sort" data-testid="book-catalog-sort">
        <option value="title">Title</option>
        <option value="price-low">Price: low to high</option>
        <option value="price-high">Price: high to low</option>
        <option value="rating">Rating</option>
      </select>
      <label for="format">Format</label>
      <select id="format" data-testid="book-catalog-format">
        <option value="all">All formats</option>
        <script data-bascik-build-once type="text/typescript">
          import { formatOptions } from "./listing.ts";
          export default formatOptions;
        </script>
      </select>
    </form>
    <h2>All titles</h2>
    <p id="status" class="status" role="status" data-testid="book-catalog-status"></p>
    <ul id="list" class="grid" data-testid="book-catalog-list">
      <script data-bascik-build-once type="text/typescript">
        import { catalogItems } from "./listing.ts";
        export default catalogItems;
      </script>
    </ul>
  </div>
</section>
<script type="text/typescript">
  const controls = document.getElementById("controls") as HTMLFormElement;
  const sort = document.getElementById("sort") as HTMLSelectElement;
  const format = document.getElementById("format") as HTMLSelectElement;
  const status = document.getElementById("status") as HTMLParagraphElement;
  const list = document.getElementById("list") as HTMLUListElement;
  // Each item carries its book's facts in data- attributes, written at build time.
  const items = Array.from(list.children) as HTMLLIElement[];

  const byNumber = (name: string, direction: 1 | -1) =>
    (a: HTMLLIElement, b: HTMLLIElement): number =>
      direction * (Number(a.dataset[name]) - Number(b.dataset[name]));
  const orders: Record<string, (a: HTMLLIElement, b: HTMLLIElement) => number> = {
    title: (a, b) => (a.dataset.title ?? "").localeCompare(b.dataset.title ?? ""),
    "price-low": byNumber("price", 1),
    "price-high": byNumber("price", -1),
    rating: byNumber("rating", -1),
  };

  /** Put the items in the chosen order and hide the ones the format filter leaves out. */
  function apply(announce: boolean): void {
    list.append(...[...items].sort(orders[sort.value] ?? orders.title));
    let shown = 0;
    for (const item of items) {
      const match = format.value === "all" || item.dataset.format === format.value;
      item.hidden = !match;
      if (match) shown += 1;
    }
    if (announce) status.textContent = \`Showing \${shown} of \${items.length} books\`;
  }

  controls.hidden = false;
  controls.addEventListener("change", (): void => apply(true));
  controls.addEventListener("submit", (event: SubmitEvent): void => event.preventDefault());
  // The browser restores the selects on back and reload: match the list to them.
  window.addEventListener("pageshow", (): void => apply(false));
</script>
`;

export const BOOK_CATALOG_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { books, FORMATS } from "../../lib/catalog.ts";
import { bookCard } from "../book-card/card.ts";

/** One <option> per format the catalog allows. */
export const formatOptions = (): SafeHtml =>
  html\`\${FORMATS.map(
    (format) => html\`<option value="\${format}">\${format}</option>\`,
  )}\`;

/** Every book as a list item. The data- attributes are what the sort and filter script reads. */
export const catalogItems = (): SafeHtml =>
  html\`\${books.map(
    (book) =>
      html\`<li
        data-title="\${book.title}"
        data-price="\${book.priceCents}"
        data-rating="\${book.rating}"
        data-format="\${book.format}"
      >
        \${bookCard(book)}
      </li>\`,
  )}\`;
`;

export const BOOK_DETAIL_HTML = `<!-- @bascik
A book's own page: its facts and the add-to-cart button. The cover goes in the default slot.
@prop slug - The book's slug, which is its id in the cart
@prop title - The book's title
@prop author - The author
@prop format - Hardcover, Paperback or Ebook
@prop price - The price as text
@prop rating - The rating out of 5
@prop description - What the book is about
-->
<style>
  article {
    display: grid;
    grid-template-columns: minmax(160px, 260px) minmax(0, 1fr);
    gap: 40px;
    align-items: start;
  }
  h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); margin-bottom: 4px; }
  .facts { font-size: 0.9rem; }
  .description { color: var(--text); max-width: 60ch; }
  .price { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; }
  @media (max-width: 640px) {
    article { grid-template-columns: minmax(0, 1fr); }
    .art { max-width: 220px; }
  }
</style>
<article data-testid="book-detail">
  <div class="art"><div data-bascik-slot></div></div>
  <div>
    <h1 data-bascik-prop-title></h1>
    <p>by <span data-bascik-prop-author></span></p>
    <p class="facts">
      <span data-bascik-prop-format></span> ·
      <span aria-hidden="true">★</span> <span data-bascik-prop-rating></span><span class="visually-hidden"> out of 5</span>
    </p>
    <p class="description" data-bascik-prop-description></p>
    <p class="price" data-bascik-prop-price data-testid="book-detail-price"></p>
    <noscript><p>Adding a book to the cart needs JavaScript.</p></noscript>
    <div class="actions">
      <!-- Hidden until the script runs, so there is no button that does nothing. -->
      <button id="add" type="button" class="btn btn-primary" data-bascik-attr-data-book="slug" data-testid="book-detail-add" hidden>Add to cart</button>
      <a id="view-cart" href="/cart" class="btn btn-ghost" data-testid="book-detail-view-cart" hidden>View cart</a>
    </div>
    <p id="status" class="status" role="status" data-testid="book-detail-status"></p>
  </div>
</article>
<script type="module" src="book-detail.ts"></script>
`;

export const BOOK_DETAIL_TS = `import { books } from "/js/books.js";
import { addToCart, loadCart, saveCart } from "/js/cart.js";

const add = document.getElementById("add") as HTMLButtonElement;
const viewCart = document.getElementById("view-cart") as HTMLAnchorElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const id = add.dataset.book ?? "";

add.hidden = false;
viewCart.hidden = !loadCart(books).some((line) => line.id === id);

add.addEventListener("click", (): void => {
  const cart = addToCart(loadCart(books), id);
  if (!saveCart(cart)) {
    status.textContent =
      "This book could not be added: your browser is not letting this site save a cart.";
    return;
  }
  const copies = cart.find((line) => line.id === id)?.quantity ?? 0;
  status.textContent = \`Added. Your cart has \${copies} \${copies === 1 ? "copy" : "copies"} of this book.\`;
  viewCart.hidden = false;
});
`;

// ─── Cart ─────────────────────────────────────────────────────────────────────

export const CART_LIST_HTML = `<style>
  .lines { margin: 24px 0; padding: 0; list-style: none; }
  .line {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto auto auto;
    gap: 16px;
    align-items: center;
    padding: 16px 0;
    border-bottom: 1px solid var(--border);
  }
  .about { display: flex; flex-direction: column; }
  .name { color: var(--text); font-weight: 600; }
  .unit { font-size: 0.85rem; color: var(--text-muted); }
  .quantity { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }
  .quantity input {
    width: 4.5em;
    padding: 8px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font: inherit;
  }
  .amount { min-width: 5em; text-align: right; }
  .summary {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .total { margin: 0; font-size: 1.2rem; color: var(--text); }
  @media (max-width: 640px) {
    .line { grid-template-columns: 56px minmax(0, 1fr) auto; }
    .about { grid-column: 2 / -1; }
  }
</style>
<section class="section" data-testid="cart-list">
  <div class="container">
    <h1>Your cart</h1>
    <noscript><p>The cart is kept in your browser, so it needs JavaScript.</p></noscript>
    <p id="empty" data-testid="cart-list-empty" hidden>Your cart is empty. <a href="/books/">Browse the books</a>.</p>
    <!-- One hidden line per book in the catalog, written at build time. The script shows the
         lines that are in the cart and fills in their quantities: it never builds markup. -->
    <ul id="lines" class="lines" data-testid="cart-list-lines">
      <script data-bascik-build-once src="./lines.ts"></script>
    </ul>
    <p id="status" class="status" role="status" data-testid="cart-list-status"></p>
    <div id="summary" class="summary" hidden>
      <p class="total">Total <strong id="total" data-testid="cart-list-total"></strong></p>
      <a href="/checkout" class="btn btn-primary" data-testid="cart-list-checkout">Check out</a>
    </div>
  </div>
</section>
<script type="module" src="cart-list.ts"></script>
`;

export const CART_LIST_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { MAX_QUANTITY } from "../../browser/cart.ts";
import { bookPath, books } from "../../lib/catalog.ts";
import { formatCents } from "../../browser/money.ts";
import { bookCover } from "../book-cover/cover.ts";

/** A cart line for every book, hidden until cart-list.ts finds the book in the cart. */
export default (): SafeHtml =>
  html\`\${books.map((book) => {
    const href = bookPath(book);
    return html\`<li class="line" data-book="\${book.slug}" data-testid="cart-list-line" hidden>
      \${bookCover(book)}
      <span class="about">
        <a class="name" href="\${href}">\${book.title}</a>
        <span class="unit">\${formatCents(book.priceCents)} each</span>
      </span>
      <label class="quantity">
        Quantity<span class="visually-hidden"> of \${book.title}</span>
        <input
          type="number"
          inputmode="numeric"
          min="1"
          max="\${MAX_QUANTITY}"
          step="1"
          value="1"
          data-testid="cart-list-quantity"
        />
      </label>
      <strong class="amount" data-testid="cart-list-amount"></strong>
      <button type="button" class="btn btn-ghost" data-testid="cart-list-remove">
        Remove<span class="visually-hidden"> \${book.title}</span>
      </button>
    </li>\`;
  })}\`;
`;

export const CART_LIST_TS = `import { books } from "/js/books.js";
import {
  CART_CHANGED,
  MAX_QUANTITY,
  loadCart,
  priceCart,
  removeFromCart,
  saveCart,
  setQuantity,
  type CartLine,
} from "/js/cart.js";
import { formatCents } from "/js/money.js";

const lines = document.getElementById("lines") as HTMLUListElement;
const empty = document.getElementById("empty") as HTMLParagraphElement;
const summary = document.getElementById("summary") as HTMLDivElement;
const total = document.getElementById("total") as HTMLElement;
const status = document.getElementById("status") as HTMLParagraphElement;
// One line per book in the catalog, written at build time (lines.ts).
const rows = Array.from(lines.children) as HTMLLIElement[];

/** Show the saved cart: unhide its lines, fill in quantities and amounts, and total it. */
function render(): void {
  const cart = priceCart(loadCart(books), books);
  for (const row of rows) {
    const line = cart.lines.find((entry) => entry.id === row.dataset.book);
    row.hidden = !line;
    if (!line) continue;
    (row.querySelector("input") as HTMLInputElement).value = String(line.quantity);
    (row.querySelector("strong") as HTMLElement).textContent = formatCents(line.lineCents);
  }
  empty.hidden = cart.lines.length > 0;
  summary.hidden = cart.lines.length === 0;
  total.textContent = formatCents(cart.totalCents);
}

/** Save a changed cart and say what happened. Saving redraws every component that shows the cart. */
function change(cart: CartLine[], message: string): void {
  status.textContent = saveCart(cart)
    ? message
    : "That change was not saved: your browser is not letting this site save a cart.";
  render();
}

/** The slug of the book whose line holds this control. */
const bookOf = (control: Element): string =>
  control.closest("li")?.dataset.book ?? "";

lines.addEventListener("change", (event: Event): void => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const quantity = Number(input.value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    status.textContent = \`Choose a whole quantity from 1 to \${MAX_QUANTITY}, or remove the book.\`;
    render();
    return;
  }
  change(setQuantity(loadCart(books), bookOf(input), quantity), "Quantity updated.");
});

lines.addEventListener("click", (event: MouseEvent): void => {
  const button = event.target;
  if (!(button instanceof HTMLButtonElement)) return;
  change(removeFromCart(loadCart(books), bookOf(button)), "Removed from your cart.");
});

// Another tab changed the cart, or the page came back from the back/forward cache.
document.addEventListener(CART_CHANGED, render);
window.addEventListener("storage", render);
window.addEventListener("pageshow", (event: PageTransitionEvent): void => {
  if (event.persisted) render();
});
render();
`;

// ─── Checkout ─────────────────────────────────────────────────────────────────

export const FORM_FIELD_HTML = `<!-- @bascik
One required text field with its label and its error message.
@prop label - The visible label
@prop name - The key the value is submitted under
@prop type - The input type, such as text or email
@prop autocomplete - The autocomplete token, such as postal-code
-->
<style>
  .field { margin-bottom: 18px; }
  label { display: block; margin-bottom: 6px; font-size: 0.88rem; font-weight: 600; }
  input {
    width: 100%;
    padding: 10px 14px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
  }
  input[aria-invalid="true"] { border-color: #ff8f8f; }
  .error { margin: 6px 0 0; font-size: 0.85rem; color: #ff8f8f; }
</style>
<div class="field" data-testid="form-field">
  <label for="input" data-bascik-prop-label></label>
  <!-- The pattern refuses a value that is only spaces. -->
  <input id="input" required maxlength="200" pattern=".*\\S.*" aria-describedby="error" data-bascik-attr-name="name" data-bascik-attr-type="type" data-bascik-attr-autocomplete="autocomplete" data-testid="form-field-input" />
  <p id="error" class="error" data-testid="form-field-error" hidden></p>
</div>
<script type="text/typescript">
  const input = document.getElementById("input") as HTMLInputElement;
  const error = document.getElementById("error") as HTMLParagraphElement;

  /** Show the browser's own message for this field under it, or clear it. */
  function show(): void {
    const valid = input.validity.valid;
    error.textContent = valid ? "" : input.validationMessage;
    error.hidden = valid;
    input.setAttribute("aria-invalid", String(!valid));
  }

  // The form calls checkValidity() on submit, which fires "invalid" on each field that fails.
  input.addEventListener("invalid", show);
  input.addEventListener("input", (): void => {
    if (!error.hidden) show();
  });
</script>
`;

export const CHECKOUT_FORM_HTML = `<style>
  form { max-width: 560px; }
  .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
  .alert { color: #ff8f8f; }
  @media (max-width: 480px) {
    .pair { grid-template-columns: minmax(0, 1fr); }
  }
</style>
<section data-testid="checkout-form">
  <h2>Delivery address</h2>
  <noscript><p>The cart is kept in your browser, so the checkout needs JavaScript.</p></noscript>
  <p id="empty" data-testid="checkout-form-empty" hidden>There is nothing to check out yet. <a href="/books/">Find a book first</a>.</p>
  <!-- Shown by the script when the cart has something in it. novalidate turns off the browser's
       pop-up bubbles: the script checks the fields and each one shows its message in the page. -->
  <form id="form" novalidate data-testid="checkout-form-form" hidden>
    <div class="callout">
      <p>This is a demo checkout. No payment is taken and nothing you type leaves your browser.</p>
    </div>
    <form-field data-bascik-prop-label="Full name" data-bascik-prop-name="name" data-bascik-prop-type="text" data-bascik-prop-autocomplete="name" />
    <form-field data-bascik-prop-label="Email" data-bascik-prop-name="email" data-bascik-prop-type="email" data-bascik-prop-autocomplete="email" />
    <form-field data-bascik-prop-label="Street address" data-bascik-prop-name="address" data-bascik-prop-type="text" data-bascik-prop-autocomplete="street-address" />
    <div class="pair">
      <form-field data-bascik-prop-label="City" data-bascik-prop-name="city" data-bascik-prop-type="text" data-bascik-prop-autocomplete="address-level2" />
      <form-field data-bascik-prop-label="State or region" data-bascik-prop-name="region" data-bascik-prop-type="text" data-bascik-prop-autocomplete="address-level1" />
      <form-field data-bascik-prop-label="Postal code" data-bascik-prop-name="postal-code" data-bascik-prop-type="text" data-bascik-prop-autocomplete="postal-code" />
      <form-field data-bascik-prop-label="Country" data-bascik-prop-name="country" data-bascik-prop-type="text" data-bascik-prop-autocomplete="country-name" />
    </div>
    <p id="alert" class="alert" role="alert" data-testid="checkout-form-alert"></p>
    <button type="submit" class="btn btn-primary" data-testid="checkout-form-submit">Place demo order</button>
  </form>
</section>
<script type="module" src="checkout-form.ts"></script>
`;

export const CHECKOUT_FORM_TS = `import { books } from "/js/books.js";
import { CART_CHANGED, loadCart, saveCart } from "/js/cart.js";

const form = document.getElementById("form") as HTMLFormElement;
const empty = document.getElementById("empty") as HTMLParagraphElement;
const alert = document.getElementById("alert") as HTMLParagraphElement;

/** The form is only shown when there is something to order. */
function sync(): void {
  const hasItems = loadCart(books).length > 0;
  form.hidden = !hasItems;
  empty.hidden = hasItems;
}

form.addEventListener("submit", (event: SubmitEvent): void => {
  event.preventDefault();
  // checkValidity() fires "invalid" on every field that fails, and each <form-field> shows its message.
  if (!form.checkValidity()) {
    alert.textContent = "Some fields need attention. Check the messages above.";
    (form.querySelector("input:invalid") as HTMLInputElement | null)?.focus();
    return;
  }

  // DEMO: no payment is taken and nothing is sent anywhere.
  // Connect a payment provider here. A real checkout sends the cart's ids and quantities
  // (loadCart(books)) and new FormData(form) to your server, which prices the cart from the
  // catalog (priceCart in src/browser/cart.ts), creates the payment with your provider, and sends
  // the visitor to the provider's page. Empty the cart only once the provider confirms payment.
  saveCart([]);
  window.location.assign("/order-confirmed");
});

document.addEventListener(CART_CHANGED, sync);
window.addEventListener("storage", sync);
window.addEventListener("pageshow", (event: PageTransitionEvent): void => {
  if (event.persisted) sync();
});
sync();
`;

export const ORDER_SUMMARY_HTML = `<style>
  section {
    padding: 24px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: var(--r);
  }
  ul { margin: 0 0 16px; padding: 0; list-style: none; }
  .line {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
  }
  .copies { color: var(--text-muted); }
  .total { display: flex; justify-content: space-between; color: var(--text); font-size: 1.1rem; }
</style>
<section data-testid="order-summary">
  <h2>Order summary</h2>
  <!-- One hidden line per book, written at build time; the script shows the ones in the cart. -->
  <ul id="lines" data-testid="order-summary-lines">
    <script data-bascik-build-once src="./lines.ts"></script>
  </ul>
  <p class="total">Total <strong id="total" data-testid="order-summary-total"></strong></p>
  <p id="status" class="status" role="status" data-testid="order-summary-status"></p>
  <a href="/cart" data-testid="order-summary-edit">Edit cart</a>
</section>
<script type="module" src="order-summary.ts"></script>
`;

export const ORDER_SUMMARY_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { books } from "../../lib/catalog.ts";

/** A summary line for every book, hidden until order-summary.ts finds the book in the cart. */
export default (): SafeHtml =>
  html\`\${books.map(
    (book) =>
      html\`<li class="line" data-book="\${book.slug}" data-testid="order-summary-line" hidden>
        <span>\${book.title}</span>
        <span class="copies"></span>
        <strong></strong>
      </li>\`,
  )}\`;
`;

/** How the summary gets its prices: from the catalog in the page, or from the server. */
const PRICE_IN_BROWSER = `/** The cart with prices from the catalog. With a deploy adapter this is a request to the server instead. */
const price = async (cart: CartLine[]): Promise<PricedCart> =>
  priceCart(cart, books);`;

const PRICE_ON_SERVER = `/**
 * The cart, priced by the server (src/api/cart.ts). Only ids and quantities are sent,
 * so the totals shown here are the ones a real checkout would charge.
 */
async function price(cart: CartLine[]): Promise<PricedCart> {
  const response = await fetch("/api/cart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: cart }),
  });
  if (!response.ok) throw new Error(\`/api/cart answered \${response.status}\`);
  return (await response.json()) as PricedCart;
}`;

export const orderSummaryTs = (
  adapter?: Adapter,
): string => `import { books } from "/js/books.js";
import {
  CART_CHANGED,
  loadCart,${adapter ? "" : "\n  priceCart,"}
  type CartLine,
  type PricedCart,
} from "/js/cart.js";
import { formatCents } from "/js/money.js";

const lines = document.getElementById("lines") as HTMLUListElement;
const total = document.getElementById("total") as HTMLElement;
const status = document.getElementById("status") as HTMLParagraphElement;
// One line per book in the catalog, written at build time (lines.ts).
const rows = Array.from(lines.children) as HTMLLIElement[];

${adapter ? PRICE_ON_SERVER : PRICE_IN_BROWSER}

/** Counts renders, so a slow answer for an older cart never overwrites a newer one. */
let latest = 0;

/** Show the saved cart's lines and total. */
async function render(): Promise<void> {
  const turn = ++latest;
  let cart: PricedCart;
  try {
    cart = await price(loadCart(books));
  } catch {
    if (turn === latest) status.textContent = "The prices could not be confirmed. Reload the page to try again.";
    return;
  }
  if (turn !== latest) return;
  status.textContent = "";
  for (const row of rows) {
    const line = cart.lines.find((entry) => entry.id === row.dataset.book);
    row.hidden = !line;
    if (!line) continue;
    (row.querySelector(".copies") as HTMLElement).textContent = \`× \${line.quantity}\`;
    (row.querySelector("strong") as HTMLElement).textContent = formatCents(line.lineCents);
  }
  total.textContent = formatCents(cart.totalCents);
}

document.addEventListener(CART_CHANGED, render);
window.addEventListener("storage", render);
window.addEventListener("pageshow", (event: PageTransitionEvent): void => {
  if (event.persisted) void render();
});
void render();
`;

export const ORDER_CONFIRMATION_HTML = `<!--
  DEMO: this page is where the checkout ends, and nothing was charged to reach it.
  Connect a payment provider in src/components/checkout-form/checkout-form.ts (look for
  "Connect a payment provider here"). With a real provider, send visitors here from the
  provider's success redirect and show the order the provider confirmed, not the cart.
-->
<section class="section" data-testid="order-confirmation">
  <div class="container">
    <p class="section-label">Demo order</p>
    <h1>Thank you. This was a demo.</h1>
    <div class="callout">
      <p data-testid="order-confirmation-notice">No payment is taken; connect a payment provider here. Nothing was ordered, charged or sent, and your cart has been emptied.</p>
    </div>
    <a href="/books/" class="btn btn-primary mt-28" data-testid="order-confirmation-continue">Keep browsing</a>
  </div>
</section>
`;
