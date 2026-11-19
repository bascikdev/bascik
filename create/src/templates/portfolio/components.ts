/**
 * @module templates/portfolio/components
 *
 * The portfolio's components, each with the Vitest test written beside it in the generated project.
 *
 * The header and footer use the default template's CSS (`SITE_HEADER_CSS`, `SITE_FOOTER_CSS`), so the skip link
 * is the same one: first in the header and clipped until it has focus. Their markup is the portfolio's own,
 * because the navigation differs and the name comes from `src/lib/site.ts` instead of a prop.
 */

import {
  SITE_FOOTER_CSS,
  SITE_HEADER_CSS,
  SITE_META_HTML,
} from "../../scaffold.js";

/** The first lines every generated component test shares. */
const testHead = (
  name: string,
): string => `import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/${name}/${name}.html"),
    "utf8",
  );
`;

// ─── site-meta ────────────────────────────────────────────────────────────────

/**
 * The default template's head tags without its one description for every page: here each page writes its own
 * through `seo()`, and two descriptions on a page would be a duplicate.
 */
export const SITE_META_HTML_PORTFOLIO = SITE_META_HTML.split("\n")
  .filter((line) => !line.includes('name="description"'))
  .join("\n");

export const SITE_META_TEST = `${testHead("site-meta")}
describe("site-meta component", () => {
  it("holds the tags every page shares: charset, viewport, icons, and the stylesheet", async () => {
    const html = await source();
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("favicon.ico");
    expect(html).toContain("favicon.svg");
    expect(html).toContain("apple-touch-icon.png");
    expect(html).toContain("/css/styles.css");
  });

  it("leaves the title and description to each page's seo() call", async () => {
    const html = await source();
    expect(html).not.toContain("<title");
    expect(html).not.toContain('name="description"');
  });
});
`;

// ─── site-header ──────────────────────────────────────────────────────────────

/** Sticky header: the skip link first, the site's name, and the navigation with a toggle at phone width. */
export const SITE_HEADER_HTML = `<style>
${SITE_HEADER_CSS}</style>
<header data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav aria-label="Main" data-testid="site-header-nav">
      <a href="/" class="logo" data-testid="site-header-logo"><script data-bascik-build-once type="text/typescript">
        import { html } from "@bascik/bascik/html";
        import { site } from "@/lib/site.ts";
        export default () => html\`\${site.name}\`;
      </script></a>
      <button id="nav-toggle" type="button" class="toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle">
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="menu" data-testid="site-header-nav-menu">
        <li><a href="/work" data-testid="site-header-work">Work</a></li>
        <li><a href="/about" data-testid="site-header-about">About</a></li>
        <li><a href="/contact" data-testid="site-header-contact">Contact</a></li>
      </ul>
    </nav>
  </div>
</header>
<script type="text/typescript">
  const toggle = document.getElementById("nav-toggle") as HTMLButtonElement;
  const menu = document.getElementById("nav-menu") as HTMLUListElement;
  toggle.addEventListener("click", (): void => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    menu.classList.toggle("is-open");
  });
</script>
`;

export const SITE_HEADER_TEST = `${testHead("site-header")}
describe("site-header component", () => {
  it("puts the skip link first, pointing at the page's main element", async () => {
    const html = await source();
    const header = html.slice(html.indexOf("<header"));
    expect(header.search(/<a\\s/)).toBe(header.search(/<a\\s+href="#main"/));
    expect(html).toContain(".skip-link:not(:focus)");
  });

  it("links to each section and reads the site's name from src/lib/site.ts", async () => {
    const html = await source();
    for (const href of ["/", "/work", "/about", "/contact"])
      expect(html).toContain(\`href="\${href}"\`);
    expect(html).toContain('from "@/lib/site.ts"');
    expect(html).toContain("site.name");
  });

  it("has a menu toggle that says which menu it controls and whether it is open", async () => {
    const html = await source();
    expect(html).toContain('aria-controls="nav-menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="nav-menu"');
  });
});
`;

// ─── site-footer ──────────────────────────────────────────────────────────────

export const SITE_FOOTER_HTML = `<style>
${SITE_FOOTER_CSS}</style>
<footer data-testid="site-footer">
  <div class="container">
    <div class="inner">
      <span class="copy">
        &copy;
        <script data-bascik-build-once type="text/typescript">
          import { html } from "@bascik/bascik/html";
          import { site } from "@/lib/site.ts";
          export default () => html\`\${String(new Date().getFullYear())} \${site.author}\`;
        </script>
      </span>
      <nav aria-label="Footer" data-testid="site-footer-nav">
        <a href="/work" data-testid="site-footer-work">Work</a>
        <a href="/about" data-testid="site-footer-about">About</a>
        <a href="/contact" data-testid="site-footer-contact">Contact</a>
      </nav>
    </div>
  </div>
</footer>
`;

