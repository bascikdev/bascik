/**
 * Prompt 133: pure planning pieces of the serverless artifact emitter.
 * The real build + bundle path is covered by `serverless-build.integration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  splitDistPageIntoSegments,
  pageAliasesFor,
  isPublicAssetPath,
  buildInvocationRoutes,
  detectPublicCollisions,
  formatUnsupportedImport,
  CLOUDFLARE_COMPATIBILITY_DATE,
  PAGES_ROUTES_LIMIT,
  WORKERS_SUPPORTED_NODE_BUILTINS,
  classifyNodeBuiltin,
} from "./serverless-artifacts.ts";

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

describe("buildInvocationRoutes", () => {
  it("includes the API prefix and every dynamic page alias, sorted and deduplicated", () => {
    const routes = buildInvocationRoutes({
      base: "/",
      dynamicPagePaths: ["/", "/account"],
      hasApiRoutes: true,
    });
    expect(routes.include).toEqual(["/", "/_routes.json", "/_worker.js", "/account", "/account.html", "/account/", "/api/*", "/index", "/index.html"]);
    expect(routes.exclude).toEqual([]);
    expect(routes.overflowed).toBe(false);
  });

  it("omits the API prefix when there are no API routes", () => {
    const routes = buildInvocationRoutes({ base: "/", dynamicPagePaths: ["/x"], hasApiRoutes: false });
    expect(routes.include).not.toContain("/api/*");
  });

  it("always routes the generated control files to the worker so they can never be downloaded", () => {
    const routes = buildInvocationRoutes({ base: "/docs/", dynamicPagePaths: [], hasApiRoutes: false });
    expect(routes.include).toEqual(["/docs/_routes.json", "/docs/_worker.js"]);
  });

  it("falls back to invoking every path when the platform rule limit would be exceeded", () => {
    const dynamicPagePaths = Array.from({ length: PAGES_ROUTES_LIMIT }, (_, i) => `/p${i}`);
    const routes = buildInvocationRoutes({ base: "/", dynamicPagePaths, hasApiRoutes: true });
    expect(routes.overflowed).toBe(true);
    expect(routes.include).toEqual(["/*"]);
  });
});

describe("detectPublicCollisions", () => {
  it("rejects authored files that would shadow generated control files", () => {
    const problems = detectPublicCollisions({
      publicPaths: ["_worker.js", "img/a.png", "_routes.json"],
      apiRoutePaths: [],
      target: "cloudflare-pages",
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
      target: "cloudflare-workers",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/api/health");
  });
});

describe("node builtin policy for the pinned Cloudflare target", () => {
  it("pins a compatibility date the local runtime harness supports", () => {
    expect(CLOUDFLARE_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("classifies supported builtins as runtime-provided and others as unsupported", () => {
    expect(classifyNodeBuiltin("node:crypto")).toBe("provided");
    expect(classifyNodeBuiltin("crypto")).toBe("provided");
    expect(classifyNodeBuiltin("node:child_process")).toBe("unsupported");
    expect(classifyNodeBuiltin("node:worker_threads")).toBe("unsupported");
    expect(classifyNodeBuiltin("marked")).toBe("not-builtin");
    expect(WORKERS_SUPPORTED_NODE_BUILTINS.has("buffer")).toBe(true);
  });

  it("formats an unsupported import as an authored import-chain diagnostic", () => {
    const message = formatUnsupportedImport({
      specifier: "node:child_process",
      importer: "/proj/src/lib/exec.ts",
      projectRoot: "/proj",
      owners: ["API route /api/run", "server script in src/pages/x.html:12"],
    });
    expect(message).toContain('"node:child_process"');
    expect(message).toContain("src/lib/exec.ts");
    expect(message).toContain("API route /api/run");
    expect(message).toContain("src/pages/x.html:12");
    expect(message).not.toContain("/proj/");
  });
});
