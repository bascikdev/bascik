/**
 * @module templates/portfolio/lib
 *
 * The portfolio's TypeScript modules under `src/lib/`, their tests, and the project config.
 *
 * `src/lib/books.ts` is the collection: a typed array, checked when the module loads so a bad entry stops the
 * build with a message that names it. `src/lib/site.ts` is the only file that holds the site's name.
 */

/**
 * `src/lib/site.ts` for a site name. The name is written as a JSON string, which is a TypeScript string literal,
 * so any name is safe here; the pages print it with `html` from `@bascik/bascik/html`, which escapes it for HTML.
 */
export const siteModule = (
  siteName: string,
): string => `// The facts several pages and components show. Change one here and every page follows.
export const site = {
  /** The site's name: the header logo, og:site_name, and the end of every page title. */
  name: ${JSON.stringify(siteName)},
  /** Who the site is about. */
  author: "Odalys Venn",
  role: "Novelist and essayist",
  tagline:
    "Novels, stories, and essays about coastlines, weather, and the people who stay put.",
  /** The home page's description in search results: one or two sentences. */
  description:
    "The books of Odalys Venn: novels, short stories, and essays about coastlines, weather, and the people who stay put.",
} as const;
`;

/** `bascik.config.ts`: the one setting the site needs that is not a default. */
export const BASCIK_CONFIG = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // Rebuild pages in dev when the books or a shared helper change.
    // Component and page folders are watched already.
    watchPaths: ["src/lib/"],
  },
});
`;

/** `src/lib/books.ts`: the types, the sample books, and the check that runs when the module loads. */
export const BOOKS_TS = `// The books this site shows. Each entry becomes a card on /work and a page at /work/<slug>
// (src/pages/work/[slug].html). To add a book, add an entry; to remove one, delete it.
//
// Bascik strips the types without checking them, so checkBooks() checks every entry when this module loads:
// a missing field or a slug used twice stops the build with a message that names the book.

/** The cover colors <book-cover> draws (src/components/book-cover/book-cover.html). Add a color in both files. */
export const COVER_TONES = [
  "amber",
  "moss",
  "tide",
  "plum",
  "rust",
  "slate",
] as const;
export type CoverTone = (typeof COVER_TONES)[number];

export interface Book {
  /** The last part of the page's URL: lowercase letters, digits, and hyphens. Unique. */
  slug: string;
  title: string;
  /** The year it was published. */
  year: number;
  /** What kind of book it is, such as "Novel" or "Essays". */
  kind: string;
  /** One sentence: the card's text and the page's description in search results (50 to 160 characters reads best). */
  summary: string;
  /** The page's text, one string per paragraph. */
  description: string[];
  cover: {
    tone: CoverTone;
    /** What the cover shows, for people who cannot see it. */
    alt: string;
  };
  pages?: number;
  /** Show the book on the home page. */
  featured?: boolean;
}