export const SITE_FOOTER_TEST = `${testHead("site-footer")}
describe("site-footer component", () => {
  it("writes the year and the author's name once, at build time", async () => {
    const html = await source();
    expect(html).toContain("data-bascik-build-once");
    expect(html).toContain("getFullYear");
    expect(html).toContain("site.author");
  });

  it("links to each section", async () => {
    const html = await source();
    for (const href of ["/work", "/about", "/contact"])
      expect(html).toContain(\`href="\${href}"\`);
  });
});
`;

// ─── page-intro ───────────────────────────────────────────────────────────────

/** The heading group that opens a page: a short label, the page's one `<h1>`, and a sentence under it. */
export const PAGE_INTRO_HTML = `<!-- @bascik
The heading group that opens a page.
@prop label - A word or two above the heading
@prop title - The page's one h1
@prop text - A sentence under the heading
-->
<style>
  header {
    margin-bottom: 40px;
  }
  .text {
    margin-bottom: 0;
  }
</style>
<header data-testid="page-intro">
  <p class="section-label" data-bascik-prop-label></p>
  <h1 data-bascik-prop-title></h1>
  <p class="page-intro text" data-bascik-prop-text></p>
</header>
`;

export const PAGE_INTRO_TEST = `${testHead("page-intro")}
describe("page-intro component", () => {
  it("takes a label, a title for the page's one h1, and a line of text", async () => {
    const html = await source();
    expect(html).toContain("data-bascik-prop-label");
    expect(html).toMatch(/<h1\\s+data-bascik-prop-title\\s*>/);
    expect(html).toContain("data-bascik-prop-text");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
`;

// ─── home-intro ───────────────────────────────────────────────────────────────

export const HOME_INTRO_HTML = `<section class="hero" data-testid="home-intro">
  <div class="container">
    <script data-bascik-build-once type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { site } from "@/lib/site.ts";
      export default () =>
        html\`<p class="section-label">\${site.role}</p>
          <h1>\${site.author}</h1>
          <p>\${site.tagline}</p>\`;
    </script>
    <div class="hero-actions">
      <a href="/work" class="btn btn-primary">See race projects</a>
      <a href="/contact" class="btn btn-ghost">Get in touch</a>
    </div>
  </div>
</section>
`;

export const HOME_INTRO_TEST = `${testHead("home-intro")}
describe("home-intro component", () => {
  it("writes the racing site name as the page's h1 from src/lib/site.ts", async () => {
    const html = await source();
    expect(html).toContain("<h1>\${site.author}</h1>");
    expect(html).toContain("site.tagline");
  });

  it("links to the race projects and to the contact page", async () => {
    const html = await source();
    expect(html).toContain('href="/work"');
    expect(html).toContain('href="/contact"');
  });
});
`;

// ─── book-cover ───────────────────────────────────────────────────────────────

/**
 * A cover drawn in CSS: no image file. `role="img"` with the `alt` prop as its label makes it one image to a
 * screen reader, the way an `<img alt>` would be.
 */
export const BOOK_COVER_HTML = `<!-- @bascik
A book cover drawn in CSS, with no image file. To use real artwork, replace the div with an img element that has
width, height, and alt.
@prop title - The title printed on the cover
@prop alt - What the cover shows, read by screen readers in place of the drawing
@prop tone - The color: amber, moss, tide, plum, rust, or slate (COVER_TONES in src/lib/books.ts)
-->
<style>
  .cover {
    --from: #4b5563;
    --to: #252b35;
    container-type: inline-size;
    position: relative;
    aspect-ratio: 2 / 3;
    overflow: hidden;
    border-radius: 3px 8px 8px 3px;
    background: linear-gradient(160deg, var(--from), var(--to));
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
    color: #ffffff;
  }
  .cover[data-tone="amber"] {
    --from: #9a5a18;
    --to: #5a300f;
  }
  .cover[data-tone="moss"] {
    --from: #4f6b3a;
    --to: #283a20;
  }
  .cover[data-tone="tide"] {
    --from: #2a6584;
    --to: #15364d;
  }
  .cover[data-tone="plum"] {
    --from: #6d3f73;
    --to: #38203d;
  }
  .cover[data-tone="rust"] {
    --from: #9c412c;
    --to: #561f15;
  }

  /* The spine. */
  .cover::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 5%;
    background: rgba(0, 0, 0, 0.22);
  }

  .title {
    position: absolute;
    inset: 12% 8% auto 14%;
    font-family: Georgia, "Times New Roman", serif;
    /* Sized from the cover's own width, so a long word fits a small cover. */
    font-size: clamp(0.8rem, 9.5cqi, 2.2rem);
    font-weight: 700;
    line-height: 1.15;
    overflow-wrap: break-word;
  }

  /* A small ornament where a publisher's mark would be. */
  .mark {
    position: absolute;
    left: 14%;
    bottom: 10%;
    width: 16%;
    aspect-ratio: 1;
    border: 2px solid rgba(255, 255, 255, 0.7);
    border-radius: 50%;
  }
</style>
<div
  class="cover"
  role="img"
  data-bascik-attr-aria-label="alt"
  data-bascik-attr-data-tone="tone"
  data-testid="book-cover"
>
  <span class="title" data-bascik-prop-title></span>
  <span class="mark"></span>
</div>
`;

