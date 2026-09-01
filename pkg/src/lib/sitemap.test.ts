import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pagePathToUrlPath, buildSitemapXml, buildRobotsTxt, escapeXml, is404Page, generateSitemapFiles } from "./sitemap.ts";
import { listPages } from "./file-system.ts";
import { writeFile } from "node:fs/promises";
import { BascikConfig } from "./config.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./config.js", () => ({
  BascikConfig: {
    generate: { sitemap: true, robots: true },
    directory: { pages: "/project/src/pages", components: "/project/src/components", out: "dist" },
    isBuild: true,
  },
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => { }),
}));

vi.mock("./file-system.js", () => ({
  listPages: vi.fn(async () => []),
  getRelativePath: vi.fn((p: string) => `pages/${p.split("/").pop()}`),
}));

// ─────────────────────────────────────────────────────────────────────────────

let savedSiteUrl: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedSiteUrl = process.env.BASCIK_SITE_URL;
  process.env.BASCIK_SITE_URL = "https://example.com";
});

afterEach(() => {
  if (savedSiteUrl === undefined) {
    delete process.env.BASCIK_SITE_URL;
  } else {
    process.env.BASCIK_SITE_URL = savedSiteUrl;
  }
});

describe("pagePathToUrlPath", () => {
  it("maps root index.html to /", () => {
    expect(pagePathToUrlPath("pages/index.html")).toBe("/");
  });

  it("maps a top-level page to /slug", () => {
    expect(pagePathToUrlPath("pages/about.html")).toBe("/about");
  });

  it("maps a nested page to /section/slug", () => {
    expect(pagePathToUrlPath("pages/blog/post.html")).toBe("/blog/post");
  });

  it("maps a nested index to the parent path", () => {
    expect(pagePathToUrlPath("pages/blog/index.html")).toBe("/blog");
  });

  it("handles deeply nested paths", () => {
    expect(pagePathToUrlPath("pages/docs/api/reference.html")).toBe("/docs/api/reference");
  });

  it("percent-encodes non-ASCII characters in path segments", () => {
    expect(pagePathToUrlPath("pages/blog/author’s-post.html")).toBe(
      "/blog/author%E2%80%99s-post",
    );
  });
});

describe("buildSitemapXml", () => {
  it("produces valid XML sitemap structure", () => {
    const xml = buildSitemapXml("https://example.com", ["/", "/about"]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
  });

  it("handles an empty URL list", () => {
    const xml = buildSitemapXml("https://example.com", []);
    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("<url>");
  });

  it("does not double-slash when base URL has trailing slash stripped", () => {
    const xml = buildSitemapXml("https://example.com", ["/blog"]);
    expect(xml).toContain("<loc>https://example.com/blog</loc>");
    expect(xml).not.toContain("//blog");
  });

  it("strips trailing slash from base URL to prevent double slashes in sitemap", () => {
    const xml = buildSitemapXml("https://example.com/", ["/", "/about"]);
    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).not.toContain("https://example.com//");
  });

  it("XML-escapes the base URL", () => {
    const xml = buildSitemapXml("https://example.com/?a=1&b=2", ["/x"]);
    expect(xml).toContain("<loc>https://example.com/?a=1&amp;b=2/x</loc>");
    expect(xml).not.toContain("a=1&b=2");
  });

  it("XML-escapes angle brackets and quotes in the base URL", () => {
    const xml = buildSitemapXml('https://example.com/<script>"x"', ["/"]);
    expect(xml).toContain(
      "<loc>https://example.com/&lt;script&gt;&quot;x&quot;/</loc>",
    );
    expect(xml).not.toContain("<script>");
  });

  it("XML-escapes apostrophes in the base URL", () => {
    const xml = buildSitemapXml("https://example.com/it's", ["/"]);
    expect(xml).toContain("<loc>https://example.com/it&apos;s/</loc>");
  });

  it("XML-escapes URL paths", () => {
    const xml = buildSitemapXml("https://example.com", ["/a&b"]);
    expect(xml).toContain("<loc>https://example.com/a&amp;b</loc>");
  });
});

