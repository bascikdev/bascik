/**
 * `bascik --build --config <path>` with `pipeline.workers: true` compiles
 * pages with the config the flag names.
 *
 * Page workers load the config themselves, and a worker thread does not
 * inherit `process.argv`, so the flag has to be handed to them. Without it
 * a worker falls back to config discovery: it compiles with the defaults, or
 * with a `bascik.config.*` in the project root that the flag was meant to
 * replace, while the main thread uses the named file.
 *
 * These tests run the real CLI (`src/index.ts --build`) as a child process
 * and read what it wrote to disk. Each build runs twice, with workers off
 * and on, and the output must be the same bytes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  runRealBuild,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Books</title>
  </head>
  <body>
    <book-card></book-card>
    <a href="/authors">Authors</a>
  </body>
</html>
`;

const BOOK_CARD = `<style>
  .title {
    color: rgb(0, 100, 0);
  }
</style>
<article data-testid="book-card">
  <h2 class="title">Dune</h2>
</article>
`;

/** A config that differs from the build defaults in ways the page shows. */
const namedConfig = (workers: boolean, pages = "src/pages") => `export default {
  directory: { pages: ${JSON.stringify(pages)}, out: "dist" },
  pipeline: { workers: ${workers} },
  generate: { sitemap: false, robots: false },
  minify: false,
  base: "/library/",
};
`;

const makeProject = async (name: string, pages = "src/pages") => {
  const root = fixtureRoot(`config-flag-workers-${name}`);
  roots.push(root);
  await createFixtureDirs(root);
  // Two pages, so the pool has more than one worker to hand the flag to.
  await writeFixtureFile(root, `${pages}/index.html`, PAGE);
  await writeFixtureFile(root, `${pages}/authors.html`, PAGE);
  await writeFixtureFile(
    root,
    "src/components/book-card/book-card.html",
    BOOK_CARD,
  );
  await writeFixtureFile(root, "config/off.mjs", namedConfig(false, pages));
  await writeFixtureFile(root, "config/on.mjs", namedConfig(true, pages));
  return root;
};

const build = async (root: string, args: string[]) => {
  await runRealBuild({
    projectRoot: root,
    args,
    env: { NO_COLOR: "1" },
  });
  return {
    index: readFileSync(join(root, "dist/index.html"), "utf8"),
    authors: readFileSync(join(root, "dist/authors.html"), "utf8"),
  };
};

describe("--config with pipeline.workers", () => {
  it("compiles pages in workers with the named config, as it does without workers", async () => {
    const root = await makeProject("defaults");
    const serial = await build(root, ["--config", "config/off.mjs"]);
    const parallel = await build(root, ["--config", "config/on.mjs"]);

    // minify: false keeps readable scoped names and the source's line breaks.
    expect(parallel.index).toContain("bascik__book-card__title");
    expect(parallel.index).toContain('href="/library/authors"');
    expect(parallel.index).toBe(serial.index);
    expect(parallel.authors).toBe(serial.authors);
  }, 60_000);

  it("accepts the --config=<path> form", async () => {
    const root = await makeProject("inline-form");
    const serial = await build(root, ["--config=config/off.mjs"]);
    const parallel = await build(root, ["--config=config/on.mjs"]);
    expect(parallel.index).toContain("bascik__book-card__title");
    expect(parallel.index).toBe(serial.index);
  }, 60_000);

  it("does not let a bascik.config.mjs in the project root replace the named config in workers", async () => {
    const root = await makeProject("shadowed");
    await writeFixtureFile(
      root,
      "bascik.config.mjs",
      `export default { generate: { sitemap: false, robots: false }, base: "/wrong/" };\n`,
    );
    const serial = await build(root, ["--config", "config/off.mjs"]);
    const parallel = await build(root, ["--config", "config/on.mjs"]);
    expect(parallel.index).not.toContain("/wrong/");
    expect(parallel.index).toBe(serial.index);
  }, 60_000);

  it("writes pages from a named directory.pages to the same output paths", async () => {
    const root = await makeProject("pages-dir", "site/pages");
    const serial = await build(root, ["--config", "config/off.mjs"]);
    const parallel = await build(root, ["--config", "config/on.mjs"]);
    expect(parallel.index).toBe(serial.index);
    // A worker that fell back to src/pages wrote each page under a copy of
    // its absolute source path inside dist/.
    expect(existsSync(join(root, "dist", root))).toBe(false);
  }, 60_000);
});