/** Every book, newest first: the order written here is the order on the site. */
export const books: Book[] = checkBooks([
  {
    slug: "nine-letters-to-a-lighthouse",
    title: "Nine Letters to a Lighthouse",
    year: 2025,
    kind: "Novella",
    pages: 148,
    featured: true,
    summary:
      "A keeper's granddaughter writes to the light that raised her family, one letter for each year it has stood dark.",
    description: [
      "The Carrow light was switched off nine years ago, and nobody told Mirren Ashby, who grew up in its kitchen. She finds out from a postcard. What follows is a year of letters addressed to a building: furious, funny, and slowly forgiving.",
      "This is the shortest book on the shelf and the one readers write back about most. It can be read in an evening, preferably a windy one.",
    ],
    cover: {
      tone: "tide",
      alt: "Cover of Nine Letters to a Lighthouse: the title in white serif type on deep sea blue.",
    },
  },
  {
    slug: "the-lamplighters-almanac",
    title: "The Lamplighter's Almanac",
    year: 2023,
    kind: "Novel",
    pages: 384,
    featured: true,
    summary:
      "A town that still lights its streets by hand hires its first new lamplighter in forty years, and she keeps notes.",
    description: [
      "Pell Harbor has 212 gas lamps and one rule: each is lit by a person, at dusk, every day of the year. When the old lamplighter retires, the job goes to Wren Tolland, who is nineteen, afraid of ladders, and unable to stop writing things down.",
      "Told as a year of almanac entries, the novel follows one round of the lamps through four seasons, three funerals, a wedding, and a flood.",
    ],
    cover: {
      tone: "amber",
      alt: "Cover of The Lamplighter's Almanac: the title in white serif type on warm amber.",
    },
  },
  {
    slug: "tide-tables-for-beginners",
    title: "Tide Tables for Beginners",
    year: 2021,
    kind: "Short stories",
    pages: 226,
    featured: true,
    summary:
      "Eleven stories set between high and low water, about people learning something later than they meant to.",
    description: [
      "A retired pilot takes swimming lessons. A ferry cook studies for a law degree between crossings. A widower learns to read the sky from his late wife's notebooks. Each story happens in the six hours between one tide and the next.",
      "Several of these stories first appeared in small magazines; three are new to this collection.",
    ],
    cover: {
      tone: "moss",
      alt: "Cover of Tide Tables for Beginners: the title in white serif type on moss green.",
    },
  },
  {
    slug: "glasshouse-winter",
    title: "Glasshouse Winter",
    year: 2019,
    kind: "Novel",
    pages: 312,
    summary:
      "Two sisters inherit a botanical garden in the coldest winter on record and have until spring to decide what lives.",
    description: [
      "The boilers at Hollin Garden can keep one glasshouse warm, not five. Ada wants to save the orchids their mother collected; June wants to save the garden's accounts. The frost does not wait for them to agree.",
      "A novel about inheritance, heating bills, and the difference between keeping something and keeping it alive.",
    ],
    cover: {
      tone: "plum",
      alt: "Cover of Glasshouse Winter: the title in white serif type on dark plum.",
    },
  },
  {
    slug: "a-small-hours-atlas",
    title: "A Small Hours Atlas",
    year: 2017,
    kind: "Essays",
    pages: 198,
    summary:
      "Essays on night shifts, ferry timetables, and the maps people draw of places they only visit after midnight.",
    description: [
      "Fourteen essays written between midnight and five in the morning, in the places that are open then: a bakery, a signal box, a hospital car park, the upper deck of the last boat home.",
      "Part travel writing and part sleep diary, the book asks who keeps a town running while it sleeps, and what they see.",
    ],
    cover: {
      tone: "slate",
      alt: "Cover of A Small Hours Atlas: the title in white serif type on slate gray.",
    },
  },
  {
    slug: "the-salt-ledger",
    title: "The Salt Ledger",
    year: 2015,
    kind: "Novel",
    pages: 296,
    summary:
      "A debut novel about a salt works, the family that keeps its books, and the one entry nobody will explain.",
    description: [
      "For a hundred and forty years the Marsh family has written down every sack of salt that left Saltwick Pans. Then a new bookkeeper finds a line in the ledger for 1911 that has been paid, every year since, to no one.",
      "The first novel, and still the one with the most weather in it.",
    ],
    cover: {
      tone: "rust",
      alt: "Cover of The Salt Ledger: the title in white serif type on rust red.",
    },
  },
]);

/** The books the home page shows. */
export const featuredBooks = (): Book[] =>
  books.filter((book) => book.featured);

