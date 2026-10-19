// Unit tests for the pure functions in the public agent skills' scripts and the starter site's helpers.
// The end-to-end checks (copy, build, lint, audit) are in examples.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  destinationFor,
  loadBundle,
  selectFiles,
} from "../../skills/bascik/scripts/add-example.mjs";
import {
  auditPages,
  inspectPage,
  pagePathOf,
} from "../../skills/bascik-seo/scripts/audit-seo.mjs";
import {
  checkSite,
  extractLinks,
  fileFor,
  resolveLink,
} from "../../skills/bascik/scripts/check-links.mjs";
import { analyzeTokens } from "../../skills/bascik-components/scripts/check-tokens.mjs";
import {
  postSource,
  slugify,
} from "../../skills/bascik-scripts/scripts/new-post.mjs";
import { createExamplesBundle } from "./examples-bundle.ts";

const examplesDir = fileURLToPath(new URL("../../examples", import.meta.url));
const starterDir = join(examplesDir, "starter-site");

// The starter site's .ts helpers live outside docs/ (outside this tsconfig's rootDir), so load them by computed path.
const starter = (path: string): Promise<any> => import(join(starterDir, path));
const { escapeHtml, groupByTag, parseFrontMatter, toPost } =
  await starter("src/lib/posts.ts");
const { isCurrent, navLinks } = await import(
  join(examplesDir, "components/site-header/links.ts")
);
const { footerLinks } = await import(
  join(examplesDir, "components/site-footer/links.ts")
);
const { absoluteUrl, jsonLd, seo } = await starter("src/lib/seo.ts");
const { POST, validateContact } = await starter("src/api/contact.ts");
const bundle = await createExamplesBundle(examplesDir);

