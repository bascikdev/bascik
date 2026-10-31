// Unit tests for skills/bascik-refactor/scripts/interaction-crawl.mjs: what counts as interactive, how a production
// element is found again on the target by stable anchors, and how recorded effects are compared. The browser half
// (discovery through CDP listeners, activation, smooth scrolling) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: a hero button that scrolls to a section did nothing on the target, and the old interaction trace only
// compared open/closed booleans for steps someone remembered to write down.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  INTERACTIVE_SELECTOR,
  activatable,
  diffEffects,
  effectOf,
  matchAnchor,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/interaction-crawl.mjs";

type Effect = {
  scrollDelta: number;
  scrollTarget: string | null;
  hash: string;
  url: string;
  changed: string[];
  shown: string[];
  focused: string | null;
};

const none: Effect = {
  scrollDelta: 0,
  scrollTarget: null,
  hash: "",
  url: "/",
  changed: [],
  shown: [],
  focused: null,
};
const effect = (over: Partial<Effect> = {}): Effect => ({ ...none, ...over });
const anchor = (over: Record<string, unknown> = {}) => ({
  tag: "BUTTON",
  role: "button",
  name: "See features",
  text: "See features",
  href: null,
  testId: null,
  ...over,
});

describe("CHECK and INTERACTIVE_SELECTOR", () => {
  it("names the check", () => {
    expect(CHECK).toBe("interaction-crawl");
  });

  it("covers every interactive pattern the crawl must try", () => {
    for (const part of [
      "button",
      'a[href^="#"]',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      "[aria-controls]",
      "[aria-expanded]",
      '[tabindex="0"]',
    ])
      expect(INTERACTIVE_SELECTOR, part).toContain(part);
  });

  it("never activates plain navigation links or submit buttons: the crawl is read-only", () => {
    expect(INTERACTIVE_SELECTOR).not.toMatch(/(^|,\s*)a(\[href\])?\s*(,|$)/);
  });
});

describe("matchAnchor", () => {
  const candidates = [
    anchor({ name: "Products", text: "Products", testId: null }),
    anchor({ name: "See features", text: "See features", testId: "hero-cta" }),
    anchor({
      tag: "A",
      role: "link",
      name: "Pricing",
      text: "Pricing",
      href: "#pricing",
    }),
  ];

  it("prefers the test id when production has one", () => {
    expect(
      matchAnchor(anchor({ testId: "hero-cta", name: "Other" }), candidates),
    ).toBe(1);
  });

  it("falls back to role plus accessible name, ignoring class names and whitespace", () => {
    expect(matchAnchor(anchor({ name: "  See\n features " }), candidates)).toBe(
      1,
    );
  });

  it("matches an in-page link by its href when the text changed", () => {
    expect(
      matchAnchor(
        anchor({
          tag: "A",
          role: "link",
          name: "Plans",
          text: "Plans",
          href: "#pricing",
        }),
        candidates,
      ),
    ).toBe(2);
  });

  it("returns -1 when nothing on the target matches", () => {
    expect(
      matchAnchor(
        anchor({ name: "Book a demo", text: "Book a demo" }),
        candidates,
      ),
    ).toBe(-1);
  });
});

describe("diffEffects", () => {
  const item = (a: Record<string, unknown>, e: Effect) => ({
    anchor: anchor(a),
    effect: e,
  });

  it("equal effects produce no findings", () => {
    const prod = [
      item({}, effect({ scrollDelta: 700, scrollTarget: "H2:Features" })),
    ];
    const target = [
      item({}, effect({ scrollDelta: 712, scrollTarget: "H2:Features" })),
    ];
    expect(diffEffects(prod, target)).toEqual([]);
  });

  it("a button that scrolls in production and does nothing on the target is a missing effect", () => {
    const findings = diffEffects(
      [item({}, effect({ scrollDelta: 700, scrollTarget: "H2:Features" }))],
      [item({}, effect())],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: CHECK, kind: "missing-effect" });
    expect(findings[0].anchor).toContain("See features");
    expect(findings[0].message).toMatch(/scroll/i);
  });

  it("scrolling to a different section is a different effect", () => {
    const findings = diffEffects(
      [item({}, effect({ scrollDelta: 700, scrollTarget: "H2:Features" }))],
      [
        item(
          {},
          effect({ scrollDelta: 1600, scrollTarget: "H2:Pricing plans" }),
        ),
      ],
    );
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "different-effect",
    ]);
    expect(findings[0].message).toContain("Pricing plans");
  });

  it("a disclosure that no longer flips aria-expanded or shows its panel is a missing effect", () => {
    const opened = effect({
      changed: ["aria-expanded: false -> true"],
      shown: ["A:Boards", "A:Timelines"],
    });
    const findings = diffEffects(
      [item({ name: "Products", text: "Products" }, opened)],
      [
        item(
          { name: "Products", text: "Products" },
          effect({ shown: ["A:Boards"] }),
        ),
      ],
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.every((f: { kind: string }) => f.kind === "missing-effect"),
    ).toBe(true);
    const text = findings.map((f: { message: string }) => f.message).join("\n");
    expect(text).toContain("aria-expanded");
    expect(text).toContain("A:Timelines");
  });

  it("hash, URL and focus changes are compared too", () => {
    const findings = diffEffects(
      [item({}, effect({ hash: "#pricing", focused: "H2:Pricing plans" }))],
      [item({}, effect({ hash: "#plans", focused: null }))],
    );
    const text = findings.map((f: { message: string }) => f.message).join("\n");
    expect(text).toContain("#pricing");
    expect(text).toMatch(/focus/i);
  });

  it("an element production has and the target lacks is a missing element, never a silent pass", () => {
    const findings = diffEffects(
      [
        item(
          { name: "Book a demo", text: "Book a demo" },
          effect({ shown: ["DIALOG:Book a demo"] }),
        ),
      ],
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing-element");
    expect(findings[0].message).toContain("Book a demo");
  });

  it("a target element found at discovery but not measured after the reload is unmeasured, never a silent pass", () => {
    // Its selector changed between loads (an id a script randomizes per load), so activate() gave the target null.
    const findings = diffEffects(
      [
        item(
          { name: "Menu", text: "Menu" },
          effect({ changed: ["aria-expanded: false -> true"] }),
        ),
      ],
      [{ anchor: anchor({ name: "Menu", text: "Menu" }), effect: null }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("unmeasured");
    expect(findings[0].message).toContain('BUTTON "Menu"');
    expect(findings[0].message).toContain("aria-expanded");
  });

  it("a production element that could not be measured is not blamed on the target", () => {
    // Production is the reference the refactor cannot change; with nothing recorded there is nothing to compare.
    expect(
      diffEffects(
        [{ anchor: anchor(), effect: null }],
        [item({}, effect({ shown: ["DIALOG:See features"] }))],
      ),
    ).toEqual([]);
  });

  it("an effect the target adds where production has none is reported", () => {
    const findings = diffEffects(
      [item({}, effect())],
      [item({}, effect({ url: "/features" }))],
    );
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "different-effect",
    ]);
  });
});

