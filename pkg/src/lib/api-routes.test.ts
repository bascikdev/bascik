import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchApiRoute,
  scanApiRouteFiles,
  buildApiRouteTree,
  fileToApiRoutePath,
  formatApiRouteWarning,
  type ApiRouteDefinition,
} from "./api-routes.ts";

// Route files are the script extensions components and configs accept:
// .ts, .mts, .js, .mjs. Anything else in the folder (types, notes, CommonJS)
// is not a route.
describe("scanApiRouteFiles", () => {
  it("finds .ts, .mts, .js and .mjs routes, in any case, and skips other files", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-api-scan-"));
    try {
      await mkdir(join(root, "users"), { recursive: true });
      const names = [
        "health.ts",
        "status.mts",
        "legacy.js",
        "plain.mjs",
        "LOUD.MTS",
        "users/[id].mts",
        "types.d.cts",
        "old.cjs",
        "notes.md",
      ];
      for (const name of names) {
        await writeFile(join(root, name), "export const GET = () => {};\n");
      }
      const found = (await scanApiRouteFiles(root)).map((file) =>
        file.slice(root.length + 1).replace(/\\/g, "/"),
      );
      expect(found.sort()).toEqual(
        [
          "LOUD.MTS",
          "health.ts",
          "legacy.js",
          "plain.mjs",
          "status.mts",
          "users/[id].mts",
        ].sort(),
      );
      expect(fileToApiRoutePath("users/[id].mts")).toBe("/api/users/[id]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // F078: a test or declaration file beside a route is not a route. The
  // docs encourage `contact.test.ts` next to `contact.ts`; registering it
  // made /api/contact.test import vitest on request and answer 500.
  it("skips declaration, test and spec files, in any case", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-api-scan-"));
    try {
      await mkdir(join(root, "users"), { recursive: true });
      const names = [
        "contact.ts",
        "contact.test.ts",
        "contact.spec.mts",
        "users/[id].ts",
        "users/[id].test.mjs",
        "users/[id].SPEC.js",
        "types.d.ts",
        "env.d.mts",
        "latest.ts",
        "contest.ts",
        "spec.ts",
      ];
      for (const name of names) {
        await writeFile(join(root, name), "export const GET = () => {};\n");
      }
      const found = (await scanApiRouteFiles(root)).map((file) =>
        file.slice(root.length + 1).replace(/\\/g, "/"),
      );
      expect(found.sort()).toEqual(
        [
          "contact.ts",
          "contest.ts",
          "latest.ts",
          "spec.ts",
          "users/[id].ts",
        ].sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns no routes for a missing folder", async () => {
    expect(
      await scanApiRouteFiles(join(tmpdir(), "bascik-no-such-api")),
    ).toEqual([]);
  });
});

describe("fileToApiRoutePath", () => {
  it.each([
    ["health.ts", "/api/health"],
    ["users/index.ts", "/api/users"],
    ["index.ts", "/api"],
    ["users/", "/api/users"],
  ])("maps %j to %j", (relPath, expected) => {
    expect(fileToApiRoutePath(relPath)).toBe(expected);
  });
});

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
    const filePaths = ["/app/src/api/users.ts", "/app/src/api/users/index.ts"];

    expect(() => buildApiRouteTree(filePaths, "/app/src/api")).toThrowError(
      /Duplicate API route "\/api\/users" declared in multiple files:\n  - \/app\/src\/api\/users\.ts\n  - \/app\/src\/api\/users\/index\.ts/,
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
    expect(match2?.route.filePath).toBe(
      "C:\\app\\src\\api\\categories\\deep\\nested.ts",
    );
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

    expect(matchApiRoute(routes, "/sub/api/health")?.route.filePath).toBe(
      "/app/src/api/health.ts",
    );
    expect(matchApiRoute(routes, "/api/health")).toBeNull();
  });

  it("formats build warning message accurately", () => {
    const warning = formatApiRouteWarning(
      ["/api/health", "/api/contact", "/api/users/[id]"],
      "src/api",
    );
    expect(warning).toContain(
      "warning: 3 API routes found in src/api/ but static builds cannot serve them.",
    );
    expect(warning).toContain(
      "Deploy with `bascik --server`, build a serverless bundle with `bascik --build --target <name>`, or port them to your host's function runtime.",
    );
    expect(warning).toContain(
      "Routes: /api/health, /api/contact, /api/users/[id]",
    );
  });
});
