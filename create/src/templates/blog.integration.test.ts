/**
 * blog.integration.test.ts
 *
 * The blog template through the real compiler and the generated project's own test runner.
 *
 * Boundary tested:
 * `scaffold()` on the real filesystem -> the Bascik CLI in a child process (`bascik --build`), including the
 * routes script that turns each Markdown file into a page and the `post` exec script that writes the feed ->
 * the files in `dist/`. Then the generated project's Vitest suite, run in that project.
 *
 * The template-by-adapter matrix in scaffold.integration.test.ts already builds this template with every
 * adapter and runs `--check` and the audits. This file asserts what only a blog has: one page per post, the
 * list order, the feed, the sitemap, and a build that fails on a post it cannot read.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
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
import { BLOG_TEMPLATE } from "./blog.ts";
import { SAMPLE_POSTS } from "./blog/content.ts";
import { siteModule } from "./blog/lib.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const SITE_URL = "https://example.com";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * A scaffolded blog in a temporary folder. A scaffolded project has no node_modules, so Bascik and the packages
 * the site and its tests import are linked from the workspace; each resolves its own dependencies from its
 * real path.
 */
async function scaffoldBlog(label: string): Promise<string> {
  const parentDir = await mkdtemp(join(tmpdir(), `bascik-blog-test-${label}-`));
  tempDirs.push(parentDir);
  const projectDir = join(parentDir, "book-notes");
  const { notes } = await scaffold("book-notes", parentDir, {
    template: BLOG_TEMPLATE,
  });
  expect(notes).toEqual([]);
  const modules = join(projectDir, "node_modules");
  await mkdir(join(modules, "@bascik"), { recursive: true });
  await symlink(
    join(REPO_ROOT, "pkg"),
    join(modules, "@bascik", "bascik"),
    "dir",
  );
  for (const name of [
    ...Object.keys(BLOG_TEMPLATE.dependencies ?? {}),
    "vitest",
  ])
    await symlink(
      join(REPO_ROOT, "node_modules", name),
      join(modules, name),
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

/** The front matter values of a sample post. */
const field = (markdown: string, key: string): string =>
  new RegExp(`^${key}: (.*)$`, "m").exec(markdown)![1];

/** The hrefs of the post cards in a built page, in document order. Test ids survive identifier minification. */
const cardLinks = (html: string): string[] =>
  [
    ...html.matchAll(
      /<a\b[^>]*data-testid="?post-card-link"?[^>]*href="?([^" >]+)/g,
    ),
  ].map((match) => match[1]);