export const BOOK_COVER_TEST = `${testHead("book-cover")}
import { COVER_TONES } from "../../lib/books.ts";

describe("book-cover component", () => {
  it("is one image with a text alternative, and ships no image file", async () => {
    const html = await source();
    expect(html).toContain('role="img"');
    expect(html).toContain('data-bascik-attr-aria-label="alt"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("url(");
  });

  it("draws every cover color a book may name; slate is the color without a rule", async () => {
    const html = await source();
    for (const tone of COVER_TONES.filter((tone) => tone !== "slate"))
      expect(html).toContain(\`.cover[data-tone="\${tone}"]\`);
    expect(html).toContain('data-bascik-attr-data-tone="tone"');
  });
});
`;

// ─── book-card ────────────────────────────────────────────────────────────────

/** One book in a grid. The cover goes in the slot; the title's link covers the whole card. */
export const BOOK_CARD_HTML = `<!-- @bascik
One book in a grid: its cover in the slot, then what it is, its title, and a sentence about it.
@prop title - The book's title, linked to its page
@prop meta - A short line above the title, such as "Novel · 2023"
@prop summary - One sentence about the book
@prop href - The book's page
@slot default - The cover, a <book-cover />
-->
<style>
  article {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
  }
  .art {
    transition: transform 0.2s;
  }
  @media (hover: hover) {
    article:hover .art {
      transform: translateY(-3px);
    }
  }
  .meta {
    margin: 0 0 4px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h3 {
    margin: 0 0 6px;
    font-size: 1.05rem;
  }
  a {
    color: var(--text);
    text-decoration: none;
  }
  /* The link covers the card, so the cover and the text are one target with one name. */
  a::after {
    content: "";
    position: absolute;
    inset: 0;
  }
  a:focus-visible {
    outline: none;
  }
  a:focus-visible::after {
    outline: 2px solid var(--accent);
    outline-offset: 6px;
    border-radius: var(--r-sm);
  }
  .summary {
    margin: 0;
    font-size: 0.88rem;
  }
</style>
<article data-testid="book-card">
  <div class="art"><div data-bascik-slot></div></div>
  <div>
    <p class="meta" data-bascik-prop-meta></p>
    <h3>
      <a
        data-bascik-attr-href="href"
        data-bascik-prop-title
        data-testid="book-card-link"
      ></a>
    </h3>
    <p class="summary" data-bascik-prop-summary></p>
  </div>
</article>
`;

export const BOOK_CARD_TEST = `${testHead("book-card")}
describe("book-card component", () => {
  it("is an article whose title links to the book's page", async () => {
    const html = await source();
    expect(html).toMatch(/<article\\s[^>]*data-testid="book-card"/);
    expect(html).toContain('data-bascik-attr-href="href"');
    expect(html).toContain("data-bascik-prop-title");
  });

  it("takes the cover through its slot, and the line above and the sentence below as props", async () => {
    const html = await source();
    expect(html).toContain("<div data-bascik-slot></div>");
    expect(html).toContain("data-bascik-prop-meta");
    expect(html).toContain("data-bascik-prop-summary");
  });
});
`;

// ─── featured-books ───────────────────────────────────────────────────────────

export const FEATURED_BOOKS_HTML = `<style>
  .more {
    margin: 32px 0 0;
  }
</style>
<section class="section" data-testid="featured-books">
  <div class="container">
    <p class="section-label">Selected work</p>
    <h2>Start here</h2>
    <script data-bascik-build-once type="text/typescript">
      import { bookCards } from "@/lib/book-cards.ts";
      import { featuredBooks } from "@/lib/books.ts";
      export default () => bookCards(featuredBooks());
    </script>
    <p class="more"><a href="/work">See all the books</a></p>
  </div>
</section>
`;

