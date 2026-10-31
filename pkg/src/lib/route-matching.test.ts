import { describe, it, expect, vi } from "vitest";
import {
  InvalidApiPathError,
  hasHiddenSegment,
  isBascikFolderName,
  matchApiRoute,
  WELL_KNOWN_SEGMENT,
} from "./route-matching.ts";

describe("isBascikFolderName", () => {
  it.each([
    ".bascik",
    ".BASCIK",
    ".Bascik",
    ".bascik.",
    ".bascik . ",
    ".bascik  ",
  ])("names %j as the private folder", (segment) => {
    expect(isBascikFolderName(segment)).toBe(true);
  });

  it.each(["bascik", ".bascikx", ". bascik", ".bascik.x", ""])(
    "does not name %j",
    (segment) => {
      expect(isBascikFolderName(segment)).toBe(false);
    },
  );

  it("misuse: a request segment of many spaces and dots is answered in linear time", () => {
    const segment = ". ".repeat(100_000) + "x";
    const started = performance.now();
    expect(isBascikFolderName(segment)).toBe(false);
    expect(isBascikFolderName(". ".repeat(100_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("hasHiddenSegment", () => {
  it("names the RFC 8615 well-known segment", () => {
    expect(WELL_KNOWN_SEGMENT).toBe(".well-known");
  });

  it.each([
    "/.env",
    "/.git/config",
    "/foo/.hidden",
    "/.bascik/manifest.json",
    "/.bascik/server-scripts.json",
    "/.well-knownx/a.json",
    "/.Well-Known/a.json",
    "/.WELL-KNOWN/a.json",
    "/.well-known/.env",
    "/.well-known/agent-skills/.secret/a.json",
    "/blog/.well-known/a.json",
    "/api/.well-known/a.json",
    ".env",
    "dir/.env",
  ])("treats %s as hidden", (path) => {
    expect(hasHiddenSegment(path)).toBe(true);
  });

  it.each([
    "/",
    "",
    "/about",
    "/assets/app.js",
    "/.well-known",
    "/.well-known/",
    "/.well-known/security.txt",
    "/.well-known/agent-skills/index.json",
    "/.well-known/agent-skills/bascik.tar.gz",
    "//.well-known/security.txt",
    ".well-known/security.txt",
    "well-known/a.json",
    "/file.with.dots.txt",
  ])("allows %s", (path) => {
    expect(hasHiddenSegment(path)).toBe(false);
  });

  describe("with a non-root base", () => {
    it("allows the well-known segment directly below the base", () => {
      expect(hasHiddenSegment("/docs/.well-known/security.txt", "/docs/")).toBe(
        false,
      );
      expect(
        hasHiddenSegment("/docs/.well-known/agent-skills/index.json", "/docs/"),
      ).toBe(false);
    });

    it("still hides other dot segments below the base", () => {
      expect(hasHiddenSegment("/docs/.env", "/docs/")).toBe(true);
      expect(hasHiddenSegment("/docs/.well-known/.env", "/docs/")).toBe(true);
      expect(hasHiddenSegment("/docs/blog/.well-known/a.json", "/docs/")).toBe(
        true,
      );
    });

    it("applies the root rule to paths outside the base, which are 404 anyway", () => {
      expect(hasHiddenSegment("/other/.well-known/a.json", "/docs/")).toBe(
        true,
      );
      expect(hasHiddenSegment("/.env", "/docs/")).toBe(true);
    });

    it("does not treat a base-like prefix without a boundary as the base", () => {
      expect(hasHiddenSegment("/docsx/.well-known/a.json", "/docs/")).toBe(
        true,
      );
    });
  });
});

describe("matchApiRoute dynamic parameter single-decoding", () => {
  it("does not double-decode dynamic route parameters when rawPathname is provided", () => {
    const routes = [
      {
        path: "/api/users/[id]",
        filePath: "/app/src/api/users/[id].ts",
        paramNames: ["id"],
        isDynamic: true,
      },
    ];
    // pathname is decoded by server (e.g. /api/users/100%20)
    // rawPathname is wire path (e.g. /api/users/100%2520)
    const match = matchApiRoute(
      routes,
      "/api/users/100%20",
      "/api/users/100%2520",
    );
    expect(match?.params).toEqual({ id: "100%20" });
  });

  it("decodes exactly once when only decoded pathname is provided", () => {
    const routes = [
      {
        path: "/api/users/[id]",
        filePath: "/app/src/api/users/[id].ts",
        paramNames: ["id"],
        isDynamic: true,
      },
    ];
    // When only pathname is passed without rawPathname, pSeg is decoded once
    const match = matchApiRoute(routes, "/api/users/100%20");
    expect(match?.params).toEqual({ id: "100 " });
  });

  it("matches static routes with doubled slashes like /api//users", () => {
    const routes = [
      {
        path: "/api/users",
        filePath: "/app/src/api/users.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];
    const match = matchApiRoute(routes, "/api//users", "/api//users");
    expect(match?.route.filePath).toBe("/app/src/api/users.ts");
    expect(match?.params).toEqual({});
  });

  it("matches dynamic routes with doubled slashes like /api/users//100", () => {
    const routes = [
      {
        path: "/api/users/[id]",
        filePath: "/app/src/api/users/[id].ts",
        paramNames: ["id"],
        isDynamic: true,
      },
    ];
    const match = matchApiRoute(routes, "/api/users//100", "/api/users//100");
    expect(match?.route.filePath).toBe("/app/src/api/users/[id].ts");
    expect(match?.params).toEqual({ id: "100" });
  });

  it("matches dynamic routes with trailing // like /api/users/100//", () => {
    const routes = [
      {
        path: "/api/users/[id]",
        filePath: "/app/src/api/users/[id].ts",
        paramNames: ["id"],
        isDynamic: true,
      },
    ];
    const match = matchApiRoute(routes, "/api/users/100//", "/api/users/100//");
    expect(match?.route.filePath).toBe("/app/src/api/users/[id].ts");
    expect(match?.params).toEqual({ id: "100" });
  });

  it("decodes dynamic route parameter once with doubled slash e.g. /api/users//100%2520 to id 100%20", () => {
    const routes = [
      {
        path: "/api/users/[id]",
        filePath: "/app/src/api/users/[id].ts",
        paramNames: ["id"],
        isDynamic: true,
      },
    ];
    const match = matchApiRoute(
      routes,
      "/api/users//100%20",
      "/api/users//100%2520",
    );
    expect(match?.route.filePath).toBe("/app/src/api/users/[id].ts");
    expect(match?.params).toEqual({ id: "100%20" });
  });
});

// F052: [param] routes match the wire path. An encoded `/` (or `\`) can
// neither forge a segment boundary nor smuggle a separator into a value, and
// every value is decoded exactly once, whatever the segment counts are.
describe("matchApiRoute [param] routes and encoded separators", () => {
  const route = (path: string) => ({
    path,
    filePath: `/app/src/api${path.slice(4)}.ts`,
    paramNames: (path.match(/\[([^\]]+)\]/g) ?? []).map((m) => m.slice(1, -1)),
    isDynamic: path.includes("["),
  });
  const match = (routes: string[], raw: string) =>
    matchApiRoute(routes.map(route), decodeURIComponent(raw), raw);

  it("does not let %2F pick a route with more segments than the request has", () => {
    expect(() =>
      match(["/api/[p]/[q]", "/api/[p]/[q]/[r]"], "/api/x/a%2Fb"),
    ).toThrow(InvalidApiPathError);
    expect(() => match(["/api/[p]/[q]/[r]"], "/api/x/a%2Fb")).not.toThrow();
    expect(match(["/api/[p]/[q]/[r]"], "/api/x/a%2Fb")).toBeNull();
    expect(match(["/api/[p]/[q]/[r]"], "/api/a%2Fb/c")).toBeNull();
  });

  // Per-request cost (prompt 158 R2-09): every raw segment of a [param]
  // route is decoded, so a segment without `%` (which decodes to itself)
  // skips decodeURIComponent; an encoded one is still decoded exactly once.
  it("decodes only the segments that hold a percent-encoding", () => {
    const decode = vi.spyOn(globalThis, "decodeURIComponent");
    try {
      const routes = ["/api/users/[id]/items/[item]"].map(route);
      decode.mockClear();
      expect(
        matchApiRoute(
          routes,
          "/api/users/42/items/abc",
          "/api/users/42/items/abc",
        )?.params,
      ).toEqual({ id: "42", item: "abc" });
      expect(decode).not.toHaveBeenCalled();
      decode.mockClear();
      expect(
        matchApiRoute(
          routes,
          "/api/users/a b/items/100%20",
          "/api/users/a%20b/items/100%2520",
        )?.params,
      ).toEqual({ id: "a b", item: "100%20" });
      expect(decode.mock.calls).toEqual([["a%20b"], ["100%2520"]]);
      // Malformed encoding still keeps the raw text; an encoded separator
      // is still refused.
      expect(
        matchApiRoute(
          routes,
          "/api/users/%E0%A4%A/items/x",
          "/api/users/%E0%A4%A/items/x",
        )?.params,
      ).toEqual({ id: "%E0%A4%A", item: "x" });
      expect(() => match(["/api/users/[id]"], "/api/users/a%2Fb")).toThrow(
        /encoded path separator/,
      );
    } finally {
      decode.mockRestore();
    }
  });

  it("answers 400 (InvalidApiPathError) for %2F, %2f or %5C inside a [param] value", () => {
    for (const raw of [
      "/api/users/a%2Fb",
      "/api/users/a%2fb",
      "/api/users/a%5Cb",
    ]) {
      expect(() => match(["/api/users/[id]"], raw), raw).toThrow(
        /encoded path separator/,
      );
    }
  });

  it("never decodes twice, even next to an encoded slash", () => {
    expect(match(["/api/[p]/[q]/[r]"], "/api/100%2520/z/w")?.params).toEqual({
      p: "100%20",
      q: "z",
      r: "w",
    });
    // Before, the misaligned counts sent this through a second decode.
    expect(() => match(["/api/[p]/[q]/[r]"], "/api/x/100%2520/z%2Fw")).toThrow(
      /encoded path separator/,
    );
    // `%252e%252e` is the text `%2e%2e`, never `..`.
    expect(() => match(["/api/[p]/[q]"], "/api/%252e%252e/z%2Fw")).toThrow(
      /encoded path separator/,
    );
    expect(match(["/api/[p]"], "/api/%252e%252e")?.params).toEqual({
      p: "%2e%2e",
    });
  });

  it("still prefers a static route when the request has no encoded separator", () => {
    expect(
      match(["/api/x/[q]", "/api/[p]/[q]"], "/api/x/hello")?.route.path,
    ).toBe("/api/x/[q]");
    // A static segment never equals a decoded value that holds a slash.
    expect(match(["/api/x/[q]"], "/api/x%2Fy/z")).toBeNull();
  });

  it("decides precedence before rejecting: a static route on the decoded path still wins", () => {
    // Exact routes match the decoded path (documented), and a static route
    // beats any [param] route, so the unsafe [id] capture never matters.
    expect(
      match(["/api/users/[id]", "/api/users/a/b"], "/api/users/a%2Fb")?.route
        .path,
    ).toBe("/api/users/a/b");
  });
});
