// Unit tests for skills/bascik-refactor/scripts/spacing-diff.mjs: per-section vertical gaps between consecutive
// visible block siblings and each child's offset from its section top, at a 2 px default tolerance. The browser half
// is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: vertical spacing between elements was off by tens of pixels, and absolute geometry at |dy| > 12
// hid local errors behind cumulative drift. Measuring inside each section resets the drift.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  DEFAULT_TOLERANCE,
  diffSpacing,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/spacing-diff.mjs";

type Child = { key: string; offset: number; gap: number | null };
const section = (key: string, children: Child[]) => ({ key, children });
const stack = (gaps: number[], first = 48): Child[] => {
  const keys = [
    "H2:How it works",
    "P:Three steps",
    "UL:Import your tasks",
    "A:Start free",
  ];
  let offset = first;
  return keys.map((key, i) => {
    if (i > 0) offset += 36 + gaps[i - 1];
    return { key, offset, gap: i === 0 ? null : gaps[i - 1] };
  });
};

describe("constants", () => {
  it("names the check and defaults to 2 px", () => {
    expect(CHECK).toBe("spacing-diff");
    expect(DEFAULT_TOLERANCE).toBe(2);
  });
});

describe("diffSpacing", () => {
  const prod = [section("SECTION:How it works", stack([16, 24, 32]))];

  it("identical spacing produces no findings", () => {
    expect(
      diffSpacing(prod, [section("SECTION:How it works", stack([16, 24, 32]))]),
    ).toEqual([]);
  });

  it("one wrong gap is one gap finding naming the pair, the section and the delta", () => {
    const findings = diffSpacing(prod, [
      section("SECTION:How it works", stack([16, 48, 32])),
    ]);
    const gaps = findings.filter((f: { kind: string }) => f.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      check: CHECK,
      kind: "gap",
      section: "SECTION:How it works",
      key: "UL:Import your tasks",
      previous: "P:Three steps",
      prod: 24,
      target: 48,
      delta: 24,
    });
    expect(gaps[0].message).toContain("24");
  });

  it("2 px is within the default tolerance; 3 px is not", () => {
    expect(
      diffSpacing(prod, [section("SECTION:How it works", stack([16, 26, 32]))]),
    ).toEqual([]);
    expect(
      diffSpacing(prod, [section("SECTION:How it works", stack([16, 27, 32]))])
        .length,
    ).toBeGreaterThan(0);
  });

  it("the tolerance is configurable", () => {
    expect(
      diffSpacing(
        prod,
        [section("SECTION:How it works", stack([16, 48, 32]))],
        {
          tolerance: 30,
        },
      ),
    ).toEqual([]);
  });

  it("a section top padding error is an offset finding on the first child", () => {
    const findings = diffSpacing(prod, [
      section("SECTION:How it works", stack([16, 24, 32], 52)),
    ]);
    expect(
      findings.some(
        (f: { kind: string; key: string }) =>
          f.kind === "offset" && f.key === "H2:How it works",
      ),
    ).toBe(true);
    expect(findings.filter((f: { kind: string }) => f.kind === "gap")).toEqual(
      [],
    );
  });

  it("findings in one section never spill into the next", () => {
    const quotes = section("SECTION:What customers say", stack([16, 20, 0]));
    const findings = diffSpacing(
      [...prod, quotes],
      [section("SECTION:How it works", stack([16, 48, 32])), quotes],
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.section).toBe("SECTION:How it works");
  });

  it("a child or a section missing on the target is reported", () => {
    const missingChild = diffSpacing(prod, [
      section(
        "SECTION:How it works",
        stack([16, 24, 32]).filter((c) => c.key !== "A:Start free"),
      ),
    ]);
    expect(
      missingChild.some(
        (f: { kind: string; key: string }) =>
          f.kind === "missing" && f.key === "A:Start free",
      ),
    ).toBe(true);
    const missingSection = diffSpacing(prod, []);
    expect(missingSection).toEqual([
      expect.objectContaining({
        kind: "missing-section",
        section: "SECTION:How it works",
      }),
    ]);
  });
});

describe("parseCliArgs", () => {
  const base = [
    "--prod",
    "https://example.com",
    "--target",
    "http://localhost:8080",
    "--route",
    "/",
  ];

  it("defaults --tolerance to 2", () => {
    expect(parseCliArgs(base).tolerance).toBe(2);
  });

  it("rejects a tolerance that is not a number of pixels, naming the flag", () => {
    expect(() => parseCliArgs([...base, "--tolerance", "abc"])).toThrow(
      /--tolerance/,
    );
    expect(() => parseCliArgs([...base, "--tolerance", "-1"])).toThrow(
      /--tolerance/,
    );
  });
});
