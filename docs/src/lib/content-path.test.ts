import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCS_DIR,
  pageContentFile,
  pageRoute,
  readRouteMarkdown,
  routeContentCandidates,
  routeContentFile,
} from "./content-path.ts";
import { NAV } from "./nav.ts";
import { isExternalNavPage } from "./nav-helpers.ts";

describe("routeContentCandidates", () => {
  it("tries content/<route>.md, then content/<route>/index.md", () => {
    expect(routeContentCandidates("/deployment")).toEqual([
      "content/deployment.md",
      "content/deployment/index.md",
    ]);
    expect(routeContentCandidates("/testing/build-scripts")).toEqual([
      "content/testing/build-scripts.md",
      "content/testing/build-scripts/index.md",
    ]);
  });

  it("maps the home route to content/index.md", () => {
    expect(routeContentCandidates("/")).toEqual(["content/index.md"]);
    expect(routeContentCandidates("")).toEqual(["content/index.md"]);
  });

  it("ignores a trailing slash, a query, and a fragment", () => {
    expect(routeContentCandidates("/deployment/")).toEqual(
      routeContentCandidates("/deployment"),
    );
    expect(routeContentCandidates("/slots#named-slots")).toEqual(
      routeContentCandidates("/slots"),
    );
    expect(routeContentCandidates("/slots?x=1")).toEqual(
      routeContentCandidates("/slots"),
    );
  });

  // The old basename fallback read content/<last segment>.md, so a /testing/x page with no file of its own
  // indexed content/x.md, a different page, without a word.
  it("never falls back to another page's file by its last path segment", () => {
    expect(routeContentCandidates("/testing/slots")).not.toContain(
      "content/slots.md",
    );
  });

  it("refuses a route that climbs out of the content folder", () => {
    expect(routeContentCandidates("/../package")).toEqual([]);
    expect(routeContentCandidates("/a/../../b")).toEqual([]);
  });
});

describe("routeContentFile and readRouteMarkdown", () => {
  it("finds a page whose Markdown is an index.md in a folder of the route's name", async () => {
    expect(routeContentFile("/deployment")).toBe("content/deployment/index.md");
    const read = await readRouteMarkdown("/deployment");
    expect(read?.file).toBe("content/deployment/index.md");
    expect(read?.markdown).toMatch(/^# Deployment Overview/m);
  });

  it("prefers content/<route>.md over content/<route>/index.md when both exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-content-path-"));
    try {
      await mkdir(join(dir, "content", "both"), { recursive: true });
      await writeFile(join(dir, "content", "both.md"), "# File\n");
      await writeFile(join(dir, "content", "both", "index.md"), "# Folder\n");
      expect(routeContentFile("/both", dir)).toBe("content/both.md");
      expect((await readRouteMarkdown("/both", dir))?.markdown).toBe(
        "# File\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a route with no Markdown (a typo'd nav href)", async () => {
    expect(routeContentFile("/deploymnet")).toBeNull();
    expect(await readRouteMarkdown("/deploymnet")).toBeNull();
  });

  it("resolves a content file for every page in the sidebar", () => {
    const missing = NAV.flatMap((section) => section.pages)
      .filter((page) => !isExternalNavPage(page))
      .filter((page) => routeContentFile(page.href) === null)
      .map((page) => page.href);
    expect(missing).toEqual([]);
  });
});

describe("pageContentFile", () => {
  it("finds content/deployment/index.md for src/pages/deployment.html", () => {
    expect(
      pageContentFile(join(DOCS_DIR, "src", "pages", "deployment.html")),
    ).toBe(join(DOCS_DIR, "content", "deployment", "index.md"));
    expect(pageContentFile(join(DOCS_DIR, "src", "pages", "slots.html"))).toBe(
      join(DOCS_DIR, "content", "slots.md"),
    );
  });

  it("returns null for a page with no Markdown or a file that is not a page", () => {
    expect(
      pageContentFile(join(DOCS_DIR, "src", "pages", "no-such-page.html")),
    ).toBeNull();
    expect(pageContentFile(undefined)).toBeNull();
    expect(pageContentFile(join(DOCS_DIR, "src", "lib", "nav.ts"))).toBeNull();
  });
});

describe("pageRoute", () => {
  it("maps a page source file to its route, whatever the path separators", () => {
    const pages = join(DOCS_DIR, "src", "pages");
    expect(pageRoute(join(pages, "deployment.html"))).toBe("/deployment");
    expect(pageRoute(join(pages, "testing", "build-scripts.html"))).toBe(
      "/testing/build-scripts",
    );
    expect(pageRoute(join(pages, "index.html"))).toBe("/");
    expect(pageRoute(join(pages, "switch", "index.html"))).toBe("/switch");
    expect(pageRoute("C:\\site\\docs\\src\\pages\\how-to\\markdown.html")).toBe(
      "/how-to/markdown",
    );
    expect(pageRoute("src/pages/slots.html")).toBe("/slots");
    expect(pageRoute("/home/pages/site/src/pages/slots.html")).toBe("/slots");
  });

  it("returns null for a file outside a pages folder or with no page file at all", () => {
    expect(pageRoute(undefined)).toBeNull();
    expect(pageRoute("")).toBeNull();
    expect(pageRoute("/abs/src/components/docs-sidebar/x.ts")).toBeNull();
  });

  it("gives the sidebar the Markdown the page shell renders, for every page with a sidebar", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const pagesDir = join(DOCS_DIR, "src", "pages");
    const shells = (await readdir(pagesDir, { recursive: true }))
      .filter((file) => file.endsWith(".html"))
      .map((file) => join(pagesDir, file));
    const wrong: string[] = [];
    for (const shell of shells) {
      const html = await readFile(shell, "utf8");
      if (!html.includes("<docs-sidebar")) continue;
      const rendered = [...html.matchAll(/["']\.\/(content\/[^"']+\.md)["']/g)];
      if (!rendered.length) continue;
      const file = pageContentFile(shell);
      if (!file || !existsSync(file)) wrong.push(shell);
      else if (!rendered.some((match) => join(DOCS_DIR, match[1]) === file))
        wrong.push(`${shell} -> ${file}`);
    }
    expect(wrong).toEqual([]);
  });
});
