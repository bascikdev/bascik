import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  PACKAGE_JSON,
  SITE_FOOTER_CSS,
  SITE_HEADER_CSS,
  STYLES_CSS,
  type TemplateContext,
} from "../scaffold.js";
import { TEMPLATES, templateNamed } from "../templates.js";
import { BLOG_TEMPLATE } from "./blog.js";
import { SAMPLE_POSTS } from "./blog/content.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** The template's text files for a context, by path. */
const filesFor = (context: TemplateContext): Map<string, string> =>
  new Map(
    BLOG_TEMPLATE.files(context).map(([path, data]) => [path, String(data)]),
  );

const files = filesFor({ siteName: "my-blog" });
const file = (path: string, from = files): string => {
  const text = from.get(path);
  expect(text, `${path} is written`).toBeDefined();
  return text!;
};
const pathsMatching = (pattern: RegExp, from = files): string[] =>
  [...from.keys()].filter((path) => pattern.test(path));

/** The front matter of a sample post as written, without the template's own parser. */
const frontMatter = (markdown: string): Record<string, string> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  expect(block, "the post starts with front matter").not.toBeNull();
  return Object.fromEntries(
    block![1].split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }),
  );
};

/** The object `src/lib/site.ts` exports, evaluated: the file is one object literal with `as const`. */
const siteOf = (
  from: Map<string, string>,
): { name: string; tagline: string; description: string } =>
  new Function(
    file("src/lib/site.ts", from)
      .replace("export const SITE =", () => "return")
      .replace("} as const;", () => "};"),
  )() as { name: string; tagline: string; description: string };

describe("blog template", () => {
  it("is registered after the default, with a summary that says what it is", () => {
    expect(TEMPLATES).toContain(BLOG_TEMPLATE);
    expect(TEMPLATES.indexOf(BLOG_TEMPLATE)).toBeGreaterThan(0);
    expect(templateNamed("Blog")).toBe(BLOG_TEMPLATE);
    expect(BLOG_TEMPLATE.summary).toMatch(/^A blog: Markdown posts/);
    // The feed is Atom, so the summary must not call it RSS.
    expect(BLOG_TEMPLATE.summary).toContain("Atom feed");
    expect(file("src/lib/feed.ts")).toContain("http://www.w3.org/2005/Atom");
  });

  it("declares marked, at the range this repository's own packages use, and nothing else", () => {
    const docsPackage = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "docs/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(BLOG_TEMPLATE.dependencies).toEqual({
      marked: docsPackage.dependencies.marked,
    });
    expect(BLOG_TEMPLATE.devDependencies).toBeUndefined();
    const generated = JSON.parse(
      PACKAGE_JSON("my-blog", undefined, BLOG_TEMPLATE),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(generated.dependencies)).toEqual([
      "@bascik/bascik",
      "marked",
    ]);
    // Every bare import in the generated TypeScript is a declared package, Node, or the test runner.
    const allowed =
      /^(node:|@bascik\/bascik\/|marked$|vitest$|@playwright\/test$|\.{1,2}\/|@\/)/;
    for (const [path, text] of files)
      for (const [, specifier] of text.matchAll(
        /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm,
      ))
        expect(allowed.test(specifier), `${path} imports ${specifier}`).toBe(
          true,
        );
  });

  it("writes the three things the docs' collection layout keeps outside src/, and declares their folders", () => {
    const outside = pathsMatching(/^(?!src\/|e2e\/)/).sort();
    expect(outside).toEqual(
      [
        "bascik.config.ts",
        "scripts/feed.ts",
        ...SAMPLE_POSTS.map(([slug]) => `content/posts/${slug}.md`),
      ].sort(),
    );
    expect(BLOG_TEMPLATE.directories({ siteName: "my-blog" })).toEqual(
      expect.arrayContaining(["content/posts", "scripts", "src/lib"]),
    );
  });

  it("reuses the default template's stylesheets instead of copying them", () => {
    expect(file("src/pages/css/styles.css")).toBe(STYLES_CSS);
    expect(file("src/components/site-header/site-header.html")).toContain(
      SITE_HEADER_CSS,
    );
    expect(file("src/components/site-footer/site-footer.html")).toContain(
      SITE_FOOTER_CSS,
    );
  });
});

