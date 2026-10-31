// Unit tests for skills/bascik-refactor/scripts/state-capture.mjs: the computed styles captured for an open disclosure
// and the per-subtree icon inventory comparison. The browser half (opening every disclosure interaction-crawl finds,
// waiting for the opening animation, cropping the open state) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: main-nav dropdowns shipped with the wrong style and without their icons, because no check ever
// looked at a menu in its open state.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  ICON_KINDS,
  STATE_PROPS,
  diffIcons,
  diffStateStyles,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/state-capture.mjs";

describe("CHECK, STATE_PROPS and ICON_KINDS", () => {
  it("names the check", () => {
    expect(CHECK).toBe("state-capture");
  });

  it("captures the properties that make a dropdown look right", () => {
    for (const prop of [
      "background-color",
      "box-shadow",
      "border-radius",
      "padding-top",
      "color",
      "font-weight",
      "width",
    ])
      expect(STATE_PROPS, prop).toContain(prop);
  });

  it("counts every way a page draws an icon", () => {
    expect([...ICON_KINDS].sort()).toEqual(
      ["background", "img", "mask", "picture", "pseudo", "svg"].sort(),
    );
  });
});

describe("diffStateStyles", () => {
  const base = {
    "background-color": "rgb(255, 255, 255)",
    "box-shadow": "rgba(0, 0, 0, 0.15) 0px 8px 24px 0px",
    "border-radius": "8px",
  };

  it("identical styles produce no findings", () => {
    expect(diffStateStyles("BUTTON:Products", base, { ...base })).toEqual([]);
  });

  it("each differing property is one style finding naming the disclosure and both values", () => {
    const findings = diffStateStyles("BUTTON:Products", base, {
      ...base,
      "box-shadow": "none",
      "border-radius": "0px",
    });
    expect(
      findings.map((f: { property: string }) => f.property).sort(),
    ).toEqual(["border-radius", "box-shadow"]);
    for (const f of findings) {
      expect(f).toMatchObject({
        check: CHECK,
        kind: "style",
        anchor: "BUTTON:Products",
      });
      expect(f.message).toContain("Products");
    }
    const shadow = findings.find(
      (f: { property: string }) => f.property === "box-shadow",
    );
    expect(shadow.message).toContain("none");
    expect(shadow.message).toContain("0px 8px 24px");
  });
});

describe("diffIcons", () => {
  const svg = { kind: "svg", src: "svg:circle" };
  const img = { kind: "img", src: "icons/timeline.svg" };
  const pseudo = { kind: "pseudo", src: "icons/report.svg" };

  it("the same icons in another order produce no findings", () => {
    expect(
      diffIcons("BUTTON:Products", [svg, img, pseudo], [pseudo, svg, img]),
    ).toEqual([]);
  });

  it("a different count is one icons finding with both counts", () => {
    const findings = diffIcons("BUTTON:Products", [svg, img, pseudo], [pseudo]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: CHECK, kind: "icons" });
    expect(findings[0].message).toMatch(/\b3\b/);
    expect(findings[0].message).toMatch(/\b1\b/);
  });

  it("the same count with another source is an icon-source finding", () => {
    const findings = diffIcons(
      "BUTTON:Products",
      [svg, img],
      [svg, { kind: "img", src: "icons/calendar.svg" }],
    );
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "icon-source",
    ]);
    expect(findings[0].message).toContain("timeline.svg");
    expect(findings[0].message).toContain("calendar.svg");
  });

  it("a fingerprinted or relocated copy of the same file is the same icon", () => {
    expect(
      diffIcons(
        "BUTTON:Products",
        [img],
        [
          {
            kind: "img",
            src: "https://example.com/assets/timeline.svg?v=0eace9e1a7",
          },
        ],
      ),
    ).toEqual([]);
    expect(
      diffIcons(
        "BUTTON:Products",
        [img],
        [{ kind: "img", src: "/assets/timeline.4f3a2b1c.svg" }],
      ),
    ).toEqual([]);
  });

  it("an svg drawn as a CSS background instead of inline markup is still one icon, but a different kind", () => {
    const findings = diffIcons(
      "BUTTON:Products",
      [img],
      [{ kind: "background", src: "icons/timeline.svg" }],
    );
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "icon-source",
    ]);
  });
});

describe("parseCliArgs", () => {
  it("needs --prod, --target and --route, and defaults --out", () => {
    expect(() => parseCliArgs([])).toThrow(/--prod/);
    const args = parseCliArgs([
      "--prod",
      "https://example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/",
    ]);
    expect(args.out).toBe("artifacts/checks");
    expect(args.skipControls).toEqual([]);
  });

  it("takes --skip-control like the interaction crawl, since it activates the same controls", () => {
    const args = parseCliArgs([
      "--prod",
      "https://example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/",
      "--skip-control",
      "[data-add-to-cart]",
    ]);
    expect(args.skipControls).toEqual(["[data-add-to-cart]"]);
  });
});
