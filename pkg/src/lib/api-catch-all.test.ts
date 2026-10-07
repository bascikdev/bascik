import { describe, it, expect } from "vitest";
import {
  buildApiRouteTree,
  fileToApiRoutePath,
  findApiRoutePatternProblems,
  InvalidApiPathError,
  matchApiRoute,
} from "./api-routes.ts";

const API = "/app/src/api";
const files = (...rels: string[]): string[] => rels.map((r) => `${API}/${r}`);

/** All permutations, to prove discovery-order independence. */
const permutations = <T>(items: T[]): T[][] => {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
};

describe("catch-all: route path derivation", () => {
  it("maps [...path].ts to /api/[...path]", () => {
    expect(fileToApiRoutePath("[...path].ts")).toBe("/api/[...path]");
  });

  it("maps nested catch-all and index-shaped files", () => {
    expect(fileToApiRoutePath("proxy/[...rest].ts")).toBe("/api/proxy/[...rest]");
    expect(fileToApiRoutePath("proxy\\[...rest].ts")).toBe("/api/proxy/[...rest]");
    expect(fileToApiRoutePath("[org]/[...rest].ts", "/app/")).toBe("/app/api/[org]/[...rest]");
  });

  it("derives the capture name without the dots", () => {
    const [route] = buildApiRouteTree(files("[...path].ts"), API);
    expect(route.path).toBe("/api/[...path]");
    expect(route.paramNames).toEqual(["path"]);
    expect(route.isDynamic).toBe(true);
  });
});

describe("catch-all: matching", () => {
  const routes = buildApiRouteTree(files("[...path].ts"), API);

  it("captures one remaining segment as a one element array", () => {
    expect(matchApiRoute(routes, "/api/users")?.params).toEqual({ path: ["users"] });
  });

  it("captures multiple remaining segments preserving boundaries", () => {
    expect(matchApiRoute(routes, "/api/a/b/c")?.params).toEqual({ path: ["a", "b", "c"] });
  });

  it("is required: zero remaining segments does not match", () => {
    expect(matchApiRoute(routes, "/api")).toBeNull();
    expect(matchApiRoute(routes, "/api/")).toBeNull();
  });

  it("ignores one trailing slash", () => {
    expect(matchApiRoute(routes, "/api/a/b/")?.params).toEqual({ path: ["a", "b"] });
  });

  it("works under a nested prefix and with [param] prefix segments", () => {
    const nested = buildApiRouteTree(files("[org]/repos/[...rest].ts"), API);
    expect(matchApiRoute(nested, "/api/acme/repos/x/y")?.params).toEqual({ org: "acme", rest: ["x", "y"] });
    expect(matchApiRoute(nested, "/api/acme/other/x")).toBeNull();
    expect(matchApiRoute(nested, "/api/acme/repos")).toBeNull();
  });

  it("respects the base path", () => {
    const based = buildApiRouteTree(files("[...path].ts"), API, "/app/");
    expect(matchApiRoute(based, "/app/api/a/b")?.params).toEqual({ path: ["a", "b"] });
    expect(matchApiRoute(based, "/api/a/b")).toBeNull();
  });
});

describe("catch-all: decoding", () => {
  const routes = buildApiRouteTree(files("[...path].ts"), API);
  const match = (raw: string) => matchApiRoute(routes, decodeURIComponent(raw), raw);

  it("decodes each segment exactly once", () => {
    expect(match("/api/hello%20world/caf%C3%A9")?.params).toEqual({ path: ["hello world", "café"] });
    // %2541 decodes once to the literal text "%41", never to "A".
    expect(match("/api/%2541")?.params).toEqual({ path: ["%41"] });
  });

  it("rejects malformed percent-encoding with InvalidApiPathError", () => {
    expect(() => matchApiRoute(routes, "/api/%E0%A4%A", "/api/%E0%A4%A")).toThrow(InvalidApiPathError);
    expect(() => matchApiRoute(routes, "/api/a/%", "/api/a/%")).toThrow(InvalidApiPathError);
  });

  it.each(["/api/a%2Fb", "/api/a%2fb", "/api/a%5Cb", "/api/%2e%2e", "/api/a/%2e/b", "/api/a/%2E%2E/b", "/api/a%00b", "/api/a%0Ab"])(
    "rejects unsafe segment %s",
    (raw) => {
      expect(() => matchApiRoute(routes, raw, raw)).toThrow(InvalidApiPathError);
    },
  );

  it("rejects literal dot segments and empty interior segments", () => {
    expect(() => matchApiRoute(routes, "/api/a/../b", "/api/a/../b")).toThrow(InvalidApiPathError);
    expect(() => matchApiRoute(routes, "/api/a//b", "/api/a//b")).toThrow(InvalidApiPathError);
  });

  it("a %2F cannot forge a segment boundary: the raw path is split before decoding", () => {
    // Decoded pathname has an extra slash, but the raw one does not.
    expect(() => matchApiRoute(routes, "/api/a/b", "/api/a%2Fb")).toThrow(InvalidApiPathError);
  });

  it("a malformed capture does not throw when a more specific route wins", () => {
    const table = buildApiRouteTree(files("[...path].ts", "health.ts"), API);
    expect(matchApiRoute(table, "/api/health", "/api/health")?.route.filePath).toBe(`${API}/health.ts`);
  });
});