export const FEATURED_BOOKS_TEST = `${testHead("featured-books")}
describe("featured-books component", () => {
  it("builds its cards from the featured books, under an h2", async () => {
    const html = await source();
    expect(html).toContain("<h2>");
    expect(html).toContain("bookCards(featuredBooks())");
    expect(html).toMatch(
      /<script\\s+data-bascik-build-once\\s+type="text\\/typescript"\\s*>/,
    );
  });

  it("links to the full list", async () => {
    expect(await source()).toContain('href="/work"');
  });
});
`;

// ─── book-list ────────────────────────────────────────────────────────────────

export const BOOK_LIST_HTML = `<section data-testid="book-list">
  <h2>All books</h2>
  <script data-bascik-build-once type="text/typescript">
    import { bookCards } from "@/lib/book-cards.ts";
    import { books } from "@/lib/books.ts";
    export default () => bookCards(books);
  </script>
</section>
`;

export const BOOK_LIST_TEST = `${testHead("book-list")}
describe("book-list component", () => {
  it("builds a card for every book, under an h2 so the cards' h3 skips no level", async () => {
    const html = await source();
    expect(html).toContain("<h2>All books</h2>");
    expect(html).toContain("bookCards(books)");
    expect(html).toMatch(
      /<script\\s+data-bascik-build-once\\s+type="text\\/typescript"\\s*>/,
    );
  });
});
`;

// ─── book-detail ──────────────────────────────────────────────────────────────

/** One book's page. Its build script reads the book from the route, so it is `data-bascik-build`, not build-once. */
export const BOOK_DETAIL_HTML = `<!-- @bascik
One book's page: cover, title, text, and links to the books on either side. Use it on
src/pages/work/[slug].html, whose routes script passes each book as the route's data.
-->
<style>
  .detail {
    display: grid;
    grid-template-columns: minmax(180px, 280px) minmax(0, 1fr);
    gap: 48px;
    align-items: start;
  }
  .text {
    max-width: 65ch;
  }
  .lead {
    font-size: 1.15rem;
    color: var(--text);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 40px;
    margin: 32px 0 0;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .fact dt {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .fact dd {
    margin: 0;
  }
  .pager {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px 24px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }
  @media (max-width: 640px) {
    .detail {
      grid-template-columns: minmax(0, 1fr);
      gap: 28px;
    }
    .art {
      max-width: 220px;
    }
  }
</style>
<article class="detail" data-testid="book-detail">
  <script data-bascik-build type="text/typescript">
    import { bookDetail } from "./detail.ts";
    export default () =>
      bookDetail(JSON.parse(process.env.BASCIK_ROUTE || "{}").data);
  </script>
</article>
`;

/** `src/components/book-detail/detail.ts`: the markup of one book's page, kept beside the component that uses it. */
export const BOOK_DETAIL_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { bookPath, books, type Book } from "../../lib/books.ts";