describe("blog template: site name", () => {
  it("is written to src/lib/site.ts and nowhere else", () => {
    const named = filesFor({ siteName: "harbor-quartet-notes" });
    expect(siteOf(named).name).toBe("harbor-quartet-notes");
    expect(
      [...named].filter(([, text]) => text.includes("harbor-quartet-notes")),
    ).toHaveLength(1);
  });

  it.each([
    ['Tom & "Runa" <b>bold</b>'],
    ["</script><script>alert(1)</script>"],
    ["back`tick ${process.exit(1)} \\ slash"],
    ["two\nlines and a separator"],
    ["it's"],
  ])("keeps %j exactly, as a string literal the pages escape", (siteName) => {
    const named = filesFor({ siteName });
    // The module still evaluates, and to the same name: no character ended the literal early.
    expect(siteOf(named).name).toBe(siteName);
    // No page or component carries the name: they read it from the module at build time.
    for (const [path, text] of named)
      if (path !== "src/lib/site.ts") expect(text, path).toBe(file(path));
  });

  it("is printed only through html or esc, never pasted into markup", () => {
    const users = [...files].filter(
      ([path, text]) =>
        !path.endsWith(".test.ts") &&
        path !== "src/lib/site.ts" &&
        /SITE\.(name|description|tagline)/.test(text),
    );
    expect(users.map(([path]) => path).sort()).toEqual([
      "src/components/site-footer/site-footer.html",
      "src/components/site-header/site-header.html",
      "src/components/site-intro/site-intro.html",
      "src/lib/feed.ts",
      "src/lib/seo.ts",
      "src/pages/index.html",
    ]);
    // Each one prints it through html or esc, or hands it to seo(), which does. blog.integration.test.ts
    // builds a site whose name is markup and checks the output.
    for (const [path, text] of users)
      expect(
        /import \{[^}]*\b(html|esc)\b[^}]*\} from "@bascik\/bascik\/html"|seo\(\{ description: SITE\.description \}\)/.test(
          text,
        ),
        path,
      ).toBe(true);
    // No hand-rolled escaper anywhere.
    for (const [path, text] of files)
      expect(text, path).not.toMatch(/escapeHtml|\.replace\(\/&\/g/);
  });
});

describe("blog template: pages and components", () => {
  const pages = pathsMatching(/^src\/pages\/.*\.html$/);
  const components = pathsMatching(/^src\/components\/.*\.html$/);

  it("has the pages a blog needs", () => {
    expect(pages.sort()).toEqual([
      "src/pages/404.html",
      "src/pages/about.html",
      "src/pages/blog/[slug]/index.html",
      "src/pages/blog/index.html",
      "src/pages/blog/tags/[tag]/index.html",
      "src/pages/index.html",
    ]);
  });

  it.each(pages)("%s is a short shell of component tags", (path) => {
    const page = file(path);
    expect(page.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(page).toContain("<site-meta />");
    expect(page.match(/<main id="main"/g)).toHaveLength(1);
    expect(page).toMatch(/<main id="main"[^>]* data-testid="[a-z0-9-]+-main">/);
    // The header, with its skip link, comes before the main content, and the footer after it.
    expect(page.indexOf("<site-header />")).toBeGreaterThan(-1);
    expect(page.indexOf("<site-header />")).toBeLessThan(page.indexOf("<main"));
    expect(page.indexOf("<site-footer />")).toBeGreaterThan(
      page.indexOf("</main>"),
    );
    // Its title and description come from seo(), so each page has its own canonical URL and Open Graph tags.
    expect(page).toMatch(/import \{[^}]*\bseo\b[^}]*\} from "@\/lib\/seo\.ts"/);
    expect(page).not.toContain("<title>");
    expect(page.split("\n").length).toBeLessThan(45);
  });

  it("writes every script in TypeScript", () => {
    for (const path of [...pages, ...components])
      for (const [tag] of file(path).matchAll(/<script\b[^>]*>/g))
        expect(tag, path).toContain('type="text/typescript"');
    expect(pathsMatching(/\.(m?js|cjs)$/)).toEqual([]);
  });

  it("gives every component a test beside it and a data-testid on its root", () => {
    expect(components).toHaveLength(8);
    for (const path of components) {
      expect(files.has(path.replace(/\.html$/, ".test.ts")), path).toBe(true);
      const name = path.split("/").at(-2)!;
      // site-meta is head tags only: it has no root element.
      if (name !== "site-meta")
        expect(file(path), path).toContain(`data-testid="${name}"`);
    }
  });

  it("puts the skip link first in the header, hidden by clipping until focused", () => {
    const header = file("src/components/site-header/site-header.html");
    const markup = header.slice(header.indexOf("</style>"));
    expect(markup).toMatch(
      /^<\/style>\n<header data-testid="site-header">\n\s*<a href="#main" class="skip-link"/,
    );
    expect(header).toContain(".skip-link:not(:focus)");
    expect(header).toContain("clip-path: inset(50%)");
  });

  it("uses semantic elements for posts, dates and navigation", () => {
    expect(file("src/components/post-card/post-card.html")).toMatch(
      /<article data-testid="post-card">[\s\S]*<time data-bascik-attr-datetime="date"/,
    );
    expect(file("src/components/post-article/post-article.html")).toContain(
      '<article data-testid="post-article">',
    );
    expect(file("src/components/post-article/article-body.ts")).toContain(
      '<time datetime="${post.date}">',
    );
    expect(file("src/components/site-header/site-header.html")).toContain(
      '<nav aria-label="Main"',
    );
    expect(file("src/components/site-footer/site-footer.html")).toContain(
      '<nav aria-label="Footer"',
    );
  });

  it("gives post cards deliberate editorial spacing and a quiet reading surface", () => {
    const css = file("src/pages/css/blog.css");
    const card = file("src/components/post-card/post-card.html");

    expect(css).toMatch(
      /\.post-cards\s*\{[^}]*display:\s*grid;[^}]*gap:\s*1\.25rem;/s,
    );
    expect(css).toContain("font-family: Georgia, 'Times New Roman', serif;");
    expect(css).toContain("background: transparent;");
    expect(css).toContain("box-shadow: none;");
    expect(card).toContain("border-top: 1px solid var(--border);");
  });

  it("generates one page per post and per tag from dynamic routes, not from hand-written pages", () => {
    const post = file("src/pages/blog/[slug]/index.html");
    expect(post).toContain("<script data-bascik-routes");
    expect(post).toContain("params: { slug: post.slug }, data: post");
    expect(post).toContain("<post-article />");
    expect(file("src/pages/blog/tags/[tag]/index.html")).toContain(
      "<script data-bascik-routes",
    );
    // No sample post has a page of its own in src/pages.
    for (const [slug] of SAMPLE_POSTS)
      expect(pathsMatching(new RegExp(`^src/pages/.*${slug}`))).toEqual([]);
  });

  it("keeps the 404 page out of search results", () => {
    expect(file("src/pages/404.html")).toContain("noindex: true");
  });
});

