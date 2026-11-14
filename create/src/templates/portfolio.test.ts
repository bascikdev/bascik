/**
 * portfolio.test.ts
 *
 * The portfolio template's content, without the compiler: which files it writes, what the pages and components
 * hold, and how the generated data module behaves. The generated `src/lib/books.ts` is loaded for real from a
 * temporary folder, so its check is tested as code, not as text.
 *
 * portfolio.integration.test.ts builds the site with the real CLI.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADAPTERS,
  PACKAGE_JSON,
  SITE_FOOTER_CSS,
  SITE_HEADER_CSS,
  SITE_META_HTML,
  STYLES_CSS,
  type TemplateContext,
} from "../scaffold.js";
import { TEMPLATES, templateNamed } from "../templates.js";
import { PORTFOLIO_TEMPLATE } from "./portfolio.js";

/** The template's files for a context, by path. */
const filesFor = (context: TemplateContext): Map<string, string> =>
  new Map(
    PORTFOLIO_TEMPLATE.files(context).map(([path, data]) => [
      path,
      String(data),
    ]),
  );

const files = filesFor({ siteName: "my-portfolio" });
const file = (path: string, from = files): string => {
  const text = from.get(path);
  expect(text, `${path} is written`).toBeDefined();
  return text!;
};
const pathsMatching = (pattern: RegExp, from = files): string[] =>
  [...from.keys()].filter((path) => pattern.test(path));

const pagePaths = pathsMatching(/^src\/pages\/.*\.html$/);
const componentPaths = pathsMatching(/^src\/components\/.*\.html$/);

/** The shape of the generated `src/lib/books.ts`, as this test uses it. */
interface GeneratedBook {
  slug: string;
  title: string;
  year: number;
  kind: string;
  summary: string;
  description: string[];
  cover: { tone: string; alt: string };
  pages?: number;
  featured?: boolean;
}
interface BooksModule {
  COVER_TONES: readonly string[];
  books: GeneratedBook[];
  featuredBooks: () => GeneratedBook[];
  bookPath: (book: { slug: string }) => string;
  checkBooks: (list: readonly unknown[]) => GeneratedBook[];
}

let tempDir: string;
let booksModule: BooksModule;
let loads = 0;