/** A link to the book before or after this one, or nothing at either end of the list. */
const pagerLink = (
  book: Book | undefined,
  label: string,
  testId: string,
): SafeHtml | "" => {
  if (!book) return "";
  const href = bookPath(book);
  return html\`<a href="\${href}" data-testid="\${testId}"
    >\${label}: \${book.title}</a
  >\`;
};

/**
 * The inside of <book-detail> for one book: the cover, the text, a few facts, and links to the books on either
 * side of it in the list. html escapes every value.
 */
export function bookDetail(
  book: Book | undefined,
  all: readonly Book[] = books,
): SafeHtml {
  if (!book?.slug)
    throw new Error(
      "<book-detail> found no book in BASCIK_ROUTE. Use it on src/pages/work/[slug].html, whose routes script passes each book as the route's data.",
    );
  const index = all.findIndex((other) => other.slug === book.slug);
  const newer = index > 0 ? all[index - 1] : undefined;
  const older = index >= 0 ? all[index + 1] : undefined;
  return html\`<div class="art">
      <book-cover
        data-bascik-prop-title="\${book.title}"
        data-bascik-prop-alt="\${book.cover.alt}"
        data-bascik-prop-tone="\${book.cover.tone}"
      />
    </div>
    <div class="text">
      <p class="section-label">\${book.kind}</p>
      <h1>\${book.title}</h1>
      <p class="lead">\${book.summary}</p>
      \${book.description.map((paragraph) => html\`<p>\${paragraph}</p>\`)}
      <dl class="facts">
        <div class="fact">
          <dt>Published</dt>
          <dd>\${String(book.year)}</dd>
        </div>
        \${
          book.pages
            ? html\`<div class="fact">
                <dt>Length</dt>
                <dd>\${String(book.pages)} pages</dd>
              </div>\`
            : ""
        }
      </dl>
    </div>
    <nav class="pager" aria-label="More books" data-testid="book-detail-pager">
      \${pagerLink(newer, "Newer", "book-detail-newer")}
      <a href="/work" data-testid="book-detail-all">All books</a>
      \${pagerLink(older, "Older", "book-detail-older")}
    </nav>\`;
}
`;

export const BOOK_DETAIL_TEST = `${testHead("book-detail")}
import { books, type Book } from "../../lib/books.ts";
import { bookDetail } from "./detail.ts";

const book: Book = {
  slug: "a-test-book",
  title: "A Test Book",
  year: 2024,
  kind: "Novel",
  summary: "One sentence about the book.",
  description: ["First paragraph.", "Second paragraph."],
  cover: { tone: "moss", alt: "Cover of A Test Book." },
};

describe("book-detail component", () => {
  it("is an article that reads its book from the route", async () => {
    const html = await source();
    expect(html).toMatch(/<article\\s[^>]*data-testid="book-detail"/);
    expect(html).toMatch(
      /<script\\s+data-bascik-build\\s+type="text\\/typescript"\\s*>/,
    );
    expect(html).toContain("process.env.BASCIK_ROUTE");
  });

  it("writes the title as the page's h1, a paragraph per entry, and the cover with its text alternative", () => {
    const markup = String(bookDetail(book, [book]));
    expect(markup).toContain("<h1>A Test Book</h1>");
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain("<p>First paragraph.</p>");
    expect(markup).toContain("<p>Second paragraph.</p>");
    expect(markup).toContain('data-bascik-prop-alt="Cover of A Test Book."');
    expect(markup).toContain("<dd>2024</dd>");
    expect(markup).not.toContain("pages</dd>");
  });

  it("links to the books on either side, and to neither at the ends of the list", () => {
    const [first, second, third] = books;
    const middle = String(bookDetail(second));
    expect(middle).toContain(\`href="/work/\${first.slug}"\`);
    expect(middle).toContain(\`href="/work/\${third.slug}"\`);
    expect(String(bookDetail(first))).not.toContain("book-detail-newer");
    expect(String(bookDetail(books.at(-1)))).not.toContain("book-detail-older");
    expect(String(bookDetail(book, [book]))).toContain('href="/work"');
  });

  it("misuse: escapes markup in a book's text", () => {
    const markup = String(
      bookDetail(
        {
          ...book,
          title: "<script>alert(1)</script>",
          description: ['"Quoted" & <b>bold</b>'],
        },
        [],
      ),
    );
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&amp; &lt;b&gt;bold&lt;/b&gt;");
  });

  it("misuse: used on a page that is not the book route, it says where it belongs", () => {
    expect(() => bookDetail(undefined)).toThrow("src/pages/work/[slug].html");
    expect(() => bookDetail({} as Book)).toThrow("BASCIK_ROUTE");
  });
});
`;

// ─── author-bio ───────────────────────────────────────────────────────────────

export const AUTHOR_BIO_HTML = `<style>
  section {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
    gap: 48px;
    align-items: start;
  }
  .prose {
    max-width: 65ch;
  }
  h2 {
    margin-top: 36px;
  }
  h2:first-child {
    margin-top: 0;
  }
  .facts {
    margin: 0;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: var(--r);
    background: var(--elevated);
  }
  .fact + .fact {
    margin-top: 16px;
  }
  .fact dt {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .fact dd {
    margin: 0;
  }
  @media (max-width: 760px) {
    section {
      grid-template-columns: minmax(0, 1fr);
      gap: 28px;
    }
  }
</style>
<section data-testid="racing-bio">
  <div class="prose">
    <h2>Built around the stopwatch</h2>
    <p>Race engineering starts with clear feedback, repeatable setup changes, and a plan for every session.</p>
    <h2>Classic machinery, present purpose</h2>
    <p>Restoration and track work covers Porsche 917, 935, 962, and 963 history with a modern standard of preparation.</p>
    <p><a href="/contact">Discuss a race project</a></p>
  </div>
  <dl class="facts">
    <div class="fact"><dt>Circuits</dt><dd>Daytona, Sebring, Le Mans, Spa, Laguna Seca</dd></div>
    <div class="fact"><dt>Specialties</dt><dd>Engineering, restoration, photography</dd></div>
    <div class="fact"><dt>References</dt><dd>Hurley Haywood, Paul Newman, Jordan Taylor, Ross Bentley</dd></div>
  </dl>
</section>
`;

export const AUTHOR_BIO_TEST = `${testHead("author-bio")}
describe("author-bio component", () => {
  it("tells the author's story under h2 headings, with a list of facts beside it", async () => {
    const html = await source();
    expect(html).toMatch(/<section\\s[^>]*data-testid="author-bio"/);
    expect(html).not.toContain("<h1");
    expect(html.match(/<h2>/g)!.length).toBeGreaterThan(0);
    expect(html.match(/<dt>/g)).toHaveLength(html.match(/<dd>/g)!.length);
  });

  it("links to the contact page", async () => {
    expect(await source()).toContain('href="/contact"');
  });
});
`;

// ─── contact-form ─────────────────────────────────────────────────────────────

/**
 * Contact form. The fields are checked by the browser's own rules (`required`, `type="email"`, `minlength`); the
 * script reports the first problem in the status line and moves focus to that field. The starter has no backend,
 * so a valid form shows a note in place of sending. Field names ship as written, so `new FormData(form)` has
 * the keys name, email and message.
 */
export const CONTACT_FORM_HTML = `<!-- @bascik
A contact form that checks its fields in the browser. Nothing receives it yet: send it to your own endpoint in
the script's submit handler.
-->
<style>
  form {
    max-width: 520px;
  }
  .field {
    margin-bottom: 20px;
  }
  label {
    display: block;
    margin-bottom: 6px;
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
  }
  .input {
    width: 100%;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--elevated);
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
    transition: border-color 0.15s;
  }
  .input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .input[aria-invalid="true"] {
    border-color: #ff9d8a;
  }
  textarea {
    min-height: 120px;
    resize: vertical;
  }
  .status {
    margin: 16px 0 0;
    color: var(--accent);
  }
  .status[data-state="error"] {
    color: #ff9d8a;
  }
</style>
<form id="form" data-testid="contact-form">
  <div class="field">
    <label for="name">Name</label>
    <input
      class="input"
      type="text"
      id="name"
      name="name"
      autocomplete="name"
      required
      data-testid="contact-form-name"
    />
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input
      class="input"
      type="email"
      id="email"
      name="email"
      autocomplete="email"
      required
      data-testid="contact-form-email"
    />
  </div>
  <div class="field">
    <label for="message">Message</label>
    <textarea
      class="input"
      id="message"
      name="message"
      required
      minlength="10"
      data-testid="contact-form-message"
    ></textarea>
  </div>
  <button
    type="submit"
    class="btn btn-primary"
    data-testid="contact-form-submit"
  >
    Send message
  </button>
  <p
    id="status"
    class="status"
    role="status"
    data-testid="contact-form-status"
  ></p>
</form>
<script type="text/typescript">
  type Field = HTMLInputElement | HTMLTextAreaElement;
  const form = document.getElementById("form") as HTMLFormElement;
  const status = document.getElementById("status") as HTMLParagraphElement;
  const fields: [label: string, field: Field][] = [
    ["Name", document.getElementById("name") as HTMLInputElement],
    ["Email", document.getElementById("email") as HTMLInputElement],
    ["Message", document.getElementById("message") as HTMLTextAreaElement],
  ];

  // With the script running, problems are reported in the status line. Without it, the browser's own messages are.
  form.noValidate = true;
  form.addEventListener("submit", (event: SubmitEvent): void => {
    event.preventDefault();
    for (const [, field] of fields)
      field.setAttribute("aria-invalid", String(!field.validity.valid));
    const problem = fields.find(([, field]) => !field.validity.valid);
    if (problem) {
      const [label, field] = problem;
      status.setAttribute("data-state", "error");
      status.textContent = label + ": " + field.validationMessage;
      field.focus();
      return;
    }
    // Nothing receives the form yet: send new FormData(form) to your own endpoint here.
    status.setAttribute("data-state", "sent");
    status.textContent = "Thanks! This starter form does not send anything yet.";
  });
</script>
`;

export const CONTACT_FORM_TEST = `${testHead("contact-form")}
describe("contact-form component", () => {
  it("labels every field, names it for the server, and requires it", async () => {
    const html = await source();
    const controls = html.match(/<(?:input|textarea)\\s[^>]*>/g) ?? [];
    expect(controls).toHaveLength(3);
    for (const id of ["name", "email", "message"]) {
      expect(html).toContain(\`<label for="\${id}">\`);
      const control = controls.find((tag) => tag.includes(\`id="\${id}"\`));
      expect(control, id).toContain(\`name="\${id}"\`);
      expect(control, id).toMatch(/\\srequired\\s/);
    }
  });

  it("states its rules in HTML, so they hold without the script", async () => {
    const html = await source();
    expect(html).toContain('type="email"');
    expect(html).toContain('minlength="10"');
  });

  it("reports problems in a status line from a TypeScript script", async () => {
    const html = await source();
    expect(html).toContain('role="status"');
    expect(html).toContain('<script type="text/typescript">');
    expect(html).toContain("preventDefault");
    expect(html).toContain("validationMessage");
  });
});
`;

export const PROJECT_CARD_HTML = `<style>
  article {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface) var(--panel);
    box-shadow: var(--sheen), var(--shadow);
  }
  .visual { position: relative; aspect-ratio: 16 / 10; overflow: hidden; border-radius: 12px; background: var(--elevated); }
  .visual[data-accent="amber"] { background: #9a5a18; }
  .visual[data-accent="tide"] { background: #2a6584; }
  .visual[data-accent="moss"] { background: #4f6b3a; }
  .visual[data-accent="rust"] { background: #9c412c; }
  .visual[data-accent="slate"] { background: #566270; }
  .visual[data-accent="plum"] { background: #6d3f73; }
  .visual::after { content: ""; position: absolute; inset: 18% 12%; border: 1px solid rgba(255,255,255,.65); }
  h3 { margin: 0 0 6px; }
  a { color: var(--text); text-decoration: none; }
  a::after { content: ""; position: absolute; inset: 0; }
  .meta { margin: 0 0 4px; font-size: .72rem; font-weight: 700; text-transform: uppercase; color: var(--accent); }
  .summary { margin: 0; font-size: .88rem; }
</style>
<article data-testid="project-card">
  <div class="visual" data-bascik-attr-data-accent="accent" aria-hidden="true"></div>
  <div>
    <p class="meta" data-bascik-prop-meta></p>
    <h3><a data-bascik-attr-href="href" data-bascik-prop-title data-testid="project-card-link"></a></h3>
    <p class="summary" data-bascik-prop-summary></p>
  </div>
</article>
`;

export const PROJECT_CARD_TEST = `${testHead("project-card")}
describe("project-card component", () => {
  it("is an article linking to a race project", async () => {
    const html = await source();
    expect(html).toContain('<article data-testid="project-card">');
    expect(html).toContain('data-bascik-attr-href="href"');
  });
});
`;

export const PROJECT_LIST_HTML = `<section data-testid="project-list">
  <h2>All race projects</h2>
  <script data-bascik-build-once type="text/typescript">
    import { projectCards } from "@/lib/project-cards.ts";
    import { projects } from "@/lib/projects.ts";
    export default () => projectCards(projects);
  </script>
</section>
`;

export const PROJECT_LIST_TEST = `${testHead("project-list")}
describe("project-list component", () => {
  it("lists every project under an h2", async () => {
    const html = await source();
    expect(html).toContain("<h2>All race projects</h2>");
    expect(html).toContain("projectCards(projects)");
  });
});
`;

export const FEATURED_PROJECTS_HTML = `<section class="section" data-testid="featured-projects">
  <div class="container">
    <p class="section-label">Selected work</p>
    <h2>From the paddock</h2>
    <script data-bascik-build-once type="text/typescript">
      import { projectCards } from "@/lib/project-cards.ts";
      import { featuredProjects } from "@/lib/projects.ts";
      export default () => projectCards(featuredProjects());
    </script>
    <p class="more"><a href="/work">See all race projects</a></p>
  </div>
</section>
`;

export const FEATURED_PROJECTS_TEST = `${testHead("featured-projects")}
describe("featured-projects component", () => {
  it("builds featured race cards and links to the full list", async () => {
    const html = await source();
    expect(html).toContain("projectCards(featuredProjects())");
    expect(html).toContain('href="/work"');
  });
});
`;

export const PROJECT_DETAIL_HTML = `<style>
  .detail { display: grid; grid-template-columns: minmax(180px, 280px) minmax(0, 1fr); gap: 48px; align-items: start; padding: clamp(20px, 4vw, 36px); border: 1px solid var(--border); border-radius: 22px; background: var(--surface) var(--panel); box-shadow: var(--sheen), var(--shadow); }
  .visual { aspect-ratio: 4 / 5; border-radius: 14px; background: var(--elevated); }
  .visual[data-accent="amber"] { background: #9a5a18; }
  .visual[data-accent="tide"] { background: #2a6584; }
  .visual[data-accent="moss"] { background: #4f6b3a; }
  .visual[data-accent="rust"] { background: #9c412c; }
  .visual[data-accent="slate"] { background: #566270; }
  .visual[data-accent="plum"] { background: #6d3f73; }
  .text { max-width: 65ch; }
  .lead { font-size: 1.15rem; }
  .facts { display: flex; gap: 12px 40px; margin: 32px 0 0; padding-top: 20px; border-top: 1px solid var(--border); }
  .pager { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 12px 24px; padding-top: 24px; border-top: 1px solid var(--border); }
  @media (max-width: 640px) { .detail { grid-template-columns: minmax(0, 1fr); gap: 28px; } }
</style>
<article class="detail" data-testid="project-detail">
  <script data-bascik-build type="text/typescript">
    import { projectDetail } from "./detail.ts";
    export default () => projectDetail(JSON.parse(process.env.BASCIK_ROUTE || "{}").data);
  </script>
</article>
`;

export const PROJECT_DETAIL_TEST = `${testHead("project-detail")}
describe("project-detail component", () => {
  it("reads a project from the dynamic route", async () => {
    const html = await source();
    expect(html).toContain('data-testid="project-detail"');
    expect(html).toContain("BASCIK_ROUTE");
  });
});
`;

export const PROJECT_DETAIL_TS = `import { html, raw, type SafeHtml } from "@bascik/bascik/html";
import { projectPath, projects, type Project } from "../../lib/projects.ts";

export function projectDetail(project: Project | undefined): SafeHtml {
  if (!project?.slug) throw new Error("<project-detail> found no project in BASCIK_ROUTE.");
  const index = projects.findIndex((other) => other.slug === project.slug);
  const previous = index > 0 ? projects[index - 1] : undefined;
  const next = index >= 0 ? projects[index + 1] : undefined;
  return html\`<div class="visual" data-accent="\${project.accent}" aria-label="\${project.title} project" role="img"></div>
    <div class="text">
      <p class="section-label">\${project.category}</p>
      <h1>\${project.title}</h1>
      <p class="lead">\${project.summary}</p>
      \${raw(String(project.html))}
      <dl class="facts">
        <div><dt>Year</dt><dd>\${String(project.year)}</dd></div>
        <div><dt>Disciplines</dt><dd>\${project.tags.join(" / ")}</dd></div>
      </dl>
    </div>
    <nav class="pager" aria-label="More race projects" data-testid="project-detail-pager">
      \${previous ? html\`<a href="\${projectPath(previous)}" data-testid="project-detail-newer">Newer: \${previous.title}</a>\` : ""}
      <a href="/work" data-testid="project-detail-all">All race projects</a>
      \${next ? html\`<a href="\${projectPath(next)}" data-testid="project-detail-older">Older: \${next.title}</a>\` : ""}
    </nav>\`;
}
`;

export const RACING_BIO_HTML = `<style>
  section { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 300px); gap: 48px; }
  .prose { max-width: 65ch; }
  h2 { margin-top: 36px; } h2:first-child { margin-top: 0; }
  .facts { margin: 0; padding: 24px; border: 1px solid var(--border); border-radius: var(--r); background: var(--elevated); }
  .fact + .fact { margin-top: 16px; } .fact dt { font-weight: 700; color: var(--accent); }
  .fact dd { margin: 0; }
  @media (max-width: 760px) { section { grid-template-columns: 1fr; gap: 28px; } }
</style>
<section data-testid="racing-bio">
  <div class="prose">
    <h2>Built around the stopwatch</h2>
    <p>Hayden Vale Racing brings race engineering discipline to historic and modern programs: clear driver feedback, repeatable setup work, and a plan for every session.</p>
    <h2>Classic machinery, present purpose</h2>
    <p>Work spans restoration planning for Porsche 917, 935, 962, and 963 programs, from workshop provenance to track-day preparation.</p>
    <p><a href="/contact">Discuss a race project</a></p>
  </div>
  <dl class="facts">
    <div class="fact"><dt>Circuits</dt><dd>Daytona, Sebring, Le Mans, Spa, Laguna Seca</dd></div>
    <div class="fact"><dt>Specialties</dt><dd>Race engineering, restoration, photography</dd></div>
    <div class="fact"><dt>References</dt><dd>Hurley Haywood, Paul Newman, Jordan Taylor, Ross Bentley</dd></div>
  </dl>
</section>
`;

export const RACING_BIO_TEST = `${testHead("racing-bio")}
describe("racing-bio component", () => {
  it("covers racing specialties and references", async () => {
    const html = await source();
    expect(html).toContain("Hurley Haywood");
    expect(html).toContain("Porsche 917");
    expect(html).toContain("Laguna Seca");
  });
});
`;