describe("blog template: content pipeline", () => {
  it("excludes everything that lists the posts folder from the build script cache, and watches the posts", () => {
    const config = file("bascik.config.ts");
    const excluded = [...config.matchAll(/"(src\/[^"]+)\/\*\*"/g)].map(
      (match) => `${match[1]}/`,
    );
    expect(excluded).toHaveLength(3);
    // getPosts() reads a directory, which the cache cannot see.
    const readers = [...files]
      .filter(
        ([path, text]) =>
          /^src\/(pages|components)\//.test(path) &&
          !path.endsWith(".test.ts") &&
          text.includes("getPosts("),
      )
      .map(([path]) => path);
    expect(readers.length).toBeGreaterThanOrEqual(4);
    for (const path of readers)
      expect(
        excluded.some((folder) => path.startsWith(folder)),
        `${path} calls getPosts() but is not in scripts.cache.exclude`,
      ).toBe(true);
    expect(config).toContain('watchPaths: ["content/", "src/lib/"]');
    expect(config).toContain(
      '{ script: "scripts/feed.ts", phase: "post", watch: ["content/"] }',
    );
  });

  it("writes the feed to the output folder, and refuses a production build without a site URL for absolute links", () => {
    const script = file("scripts/feed.ts");
    expect(script).toContain("process.env.BASCIK_OUT_DIR");
    expect(script).toContain('join(outDir, "feed.xml")');
    expect(script).not.toMatch(/writeFile\([^)]*src\//);
    expect(script).toMatch(
      /if \(!siteUrl\) \{[\s\S]*?if \(process\.env\.BASCIK_BUILD === "1"\)\s+throw new Error\(/,
    );
    // XML is escaped with esc(), from the same package as html.
    expect(file("src/lib/feed.ts")).toContain(
      'import { esc } from "@bascik/bascik/html"',
    );
  });

  it("fails a post with missing or malformed front matter with an error that names the file", () => {
    const posts = file("src/lib/posts.ts");
    // Every throw in toPost() starts with the file's path, and a parser error is rethrown with it.
    const toPost = posts.slice(
      posts.indexOf("export function toPost"),
      posts.indexOf("/** Newest first"),
    );
    const thrown = [...toPost.matchAll(/throw new Error\(\s*`([^`]*)`/g)].map(
      (match) => match[1],
    );
    expect(thrown.length).toBeGreaterThanOrEqual(5);
    for (const message of thrown)
      expect(message.startsWith("${where}: "), message).toBe(true);
    expect(toPost).toContain("const where = `${POSTS_DIR}/${slug}.md`");
    // The generated project tests each case; blog.integration.test.ts runs them and a real failing build.
    const tests = file("src/lib/posts.test.ts");
    for (const title of [
      "names the file when %s is missing",
      "names the file when there is no front matter at all",
      "names the file when the front matter is never closed",
      "names the file and the line when a front matter line is not key: value",
      "refuses the date %s",
    ])
      expect(tests).toContain(title);
  });
});

describe("blog template: sample posts", () => {
  it("ships a racing blog with real posts and no invented book publishing themes", () => {
    const combined = SAMPLE_POSTS.map(([, markdown]) => markdown).join("\n");
    for (const reference of [
      "Hurley Haywood",
      "Paul Newman",
      "Jordan Taylor",
      "Ross Bentley",
      "Porsche 917",
      "Porsche 935",
      "Porsche 962",
      "Porsche 963",
      "IMSA",
      "WEC",
      "Daytona",
      "Sebring",
      "Le Mans",
      "Spa",
      "Laguna Seca",
    ])
      expect(combined, reference).toContain(reference);
    expect(SAMPLE_POSTS).toHaveLength(4);
    const dates = SAMPLE_POSTS.map(
      ([, markdown]) => frontMatter(markdown).date,
    );
    expect(dates).toEqual([...dates].sort().reverse());
    for (const [slug, markdown] of SAMPLE_POSTS) {
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const data = frontMatter(markdown);
      expect(Object.keys(data)).toEqual([
        "title",
        "description",
        "date",
        "author",
        "tags",
      ]);
      expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(data.author.length).toBeGreaterThan(3);
      // The description is the post's meta description too.
      expect(data.description.length).toBeGreaterThanOrEqual(50);
      expect(data.description.length).toBeLessThanOrEqual(160);
      expect(markdown).toContain("\n## ");
      expect(markdown.endsWith("\n")).toBe(true);
    }
  });

  it("names the same posts, in the same order, in the generated e2e spec", () => {
    const spec = file("e2e/app.spec.ts");
    const listed = [
      ...spec.matchAll(
        /\{ slug: '([^']+)', title: '([^']+)', date: '([^']+)' \}/g,
      ),
    ].map(([, slug, title, date]) => ({ slug, title, date }));
    expect(listed).toEqual(
      SAMPLE_POSTS.map(([slug, markdown]) => ({
        slug,
        title: frontMatter(markdown).title,
        date: frontMatter(markdown).date,
      })),
    );
  });

  it("covers home, the post list, a post, a tag, the feed and the 404 page in the e2e spec", () => {
    const spec = file("e2e/app.spec.ts");
    for (const test of [
      "home page lists the three newest posts",
      "post list shows every post, newest first",
      "a post page renders its Markdown and its own head tags",
      "a tag page lists only the posts with that tag",
      "feed is Atom with an absolute link for every post",
      "an unknown URL gets the 404 page with a 404 status",
    ])
      expect(spec).toContain(`test('${test}`);
    // Site tests find elements by test id or role, never by a class the build hashes.
    expect(spec).not.toMatch(/locator\('\.[a-z]/);
  });
});

describe("blog template: adapters", () => {
  it.each(ADAPTERS)(
    "stays static with %s: the same files, plus an e2e test of the shared API route",
    (adapter) => {
      const hosted = filesFor({ siteName: "my-blog", adapter });
      expect([...hosted.keys()]).toEqual([...files.keys()]);
      for (const [path, text] of hosted) {
        if (path === "e2e/app.spec.ts") continue;
        expect(text, path).toBe(file(path));
        expect(text, path).not.toMatch(/data-bascik-(server|stream)/);
      }
      const spec = file("e2e/app.spec.ts", hosted);
      expect(spec).toContain("/api/hello?name=Runa");
      expect(file("e2e/app.spec.ts")).not.toContain("/api/hello");
      // The appended test is inside the describe block, which still closes the file.
      expect(spec.trimEnd().endsWith("});\n});")).toBe(true);
    },
  );
});
