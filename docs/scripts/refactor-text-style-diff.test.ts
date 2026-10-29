// Unit tests for skills/bascik-refactor/scripts/text-style-diff.mjs: the text properties and states it compares and
// the comparison itself. The browser half (forcing :hover and :focus-visible with CDP CSS.forcePseudoState, masking a
// ticking counter) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: some links had the wrong color or the wrong font weight, which geometry never shows.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  STATES,
  TEXT_PROPS,
  diffTextStyles,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/text-style-diff.mjs";

const rest = {
  color: "rgb(36, 87, 214)",
  "font-weight": "600",
  "font-family": "Helvetica, Arial, sans-serif",
  "font-size": "16px",
  "line-height": "24px",
  "letter-spacing": "normal",
  "text-decoration": "none solid rgb(36, 87, 214)",
  "text-transform": "none",
};
const styles = (over: Record<string, Record<string, string>> = {}) => ({
  rest: { ...rest, ...over.rest },
  hover: { ...rest, color: "rgb(23, 58, 143)", ...over.hover },
  "focus-visible": {
    ...rest,
    color: "rgb(11, 42, 107)",
    ...over["focus-visible"],
  },
});

describe("constants", () => {
  it("names the check, the eight properties and the three states", () => {
    expect(CHECK).toBe("text-style-diff");
    expect([...TEXT_PROPS]).toEqual([
      "color",
      "font-weight",
      "font-family",
      "font-size",
      "line-height",
      "letter-spacing",
      "text-decoration",
      "text-transform",
    ]);
    expect([...STATES]).toEqual(["rest", "hover", "focus-visible"]);
  });
});

describe("diffTextStyles", () => {
  it("identical styles produce no findings", () => {
    expect(
      diffTextStyles(
        { "A:Read the guide": styles() },
        { "A:Read the guide": styles() },
      ),
    ).toEqual([]);
  });

  it("one finding per element, state and property, with both values", () => {
    const findings = diffTextStyles(
      { "A:Read the guide": styles(), "A:Contact us": styles() },
      {
        "A:Read the guide": styles({ rest: { color: "rgb(13, 110, 253)" } }),
        "A:Contact us": styles({ hover: { "font-weight": "400" } }),
      },
    );
    const brief = findings.map(
      (f: { key: string; state: string; property: string }) => [
        f.key,
        f.state,
        f.property,
      ],
    );
    expect(brief).toContainEqual(["A:Read the guide", "rest", "color"]);
    expect(brief).toContainEqual(["A:Contact us", "hover", "font-weight"]);
    expect(findings).toHaveLength(2);
    const color = findings.find(
      (f: { key: string }) => f.key === "A:Read the guide",
    );
    expect(color).toMatchObject({
      check: CHECK,
      kind: "style",
      prod: "rgb(36, 87, 214)",
      target: "rgb(13, 110, 253)",
    });
    expect(color.message).toContain("Read the guide");
    expect(color.message).toContain("rest");
  });

  it("a hover color the target forgot is found only because :hover was forced", () => {
    const findings = diffTextStyles(
      { "A:Pricing details": styles() },
      { "A:Pricing details": styles({ hover: { color: rest.color } }) },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: "hover", property: "color" });
  });

  it("quoting and case in font-family are not differences", () => {
    expect(
      diffTextStyles(
        {
          "P:Body": styles({
            rest: { "font-family": '"Helvetica", Arial, sans-serif' },
          }),
        },
        {
          "P:Body": styles({
            rest: { "font-family": "helvetica, arial, sans-serif" },
          }),
        },
      ),
    ).toEqual([]);
  });

  it("a text element missing on the target is a missing finding, not a silent pass", () => {
    const findings = diffTextStyles({ "A:Read the guide": styles() }, {});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "missing",
      key: "A:Read the guide",
    });
  });
});

describe("parseCliArgs", () => {
  it("collects masks for documented dynamic regions", () => {
    const args = parseCliArgs([
      "--prod",
      "https://example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/",
      "--mask",
      '[data-testid="ticker"]',
    ]);
    expect(args.mask).toEqual(['[data-testid="ticker"]']);
  });

  it("needs --prod", () => {
    expect(() => parseCliArgs(["--route", "/"])).toThrow(/--prod/);
  });
});
