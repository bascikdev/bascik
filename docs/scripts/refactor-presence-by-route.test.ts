// Unit tests for skills/bascik-refactor/scripts/presence-by-route.mjs: which elements count as fixed, sticky or overlay
// presence (banners, notices, dialogs, live regions, edge-covering layers), how one is named across both sides, and
// how the per-route inventories, fresh and after dismissal, are compared. The browser half (fresh contexts, waiting for
// a banner that slides in late, replaying the dismissal across routes) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: a cookie banner present on only a couple of pages was missed. A check that only looks at the routes
// someone opened, with whatever cookies the browser already had, never sees it.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  DISMISS_NAME,
  PRESENCE_SELECTOR,
  STATES,
  diffPresence,
  parseCliArgs,
  presenceKey,
  presenceReasons,
} from "../../skills/bascik-refactor/scripts/presence-by-route.mjs";

type Info = {
  tag: string;
  position: string;
  role: string | null;
  ariaLive: string | null;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
};
const info = (over: Partial<Info> = {}): Info => ({
  tag: "DIV",
  position: "static",
  role: null,
  ariaLive: null,
  visible: true,
  rect: { x: 0, y: 300, width: 400, height: 80 },
  viewport: { width: 1024, height: 800 },
  ...over,
});

type Item = { key: string; reasons: string[] };
type Snapshot = {
  route: string;
  width: number;
  state: "fresh" | "dismissed";
  items: Item[];
};
const COOKIE: Item = {
  key: "dialog:Cookie preferences",
  reasons: ["fixed", "dialog"],
};
const HEADER: Item = { key: "banner:Main", reasons: ["sticky"] };
const snap = (
  route: string,
  state: "fresh" | "dismissed",
  items: Item[],
  width = 1024,
): Snapshot => ({ route, width, state, items });

/** Production: a sticky header everywhere, the cookie banner on / and /pricing until it is accepted once. */
const PROD = (): Snapshot[] => [
  snap("/", "fresh", [HEADER, COOKIE]),
  snap("/", "dismissed", [HEADER]),
  snap("/about", "fresh", [HEADER]),
  snap("/about", "dismissed", [HEADER]),
  snap("/pricing", "fresh", [HEADER, COOKIE]),
  snap("/pricing", "dismissed", [HEADER]),
];

describe("constants", () => {
  it("names the check and inventories every route fresh and after dismissal", () => {
    expect(CHECK).toBe("presence-by-route");
    expect([...STATES]).toEqual(["fresh", "dismissed"]);
  });

  it("looks at dialogs, alert dialogs and live regions as well as positioned elements", () => {
    for (const part of [
      "dialog",
      '[role="dialog"]',
      '[role="alertdialog"]',
      "[aria-live]",
    ])
      expect(PRESENCE_SELECTOR, part).toContain(part);
  });

  it("recognizes the usual dismiss buttons and leaves the others alone", () => {
    for (const name of ["Accept all", "Accept", "Close", "Got it", "Dismiss"])
      expect(name, name).toMatch(DISMISS_NAME);
    for (const name of ["Manage preferences", "Learn more", "Pricing"])
      expect(name, name).not.toMatch(DISMISS_NAME);
  });
});

describe("presenceReasons", () => {
  it("a fixed or sticky element counts, with its position as the reason", () => {
    expect(presenceReasons(info({ position: "fixed" }))).toEqual(["fixed"]);
    expect(presenceReasons(info({ position: "sticky" }))).toEqual(["sticky"]);
  });

  it("a dialog, an alert dialog and a live region count wherever they sit", () => {
    expect(presenceReasons(info({ role: "dialog" }))).toContain("dialog");
    expect(presenceReasons(info({ tag: "DIALOG" }))).toContain("dialog");
    expect(presenceReasons(info({ role: "alertdialog" }))).toContain("dialog");
    expect(presenceReasons(info({ ariaLive: "polite" }))).toContain("live");
    expect(presenceReasons(info({ ariaLive: "off" }))).toEqual([]);
  });

  it("an absolutely positioned layer along a viewport edge counts as edge", () => {
    expect(
      presenceReasons(
        info({
          position: "absolute",
          rect: { x: 0, y: 720, width: 1024, height: 80 },
        }),
      ),
    ).toEqual(["edge"]);
  });

  it("ordinary flow content does not count, even at the top of the page, and hidden elements never do", () => {
    expect(
      presenceReasons(info({ rect: { x: 0, y: 0, width: 1024, height: 64 } })),
    ).toEqual([]);
    expect(
      presenceReasons(info({ position: "fixed", visible: false })),
    ).toEqual([]);
  });
});