/** A book's page, as a site path. */
export const bookPath = (book: Pick<Book, "slug">): string =>
  \`/work/\${book.slug}\`;

// A function declaration, like checkBooks: both are called above, while the module is still loading.
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The list as given, or an Error that names the first entry that cannot become a page. The parameter is
 * unknown[] so the check holds for entries the type checker never saw.
 */
export function checkBooks(list: readonly unknown[]): Book[] {
  const firstUse = new Map<string, number>();
  list.forEach((entry, index) => {
    const book = (entry ?? {}) as Partial<Book>;
    const called = isText(book.slug)
      ? book.slug
      : isText(book.title)
        ? book.title
        : "no slug or title";
    const fail = (problem: string): never => {
      throw new Error(
        \`src/lib/books.ts: book \${index + 1} ("\${called}") \${problem}\`,
      );
    };
    if (typeof entry !== "object" || entry === null)
      fail("is not an object. Each book is { slug, title, year, ... }.");
    for (const field of ["slug", "title", "kind", "summary"] as const)
      if (!isText(book[field])) fail(\`is missing "\${field}".\`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(book.slug!))
      fail(
        \`has the slug "\${book.slug}". A slug is the page's URL: use lowercase letters, digits, and hyphens, such as "my-first-book".\`,
      );
    if (!Number.isInteger(book.year))
      fail('is missing "year", a whole number.');
    if (
      !Array.isArray(book.description) ||
      book.description.length === 0 ||
      !book.description.every(isText)
    )
      fail('is missing "description", a list with one string per paragraph.');
    if (!COVER_TONES.includes(book.cover?.tone as CoverTone))
      fail(\`needs "cover.tone" to be one of: \${COVER_TONES.join(", ")}.\`);
    if (!isText(book.cover?.alt))
      fail('is missing "cover.alt", the text that describes the cover.');
    if (book.pages !== undefined && !Number.isInteger(book.pages))
      fail('has "pages" that is not a whole number.');
    const earlier = firstUse.get(book.slug!);
    if (earlier !== undefined)
      fail(
        \`has the same slug as book \${earlier + 1}. Each book needs its own slug, because the slug is its page's URL.\`,
      );
    firstUse.set(book.slug!, index);
  });
  return list as Book[];
}
`;

/** `src/lib/books.test.ts`: the sample data holds, and each kind of bad entry is refused by name. */
export const BOOKS_TEST = `import { describe, expect, it } from "vitest";
import {
  bookPath,
  books,
  checkBooks,
  featuredBooks,
  type Book,
} from "./books.ts";

const valid: Book = {
  slug: "a-test-book",
  title: "A Test Book",
  year: 2024,
  kind: "Novel",
  summary: "One sentence about the book.",
  description: ["A paragraph."],
  cover: { tone: "moss", alt: "Cover of A Test Book." },
};

describe("books", () => {
  it("lists books that all pass the check, some of them featured", () => {
    expect(books.length).toBeGreaterThan(0);
    expect(() => checkBooks(books)).not.toThrow();
    expect(featuredBooks().length).toBeGreaterThan(0);
    expect(featuredBooks().every((book) => book.featured)).toBe(true);
  });

  it("gives each book a page under /work", () => {
    expect(bookPath(valid)).toBe("/work/a-test-book");
  });

  it("accepts a book without the optional fields", () => {
    expect(checkBooks([valid])).toEqual([valid]);
  });

  it.each(["slug", "title", "kind", "summary", "year", "description"] as const)(
    "misuse: a book with no %s fails with its position and name",
    (field) => {
      const broken: Partial<Book> = { ...valid };
      delete broken[field];
      const named = field === "slug" ? "A Test Book" : "a-test-book";
      expect(() => checkBooks([valid, broken])).toThrow(\`book 2 ("\${named}")\`);
      expect(() => checkBooks([broken])).toThrow(\`"\${field}"\`);
    },
  );

  it("misuse: two books with one slug fail, naming both positions", () => {
    const other = { ...valid, title: "Another Book" };
    expect(() => checkBooks([valid, { ...valid, slug: "b" }, other])).toThrow(
      'book 3 ("a-test-book") has the same slug as book 1',
    );
  });

  it.each(["A Test Book", "a_test", "-a", "a/b", "été"])(
    "misuse: the slug %j is refused, because it would not be a clean URL",
    (slug) => {
      expect(() => checkBooks([{ ...valid, slug }])).toThrow(
        "lowercase letters",
      );
    },
  );

  it("misuse: a cover color the component does not draw, or no alt text, is refused", () => {
    expect(() =>
      checkBooks([{ ...valid, cover: { tone: "pink", alt: "Cover." } }]),
    ).toThrow("cover.tone");
    expect(() =>
      checkBooks([{ ...valid, cover: { tone: "moss", alt: " " } }]),
    ).toThrow("cover.alt");
    expect(() => checkBooks([{ ...valid, cover: undefined }])).toThrow(
      "cover.tone",
    );
  });

  it("misuse: an entry that is not an object, or a year typed as text, is refused", () => {
    expect(() => checkBooks([null])).toThrow("book 1");
    expect(() => checkBooks(["a-test-book"])).toThrow("is not an object");
    expect(() => checkBooks([{ ...valid, year: "2024" }])).toThrow('"year"');
    expect(() => checkBooks([{ ...valid, pages: 12.5 }])).toThrow('"pages"');
  });
});
`;

