// Unit tests for skills/bascik-refactor/scripts/llms-txt.mjs: a post-phase exec script that writes dist/llms.txt from
// the built pages. It reads BASCIK_OUT_DIR, BASCIK_PAGES_DIR, BASCIK_BASE and (only when set) BASCIK_SITE_URL, skips
// 404/500 and noindex pages, prefers <link rel=canonical>, groups by first path segment, and never overwrites an
// authored src/pages/llms.txt. Fixtures are strings and temp dirs; no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  optionsFromEnv,
  pageEntry,
  renderLlmsTxt,
  writeLlmsTxt,
} from "../../skills/bascik-refactor/scripts/llms-txt.mjs";

afterEach(() => vi.unstubAllEnvs());

const page = (head: string, body = "<h1>x</h1>") =>
  `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

describe("pageEntry", () => {
  it("reads title and description, decoding entities", () => {
    const entry = pageEntry(
      page(
        '<title>Plans &amp; Pricing</title><meta name="description" content="Compare plans &quot;fast&quot;.">',
      ),
      "pricing.html",
      {},
    );
    expect(entry).toMatchObject({
      path: "/pricing",
      url: "/pricing",
      title: "Plans & Pricing",
      description: 'Compare plans "fast".',
      group: "Pages",
    });
  });

  it("decodes references as the browser does, and survives an out-of-range one (R2-05)", () => {
    const entry = pageEntry(
      page(
        '<title>Cr&egrave;me &Eacute;clair &#150; &#x110000;</title><meta name="description" content="&Lt;3 &AMP; &nbsp;more">',
      ),
      "creme.html",
      {},
    );
    expect(entry).toMatchObject({
      // &#150; is an en dash (windows-1252), past U+10FFFF is U+FFFD, and
      // names are case-sensitive: &Lt; is no name this table holds.
      title: "Cr\u00e8me \u00c9clair \u2013 \ufffd",
      description: "&Lt;3 & more",
    });
  });

  it("reads both <meta> and <link> tags, in any case, from one page", () => {
    const entry = pageEntry(
      page(
        '<title>Press</title><META NAME="description" content="News.">' +
          '<LINK rel="canonical" href="https://example.com/press/"><link rel=stylesheet href=/a.css>',
      ),
      "press/index.html",
      {},
    );
    expect(entry).toMatchObject({
      description: "News.",
      url: "https://example.com/press/",
    });
  });

  it("reads minified HTML with unquoted attributes", () => {
    const entry = pageEntry(
      "<!doctype html><html lang=en><head><title>Contact</title><meta name=description content=Reach-us></head></html>",
      "contact/index.html",
      {},
    );
    expect(entry).toMatchObject({
      path: "/contact/",
      title: "Contact",
      description: "Reach-us",
      group: "Contact",
    });
  });

  it("maps dist paths to URLs: index, nested index, and nested page", () => {
    const head = page("<title>T</title>");
    expect(pageEntry(head, "index.html", {}).path).toBe("/");
    expect(pageEntry(head, "press/index.html", {}).path).toBe("/press/");
    expect(pageEntry(head, "press/launch-week.html", {})).toMatchObject({
      path: "/press/launch-week",
      group: "Press",
    });
  });

  it("prefers the canonical URL over the path-derived one", () => {
    const entry = pageEntry(
      page(
        '<title>Home</title><link rel="canonical" href="https://www.example.com/">',
      ),
      "index.html",
      { siteUrl: "https://staging.example.com" },
    );
    expect(entry.url).toBe("https://www.example.com/");
  });

  it("reads an unquoted canonical in minified output", () => {
    const entry = pageEntry(
      "<html><head><title>Press</title><link rel=canonical href=https://www.example.com/press/></head></html>",
      "press/index.html",
      {},
    );
    expect(entry.url).toBe("https://www.example.com/press/");
  });

  it("joins BASCIK_SITE_URL and BASCIK_BASE when there is no canonical", () => {
    const head = page("<title>Pricing</title>");
    expect(
      pageEntry(head, "pricing.html", {
        siteUrl: "https://www.example.com/",
        base: "/docs/",
      }).url,
    ).toBe("https://www.example.com/docs/pricing");
    expect(pageEntry(head, "pricing.html", { base: "/docs/" }).url).toBe(
      "/docs/pricing",
    );
    expect(pageEntry(head, "pricing.html", { base: "/" }).url).toBe("/pricing");
  });

  it("skips noindex pages, quoted or not", () => {
    expect(
      pageEntry(
        page(
          '<title>Thanks</title><meta name="robots" content="noindex, follow">',
        ),
        "thanks.html",
        {},
      ),
    ).toBeNull();
    expect(
      pageEntry(
        "<html><head><title>Thanks</title><meta name=robots content=noindex></head></html>",
        "thanks.html",
        {},
      ),
    ).toBeNull();
  });

  it("skips 404.html, 500.html and pages without a title", () => {
    const head = page("<title>Not found</title>");
    expect(pageEntry(head, "404.html", {})).toBeNull();
    expect(pageEntry(head, "500.html", {})).toBeNull();
    expect(pageEntry(page(""), "untitled.html", {})).toBeNull();
  });
});

describe("renderLlmsTxt", () => {
  const entries = [
    {
      path: "/press/launch-week",
      url: "/press/launch-week",
      title: "Launch week",
      description: "",
      group: "Press",
    },
    {
      path: "/",
      url: "/",
      title: "Example Site",
      description: "Plans for every team.",
      group: "Pages",
    },
    {
      path: "/contact",
      url: "/contact",
      title: "Contact",
      description: "Reach us.",
      group: "Pages",
    },
    {
      path: "/press/",
      url: "/press/",
      title: "Press",
      description: "News and coverage.",
      group: "Press",
    },
  ];

  it("starts with the home page title as H1 and its description as the summary", () => {
    const text = renderLlmsTxt(entries);
    expect(
      text.startsWith("# Example Site\n\n> Plans for every team.\n\n"),
    ).toBe(true);
  });

  it("groups by section, Pages first, home first, then sorted by path", () => {
    expect(renderLlmsTxt(entries)).toBe(
      [
        "# Example Site",
        "",
        "> Plans for every team.",
        "",
        "## Pages",
        "",
        "- [Example Site](/): Plans for every team.",
        "- [Contact](/contact): Reach us.",
        "",
        "## Press",
        "",
        "- [Press](/press/): News and coverage.",
        "- [Launch week](/press/launch-week)",
        "",
      ].join("\n"),
    );
  });

  // A title is author text and a canonical href is author markup: either can hold Markdown link syntax, and an
  // unescaped one cuts the link short so the list item points at the wrong place or reads as broken text.
  it("misuse: brackets and backslashes in a title stay inside the link text", () => {
    const line = renderLlmsTxt([
      {
        path: "/",
        url: "/",
        title: String.raw`C:\[draft] notes\ end\]`,
        description: "",
        group: "Pages",
      },
    ]).split("\n")[4];
    expect(line).toBe(String.raw`- [C:\\\[draft\] notes\\ end\\\]](/)`);
  });

  it("misuse: parentheses and spaces in a URL stay inside the link destination", () => {
    const line = renderLlmsTxt([
      {
        path: "/",
        url: "https://example.com/a (b)/c",
        title: "Home",
        description: "",
        group: "Pages",
      },
    ]).split("\n")[4];
    expect(line).toBe("- [Home](https://example.com/a%20%28b%29/c)");
  });

  it("without a home page the H1 falls back to a generic name", () => {
    expect(renderLlmsTxt(entries.slice(2)).split("\n")[0]).toBe("# Site");
  });
});

describe("writeLlmsTxt and the exec environment", () => {
  const site = () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-llms-"));
    const write = (rel: string, text: string) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    };
    write("dist/index.html", page("<title>Example Site</title>"));
    write("dist/contact.html", page("<title>Contact</title>"));
    write("dist/404.html", page("<title>Not found</title>"));
    write("dist/.bascik/manifest.html", page("<title>Internal</title>"));
    write(
      "dist/thanks.html",
      page('<title>Thanks</title><meta name="robots" content="noindex">'),
    );
    return { root, write };
  };

  it("crawls dist, skipping dot directories, error and noindex pages", () => {
    const { root } = site();
    try {
      const result = writeLlmsTxt({
        outDir: join(root, "dist"),
        pagesDir: join(root, "src/pages"),
        base: "/",
      });
      expect(result).toMatchObject({ written: true, count: 2 });
      const text = readFileSync(join(root, "dist/llms.txt"), "utf8");
      expect(text).toContain("- [Contact](/contact)");
      expect(text).not.toMatch(/Internal|Not found|Thanks/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves an authored src/pages/llms.txt alone", () => {
    const { root, write } = site();
    try {
      write("src/pages/llms.txt", "# Authored\n");
      write("dist/llms.txt", "# Authored\n");
      const result = writeLlmsTxt({
        outDir: join(root, "dist"),
        pagesDir: join(root, "src/pages"),
        base: "/",
      });
      expect(result.written).toBe(false);
      expect(result.reason).toMatch(/src\/pages\/llms\.txt|authored/i);
      expect(readFileSync(join(root, "dist/llms.txt"), "utf8")).toBe(
        "# Authored\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads Bascik's exec variables; BASCIK_SITE_URL is optional", () => {
    vi.stubEnv("BASCIK_OUT_DIR", "/p/dist");
    vi.stubEnv("BASCIK_PAGES_DIR", "/p/src/pages");
    vi.stubEnv("BASCIK_BASE", "/docs/");
    vi.stubEnv("BASCIK_SITE_URL", undefined as unknown as string);
    expect(optionsFromEnv()).toEqual({
      outDir: "/p/dist",
      pagesDir: "/p/src/pages",
      base: "/docs/",
      siteUrl: undefined,
    });
    vi.stubEnv("BASCIK_SITE_URL", "https://www.example.com");
    expect(optionsFromEnv().siteUrl).toBe("https://www.example.com");
  });

  it("misuse: run outside a Bascik pipeline, a missing output directory is named", () => {
    expect(() =>
      writeLlmsTxt({
        outDir: "/nonexistent/dist",
        pagesDir: "/nonexistent/src/pages",
        base: "/",
      }),
    ).toThrow(/\/nonexistent\/dist/);
    expect(existsSync("/nonexistent/dist/llms.txt")).toBe(false);
  });
});

describe("copying the script into a project", () => {
  it("imports only node: built-ins, so scripts/llms-txt.mjs works on its own", () => {
    const src = readFileSync(
      new URL(
        "../../skills/bascik-refactor/scripts/llms-txt.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    for (const m of src.matchAll(/^\s*import\s[^;]*from\s+["']([^"']+)["']/gm))
      expect(m[1], m[0]).toMatch(/^node:/);
    // The header shows the copied path, not a skills folder that a reinstall can change.
    expect(src).toMatch(/script: "scripts\/llms-txt\.mjs"/);
  });
});
