// Unit tests for skills/bascik-refactor/scripts/review-page.mjs: the static side-by-side page a human reviews per
// route, the sign-off file it produces ({ route, reviewer, verdict, notes, date } in docs/migration/review/), and the
// --verify gate the driver runs before it marks a route PASS. The browser half (the diff toggle and the download) is
// in refactor-parity-checks.integration.test.ts.
//
// Why it exists: a human looking at production and the target side by side caught what every automated check passed.
// No route passes without a human pass verdict.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKLIST,
  parseCliArgs,
  renderReviewPage,
  routeSlug,
  validateSignOff,
  verifySignOffs,
  writeSignOff,
} from "../../skills/bascik-refactor/scripts/review-page.mjs";
import {
  CHECKS,
  buildRouteReport,
  parseCliArgs as parseRunChecksArgs,
  runChecksMatrix,
} from "../../skills/bascik-refactor/scripts/run-checks.mjs";
import { gateLine } from "../../skills/bascik-refactor/scripts/lib/matrix.mjs";

/** What run-checks records about production for a run that measured it fresh (--refresh-prod). */
const FRESH = {
  cache: "artifacts/prod-cache",
  refreshed: true,
  fromCache: 0,
  captured: 2,
};

const SCRIPT = fileURLToPath(
  new URL(
    "../../skills/bascik-refactor/scripts/review-page.mjs",
    import.meta.url,
  ),
);
// A 1x1 white PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bascik-review-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, data: string | Buffer) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), data);
};
const signOff = (over: Record<string, unknown> = {}) => ({
  route: "/",
  reviewer: "Sam Rivera",
  verdict: "pass",
  notes: "",
  date: "2026-10-28",
  ...over,
});

describe("routeSlug", () => {
  it("matches the folder names compare-route.mjs writes", () => {
    expect(routeSlug("/")).toBe("index");
    expect(routeSlug("/about")).toBe("about");
    expect(routeSlug("/pricing/team/")).toBe("pricing_team");
  });
});

describe("CHECKLIST", () => {
  it("has the seven issue types a human caught, in order", () => {
    expect(CHECKLIST).toHaveLength(7);
    const patterns = [
      /interaction|scroll/i,
      /dropdown|menu/i,
      /repeated|component/i,
      /link|font weight|colou?r/i,
      /spacing/i,
      /align|breakpoint/i,
      /overlap/i,
    ];
    patterns.forEach((re, i) => expect(CHECKLIST[i], String(re)).toMatch(re));
  });
});