describe("blog template through the compiler", () => {
  beforeAll(() => {
    if (!existsSync(join(REPO_ROOT, "pkg/dist/index.js")))
      throw new Error(
        "[blog.integration.test] pkg/dist is missing. Run `yarn pkg:build` from the repository root first.",
      );
  });

  it("builds one page per Markdown post, the lists in date order, the feed and the sitemap", async () => {
    const projectDir = await scaffoldBlog("build");
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);
    const dist = (path: string): Promise<string> =>
      readFile(join(projectDir, "dist", path), "utf8");

    // Every post has a page with its own title, heading, date and canonical URL.
    for (const [slug, markdown] of SAMPLE_POSTS) {
      const page = await dist(`blog/${slug}/index.html`);
      const title = field(markdown, "title");
      expect(page).toContain(`<title>${title} - book-notes</title>`);
      expect(page).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
      expect(page).toMatch(
        new RegExp(`<time datetime="?${field(markdown, "date")}"?>`),
      );
      expect(page).toContain(`${SITE_URL}/blog/${slug}/`);
      expect(page).toMatch(/property="?og:type"? content="?article"?/);
    }
    // Markdown became HTML: a heading, a list and a table from the sample posts.
    const outline = await dist(
      "blog/how-nora-carrow-outlines-on-index-cards/index.html",
    );
    expect(outline).toContain("<h2>The rules</h2>");
    expect(outline).toContain("<table>");
    expect(outline).not.toContain("## The rules");

    // The lists are newest first: three on the home page, all of them on /blog/.
    const newestFirst = SAMPLE_POSTS.map(([slug]) => `/blog/${slug}/`);
    expect(cardLinks(await dist("index.html"))).toEqual(
      newestFirst.slice(0, 3),
    );
    expect(cardLinks(await dist("blog/index.html"))).toEqual(newestFirst);
    // A tag page holds only its tag's posts.
    expect(cardLinks(await dist("blog/tags/craft/index.html"))).toEqual(
      SAMPLE_POSTS.filter(([, markdown]) =>
        /^tags: \[.*\bcraft\b.*\]$/m.test(markdown),
      ).map(([slug]) => `/blog/${slug}/`),
    );

    // The feed: one entry per post, in the same order, every URL absolute.
    const feed = await dist("feed.xml");
    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(
      [...feed.matchAll(/<entry>[\s\S]*?<link href="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(newestFirst.map((path) => `${SITE_URL}${path}`));
    for (const [, url] of feed.matchAll(/(?:href|<id>)="?([^"<]+)/g))
      expect(url.startsWith(`${SITE_URL}/`), url).toBe(true);
    expect(feed.trimEnd().endsWith("</feed>")).toBe(true);

    // The sitemap lists every post and tag page, and not the 404 page or a route template.
    const sitemap = await dist("sitemap.xml");
    for (const path of newestFirst)
      expect(sitemap).toContain(`<loc>${SITE_URL}${path}</loc>`);
    expect(sitemap).toContain(`<loc>${SITE_URL}/blog/tags/craft/</loc>`);
    expect(sitemap).not.toContain("404");
    expect(sitemap).not.toContain("[");
  }, 120_000);

  it.each([
    [
      "a missing title",
      (post: string) => post.replace(/^title: .*\n/m, () => ""),
      "front matter needs title",
    ],
    [
      "a date that is not YYYY-MM-DD",
      (post: string) =>
        post.replace(/^date: .*$/m, () => "date: October 28th, 2026"),
      'front matter needs date as YYYY-MM-DD, not "October 28th, 2026"',
    ],
    [
      "a line that is not key: value",
      (post: string) => post.replace(/^author: /m, () => "author "),
      "unreadable front matter line: author Maren Okafor",
    ],
    [
      "front matter that is never closed",
      (post: string) => post.replace(/\n---\n/, () => "\n"),
      "front matter is not closed with a --- line",
    ],
  ])(
    "fails the build and names the file for a post with %s",
    async (_case, breakPost, message) => {
      const projectDir = await scaffoldBlog("bad-post");
      const [slug, markdown] = SAMPLE_POSTS[0];
      const broken = breakPost(markdown);
      expect(broken).not.toBe(markdown);
      await writeFile(
        join(projectDir, "content/posts", `${slug}.md`),
        broken,
        "utf8",
      );
      const result = await build(projectDir);
      expect(result.exitCode, result.output).not.toBe(0);
      expect(result.output).toContain(`content/posts/${slug}.md: ${message}`);
    },
    120_000,
  );

  it("escapes a site name that is markup wherever a page, the feed or a head tag prints it", async () => {
    const projectDir = await scaffoldBlog("site-name");
    // create-bascik refuses these characters in a project name, so this is the site.ts a reader could write.
    const siteName = 'Tom & "Runa" <script>alert(1)</script>';
    await writeFile(
      join(projectDir, "src/lib/site.ts"),
      siteModule(siteName),
      "utf8",
    );
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);
    for (const path of ["index.html", "about.html", "404.html", "feed.xml"]) {
      const text = await readFile(join(projectDir, "dist", path), "utf8");
      expect(text, path).not.toContain("<script>alert(1)</script>");
      expect(text, path).not.toContain('"Runa" <');
      expect(text, path).toContain("Tom &amp; ");
      expect(text, path).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }
  }, 120_000);

  it("passes the generated project's own unit tests", async () => {
    const projectDir = await scaffoldBlog("unit");
    const result = await run(
      projectDir,
      [join(projectDir, "node_modules/vitest/vitest.mjs"), "run"],
      150_000,
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toMatch(/Test Files\s+11 passed \(11\)/);
  }, 180_000);
});