describe("catch-all: precedence", () => {
  const table = files(
    "[...path].ts",
    "users/[...rest].ts",
    "users/[id].ts",
    "users/me.ts",
    "users/[id]/settings.ts",
    "health.ts",
  );
  const pick = (list: string[], path: string): string | undefined =>
    matchApiRoute(buildApiRouteTree(list, API), path)?.route.filePath.replace(`${API}/`, "");

  it("static beats [param] beats catch-all", () => {
    expect(pick(table, "/api/health")).toBe("health.ts");
    expect(pick(table, "/api/users/me")).toBe("users/me.ts");
    expect(pick(table, "/api/users/42")).toBe("users/[id].ts");
    expect(pick(table, "/api/users/42/settings")).toBe("users/[id]/settings.ts");
  });

  it("falls to the most specific catch-all when nothing else matches", () => {
    expect(pick(table, "/api/users/42/extra/deep")).toBe("users/[...rest].ts");
    expect(pick(table, "/api/other/x")).toBe("[...path].ts");
  });

  it("is independent of discovery order (matcher and tree builder)", () => {
    const small = files("[...path].ts", "users/me.ts", "users/[id].ts");
    for (const order of permutations(small)) {
      expect(pick(order, "/api/users/me")).toBe("users/me.ts");
      expect(pick(order, "/api/users/7")).toBe("users/[id].ts");
      expect(pick(order, "/api/users/7/x")).toBe("[...path].ts");
    }
    // Raw, unsorted definitions straight into the matcher.
    const defs = buildApiRouteTree(small, API);
    for (const order of permutations(defs)) {
      expect(matchApiRoute(order, "/api/users/me")?.route.path).toBe("/api/users/me");
      expect(matchApiRoute(order, "/api/users/7")?.route.path).toBe("/api/users/[id]");
      expect(matchApiRoute(order, "/api/users/7/x")?.route.path).toBe("/api/[...path]");
    }
  });

  it("sorts catch-all routes last", () => {
    const sorted = buildApiRouteTree(files("[...path].ts", "a.ts", "[x].ts"), API).map((r) => r.path);
    expect(sorted).toEqual(["/api/a", "/api/[x]", "/api/[...path]"]);
  });
});

describe("catch-all: existing behavior preserved", () => {
  it("exact and [param] routes behave as before when no catch-all exists", () => {
    const routes = buildApiRouteTree(files("users/[id].ts", "users/me.ts"), API);
    expect(matchApiRoute(routes, "/api/users/me")?.params).toEqual({});
    expect(matchApiRoute(routes, "/api/users/a%20b")?.params).toEqual({ id: "a b" });
    expect(matchApiRoute(routes, "/api/users/%E0%A4%A")?.params).toEqual({ id: "%E0%A4%A" });
  });

  it("a dotted [...] outside the final position is not treated as a plain param", () => {
    expect(() => buildApiRouteTree(files("[...a]/b.ts"), API)).toThrow(/must be the last segment/);
  });
});

describe("catch-all: invalid and ambiguous patterns", () => {
  it("rejects a non-final catch-all", () => {
    expect(() => buildApiRouteTree(files("[...a]/b.ts"), API)).toThrow(/Invalid API route patterns[\s\S]*must be the last segment/);
  });

  it("rejects unnamed or partial catch-alls", () => {
    expect(() => buildApiRouteTree(files("[...].ts"), API)).toThrow(/Invalid catch-all segment/);
    expect(() => buildApiRouteTree(files("x[...a].ts"), API)).toThrow(/Invalid catch-all segment/);
    expect(() => buildApiRouteTree(files("[....a].ts"), API)).toThrow(/Invalid catch-all segment/);
  });

  it("rejects a repeated parameter name alongside a catch-all", () => {
    expect(() => buildApiRouteTree(files("[a]/[...a].ts"), API)).toThrow(/more than once/);
  });

  it("rejects two catch-alls at the same position naming both files, in any order", () => {
    for (const order of permutations(files("[...a].ts", "[...b].ts"))) {
      expect(() => buildApiRouteTree(order, API)).toThrow(
        /Ambiguous API routes "\/api\/\[\.\.\.a\]" and "\/api\/\[\.\.\.b\]"[\s\S]*\[\.\.\.a\]\.ts[\s\S]*\[\.\.\.b\]\.ts|Ambiguous API routes "\/api\/\[\.\.\.b\]" and "\/api\/\[\.\.\.a\]"/,
      );
    }
  });

  it("treats differently named [param] prefixes with a catch-all as ambiguous", () => {
    expect(() => buildApiRouteTree(files("[x]/[...a].ts", "[y]/[...b].ts"), API)).toThrow(/Ambiguous/);
  });

  it("still reports exact duplicates with the existing message", () => {
    expect(() => buildApiRouteTree(files("[...a].ts", "[...a]/index.ts"), API)).toThrow(/Duplicate API route/);
  });

  it("does not flag catch-alls at different depths or under different static prefixes", () => {
    expect(() => buildApiRouteTree(files("[...a].ts", "x/[...b].ts", "[p]/[...c].ts"), API)).not.toThrow();
  });

  it("findApiRoutePatternProblems reports file identities", () => {
    const problems = findApiRoutePatternProblems([
      { path: "/api/[...a]", filePath: "a.ts" },
      { path: "/api/[...b]", filePath: "b.ts" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("ambiguous");
    expect(problems[0].filePaths).toEqual(["a.ts", "b.ts"]);
  });
});
