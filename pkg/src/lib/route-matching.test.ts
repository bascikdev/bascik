import { describe, it, expect } from "vitest";
import {
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