describe("escapeXml", () => {
  it("escapes all five XML metacharacters", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("escapes ampersands first so entities are not double-escaped", () => {
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves safe strings unchanged", () => {
    expect(escapeXml("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
  });
});

describe("is404Page", () => {
  it("matches pages/404.html", () => {
    expect(is404Page("pages/404.html")).toBe(true);
  });

  it("does not match a nested 404 page", () => {
    expect(is404Page("pages/blog/404.html")).toBe(false);
  });

  it("does not match a regular page", () => {
    expect(is404Page("pages/about.html")).toBe(false);
  });

  it("does not match the root index", () => {
    expect(is404Page("pages/index.html")).toBe(false);
  });
});

describe("buildRobotsTxt", () => {
  it("generates robots.txt pointing to sitemap", () => {
    const robots = buildRobotsTxt("https://example.com");
    expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("strips trailing slash from base URL in robots.txt", () => {
    const robots = buildRobotsTxt("https://example.com/");
    expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");
    expect(robots).not.toContain("//sitemap.xml");
  });
});

describe("generateSitemapFiles", () => {
  it("excludes the 404 page from sitemap.xml", async () => {
    vi.mocked(listPages).mockResolvedValue([
      "/project/src/pages/index.html",
      "/project/src/pages/about.html",
      "/project/src/pages/404.html",
    ]);
    await generateSitemapFiles();
    const sitemapCall = vi
      .mocked(writeFile)
      .mock.calls.find(([file]) => String(file).includes("sitemap.xml"));
    expect(sitemapCall).toBeDefined();
    const xml = String(sitemapCall?.[1]);
    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).not.toContain("/404");
  });

  it("includes passed transpiled routes and does not contain literal bracket placeholders", async () => {
    const transpiledPaths = [
      "pages/index.html",
      "pages/blog/first-post.html",
      "pages/blog/author’s-post.html",
    ];

    await generateSitemapFiles(transpiledPaths);

    const sitemapCall = vi
      .mocked(writeFile)
      .mock.calls.find(([file]) => String(file).includes("sitemap.xml"));
    expect(sitemapCall).toBeDefined();
    const xml = String(sitemapCall?.[1]);

    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/blog/first-post</loc>");
    expect(xml).toContain("<loc>https://example.com/blog/author%E2%80%99s-post</loc>");
    expect(xml).not.toContain("[");
    expect(xml).not.toContain("]");
  });
});

describe("buildRobotsTxt", () => {
  it("allows all user agents", () => {
    const txt = buildRobotsTxt("https://example.com");
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
  });

  it("includes the sitemap URL", () => {
    const txt = buildRobotsTxt("https://example.com");
    expect(txt).toContain("Sitemap: https://example.com/sitemap.xml");
  });
});

describe("generateSitemapFiles – early-return branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default enabled state
    (BascikConfig as Record<string, unknown>).generate = { sitemap: true, robots: true };
    vi.mocked(listPages).mockResolvedValue([]);
  });

  it("returns without writing files when both sitemap and robots are disabled", async () => {
    (BascikConfig as Record<string, unknown>).generate = { sitemap: false, robots: false };
    delete process.env.BASCIK_SITE_URL;
    await generateSitemapFiles();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fails the build with a teaching error when BASCIK_SITE_URL is not set", async () => {
    (BascikConfig as Record<string, unknown>).generate = { sitemap: true, robots: false };
    delete process.env.BASCIK_SITE_URL;
    await expect(generateSitemapFiles()).rejects.toThrow(
      /BASCIK_SITE_URL is not set, but generate\.sitemap is enabled/,
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("the teaching error shows all three ways to set the value and how to opt out", async () => {
    delete process.env.BASCIK_SITE_URL;
    await expect(generateSitemapFiles()).rejects.toThrow(
      /BASCIK_SITE_URL=https:\/\/example\.com bascik --build/,
    );
    await expect(generateSitemapFiles()).rejects.toThrow(
      /echo 'BASCIK_SITE_URL=https:\/\/example\.com' >> \.env/,
    );
    await expect(generateSitemapFiles()).rejects.toThrow(
      /bascik --build --site-url https:\/\/example\.com/,
    );
    await expect(generateSitemapFiles()).rejects.toThrow(
      /generate\.sitemap: false/,
    );
  });

  it("names every enabled feature that requires the site URL", async () => {
    delete process.env.BASCIK_SITE_URL;
    await expect(generateSitemapFiles()).rejects.toThrow(
      /generate\.sitemap and generate\.robots are enabled/,
    );
  });

  it("names generate.robots when only robots is enabled", async () => {
    (BascikConfig as Record<string, unknown>).generate = { sitemap: false, robots: true };
    delete process.env.BASCIK_SITE_URL;
    await expect(generateSitemapFiles()).rejects.toThrow(
      /BASCIK_SITE_URL is not set, but generate\.robots is enabled/,
    );
  });

  it("rejects an invalid site URL, naming the value", async () => {
    process.env.BASCIK_SITE_URL = "example.com";
    await expect(generateSitemapFiles()).rejects.toThrow(/"example\.com"/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes only robots.txt when sitemap is disabled but robots is enabled", async () => {
    (BascikConfig as Record<string, unknown>).generate = { sitemap: false, robots: true };
    await generateSitemapFiles();
    const writtenPaths = vi.mocked(writeFile).mock.calls.map(([f]) => String(f));
    expect(writtenPaths.some((p) => p.includes("sitemap.xml"))).toBe(false);
    expect(writtenPaths.some((p) => p.includes("robots.txt"))).toBe(true);
  });

  it("writes only sitemap.xml when robots is disabled but sitemap is enabled", async () => {
    (BascikConfig as Record<string, unknown>).generate = { sitemap: true, robots: false };
    await generateSitemapFiles();
    const writtenPaths = vi.mocked(writeFile).mock.calls.map(([f]) => String(f));
    expect(writtenPaths.some((p) => p.includes("sitemap.xml"))).toBe(true);
    expect(writtenPaths.some((p) => p.includes("robots.txt"))).toBe(false);
  });

  it("trims trailing slash from the site URL before writing", async () => {
    process.env.BASCIK_SITE_URL = "https://example.com/";
    (BascikConfig as Record<string, unknown>).generate = { sitemap: false, robots: true };
    await generateSitemapFiles();
    const robotsCall = vi.mocked(writeFile).mock.calls.find(([f]) =>
      String(f).includes("robots.txt")
    );
    expect(String(robotsCall?.[1])).toContain("https://example.com/sitemap.xml");
    expect(String(robotsCall?.[1])).not.toContain("https://example.com//sitemap.xml");
  });
});
