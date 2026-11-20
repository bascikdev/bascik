import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADAPTERS, SITE_HEADER_CSS, type TemplateFile } from "../scaffold.js";
import { TEMPLATES, templateNamed } from "../templates.js";
import { DOCS_TEMPLATE } from "./docs.js";
import { DOCS_SITE_META_HTML } from "./docs/site.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

const filesOf = (
  context: Parameters<typeof DOCS_TEMPLATE.files>[0] = { siteName: "My Docs" },
): Map<string, string> =>
  new Map(
    DOCS_TEMPLATE.files(context).map(([path, data]: TemplateFile) => [
      path,
      String(data),
    ]),
  );

const files = filesOf();
const file = (path: string): string => {
  const content = files.get(path);
  if (content === undefined) throw new Error(`the template has no ${path}`);
  return content;
};
const pathsMatching = (pattern: RegExp): string[] =>
  [...files.keys()].filter((path) => pattern.test(path));

/** The opening tags in a file, in order, without comments, styles or scripts. */
const openingTags = (html: string): string[] =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/g, "")
    .match(/<[a-z][^>]*>/g) ?? [];

// ─── The generated modules, loaded and run ────────────────────────────────────

interface Heading {
  id: string;
  text: string;
  depth: number;
}
interface DocPage {
  slug: string;
  title: string;
  searchText: string;
  html: string;
  headings: Heading[];
  sidebar: { label: string; links: { slug: string; href: string }[] }[];
  previous?: { slug: string };
  next?: { slug: string };
}
interface GeneratedModules {
  markdown: {
    renderMarkdown(
      body: string,
      where: string,
    ): { html: string; headings: Heading[] };
    slugify(text: string): string;
  };
  docs: {
    getDocs(dir?: string): Promise<DocPage[]>;
    toDoc(slug: string, source: string): unknown;
  };
  sidebar: {
    SIDEBAR: { label: string; pages: string[] }[];
    DOCS_HOME: string;
  };
  head: { pageHead(page: { title: string; description: string }): unknown };
}

/**
 * Write a scaffolded project's `src/lib/` and `content/` into a temporary
 * folder that resolves `marked` and `@bascik/bascik` from this repository,
 * and import the modules. `@bascik/bascik/html` comes from `pkg/dist`.
 */
async function loadProject(
  root: string,
  context: Parameters<typeof DOCS_TEMPLATE.files>[0],
): Promise<GeneratedModules & { contentDir: string }> {
  for (const [path, data] of DOCS_TEMPLATE.files(context)) {
    if (!/^(src\/lib|content)\/.*\.(ts|md)$/.test(path)) continue;
    if (path.endsWith(".test.ts")) continue;
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  const scope = join(root, "node_modules", "@bascik");
  await mkdir(scope, { recursive: true });
  await symlink(join(REPO_ROOT, "pkg"), join(scope, "bascik"), "junction");
  await symlink(
    join(REPO_ROOT, "node_modules", "marked"),
    join(root, "node_modules", "marked"),
    "junction",
  );
  const load = (name: string): Promise<unknown> =>
    import(pathToFileURL(join(root, "src", "lib", `${name}.ts`)).href);
  return {
    markdown: (await load("markdown")) as GeneratedModules["markdown"],
    docs: (await load("docs")) as GeneratedModules["docs"],
    sidebar: (await load("sidebar")) as GeneratedModules["sidebar"],
    head: (await load("head")) as GeneratedModules["head"],
    contentDir: join(root, "content", "docs"),
  };
}

const HOSTILE_NAME = `Tom & "Ann's" <b>Docs</b> \`\${x}\``;

let tempRoot: string;
let project: Awaited<ReturnType<typeof loadProject>>;
let hostile: Awaited<ReturnType<typeof loadProject>>;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "create-bascik-docs-"));
  project = await loadProject(join(tempRoot, "plain"), {
    siteName: "My Docs",
  });
  hostile = await loadProject(join(tempRoot, "hostile"), {
    siteName: HOSTILE_NAME,
  });
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ─── The template ─────────────────────────────────────────────────────────────

