import { describe, it, expect } from "vitest";
import {
  buildInvocationRoutes,
  detectControlCollisions,
} from "./build.ts";
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  classifyNodeBuiltin,
  formatUnsupportedImport,
  WORKERS_SUPPORTED_NODE_BUILTINS,
} from "./compat.ts";

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
});

describe("detectControlCollisions", () => {
  it("rejects authored files that would shadow generated control files", () => {
    const problems = detectControlCollisions(["_worker.js", "img/a.png", "_routes.json"], "pages");
    expect(problems).toEqual([
      expect.stringContaining("_routes.json"),
      expect.stringContaining("_worker.js"),
    ]);
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
