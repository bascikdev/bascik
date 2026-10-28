// Unit tests for skills/bascik-refactor/scripts/lighthouse-gate.mjs: the five-category gate over Lighthouse result
// (LHR) JSON. Performance, Accessibility, Best Practices and SEO must score exactly 1. Agentic Browsing is a
// fraction category, so it passes when every passable audit passes under Lighthouse's own rule (manual,
// notApplicable and hidden audits skipped, informative not counted, otherwise score >= 0.9). Fixtures are small
// objects written here or to a temp dir; no network, no Chrome.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agenticFraction,
  evaluateLhr,
  gate,
  parseCliArgs,
  readLhrs,
} from "../../skills/bascik-refactor/scripts/lighthouse-gate.mjs";

type Audit = { score: number | null; scoreDisplayMode: string };

const AGENTIC_IDS = [
  "agent-accessibility-tree",
  "webmcp-form-coverage",
  "webmcp-registered-tools",
  "webmcp-schema-validity",
  "cumulative-layout-shift",
  "llms-txt",
  "ard-schema",
];

/** A minimal LHR: four scored categories plus agentic-browsing, every audit passing unless overridden. */
const lhr = (
  overrides: {
    url?: string;
    formFactor?: string;
    scores?: Partial<Record<string, number | null>>;
    audits?: Record<string, Audit>;
    drop?: string[];
  } = {},
) => {
  const audits: Record<string, Audit> = {};
  for (const id of AGENTIC_IDS)
    audits[id] = { score: 1, scoreDisplayMode: "binary" };
  for (const id of [
    "webmcp-form-coverage",
    "webmcp-registered-tools",
    "webmcp-schema-validity",
  ])
    audits[id] = { score: null, scoreDisplayMode: "notApplicable" };
  audits["cumulative-layout-shift"] = { score: 1, scoreDisplayMode: "numeric" };
  Object.assign(audits, overrides.audits);
  const categories: Record<string, unknown> = {
    performance: { id: "performance", score: 1, auditRefs: [] },
    accessibility: { id: "accessibility", score: 1, auditRefs: [] },
    "best-practices": { id: "best-practices", score: 1, auditRefs: [] },
    seo: { id: "seo", score: 1, auditRefs: [] },
    "agentic-browsing": {
      id: "agentic-browsing",
      score: 1,
      auditRefs: AGENTIC_IDS.map((id) => ({ id, weight: 1 })),
    },
  };
  for (const [id, score] of Object.entries(overrides.scores ?? {}))
    (categories[id] as { score: number | null }).score = score ?? null;
  for (const id of overrides.drop ?? []) delete categories[id];
  return {
    lighthouseVersion: "13.5.0",
    requestedUrl: overrides.url ?? "http://localhost:8080/",
    finalDisplayedUrl: overrides.url ?? "http://localhost:8080/",
    configSettings: { formFactor: overrides.formFactor ?? "mobile" },
    categories,
    audits,
  };
};

describe("agenticFraction", () => {
  it("skips notApplicable and manual audits", () => {
    expect(
      agenticFraction(
        lhr({
          audits: { "ard-schema": { score: null, scoreDisplayMode: "manual" } },
        }),
      ),
    ).toEqual({ passed: 3, total: 3, failed: [] });
  });

  it("does not count informative audits, and a failing one is reported as failed", () => {
    expect(
      agenticFraction(
        lhr({
          audits: { "llms-txt": { score: 0, scoreDisplayMode: "binary" } },
        }),
      ),
    ).toEqual({ passed: 3, total: 4, failed: ["llms-txt"] });
    expect(
      agenticFraction(
        lhr({
          audits: {
            "ard-schema": { score: null, scoreDisplayMode: "informative" },
          },
        }),
      ),
    ).toEqual({ passed: 3, total: 3, failed: [] });
  });

  it("passes a numeric audit at 0.9 and fails it at 0.89; an error audit fails", () => {
    const at = (score: number) =>
      agenticFraction(
        lhr({
          audits: {
            "cumulative-layout-shift": { score, scoreDisplayMode: "numeric" },
          },
        }),
      ).failed;
    expect(at(0.9)).toEqual([]);
    expect(at(0.89)).toEqual(["cumulative-layout-shift"]);
    expect(
      agenticFraction(
        lhr({
          audits: {
            "agent-accessibility-tree": {
              score: null,
              scoreDisplayMode: "error",
            },
          },
        }),
      ).failed,
    ).toEqual(["agent-accessibility-tree"]);
  });

  it("skips audits in the hidden group", () => {
    const report = lhr({
      audits: { "llms-txt": { score: 0, scoreDisplayMode: "binary" } },
    });
    const refs = (
      report.categories["agentic-browsing"] as {
        auditRefs: { id: string; group?: string }[];
      }
    ).auditRefs;
    refs.find((r) => r.id === "llms-txt")!.group = "hidden";
    expect(agenticFraction(report).failed).toEqual([]);
  });
});