describe("renderReviewPage", () => {
  const data = () => ({
    route: "/about",
    cases: [
      {
        width: 400,
        height: 800,
        prod: join(dir, "prod-400x800.png"),
        target: join(dir, "target-400x800.png"),
      },
      {
        width: 1024,
        height: 800,
        prod: join(dir, "prod-1024x800.png"),
        target: join(dir, "target-1024x800.png"),
      },
    ],
    states: [
      {
        anchor: "BUTTON:Products",
        width: 1024,
        prod: { crop: join(dir, "open-prod.png") },
        target: { crop: join(dir, "open-target.png") },
      },
    ],
    findings: [
      {
        check: "spacing-diff",
        kind: "gap",
        width: 400,
        message: "gap before UL differs by 24 px",
      },
      {
        check: "text-style-diff",
        kind: "style",
        width: 1024,
        message: "A:<script>alert(1)</script> color",
      },
    ],
    base: dir,
  });

  it("puts production and the target side by side for every matrix case, with a diff overlay toggle", () => {
    const html = renderReviewPage(data());
    expect(html).toMatch(/<title>[^<]*\/about[^<]*<\/title>/);
    expect(html.match(/data-testid="review-case"/g)).toHaveLength(2);
    expect(html).toContain("400x800");
    expect(html).toContain("1024x800");
    expect(html).toContain('data-testid="diff-toggle"');
    expect(html).toContain('data-testid="diff-overlay"');
  });

  it("shows the open states and lists the findings beside the images, escaped", () => {
    const html = renderReviewPage(data());
    expect(html).toContain('data-testid="review-state"');
    expect(html).toContain("BUTTON:Products");
    expect(html).toContain("spacing-diff");
    expect(html).toContain("gap before UL differs by 24 px");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows the seven-point checklist and a sign-off form for docs/migration/review/<route>.json", () => {
    const html = renderReviewPage(data());
    for (const item of CHECKLIST) expect(html).toContain(item);
    for (const id of [
      "review-reviewer",
      "review-verdict",
      "review-notes",
      "review-submit",
    ])
      expect(html, id).toContain(`data-testid="${id}"`);
    const verdict =
      /<select[^>]*data-testid="review-verdict"[^>]*>([\s\S]*?)<\/select>/.exec(
        html,
      )?.[1] ?? "";
    expect(
      [...verdict.matchAll(/<option[^>]*value="([^"]*)"/g)]
        .map((m) => m[1])
        .filter(Boolean)
        .sort(),
    ).toEqual(["issues", "pass"]);
    expect(html).toContain("docs/migration/review/about.json");
  });

  it("every image resolves from the page's folder, or is inline", () => {
    for (const name of [
      "prod-400x800.png",
      "target-400x800.png",
      "prod-1024x800.png",
      "target-1024x800.png",
      "open-prod.png",
      "open-target.png",
    ])
      write(name, PNG);
    const html = renderReviewPage(data());
    const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(srcs.length).toBeGreaterThanOrEqual(6);
    for (const src of srcs)
      expect(
        src.startsWith("data:") || existsSync(resolve(dir, decodeURI(src))),
        src,
      ).toBe(true);
  });

  it("loads nothing from the network: a reviewer can open it from disk", () => {
    const html = renderReviewPage(data());
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  });
});

describe("validateSignOff", () => {
  it("accepts a pass and an issues verdict with notes", () => {
    expect(() => validateSignOff(signOff())).not.toThrow();
    expect(() =>
      validateSignOff(
        signOff({ verdict: "issues", notes: "Dropdown icons missing" }),
      ),
    ).not.toThrow();
  });

  it("names the field for each mistake", () => {
    expect(() => validateSignOff(signOff({ verdict: "passed" }))).toThrow(
      /verdict.*pass.*issues/,
    );
    expect(() => validateSignOff(signOff({ reviewer: " " }))).toThrow(
      /reviewer/,
    );
    expect(() => validateSignOff(signOff({ route: "about" }))).toThrow(/route/);
    expect(() => validateSignOff(signOff({ date: "yesterday" }))).toThrow(
      /date/,
    );
    expect(() =>
      validateSignOff(signOff({ verdict: "issues", notes: "" })),
    ).toThrow(/notes/);
  });

  it("rejects keys it does not know, so a typo is not ignored", () => {
    expect(() => validateSignOff({ ...signOff(), verdit: "pass" })).toThrow(
      /verdit/,
    );
  });
});

