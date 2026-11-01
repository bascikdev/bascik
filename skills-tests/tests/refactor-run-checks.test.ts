// Unit tests for skills/bascik-refactor/scripts/run-checks.mjs: the single entry point that runs every parity check
// (production defects first, then 1-7, testid carryover and coverage, presence by route) per route and matrix case, writes one report per route and exits nonzero on any
// finding. The browser half (the defect and clean fixture sites) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: agents treated "no flags" from the scripts they happened to run as PASS. One command with every check
// leaves nothing to forget, and its report feeds the human review page.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CHECKS,
  buildRouteReport,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/run-checks.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../../skills/bascik-refactor/scripts/run-checks.mjs",
    import.meta.url,
  ),
);
const base = [
  "--prod",
  "https://example.com",
  "--target",
  "http://localhost:8080",
  "--route",
  "/",
  "--legacy-src",
  "../legacy",
];

describe("CHECKS", () => {
  it("runs the eleven checks in order, production defects first, and each one is its own script", async () => {
    expect([...CHECKS]).toEqual([
      "production-defects",
      "interaction-crawl",
      "state-capture",
      "repeated-sections",
      "text-style-diff",
      "spacing-diff",
      "alignment-diff",
      "overlap-diff",
      "testid-carryover",
      "testid-coverage",
      "presence-by-route",
    ]);
    for (const name of CHECKS) {
      const mod = await import(
        fileURLToPath(
          new URL(
            `../../skills/bascik-refactor/scripts/${name}.mjs`,
            import.meta.url,
          ),
        )
      );
      expect(mod.CHECK, name).toBe(name);
      expect(typeof mod.runCheck, name).toBe("function");
    }
  });
});

describe("parseCliArgs", () => {
  it("defaults the matrix, the sources, the tolerances and the output folder", () => {
    expect(parseCliArgs(base)).toMatchObject({
      prod: "https://example.com",
      target: "http://localhost:8080",
      route: ["/"],
      matrix: "docs/migration/breakpoints.json",
      targetSrc: ".",
      legacySrc: "../legacy",
      spacingTolerance: 2,
      overlapTolerance: 1,
      mask: [],
      skipControls: [],
      out: "artifacts/checks",
      only: [...CHECKS],
    });
  });

  it("--skip-control passes side-effecting controls to the crawl and state capture, and rejects a broken selector", () => {
    expect(
      parseCliArgs([...base, "--skip-control", "[data-add-to-cart]"])
        .skipControls,
    ).toEqual(["[data-add-to-cart]"]);
    expect(() =>
      parseCliArgs([...base, "--skip-control", "button[type=button"]),
    ).toThrow(/--skip-control/);
  });

  it("--only and --skip take check names and reject a typo, listing the valid ones", () => {
    expect(parseCliArgs([...base, "--only", "spacing-diff"]).only).toEqual([
      "spacing-diff",
    ]);
    expect(
      parseCliArgs([...base, "--skip", "overlap-diff"]).only,
    ).not.toContain("overlap-diff");
    expect(() => parseCliArgs([...base, "--only", "spacing"])).toThrow(
      /spacing[\s\S]*spacing-diff/,
    );
  });

  it("needs --legacy-src while testid-carryover runs, and not when it is skipped", () => {
    const noLegacy = base.slice(0, -2);
    expect(() => parseCliArgs(noLegacy)).toThrow(/--legacy-src/);
    expect(() =>
      parseCliArgs([...noLegacy, "--skip", "testid-carryover"]),
    ).not.toThrow();
  });

  it("rejects a spacing tolerance that is not a number", () => {
    expect(() => parseCliArgs([...base, "--spacing-tolerance", "two"])).toThrow(
      /--spacing-tolerance/,
    );
  });
});

describe("buildRouteReport", () => {
  const result = (
    check: string,
    findings: Array<Record<string, unknown>> = [],
  ) => ({
    check,
    ok: findings.length === 0,
    findings: findings.map((f) => ({ check, ...f })),
  });

  it("passes only when every check ran and none has a finding", () => {
    const report = buildRouteReport(
      "/",
      CHECKS.map((c: string) => result(c)),
    );
    expect(report).toMatchObject({ route: "/", ok: true, findings: [] });
    expect(Object.keys(report.checks)).toEqual([...CHECKS]);
  });

  it("one finding anywhere fails the route and is listed with its check", () => {
    const report = buildRouteReport(
      "/",
      CHECKS.map((c: string) =>
        c === "overlap-diff"
          ? result(c, [{ kind: "offset", message: "icon 2 px off" }])
          : result(c),
      ),
    );
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      expect.objectContaining({
        check: "overlap-diff",
        kind: "offset",
        message: "icon 2 px off",
      }),
    ]);
  });

  it("a check that crashed is a finding, never a pass", () => {
    const report = buildRouteReport("/", [
      ...CHECKS.filter((c: string) => c !== "state-capture").map((c: string) =>
        result(c),
      ),
      {
        check: "state-capture",
        error: "page.goto: net::ERR_CONNECTION_REFUSED",
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      expect.objectContaining({
        check: "state-capture",
        kind: "error",
        message: expect.stringContaining("ERR_CONNECTION_REFUSED"),
      }),
    ]);
  });

  it("a parity finding on an element production got wrong is corrected, not reported, at that case only", () => {
    const key = "H3:Boards that update themselves the moment work moves";
    const defect = {
      check: "production-defects",
      kind: "icon-misaligned",
      route: "/",
      width: 400,
      key,
      selector: "main section li:nth-child(1)",
      message: "icon 16 px off its heading",
    };
    const report = buildRouteReport(
      "/",
      CHECKS.map((c: string) =>
        c === "production-defects"
          ? { ...result(c), defects: [defect] }
          : c === "alignment-diff"
            ? result(c, [
                { kind: "left", width: 400, key, message: "left differs" },
                { kind: "left", width: 1024, key, message: "left differs" },
              ])
            : result(c),
      ),
    );
    // The target fixed the icon at 400 px, so it differs from production there on purpose; at 1024 it must not.
    expect(report.findings).toEqual([
      expect.objectContaining({ check: "alignment-diff", width: 1024 }),
    ]);
    expect(report.corrected).toEqual([
      expect.objectContaining({ check: "alignment-diff", width: 400 }),
    ]);
    expect(report.productionDefects).toEqual([defect]);
    expect(report.ok).toBe(false);
  });

  it("an empty run never passes", () => {
    expect(buildRouteReport("/", []).ok).toBe(false);
  });
});

describe("the CLI", () => {
  it("--help prints the checks and exits 0", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--help"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    for (const name of CHECKS) expect(r.stdout, name).toContain(name);
  });

  it("a missing matrix file fails before any browser starts, naming the file", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, ...base, "--matrix", "nope/breakpoints.json"],
      {
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nope/breakpoints.json");
  });
});