describe("presenceKey", () => {
  it("names an element by role and accessible name, so a div and a section with the same role match", () => {
    const a = presenceKey({
      tag: "DIV",
      role: "dialog",
      name: "Cookie preferences",
      text: "We use cookies",
    });
    const b = presenceKey({
      tag: "SECTION",
      role: "dialog",
      name: "Cookie  preferences ",
      text: "We use cookies to remember",
    });
    expect(a).toBe(b);
    expect(a).toContain("Cookie preferences");
  });

  it("falls back to tag and text, and never uses class names", () => {
    const key = presenceKey({
      tag: "BUTTON",
      role: null,
      name: "",
      text: " Chat\n with us ",
      className: "chat c_9f2a",
    });
    expect(key).toContain("Chat with us");
    expect(key).not.toContain("c_9f2a");
  });
});

describe("diffPresence", () => {
  it("identical inventories produce no findings, including routes where the element is absent on both sides", () => {
    expect(diffPresence(PROD(), PROD())).toEqual([]);
  });

  it("a banner production shows on a route and the target does not is missing on that route only", () => {
    const target = PROD().map((s) =>
      s.route === "/pricing" ? { ...s, items: [HEADER] } : s,
    );
    const findings = diffPresence(PROD(), target);
    expect(findings).toEqual([
      expect.objectContaining({
        check: CHECK,
        kind: "missing",
        route: "/pricing",
        width: 1024,
        state: "fresh",
        key: COOKIE.key,
      }),
    ]);
    expect(findings[0].message).toContain("/pricing");
    expect(findings[0].message).toContain("Cookie preferences");
  });

  it("an element the target adds on a route where production has none is extra", () => {
    const chat = { key: "BUTTON:Chat with us", reasons: ["fixed"] };
    const target = PROD().map((s) =>
      s.route === "/about" ? { ...s, items: [HEADER, chat] } : s,
    );
    const findings = diffPresence(PROD(), target);
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual(["extra"]);
    expect(findings[0]).toMatchObject({ route: "/about", key: chat.key });
  });

  it("a banner that comes back after it was dismissed is one wrong trigger state, not also an extra element", () => {
    const target = PROD().map((s) =>
      s.route === "/" && s.state === "dismissed"
        ? { ...s, items: [HEADER, COOKIE] }
        : s,
    );
    const findings = diffPresence(PROD(), target);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "trigger",
      route: "/",
      key: COOKIE.key,
    });
    expect(findings[0].message).toMatch(/dismiss/i);
  });

  it("compares each matrix case on its own: a notice shown only on narrow screens must stay narrow-only", () => {
    const notice = { key: "status:Offline", reasons: ["live"] };
    const prod = [
      snap("/", "fresh", [notice], 400),
      snap("/", "fresh", [], 1024),
    ];
    const target = [
      snap("/", "fresh", [notice], 400),
      snap("/", "fresh", [notice], 1024),
    ];
    const findings = diffPresence(prod, target);
    expect(findings).toEqual([
      expect.objectContaining({ kind: "extra", width: 1024 }),
    ]);
  });

  it("a route, case or state the target never captured is an error naming it, not a silent pass", () => {
    expect(() =>
      diffPresence(
        PROD(),
        PROD().filter((s) => s.route !== "/pricing"),
      ),
    ).toThrow(/\/pricing/);
    expect(() =>
      diffPresence(
        PROD(),
        PROD().filter((s) => s.state !== "dismissed"),
      ),
    ).toThrow(/dismissed/);
  });
});

describe("parseCliArgs", () => {
  const base = [
    "--prod",
    "https://example.com",
    "--target",
    "http://localhost:8080",
  ];

  it("needs at least one --route, and collects every one: presence is compared across routes", () => {
    expect(() => parseCliArgs(base)).toThrow(/--route/);
    expect(
      parseCliArgs([...base, "--route", "/", "--route", "/pricing"]).route,
    ).toEqual(["/", "/pricing"]);
  });

  it("defaults the matrix and the output folder, and takes extra dismiss selectors", () => {
    const args = parseCliArgs([...base, "--route", "/"]);
    expect(args.matrix).toBe("docs/migration/breakpoints.json");
    expect(args.out).toBe("artifacts/checks");
    expect(args.dismiss).toEqual([]);
    expect(
      parseCliArgs([
        ...base,
        "--route",
        "/",
        "--dismiss",
        '[data-consent="accept"]',
      ]).dismiss,
    ).toEqual(['[data-consent="accept"]']);
  });
});