describe("evaluateLhr", () => {
  it("all five categories passing passes, and the result names the URL", () => {
    const result = evaluateLhr(lhr(), { formFactor: "mobile" });
    expect(result).toMatchObject({
      requestedUrl: "http://localhost:8080/",
      formFactor: "mobile",
      ok: true,
      failures: [],
    });
    expect(result.scores).toMatchObject({
      performance: 1,
      accessibility: 1,
      "best-practices": 1,
      seo: 1,
      "agentic-browsing": "4/4",
    });
  });

  it("Performance at 0.99 fails: the gate is exactly 1, not a rounded 100", () => {
    const result = evaluateLhr(lhr({ scores: { performance: 0.99 } }), {
      formFactor: "mobile",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/performance.*0\.99/);
  });

  it("agentic browsing with WebMCP notApplicable and the rest passing passes, even if its category score is not 1", () => {
    const result = evaluateLhr(lhr({ scores: { "agentic-browsing": 0.86 } }), {
      formFactor: "mobile",
    });
    expect(result.ok).toBe(true);
  });

  it("llms-txt at 0 fails agentic browsing by audit id", () => {
    const result = evaluateLhr(
      lhr({ audits: { "llms-txt": { score: 0, scoreDisplayMode: "binary" } } }),
      { formFactor: "mobile" },
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/agentic-browsing.*llms-txt/);
  });

  it("misuse: a desktop report checked as mobile fails", () => {
    const result = evaluateLhr(lhr({ formFactor: "desktop" }), {
      formFactor: "mobile",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/formFactor.*desktop.*mobile/);
  });

  it("misuse: a missing category fails by name (an old Lighthouse without Agentic Browsing)", () => {
    const result = evaluateLhr(lhr({ drop: ["agentic-browsing"] }), {
      formFactor: "mobile",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/agentic-browsing.*missing/);
  });

  it("misuse: a null category score (a run that errored) fails", () => {
    const result = evaluateLhr(lhr({ scores: { seo: null } }), {
      formFactor: "mobile",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/seo/);
  });
});

describe("gate", () => {
  it("passes when every report passes and every expected URL is covered", () => {
    const result = gate(
      [lhr(), lhr({ url: "http://localhost:8080/contact" })],
      {
        formFactor: "mobile",
        expectUrls: ["http://localhost:8080/", "http://localhost:8080/contact"],
      },
    );
    expect(result.ok).toBe(true);
    expect(
      result.pages.map((p: { requestedUrl: string }) => p.requestedUrl),
    ).toEqual(["http://localhost:8080/", "http://localhost:8080/contact"]);
  });

  it("reports an expected URL with no report and a report for a URL not in the list", () => {
    const result = gate([lhr(), lhr({ url: "http://localhost:8080/old" })], {
      formFactor: "mobile",
      expectUrls: ["http://localhost:8080/", "http://localhost:8080/contact"],
    });
    expect(result.ok).toBe(false);
    expect(result.missingUrls).toEqual(["http://localhost:8080/contact"]);
    expect(result.unexpectedUrls).toEqual(["http://localhost:8080/old"]);
  });

  it("misuse: no reports at all never pass", () => {
    expect(gate([], { formFactor: "mobile" }).ok).toBe(false);
  });
});

describe("reading reports and flags", () => {
  it("reads lighthouse --output=json files and the lhr-*.json files lhci writes, skipping others", () => {
    const dir = mkdtempSync(join(tmpdir(), "lighthouse-gate-"));
    try {
      writeFileSync(join(dir, "home.report.json"), JSON.stringify(lhr()));
      writeFileSync(
        join(dir, "lhr-1700000000000.json"),
        JSON.stringify(lhr({ url: "http://localhost:8080/contact" })),
      );
      writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ url: "x" }]));
      writeFileSync(join(dir, "notes.txt"), "not a report");
      const reports = readLhrs({ dir });
      expect(
        reports.map((r: { requestedUrl: string }) => r.requestedUrl).sort(),
      ).toEqual(["http://localhost:8080/", "http://localhost:8080/contact"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("misuse: an unreadable report names the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lighthouse-gate-"));
    try {
      writeFileSync(join(dir, "lhr-1.json"), "{ truncated");
      expect(() => readLhrs({ dir })).toThrow(/lhr-1\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses --dir, --form-factor, --expect-urls and file arguments", () => {
    expect(
      parseCliArgs([
        "--dir",
        ".lighthouseci",
        "--form-factor",
        "desktop",
        "--expect-urls",
        "docs/migration/urls.txt",
        "extra.json",
      ]),
    ).toMatchObject({
      dir: ".lighthouseci",
      formFactor: "desktop",
      expectUrls: "docs/migration/urls.txt",
      files: ["extra.json"],
    });
  });

  it("misuse: an unknown --form-factor is rejected", () => {
    expect(() => parseCliArgs(["--form-factor", "tablet"])).toThrow(
      /--form-factor.*mobile.*desktop/,
    );
  });

  it("misuse: neither --dir nor files is rejected", () => {
    expect(() => parseCliArgs(["--form-factor", "mobile"])).toThrow(/--dir/);
  });
});
