/**
 * Integration tests for the `shop` template: the real compiler builds a
 * scaffolded shop, and the output is read from disk.
 *
 * The matrix in scaffold.integration.test.ts already builds every template with
 * every adapter and runs `bascik --check` and the audits. These tests cover what
 * is the shop's own: one page per catalog entry, the sitemap, the modules
 * published for the browser, a site name that needs escaping, and a catalog
 * mistake failing the build with the entry's name.
 *
 * Needs `yarn pkg:build` first, like scaffold.integration.test.ts.
 */

import { execFile } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { scaffold } from "../scaffold.ts";
import { SHOP_TEMPLATE } from "./shop.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const PKG_DIST_INDEX = join(REPO_ROOT, "pkg/dist/index.js");

const tempDirs: string[] = [];

afterEach(async () => {
  // A build that fails can exit while a build script's process is still writing
  // its compile cache, so removing the folder is retried.
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

/** A scaffolded shop with `@bascik/bascik` linked to the workspace package. */
async function scaffoldShop(projectName: string): Promise<string> {
  const parentDir = await mkdtemp(join(tmpdir(), "bascik-shop-test-"));
  tempDirs.push(parentDir);
  await scaffold(projectName, parentDir, { template: SHOP_TEMPLATE });
  const projectDir = join(parentDir, projectName);
  const scope = join(projectDir, "node_modules", "@bascik");
  await mkdir(scope, { recursive: true });
  await symlink(join(REPO_ROOT, "pkg"), join(scope, "bascik"), "dir");
  return projectDir;
}

async function build(
  projectDir: string,
): Promise<{ output: string; exitCode: number }> {
  const run = execFileAsync(process.execPath, [PKG_CLI, "--build"], {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      NODE_ENV: "production",
      BASCIK_SITE_URL: "https://example.com",
    },
    timeout: 90_000,
  });
  return run.then(
    ({ stdout, stderr }) => ({ output: `${stdout}\n${stderr}`, exitCode: 0 }),
    (err: { stdout?: string; stderr?: string }) => ({
      output: `${err.stdout ?? ""}\n${err.stderr ?? ""}`,
      exitCode: 1,
    }),
  );
}

/** Replace text in a project file. The edit must change the file. */
async function edit(
  projectDir: string,
  path: string,
  find: string,
  replacement: string,
): Promise<void> {
  const target = join(projectDir, ...path.split("/"));
  const original = await readFile(target, "utf8");
  expect(original, `${path} has no ${find}`).toContain(find);
  await writeFile(
    target,
    original.replace(find, () => replacement),
    "utf8",
  );
}

describe("shop template build", () => {
  beforeAll(() => {
    if (!existsSync(PKG_DIST_INDEX)) {
      throw new Error(
        `[shop.integration.test] Required artifact missing: ${PKG_DIST_INDEX}. Run \`yarn pkg:build\` from the repository root first.`,
      );
    }
  });

  it("builds one page per racing product, lists them in the sitemap, and publishes the browser modules", async () => {
    // scaffold() takes any name; the CLI would refuse this one. It must reach the pages escaped.
    const siteName = "Porsche & Sons Racing Works";
    const projectDir = await scaffoldShop(siteName);
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);
    const dist = join(projectDir, "dist");
    const read = (path: string): Promise<string> =>
      readFile(join(dist, ...path.split("/")), "utf8");

    // One page per catalog entry, from the dynamic route.
    const { books } = (await import(
      pathToFileURL(join(projectDir, "catalog", "books.ts")).href
    )) as { books: { slug: string; title: string }[] };
    const pages = (await readdir(join(dist, "books"))).sort();
    expect(pages).toEqual(
      ["index.html", ...books.map((book) => `${book.slug}.html`)].sort(),
    );

    // The sitemap lists the home page, the catalog and every book, and none of the checkout pages.
    const sitemap = await read("sitemap.xml");
    for (const path of [
      "/",
      "/books/",
      ...books.map((b) => `/books/${b.slug}`),
    ])
      expect(sitemap).toContain(`<loc>https://example.com${path}</loc>`);
    for (const path of ["cart", "checkout", "order-confirmed", "404"])
      expect(sitemap).not.toContain(`https://example.com/${path}<`);

    // A product page: an absolute canonical URL, Product data, the product's own heading, and no leftover tags.
    const page = await read("books/917-longtail-racing-jacket.html");
    expect(page).toContain(
      '<link rel="canonical" href="https://example.com/books/917-longtail-racing-jacket"',
    );
    const data = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
        page,
      )![1],
    ) as Record<string, unknown>;
    expect(data).toMatchObject({
      "@type": "Product",
      name: "917 Longtail Racing Jacket",
      offers: {
        price: "240.00",
        priceCurrency: "USD",
        url: "https://example.com/books/917-longtail-racing-jacket",
      },
    });
    expect(page).toMatch(/<h1[^>]*>917 Longtail Racing Jacket<\/h1>/);
    expect(page).toContain("$240.00");
    expect(page).toMatch(
      /role="img"[^>]*aria-label="917 Longtail Racing Jacket by Hurley Haywood"/,
    );
    expect(page).not.toMatch(/<book-|<site-|data-bascik-/);

    // The catalog page lists every book in the HTML itself, before any script runs.
    const catalog = await read("books/index.html");
    for (const book of books) expect(catalog).toContain(book.title);
    expect(catalog.match(/data-testid="book-card"/g)).toHaveLength(
      books.length,
    );

    // The site name is escaped wherever it is printed, and never raw.
    const home = await read("index.html");
    expect(home).toContain("Porsche &amp; Sons Racing Works</title>");
    expect(home).not.toContain(siteName);
    expect(home.match(/<h1\b/g)).toHaveLength(1);

    // The cart and checkout pages are static and marked noindex.
    for (const path of ["cart.html", "checkout.html", "order-confirmed.html"])
      expect(await read(path)).toContain(
        '<meta name="robots" content="noindex"',
      );
    expect(await read("order-confirmed.html")).toContain(
      "No payment is taken; connect a payment provider here.",
    );

    // The browser modules are plain JavaScript with no import left to resolve, and no API route exists.
    for (const name of ["books.js", "cart.js", "money.js"]) {
      const module = await read(`js/${name}`);
      expect(module, name).not.toMatch(/^\s*import\s/m);
      expect(module, name).toContain("export ");
    }
    expect(await read("js/cart.js")).not.toMatch(/: CartLine\[\]|interface /);
    expect(existsSync(join(projectDir, "src", "api"))).toBe(false);
  }, 120_000);

  it.each([
    [
      "a price that is not whole cents",
      "priceCents: 16500",
      "priceCents: 16.5",
      'item 2 ("935-moby-dick-racing-suit") needs "priceCents" as a whole number of cents above zero',
    ],
    [
      "a negative price",
      "priceCents: 8500",
      "priceCents: -850",
      'item 8 ("963-penske-wheel-nut-set") needs "priceCents" as a whole number of cents above zero',
    ],
    [
      "a duplicate slug",
      'slug: "917-longtail-racing-jacket"',
      'slug: "935-moby-dick-racing-suit"',
      'item 2 ("935-moby-dick-racing-suit") repeats the slug of an earlier item',
    ],
    [
      "a missing author",
      'author: "Hurley Haywood",',
      "",
      'item 1 ("917-longtail-racing-jacket") is missing "author"',
    ],
  ])(
    "misuse: %s fails the build with an error naming the item",
    async (_kind, find, replacement, message) => {
      const projectDir = await scaffoldShop("bad-shop");
      await edit(projectDir, "catalog/books.ts", find, replacement);
      const result = await build(projectDir);
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain(`catalog/books.ts: ${message}`);
      // The failed build leaves no product pages behind to deploy by mistake.
      expect(
        existsSync(
          join(projectDir, "dist", "books", "917-longtail-racing-jacket.html"),
        ),
      ).toBe(false);
    },
    120_000,
  );
});