describe("docs template", () => {
  it("is registered under the name docs and declares the Markdown parser it imports", () => {
    expect(TEMPLATES).toContain(DOCS_TEMPLATE);
    expect(templateNamed("docs")).toBe(DOCS_TEMPLATE);
    expect(templateNamed("Docs")).toBe(DOCS_TEMPLATE);
    expect(DOCS_TEMPLATE.dependencies).toEqual({ marked: "^18.1.3" });
    expect(file("src/lib/markdown.ts")).toContain('from "marked"');
  });

  it("writes the pages a docs site needs and one template for every Markdown page", () => {
    expect(pathsMatching(/^src\/pages\/.*\.html$/).sort()).toEqual([
      "src/pages/404.html",
      "src/pages/docs/[slug].html",
      "src/pages/index.html",
    ]);
    const template = file("src/pages/docs/[slug].html");
    expect(template).toContain(
      '<script data-bascik-routes type="text/typescript">',
    );
    expect(template).toContain("params: { slug: page.slug }");
  });

  it("writes outside src/ only its Markdown, its config and the e2e spec", () => {
    expect(pathsMatching(/^(?!src\/)/).sort()).toEqual([
      "bascik.config.ts",
      "content/docs/build-and-check.md",
      "content/docs/components-and-design.md",
      "content/docs/deployment.md",
      "content/docs/getting-started.md",
      "content/docs/navigation-and-search.md",
      "content/docs/writing-pages.md",
      "e2e/app.spec.ts",
    ]);
  });

  it("watches content and avoids caching scripts that read the docs directory", () => {
    const config = file("bascik.config.ts");
    expect(config).toContain('watchPaths: ["content/", "src/lib/"]');
    expect(config).toContain('"src/components/docs-*/**"');
    expect(config).toContain('"src/pages/index.html"');
    expect(config).toContain('"src/pages/docs/**"');
    // The site URL is per deployment (BASCIK_SITE_URL), and no other default is changed.
    expect(config).not.toContain("siteUrl");
    expect(config.match(/^ {2}\w+:/gm)).toEqual([
      "  assets:",
      "  pipeline:",
      "  scripts:",
    ]);
  });

  it("gives every component a test beside it and every helper with logic a test", () => {
    const components = pathsMatching(/^src\/components\/.*\.html$/);
    expect(components).toHaveLength(9);
    for (const path of components) {
      expect(files.has(path.replace(/\.html$/, ".test.ts")), path).toBe(true);
    }
    for (const helper of ["head", "markdown", "docs", "current-doc"]) {
      expect(files.has(`src/lib/${helper}.test.ts`), helper).toBe(true);
    }
  });

  it.each([undefined, ...ADAPTERS])(
    "with adapter %s stays static, and mentions the API route only when there is one",
    (adapter) => {
      const withAdapter = filesOf({ siteName: "My Docs", adapter });
      const paths = [...withAdapter.keys()];
      // Same files either way: the adapter's /api/hello route comes from scaffold.
      expect(paths).toEqual([...files.keys()]);
      for (const content of withAdapter.values()) {
        expect(content).not.toContain("data-bascik-server");
        expect(content).not.toContain("data-bascik-stream");
      }
      const spec = withAdapter.get("e2e/app.spec.ts")!;
      expect(spec.includes("/api/hello")).toBe(adapter !== undefined);
      expect(paths).not.toContain(
        "src/components/home-features/home-features.html",
      );
    },
  );
});

// ─── House rules ──────────────────────────────────────────────────────────────