type TagGroup = { tag: string; posts: Array<{ slug: string }> };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("add-example", () => {
  const layout = {
    root: "/p",
    componentRoot: "/p/src/components",
    pagesDir: "/p/src/pages",
    importRoot: "/p/src",
    apiDir: "/p/src/api",
  };

  const site = { name: "starter-site", kind: "site" };
  const component = { name: "tab-group", kind: "component" };
  const picked = (references: string[]) =>
    selectFiles(bundle, references).map(
      ({
        example,
        file,
      }: {
        example: { name: string };
        file: { path: string };
      }) => `${example.name}/${file.path}`,
    );

  it("maps site folders to the project folders from its config", () => {
    expect(destinationFor(component, "tab-group.html", layout)).toBe(
      join("/p/src/components", "tab-group", "tab-group.html"),
    );
    expect(
      destinationFor(site, "src/components/site-head/site-head.html", layout),
    ).toBe(join("/p/src/components", "site-head/site-head.html"));
    expect(
      destinationFor(site, "src/pages/blog/[slug]/index.html", layout),
    ).toBe(join("/p/src/pages", "blog/[slug]/index.html"));
    expect(destinationFor(site, "src/lib/seo.ts", layout)).toBe(
      join("/p/src", "lib", "seo.ts"),
    );
    expect(destinationFor(site, "src/api/contact.ts", layout)).toBe(
      join("/p/src/api", "contact.ts"),
    );
    expect(destinationFor(site, "scripts/feed.ts", layout)).toBe(
      join("/p", "scripts/feed.ts"),
    );
    expect(destinationFor(site, "content/posts/a.md", layout)).toBe(
      join("/p", "content/posts/a.md"),
    );
  });

  it("prints the config, package.json, and README instead of copying them", () => {
    for (const file of [
      "bascik.config.ts",
      "bascik.config.js",
      "package.json",
      "README.md",
    ]) {
      expect(destinationFor(site, file, layout)).toBeUndefined();
    }
  });

  it("refuses paths that would escape the project", () => {
    for (const file of [
      "../x.html",
      "/etc/passwd",
      "src/../../x",
      "a//b",
      "./a",
    ]) {
      expect(() => destinationFor(site, file, layout)).toThrow(/unsafe path/);
    }
  });

  it("selects a component, a site file, or a site folder, and adds the components they use", () => {
    expect(picked(["tab-group"])).toEqual(["tab-group/tab-group.html"]);
    expect(picked(["starter-site/src/lib/seo.ts"])).toEqual([
      "starter-site/src/lib/seo.ts",
    ]);
    const contact = picked(["starter-site/src/pages/contact.html"]);
    expect(contact).toContain("contact-form/contact-form.html");
    expect(contact).toContain(
      "starter-site/src/components/site-head/site-head.html",
    );
    expect(
      picked(["starter-site/src/pages/blog"]).every(
        (ref: string) =>
          !ref.startsWith("starter-site/") ||
          ref.startsWith("starter-site/src/"),
      ),
    ).toBe(true);
  });

  it("lists each file once and rejects unknown names and paths", () => {
    const refs = picked([
      "contact-form",
      "starter-site/src/pages/contact.html",
    ]);
    expect(new Set(refs).size).toBe(refs.length);
    expect(() => selectFiles(bundle, ["nope"])).toThrow(
      /no example named "nope"/,
    );
    expect(() => selectFiles(bundle, ["tab-group/missing.html"])).toThrow(
      /no file or folder/,
    );
  });

  it("rejects a bundle version it does not understand", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "bascik-bundle-"));
    const file = join(dir, "examples.json");
    writeFileSync(file, JSON.stringify({ version: 2, examples: [] }));
    try {
      await expect(loadBundle(file)).rejects.toThrow(
        /not a supported examples bundle/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit-seo", () => {
  const page = (path: string, head: string, body = "<h1>Title</h1>") => ({
    path,
    file: path === "/" ? "index.html" : `${path.slice(1)}.html`,
    html: `<!doctype html><html lang=en><head><meta name=viewport content="width=device-width">${head}</head><body>${body}</body></html>`,
  });
  const good = (path: string, title: string, description: string) =>
    page(
      path,
      `<title>${title}</title><meta name=description content="${description}"><link rel=canonical href=https://example.com${path}>` +
        `<meta property=og:title content=x><meta property=og:description content=x><meta property=og:url content=x>`,
    );

  it("reads unquoted attributes from minified output", () => {
    const facts = inspectPage(
      "<html lang=en><head><meta name=robots content=noindex><link rel=canonical href=https://e.com/a></head></html>",
    );
    expect(facts.lang).toBe("en");
    expect(facts.robots).toBe("noindex");
    expect(facts.canonical).toBe("https://e.com/a");
  });

  it("ignores headings and images inside case-insensitive script and style elements", () => {
    const facts = inspectPage(
      '<html><body><SCRIPT>"<h1>fake</h1><img src=x>"</SCRIPT><style>/* <h1>fake</h1> */</style><h1>real</h1></body></html>',
    );
    expect(facts.h1Count).toBe(1);
    expect(facts.imagesWithoutAlt).toBe(0);
  });

  it("does not form new HTML from either side of a script or style", () => {
    const facts = inspectPage(
      '<body><h<script>inert</script>1>fake</h1><SCRIPT>"<h1>ignored</h1>"</script\t\n data-test><h1>real</h1></body>',
    );
    expect(facts.h1Count).toBe(1);
  });

  it("maps dist files to the same paths the sitemap and BASCIK_PAGE_PATH use", () => {
    expect(pagePathOf("index.html")).toBe("/");
    expect(pagePathOf("about.html")).toBe("/about");
    expect(pagePathOf(join("blog", "post", "index.html"))).toBe("/blog/post/");
  });

  it("passes a complete page and flags duplicates and a wrong canonical", () => {
    const description =
      "A description that is comfortably longer than fifty characters.";
    expect(
      auditPages([good("/", "Home - Example Site", description)], {
        siteUrl: "https://example.com",
      }).filter((f: { level: string }) => f.level !== "info"),
    ).toEqual([]);

    const findings = auditPages(
      [
        good("/a", "Same title here", description),
        good("/b", "Same title here", description),
        page(
          "/c",
          "<title>Third page title</title><link rel=canonical href=https://example.com/a>",
        ),
      ],
      { siteUrl: "https://example.com" },
    );
    const messages = findings
      .map((f: { message: string }) => f.message)
      .join("\n");
    expect(messages).toContain("share the same title");
    expect(messages).toContain("share the same description");
    expect(messages).toContain("does not point at this page");
    expect(
      findings.some(
        (f: { level: string; message: string }) =>
          f.level === "error" && f.message.includes("description"),
      ),
    ).toBe(true);
  });

  it("includes the base in the expected canonical and flags noindex pages listed in the sitemap", () => {
    const description =
      "A description that is comfortably longer than fifty characters.";
    const noindex = page(
      "/thanks",
      `<title>Thanks - Example</title><meta name=description content="${description}"><meta name=robots content=noindex><link rel=canonical href=https://example.com/sub/thanks>`,
    );
    const findings = auditPages([noindex], {
      siteUrl: "https://example.com",
      base: "/sub/",
      sitemapUrls: ["https://example.com/sub/thanks"],
    });
    const messages = findings.map((f: { message: string }) => f.message);
    expect(
      messages.some((m: string) =>
        m.includes("noindex page is listed in sitemap.xml"),
      ),
    ).toBe(true);
    expect(
      messages.some((m: string) => m.includes("does not point at this page")),
    ).toBe(false);
  });

  it("reports invalid JSON-LD and only checks the basics on error pages", () => {
    const broken = page(
      "/x",
      '<title>Broken JSON-LD page</title><script type="application/ld+json">{nope</script>',
    );
    expect(
      auditPages([broken]).some(
        (f: { level: string; message: string }) =>
          f.level === "error" && f.message.includes("JSON-LD"),
      ),
    ).toBe(true);
    const notFound = {
      ...page("/404", "<title>Not found</title>", ""),
      file: "404.html",
    };
    expect(auditPages([notFound])).toEqual([]);
  });
});

describe("check-links", () => {
  it("resolves links against the page and strips the base", () => {
    expect(
      resolveLink("/sub/about#team", "/sub/blog/", { base: "/sub/" }),
    ).toEqual({ path: "/about", fragment: "team" });
    expect(resolveLink("post/", "/sub/blog/", { base: "/sub/" })).toEqual({
      path: "/blog/post/",
      fragment: "",
    });
    expect(resolveLink("#main", "/sub/about", { base: "/sub/" })).toEqual({
      path: "/about",
      fragment: "main",
    });
    expect(resolveLink("/about", "/sub/", { base: "/sub/" })).toEqual({
      error: "outside the deployment base /sub/",
    });
  });

  it("skips external links and non-http schemes", () => {
    expect(resolveLink("https://other.example/", "/", {})).toEqual({
      skip: "external",
    });
    expect(resolveLink("mailto:a@b.c", "/", {})).toEqual({ skip: "scheme" });
    expect(
      resolveLink("https://example.com/a", "/", {
        origin: "https://example.com",
      }),
    ).toEqual({ path: "/a", fragment: "" });
  });

  it("finds the served file the way Bascik does", () => {
    const files = new Set([
      "index.html",
      "about.html",
      "blog/index.html",
      "css/styles.css",
    ]);
    const exists = (file: string) => files.has(file);
    expect(fileFor("/", exists)).toBe("index.html");
    expect(fileFor("/about", exists)).toBe("about.html");
    expect(fileFor("/blog/", exists)).toBe("blog/index.html");
    expect(fileFor("/blog", exists)).toBe("blog/index.html");
    expect(fileFor("/css/styles.css", exists)).toBe("css/styles.css");
    expect(fileFor("/missing", exists)).toBeUndefined();
  });

  it("reports missing pages and fragments, and ignores /api/ and inline scripts", () => {
    const pages = [
      {
        file: "index.html",
        html:
          '<a href="/about#team">a</a><a href="/gone">b</a><a href="#top">c</a><form action="/api/x"></form><a href="/api/contact">d</a>' +
          '<script>const s = "<a href=\'/fake\'>";</script><img srcset="/a.png 1x, /b.png 2x">',
      },
      { file: "about.html", html: '<h2 id="team">Team</h2>' },
    ];
    const files = new Set(["index.html", "about.html", "a.png"]);
    const { problems } = checkSite(pages, {
      exists: (f: string) => files.has(f),
    });
    expect(problems.map((p: { url: string }) => p.url).sort()).toEqual([
      "#top",
      "/b.png",
      "/gone",
    ]);
  });

  it("extracts every srcset candidate", () => {
    expect(
      extractLinks('<img src="/a.png" srcset="/a.png 1x, /a@2x.png 2x">').map(
        (l: { url: string }) => l.url,
      ),
    ).toEqual(["/a.png", "/a.png", "/a@2x.png"]);
  });

  it("decodes entities once and ignores links in masked elements", () => {
    const links = extractLinks(
      '<!-- <a href="/comment"> --><SCRIPT>"<a href=\'/script\'>"</SCRIPT><pre><a href="/pre">x</a></pre><a href="/a&amp;lt;b&amp;gt;">real</a>',
    );
    expect(links.map((link: { url: string }) => link.url)).toEqual([
      "/a&lt;b&gt;",
    ]);
  });

  it("never joins visible segments into a new link or scans hidden elements", () => {
    const links = extractLinks(
      '<a hr<!-- ignored -->ef="/fake"><script src="/app.js">"<a href=\'/in-script\'>"</script\t\n data-test><pre><a href="/in-pre"></pre><a href="/real">here</a>',
    );
    expect(links.map((link: { url: string }) => link.url)).toEqual([
      "/app.js",
      "/real",
    ]);
  });
});

describe("check-tokens", () => {
  it("separates undeclared tokens, fallbacks, and component :root declarations", () => {
    const { findings, unused } = analyzeTokens({
      globals: [
        {
          file: "styles.css",
          css: ":root { --color-text: #000; --unused: 1px; }",
        },
      ],
      components: [
        {
          file: "card.html",
          css: ".card { color: var(--color-text); border: var(--color-border, red); margin: var(--gap); }",
        },
        {
          file: "bad.html",
          css: ":root { --brand: blue; } .x { color: var(--brand); }",
        },
      ],
    });
    const byToken = Object.fromEntries(
      findings.map((f: { token: string; level: string }) => [
        `${f.level}:${f.token}`,
        true,
      ]),
    );
    expect(byToken["info:--color-border"]).toBe(true);
    expect(byToken["error:--gap"]).toBe(true);
    expect(byToken["warn:--brand"]).toBe(true);
    expect(byToken["error:--brand"]).toBeUndefined();
    expect(unused).toEqual(["--unused"]);
  });
});

describe("new-post and posts.ts", () => {
  it("slugifies titles into URL-safe names", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("Crème brûlée & tea")).toBe("creme-brulee-and-tea");
    expect(slugify("  --  ")).toBe("");
  });

  it("writes front matter that posts.ts accepts, including titles with colons and quotes", () => {
    const source = postSource({
      title: 'Release: "v2" is out',
      description: "What changed: everything.",
      date: "2026-03-01",
      tags: ["news", "release"],
      draft: true,
    });
    const post = toPost("release-v2", source);
    expect(post).toMatchObject({
      title: 'Release: "v2" is out',
      description: "What changed: everything.",
      date: "2026-03-01",
      tags: ["news", "release"],
      draft: true,
    });
    expect(post.html).toContain("<p>Write the post here.</p>");
  });

  it("parses inline lists, dash lists, booleans, numbers, and quoted strings", () => {
    const { data, body } = parseFrontMatter(
      "---\ntitle: 'It''s here'\ntags:\n  - a\n  - b\norder: 3\ndraft: false\n---\nBody",
    );
    expect(data).toEqual({
      title: "It's here",
      tags: ["a", "b"],
      order: 3,
      draft: false,
    });
    expect(body).toBe("Body");
  });

  it("rejects posts that would build broken pages", () => {
    const fm = (lines: string) => `---\n${lines}\n---\nBody`;
    expect(() =>
      toPost("Bad_Slug", fm("title: T\ndescription: D\ndate: 2026-01-01")),
    ).toThrow(/file names/);
    expect(() => toPost("ok", fm("description: D\ndate: 2026-01-01"))).toThrow(
      /title/,
    );
    expect(() =>
      toPost("ok", fm("title: T\ndescription: D\ndate: Jan 1")),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      toPost(
        "ok",
        fm("title: T\ndescription: D\ndate: 2026-01-01\ntags: [Two Words]"),
      ),
    ).toThrow(/tag/);
  });

  it("groups posts by tag and escapes HTML", () => {
    const a = toPost(
      "a",
      "---\ntitle: A\ndescription: D\ndate: 2026-01-01\ntags: [x, y]\n---\n",
    );
    const b = toPost(
      "b",
      "---\ntitle: B\ndescription: D\ndate: 2026-01-02\ntags: [x]\n---\n",
    );
    expect(
      groupByTag([b, a]).map((g: TagGroup) => [
        g.tag,
        g.posts.map((p) => p.slug),
      ]),
    ).toEqual([
      ["x", ["b", "a"]],
      ["y", ["a"]],
    ]);
    expect(escapeHtml('<a href="x">\'&')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;",
    );
  });
});

