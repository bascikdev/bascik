import { describe, it, expect } from "vitest";
import {
  isDynamicRoute,
  extractRouteParamNames,
  resolveRoutePath,
  parseRouteList,
  dedupeRoutes,
} from "./routes.ts";

describe("isDynamicRoute", () => {
  it("returns true for single bracket file", () => {
    expect(isDynamicRoute("src/pages/blog/[slug].html")).toBe(true);
    expect(isDynamicRoute("[slug].html")).toBe(true);
  });

  it("returns true for directory form", () => {
    expect(isDynamicRoute("src/pages/blog/[slug]/index.html")).toBe(true);
  });

  it("returns true for multi-parameter paths", () => {
    expect(isDynamicRoute("src/pages/[category]/[slug].html")).toBe(true);
    expect(isDynamicRoute("src/pages/[a]/[b]/[c]/index.html")).toBe(true);
  });

  it("returns false for non-dynamic paths", () => {
    expect(isDynamicRoute("src/pages/index.html")).toBe(false);
    expect(isDynamicRoute("src/pages/blog/post.html")).toBe(false);
  });

  it("handles malformed brackets without crashing", () => {
    expect(isDynamicRoute("not-a-[bracket-in-name.html")).toBe(false);
    expect(isDynamicRoute("closing-bracket]-only.html")).toBe(false);
    expect(isDynamicRoute("empty-[].html")).toBe(false);
  });

  it("handles Windows backslashes", () => {
    expect(isDynamicRoute("src\\pages\\blog\\[slug].html")).toBe(true);
  });
});

