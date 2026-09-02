import { describe, it, expect } from "vitest";
import {
  matchApiRoute,
  buildApiRouteTree,
  formatApiRouteWarning,
  type ApiRouteDefinition,
} from "./api-routes.ts";

describe("API route matching (pure)", () => {
  it("matches static routes correctly", () => {
    const routes: ApiRouteDefinition[] = [
      {
        path: "/api/health",
        filePath: "/app/src/api/health.ts",
        paramNames: [],
        isDynamic: false,
      },
      {
        path: "/api/contact",
        filePath: "/app/src/api/contact.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];

    const match1 = matchApiRoute(routes, "/api/health");
    expect(match1).not.toBeNull();
    expect(match1?.route.filePath).toBe("/app/src/api/health.ts");
    expect(match1?.params).toEqual({});

    const match2 = matchApiRoute(routes, "/api/contact");
    expect(match2).not.toBeNull();
    expect(match2?.route.filePath).toBe("/app/src/api/contact.ts");

    const match3 = matchApiRoute(routes, "/api/unknown");
    expect(match3).toBeNull();
  });

  it("maps index.ts to the directory path", () => {
    const routes: ApiRouteDefinition[] = [
      {
        path: "/api/users",
        filePath: "/app/src/api/users/index.ts",
        paramNames: [],
        isDynamic: false,
      },
      {
        path: "/api",
        filePath: "/app/src/api/index.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];

    const match1 = matchApiRoute(routes, "/api/users");
    expect(match1?.route.filePath).toBe("/app/src/api/users/index.ts");
    expect(match1?.params).toEqual({});

    const match2 = matchApiRoute(routes, "/api/users/");
    expect(match2?.route.filePath).toBe("/app/src/api/users/index.ts");

    const match3 = matchApiRoute(routes, "/api");
    expect(match3?.route.filePath).toBe("/app/src/api/index.ts");
  });

  it("extracts single and multiple [param] segments in order", () => {
    const routes: ApiRouteDefinition[] = [
      {
        path: "/api/users/[id]",
        filePath: "/app/src/api/users/[id].ts",
        paramNames: ["id"],
        isDynamic: true,
      },
      {
        path: "/api/[org]/repos/[repoId]",
        filePath: "/app/src/api/[org]/repos/[repoId].ts",
        paramNames: ["org", "repoId"],
        isDynamic: true,
      },
    ];

    const match1 = matchApiRoute(routes, "/api/users/42");
    expect(match1?.route.filePath).toBe("/app/src/api/users/[id].ts");
    expect(match1?.params).toEqual({ id: "42" });

    const match2 = matchApiRoute(routes, "/api/bascik/repos/compiler");
    expect(match2?.route.filePath).toBe("/app/src/api/[org]/repos/[repoId].ts");
    expect(match2?.params).toEqual({ org: "bascik", repoId: "compiler" });
  });

  it("prefers static routes over dynamic routes with same depth", () => {
    const filePaths = [
      "/app/src/api/users/[id].ts",
      "/app/src/api/users/me.ts",
    ];
    const routes = buildApiRouteTree(filePaths, "/app/src/api");

    const match = matchApiRoute(routes, "/api/users/me");
    expect(match?.route.filePath).toBe("/app/src/api/users/me.ts");
    expect(match?.params).toEqual({});

    const matchOther = matchApiRoute(routes, "/api/users/123");
    expect(matchOther?.route.filePath).toBe("/app/src/api/users/[id].ts");
    expect(matchOther?.params).toEqual({ id: "123" });
  });

  it("errors on duplicate route definitions naming both files", () => {
    const filePaths = [
      "/app/src/api/users.ts",
      "/app/src/api/users/index.ts",
    ];

    expect(() => buildApiRouteTree(filePaths, "/app/src/api")).toThrowError(
      /Duplicate API route "\/api\/users" declared in multiple files:\n  - \/app\/src\/api\/users\.ts\n  - \/app\/src\/api\/users\/index\.ts/
    );
  });

  it("handles trailing slashes, URL-encoded characters, Windows separators, nested directories", () => {
    const filePaths = [
      "C:\\app\\src\\api\\items\\[item].ts",
      "C:\\app\\src\\api\\categories\\deep\\nested.ts",
    ];

    const routes = buildApiRouteTree(filePaths, "C:\\app\\src\\api");
    expect(routes.length).toBe(2);

    const match1 = matchApiRoute(routes, "/api/items/hello%20world/");
    expect(match1?.route.filePath).toBe("C:\\app\\src\\api\\items\\[item].ts");
    expect(match1?.params).toEqual({ item: "hello world" });

    const match2 = matchApiRoute(routes, "/api/categories/deep/nested");
    expect(match2?.route.filePath).toBe("C:\\app\\src\\api\\categories\\deep\\nested.ts");
  });

  it("composes with base path", () => {
    const routes: ApiRouteDefinition[] = [
      {
        path: "/sub/api/health",
        filePath: "/app/src/api/health.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];

    expect(matchApiRoute(routes, "/sub/api/health")?.route.filePath).toBe("/app/src/api/health.ts");
    expect(matchApiRoute(routes, "/api/health")).toBeNull();
  });

  it("formats build warning message accurately", () => {
    const warning = formatApiRouteWarning(["/api/health", "/api/contact", "/api/users/[id]"], "src/api");
    expect(warning).toContain("warning: 3 API routes found in src/api/ but static builds cannot serve them.");
    expect(warning).toContain("Deploy with `bascik --server`, or port them to your host's function runtime.");
    expect(warning).toContain("Routes: /api/health, /api/contact, /api/users/[id]");
  });
});
