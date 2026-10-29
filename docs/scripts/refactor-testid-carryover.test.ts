// Unit tests for skills/bascik-refactor/scripts/testid-carryover.mjs: the test hook attributes it collects, reading
// them from legacy source (JSX and HTML, static and dynamic values), and the comparison with the target's rendered
// hooks. The browser half is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: the existing end-to-end suite finds elements by these hooks. A hook dropped, moved to another element
// or renamed in the refactor breaks those tests silently, or worse, makes them pass against the wrong element.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  HOOK_ATTRS,
  collectSourceHooks,
  diffHooks,
  diffSourceHooks,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/testid-carryover.mjs";

const anchor = (over: Record<string, unknown> = {}) => ({
  tag: "BUTTON",
  role: "button",
  name: "Get started",
  text: "Get started",
  index: 0,
  ...over,
});
const hook = (
  attr: string,
  value: string,
  a: Record<string, unknown> = {},
) => ({
  attr,
  value,
  anchor: anchor(a),
});

describe("constants", () => {
  it("names the check and the five hook attributes", () => {
    expect(CHECK).toBe("testid-carryover");
    expect([...HOOK_ATTRS].sort()).toEqual(
      ["data-cy", "data-qa", "data-test", "data-test-id", "data-testid"].sort(),
    );
  });
});

describe("collectSourceHooks", () => {
  it("reads every static form, with file and line", () => {
    const text = [
      '<button data-testid="hero-cta">',
      "<form data-cy='signup-form'>",
      '<a data-qa={"nav-pricing"} />',
      "<input data-test={'signup-email'} />",
      "<button data-test-id={`signup-submit`} />",
    ].join("\n");
    const hooks = collectSourceHooks(text, "src/App.jsx");
    expect(
      hooks.map((h: { attr: string; value: string; line: number }) => [
        h.attr,
        h.value,
        h.line,
      ]),
    ).toEqual([
      ["data-testid", "hero-cta", 1],
      ["data-cy", "signup-form", 2],
      ["data-qa", "nav-pricing", 3],
      ["data-test", "signup-email", 4],
      ["data-test-id", "signup-submit", 5],
    ]);
    for (const h of hooks) expect(h.file).toBe("src/App.jsx");
  });

  it("keeps dynamic values as dynamic instead of dropping them", () => {
    const hooks = collectSourceHooks(
      "<li data-testid={`plan-${plan.id}`} />\n<li data-testid={id} />",
      "src/Plans.jsx",
    );
    expect(hooks).toEqual([
      expect.objectContaining({
        attr: "data-testid",
        value: null,
        dynamic: true,
        line: 1,
      }),
      expect.objectContaining({
        attr: "data-testid",
        value: null,
        dynamic: true,
        line: 2,
      }),
    ]);
  });

  it("does not read look-alike attributes", () => {
    expect(
      collectSourceHooks(
        '<div data-testids="x" data-cypress="y" aria-data-qa="z">',
        "a.html",
      ),
    ).toEqual([]);
  });
});

describe("diffHooks", () => {
  it("the same hooks on the same elements produce no findings", () => {
    const prod = [
      hook("data-testid", "hero-cta"),
      hook("data-qa", "nav-pricing", {
        tag: "A",
        role: "link",
        name: "Pricing",
        text: "Pricing",
      }),
    ];
    expect(diffHooks(prod, structuredClone(prod))).toEqual([]);
  });

  it("a hook the target dropped is missing, naming the element", () => {
    const findings = diffHooks([hook("data-testid", "hero-cta")], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: CHECK, kind: "missing" });
    expect(findings[0].message).toContain('data-testid="hero-cta"');
    expect(findings[0].message).toContain("Get started");
  });

  it("a hook on another element is moved, naming both elements", () => {
    const pricing = {
      tag: "A",
      role: "link",
      name: "Pricing",
      text: "Pricing",
    };
    const contact = {
      tag: "A",
      role: "link",
      name: "Contact",
      text: "Contact",
    };
    const findings = diffHooks(
      [hook("data-qa", "nav-pricing", pricing)],
      [hook("data-qa", "nav-pricing", contact)],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("moved");
    expect(findings[0].message).toContain("Pricing");
    expect(findings[0].message).toContain("Contact");
  });

  it("the same value under another attribute name is missing: tests query the attribute", () => {
    const form = { tag: "FORM", role: "form", name: "", text: "Email Sign up" };
    const findings = diffHooks(
      [hook("data-cy", "signup-form", form)],
      [hook("data-testid", "signup-form", form)],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing");
    expect(findings[0].message).toContain('data-cy="signup-form"');
    expect(findings[0].message).toContain("data-testid");
  });

  it("repeated elements are told apart by position", () => {
    const card = (index: number) => ({
      tag: "A",
      role: "link",
      name: "Learn more",
      text: "Learn more",
      index,
    });
    const findings = diffHooks(
      [
        hook("data-testid", "card-link-boards", card(0)),
        hook("data-testid", "card-link-timelines", card(1)),
      ],
      [
        hook("data-testid", "card-link-timelines", card(0)),
        hook("data-testid", "card-link-boards", card(1)),
      ],
    );
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "moved",
      "moved",
    ]);
  });
});

describe("diffSourceHooks", () => {
  it("a static legacy hook found nowhere on the target is missing, located at its legacy file and line", () => {
    const legacy = collectSourceHooks(
      'export const F = () => (\n  <form data-testid="footer-newsletter" />\n);',
      "src/components/Footer.jsx",
    );
    const findings = diffSourceHooks(legacy, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: CHECK, kind: "missing" });
    expect(findings[0].message).toContain("footer-newsletter");
    expect(findings[0].message).toContain("src/components/Footer.jsx:2");
  });

  it("a legacy hook the target source or rendered page carries is fine", () => {
    const legacy = collectSourceHooks(
      '<form data-testid="footer-newsletter" />',
      "Footer.jsx",
    );
    expect(
      diffSourceHooks(legacy, [
        { attr: "data-testid", value: "footer-newsletter" },
      ]),
    ).toEqual([]);
  });

  it("dynamic legacy hooks are left to the rendered comparison, not reported from source", () => {
    const legacy = collectSourceHooks(
      "<li data-testid={`plan-${plan.id}`} />",
      "Plans.jsx",
    );
    expect(diffSourceHooks(legacy, [])).toEqual([]);
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

  it("needs --legacy-src: without it the source half would be skipped silently", () => {
    expect(() => parseCliArgs(base)).toThrow(/--legacy-src/);
  });

  it("defaults the target source to the current project", () => {
    expect(parseCliArgs([...base, "--legacy-src", "../legacy"])).toMatchObject({
      legacySrc: "../legacy",
      targetSrc: ".",
    });
  });
});
