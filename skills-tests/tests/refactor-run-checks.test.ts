// Unit tests for skills/bascik-refactor/scripts/run-checks.mjs: the single entry point that runs every parity check
// (production defects first, then 1-7, testid carryover and coverage, presence by route) per route and matrix case, writes one report per route and exits nonzero on any
// finding. The browser half (the defect and clean fixture sites) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: agents treated "no flags" from the scripts they happened to run as PASS. One command with every check
// leaves nothing to forget, and its report feeds the human review page.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKS,
  buildRouteReport,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/run-checks.mjs";
import {
  caseId,
  gateLine,
  gateRecord,
  selectCases,
} from "../../skills/bascik-refactor/scripts/lib/matrix.mjs";
import { parseArgsFor } from "../../skills/bascik-refactor/scripts/lib/checks.mjs";

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

  it("--reject and --accepted pass reviewed production-defects false positives through, and a malformed id is refused", () => {
    expect(
      parseCliArgs([
        ...base,
        "--reject",
        "PD-1a2b3c",
        "--accepted",
        "docs/migration/accepted.json",
      ]),
    ).toMatchObject({
      reject: ["PD-1a2b3c"],
      accepted: "docs/migration/accepted.json",
    });
    expect(parseCliArgs(base).reject).toEqual([]);
    expect(() => parseCliArgs([...base, "--reject", "PD-1a2b"])).toThrow(
      /--reject PD-1a2b/,
    );
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
    expect(() => parseCliArgs(noLegacy)).toThrow(/--no-legacy-repo/);
  });

  it("--no-legacy-repo waives testid-carryover with a reason; misuse: next to --legacy-src it is refused", () => {
    const noLegacy = base.slice(0, -2);
    const args = parseCliArgs([...noLegacy, "--no-legacy-repo"]);
    expect(args.only).not.toContain("testid-carryover");
    expect(args.waived).toEqual({
      "testid-carryover": "no legacy repository (--no-legacy-repo)",
    });
    expect(parseCliArgs(base).waived).toEqual({});
    expect(() => parseCliArgs([...base, "--no-legacy-repo"])).toThrow(
      /--no-legacy-repo[\s\S]*--legacy-src/,
    );
  });

  it("rejects a spacing tolerance that is not a number", () => {
    expect(() => parseCliArgs([...base, "--spacing-tolerance", "two"])).toThrow(
      /--spacing-tolerance/,
    );
  });
});

