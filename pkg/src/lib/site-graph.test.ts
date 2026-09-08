import { describe, it, expect } from "vitest";
import {
  splitDistPageIntoSegments,
  pageAliasesFor,
  isPublicAssetPath,
  detectPublicCollisions,
  readSiteGraph,
} from "./site-graph.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { SIDECAR_SCHEMA_VERSION } from "./server-sidecar.ts";

describe("splitDistPageIntoSegments", () => {
  it("splits placeholder HTML into static text and script ids in document order", () => {
    const html =
      `<p>a</p><script type="text/bascik-server" data-bascik-server-id="s1"></script><p>b</p>` +
      `<script type="text/bascik-server" data-bascik-server-id="s2" data-bascik-stream></script><p>c</p>`;
    const result = splitDistPageIntoSegments(html);
    expect(result.segments).toEqual([
      { kind: "static", text: "<p>a</p>" },
      { kind: "script", id: "s1" },
      { kind: "static", text: "<p>b</p>" },
      { kind: "script", id: "s2" },
      { kind: "static", text: "<p>c</p>" },
    ]);
    expect(result.scriptIds).toEqual(["s1", "s2"]);
  });

  it("returns a single static segment and no ids for a plain page", () => {
    const result = splitDistPageIntoSegments("<p>static</p>");
    expect(result.scriptIds).toEqual([]);
    expect(result.segments).toEqual([{ kind: "static", text: "<p>static</p>" }]);
  });

  it("preserves multi-byte text exactly", () => {
    const html = `日本 🚀<script type="text/bascik-server" data-bascik-server-id="x"></script>ünï`;
    const { segments } = splitDistPageIntoSegments(html);
    expect(segments[0]).toEqual({ kind: "static", text: "日本 🚀" });
    expect(segments[2]).toEqual({ kind: "static", text: "ünï" });
  });
});

describe("pageAliasesFor", () => {
  it("lists every request spelling the Node server accepts for a page", () => {
    expect(pageAliasesFor("/", "/")).toEqual(["/", "/index", "/index.html"]);
    expect(pageAliasesFor("/about", "/")).toEqual(["/about", "/about/", "/about.html"]);
    expect(pageAliasesFor("/blog/", "/")).toEqual(["/blog/", "/blog", "/blog/index", "/blog/index.html"]);
  });

  it("prefixes the base path", () => {
    expect(pageAliasesFor("/about", "/docs/")).toEqual(["/docs/about", "/docs/about/", "/docs/about.html"]);
    expect(pageAliasesFor("/", "/docs/")).toEqual(["/docs/", "/docs", "/docs/index", "/docs/index.html"]);
  });
});

describe("isPublicAssetPath", () => {
  it.each([
    [".bascik/manifest.json", false],
    [".bascik/server-scripts.json", false],
    ["assets/app.js.map", false],
    ["style.css.br", false],
    ["style.css.gz", false],
    ["style.css.br.bmeta", false],
    [".hidden", false],
    ["dir/.env", false],
    ["style.css", true],
    ["img/logo.png", true],
    ["about.html", true],
    ["_headers", true],
    ["_redirects", true],
  ])("%s -> public %s", (path, expected) => {
    expect(isPublicAssetPath(path)).toBe(expected);
  });
});

describe("detectPublicCollisions", () => {
  it("rejects authored files that would shadow control files supplied by adapter", () => {
    const problems = detectPublicCollisions({
      publicPaths: ["_worker.js", "img/a.png", "_routes.json"],
      apiRoutePaths: [],
      controlFiles: ["_worker.js", "_routes.json"],
    });
    expect(problems).toEqual([
      expect.stringContaining("_routes.json"),
      expect.stringContaining("_worker.js"),
    ]);
  });

  it("rejects a static API route path that a public file also occupies", () => {
    const problems = detectPublicCollisions({
      publicPaths: ["api/health"],
      apiRoutePaths: ["/api/health", "/api/users/[id]"],
      controlFiles: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/api/health");
  });
});

describe("readSiteGraph", () => {
  it("reads dist/ and sidecar, builds host-neutral SiteGraph", async () => {
    const testDir = join(tmpdir(), `bascik-site-graph-test-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const bascikHiddenDir = join(distDir, ".bascik");
    const srcApiDir = join(testDir, "src/api");
    await mkdir(bascikHiddenDir, { recursive: true });
    await mkdir(srcApiDir, { recursive: true });

    // 1. static page
    await writeFile(join(distDir, "index.html"), "<h1>Home</h1>", "utf8");
    // 2. custom 404
    await writeFile(join(distDir, "404.html"), "<h1>Not Found</h1>", "utf8");
    // 3. custom 500
    await writeFile(join(distDir, "500.html"), "<h1>Server Error</h1>", "utf8");
    // 4. dynamic page with inline and src= script jobs
    await writeFile(
      join(distDir, "dynamic.html"),
      `<p>Hi</p><script type="text/bascik-server" data-bascik-server-id="job-inline"></script>` +
      `<p>Stream</p><script type="text/bascik-server" data-bascik-server-id="job-src" data-bascik-stream></script>`,
      "utf8",
    );
    // sidecar
    const sidecar = {
      schema: SIDECAR_SCHEMA_VERSION,
      scripts: {
        "job-inline": {
          mode: "server",
          source: 'console.log("inline");',
          sourceFile: "src/pages/dynamic.html",
          sourceLine: 2,
        },
        "job-src": {
          mode: "stream",
          modulePath: "./helper.ts",
          sourceFile: "src/pages/dynamic.html",
          sourceLine: 4,
        },
      },
    };
    await writeFile(join(bascikHiddenDir, "server-scripts.json"), JSON.stringify(sidecar), "utf8");

    // helper file for src=
    await mkdir(join(testDir, "src/pages"), { recursive: true });
    await writeFile(join(testDir, "src/pages/helper.ts"), "export default () => 'streamed';", "utf8");

    // static asset
    await mkdir(join(distDir, "css"), { recursive: true });
    await writeFile(join(distDir, "css/main.css"), "body { color: red; }", "utf8");

    // API route
    await writeFile(join(srcApiDir, "hello.ts"), "export const GET = () => new Response('world');", "utf8");

    try {
      const graph = await readSiteGraph({
        projectRoot: testDir,
        distDir,
        version: "1.0.0",
        base: "/",
      });

      expect(graph.publicFiles).toContain("index.html");
      expect(graph.publicFiles).toContain("404.html");
      expect(graph.publicFiles).toContain("css/main.css");
      // dynamic.html has server scripts so it must NEVER be listed as public
      expect(graph.publicFiles).not.toContain("dynamic.html");

      expect(graph.custom500).toBe("<h1>Server Error</h1>");
      expect(graph.pages["/dynamic"]).toBeDefined();
      expect(graph.pages["/dynamic"].jobs["job-inline"]).toBeDefined();
      expect(graph.pages["/dynamic"].jobs["job-inline"].source.kind).toBe("inline");
      expect(graph.pages["/dynamic"].jobs["job-src"]).toBeDefined();
      expect(graph.pages["/dynamic"].jobs["job-src"].source.kind).toBe("module");

      expect(graph.apiRoutes).toHaveLength(1);
      expect(graph.apiRoutes[0].path).toBe("/api/hello");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