/** `src/lib/seo.ts`: each page's title, description, canonical URL, and Open Graph tags. */
export const SEO_TS = `// The head tags each page needs: title, description, canonical URL, and Open Graph tags. A page calls it from
// a build script in its <head>:
//
//   <script data-bascik-build type="text/typescript">
//     import { seo } from "@/lib/seo.ts";
//     export default () => seo({ title: "About", description: "Who I am and what I write." });
//   </script>
//
// The domain comes from BASCIK_SITE_URL (.env or the host's settings), never from this file. html escapes each
// value for where it lands, so a title with quotes or an ampersand is safe.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { site } from "./site.ts";

export interface SeoOptions {
  /** The page's own title. The site's name is added after it. */
  title: string;
  /** One or two sentences for search results. */
  description: string;
  /** "book" on a book's page, otherwise "website". */
  type?: "website" | "book";
  /** Keep the page out of search results, as the 404 page does. */
  noindex?: boolean;
}

/** The absolute URL of the page being built, or undefined when the site URL is not set (as in dev). */
export function pageUrl(): string | undefined {
  const origin = process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "");
  if (!origin) return undefined;
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  return \`\${origin}\${base}\${process.env.BASCIK_PAGE_PATH || "/"}\`;
}

export function seo(options: SeoOptions): SafeHtml {
  const title = \`\${options.title} - \${site.name}\`;
  // A canonical URL must be absolute, so it is written only when the site URL is known.
  const url = options.noindex ? undefined : pageUrl();
  return html\`<title>\${title}</title>
    <meta name="description" content="\${options.description}" />
    \${options.noindex ? html\`<meta name="robots" content="noindex" />\` : ""}
    \${url ? html\`<link rel="canonical" href="\${url}" />\` : ""}
    <meta property="og:type" content="\${options.type ?? "website"}" />
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${options.description}" />
    \${url ? html\`<meta property="og:url" content="\${url}" />\` : ""}
    <meta property="og:site_name" content="\${site.name}" />
    <meta name="twitter:card" content="summary" />\`;
}
`;

