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
html[data-theme="light"] { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }

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

/* The main landmark starts below the navigation and keeps a clear page gutter. */
.shop-main {
  flex: 1;
  width: 100%;
  padding: clamp(24px, 4vw, 48px) clamp(16px, 4vw, 52px);
}
.shop-main > .container { max-width: 1280px; margin-inline: auto; }
.product-page { max-width: 1280px; margin-inline: auto; }

/* A page whose content is not one full-width section: the book page and the checkout. */
.page {
  max-width: 1140px;
  margin: 0 auto;
  padding: clamp(24px, 5vw, 52px);
  border: 1px solid var(--border);
  border-radius: 22px;
  background: var(--surface) var(--panel);
  box-shadow: var(--sheen), var(--shadow);
}
@media (max-width: 640px) {
  .page { padding: 28px 20px; border-radius: 16px; }
  .shop-main { padding: 24px 16px 36px; }
}

.status { min-height: 1.7em; color: var(--accent); }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 14px; margin-block: 24px; }
.filters label { display: grid; gap: 6px; font-size: 0.88rem; font-weight: 600; }
.filters select, .filters button { padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--elevated); color: var(--text); font: inherit; }
@media (max-width: 640px) {
  html[data-interactive] [data-testid="site-header-nav-toggle"] { display: flex !important; }
  html[data-interactive] [data-testid="site-header-nav-toggle"][hidden] { visibility: hidden; }
  html[data-interactive] [data-testid="site-header-nav-menu"] { display: none; }
}
.checkout-columns {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 40px;
  align-items: start;
}
@media (max-width: 760px) {
  .checkout-columns { grid-template-columns: minmax(0, 1fr); }
}

/* Initial content is visible immediately. Motion is reserved for interactions. */
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
  .filter(
    (line) =>
      !line.includes('name="description"') &&
      !line.includes('rel="stylesheet"'),
  )
  .join("\n")}