describe("site-footer links.ts", () => {
  it("escapes labels and hrefs", () => {
    expect(footerLinks([{ label: "A & B", href: '/a?x="1"' }])).toBe(
      '<ul class="links"><li><a href="/a?x=&quot;1&quot;">A &amp; B</a></li></ul>',
    );
  });
});

describe("site-header links.ts", () => {
  it("marks the current page and its section", () => {
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/", "/about")).toBe(false);
    expect(isCurrent("/blog/", "/blog/hello/")).toBe(true);
    expect(isCurrent("/blog/", "/blogroll")).toBe(false);
    const html = navLinks("/blog/hello/");
    expect(html).toContain('<a href="/blog/" aria-current="true">Blog</a>');
    expect(navLinks("/about")).toContain(
      '<a href="/about" aria-current="page">About</a>',
    );
  });
});

describe("seo.ts", () => {
  it("builds absolute canonical and Open Graph URLs from the site URL, base, and page path", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com/");
    vi.stubEnv("BASCIK_BASE", "/sub/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/about");
    const html = seo({
      title: "About <us>",
      description: 'Who "we" are.',
      image: "/og.png",
    });
    expect(html).toContain("<title>About &lt;us&gt;</title>");
    expect(html).toContain(
      '<link rel="canonical" href="https://example.com/sub/about" />',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://example.com/sub/og.png" />',
    );
    expect(html).toContain('content="Who &quot;we&quot; are."');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
  });

  it("omits the canonical without a site URL", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    const html = seo({ title: "T", description: "D" });
    expect(html).not.toContain("canonical");
    expect(absoluteUrl("/x")).toBe("/x");
  });

  it("escapes < in JSON-LD so data cannot close the script tag", () => {
    expect(
      jsonLd({ name: "</script><script>alert(1)</script>" }),
    ).not.toContain("</script><script>");
  });
});

describe("contact.ts", () => {
  const valid = {
    name: "Ada",
    email: "ada@example.com",
    message: "Hello there, this is long enough.",
  };

  it("validates and trims input", () => {
    expect(validateContact({ ...valid, name: "  Ada  " })).toEqual({
      ok: true,
      value: valid,
    });
    const result = validateContact({ email: "nope", message: "short" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toEqual([
        "name is required",
        "email is not valid",
        "message is too short",
      ]);
  });

  it("answers JSON with 201 or 422, and rejects bodies that are not objects", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const json = (body: unknown) =>
      new Request("http://site.test/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await POST(json(valid))).status).toBe(201);
    const invalid = await POST(json({ ...valid, email: "x" }));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ errors: ["email is not valid"] });
    expect((await POST(json(null))).status).toBe(400);
    expect((await POST(json(["a"]))).status).toBe(400);
  });

  it("redirects a no-JavaScript form post back to the page with ?sent=1", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await POST(
      new Request("http://site.test/api/contact", {
        method: "POST",
        headers: { referer: "http://site.test/contact" },
        body: new URLSearchParams(valid),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://site.test/contact?sent=1",
    );
  });
});
