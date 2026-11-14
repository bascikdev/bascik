/**
 * @module templates/portfolio/pages
 *
 * The portfolio's pages, the rules it adds to the global stylesheet, and its Playwright spec.
 *
 * Every page is a list of component tags. Its `<head>` holds the shared `<site-meta />` and one build script
 * that calls `seo()` for the title, description, canonical URL and Open Graph tags.
 */

import { STYLES_CSS } from "../../scaffold.js";

/** A page: the shared head and layout around its own head script and the tags inside `<main>`. */
const page = (options: {
  /** The page's name in its `<main>` test id. */
  name: string;
  /** What goes in `<head>` after `<site-meta />`, indented four spaces. */
  head: string;
  /** Classes on `<main>`, when the page is not full width. */
  mainClass?: string;
  /** The tags inside `<main>`, indented six spaces. */
  body: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
${options.head}
  </head>
  <body>
    <site-header />
    <main id="main"${options.mainClass ? ` class="${options.mainClass}"` : ""} data-testid="${options.name}-main">
${options.body}
    </main>
    <site-footer />
  </body>
</html>
`;

/** A head build script that calls `seo()` with a fixed title and description. */
const seoScript = (title: string, description: string): string =>
  `    <script data-bascik-build type="text/typescript">
      import { seo } from "@/lib/seo.ts";
      export default () =>
        seo({
          title: ${JSON.stringify(title)},
          description:
            ${JSON.stringify(description)},
        });
    </script>`;

export const INDEX_PAGE = page({
  name: "home",
  head: `    <script data-bascik-build type="text/typescript">
      import { seo } from "@/lib/seo.ts";
      import { site } from "@/lib/site.ts";
      export default () =>
        seo({ title: site.author, description: site.description });
    </script>`,
  body: `      <home-intro />
      <featured-books />`,
});

export const WORK_PAGE = page({
  name: "work",
  head: seoScript(
    "Work",
    "Every book so far, newest first: novels, a novella, short stories, and essays. Each has a page of its own.",
  ),
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="Work"
        data-bascik-prop-title="Books"
        data-bascik-prop-text="Every book so far, newest first. Each has a page of its own."
      />
      <book-list />`,
});

/**
 * The dynamic route: one page per book. The routes script returns a route for each entry in `src/lib/books.ts`,
 * with the book as the route's data; the head script and `<book-detail>` read it from `BASCIK_ROUTE`.
 */
export const BOOK_PAGE = page({
  name: "book",
  head: `    <!-- One page per book at /work/<slug>. The routes script hands each page its book as the route's data. -->
    <script data-bascik-routes type="text/typescript">
      import { books } from "@/lib/books.ts";
      export default () =>
        books.map((book) => ({ params: { slug: book.slug }, data: book }));
    </script>
    <script data-bascik-build type="text/typescript">
      import type { Book } from "@/lib/books.ts";
      import { seo } from "@/lib/seo.ts";
      export default () => {
        const { data: book }: { data: Book } = JSON.parse(
          process.env.BASCIK_ROUTE || "{}",
        );
        return seo({
          title: book.title,
          description: book.summary,
          type: "book",
        });
      };
    </script>`,
  mainClass: "container page",
  body: `      <book-detail />`,
});

export const ABOUT_PAGE = page({
  name: "about",
  head: seoScript(
    "About",
    "Who writes these books, where, and what comes next: a short biography and a few facts.",
  ),
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="About"
        data-bascik-prop-title="About the author"
        data-bascik-prop-text="Who writes these books, where, and what comes next."
      />
      <author-bio />`,
});

export const CONTACT_PAGE = page({
  name: "contact",
  head: seoScript(
    "Contact",
    "Get in touch about readings, interviews, book club visits, or anything one of the books left you wondering.",
  ),
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="Contact"
        data-bascik-prop-title="Get in touch"
        data-bascik-prop-text="Readings, interviews, book club visits, or a question a book left you with."
      />
      <contact-form />`,
});

