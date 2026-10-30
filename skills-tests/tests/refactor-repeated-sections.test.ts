// Unit tests for skills/bascik-refactor/scripts/repeated-sections.mjs: structural fingerprints without text, the
// fingerprints shared by two or more routes, the target's component usage read from its source, and the computed
// style signatures every instance must share. The browser half is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: a section repeated on several pages, which any human would make a component, was pasted per page by
// the agent, and one copy was styled wrong.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CHECK,
  componentUsage,
  diffInstances,
  findRepeated,
  fingerprint,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/repeated-sections.mjs";

type Tree = { tag: string; children?: Tree[] };
const t = (tag: string, ...children: Tree[]): Tree => ({ tag, children });
const features = (h: string, items: number) =>
  t(
    "SECTION",
    t(h),
    t("UL", ...Array.from({ length: items }, () => t("LI", t("H3"), t("P")))),
  );

describe("fingerprint", () => {
  it("names the check", () => {
    expect(CHECK).toBe("repeated-sections");
  });

  it("is the same for the same structure, whatever the text and classes", () => {
    expect(fingerprint(features("H2", 3))).toBe(fingerprint(features("H2", 3)));
  });

  it("keeps the heading shape: an h2 section is not an h3 section", () => {
    expect(fingerprint(features("H2", 3))).not.toBe(
      fingerprint(features("H3", 3)),
    );
  });

  it("collapses runs of identical siblings, so three and four cards are one component", () => {
    expect(fingerprint(features("H2", 3))).toBe(fingerprint(features("H2", 4)));
  });

  it("keeps landmarks: a nav inside is a different shape", () => {
    expect(fingerprint(t("HEADER", t("NAV", t("A"))))).not.toBe(
      fingerprint(t("HEADER", t("DIV", t("A")))),
    );
  });
});

describe("findRepeated", () => {
  it("returns the fingerprints present on two or more routes, with their routes", () => {
    const fp = fingerprint(features("H2", 3));
    const repeated = findRepeated({
      "/": [
        { fingerprint: fp, key: "SECTION:Features" },
        { fingerprint: "hero", key: "SECTION:Plan" },
      ],
      "/about": [{ fingerprint: fp, key: "SECTION:Why teams switch" }],
      "/contact": [{ fingerprint: "form", key: "SECTION:Contact" }],
    });
    expect(repeated).toEqual([
      {
        fingerprint: fp,
        routes: ["/", "/about"],
        keys: ["SECTION:Features", "SECTION:Why teams switch"],
      },
    ]);
  });

  it("a section repeated twice on one route only is not a cross-route repeat", () => {
    expect(
      findRepeated({
        "/": [
          { fingerprint: "card", key: "SECTION:A" },
          { fingerprint: "card", key: "SECTION:B" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("componentUsage", () => {
  let dir: string;
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bascik-repeated-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists the components and which ones each page uses", () => {
    write(
      "src/components/feature-grid/feature-grid.html",
      "<section></section>\n",
    );
    write("src/components/site-footer/site-footer.html", "<footer></footer>\n");
    write(
      "src/pages/index.html",
      "<main><feature-grid></feature-grid></main><site-footer />\n",
    );
    write(
      "src/pages/about.html",
      "<main><section><h2>Pasted</h2></section></main>\n",
    );
    const usage = componentUsage(dir);
    expect(usage.components.sort()).toEqual(["feature-grid", "site-footer"]);
    expect(usage.pages["src/pages/index.html"].sort()).toEqual([
      "feature-grid",
      "site-footer",
    ]);
    expect(usage.pages["src/pages/about.html"]).toEqual([]);
  });

  it("names the folder it expected when the target source has no src/pages", () => {
    expect(() => componentUsage(dir)).toThrow(/src\/pages/);
  });
});

describe("diffInstances", () => {
  const sig = {
    "padding-top": "48px",
    "background-color": "rgb(245, 247, 251)",
  };

  it("identical signatures produce no findings", () => {
    expect(
      diffInstances("SECTION:Features", [
        { route: "/", width: 1024, signature: sig },
        { route: "/about", width: 1024, signature: { ...sig } },
      ]),
    ).toEqual([]);
  });

  it("an instance that differs is a diverging-instance finding naming its route, width and property", () => {
    const findings = diffInstances("SECTION:Features", [
      { route: "/", width: 1024, signature: sig },
      {
        route: "/about",
        width: 1024,
        signature: { ...sig, "padding-top": "24px" },
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: CHECK,
      kind: "diverging-instance",
      route: "/about",
    });
    expect(findings[0].message).toContain("padding-top");
    expect(findings[0].message).toContain("1024");
  });
});

describe("parseCliArgs", () => {
  it("needs two or more routes, since one route cannot repeat anything", () => {
    expect(() =>
      parseCliArgs([
        "--prod",
        "https://example.com",
        "--target",
        "http://localhost:8080",
        "--route",
        "/",
      ]),
    ).toThrow(/two or more/);
  });

  it("defaults the target source to the current project", () => {
    const args = parseCliArgs([
      "--prod",
      "https://example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/",
      "--route",
      "/about",
    ]);
    expect(args.targetSrc).toBe(".");
    expect(args.route).toEqual(["/", "/about"]);
  });
});