<script type="text/typescript">
  document.documentElement.dataset.interactive = "true";
  // Apply a valid saved preference before the page paints; storage may be blocked.
  try {
    const theme = localStorage.getItem("shop-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch { /* The system theme remains the default. */ }
</script>`;

/** Prints the site name from `src/lib/site.ts`, escaped by `html`. */
const SITE_NAME_SCRIPT = `<script data-bascik-build-once type="text/typescript">
        import { html } from "@bascik/bascik/html";
        import { siteName } from "@/lib/site.ts";
        export default () => html\`\${siteName}\`;
      </script>`;

export const SHOP_SITE_HEADER_HTML = `<style>
${SITE_HEADER_CSS}
@media (max-width: 640px) {
  .menu { display: flex; position: static; flex-direction: row; padding: 0; border: 0; background: none; }
  .menu li { width: auto; }
  .toggle:not([hidden]) + .menu { display: none; position: absolute; top: 60px; left: 0; right: 0; flex-direction: column; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .toggle:not([hidden]) + .menu.is-open { display: flex; }
}
.menu a { text-decoration: none; }
.menu a:hover { text-decoration: underline; text-underline-offset: 4px; }
.theme {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.theme svg { width: 22px; height: 22px; }
.theme[hidden] { display: inline-flex !important; visibility: hidden; }
.theme .sun { display: none; }
.theme[data-dark="true"] .sun { display: block; }
.theme[data-dark="true"] .moon { display: none; }
.count {
  display: inline-block;
  width: 3.5em;
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--elevated);
  color: var(--text-muted);
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
      <button id="nav-toggle" type="button" class="toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle" hidden>
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="menu" data-testid="site-header-nav-menu">
        <li><a href="/" data-testid="site-header-books">Shop</a></li>
        <li><a id="cart-link" href="/cart" aria-label="Cart, 0 items" data-testid="site-header-cart">Cart <span id="cart-count" class="count" data-testid="site-header-cart-count">0</span></a></li>
      </ul>
      <button id="theme" type="button" class="theme" aria-label="Switch to dark mode" data-testid="site-header-theme" hidden>
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z" /></svg>
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg>
      </button>
    </nav>
  </div>
</header>
<script src="site-header.ts"></script>
<script type="module" src="cart-count.ts"></script>
`;

export const SHOP_SITE_HEADER_TS = `const themeButton = document.getElementById("theme") as HTMLButtonElement;
const root = document.documentElement;
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function showTheme(): void {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : systemTheme.matches;
  themeButton.dataset.dark = String(dark);
  themeButton.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}
themeButton.hidden = false;
showTheme();
systemTheme.addEventListener("change", showTheme);
themeButton.addEventListener("click", (): void => {
  const theme = themeButton.dataset.dark === "true" ? "light" : "dark";
  root.classList.add("theme-switching");
  root.dataset.theme = theme;
  try { localStorage.setItem("shop-theme", theme); } catch { /* Still works for this page. */ }
  showTheme();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
});

const toggle = document.getElementById("nav-toggle") as HTMLButtonElement;
const menu = document.getElementById("nav-menu") as HTMLUListElement;
toggle.hidden = false;
toggle.addEventListener("click", (): void => {
  const open = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!open));
  menu.classList.toggle("is-open");
});
`;

export const SHOP_CART_COUNT_TS = `import { books } from "/js/books.js";
import { CART_CHANGED, cartCount, loadCart } from "/js/cart.js";

const link = document.getElementById("cart-link") as HTMLAnchorElement;
const count = document.getElementById("cart-count") as HTMLSpanElement;

function showCount(): void {
  const items = cartCount(loadCart(books));
  count.textContent = items > 999 ? "999+" : String(items);
  link.setAttribute("aria-label", \`Cart, \${items} \${items === 1 ? "item" : "items"}\`);
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
        <a href="/" data-testid="site-footer-books">Shop</a>
        <a href="/cart" data-testid="site-footer-cart">Cart</a>
      </nav>
    </div>
  </div>
</footer>
`;

export const HOME_HERO_HTML = `<style>
  .hero { padding-block: clamp(56px, 9vw, 112px) clamp(44px, 7vw, 84px); }
  .hero > .container { max-width: 1080px; }
  .hero h1 {
    max-width: 13ch;
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(3rem, 8vw, 6.5rem);
    font-weight: 400;
    letter-spacing: -0.055em;
    line-height: 0.98;
  }
  .hero h1 span { color: var(--accent); font-style: italic; }
  .hero > .container > p:not(.section-label) {
    max-width: 49ch;
    font-size: clamp(1.05rem, 1.8vw, 1.25rem);
    line-height: 1.65;
  }
  .hero-actions { margin-top: 30px; }
</style>
<section class="hero" data-testid="home-hero">
  <div class="container">
    <p class="section-label">Trackside essentials</p>
    <h1>Made for <span>the long way around.</span></h1>
    <p>Considered apparel, useful garage pieces and everyday accessories with a motorsport point of view.</p>
    <div class="hero-actions">
      <a href="/" class="btn btn-primary" data-testid="home-hero-browse">Explore the collection</a>
    </div>
  </div>
</section>
`;

// ─── Product artwork and cards ────────────────────────────────────────────────

/**
 * Original vector illustrations are selected for each specific product. No
 * book covers, external image service, or third-party product branding.
 */
export const PRODUCT_ART_HTML = `<!-- @bascik
An original, product-specific illustration drawn as inline SVG.
@prop format - Racewear, Parts or Accessories
@prop product - The product slug, used to select the matching illustration
@prop tone - The artwork palette: plum, rust, teal, ink, moss or sand
@prop label - A short text alternative describing the product illustration
-->
<style>
  .artwork {
    display: block;
    width: 100%;
    overflow: hidden;
    aspect-ratio: 4 / 3;
    border-radius: 12px;
    background: var(--art-bg, #e8e4da);
  }
  .artwork[data-tone="plum"] { --art-bg: #e9e2e8; --art-ink: #593e54; --art-detail: #b17e67; }
  .artwork[data-tone="rust"] { --art-bg: #eee3d9; --art-ink: #814a35; --art-detail: #d3a26e; }
  .artwork[data-tone="teal"] { --art-bg: #dce8e5; --art-ink: #315d58; --art-detail: #8aab9e; }
  .artwork[data-tone="ink"] { --art-bg: #dfe3e8; --art-ink: #354354; --art-detail: #8c9cab; }
  .artwork[data-tone="moss"] { --art-bg: #e3e7d9; --art-ink: #4a5a3d; --art-detail: #9bab7b; }
  .artwork[data-tone="sand"] { --art-bg: #eee8d8; --art-ink: #775a36; --art-detail: #b99961; }
  svg { display: none; width: 100%; height: 100%; color: var(--art-ink, #3e4c40); }
  .detail { stroke: var(--art-detail, #a18d67); }
  .artwork[data-product="pit-lane-coach-jacket"] .jacket,
  .artwork[data-product="gridline-driver-suit"] .suit,
  .artwork[data-product="brake-cooling-duct-kit"] .duct,
  .artwork[data-product="aero-display-panel"] .panel,
  .artwork[data-product="helmet-number-decal-set"] .helmet-decals,
  .artwork[data-product="interval-chronograph"] .chronograph,
  .artwork[data-product="door-number-decal-pack"] .door-decals,
  .artwork[data-product="wheel-fastener-kit"] .fasteners { display: block; }
</style>
<span class="artwork" role="img" data-bascik-attr-aria-label="label" data-bascik-attr-data-format="format" data-bascik-attr-data-product="product" data-bascik-attr-data-tone="tone" data-testid="product-art">
  <svg class="jacket" viewBox="0 0 240 180" aria-hidden="true">
    <path d="m88 36 32 12 32-12 31 23-19 27-16-11v73H92V75L76 86 57 59l31-23Z" fill="currentColor" />
    <path class="detail" d="M120 49v99m-18-96 10 13m26-13-10 13m-29 12h42m-42 9h42" fill="none" stroke-width="3" stroke-linecap="round" />
    <path d="M106 68h28v6h-28z" fill="var(--art-bg)" />
  </svg>
  <svg class="suit" viewBox="0 0 240 180" aria-hidden="true">
    <path d="m88 32 32 13 32-13 30 23-18 25-16-10v42l12 42H99l12-42V70L95 80 77 55l11-23Z" fill="currentColor" />
    <path class="detail" d="M120 45v82m-21-47h42m-37 18h32m-31 31-7 24m45-24 7 24" fill="none" stroke-width="3" stroke-linecap="round" />
    <path d="M109 65h22v8h-22z" fill="var(--art-bg)" />
  </svg>
  <svg class="duct" viewBox="0 0 240 180" aria-hidden="true">
    <path d="M64 49h47v28H93v55H64V77H49V61a12 12 0 0 1 15-12Zm112 0h-47v28h18v55h29V77h15V61a12 12 0 0 0-15-12Z" fill="currentColor" />
    <path class="detail" d="M71 56v14m98-14v14M76 85h10m68 0h10m-88 38h22m32 0h22" fill="none" stroke-width="4" stroke-linecap="round" />
    <path d="M105 64h30v67h-30z" fill="var(--art-bg)" />
  </svg>
  <svg class="panel" viewBox="0 0 240 180" aria-hidden="true">
    <path d="m60 49 111-12 12 86-111 13L60 49Z" fill="currentColor" />
    <path class="detail" d="m72 61 85-9m-80 21 4 28m17-31 4 28m17-31 4 28m17-31 4 28" fill="none" stroke-width="4" stroke-linecap="round" />
    <circle cx="72" cy="50" r="4" fill="var(--art-bg)" />
    <circle cx="170" cy="40" r="4" fill="var(--art-bg)" />
    <circle cx="178" cy="116" r="4" fill="var(--art-bg)" />
    <circle cx="83" cy="130" r="4" fill="var(--art-bg)" />
  </svg>
  <svg class="helmet-decals" viewBox="0 0 240 180" aria-hidden="true">
    <rect x="68" y="45" width="104" height="90" rx="8" fill="currentColor" />
    <path d="M83 58h74v64H83z" fill="var(--art-bg)" />
    <text x="120" y="106" fill="currentColor" font-size="48" font-family="system-ui" font-weight="700" text-anchor="middle">8</text>
    <circle class="detail" cx="76" cy="53" r="3" fill="none" stroke-width="3" />
    <circle class="detail" cx="164" cy="127" r="3" fill="none" stroke-width="3" />
  </svg>
  <svg class="chronograph" viewBox="0 0 240 180" aria-hidden="true">
    <path d="M102 25h36l9 42h-54l9-42Zm-9 88h54l-9 42h-36l-9-42Z" fill="currentColor" />
    <circle cx="120" cy="90" r="39" fill="var(--art-bg)" stroke="currentColor" stroke-width="8" />
    <path class="detail" d="M120 65v27l17 11m-49-33-8-7m81 0-8 7" fill="none" stroke-width="4" stroke-linecap="round" />
    <circle cx="120" cy="90" r="4" fill="currentColor" />
  </svg>
  <svg class="door-decals" viewBox="0 0 240 180" aria-hidden="true">
    <circle cx="83" cy="90" r="42" fill="currentColor" />
    <circle cx="157" cy="90" r="42" fill="currentColor" />
    <circle cx="83" cy="90" r="34" fill="var(--art-bg)" />
    <circle cx="157" cy="90" r="34" fill="var(--art-bg)" />
    <text x="83" y="102" fill="currentColor" font-size="38" font-family="system-ui" font-weight="700" text-anchor="middle">7</text>
    <text x="157" y="102" fill="currentColor" font-size="33" font-family="system-ui" font-weight="700" text-anchor="middle">24</text>
    <circle class="detail" cx="83" cy="90" r="41" fill="none" stroke-width="2" />
    <circle class="detail" cx="157" cy="90" r="41" fill="none" stroke-width="2" />
  </svg>
  <svg class="fasteners" viewBox="0 0 240 180" aria-hidden="true">
    <g fill="currentColor">
      <path d="M69 48h26v12H84v53H69z" /><path d="M107 39h26v12h-11v62h-15z" />
      <path d="M145 48h26v12h-11v53h-15z" /><path d="M88 116h26v12h-11v20H88z" />
      <path d="M126 116h26v12h-11v20h-15z" />
    </g>
    <g class="detail" fill="var(--art-bg)" stroke-width="2">
      <circle cx="78" cy="48" r="5" /><circle cx="116" cy="39" r="5" /><circle cx="154" cy="48" r="5" />
      <circle cx="97" cy="116" r="5" /><circle cx="135" cy="116" r="5" />
    </g>
  </svg>
</span>
`;

export const PRODUCT_ART_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import type { Book } from "../../lib/catalog.ts";

/** The <product-art> tag: product-specific, original art with an accessible label. */
export const productArt = (book: Book): SafeHtml => {
  const label = \`\${book.title} product illustration\`;
  return html\`<product-art
    data-bascik-prop-format="\${book.format}"
    data-bascik-prop-product="\${book.slug}"
    data-bascik-prop-tone="\${book.tone}"
    data-bascik-prop-label="\${label}"
  />\`;
};
`;

export const BOOK_CARD_HTML = `<!-- @bascik
One product in a list, linking to its page. Its illustration goes in the default slot.
@prop title - The product's title
@prop format - Racewear, Parts or Accessories
@prop price - The price as text, such as "$14.99"
@prop rating - The rating out of 5, such as "4.5"
@prop href - The product's page
-->
<style>
  article {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    padding: 14px;
    background: var(--surface) var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: none;
    transition: border-color 150ms ease-out, transform 150ms ease-out;
  }
  article:hover { border-color: var(--border-hover); transform: translateY(-2px); }
  h3 { margin: 6px 0 0; font-size: 1.05rem; }
  h3 a { color: var(--text); }
  .meta { margin: 0; color: var(--text-muted); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
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
  <p class="meta" data-bascik-prop-format></p>
  <p class="buy">
    <span class="price" data-bascik-prop-price data-testid="book-card-price"></span>
    <span><span aria-hidden="true">★</span> <span data-bascik-prop-rating></span><span class="visually-hidden"> out of 5</span></span>
  </p>
</article>
`;

export const BOOK_CARD_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { bookPath, type Book } from "../../lib/catalog.ts";
import { formatCents } from "../../browser/money.ts";
import { productArt } from "../product-art/art.ts";

/** The <book-card> tag for a product, with its category artwork in the slot. */
export const bookCard = (book: Book): SafeHtml => {
  const href = bookPath(book);
  return html\`<book-card
    data-bascik-prop-title="\${book.title}"
    data-bascik-prop-format="\${book.format}"
    data-bascik-prop-price="\${formatCents(book.priceCents)}"
    data-bascik-prop-rating="\${book.rating.toFixed(1)}"
    data-bascik-prop-href="\${href}"
  >\${productArt(book)}</book-card>\`;
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
    <p class="section-label">The selection</p>
    <h2>Considered for the track and beyond</h2>
    <ul class="grid" data-testid="featured-books-list">
      <script data-bascik-build-once src="./featured.ts"></script>
    </ul>
    <a href="/" class="btn btn-ghost" data-testid="featured-books-all">See every product →</a>
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
</style>
<section class="section" data-testid="book-catalog">
  <div class="container">
    <p class="section-label">Catalog</p>
    <h1>All products</h1>
    <p class="page-intro">Original apparel, workshop pieces and practical accessories with a motorsport point of view.</p>
    <div data-bascik-slot="controls"></div>
    <p class="status" role="status" data-bascik-prop-status data-testid="book-catalog-status"></p>
    <ul class="grid" data-testid="book-catalog-list">
      <div data-bascik-slot></div>
    </ul>
  </div>
</section>
`;

export const BOOK_CATALOG_HELPER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { FORMATS, type Book } from "../../lib/catalog.ts";
import { readCatalog, type CatalogContext } from "../../lib/racing-db.ts";
import { bookCard } from "../book-card/card.ts";

const orders: Record<string, (a: Book, b: Book) => number> = {
  title: (a, b) => a.title.localeCompare(b.title),
  "price-low": (a, b) => a.priceCents - b.priceCents,
  "price-high": (a, b) => b.priceCents - a.priceCents,
  rating: (a, b) => b.rating - a.rating,
};
const option = (value: string, label: string, selected: string): SafeHtml =>
  value === selected
    ? html\`<option value="\${value}" selected>\${label}</option>\`
    : html\`<option value="\${value}">\${label}</option>\`;

export async function catalogPage(request: Request, context: CatalogContext): Promise<SafeHtml> {
  const query = new URL(request.url).searchParams;
  const sort = query.get("sort") ?? "title";
  const format = query.get("format") ?? "all";
  if (!Object.hasOwn(orders, sort)) throw new Error("Unknown catalog sort order: " + sort);
  if (format !== "all" && !(FORMATS as readonly string[]).includes(format))
    throw new Error("Unknown catalog category: " + format);
  const books = await readCatalog(context);
  const selected = books.filter(book => format === "all" || book.format === format).sort(orders[sort]);
  return html\`<book-catalog data-bascik-prop-status="\${'Showing ' + selected.length + ' of ' + books.length + ' products'}">
    <div data-bascik-slot="controls">
      <form class="filters" action="/" method="get" aria-label="Sort and filter" data-testid="book-catalog-controls">
        <label>Sort by<select name="sort" data-testid="book-catalog-sort">
          \${option("title", "Title", sort)}
          \${option("price-low", "Price: low to high", sort)}
          \${option("price-high", "Price: high to low", sort)}
          \${option("rating", "Rating", sort)}
        </select></label>
        <label>Category<select name="format" data-testid="book-catalog-format">
          \${option("all", "All categories", format)}
          \${FORMATS.map(value => option(value, value, format))}
        </select></label>
        <button type="submit" data-testid="book-catalog-apply">Apply filters</button>
      </form>
    </div>
    \${selected.map(book => html\`<li>\${bookCard(book)}</li>\`)}
  </book-catalog>\`;
}
`;

export const BOOK_DETAIL_HTML = `<!-- @bascik
One product's detail page and add-to-cart button. Its illustration goes in the slot.
@prop slug - The product's slug, which is its id in the cart
@prop title - The product's title
@prop format - Racewear, Parts or Accessories
@prop price - The price as text
@prop rating - The rating out of 5
@prop description - What the product is
@prop material - Illustrative composition
@prop fit - Dimensions or fit guidance
@prop specification - Contents, care and intended use
@prop availability - Clearly labeled demo inventory
-->
<style>
  article {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: clamp(28px, 4vw, 64px);
    align-items: center;
    min-height: calc(100svh - 180px);
    max-width: 1280px;
    margin-inline: auto;
    padding: clamp(24px, 3vw, 44px);
    border-radius: var(--r);
    background: var(--surface);
    border: 1px solid var(--border);
  }
  h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); margin-bottom: 4px; }
  .facts { font-size: 0.9rem; }
  .description { color: var(--text); max-width: 60ch; }
  .price { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; }
  .information { min-width: 0; }
  .specs { margin: 24px 0; font-size: 0.9rem; }
  .specs > div { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 16px; padding-block: 12px; border-top: 1px solid var(--border); }
  dt { font-weight: 650; }
  dd { margin: 0; color: var(--text-muted); overflow-wrap: anywhere; }
  .demo { font-size: 0.8rem; }
  @media (max-width: 760px) {
    article { grid-template-columns: minmax(0, 1fr); min-height: auto; padding: 24px 20px; }
    .art { width: 100%; max-width: 420px; margin-inline: auto; }
    .specs > div { grid-template-columns: 84px minmax(0, 1fr); gap: 12px; }
  }
</style>
<article data-testid="book-detail">
  <div class="art"><div data-bascik-slot></div></div>
  <div class="information">
    <h1 data-bascik-prop-title></h1>
    <p class="facts">
      <span data-bascik-prop-format></span> ·
      <span aria-hidden="true">★</span> <span data-bascik-prop-rating></span><span class="visually-hidden"> out of 5</span> illustrative rating
    </p>
    <p class="description" data-bascik-prop-description></p>
    <dl class="specs" data-testid="book-detail-specs">
      <div><dt>Material</dt><dd data-bascik-prop-material></dd></div>
      <div><dt>Fit</dt><dd data-bascik-prop-fit></dd></div>
      <div><dt>Specification</dt><dd data-bascik-prop-specification></dd></div>
      <div><dt>Availability</dt><dd data-bascik-prop-availability></dd></div>
    </dl>
    <p class="demo">Illustrative product, specifications and rating. Demo checkout only; nothing is sold or shipped.</p>
    <p class="price" data-bascik-prop-price data-testid="book-detail-price"></p>
    <noscript><p>Adding a product to the cart needs JavaScript.</p></noscript>
    <div class="actions">
      <button id="add" type="button" class="btn btn-primary" data-bascik-attr-data-book="slug" data-testid="book-detail-add" disabled>Add to cart</button>
      <a id="view-cart" href="/cart" class="btn btn-ghost" data-testid="book-detail-view-cart">View cart</a>
    </div>
    <p id="status" class="status" role="status" data-testid="book-detail-status"></p>
  </div>
</article>
<script type="module" src="book-detail.ts"></script>
`;

export const BOOK_DETAIL_TS = `import { books } from "/js/books.js";
import { addToCart, loadCart, saveCart } from "/js/cart.js";

const add = document.getElementById("add") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const id = add.dataset.book ?? "";

add.addEventListener("click", (): void => {
  const cart = addToCart(loadCart(books), id);
  if (!saveCart(cart)) {
    status.textContent =
      "This product could not be added: your browser is not letting this site save a cart.";
    return;
  }
  const copies = cart.find((line) => line.id === id)?.quantity ?? 0;
  status.textContent = \`Added. Your cart has \${copies} \${copies === 1 ? "item" : "items"}.\`;
});
add.disabled = false;
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
    <p id="empty" data-testid="cart-list-empty" hidden>Your cart is empty. <a href="/">Browse the products</a>.</p>
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
import { productArt } from "../product-art/art.ts";

/** A cart line for every product, hidden until cart-list.ts finds it in the cart. */
export default (): SafeHtml =>
  html\`\${books.map((book) => {
    const href = bookPath(book);
    return html\`<li class="line" data-book="\${book.slug}" data-testid="cart-list-line" hidden>
      \${productArt(book)}
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
    status.textContent = \`Choose a whole quantity from 1 to \${MAX_QUANTITY}, or remove the product.\`;
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
  input[aria-invalid="true"] { border-color: var(--error); }
  .error { margin: 6px 0 0; font-size: 0.85rem; color: var(--error); }
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
  .alert { color: var(--error); }
  @media (max-width: 480px) {
    .pair { grid-template-columns: minmax(0, 1fr); }
  }
</style>
<section data-testid="checkout-form">
  <h2>Delivery address</h2>
  <noscript><p>The cart is kept in your browser, so the checkout needs JavaScript.</p></noscript>
  <p id="empty" data-testid="checkout-form-empty" hidden>There is nothing to check out yet. <a href="/">Choose a product first</a>.</p>
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

/** A summary line for every product, hidden until order-summary.ts finds the product in the cart. */
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
    <a href="/" class="btn btn-primary mt-28" data-testid="order-confirmation-continue">Keep browsing</a>
  </div>
</section>
`;
