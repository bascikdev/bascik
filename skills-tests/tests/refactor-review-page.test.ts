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
    write(
      "artifacts/checks/about/report.json",
      JSON.stringify({ route: "/about", ok: true, findings: [] }),
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