describe("docs template markup", () => {
  it("writes every script as TypeScript", () => {
    for (const path of pathsMatching(/\.html$/)) {
      for (const tag of file(path).match(/<script\b[^>]*>/g) ?? []) {
        expect(
          tag.includes('type="text/typescript"') || /src="[^"]+\.ts"/.test(tag),
          `${path}: ${tag}`,
        ).toBe(true);
      }
    }
    expect(pathsMatching(/\.(js|mjs|cjs)$/)).toEqual([]);
  });

  it("puts a data-testid on every component root and interactive part", () => {
    for (const path of pathsMatching(/^src\/components\/.*\.html$/)) {
      const name = path.split("/")[2];
      if (name === "site-meta") continue; // head tags only: nothing to find
      const [root, ...rest] = openingTags(file(path));
      const id = root.includes(`data-testid="${name}"`);
      expect(id, `${path} root: ${root}`).toBe(true);
      for (const tag of rest) {
        if (/^<(button|input|select|textarea|summary|form|nav)\b/.test(tag)) {
          expect(tag, path).toContain(`data-testid="${name}-`);
        }
      }
      // Links a build script prints carry one too, or are found by role inside a tested landmark.
      for (const tag of file(path).match(/<(button|nav)\b[^>]*>/g) ?? []) {
        expect(tag, path).toContain("data-testid=");
      }
    }
  });

  it("uses the element the job calls for: nav with a label, aside, article", () => {
    for (const path of pathsMatching(/\.html$/)) {
      for (const nav of file(path).match(/<nav\b[^>]*>/g) ?? []) {
        expect(nav, path).toMatch(/aria-label="[^"]+"/);
      }
    }
    const root = (name: string): string =>
      openingTags(file(`src/components/${name}/${name}.html`))[0];
    expect(root("docs-sidebar")).toMatch(/^<nav /);
    expect(root("docs-toc")).toMatch(/^<aside /);
    expect(root("docs-article")).toMatch(/^<article /);
    expect(root("docs-pagination")).toMatch(/^<nav /);
    expect(root("site-header")).toMatch(/^<header /);
    expect(root("site-footer")).toMatch(/^<footer /);
    expect(file("src/components/docs-toc/docs-toc.html")).toContain(
      '<nav aria-label="On this page"',
    );
    // Four navigations on a docs page, each with its own name.
    const labels = pathsMatching(/^src\/components\/.*\.html$/).flatMap(
      (path) =>
        [...file(path).matchAll(/<nav\b[^>]*aria-label="([^"]+)"/g)].map(
          (match) => match[1],
        ),
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toHaveLength(5);
  });

  it("gives every page one <main id=main>, a lang, and pages that read as component tags", () => {
    for (const path of pathsMatching(/^src\/pages\/.*\.html$/)) {
      const page = file(path);
      expect(page.match(/<main\b/g), path).toHaveLength(1);
      expect(page, path).toMatch(/<main id="main" data-testid="[a-z0-9-]+">/);
      expect(page, path).toContain('<html lang="en">');
      expect(page, path).toContain("<site-meta />");
      expect(page, path).toContain("<site-header />");
      expect(page, path).toContain("<site-footer />");
      expect(page, path).toContain("pageHead(");
    }
    expect(file("src/pages/docs/[slug].html")).toMatch(
      /<docs-sidebar \/>\s*<main id="main" data-testid="docs-main">\s*<docs-article \/>\s*<docs-pagination \/>\s*<\/main>\s*<docs-toc \/>/,
    );
    expect(file("src/pages/index.html")).toMatch(
      /<docs-sidebar \/>\s*<main id="main" data-testid="docs-main">\s*<docs-article \/>\s*<docs-pagination \/>\s*<\/main>\s*<docs-toc \/>/,
    );
  });

  it("does not skip a heading level on the pages it writes by hand", () => {
    const levels = (html: string): number[] =>
      [...html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
    // Both root and guide pages use the same article with one h1.
    expect(file("src/pages/index.html")).toContain("<docs-article />");
    expect(levels(file("src/pages/404.html"))).toEqual([1]);
    expect(
      levels(file("src/components/docs-article/docs-article.html")),
    ).toEqual([1]);
    // Nothing around the article adds a heading that could come before its h1.
    for (const name of ["site-header", "docs-sidebar", "docs-toc"]) {
      expect(levels(file(`src/components/${name}/${name}.html`))).toEqual([]);
    }
  });

  it("puts the skip link first in the header, hidden by clipping until focused, as the default template does", () => {
    const header = file("src/components/site-header/site-header.html");
    const [root, first] = openingTags(header);
    expect(root).toMatch(/^<header /);
    expect(first).toContain('href="#main"');
    expect(first).toContain('class="skip-link"');
    // The rules are the default template's own, not a copy that can drift.
    const skipLinkRules = SITE_HEADER_CSS.slice(
      0,
      SITE_HEADER_CSS.indexOf("header {"),
    );
    expect(skipLinkRules).toContain("clip-path: inset(50%)");
    expect(header).toContain(skipLinkRules);
    // The default header's collapsing menu is left out: this header has one link and no toggle.
    expect(header).not.toContain(".menu");
    expect(header).not.toContain(".toggle");
  });

  it("collapses the sidebar behind a real button that names what it controls", () => {
    const sidebar = file("src/components/docs-sidebar/docs-sidebar.html");
    const button = sidebar.match(/<button\b[^>]*>/)![0];
    expect(button).toContain('type="button"');
    expect(button).toContain("aria-expanded=");
    expect(button).toContain('aria-controls="menu"');
    expect(sidebar).toContain('<div id="menu"');
    // Without JavaScript the list stays open and the button stays out of the way.
    expect(button).toMatch(/\shidden>$/);
    expect(sidebar).toContain('.menu[data-state="closed"] { display: none; }');
    expect(sidebar).toContain("@media (max-width: 760px)");
  });

  it("marks the current page with aria-current and keeps heading ids as written", () => {
    expect(file("src/components/docs-sidebar/docs-sidebar.html")).toContain(
      'aria-current="page"',
    );
    expect(file("src/components/docs-article/docs-article.html")).toContain(
      '<article data-bascik-preserve="id"',
    );
  });

  it("builds markup with the html helpers and never with an escaper of its own", () => {
    for (const [path, content] of files) {
      expect(content, path).not.toMatch(/\.replace\(\s*\/[&<>"']/);
      expect(content, path).not.toMatch(/&(amp|lt|gt|quot);["'`]\s*\)/);
      expect(content, path).not.toMatch(/escapeHtml/i);
    }
    for (const path of pathsMatching(/\.html$/)) {
      const scripts =
        file(path).match(
          /<script data-bascik-build[^>]*>[\s\S]*?<\/script>/g,
        ) ?? [];
      for (const script of scripts) {
        if (!script.includes("`")) continue; // returns a helper's value
        expect(script, path).toContain('from "@bascik/bascik/html"');
        expect(script, path).toContain("html`");
      }
    }
    // raw() only where the project's own rendered Markdown is inserted.
    expect(
      pathsMatching(/\.html$/).filter((path) => /\braw\(/.test(file(path))),
    ).toEqual(["src/components/docs-article/docs-article.html"]);
  });

  it("drops the default head's site-wide description, since every page prints its own", () => {
    expect(DOCS_SITE_META_HTML).not.toContain('name="description"');
    expect(DOCS_SITE_META_HTML).toContain('<meta charset="UTF-8" />');
    expect(DOCS_SITE_META_HTML).not.toContain('rel="stylesheet"');
    expect(DOCS_SITE_META_HTML.endsWith("\n")).toBe(true);
  });
});

// ─── Sample content ───────────────────────────────────────────────────────────

describe("docs template sample content", () => {
  it("ships four to six pages in two sidebar groups, one Markdown file per entry", () => {
    const { SIDEBAR, DOCS_HOME } = project.sidebar;
    expect(SIDEBAR).toHaveLength(2);
    const listed = SIDEBAR.flatMap((group) => group.pages);
    expect(listed.length).toBeGreaterThanOrEqual(4);
    expect(listed.length).toBeLessThanOrEqual(6);
    expect(pathsMatching(/^content\/docs\/.*\.md$/).sort()).toEqual(
      listed.map((slug) => `content/docs/${slug}.md`).sort(),
    );
    expect(DOCS_HOME).toBe("/");
  });

  it("reads every page in sidebar order, with previous and next links between them", async () => {
    const pages = await project.docs.getDocs(project.contentDir);
    const listed = project.sidebar.SIDEBAR.flatMap((group) => group.pages);
    expect(pages.map((page) => page.slug)).toEqual(listed);
    expect(pages[0].previous).toBeUndefined();
    expect(pages.at(-1)!.next).toBeUndefined();
    pages.slice(1).forEach((page, index) => {
      expect(page.previous?.slug).toBe(pages[index].slug);
      expect(pages[index].next?.slug).toBe(page.slug);
    });
    for (const page of pages) {
      expect(
        page.sidebar.flatMap((group) => group.links).map((l) => l.slug),
      ).toEqual(listed);
    }
  });

  it("gives every sample page a table of contents whose ids are unique and match its headings", async () => {
    for (const page of await project.docs.getDocs(project.contentDir)) {
      const ids = page.headings.map((heading) => heading.id);
      expect(ids.length, page.slug).toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size, page.slug).toBe(ids.length);
      for (const id of ids) {
        expect(id, page.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(page.html, page.slug).toContain(` id="${id}"`);
      }
      // Sections start at h2: the page's h1 is its front matter title.
      expect(page.headings[0].depth, page.slug).toBe(2);
      expect(page.html, page.slug).not.toContain("<h1");
    }
  });

  it("links only to pages that exist", async () => {
    const slugs = project.sidebar.SIDEBAR.flatMap((group) => group.pages);
    for (const page of await project.docs.getDocs(project.contentDir)) {
      for (const [, target] of page.html.matchAll(/href="\/docs\/([^"#]+)/g)) {
        expect(slugs, `${page.slug} links to /docs/${target}`).toContain(
          target,
        );
      }
    }
  });

  it("uses generic documentation topics without fictional attribution to real people or companies", () => {
    const markdown = pathsMatching(/^content\/docs\//)
      .map(file)
      .join("\n");
    expect(markdown).toMatch(/search/i);
    expect(markdown).toMatch(/front matter/i);
    expect(markdown).not.toMatch(/Porsche|race weekend|race operations/i);
    expect(markdown).not.toMatch(
      /Hurley Haywood|Paul Newman|Jordan Taylor|Ross Bentley/i,
    );
  });
});

// ─── Misuse ───────────────────────────────────────────────────────────────────

describe("docs template misuse", () => {
  it("keeps a site name with HTML and script characters in one JSON string", () => {
    const hostileFiles = filesOf({ siteName: HOSTILE_NAME });
    expect(hostileFiles.get("src/lib/site.ts")).toContain(
      `export const SITE_NAME = ${JSON.stringify(HOSTILE_NAME)};`,
    );
    // No page, component or test has the name typed into it: they all read SITE_NAME.
    for (const [path, content] of hostileFiles) {
      if (path === "src/lib/site.ts") continue;
      expect(content, path).not.toContain("Ann's");
      expect(content, path).toBe(files.get(path));
    }
  });

  it("escapes that site name wherever a page prints it", () => {
    const head = String(
      hostile.head.pageHead({
        title: "Braking zones",
        description: "Braking references.",
      }),
    );
    expect(head).toContain(
      "<title>Braking zones - Tom &amp; &quot;Ann&#39;s&quot; &lt;b&gt;Docs&lt;/b&gt; `${x}`</title>",
    );
    expect(head).not.toContain("<b>");
    expect(head).toContain(
      'content="Tom &amp; &quot;Ann&#39;s&quot; &lt;b&gt;Docs&lt;/b&gt; `${x}`"',
    );
  });

  it("escapes a page title and description with HTML characters in the head", () => {
    const head = String(
      project.head.pageHead({
        title: 'The <book> tag & "quotes"',
        description: 'Say "hi" to <author> & co.',
      }),
    );
    expect(head).toContain(
      "<title>The &lt;book&gt; tag &amp; &quot;quotes&quot; - My Docs</title>",
    );
    expect(head).toContain(
      'content="Say &quot;hi&quot; to &lt;author&gt; &amp; co."',
    );
  });

  it("keeps table of contents ids unique when headings repeat or collide with the page's own id", () => {
    const { headings, html } = project.markdown.renderMarkdown(
      "## Example\n\n## Example\n\n### Example\n\n## Example 2\n\n## Main\n",
      "content/docs/x.md",
    );
    const ids = headings.map((heading) => heading.id);
    expect(ids).toEqual([
      "example",
      "example-2",
      "example-3",
      "example-2-2",
      "main-2",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(html).toContain(` id="${id}"`);
  });

  it("builds valid ids and plain link text from headings with HTML-special characters", () => {
    const { headings, html } = project.markdown.renderMarkdown(
      [
        '## The `<book>` tag & "quotes"',
        "## <em>Raw</em> <script>alert(1)</script> html",
        "## Tom's *favorite* [reference](/docs/data-and-rules)",
        "## ???",
        "## Über Bücher 2",
      ].join("\n\n"),
      "content/docs/x.md",
    );
    expect(headings).toEqual([
      {
        id: "the-book-tag-quotes",
        text: 'The <book> tag & "quotes"',
        depth: 2,
      },
      { id: "raw-alert-1-html", text: "Raw alert(1) html", depth: 2 },
      {
        id: "toms-favorite-reference",
        text: "Tom's favorite reference",
        depth: 2,
      },
      { id: "section", text: "???", depth: 2 },
      { id: "über-bücher-2", text: "Über Bücher 2", depth: 2 },
    ]);
    // An id never holds a character that could end the attribute or start a tag.
    for (const { id } of headings) expect(id).not.toMatch(/[\s"'<>&`=]/);
    // The heading itself is marked's own rendering: code is escaped, the link stays a link.
    expect(html).toContain(
      "<code>&lt;book&gt;</code> tag &amp; &quot;quotes&quot;",
    );
    expect(html).toContain(
      '<h2 id="toms-favorite-reference">Tom&#39;s <em>favorite</em> <a href="/docs/data-and-rules">reference</a></h2>',
    );
  });

  it("prints table of contents text through html, so heading text is escaped there", () => {
    const toc = file("src/components/docs-toc/docs-toc.html");
    expect(toc).toContain('href="#${heading.id}"');
    expect(toc).toContain(">${heading.text}</a>");
    expect(toc).not.toMatch(/\braw\(/);
  });

  it("fails, naming the file, on a second page title or a skipped heading level", () => {
    const { renderMarkdown } = project.markdown;
    expect(() => renderMarkdown("# Again\n", "content/docs/x.md")).toThrow(
      'content/docs/x.md: "# Again" would be a second page title.',
    );
    expect(() =>
      renderMarkdown("## One\n\n#### Four\n", "content/docs/x.md"),
    ).toThrow(
      'content/docs/x.md: the heading "Four" skips a level (h2 to h4). Use ### here.',
    );
  });

  it("fails, naming the file, when front matter has no title or description or the file name is not a URL", () => {
    const { toDoc } = project.docs;
    expect(() => toDoc("x", "Body only\n")).toThrow(
      "content/docs/x.md: front matter needs a title",
    );
    expect(() => toDoc("x", "---\ntitle: X\n---\nBody\n")).toThrow(
      "content/docs/x.md: front matter needs a description",
    );
    expect(() =>
      toDoc("My Page", "---\ntitle: X\ndescription: Y\n---\n"),
    ).toThrow("content/docs/My Page.md: file names must be lowercase words");
  });

  it("fails the build, naming the page, when a Markdown file is missing from the sidebar", async () => {
    const dir = join(tempRoot, "unlisted");
    await mkdir(dir);
    for (const path of pathsMatching(/^content\/docs\//)) {
      await writeFile(join(dir, path.split("/").pop()!), file(path));
    }
    await writeFile(
      join(dir, "weather-notes.md"),
      "---\ntitle: Weather notes\ndescription: How to update a guide when conditions change.\n---\n\n## Update the guide\n",
    );
    await expect(project.docs.getDocs(dir)).rejects.toThrow(
      'content/docs/weather-notes.md is not in the sidebar. Add "weather-notes" to SIDEBAR in src/lib/sidebar.ts, or delete the file.',
    );
  });

  it("fails the build, naming the entry, when the sidebar lists a page with no file", async () => {
    const dir = join(tempRoot, "missing");
    await mkdir(dir);
    for (const path of pathsMatching(/^content\/docs\//)) {
      if (path.endsWith("/deployment.md")) continue;
      await writeFile(join(dir, path.split("/").pop()!), file(path));
    }
    await expect(project.docs.getDocs(dir)).rejects.toThrow(
      'src/lib/sidebar.ts: SIDEBAR lists "deployment", but content/docs/deployment.md does not exist. Create the file or remove the entry.',
    );
  });

  it("ignores files in the content folder that are not Markdown", async () => {
    const dir = join(tempRoot, "extras");
    await mkdir(dir);
    for (const path of pathsMatching(/^content\/docs\//)) {
      await writeFile(join(dir, path.split("/").pop()!), file(path));
    }
    await writeFile(join(dir, ".DS_Store"), "");
    await writeFile(join(dir, "notes.txt"), "not a page");
    await expect(project.docs.getDocs(dir)).resolves.toHaveLength(6);
  });
});