/** `src/lib/seo.test.ts`. */
export const SEO_TEST = `import { afterEach, describe, expect, it, vi } from "vitest";
import { pageUrl, seo } from "./seo.ts";
import { site } from "./site.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seo", () => {
  it("writes absolute canonical and Open Graph URLs from the site URL and the page path", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com/");
    vi.stubEnv("BASCIK_BASE", "/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/work/a-test-book");
    expect(pageUrl()).toBe("https://example.com/work/a-test-book");
    const tags = String(
      seo({ title: "A Test Book", description: "About it." }),
    );
    expect(tags).toContain(
      '<link rel="canonical" href="https://example.com/work/a-test-book" />',
    );
    expect(tags).toContain(
      '<meta property="og:url" content="https://example.com/work/a-test-book" />',
    );
    expect(tags).toContain('<meta property="og:type" content="website" />');
  });

  it("keeps the base path of a site served from a subfolder", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    vi.stubEnv("BASCIK_BASE", "/books/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/about");
    expect(pageUrl()).toBe("https://example.com/books/about");
  });

  it("leaves the canonical and og:url out when the site URL is not set, as in dev", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    const tags = String(seo({ title: "About", description: "About me." }));
    expect(pageUrl()).toBeUndefined();
    expect(tags).not.toContain("canonical");
    expect(tags).not.toContain("og:url");
    expect(tags).toContain("<title>About - ");
  });

  it("ends each title with the site's name and marks a book's page", () => {
    const tags = String(
      seo({ title: "A Test Book", description: "About it.", type: "book" }),
    );
    expect(tags).toContain('<meta property="og:type" content="book" />');
    expect(tags).toContain('<meta property="og:site_name" content="');
    expect(site.name.length).toBeGreaterThan(0);
  });

  it("marks a noindex page and gives it no canonical URL", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    const tags = String(
      seo({
        title: "Page not found",
        description: "Nothing here.",
        noindex: true,
      }),
    );
    expect(tags).toContain('<meta name="robots" content="noindex" />');
    expect(tags).not.toContain("canonical");
  });

  it("misuse: escapes markup and quotes in a title or description", () => {
    const tags = String(
      seo({
        title: '<script>alert("x")</script> & Sons',
        description: 'She said "no" & left <b>',
      }),
    );
    expect(tags).not.toContain("<script>");
    expect(tags).not.toContain("<b>");
    expect(tags).toContain("&lt;script&gt;");
    expect(tags).toContain("&amp; Sons");
    expect(tags).not.toContain('content="She said "no"');
  });
});
`;

/** `src/lib/book-cards.ts`: the grid of cards the home page and the work page share. */
export const BOOK_CARDS_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { bookPath, type Book } from "./books.ts";

/**
 * A grid with one <book-card> per book, its <book-cover> in the card's slot. Bascik expands both tags when the
 * page builds. html escapes each value, so a title with an apostrophe or an ampersand is safe.
 */
export const bookCards = (list: readonly Book[]): SafeHtml =>
  html\`<ul class="book-grid">
    \${list.map((book) => {
      const href = bookPath(book);
      const meta = \`\${book.kind} · \${book.year}\`;
      return html\`<li>
        <book-card
          data-bascik-prop-title="\${book.title}"
          data-bascik-prop-meta="\${meta}"
          data-bascik-prop-summary="\${book.summary}"
          data-bascik-prop-href="\${href}"
        >
          <book-cover
            data-bascik-prop-title="\${book.title}"
            data-bascik-prop-alt="\${book.cover.alt}"
            data-bascik-prop-tone="\${book.cover.tone}"
          />
        </book-card>
      </li>\`;
    })}
  </ul>\`;
`;

/** `src/lib/book-cards.test.ts`. */
export const BOOK_CARDS_TEST = `import { describe, expect, it } from "vitest";
import { bookCards } from "./book-cards.ts";
import { books, type Book } from "./books.ts";

describe("bookCards", () => {
  it("writes one card per book, in order, each linking to the book's page", () => {
    const markup = String(bookCards(books));
    expect(markup.match(/<book-card/g)).toHaveLength(books.length);
    expect(markup.match(/<book-cover/g)).toHaveLength(books.length);
    const links = [...markup.matchAll(/data-bascik-prop-href="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(links).toEqual(books.map((book) => \`/work/\${book.slug}\`));
  });

  it("writes an empty list for no books", () => {
    expect(String(bookCards([]))).not.toContain("<li>");
  });

  it("misuse: escapes markup and quotes in a book's text", () => {
    const book: Book = {
      ...books[0],
      title: '"Quoted" <b>& Sons</b>',
      summary: "<img src=x onerror=alert(1)>",
    };
    const markup = String(bookCards([book]));
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;b&gt;&amp; Sons&lt;/b&gt;");
    expect(markup).not.toContain('title=""Quoted"');
  });
});
`;
