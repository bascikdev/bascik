// Unit tests for skills/bascik-refactor/scripts/testid-coverage.mjs: which target elements need a data-testid, and the
// component naming rule (root: the component name; parts: <component>-<part>; repeated instances share their ids).
// The browser half (rendered gaps mapped to the source file to edit) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: the target's own end-to-end tests need stable hooks, and class and id names are hashed in production
// builds. Every interactive element, form, landmark and component root gets a data-testid as part of its route.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CHECK,
  COVERAGE_SELECTOR,
  auditComponent,
  auditSource,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/testid-coverage.mjs";

const FILE = "src/components/promo-card/promo-card.html";

describe("constants", () => {
  it("names the check", () => {
    expect(CHECK).toBe("testid-coverage");
  });

  it("covers interactive elements, forms and landmarks", () => {
    for (const part of [
      "button",
      "a[href]",
      "input",
      "select",
      "textarea",
      "summary",
      "form",
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="dialog"]',
      "header",
      "nav",
      "main",
      "footer",
      "aside",
    ])
      expect(COVERAGE_SELECTOR, part).toContain(part);
  });
});

describe("auditComponent", () => {
  const card = (root: string, part: string) =>
    `<!-- @bascik\nA card.\n-->\n<style>\n  .card { padding: 24px; }\n</style>\n<article class="card"${root}>\n  <h3 data-bascik-prop-title>Title</h3>\n  <a href="/features"${part}>Learn more</a>\n</article>\n`;

  it("a root named after the component and prefixed parts pass", () => {
    expect(
      auditComponent(
        "promo-card",
        card(' data-testid="promo-card"', ' data-testid="promo-card-link"'),
        FILE,
      ),
    ).toEqual([]);
  });

  it("a root without a data-testid is a component-root finding with the value to add and the line", () => {
    const findings = auditComponent(
      "promo-card",
      card("", ' data-testid="promo-card-link"'),
      FILE,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        check: CHECK,
        kind: "component-root",
        file: FILE,
        line: 7,
      }),
    ]);
    expect(findings[0].message).toContain('data-testid="promo-card"');
  });

  it("a root with another name is a component-root finding too", () => {
    const findings = auditComponent(
      "promo-card",
      card(' data-testid="card"', ' data-testid="promo-card-link"'),
      FILE,
    );
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "component-root",
    ]);
  });

  it("a part not prefixed with the component name is a part-name finding", () => {
    const findings = auditComponent(
      "promo-card",
      card(' data-testid="promo-card"', ' data-testid="learn-more"'),
      FILE,
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: "part-name", file: FILE, line: 9 }),
    ]);
    expect(findings[0].message).toContain("learn-more");
    expect(findings[0].message).toContain("promo-card-");
  });

  it("an interactive part without any data-testid is a missing finding", () => {
    const findings = auditComponent(
      "promo-card",
      card(' data-testid="promo-card"', ""),
      FILE,
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: "missing", file: FILE, line: 9 }),
    ]);
  });

  it("the comment, style and script blocks are not the root", () => {
    const html = `<!-- <div>not this</div> -->\n<style>.x { color: red; }</style>\n<nav data-testid="site-nav"><a href="/" data-testid="site-nav-home">Home</a></nav>\n<script>const a = "<button>";</script>\n`;
    expect(
      auditComponent("site-nav", html, "src/components/site-nav/site-nav.html"),
    ).toEqual([]);
  });
});

describe("auditSource", () => {
  let dir: string;
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bascik-coverage-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("audits every component under src/components, with paths relative to the source root", () => {
    write(
      "src/components/promo-card/promo-card.html",
      '<article class="card"><a href="/" data-testid="promo-card-link">x</a></article>\n',
    );
    write(
      "src/components/site-footer/site-footer.html",
      '<footer data-testid="site-footer"></footer>\n',
    );
    const findings = auditSource(dir);
    expect(findings).toEqual([
      expect.objectContaining({ kind: "component-root", file: FILE }),
    ]);
  });

  it("names the folder it expected when there is no src/components", () => {
    expect(() => auditSource(dir)).toThrow(/src\/components/);
  });
});

describe("parseCliArgs", () => {
  it("needs only the target: coverage is about the new site", () => {
    expect(() => parseCliArgs(["--route", "/"])).toThrow(/--target/);
    expect(
      parseCliArgs(["--target", "http://localhost:8080", "--route", "/"]),
    ).toMatchObject({
      target: "http://localhost:8080",
      route: ["/"],
      targetSrc: ".",
    });
  });
});
