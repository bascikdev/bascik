// Unit tests for skills/bascik-refactor/scripts/alignment-diff.mjs: text-align, rendered line count and the left and
// right offsets from the containing block, per matrix case, for headings, paragraphs and buttons. The browser half is
// in refactor-parity-checks.integration.test.ts.
//
// Why it exists: text was misaligned at certain breakpoints only, and one screenshot per route never showed it.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  DEFAULT_TOLERANCE,
  SELECTOR,
  diffAlignment,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/alignment-diff.mjs";

type Node = { textAlign: string; lines: number; left: number; right: number };
const node = (over: Partial<Node> = {}): Node => ({
  textAlign: "center",
  lines: 2,
  left: 24,
  right: 24,
  ...over,
});
const at = (width: number, nodes: Record<string, Node>) => ({
  width,
  height: 800,
  nodes,
});

describe("constants", () => {
  it("names the check, measures headings, paragraphs and buttons, at 2 px", () => {
    expect(CHECK).toBe("alignment-diff");
    for (const part of ["h1", "h2", "h3", "p", "button"])
      expect(SELECTOR).toContain(part);
    expect(DEFAULT_TOLERANCE).toBe(2);
  });
});

describe("diffAlignment", () => {
  it("identical cases produce no findings", () => {
    const cases = [
      at(400, { "H1:Plan": node() }),
      at(1024, { "H1:Plan": node({ textAlign: "left" }) }),
    ];
    expect(diffAlignment(cases, structuredClone(cases))).toEqual([]);
  });

  it("flags only the case where alignment differs, naming the width", () => {
    const findings = diffAlignment(
      [
        at(400, { "H1:Plan": node() }),
        at(1024, { "H1:Plan": node({ textAlign: "left" }) }),
      ],
      [
        at(400, { "H1:Plan": node({ textAlign: "left" }) }),
        at(1024, { "H1:Plan": node({ textAlign: "left" }) }),
      ],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: CHECK,
      kind: "text-align",
      width: 400,
      key: "H1:Plan",
      prod: "center",
      target: "left",
    });
    expect(findings[0].message).toMatch(/\b400\b/);
  });

  it("flags a different line count and offsets past the tolerance", () => {
    const findings = diffAlignment(
      [at(400, { "P:Boards": node({ lines: 3 }) })],
      [at(400, { "P:Boards": node({ lines: 4, left: 27, right: 26 }) })],
    );
    expect(findings.map((f: { kind: string }) => f.kind).sort()).toEqual([
      "left",
      "lines",
    ]);
  });

  it("start and left are the same alignment in a left-to-right page", () => {
    expect(
      diffAlignment(
        [at(400, { "P:Boards": node({ textAlign: "start" }) })],
        [at(400, { "P:Boards": node({ textAlign: "left" }) })],
      ),
    ).toEqual([]);
  });

  it("an element missing at one case is reported at that case", () => {
    const findings = diffAlignment(
      [
        at(400, { "BUTTON:Start free": node() }),
        at(1024, { "BUTTON:Start free": node() }),
      ],
      [at(400, {}), at(1024, { "BUTTON:Start free": node() })],
    );
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "missing",
        width: 400,
        key: "BUTTON:Start free",
      }),
    ]);
  });

  it("a case missing on the target is an error naming it, not a silent pass", () => {
    expect(() =>
      diffAlignment([at(400, {}), at(1024, {})], [at(400, {})]),
    ).toThrow(/1024/);
  });
});

describe("parseCliArgs", () => {
  it("needs --route and defaults the matrix", () => {
    expect(() =>
      parseCliArgs([
        "--prod",
        "https://example.com",
        "--target",
        "http://localhost:8080",
      ]),
    ).toThrow(/--route/);
    expect(
      parseCliArgs([
        "--prod",
        "https://example.com",
        "--target",
        "http://localhost:8080",
        "--route",
        "/",
      ]).matrix,
    ).toBe("docs/migration/breakpoints.json");
  });
});