describe("writeSignOff and verifySignOffs", () => {
  it("writes docs/migration/review/<slug>.json and the gate accepts it", () => {
    const review = join(dir, "docs/migration/review");
    const file = writeSignOff({ dir: review, ...signOff({ route: "/about" }) });
    expect(file).toBe(join(review, "about.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      signOff({ route: "/about" }),
    );
    expect(verifySignOffs(review, ["/about"])).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("fails without a file, on an issues verdict, on bad JSON and on a file for another route", () => {
    const review = join(dir, "review");
    write(
      "review/about.json",
      JSON.stringify(
        signOff({ route: "/about", verdict: "issues", notes: "Spacing" }),
      ),
    );
    write("review/pricing.json", "{ not json");
    write("review/contact.json", JSON.stringify(signOff({ route: "/" })));
    const result = verifySignOffs(review, [
      "/",
      "/about",
      "/pricing",
      "/contact",
    ]);
    expect(result.ok).toBe(false);
    const text = result.problems.join("\n");
    expect(text).toContain(join(review, "index.json"));
    expect(text).toMatch(/about\.json[^\n]*issues/);
    expect(text).toMatch(/pricing\.json[^\n]*JSON/i);
    expect(text).toMatch(/contact\.json[^\n]*route/);
  });
});

describe("verifySignOffs: only a full-matrix run-checks report is a gate", () => {
  const MATRIX = JSON.stringify({
    cases: [
      { width: 360, height: 812 },
      { width: 1280, height: 900 },
    ],
  });
  const sha = createHash("sha256").update(MATRIX).digest("hex");
  const gate = (over: Record<string, unknown> = {}) => ({
    matrix: "docs/migration/breakpoints.json",
    sha256: sha,
    cases: ["360x812", "1280x900"],
    total: 2,
    checks: [...CHECKS],
    skipped: [],
    partial: false,
    ...over,
  });
  const setup = (report: Record<string, unknown>) => {
    write("docs/migration/breakpoints.json", MATRIX);
    write(
      "artifacts/checks/about/report.json",
      JSON.stringify({
        route: "/about",
        ok: true,
        findings: [],
        production: FRESH,
        ...report,
      }),
    );
    writeSignOff({
      dir: join(dir, "review"),
      ...signOff({ route: "/about" }),
    });
  };
  const verify = (extra: Record<string, unknown> = {}) =>
    verifySignOffs(join(dir, "review"), ["/about"], {
      checks: join(dir, "artifacts/checks"),
      matrix: join(dir, "docs/migration/breakpoints.json"),
      ...extra,
    });

  it("accepts a passing report of the full matrix in docs/migration/breakpoints.json", () => {
    setup({ gate: gate() });
    expect(verify()).toEqual({ ok: true, problems: [] });
  });

  it("refuses a partial report (a --cases subset or an iteration matrix)", () => {
    setup({ gate: gate({ partial: true, cases: ["360x812"] }) });
    const result = verify();
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(
      /partial run \(1 of 2 cases\)[\s\S]*full matrix/,
    );
  });

  it("refuses a report whose matrix hash differs from docs/migration/breakpoints.json", () => {
    setup({ gate: gate({ sha256: "0".repeat(64) }) });
    expect(verify().problems.join("\n")).toMatch(
      /breakpoints\.json changed since this run|another matrix/,
    );
  });

  it("refuses a report that records no matrix (written before run-checks recorded one)", () => {
    setup({});
    expect(verify().problems.join("\n")).toMatch(/records no matrix/);
  });

  it("refuses a full-matrix run that left out a check (--only or --skip), naming what it left out", () => {
    setup({
      gate: gate({
        checks: ["spacing-diff"],
        skipped: CHECKS.filter((c: string) => c !== "spacing-diff"),
        partial: true,
      }),
    });
    const text = verify().problems.join("\n");
    expect(text).toMatch(
      /ran 1 of \d+ checks, without [^\n]*interaction-crawl[\s\S]*every check/,
    );
    // A forged or hand-edited record that drops a check but claims a full run is still refused.
    setup({
      gate: gate({
        checks: CHECKS.filter((c: string) => c !== "interaction-crawl"),
      }),
    });
    expect(verify().problems.join("\n")).toMatch(/without interaction-crawl/);
  });

  it("refuses a report that records no list of the checks it ran", () => {
    const { checks: _checks, skipped: _skipped, ...old } = gate();
    setup({ gate: old });
    expect(verify().problems.join("\n")).toMatch(/no list of the checks/);
  });

  it("accepts testid-carryover waived by --no-legacy-repo, and no other waiver", () => {
    const rest = CHECKS.filter((c: string) => c !== "testid-carryover");
    setup({
      gate: gate({
        checks: rest,
        waived: {
          "testid-carryover": "no legacy repository (--no-legacy-repo)",
        },
      }),
    });
    expect(verify()).toEqual({ ok: true, problems: [] });
    const noCrawl = CHECKS.filter((c: string) => c !== "interaction-crawl");
    setup({
      gate: gate({
        checks: noCrawl,
        waived: { "interaction-crawl": "too slow" },
      }),
    });
    expect(verify().problems.join("\n")).toMatch(/without interaction-crawl/);
  });

  it("refuses, by default, cached production measured more than a day ago; --max-prod-age moves the limit", () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    setup({
      gate: gate(),
      production: { fromCache: 10, captured: 0, oldestCachedAt: old },
    });
    const result = verify();
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(
      /older than --max-prod-age \(1d\)[\s\S]*--refresh-prod/,
    );
    expect(verify({ maxProdAge: 2 * 86_400_000 }).ok).toBe(false);
    expect(verify({ maxProdAge: 4 * 86_400_000 }).ok).toBe(true);
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    setup({
      gate: gate(),
      production: { fromCache: 10, captured: 0, oldestCachedAt: recent },
    });
    expect(verify()).toEqual({ ok: true, problems: [] });
  });

  it("refuses a report with no production record, or cached production of unknown age", () => {
    setup({ gate: gate(), production: undefined });
    expect(verify().problems.join("\n")).toMatch(/no production measurement/);
    setup({ gate: gate(), production: { fromCache: 3, captured: 0 } });
    expect(verify().problems.join("\n")).toMatch(/unknown age/);
    setup({
      gate: gate(),
      production: { fromCache: 0, captured: 0, oldestCachedAt: "not a date" },
    });
    expect(verify().ok).toBe(false);
  });

  it("misuse: run-checks --only or --skip on the full default matrix prints PARTIAL, and its report is refused", () => {
    write("docs/migration/breakpoints.json", MATRIX);
    const matrix = join(dir, "docs/migration/breakpoints.json");
    const base = [
      "--prod",
      "https://example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/about",
      "--legacy-src",
      "legacy",
      "--matrix",
      matrix,
    ];
    for (const extra of [
      ["--only", "spacing-diff"],
      ["--skip", "interaction-crawl"],
      ["--skip", "testid-carryover"],
    ]) {
      const args = parseRunChecksArgs([...base, ...extra]);
      const { gate: record } = runChecksMatrix(args, matrix);
      expect(record.partial, extra.join(" ")).toBe(true);
      expect(gateLine(record)).toMatch(
        /^PARTIAL \(2 of 2 cases; \d+ of \d+ checks, without /,
      );
      const report = buildRouteReport(
        "/about",
        args.only.map((c: string) => ({ check: c, ok: true, findings: [] })),
        { expected: args.only, gate: record, production: FRESH },
      );
      write("artifacts/checks/about/report.json", JSON.stringify(report));
      writeSignOff({
        dir: join(dir, "review"),
        ...signOff({ route: "/about" }),
      });
      const result = verify();
      expect(result.ok, extra.join(" ")).toBe(false);
      expect(result.problems.join("\n")).toMatch(/checks, without/);
    }
    // Every check (testid-carryover waived because there is no legacy repository) is the gate.
    const noLegacy = parseRunChecksArgs([
      ...base.filter(
        (a, i) => a !== "--legacy-src" && base[i - 1] !== "--legacy-src",
      ),
      "--no-legacy-repo",
    ]);
    const { gate: full } = runChecksMatrix(noLegacy, matrix);
    expect(full.partial).toBe(false);
    expect(gateLine(full)).toBeNull();
  });
});

describe("parseCliArgs", () => {
  it("has three modes: build pages, sign, verify", () => {
    expect(parseCliArgs(["--route", "/"])).toMatchObject({
      mode: "build",
      route: ["/"],
      compare: "artifacts/compare",
      checks: "artifacts/checks",
      out: "artifacts/review",
    });
    expect(
      parseCliArgs([
        "--sign",
        "--route",
        "/",
        "--reviewer",
        "Sam Rivera",
        "--verdict",
        "pass",
      ]),
    ).toMatchObject({
      mode: "sign",
      dir: "docs/migration/review",
      reviewer: "Sam Rivera",
      verdict: "pass",
    });
    expect(parseCliArgs(["--verify", "--route", "/"])).toMatchObject({
      mode: "verify",
    });
  });

  it("--max-prod-age takes days, hours or minutes, and rejects anything else", () => {
    expect(
      parseCliArgs(["--verify", "--route", "/"]).maxProdAge,
    ).toBeUndefined();
    expect(
      parseCliArgs(["--verify", "--route", "/", "--max-prod-age", "7d"])
        .maxProdAge,
    ).toBe(7 * 86_400_000);
    expect(
      parseCliArgs(["--verify", "--route", "/", "--max-prod-age", "12h"])
        .maxProdAge,
    ).toBe(12 * 3_600_000);
    expect(() =>
      parseCliArgs(["--verify", "--route", "/", "--max-prod-age", "soon"]),
    ).toThrow(/--max-prod-age/);
  });

  it("refuses --sign and --verify together, and --sign for several routes", () => {
    expect(() => parseCliArgs(["--sign", "--verify", "--route", "/"])).toThrow(
      /--sign.*--verify|--verify.*--sign/,
    );
    expect(() =>
      parseCliArgs([
        "--sign",
        "--route",
        "/",
        "--route",
        "/about",
        "--reviewer",
        "A",
        "--verdict",
        "pass",
      ]),
    ).toThrow(/one --route/);
  });
});

describe("the CLI", () => {
  const node = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
    });

  it("--verify exits 1 naming the missing file, and 0 once a pass verdict is signed for the run in the reports", () => {
    // --sign records which run it reviewed, from the compare-route and run-checks reports the page showed.
    write("artifacts/compare/about/target-400x800.png", PNG);
    write(
      "artifacts/compare/about/report.json",
      JSON.stringify({
        route: "/about",
        cases: [
          {
            width: 400,
            height: 800,
            screenshots: {
              prod: "artifacts/compare/about/target-400x800.png",
              target: "artifacts/compare/about/target-400x800.png",
            },
          },
        ],
      }),
    );
    const matrix = JSON.stringify({ cases: [{ width: 400, height: 800 }] });
    write("docs/migration/breakpoints.json", matrix);
    write(
      "artifacts/checks/about/report.json",
      JSON.stringify({
        route: "/about",
        ok: true,
        findings: [],
        gate: {
          matrix: "docs/migration/breakpoints.json",
          sha256: createHash("sha256").update(matrix).digest("hex"),
          cases: ["400x800"],
          total: 1,
          checks: [...CHECKS],
          skipped: [],
          partial: false,
        },
        production: FRESH,
      }),
    );
    const missing = node(["--verify", "--route", "/about", "--dir", "review"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout + missing.stderr).toContain("about.json");
    const signed = node([
      "--sign",
      "--route",
      "/about",
      "--reviewer",
      "Sam Rivera",
      "--verdict",
      "pass",
      "--dir",
      "review",
    ]);
    expect(signed.status, signed.stderr).toBe(0);
    expect(existsSync(join(dir, "review/about.json"))).toBe(true);
    expect(
      node(["--verify", "--route", "/about", "--dir", "review"]).status,
    ).toBe(0);
  });

  it("misuse: --sign and --verify refuse a full-matrix run-checks report of only some checks, or of stale production", () => {
    write("artifacts/compare/about/target-400x800.png", PNG);
    write(
      "artifacts/compare/about/report.json",
      JSON.stringify({
        route: "/about",
        cases: [
          {
            width: 400,
            height: 800,
            screenshots: {
              prod: "artifacts/compare/about/target-400x800.png",
              target: "artifacts/compare/about/target-400x800.png",
            },
          },
        ],
      }),
    );
    const matrix = JSON.stringify({ cases: [{ width: 400, height: 800 }] });
    write("docs/migration/breakpoints.json", matrix);
    const gate = {
      matrix: "docs/migration/breakpoints.json",
      sha256: createHash("sha256").update(matrix).digest("hex"),
      cases: ["400x800"],
      total: 1,
      checks: ["spacing-diff"],
      skipped: CHECKS.filter((c: string) => c !== "spacing-diff"),
      partial: true,
    };
    const report = (over: Record<string, unknown>) =>
      write(
        "artifacts/checks/about/report.json",
        JSON.stringify({
          route: "/about",
          ok: true,
          findings: [],
          gate,
          production: FRESH,
          ...over,
        }),
      );
    const sign = () =>
      node([
        "--sign",
        "--route",
        "/about",
        "--reviewer",
        "Sam Rivera",
        "--verdict",
        "pass",
        "--dir",
        "review",
      ]);
    report({});
    const onlySome = sign();
    expect(onlySome.status).toBe(1);
    expect(onlySome.stderr).toMatch(/checks, without/);
    expect(existsSync(join(dir, "review/about.json"))).toBe(false);

    const stale = {
      fromCache: 4,
      captured: 0,
      oldestCachedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    };
    report({
      gate: { ...gate, checks: [...CHECKS], skipped: [], partial: false },
      production: stale,
    });
    const staleSign = sign();
    expect(staleSign.status).toBe(1);
    expect(staleSign.stderr).toMatch(/--refresh-prod/);

    // A full fresh run signs; --verify then refuses the report once it is replaced by an --only run.
    report({
      gate: { ...gate, checks: [...CHECKS], skipped: [], partial: false },
    });
    expect(sign().status).toBe(0);
    expect(
      node(["--verify", "--route", "/about", "--dir", "review"]).status,
    ).toBe(0);
    report({});
    const verified = node(["--verify", "--route", "/about", "--dir", "review"]);
    expect(verified.status).toBe(1);
    expect(verified.stdout + verified.stderr).toMatch(/checks, without/);
  });

  it("misuse: --sign refuses a partial run-checks report", () => {
    write("artifacts/compare/about/target-400x800.png", PNG);
    write(
      "artifacts/compare/about/report.json",
      JSON.stringify({
        route: "/about",
        cases: [
          {
            width: 400,
            height: 800,
            screenshots: {
              prod: "artifacts/compare/about/target-400x800.png",
              target: "artifacts/compare/about/target-400x800.png",
            },
          },
        ],
      }),
    );
    write(
      "artifacts/checks/about/report.json",
      JSON.stringify({
        route: "/about",
        ok: true,
        findings: [],
        gate: {
          matrix: "docs/migration/breakpoints.iter-about.json",
          sha256: "0".repeat(64),
          cases: ["400x800"],
          total: 1,
          partial: true,
        },
      }),
    );
    const signed = node([
      "--sign",
      "--route",
      "/about",
      "--reviewer",
      "Sam Rivera",
      "--verdict",
      "pass",
      "--dir",
      "review",
    ]);
    expect(signed.status).toBe(1);
    expect(signed.stderr).toMatch(/partial/);
    expect(existsSync(join(dir, "review/about.json"))).toBe(false);
  });

  it("builds artifacts/review/<slug>.html from the compare and checks reports", () => {
    for (const side of ["prod", "target"])
      write(`artifacts/compare/about/${side}-400x800.png`, PNG);
    write(
      "artifacts/compare/about/report.json",
      JSON.stringify({
        route: "/about",
        cases: [
          {
            width: 400,
            height: 800,
            screenshots: {
              prod: "artifacts/compare/about/prod-400x800.png",
              target: "artifacts/compare/about/target-400x800.png",
            },
          },
        ],
      }),
    );
    write(
      "artifacts/checks/about/report.json",
      JSON.stringify({
        route: "/about",
        ok: false,
        findings: [
          {
            check: "overlap-diff",
            kind: "offset",
            width: 400,
            message: "LI:Design review icon 2 px off",
          },
        ],
        checks: {},
        states: [],
      }),
    );
    const result = node(["--route", "/about"]);
    expect(result.status, result.stderr).toBe(0);
    const html = readFileSync(join(dir, "artifacts/review/about.html"), "utf8");
    expect(html).toContain("LI:Design review icon 2 px off");
    expect(html).toContain("400x800");
  });

  it("a missing compare report is a located error, not an empty page", () => {
    const result = node(["--route", "/about"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      join("artifacts", "compare", "about", "report.json"),
    );
  });
});
