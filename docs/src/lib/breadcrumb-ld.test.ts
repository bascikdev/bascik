import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breadcrumbLd, SECTIONS_WITH_PAGE } from "./breadcrumb-ld.js";
import { NAV } from "./nav.js";

/** The JSON between the opening `<script ...>` tag and the closing tag. */
const jsonLdBody = (html: string): string =>
  html.slice(html.indexOf(">") + 1, html.lastIndexOf("</"));

describe("breadcrumbLd", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "breadcrumb-ld-test-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty string if env vars are missing", async () => {
    delete process.env.BASCIK_SITE_URL;
    delete process.env.BASCIK_PAGE_FILE;
    delete process.env.BASCIK_PAGES_DIR;

    const result = await breadcrumbLd();
    expect(result).toBe("");
  });

  it("returns empty string for top-level pages (less than 2 path segments)", async () => {
    const pageFile = join(tempDir, "index.html");
    await writeFile(
      pageFile,
      "<html><head><title>Home</title></head><body></body></html>",
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const result = await breadcrumbLd();
    expect(result).toBe("");
  });

  it("generates breadcrumbs for nested section pages (e.g. how-to/server-scripts)", async () => {
    const sectionDir = join(tempDir, "how-to");
    const pageFile = join(sectionDir, "server-scripts.html");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sectionDir, { recursive: true });
    await writeFile(
      pageFile,
      "<html><head><title>Server Scripts - Bascik Docs</title></head><body></body></html>",
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const result = await breadcrumbLd();
    expect(result).toContain('"@type": "BreadcrumbList"');
    expect(result).toContain('"name": "Bascik"');
    expect(result).toContain('"name": "Server Scripts"');
    const parsed = JSON.parse(jsonLdBody(result));
    expect(parsed.itemListElement).toHaveLength(2);
    expect(parsed.itemListElement[0].name).toBe("Bascik");
    expect(parsed.itemListElement[1].name).toBe("Server Scripts");
  });

  it("includes section index link for SECTIONS_WITH_PAGE (e.g. internals/architecture)", async () => {
    const sectionDir = join(tempDir, "internals");
    const pageFile = join(sectionDir, "architecture.html");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sectionDir, { recursive: true });
    await writeFile(
      pageFile,
      "<html><head><title>Architecture - Bascik Docs</title></head><body></body></html>",
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const result = await breadcrumbLd();
    const parsed = JSON.parse(jsonLdBody(result));
    expect(parsed.itemListElement).toHaveLength(3);
    expect(parsed.itemListElement[0].name).toBe("Bascik");
    expect(parsed.itemListElement[1].name).toBe("Internals");
    expect(parsed.itemListElement[1].item).toBe("https://bascik.dev/internals");
    expect(parsed.itemListElement[2].name).toBe("Architecture");
  });

  it("links the Lighthouse overview page as the parent of /lighthouse/* pages", async () => {
    const sectionDir = join(tempDir, "lighthouse");
    const pageFile = join(sectionDir, "seo.html");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sectionDir, { recursive: true });
    await writeFile(
      pageFile,
      "<html><head><title>Lighthouse SEO 100 - Bascik</title></head><body></body></html>",
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const parsed = JSON.parse(jsonLdBody(await breadcrumbLd()));
    expect(
      parsed.itemListElement.map((item: { name: string }) => item.name),
    ).toEqual(["Bascik", "Lighthouse 100s", "SEO"]);
    expect(parsed.itemListElement[1].item).toBe(
      "https://bascik.dev/lighthouse",
    );
  });

  it("marks every nested section that has an index page in the nav as a breadcrumb parent", () => {
    const nestedSections = new Set(
      NAV.flatMap((sec) => sec.pages)
        .filter((page) => !page.external && page.href.split("/").length > 2)
        .map((page) => page.href.split("/")[1]),
    );
    const navHrefs = new Set(
      NAV.flatMap((sec) => sec.pages).map((page) => page.href),
    );
    const withIndexPage = [...nestedSections].filter((section) =>
      navHrefs.has(`/${section}`),
    );
    expect(withIndexPage.sort()).toEqual([...SECTIONS_WITH_PAGE].sort());
  });

  it("uses the short sidebar label, not the keyword-rich <title>, for pages in the nav", async () => {
    const sectionDir = join(tempDir, "switch");
    const pageFile = join(sectionDir, "from-react.html");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sectionDir, { recursive: true });
    await writeFile(
      pageFile,
      "<html><head><title>Migrate from React to Bascik</title></head><body></body></html>",
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const parsed = JSON.parse(jsonLdBody(await breadcrumbLd()));
    expect(parsed.itemListElement.at(-1).name).toBe("From React");
  });
});