/** A generated module, written to the temporary folder and imported. Each call is a fresh module. */
async function load<T>(source: string): Promise<T> {
  const path = join(tempDir, `module-${++loads}.ts`);
  await writeFile(path, source, "utf8");
  return (await import(/* @vite-ignore */ pathToFileURL(path).href)) as T;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bascik-portfolio-test-"));
  booksModule = await load<BooksModule>(file("src/lib/books.ts"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("portfolio template", () => {
  it("is registered after the default, with the summary the usage text prints", () => {
    expect(TEMPLATES).toContain(PORTFOLIO_TEMPLATE);
    expect(TEMPLATES.indexOf(PORTFOLIO_TEMPLATE)).toBeGreaterThan(0);
    expect(templateNamed("Portfolio")).toBe(PORTFOLIO_TEMPLATE);
    expect(PORTFOLIO_TEMPLATE.summary).toBe(
      "A portfolio: a work grid, a page per item, and about and contact pages",
    );
  });

  it("needs no package beyond the starter's own", () => {
    expect(PORTFOLIO_TEMPLATE.dependencies).toBeUndefined();
    expect(PORTFOLIO_TEMPLATE.devDependencies).toBeUndefined();
    const generated = JSON.parse(
      PACKAGE_JSON("my-portfolio", undefined, PORTFOLIO_TEMPLATE),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(generated.dependencies)).toEqual(["@bascik/bascik"]);
    // Every import in the generated code is Bascik, Node, a test runner, or a file of the project.
    const allowed =
      /^(node:|@bascik\/bascik\/(html|config)$|vitest$|@playwright\/test$|\.{1,2}\/|@\/)/;
    for (const [path, text] of files)
      for (const [, specifier] of text.matchAll(
        /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm,
      ))
        expect(allowed.test(specifier), `${path} imports ${specifier}`).toBe(
          true,
        );
  });

  it("writes the pages a portfolio needs, with the book page as a dynamic route", () => {
    expect(pagePaths.sort()).toEqual([
      "src/pages/404.html",
      "src/pages/about.html",
      "src/pages/contact.html",
      "src/pages/index.html",
      "src/pages/work.html",
      "src/pages/work/[slug].html",
    ]);
    const bookPage = file("src/pages/work/[slug].html");
    expect(bookPage).toContain(
      '<script data-bascik-routes type="text/typescript">',
    );
    expect(bookPage).toContain("params: { slug: book.slug }, data: book");
    expect(bookPage).toContain("<book-detail />");
    // No book has a page written by hand.
    for (const book of booksModule.books)
      expect(pathsMatching(new RegExp(book.slug))).toEqual([]);
  });

  it("writes only a config file outside src/ and e2e/, and it only adds the watch on src/lib/", () => {
    expect(pathsMatching(/^(?!src\/|e2e\/)/)).toEqual(["bascik.config.ts"]);
    const config = file("bascik.config.ts");
    expect(config).toContain('watchPaths: ["src/lib/"]');
    expect(config).not.toContain("siteUrl");
  });

  it("ships no image file and fetches nothing from the network", () => {
    for (const [path, data] of PORTFOLIO_TEMPLATE.files({
      siteName: "my-portfolio",
    })) {
      expect(typeof data, `${path} is text`).toBe("string");
      expect(path).not.toMatch(/\.(png|jpe?g|gif|webp|avif|svg|ico)$/);
    }
    for (const path of [...pagePaths, ...componentPaths]) {
      const text = file(path);
      expect(text, path).not.toMatch(/<img\s/);
      expect(text, path).not.toMatch(/\burl\(/);
      expect(text, path).not.toMatch(/https?:\/\//);
    }
    for (const [path, text] of files)
      if (path.endsWith(".ts") && !path.endsWith(".test.ts"))
        expect(text, path).not.toMatch(/\bfetch\(/);
  });

  it.each(pagePaths)(
    "%s is a list of component tags with one main, a language, and its own SEO tags",
    (path) => {
      const page = file(path);
      expect(page.startsWith("<!doctype html>\n")).toBe(true);
      expect(page).toContain('<html lang="en">');
      expect(page.match(/<main /g)).toHaveLength(1);
      expect(page).toMatch(/<main id="main"[^>]* data-testid="[a-z-]+-main">/);
      // The shared head, then one build script that calls seo() for the title, canonical and Open Graph tags.
      expect(page).toContain("<site-meta />");
      expect(page).toContain('import { seo } from "@/lib/seo.ts";');
      expect(page).not.toMatch(/<title|rel="canonical"|property="og:/);
      // The body: header, main, footer, and nothing but tags and at most one short paragraph inside main.
      const body = page.slice(page.indexOf("<body>"));
      expect(body.indexOf("<site-header />")).toBeLessThan(
        body.indexOf("<main "),
      );
      expect(body.indexOf("<site-footer />")).toBeGreaterThan(
        body.indexOf("</main>"),
      );
      const main = body.slice(body.indexOf("<main "), body.indexOf("</main>"));
      expect(main.match(/<[a-z]+-[a-z-]+/g)!.length).toBeGreaterThan(0);
      expect(main).not.toMatch(/<(div|section|h[1-6]|ul|form)\b/);
      expect(main.split("\n").length).toBeLessThan(15);
    },
  );

  it("gives each page one h1: from page-intro, home-intro, or the book's title", () => {
    const h1Sources: Record<string, string> = {
      "src/pages/index.html": "<home-intro />",
      "src/pages/work.html": "<page-intro",
      "src/pages/work/[slug].html": "<book-detail />",
      "src/pages/about.html": "<page-intro",
      "src/pages/contact.html": "<page-intro",
      "src/pages/404.html": "<page-intro",
    };
    expect(Object.keys(h1Sources).sort()).toEqual([...pagePaths].sort());
    for (const [path, tag] of Object.entries(h1Sources))
      expect(file(path).split(tag), path).toHaveLength(2);
    for (const name of ["page-intro", "home-intro"])
      expect(
        file(`src/components/${name}/${name}.html`).match(/<h1/g),
      ).toHaveLength(1);
    expect(
      file("src/components/book-detail/detail.ts").match(/<h1/g),
    ).toHaveLength(1);
    // Every other component starts at h2 or lower, and the cards' h3 sits under an h2 on both pages that list them.
    for (const path of componentPaths)
      if (!/\/(page-intro|home-intro)\//.test(path))
        expect(file(path), path).not.toMatch(/<h1/);
    expect(file("src/components/book-card/book-card.html")).toContain("<h3>");
    for (const name of ["featured-books", "book-list"])
      expect(file(`src/components/${name}/${name}.html`)).toContain("<h2>");
  });

  it("keeps the 404 page out of search results", () => {
    expect(file("src/pages/404.html")).toContain("noindex: true");
    expect(file("src/lib/seo.ts")).toContain(
      '<meta name="robots" content="noindex" />',
    );
  });

  it.each(componentPaths)(
    "%s has a test beside it, a data-testid on its root, and TypeScript scripts",
    (path) => {
      const name = /\/([a-z-]+)\.html$/.exec(path)![1];
      expect(path).toBe(`src/components/${name}/${name}.html`);
      expect(files.has(`src/components/${name}/${name}.test.ts`)).toBe(true);
      const html = file(path);
      // site-meta is head tags with no root element.
      if (name !== "site-meta") expect(html).toContain(`data-testid="${name}"`);
      for (const [tag] of html.matchAll(/<script\b[^>]*>/g))
        expect(tag, `${path}: ${tag}`).toContain('type="text/typescript"');
      // Style above the markup, a browser script below it.
      if (html.includes("<style>"))
        expect(html.indexOf("<style>")).toBeLessThan(
          html.indexOf("data-testid="),
        );
    },
  );

  it("marks every script in a page as TypeScript too", () => {
    for (const path of pagePaths)
      for (const [tag] of file(path).matchAll(/<script\b[^>]*>/g))
        expect(tag, `${path}: ${tag}`).toContain('type="text/typescript"');
  });

  it("puts a data-testid on every control, form and landmark", () => {
    const interactive =
      /<(button|input|textarea|select|form|nav|header|footer|main)\b[^>]*>/g;
    for (const path of [...pagePaths, ...componentPaths])
      for (const [tag] of file(path).matchAll(interactive))
        expect(tag, `${path}: ${tag}`).toContain("data-testid=");
  });

  it("uses the default template's header and footer CSS, so the skip link is the same one", () => {
    const header = file("src/components/site-header/site-header.html");
    expect(header).toContain(SITE_HEADER_CSS);
    expect(header).toContain(".skip-link:not(:focus)");
    expect(header).toContain("clip-path: inset(50%)");
    // The skip link is the first element in the header and the first link in the file.
    const markup = header.slice(header.indexOf("<header"));
    expect(markup).toMatch(
      /^<header data-testid="site-header">\s*<a href="#main" class="skip-link"/,
    );
    expect(file("src/components/site-footer/site-footer.html")).toContain(
      SITE_FOOTER_CSS,
    );
    expect(file("src/pages/css/styles.css").startsWith(STYLES_CSS)).toBe(true);
  });

  it("takes the default template's head tags without its one description for every page", () => {
    const meta = file("src/components/site-meta/site-meta.html");
    expect(SITE_META_HTML).toContain('name="description"');
    expect(meta).not.toContain('name="description"');
    expect(meta.split("\n").length).toBe(SITE_META_HTML.split("\n").length - 1);
    for (const line of meta.split("\n")) expect(SITE_META_HTML).toContain(line);
    expect(meta).toContain('<link rel="stylesheet" href="/css/styles.css" />');
  });

  it("labels each form control and states its rules in HTML", () => {
    const form = file("src/components/contact-form/contact-form.html");
    const controls = [...form.matchAll(/<(?:input|textarea)\b[^>]*>/g)].map(
      ([tag]) => tag,
    );
    expect(controls).toHaveLength(3);
    for (const tag of controls) {
      const id = /\bid="([^"]+)"/.exec(tag)![1];
      expect(form).toContain(`<label for="${id}">`);
      expect(tag).toContain(`name="${id}"`);
      expect(tag).toMatch(/\srequired\s/);
    }
    expect(form).toMatch(/<button\s[^>]*type="submit"/);
    expect(form).toContain('role="status"');
    // No field is named after a form property, which would shadow form.submit() or form.action.
    expect(form).not.toMatch(/name="(action|method|submit|reset|elements)"/);
  });

  it("draws covers as one image with a text alternative taken from the book", () => {
    const cover = file("src/components/book-cover/book-cover.html");
    expect(cover).toContain('role="img"');
    expect(cover).toContain('data-bascik-attr-aria-label="alt"');
    for (const tone of booksModule.COVER_TONES)
      if (tone !== "slate")
        expect(cover).toContain(`.cover[data-tone="${tone}"]`);
    for (const path of [
      "src/lib/book-cards.ts",
      "src/components/book-detail/detail.ts",
    ])
      expect(file(path)).toContain('data-bascik-prop-alt="${book.cover.alt}"');
  });

  it("builds markup from data with html from @bascik/bascik/html, never with an escaper of its own", () => {
    for (const path of [
      "src/lib/seo.ts",
      "src/lib/book-cards.ts",
      "src/components/book-detail/detail.ts",
    ])
      expect(file(path)).toContain('from "@bascik/bascik/html"');
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/&amp;["'`]|escapeHtml|\.innerHTML/);
      expect(text, path).not.toMatch(/\.join\(""\)/);
    }
  });

  it.each(ADAPTERS)(
    "with the %s adapter the site is the same, plus a test of the shared API route",
    (adapter) => {
      const hosted = filesFor({ siteName: "my-portfolio", adapter });
      expect([...hosted.keys()]).toEqual([...files.keys()]);
      for (const [path, text] of hosted)
        if (path !== "e2e/app.spec.ts")
          expect(text, path).toBe(files.get(path));
      expect(file("e2e/app.spec.ts")).not.toContain("/api/hello");
      expect(file("e2e/app.spec.ts", hosted)).toContain("/api/hello?name=");
      // The site itself has no request-time code: the contact form sends nothing.
      for (const [path, text] of hosted)
        if (path.endsWith(".html"))
          expect(text, path).not.toMatch(/data-bascik-(server|stream)/);
    },
  );

  it("covers home, the list, a book page, the form, the menu toggle and the 404 in the E2E spec", () => {
    const spec = file("e2e/app.spec.ts");
    for (const needle of [
      'page.goto("/")',
      'page.goto("/work")',
      "`/work/${each.slug}`",
      "contact-form-submit",
      "site-header-nav-toggle",
      "toBe(404)",
      'link[rel="canonical"]',
    ])
      expect(spec).toContain(needle);
    // It follows the content: it imports the books and names no sample title or slug.
    expect(spec).toContain('from "../src/lib/books.ts"');
    for (const book of booksModule.books) {
      expect(spec).not.toContain(book.slug);
      expect(spec).not.toContain(book.title);
    }
    // No scoped class, positional or parent traversal locators.
    expect(spec).not.toMatch(/\.nth\(|locator\(["']\.\.|bascik__/);
  });
});

describe("portfolio template: the site name", () => {
  const siteOf = async (siteName: string): Promise<{ name: string }> =>
    (
      await load<{ site: { name: string } }>(
        file("src/lib/site.ts", filesFor({ siteName })),
      )
    ).site;

  it("is written once, in src/lib/site.ts, and read from there by the header, the footer and seo()", async () => {
    const named = filesFor({ siteName: "tide-and-type" });
    expect(
      pathsMatching(/./, named).filter((path) =>
        named.get(path)!.includes("tide-and-type"),
      ),
    ).toEqual(["src/lib/site.ts"]);
    expect((await siteOf("tide-and-type")).name).toBe("tide-and-type");
    expect(file("src/components/site-header/site-header.html")).toContain(
      "html`${site.name}`",
    );
    expect(file("src/lib/seo.ts")).toContain(
      '<meta property="og:site_name" content="${site.name}" />',
    );
  });

  it.each([
    `Tom & "Jerry" <b>'s`,
    `</script><script>alert(1)</script>`,
    "back\\slash and `tick` and ${dollar}",
    "line one\nline two three",
    "$& $1 $`",
    '";process.exit(1);"',
  ])(
    "misuse: the name %j reaches site.ts as that exact string and no page or component as markup",
    async (siteName) => {
      const named = filesFor({ siteName });
      expect((await siteOf(siteName)).name).toBe(siteName);
      // Only site.ts differs, so the name is in no HTML file: the pages print it with html, which escapes it.
      for (const [path, text] of named)
        if (path !== "src/lib/site.ts")
          expect(text, path).toBe(files.get(path));
      expect(file("src/lib/site.ts", named)).toContain(
        `name: ${JSON.stringify(siteName)},`,
      );
    },
  );
});

describe("portfolio template: the generated books module", () => {
  const valid: GeneratedBook = {
    slug: "a-test-book",
    title: "A Test Book",
    year: 2024,
    kind: "Novel",
    summary: "One sentence about the book.",
    description: ["A paragraph."],
    cover: { tone: "moss", alt: "Cover of A Test Book." },
  };

  it("has five or six sample books with unique slugs, half of them or fewer on the home page", () => {
    const { books, featuredBooks } = booksModule;
    expect(books.length).toBeGreaterThanOrEqual(5);
    expect(books.length).toBeLessThanOrEqual(6);
    expect(new Set(books.map((book) => book.slug)).size).toBe(books.length);
    expect(new Set(books.map((book) => book.title)).size).toBe(books.length);
    expect(featuredBooks().length).toBeGreaterThanOrEqual(2);
    expect(featuredBooks().length).toBeLessThanOrEqual(books.length / 2);
    // Newest first, as the work page says.
    const years = books.map((book) => book.year);
    expect(years).toEqual([...years].sort((a, b) => b - a));
  });

  it("gives every sample book what its page and its search result need", () => {
    for (const book of booksModule.books) {
      expect(book.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      // The summary is the page's meta description, and the title plus a site name is its <title>.
      expect(book.summary.length, book.slug).toBeGreaterThanOrEqual(50);
      expect(book.summary.length, book.slug).toBeLessThanOrEqual(160);
      expect(book.title.length, book.slug).toBeLessThanOrEqual(40);
      expect(book.description.length, book.slug).toBeGreaterThanOrEqual(2);
      expect(booksModule.COVER_TONES).toContain(book.cover.tone);
      expect(book.cover.alt).toContain(book.title);
      expect(booksModule.bookPath(book)).toBe(`/work/${book.slug}`);
    }
    // Each sample cover has its own color.
    expect(new Set(booksModule.books.map((book) => book.cover.tone)).size).toBe(
      booksModule.books.length,
    );
  });

  it("accepts a valid list and returns it", () => {
    expect(booksModule.checkBooks([valid])).toEqual([valid]);
    expect(booksModule.checkBooks([])).toEqual([]);
  });

  it.each(["slug", "title", "year", "kind", "summary", "description", "cover"])(
    "misuse: a book with no %s is refused with an error that names the file, the book and the field",
    (field) => {
      const broken: Record<string, unknown> = { ...valid };
      delete broken[field];
      const named = field === "slug" ? "A Test Book" : "a-test-book";
      expect(() => booksModule.checkBooks([valid, broken])).toThrow(
        `src/lib/books.ts: book 2 ("${named}")`,
      );
      expect(() => booksModule.checkBooks([valid, broken])).toThrow(
        `"${field === "cover" ? "cover.tone" : field}"`,
      );
    },
  );

  it.each([
    ["an empty title", { title: "   " }, '"title"'],
    ["a year typed as text", { year: "2024" }, '"year"'],
    [
      "a description that is one string",
      { description: "Text." },
      '"description"',
    ],
    ["an empty description", { description: [] }, '"description"'],
    [
      "an unknown cover color",
      { cover: { tone: "pink", alt: "A." } },
      "cover.tone",
    ],
    ["a cover with no alt text", { cover: { tone: "moss" } }, "cover.alt"],
    ["a page count that is not whole", { pages: 1.5 }, '"pages"'],
  ])("misuse: %s is refused, naming the field", (_label, change, field) => {
    expect(() => booksModule.checkBooks([{ ...valid, ...change }])).toThrow(
      field,
    );
  });

  it("misuse: a slug used twice is refused, naming both books", () => {
    const again = { ...valid, title: "Another Book" };
    expect(() =>
      booksModule.checkBooks([valid, { ...valid, slug: "other" }, again]),
    ).toThrow(
      'src/lib/books.ts: book 3 ("a-test-book") has the same slug as book 1',
    );
  });

  it.each([
    "A Test Book",
    "a_test",
    "a/b",
    "../up",
    "a.b",
    "été",
    "-a",
    "a--b",
  ])(
    "misuse: the slug %j is refused before Bascik would skip its route with only a warning",
    (slug) => {
      expect(() => booksModule.checkBooks([{ ...valid, slug }])).toThrow(
        "lowercase letters, digits, and hyphens",
      );
    },
  );

  it("misuse: an entry that is not an object is refused by position", () => {
    expect(() => booksModule.checkBooks([valid, null])).toThrow(
      'book 2 ("no slug or title") is not an object',
    );
    expect(() => booksModule.checkBooks(["a-test-book"])).toThrow(
      "is not an object",
    );
  });

  it("misuse: a duplicate in the data stops the module from loading at all", async () => {
    const source = file("src/lib/books.ts");
    const first = booksModule.books[0].slug;
    const second = booksModule.books[1].slug;
    const duplicated = source.replace(
      `slug: "${second}"`,
      () => `slug: "${first}"`,
    );
    expect(duplicated).not.toBe(source);
    await expect(load(duplicated)).rejects.toThrow(
      `book 2 ("${first}") has the same slug as book 1`,
    );
  });
});
