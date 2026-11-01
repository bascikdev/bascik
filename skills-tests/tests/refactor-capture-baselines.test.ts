// Unit tests for skills/bascik-refactor/scripts/capture-baselines.mjs: the production baselines the inventory stage
// records before any target page exists (a full-page PNG and collectNodes geometry per route and matrix case, and with
// --states every open state's crop), where they go, what a baseline id is, and how index.json accumulates runs. The
// browser half (the files on disk, the cache the first run-checks reads) is in
// refactor-parity-checks.integration.test.ts.
//
// Why it exists: phase 1 of a migration asks for production baselines, but no script captured production alone, and
// nothing said where a baseline goes or what its id is, so each agent wrote its own driver.
import { describe, expect, it } from "vitest";
import {
  baselineId,
  baselinePaths,
  DEFAULT_BASELINES,
  mergeIndex,
  parseCliArgs,
  stateId,
} from "../../skills/bascik-refactor/scripts/capture-baselines.mjs";

const base = ["--prod", "https://www.example.com", "--route", "/"];

describe("parseCliArgs", () => {
  it("needs --prod and --route, writes to artifacts/baselines, and takes --states", () => {
    expect(() => parseCliArgs([])).toThrow(/--prod/);
    expect(() => parseCliArgs(["--prod", "https://www.example.com"])).toThrow(
      /--route/,
    );
    const args = parseCliArgs(base);
    expect(args.out).toBe(DEFAULT_BASELINES);
    expect(DEFAULT_BASELINES).toBe("artifacts/baselines");
    expect(args.states).toBe(false);
    expect(args.prodCache).toBe("artifacts/prod-cache");
    expect(parseCliArgs([...base, "--states"]).states).toBe(true);
    expect(parseCliArgs([...base, "--out", "tmp/b"]).out).toBe("tmp/b");
    expect(parseCliArgs(["--help"])).toEqual({ help: true });
  });

  it("misuse: --target is refused, since a baseline is production alone", () => {
    expect(() =>
      parseCliArgs([...base, "--target", "http://localhost:8080"]),
    ).toThrow(/records production only.*run-checks\.mjs/s);
    expect(() =>
      parseCliArgs([...base, "--target", "https://www.example.com"]),
    ).toThrow(/records production only/);
  });

  it("misuse: a typo'd route, mask or skip-control fails before any browser starts", () => {
    expect(() =>
      parseCliArgs(["--prod", "https://a.example", "--route", "pricing"]),
    ).toThrow(/starts with "\/"/);
    expect(() => parseCliArgs([...base, "--mask", "[data-x"])).toThrow(
      /not a CSS selector/,
    );
    expect(() =>
      parseCliArgs([...base, "--states", "--skip-control", "(a"]),
    ).toThrow(/--skip-control \(a: not a CSS selector/);
  });
});

describe("baseline ids and paths", () => {
  it("a baseline id is <route>@<caseId>, and an open state adds #<label>", () => {
    expect(baselineId("/", { width: 360, height: 812 })).toBe("/@360x812");
    expect(
      baselineId("/pricing", { width: 1408, height: 900, colorScheme: "dark" }),
    ).toBe("/pricing@1408x900-dark");
    expect(stateId("/pricing@360x812", "BUTTON:Menu")).toBe(
      "/pricing@360x812#BUTTON:Menu",
    );
  });

  it("writes <out>/<route slug>/<caseId>.png and .nodes.json, open states beside them", () => {
    expect(baselinePaths("/", { width: 360, height: 812 })).toEqual({
      dir: "index",
      png: "index/360x812.png",
      nodes: "index/360x812.nodes.json",
      state: expect.any(Function),
    });
    const paths = baselinePaths("/pricing/team/", { width: 768, height: 1024 });
    expect(paths.png).toBe("pricing_team/768x1024.png");
    expect(paths.state(0)).toBe("pricing_team/768x1024.state-0.png");
  });
});

describe("mergeIndex", () => {
  const entry = (id: string, at = "2026-10-31T00:00:00.000Z") => ({
    id,
    route: id.split("@")[0],
    capturedAt: at,
  });

  it("keeps baselines of other routes and cases, replaces the same id, and orders by id", () => {
    const first = mergeIndex(null, {
      prod: "https://www.example.com",
      matrix: "docs/migration/breakpoints.json",
      baselines: [entry("/@360x812"), entry("/@1440x900")],
    });
    expect(first.format).toBe(1);
    const second = mergeIndex(first, {
      prod: "https://www.example.com",
      matrix: "docs/migration/breakpoints.json",
      baselines: [
        entry("/pricing@360x812"),
        entry("/@360x812", "2026-11-01T00:00:00.000Z"),
      ],
    });
    expect(second.baselines.map((b: { id: string }) => b.id)).toEqual([
      "/@1440x900",
      "/@360x812",
      "/pricing@360x812",
    ]);
    expect(
      second.baselines.find((b: { id: string }) => b.id === "/@360x812")
        .capturedAt,
    ).toBe("2026-11-01T00:00:00.000Z");
  });

  it("misuse: baselines of another production origin are never mixed into one index", () => {
    const first = mergeIndex(null, {
      prod: "https://www.example.com",
      matrix: "m.json",
      baselines: [entry("/@360x812")],
    });
    expect(() =>
      mergeIndex(first, {
        prod: "https://staging.example.com",
        matrix: "m.json",
        baselines: [entry("/@360x812")],
      }),
    ).toThrow(/holds baselines of https:\/\/www\.example\.com/);
  });
});