describe("extractRouteParamNames", () => {
  it("extracts single param name", () => {
    expect(extractRouteParamNames("src/pages/blog/[slug].html")).toEqual(["slug"]);
  });

  it("extracts multiple param names in order", () => {
    expect(extractRouteParamNames("src/pages/[category]/[slug].html")).toEqual([
      "category",
      "slug",
    ]);
    expect(extractRouteParamNames("[a]/[b]/[c]/index.html")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for non-dynamic routes", () => {
    expect(extractRouteParamNames("src/pages/about.html")).toEqual([]);
  });

  it("handles Windows backslash paths", () => {
    expect(extractRouteParamNames("src\\pages\\[category]\\[slug].html")).toEqual([
      "category",
      "slug",
    ]);
  });
});

describe("resolveRoutePath", () => {
  it("resolves single parameter path", () => {
    expect(
      resolveRoutePath("src/pages/blog/[slug].html", { slug: "my-post" }),
    ).toBe("src/pages/blog/my-post.html");
  });

  it("resolves directory form", () => {
    expect(
      resolveRoutePath("src/pages/blog/[slug]/index.html", { slug: "first-post" }),
    ).toBe("src/pages/blog/first-post/index.html");
  });

  it("resolves multi-parameter paths", () => {
    expect(
      resolveRoutePath("src/pages/[category]/[slug].html", {
        category: "news",
        slug: "breaking",
      }),
    ).toBe("src/pages/news/breaking.html");
  });

  it("supports numeric param values", () => {
    expect(
      resolveRoutePath("src/pages/page/[n].html", { n: 1 }),
    ).toBe("src/pages/page/1.html");
  });

  it("handles Unicode param values verbatim in path", () => {
    // Unicode right single quote
    expect(
      resolveRoutePath("src/pages/blog/[slug].html", { slug: "author’s-post" }),
    ).toBe("src/pages/blog/author’s-post.html");
  });

  it("handles Windows backslashes", () => {
    expect(
      resolveRoutePath("src\\pages\\blog\\[slug].html", { slug: "hello" }),
    ).toBe("src\\pages\\blog\\hello.html");
  });

  it("handles relative, bare-filename, and absolute paths", () => {
    expect(resolveRoutePath("[slug].html", { slug: "a" })).toBe("a.html");
    expect(resolveRoutePath("pages/[slug].html", { slug: "a" })).toBe("pages/a.html");
    expect(resolveRoutePath("/abs/src/pages/[slug].html", { slug: "a" })).toBe(
      "/abs/src/pages/a.html",
    );
  });
});

describe("parseRouteList", () => {
  it("parses valid full-form route list", () => {
    const stdout = JSON.stringify([
      { params: { slug: "hello-world" }, data: { title: "Hello World" } },
      { params: { slug: "second-post" } },
    ]);
    const { routes, warnings, error } = parseRouteList(stdout, ["slug"]);
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(routes).toEqual([
      { params: { slug: "hello-world" }, data: { title: "Hello World" } },
      { params: { slug: "second-post" } },
    ]);
  });

  it("handles numeric param values", () => {
    const stdout = JSON.stringify([
      { params: { n: 1 } },
      { params: { n: 2 } },
    ]);
    const { routes, warnings, error } = parseRouteList(stdout, ["n"]);
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(routes).toEqual([
      { params: { n: 1 } },
      { params: { n: 2 } },
    ]);
  });

  it("rejects shorthand [{ slug: 'a' }] with descriptive error / warning", () => {
    const stdout = JSON.stringify([{ slug: "a" }]);
    const { routes, warnings } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/missing required "params"/i);
  });

  it("returns error on invalid JSON", () => {
    const stdout = "Not JSON at all!";
    const { routes, error } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([]);
    expect(error).toMatch(/Invalid JSON/i);
    expect(error).toContain("Not JSON at all!");
  });

  it("returns error when JSON is not an array", () => {
    const stdout = JSON.stringify({ params: { slug: "a" } });
    const { routes, error } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([]);
    expect(error).toMatch(/must be an array/i);
  });

  it("returns empty routes with no warnings for empty array", () => {
    const stdout = JSON.stringify([]);
    const { routes, warnings, error } = parseRouteList(stdout, ["slug"]);
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(routes).toEqual([]);
  });

  it("warns and skips item missing required params key", () => {
    const stdout = JSON.stringify([
      { params: { other: "val" } },
      { params: { slug: "valid" } },
    ]);
    const { routes, warnings } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([{ params: { slug: "valid" } }]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/missing required param "slug"/i);
  });

  it("allows extra params beyond the path", () => {
    const stdout = JSON.stringify([
      { params: { slug: "post", extra: "val", id: 123 } },
    ]);
    const { routes, warnings, error } = parseRouteList(stdout, ["slug"]);
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(routes).toEqual([
      { params: { slug: "post", extra: "val", id: 123 } },
    ]);
  });

  it("warns and skips item with non-string/non-number param value", () => {
    const stdout = JSON.stringify([
      { params: { slug: null } },
      { params: { slug: true } },
      { params: { slug: { nested: "obj" } } },
      { params: { slug: "valid" } },
    ]);
    const { routes, warnings } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([{ params: { slug: "valid" } }]);
    expect(warnings.length).toBe(3);
  });

  it("warns and skips item with empty string param value", () => {
    const stdout = JSON.stringify([
      { params: { slug: "" } },
      { params: { slug: "valid" } },
    ]);
    const { routes, warnings } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([{ params: { slug: "valid" } }]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/empty/i);
  });

  it("warns and skips item with path traversal characters (/, \\, ..)", () => {
    const stdout = JSON.stringify([
      { params: { slug: "a/b" } },
      { params: { slug: "a\\b" } },
      { params: { slug: "../escape" } },
      { params: { slug: "valid-slug" } },
    ]);
    const { routes, warnings } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([{ params: { slug: "valid-slug" } }]);
    expect(warnings.length).toBe(3);
  });

  it("warns and skips item with Windows-illegal filename characters (<>:\"|?*) or control chars", () => {
    const stdout = JSON.stringify([
      { params: { slug: "bad<name" } },
      { params: { slug: "bad>name" } },
      { params: { slug: "bad:name" } },
      { params: { slug: 'bad"name' } },
      { params: { slug: "bad|name" } },
      { params: { slug: "bad?name" } },
      { params: { slug: "bad*name" } },
      { params: { slug: "bad\x00control" } },
      { params: { slug: "valid-name" } },
    ]);
    const { routes, warnings } = parseRouteList(stdout, ["slug"]);
    expect(routes).toEqual([{ params: { slug: "valid-name" } }]);
    expect(warnings.length).toBe(8);
  });
});

describe("dedupeRoutes", () => {
  it("keeps first of exact duplicate output paths and warns", () => {
    const routes = [
      { params: { slug: "first" }, data: 1 },
      { params: { slug: "second" }, data: 2 },
      { params: { slug: "first" }, data: 3 },
    ];
    const { routes: deduped, warnings } = dedupeRoutes("src/pages/blog/[slug].html", routes);
    expect(deduped).toEqual([
      { params: { slug: "first" }, data: 1 },
      { params: { slug: "second" }, data: 2 },
    ]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/duplicate route/i);
  });

  it("warns and keeps first for case-insensitive duplicate output paths", () => {
    const routes = [
      { params: { slug: "Hello" }, data: 1 },
      { params: { slug: "hello" }, data: 2 },
    ];
    const { routes: deduped, warnings } = dedupeRoutes("src/pages/blog/[slug].html", routes);
    expect(deduped).toEqual([{ params: { slug: "Hello" }, data: 1 }]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/case-insensitive/i);
  });
});