/** Served with status 404 for unknown URLs. Bascik keeps a 404 page out of the sitemap by itself. */
export const NOT_FOUND_PAGE = page({
  name: "not-found",
  head: `    <script data-bascik-build type="text/typescript">
      import { seo } from "@/lib/seo.ts";
      export default () =>
        seo({
          title: "Page not found",
          description: "This page does not exist or has moved.",
          noindex: true,
        });
    </script>`,
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="404"
        data-bascik-prop-title="Page not found"
        data-bascik-prop-text="This page does not exist or has moved."
      />
      <p><a href="/work" class="btn btn-primary">See the books</a></p>`,
});

/**
 * The global stylesheet: the default template's design tokens and helpers, then the few rules the portfolio's
 * pages share. `.book-grid` is global because two components build the same grid.
 */
export const PORTFOLIO_STYLES_CSS = `${STYLES_CSS}
/* ── Portfolio ── */
.page { padding-top: 72px; padding-bottom: 72px; }

.book-grid {
  list-style: none; margin: 28px 0 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 36px 28px;
}

@media (max-width: 640px) {
  .page { padding-top: 48px; padding-bottom: 48px; }
  /* Two covers side by side on a phone. */
  .book-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 28px 16px; }
}
`;

/** With an adapter: the shared `/api/hello` route answers under `bascik --server`, the E2E web server. */
const API_ROUTE_E2E_TEST = `
  test("the API route answers with JSON", async ({ request }) => {
    const response = await request.get("/api/hello?name=reader");
    expect(response.ok()).toBe(true);
    expect((await response.json()).hello).toBe("reader");
  });
`;

/**
 * The Playwright spec. It imports the books, so it follows the content: adding, removing or renaming a book
 * does not break it.
 */
const E2E_APP_SPEC_TESTS = `import { test, expect } from "@playwright/test";
import { books, featuredBooks } from "../src/lib/books.ts";

const [book] = books;

test.describe("Portfolio E2E Tests", () => {
  test("home page introduces the author and shows the featured books", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const cards = page.getByTestId("featured-books").getByTestId("book-card");
    await expect(cards).toHaveCount(featuredBooks().length);

    const [featured] = featuredBooks();
    await cards
      .filter({ hasText: featured.title })
      .getByTestId("book-card-link")
      .click();
    await expect(page).toHaveURL(\`/work/\${featured.slug}\`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      featured.title,
    );
  });

  test("work page lists every book, each linking to its own page", async ({
    page,
  }) => {
    await page.goto("/work");
    await expect(page).toHaveTitle(/^Work - /);
    const cards = page.getByTestId("book-list").getByTestId("book-card");
    await expect(cards).toHaveCount(books.length);
    for (const each of books) {
      const card = cards.filter({ hasText: each.title });
      await expect(card.getByTestId("book-card-link")).toHaveAttribute(
        "href",
        \`/work/\${each.slug}\`,
      );
      // The drawn cover is one image, named by its text alternative.
      await expect(
        card.getByRole("img", { name: each.cover.alt }),
      ).toBeVisible();
    }
  });

  test("every book has a page with its title, text and absolute SEO URLs", async ({
    page,
  }) => {
    for (const each of books) {
      const response = await page.goto(\`/work/\${each.slug}\`);
      expect(response?.status(), each.slug).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        each.title,
      );
      await expect(page.getByTestId("book-detail")).toContainText(
        each.description[0],
      );
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        each.summary,
      );
      for (const tag of ['link[rel="canonical"]', 'meta[property="og:url"]']) {
        const url = await page
          .locator(tag)
          .getAttribute(tag.startsWith("link") ? "href" : "content");
        expect(url, tag).toMatch(/^https?:\\/\\//);
        expect(new URL(url!).pathname).toBe(\`/work/\${each.slug}\`);
      }
    }
  });

  test("a book page links to the books on either side of it", async ({
    page,
  }) => {
    test.skip(books.length < 2, "needs two books");
    await page.goto(\`/work/\${book.slug}\`);
    await expect(page.getByTestId("book-detail-newer")).toHaveCount(0);
    await page.getByTestId("book-detail-older").click();
    await expect(page).toHaveURL(\`/work/\${books[1].slug}\`);
    await page.getByTestId("book-detail-newer").click();
    await expect(page).toHaveURL(\`/work/\${book.slug}\`);
    await page.getByTestId("book-detail-all").click();
    await expect(page).toHaveURL("/work");
  });

  test("navigates between the pages from the header", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("site-header-about").click();
    await expect(page).toHaveURL("/about");
    await expect(page).toHaveTitle(/^About - /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "About the author",
    );
    await page.getByTestId("site-header-logo").click();
    await expect(page).toHaveURL("/");
  });

  test("skip link is the first stop and moves to the main content", async ({
    page,
  }) => {
    await page.goto("/work");
    await page.keyboard.press("Tab");
    const skip = page.getByTestId("site-header-skip-link");
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/work#main");
  });

  test("mobile navigation toggle expands and collapses menu", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    const toggle = page.getByTestId("site-header-nav-toggle");
    const menu = page.getByTestId("site-header-nav-menu");

    // Assert what the reader sees, not the class name: the build scopes
    // .is-open (hashed under minify.identifiers), so the element never
    // carries the literal class.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
  });

  test("pages fit a phone screen without scrolling sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    for (const path of [
      "/",
      "/work",
      \`/work/\${book.slug}\`,
      "/about",
      "/contact",
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("contact form reports the first invalid field, then accepts a complete form", async ({
    page,
  }) => {
    await page.goto("/contact");
    const status = page.getByTestId("contact-form-status");
    const name = page.getByTestId("contact-form-name");
    const email = page.getByTestId("contact-form-email");
    const message = page.getByTestId("contact-form-message");
    const submit = page.getByTestId("contact-form-submit");

    // Empty: the name is the first problem.
    await submit.click();
    await expect(status).toContainText("Name:");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");

    // A name, and an email that is not one.
    await name.fill("Collin");
    await email.fill("not-an-email");
    await submit.click();
    await expect(status).toContainText("Email:");
    await expect(email).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "false");

    // A message shorter than the form asks for.
    await email.fill("collin@example.com");
    // Typed, not filled: browsers apply minlength only to text a person typed.
    await message.pressSequentially("Hi");
    await submit.click();
    await expect(status).toContainText("Message:");

    await message.fill("I would like to invite you to our book club.");
    await submit.click();
    await expect(page).toHaveURL("/contact");
    await expect(status).toContainText("Thanks");
    await expect(message).toHaveAttribute("aria-invalid", "false");
  });

  test("unknown URL gets the 404 page with a way back", async ({ page }) => {
    const response = await page.goto("/work/no-such-book");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Page not found",
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex",
    );
    await page.getByRole("link", { name: "See the books" }).click();
    await expect(page).toHaveURL("/work");
  });
`;

export const e2eAppSpec = (options: { adapter: boolean }): string =>
  `${E2E_APP_SPEC_TESTS}${options.adapter ? API_ROUTE_E2E_TEST : ""}});
`;