describe("effectOf: where a scrolled-to heading lands", () => {
  const state = (over: Record<string, unknown> = {}) => ({
    attrs: {},
    shown: [],
    focused: null,
    scrollY: 0,
    scrollTarget: null,
    landing: null,
    hash: "",
    url: "/about",
    ...over,
  });
  const banner = "html > body > aside";
  const header = "html > body > header";
  const scrolled = (cover: string) =>
    state({
      scrollY: 900,
      scrollTarget: "H2:Specs",
      landing: { top: 140, covered: true, cover },
    });

  it("a cover the page puts up by itself (a banner sliding in, a timed modal) is not under what the scroll forgot", () => {
    const e = effectOf(state(), scrolled(banner), { selectors: [banner] });
    expect(e.landing).toEqual({ top: 140, covered: false });
    const findings = diffEffects(
      [
        {
          anchor: anchor(),
          effect: { ...e, landing: { top: 140, covered: false } },
        },
      ],
      [{ anchor: anchor(), effect: e }],
    );
    expect(findings).toEqual([]);
  });

  it("a sticky header over the heading on the target only is still a different effect", () => {
    const prod = effectOf(
      state(),
      state({
        scrollY: 900,
        scrollTarget: "H2:Specs",
        landing: { top: 140, covered: false, cover: null },
      }),
      { selectors: [banner] },
    );
    const target = effectOf(state(), scrolled(header), { selectors: [banner] });
    expect(target.landing).toEqual({ top: 140, covered: true });
    const findings = diffEffects(
      [{ anchor: anchor(), effect: prod }],
      [{ anchor: anchor(), effect: target }],
    );
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "different-effect",
    ]);
    expect(findings[0].message).toMatch(/fixed or sticky layer covers it/);
  });
});

describe("parseCliArgs", () => {
  it("needs --prod, --target and --route", () => {
    expect(() => parseCliArgs([])).toThrow(/--prod/);
    expect(() => parseCliArgs(["--prod", "https://example.com"])).toThrow(
      /--target/,
    );
    expect(() =>
      parseCliArgs([
        "--prod",
        "https://example.com",
        "--target",
        "http://localhost:8080",
      ]),
    ).toThrow(/--route/);
  });

  it("returns help without other flags", () => {
    expect(parseCliArgs(["--help"])).toEqual({ help: true });
  });

  it("defaults the matrix and the output folder", () => {
    const args = parseCliArgs([
      "--prod",
      "https://example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/",
    ]);
    expect(args.matrix).toBe("docs/migration/breakpoints.json");
    expect(args.out).toBe("artifacts/checks");
  });
});

describe("activatable (the in-page source, run with stub page helpers)", () => {
  const here = new URL("https://example.com/pricing");
  const inPage = new Function(
    "location",
    "isRendered",
    "isMasked",
    "tagOf",
    `${activatable}\nreturn activatable;`,
  )(
    here,
    () => true,
    () => false,
    (el: { tagName: string }) => el.tagName,
  ) as (el: unknown, mode: string, masks: string[]) => boolean;
  const linkTo = (href: string) => {
    const link = {
      tagName: "A",
      form: null,
      getAttribute: (name: string) => (name === "href" ? href : null),
      href: new URL(href, here).href,
      closest: (selector: string) => (selector === "a[href]" ? link : null),
    };
    return link;
  };

  it.each(["#plans", "javascript:void(0)", "JavaScript:void(0)", "/pricing"])(
    "clicks a link to %s, which keeps the page",
    (href) => {
      expect(inPage(linkTo(href), "click", [])).toBe(true);
    },
  );

  it.each([
    "/about",
    "https://other.example/",
    "data:text/html,<p>x</p>",
    "vbscript:msgbox(1)",
  ])("does not click a link to %s, which leaves the page", (href) => {
    expect(inPage(linkTo(href), "click", [])).toBe(false);
  });

  it("hovers any link, since a hover never leaves the page", () => {
    expect(inPage(linkTo("/about"), "hover", [])).toBe(true);
  });
});