describe("--cases: a subset of the matrix for the iteration loop", () => {
  const MATRIX = [
    { width: 360, height: 812 },
    { width: 360, height: 640 },
    { width: 1024, height: 1024 },
    { width: 1408, height: 900 },
    { width: 1408, height: 900, colorScheme: "dark" },
    { width: 390, height: 844, isMobile: true, hasTouch: true },
    { width: 1280, height: 900, reducedMotion: "no-preference" },
  ];

  it("names each case by its viewport, with a suffix for each variant", () => {
    expect(MATRIX.map(caseId)).toEqual([
      "360x812",
      "360x640",
      "1024x1024",
      "1408x900",
      "1408x900-dark",
      "390x844-mobile-touch",
      "1280x900-motion",
    ]);
  });

  it("selects cases by id, and a bare width selects every case of that width, in matrix order", () => {
    expect(selectCases(MATRIX, ["1408x900-dark", "360x812"])).toEqual([
      MATRIX[0],
      MATRIX[4],
    ]);
    expect(selectCases(MATRIX, ["360"])).toEqual([MATRIX[0], MATRIX[1]]);
    expect(selectCases(MATRIX, ["1408,1024x1024"])).toEqual([
      MATRIX[2],
      MATRIX[3],
      MATRIX[4],
    ]);
    expect(selectCases(MATRIX, [])).toEqual(MATRIX);
    expect(selectCases(MATRIX, undefined)).toEqual(MATRIX);
  });

  it("misuse: an id or width the matrix does not have fails, listing the valid ids", () => {
    expect(() => selectCases(MATRIX, ["375x812"])).toThrow(
      /--cases 375x812[\s\S]*360x812, 360x640, 1024x1024/,
    );
    expect(() => selectCases(MATRIX, ["999"])).toThrow(/999/);
    expect(() => selectCases(MATRIX, [" , "])).toThrow(/--cases/);
  });

  it("run-checks and every check CLI take --cases (repeatable or comma separated)", () => {
    expect(
      parseCliArgs([...base, "--cases", "360x812,1024", "--cases", "1408"])
        .caseIds,
    ).toEqual(["360x812", "1024", "1408"]);
    expect(parseCliArgs(base).caseIds).toEqual([]);
    expect(
      parseArgsFor([
        "--prod",
        "https://a.example",
        "--target",
        "http://b",
        "--route",
        "/",
        "--cases",
        "360",
      ]).caseIds,
    ).toEqual(["360"]);
  });

  it("misuse: run-checks and every check refuse a --target that is production, pointing at production-only mode", () => {
    const prod = ["--prod", "https://www.example.com"];
    expect(() =>
      parseCliArgs([
        ...prod,
        "--target",
        "https://example.com/",
        "--route",
        "/",
        "--legacy-src",
        "../legacy",
      ]),
    ).toThrow(
      /--target https:\/\/example\.com\/ is production.*interaction-crawl, presence-by-route, state-capture and production-defects run on production alone.*capture-baselines/s,
    );
    expect(() =>
      parseArgsFor([
        ...prod,
        "--target",
        "https://www.example.com",
        "--route",
        "/",
      ]),
    ).toThrow(/is production/);
    // Another host, or the same host on another port, is a real target.
    for (const target of [
      "http://localhost:8080",
      "https://staging.example.com",
      "https://www.example.com:8443",
    ])
      expect(
        parseArgsFor([...prod, "--target", target, "--route", "/"]).target,
      ).toBe(target);
    // The checks that compare two sides still need --target by default.
    expect(() => parseArgsFor([...prod, "--route", "/"])).toThrow(
      /--target <url> is required/,
    );
  });

  it("run-checks takes the production cache flags and rejects --refresh-prod with --no-prod-cache", () => {
    expect(parseCliArgs(base)).toMatchObject({
      prodCache: "artifacts/prod-cache",
      refreshProd: false,
    });
    expect(
      parseCliArgs([...base, "--prod-cache", "tmp/pc", "--refresh-prod"]),
    ).toMatchObject({ prodCache: "tmp/pc", refreshProd: true });
    expect(() =>
      parseCliArgs([...base, "--refresh-prod", "--no-prod-cache"]),
    ).toThrow(/--refresh-prod.*--no-prod-cache/);
  });
});

