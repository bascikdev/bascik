/**
 * portfolio.integration.test.ts
 *
 * The portfolio template through the real compiler and the generated project's own test runner.
 *
 * Boundary tested:
 * `scaffold()` on the real filesystem -> the Bascik CLI in a child process (`bascik --build`), including the
 * routes script that turns each entry of `src/lib/books.ts` into a page and the build scripts that print
 * content with `html` -> the files in `dist/`. Then the generated project's Vitest suite, run in that project.
 *
 * The template-by-adapter matrix in scaffold.integration.test.ts already builds this template with every
 * adapter and runs `--check` and the audits. This file asserts what only a portfolio has: one page per book,
 * absolute SEO URLs, the sitemap, escaped content, and a build that fails on a book it cannot make a page for.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scaffold } from "../scaffold.ts";
import { PORTFOLIO_TEMPLATE } from "./portfolio.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const SITE_URL = "https://example.com";

/** The sample books, read from the generated data file: slug and title, in the order written. */
const SAMPLE_BOOKS: { slug: string; title: string }[] = [
  ...String(
    PORTFOLIO_TEMPLATE.files({ siteName: "x" }).find(
      ([path]) => path === "src/lib/books.ts",
    )![1],
  ).matchAll(/^ {4}slug: "([^"]+)",\n {4}title: "([^"]+)",$/gm),
].map(([, slug, title]) => ({ slug, title }));

const tempDirs: string[] = [];

// A build that fails on the first script exits while the other pages' build scripts are still finishing, and
// those write to the project's compile cache for a moment longer: retry the removal instead of failing on it.
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    ),
  );
});

/**
 * A scaffolded portfolio in a temporary folder. A scaffolded project has no node_modules, so Bascik and the
 * test runner are linked from the workspace; each resolves its own dependencies from its real path.
 */
async function scaffoldPortfolio(label: string): Promise<string> {
  const parentDir = await mkdtemp(
    join(tmpdir(), `bascik-portfolio-test-${label}-`),
  );
  tempDirs.push(parentDir);
  const projectDir = join(parentDir, "book-shelf");
  const { notes } = await scaffold("book-shelf", parentDir, {
    template: PORTFOLIO_TEMPLATE,
  });
  expect(notes).toEqual([]);
  const modules = join(projectDir, "node_modules");
  await mkdir(join(modules, "@bascik"), { recursive: true });
  await symlink(
    join(REPO_ROOT, "pkg"),
    join(modules, "@bascik", "bascik"),
    "dir",
  );
  await symlink(
    join(REPO_ROOT, "node_modules", "vitest"),
    join(modules, "vitest"),
    "dir",
  );
  return projectDir;
}

interface RunResult {
  exitCode: number;
  output: string;
}