describe("the gate record", () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "bascik-gate-"));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const cases = [
    { width: 360, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ];

  it("records the matrix file, its sha256, the cases run and the total; the full default matrix is not partial", () => {
    const file = join(work, "breakpoints.json");
    writeFileSync(file, JSON.stringify({ cases }));
    const sha = createHash("sha256")
      .update(JSON.stringify({ cases }))
      .digest("hex");
    expect(
      gateRecord({ file, cases, selected: cases, defaultMatrix: file }),
    ).toEqual({
      matrix: file,
      sha256: sha,
      cases: ["360x812", "768x1024", "1280x900"],
      total: 3,
      partial: false,
    });
    expect(
      gateLine(
        gateRecord({ file, cases, selected: cases, defaultMatrix: file }),
      ),
    ).toBeNull();
  });

  it("a subset or another matrix file is partial: an iteration result, not a gate", () => {
    const file = join(work, "breakpoints.json");
    writeFileSync(file, JSON.stringify({ cases }));
    const subset = gateRecord({
      file,
      cases,
      selected: [cases[0]],
      defaultMatrix: file,
    });
    expect(subset).toMatchObject({
      partial: true,
      cases: ["360x812"],
      total: 3,
    });
    expect(gateLine(subset)).toBe(
      "PARTIAL (1 of 3 cases): iteration result, not a gate",
    );
    const iter = join(work, "breakpoints.iter-home.json");
    writeFileSync(iter, JSON.stringify({ cases }));
    const other = gateRecord({
      file: iter,
      cases,
      selected: cases,
      defaultMatrix: file,
    });
    expect(other.partial).toBe(true);
    expect(gateLine(other)).toMatch(
      /^PARTIAL \(3 of 3 cases from .*breakpoints\.iter-home\.json\): iteration result, not a gate$/,
    );
  });

  it("with every check listed, a run that leaves one out is partial and PARTIAL names what it left out", () => {
    const file = join(work, "breakpoints.json");
    writeFileSync(file, JSON.stringify({ cases }));
    const all = gateRecord({
      file,
      cases,
      selected: cases,
      defaultMatrix: file,
      checks: [...CHECKS],
      allChecks: CHECKS,
    });
    expect(all).toMatchObject({
      checks: [...CHECKS],
      skipped: [],
      partial: false,
    });
    expect(gateLine(all)).toBeNull();
    const only = gateRecord({
      file,
      cases,
      selected: cases,
      defaultMatrix: file,
      checks: ["spacing-diff"],
      allChecks: CHECKS,
    });
    expect(only.partial).toBe(true);
    expect(only.skipped).toHaveLength(CHECKS.length - 1);
    expect(gateLine(only)).toBe(
      `PARTIAL (3 of 3 cases; 1 of ${CHECKS.length} checks, without ${CHECKS.filter((c: string) => c !== "spacing-diff").join(", ")}): iteration result, not a gate`,
    );
    const subset = gateRecord({
      file,
      cases,
      selected: [cases[0]],
      defaultMatrix: file,
      checks: CHECKS.filter((c: string) => c !== "interaction-crawl"),
      allChecks: CHECKS,
    });
    expect(gateLine(subset)).toBe(
      `PARTIAL (1 of 3 cases; ${CHECKS.length - 1} of ${CHECKS.length} checks, without interaction-crawl): iteration result, not a gate`,
    );
    // A waived check (testid-carryover with --no-legacy-repo) is recorded with its reason and keeps the run whole.
    const waived = gateRecord({
      file,
      cases,
      selected: cases,
      defaultMatrix: file,
      checks: CHECKS.filter((c: string) => c !== "testid-carryover"),
      allChecks: CHECKS,
      waived: { "testid-carryover": "no legacy repository (--no-legacy-repo)" },
    });
    expect(waived).toMatchObject({ skipped: [], partial: false });
    expect(waived.waived).toEqual({
      "testid-carryover": "no legacy repository (--no-legacy-repo)",
    });
  });

  it("buildRouteReport carries the gate record and the production cache numbers into report.json", () => {
    const gate = {
      matrix: "m.json",
      sha256: "x",
      cases: [],
      total: 1,
      partial: true,
    };
    const production = {
      cache: "artifacts/prod-cache",
      fromCache: 2,
      captured: 0,
      oldestCachedAt: "2026-10-30T00:00:00.000Z",
    };
    const report = buildRouteReport(
      "/",
      CHECKS.map((c: string) => ({ check: c, ok: true, findings: [] })),
      { gate, production },
    );
    expect(report.gate).toEqual(gate);
    expect(report.production).toEqual(production);
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

  it("keeps the rejected production defects of the route and every rejection with its source, so the gate record shows them", () => {
    const rejectedDefect = {
      check: "production-defects",
      kind: "text-overflow",
      route: "/",
      width: 400,
      key: "SPAN:MILKFROTHER",
      selector: "header a > span",
      message: "overflows its box",
      id: "PD-1a2b3c",
      sources: ["--reject"],
    };
    const rejections = [
      { id: "PD-1a2b3c", source: "--reject", matched: 2 },
      { id: "PD-00ff00", source: "D-07", ledgerRow: true, matched: 0 },
    ];
    const report = buildRouteReport(
      "/",
      CHECKS.map((c: string) =>
        c === "production-defects"
          ? {
              ...result(c),
              defects: [],
              rejected: [rejectedDefect, { ...rejectedDefect, route: "/shop" }],
              rejections,
            }
          : result(c),
      ),
    );
    expect(report.rejectedDefects).toEqual([rejectedDefect]);
    expect(report.rejections).toEqual(rejections);
    // A rejection is not a finding: the route still passes on its findings alone.
    expect(report.ok).toBe(true);
    // A run without production-defects records none.
    expect(buildRouteReport("/", [result("spacing-diff")])).toMatchObject({
      rejectedDefects: [],
      rejections: [],
    });
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

  it("misuse: --cases with no match in the matrix fails before any browser starts, listing the valid ids", () => {
    const work = mkdtempSync(join(tmpdir(), "bascik-cases-"));
    try {
      const matrix = join(work, "breakpoints.json");
      writeFileSync(
        matrix,
        JSON.stringify({
          cases: [
            { width: 360, height: 812 },
            { width: 1280, height: 900 },
          ],
        }),
      );
      const r = spawnSync(
        process.execPath,
        [SCRIPT, ...base, "--matrix", matrix, "--cases", "375"],
        { cwd: work, encoding: "utf8" },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--cases 375/);
      expect(r.stderr).toContain("360x812, 1280x900");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("misuse: --refresh-prod with --no-prod-cache exits 1 naming both flags", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, ...base, "--refresh-prod", "--no-prod-cache"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--refresh-prod.*--no-prod-cache/);
  });
});