const run = (
  projectDir: string,
  args: string[],
  timeout: number,
): Promise<RunResult> =>
  execFileAsync(process.execPath, args, {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      BASCIK_SITE_URL: SITE_URL,
    },
    timeout,
  }).then(
    ({ stdout, stderr }) => ({ exitCode: 0, output: `${stdout}${stderr}` }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({
      exitCode: typeof err.code === "number" ? err.code : 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    }),
  );

const build = (projectDir: string): Promise<RunResult> =>
  run(projectDir, [PKG_CLI, "--build"], 90_000);

const dist = (projectDir: string, path: string): Promise<string> =>
  readFile(join(projectDir, "dist", path), "utf8");

/** Replace one piece of a project file, failing when the piece is not there. */
async function edit(
  projectDir: string,
  path: string,
  from: string | RegExp,
  to: string,
): Promise<void> {
  const file = join(projectDir, path);
  const before = await readFile(file, "utf8");
  const after = before.replace(from, () => to);
  expect(after, `${path} holds ${String(from)}`).not.toBe(before);
  await writeFile(file, after, "utf8");
}

/** The content attribute or href of the first tag matching the pattern's one group. */
const attribute = (html: string, pattern: RegExp): string | undefined =>
  pattern.exec(html)?.[1];

describe("portfolio template through the compiler", () => {
  it("reads five or six sample books from the generated data file", () => {
    expect(SAMPLE_BOOKS.length).toBeGreaterThanOrEqual(5);
    expect(SAMPLE_BOOKS.length).toBeLessThanOrEqual(6);
  });

  it("builds a page for every book, lists them in the sitemap, and gives each absolute canonical and Open Graph URLs", async () => {
    const projectDir = await scaffoldPortfolio("build");
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);

    // One file per book, and no file for the template itself.
    const bookFiles = (await readdir(join(projectDir, "dist", "work"))).sort();
    expect(bookFiles).toEqual(
      SAMPLE_BOOKS.map((book) => `${book.slug}.html`).sort(),
    );
    for (const page of [
      "index.html",
      "work.html",
      "about.html",
      "contact.html",
      "404.html",
    ])
      expect(existsSync(join(projectDir, "dist", page)), page).toBe(true);

    const sitemap = await dist(projectDir, "sitemap.xml");
    for (const path of [
      "/",
      "/work",
      "/about",
      "/contact",
      ...SAMPLE_BOOKS.map((book) => `/work/${book.slug}`),
    ])
      expect(sitemap).toContain(`<loc>${SITE_URL}${path}</loc>`);
    expect(sitemap).not.toContain("[slug]");
    expect(sitemap).not.toContain("404");

    const titles = new Set<string>();
    for (const book of SAMPLE_BOOKS) {
      const html = await dist(projectDir, `work/${book.slug}.html`);
      const url = `${SITE_URL}/work/${book.slug}`;
      expect(attribute(html, /<link rel="canonical" href="([^"]+)"/)).toBe(url);
      expect(attribute(html, /<meta property="og:url" content="([^"]+)"/)).toBe(
        url,
      );
      expect(html).toContain('<meta property="og:type" content="book"');
      expect(html).toContain(
        '<meta property="og:site_name" content="book-shelf"',
      );
      expect(html.match(/<title>/g), book.slug).toHaveLength(1);
      expect(html.match(/<meta name="description"/g), book.slug).toHaveLength(
        1,
      );
      expect(html.match(/<h1/g), book.slug).toHaveLength(1);
      expect(html.match(/<main /g), book.slug).toHaveLength(1);
      titles.add(attribute(html, /<title>([^<]+)<\/title>/)!);
      // The cover is drawn, with its text alternative, and every component tag was expanded.
      expect(html).toMatch(/role="img"[^>]* aria-label="Cover of /);
      expect(html).not.toMatch(/<(book|site|page|home|author|contact)-[a-z]+/);
      expect(html).not.toMatch(/<img\b/);
    }
    expect(titles.size).toBe(SAMPLE_BOOKS.length);

    // The home page links to the featured books, the work page to all of them.
    const work = await dist(projectDir, "work.html");
    for (const book of SAMPLE_BOOKS)
      expect(work).toContain(`href="/work/${book.slug}"`);
    expect(work.match(/data-testid="book-card"/g)).toHaveLength(
      SAMPLE_BOOKS.length,
    );
    const home = await dist(projectDir, "index.html");
    const featured = home.match(/data-testid="book-card"/g)!.length;
    expect(featured).toBeGreaterThan(0);
    expect(featured).toBeLessThan(SAMPLE_BOOKS.length);
    expect(attribute(home, /<link rel="canonical" href="([^"]+)"/)).toBe(
      `${SITE_URL}/`,
    );

    // The 404 page is kept out of search results and has no canonical URL.
    const notFound = await dist(projectDir, "404.html");
    expect(notFound).toContain('<meta name="robots" content="noindex"');
    expect(notFound).not.toContain('rel="canonical"');
  }, 120_000);

  it("escapes a book's text once, in the title, the meta tags, the cover and the page", async () => {
    const projectDir = await scaffoldPortfolio("escape");
    const [first] = SAMPLE_BOOKS;
    await edit(
      projectDir,
      "src/lib/books.ts",
      `title: "${first.title}"`,
      'title: "Salt & <em>Vinegar</em> \\"Stories\\""',
    );
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);
    const escaped =
      "Salt &amp; &lt;em&gt;Vinegar&lt;/em&gt; &quot;Stories&quot;";
    for (const page of [`work/${first.slug}.html`, "work.html", "index.html"]) {
      const html = await dist(projectDir, page);
      expect(html, page).toContain(escaped);
      expect(html, page).not.toContain("<em>Vinegar");
      // Escaped once: no &amp;amp; or &amp;lt; from a second pass.
      expect(html, page).not.toMatch(/&amp;(amp|lt|gt|quot);/);
    }
    const bookPage = await dist(projectDir, `work/${first.slug}.html`);
    expect(bookPage).toContain(`<title>${escaped} - book-shelf</title>`);
    expect(bookPage).toMatch(
      new RegExp(`<h1[^>]*>${escaped.replace(/&quot;/g, '(&quot;|")')}</h1>`),
    );
  }, 120_000);

  it("misuse: prints a site name with markup in it as text on every page", async () => {
    const projectDir = await scaffoldPortfolio("site-name");
    const siteName = `Tom & "Jerry" <b>Books</b>`;
    // The folder keeps a plain name; only the module that holds the site's name is rewritten.
    const siteModule = String(
      PORTFOLIO_TEMPLATE.files({ siteName }).find(
        ([path]) => path === "src/lib/site.ts",
      )![1],
    );
    await writeFile(join(projectDir, "src/lib/site.ts"), siteModule, "utf8");
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);
    for (const page of ["index.html", "work.html", "404.html"]) {
      const html = await dist(projectDir, page);
      expect(html, page).not.toContain("<b>Books</b>");
      expect(html, page).toContain("Tom &amp; ");
      expect(html, page).toContain("&lt;b&gt;Books&lt;/b&gt;");
      expect(html, page).not.toMatch(/&amp;(amp|lt|gt|quot);/);
      // The name is inside the title and a quoted attribute, and breaks out of neither.
      expect(attribute(html, /<title>([^<]*)<\/title>/)).toContain(
        "&lt;b&gt;Books&lt;/b&gt;",
      );
      expect(
        attribute(html, /<meta property="og:site_name" content="([^"]*)"/),
      ).toBe("Tom &amp; &quot;Jerry&quot; &lt;b&gt;Books&lt;/b&gt;");
    }
  }, 120_000);

  it("misuse: a book with a missing field fails the build with an error that names the book", async () => {
    const projectDir = await scaffoldPortfolio("missing-field");
    const second = SAMPLE_BOOKS[1];
    await edit(
      projectDir,
      "src/lib/books.ts",
      new RegExp(
        `(slug: "${second.slug}",\\n {4}title: "[^"]+",\\n) {4}year: \\d+,\\n`,
      ),
      `    slug: "${second.slug}",\n    title: "${second.title}",\n`,
    );
    const result = await build(projectDir);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain(
      `src/lib/books.ts: book 2 ("${second.slug}") is missing "year"`,
    );
    expect(
      existsSync(join(projectDir, "dist", "work", `${second.slug}.html`)),
    ).toBe(false);
  }, 120_000);

  it("misuse: two books with one slug fail the build with an error that names both", async () => {
    const projectDir = await scaffoldPortfolio("duplicate-slug");
    const [first, , third] = SAMPLE_BOOKS;
    await edit(
      projectDir,
      "src/lib/books.ts",
      `slug: "${third.slug}"`,
      `slug: "${first.slug}"`,
    );
    const result = await build(projectDir);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain(
      `src/lib/books.ts: book 3 ("${first.slug}") has the same slug as book 1`,
    );
  }, 120_000);

  it("misuse: <book-detail> on a page that is not the book route fails the build and says where it belongs", async () => {
    const projectDir = await scaffoldPortfolio("detail-misuse");
    await edit(
      projectDir,
      "src/pages/about.html",
      "<author-bio />",
      "<book-detail />",
    );
    const result = await build(projectDir);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain("src/pages/work/[slug].html");
  }, 120_000);

  it("a book added to the data file gets a page, a card and a sitemap entry with no other change", async () => {
    const projectDir = await scaffoldPortfolio("add-book");
    await edit(
      projectDir,
      "src/lib/books.ts",
      "export const books: Book[] = checkBooks([\n",
      `export const books: Book[] = checkBooks([
  {
    slug: "a-seventh-book",
    title: "A Seventh Book",
    year: 2026,
    kind: "Novel",
    summary: "A book added by a test, to prove that one entry in the data file is all a new page needs.",
    description: ["Its only paragraph."],
    cover: { tone: "slate", alt: "Cover of A Seventh Book." },
  },
`,
    );
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);
    const page = await dist(projectDir, "work/a-seventh-book.html");
    expect(page).toContain("A Seventh Book - book-shelf</title>");
    expect(page).toContain("Its only paragraph.");
    // First in the list, so it has an older neighbor and no newer one.
    expect(page).toContain(`href="/work/${SAMPLE_BOOKS[0].slug}"`);
    expect(page).not.toContain("book-detail-newer");
    expect(await dist(projectDir, "work.html")).toContain(
      'href="/work/a-seventh-book"',
    );
    expect(await dist(projectDir, "sitemap.xml")).toContain(
      `<loc>${SITE_URL}/work/a-seventh-book</loc>`,
    );
  }, 120_000);

  it("passes the generated project's own unit tests", async () => {
    const projectDir = await scaffoldPortfolio("vitest");
    const result = await run(
      projectDir,
      [join(REPO_ROOT, "node_modules/vitest/vitest.mjs"), "run"],
      120_000,
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toMatch(/Test Files\s+15 passed \(15\)/);
  }, 150_000);

  it("still builds, with the same pages, and passes its unit tests after Prettier formats the project", async () => {
    const projectDir = await scaffoldPortfolio("prettier");
    const prettier = join(REPO_ROOT, "node_modules/prettier/bin/prettier.cjs");
    // The files the template wrote itself are formatted already; the ones that carry the default template's
    // CSS and head tags are not, so this run rewrites those and nothing else.
    const check = await run(
      projectDir,
      [prettier, "--list-different", "src", "e2e", "bascik.config.ts"],
      60_000,
    );
    expect(
      check.output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .sort(),
    ).toEqual([
      "e2e/playwright.config.ts",
      "src/components/site-footer/site-footer.html",
      "src/components/site-header/site-header.html",
      "src/components/site-meta/site-meta.html",
      "src/pages/css/styles.css",
    ]);
    const format = await run(
      projectDir,
      [prettier, "--write", "src", "e2e", "bascik.config.ts"],
      60_000,
    );
    expect(format.exitCode, format.output).toBe(0);

    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);
    expect((await readdir(join(projectDir, "dist", "work"))).sort()).toEqual(
      SAMPLE_BOOKS.map((book) => `${book.slug}.html`).sort(),
    );
    // The header's name sits in a link with a build script inside it: formatting must not add markup there.
    const logo = /data-testid="site-header-logo"[^>]*>([^<]*)<\/a\s*>/.exec(
      await dist(projectDir, "index.html"),
    );
    expect(logo?.[1].trim()).toBe("book-shelf");
    const tests = await run(
      projectDir,
      [join(REPO_ROOT, "node_modules/vitest/vitest.mjs"), "run"],
      120_000,
    );
    expect(tests.exitCode, tests.output).toBe(0);
  }, 240_000);
});
