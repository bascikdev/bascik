// Unit tests for skills/bascik-refactor/scripts/compare-route.mjs and scripts/lib/project-deps.mjs: the pixel diff on
// raw RGBA buffers, the capture settings, generic interaction steps run against a fake page, the JSON report, and
// loading Playwright and sharp from the reader's project. No browser, no network.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIONS,
  acceptedFor,
  buildReport,
  contextOptions,
  loadAccepted,
  parseCliArgs,
  reportDirName,
  pixelDiff,
  runInteraction,
  validateStep,
} from "../../skills/bascik-refactor/scripts/compare-route.mjs";
import { routeUrl } from "../../skills/bascik-refactor/scripts/lib/capture.mjs";
import {
  loadPlaywright,
  loadSharp,
} from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** A width x height RGBA buffer filled with one color. */
const solid = (
  width: number,
  height: number,
  rgba: [number, number, number, number],
) => {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) buf.set(rgba, i * 4);
  return buf;
};

const setPixel = (
  buf: Buffer,
  width: number,
  x: number,
  y: number,
  rgba: [number, number, number, number],
) => buf.set(rgba, (y * width + x) * 4);

describe("pixelDiff", () => {
  it("identical buffers differ in no pixel", () => {
    const a = solid(4, 3, [10, 20, 30, 255]);
    expect(pixelDiff(a, Buffer.from(a), 4, 3)).toEqual({
      count: 0,
      total: 12,
      ratio: 0,
    });
  });

  it("a channel difference of exactly the tolerance (10) does not count; 11 does", () => {
    const a = solid(2, 2, [100, 100, 100, 255]);
    const b = Buffer.from(a);
    setPixel(b, 2, 0, 0, [110, 90, 100, 255]);
    expect(pixelDiff(a, b, 2, 2).count).toBe(0);
    setPixel(b, 2, 1, 1, [100, 100, 111, 255]);
    expect(pixelDiff(a, b, 2, 2)).toEqual({ count: 1, total: 4, ratio: 0.25 });
  });

  it("accepts a custom tolerance", () => {
    const a = solid(2, 1, [0, 0, 0, 255]);
    const b = solid(2, 1, [5, 0, 0, 255]);
    expect(pixelDiff(a, b, 2, 1, { tolerance: 4 }).count).toBe(2);
  });

  it("ignores masked regions and leaves them out of the total", () => {
    const a = solid(10, 10, [0, 0, 0, 255]);
    const b = Buffer.from(a);
    // A rotating review carousel slide in the top-left 3x2 corner differs everywhere.
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 3; x++) setPixel(b, 10, x, y, [255, 255, 255, 255]);
    setPixel(b, 10, 9, 9, [255, 0, 0, 255]);
    const result = pixelDiff(a, b, 10, 10, {
      masks: [{ x: 0, y: 0, width: 3, height: 2 }],
    });
    expect(result).toEqual({ count: 1, total: 94, ratio: 1 / 94 });
  });

  it("misuse: buffers that do not match width x height x 4 are rejected", () => {
    const a = solid(2, 2, [0, 0, 0, 255]);
    const b = solid(3, 2, [0, 0, 0, 255]);
    expect(() => pixelDiff(a, b, 2, 2)).toThrow(/size|length/i);
  });
});

describe("contextOptions", () => {
  it("captures with identical, deterministic settings for every matrix case", () => {
    expect(contextOptions({ width: 375, height: 812 })).toEqual({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "light",
    });
  });

  it("carries a matrix case's hover and orientation conditions", () => {
    expect(
      contextOptions({ width: 812, height: 375, hasTouch: true }),
    ).toMatchObject({ hasTouch: true, viewport: { width: 812, height: 375 } });
  });
});

/**
 * A fake page with one disclosure: a trigger (data-testid="menu-trigger", also role button "Menu", also selector
 * "#menu-button") and its panel (data-testid="menu-panel"). It behaves as a correct dropdown: click toggles, Escape,
 * an outside click and focus exit close it.
 */
const fakePage = () => {
  const state = { open: false, focused: false, hovered: false };
  const calls: string[] = [];
  const trigger = {
    click: async () => {
      calls.push("click");
      state.open = !state.open;
      state.focused = true;
    },
    hover: async () => {
      calls.push("hover");
      state.hovered = true;
    },
    focus: async () => {
      calls.push("focus");
      state.focused = true;
    },
    blur: async () => {
      calls.push("blur");
      state.focused = false;
      state.open = false;
    },
    press: async (key: string) => {
      calls.push(`press:${key}`);
      state.focused = true;
      if (key === "Enter" || key === " ") state.open = !state.open;
      if (key === "Escape") state.open = false;
    },
    getAttribute: async (name: string) =>
      name === "aria-expanded" ? String(state.open) : null,
    isVisible: async () => true,
    evaluate: async () => state.focused,
    count: async () => 1,
    nth: () => trigger,
    first: () => trigger,
  };
  const panel = {
    isVisible: async () => state.open,
    getAttribute: async () => null,
    evaluate: async () => false,
    count: async () => 1,
    nth: () => panel,
    first: () => panel,
  };
  // Two "+" buttons (quantity steppers), like a real page with duplicate accessible names.
  const twins = {
    ...trigger,
    count: async () => 2,
    nth: (i: number) => {
      calls.push(`nth:${i}`);
      return trigger;
    },
  };
  // Any element the page does not have: Playwright returns a locator that matches nothing.
  const none = {
    count: async () => 0,
    nth: () => none,
    first: () => none,
    getAttribute: async () => {
      throw new Error("locator.getAttribute: Timeout 30000ms exceeded.");
    },
    isVisible: async () => false,
    evaluate: async () => {
      throw new Error("locator.evaluate: Timeout 30000ms exceeded.");
    },
  };
  const pick = (key: string) => {
    if (key === "trigger") return trigger;
    if (key === "panel") return panel;
    if (key === "twins") return twins;
    return none;
  };
  const page = {
    locator: (selector: string) =>
      pick(
        selector === "#menu-button"
          ? "trigger"
          : selector === "#menu"
            ? "panel"
            : "none",
      ),
    getByTestId: (id: string) =>
      pick(
        id === "menu-trigger"
          ? "trigger"
          : id === "menu-panel"
            ? "panel"
            : "none",
      ),
    getByRole: (role: string, opts: { name?: string } = {}) =>
      pick(
        role === "button" && opts.name === "Menu"
          ? "trigger"
          : role === "button" && opts.name === "+"
            ? "twins"
            : "none",
      ),
    keyboard: {
      press: async (key: string) => {
        calls.push(`keyboard:${key}`);
        if (key === "Escape") state.open = false;
      },
    },
    mouse: {
      click: async (x: number, y: number) => {
        calls.push(`mouse:${x},${y}`);
        state.open = false;
        state.focused = false;
      },
    },
  };
  return { page, state, calls };
};

describe("runInteraction", () => {
  it("lists the supported actions", () => {
    expect([...ACTIONS].sort()).toEqual(
      [
        "click",
        "focus-out",
        "hover",
        "keyboard",
        "outside-click",
        "press",
      ].sort(),
    );
  });

  it("click opens: aria-expanded flips and the panel shows", async () => {
    const { page } = fakePage();
    const trace = await runInteraction(page, {
      name: "open menu",
      testId: "menu-trigger",
      panel: { testId: "menu-panel" },
      action: "click",
      expect: { ariaExpanded: true, visible: true, focused: true },
    });
    expect(trace).toMatchObject({
      name: "open menu",
      action: "click",
      ok: true,
      failures: [],
      before: { ariaExpanded: false, visible: false },
      after: { ariaExpanded: true, visible: true, focused: true },
    });
  });

  it("Escape (keyboard), an outside click and focus exit each close it", async () => {
    for (const step of [
      { action: "keyboard", key: "Escape" },
      { action: "outside-click" },
      { action: "focus-out" },
    ]) {
      const { page, state } = fakePage();
      state.open = true;
      state.focused = true;
      const trace = await runInteraction(page, {
        name: `close by ${step.action}`,
        role: "button",
        roleName: "Menu",
        panel: { selector: "#menu" },
        ...step,
        expect: { ariaExpanded: false, visible: false },
      });
      expect(trace.ok, step.action).toBe(true);
      expect(state.open, step.action).toBe(false);
    }
  });

  it("press focuses the trigger and presses the key on it", async () => {
    const { page, calls } = fakePage();
    const trace = await runInteraction(page, {
      name: "open with Enter",
      selector: "#menu-button",
      action: "press",
      key: "Enter",
      expect: { ariaExpanded: true },
    });
    expect(trace.ok).toBe(true);
    expect(calls).toContain("press:Enter");
  });

  it("a mismatch fails the step and says which expectation and what was seen", async () => {
    const { page } = fakePage();
    const trace = await runInteraction(page, {
      name: "hover does not open",
      testId: "menu-trigger",
      panel: { testId: "menu-panel" },
      action: "hover",
      expect: { visible: true },
    });
    expect(trace.ok).toBe(false);
    expect(trace.failures.join("\n")).toMatch(
      /visible.*expected true.*got false/i,
    );
  });

  it("misuse: a trigger that does not exist fails at once, naming the locator and the case (no 30 s timeout)", async () => {
    const { page } = fakePage();
    const started = Date.now();
    await expect(
      runInteraction(
        page,
        { name: "open", testId: "menu-triger", action: "click" },
        0,
        { label: "575x812" },
      ),
    ).rejects.toThrow(/trigger testId "menu-triger" not found at 575x812/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("misuse: a missing panel is named too", async () => {
    const { page } = fakePage();
    await expect(
      runInteraction(page, {
        name: "open",
        testId: "menu-trigger",
        panel: { selector: "#drawer" },
        action: "click",
      }),
    ).rejects.toThrow(/panel selector "#drawer" not found/);
  });

  it("misuse: a role and name that match two elements asks for nth, and nth picks one", async () => {
    const { page, calls } = fakePage();
    await expect(
      runInteraction(page, {
        name: "increment",
        role: "button",
        roleName: "+",
        action: "click",
      }),
    ).rejects.toThrow(/role button "\+" matches 2 elements.*"nth"/);
    const trace = await runInteraction(page, {
      name: "increment",
      role: "button",
      roleName: "+",
      nth: 1,
      action: "click",
    });
    expect(trace.ok).toBe(true);
    expect(calls).toContain("nth:1");
  });

  it("misuse: nth must be a non-negative integer", () => {
    expect(() =>
      validateStep({ name: "bad", testId: "x", action: "click", nth: -1 }, 2),
    ).toThrow(/interactions\[2\].*nth/);
  });

  it("misuse: an unknown action names the step and the supported actions", async () => {
    const { page } = fakePage();
    await expect(
      runInteraction(page, {
        name: "swipe",
        testId: "menu-trigger",
        action: "swipe",
      }),
    ).rejects.toThrow(/swipe[\s\S]*click/);
  });

  it("misuse: a step with neither selector, testId nor role is rejected by name", () => {
    expect(() => validateStep({ name: "orphan", action: "click" }, 3)).toThrow(
      /interactions\[3\].*orphan.*selector.*testId.*role/,
    );
  });

  it("misuse: press and keyboard need a key", () => {
    expect(() =>
      validateStep({ name: "no key", testId: "x", action: "press" }, 0),
    ).toThrow(/key/);
    expect(() =>
      validateStep({ name: "no key", testId: "x", action: "keyboard" }, 0),
    ).toThrow(/key/);
  });
});

describe("buildReport", () => {
  const passing = {
    width: 375,
    height: 812,
    pixels: { count: 0, total: 304500, ratio: 0 },
    interactions: [{ name: "open menu", ok: true, failures: [] }],
    screenshots: { prod: "prod-375x812.png", target: "target-375x812.png" },
  };

  it("passes when every case is under the pixel budget and every interaction passes", () => {
    const report = buildReport({
      route: "/",
      prod: "https://www.example.com",
      target: "http://localhost:8080",
      tolerance: 10,
      maxRatio: 0.01,
      cases: [passing],
    });
    expect(report).toMatchObject({
      route: "/",
      prod: "https://www.example.com",
      target: "http://localhost:8080",
      tolerance: 10,
      maxRatio: 0.01,
      ok: true,
      failures: [],
    });
    expect(report.cases[0]).toMatchObject({
      width: 375,
      height: 812,
      ok: true,
    });
  });

  it("fails and names the case for a pixel ratio over budget or a failed interaction", () => {
    const report = buildReport({
      route: "/",
      prod: "https://www.example.com",
      target: "http://localhost:8080",
      tolerance: 10,
      maxRatio: 0.01,
      cases: [
        passing,
        {
          ...passing,
          width: 768,
          height: 1024,
          pixels: { count: 50000, total: 786432, ratio: 0.0636 },
        },
        {
          ...passing,
          width: 1440,
          height: 900,
          interactions: [
            {
              name: "close on Escape",
              ok: false,
              failures: ["ariaExpanded: expected false, got true"],
            },
          ],
        },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.cases.map((c: { ok: boolean }) => c.ok)).toEqual([
      true,
      false,
      false,
    ]);
    const text = report.failures.join("\n");
    expect(text).toMatch(/768x1024.*pixel/i);
    expect(text).toMatch(/1440x900.*close on Escape/);
  });

  it("an empty case list never passes", () => {
    expect(
      buildReport({
        route: "/",
        prod: "a",
        target: "b",
        tolerance: 10,
        maxRatio: 0.01,
        cases: [],
      }).ok,
    ).toBe(false);
  });
});

describe("accepted differences (decisions ledger rows the comparison may pass)", () => {
  const accepted = [
    {
      id: "D-01",
      route: "/",
      mask: ["footer"],
      reason: "footer contrast raised to 4.6:1",
    },
    { id: "D-02", maxWidth: 767, maxRatio: 0.02 },
    { id: "D-03", route: "/pricing", minWidth: 1024, mask: [".slider"] },
  ];

  it("collects the masks, the budget and the ledger ids that apply to a route and case", () => {
    expect(acceptedFor(accepted, "/", { width: 375, height: 812 })).toEqual({
      ids: ["D-01", "D-02"],
      masks: ["footer"],
      maxRatio: 0.02,
    });
    expect(acceptedFor(accepted, "/", { width: 1440, height: 900 })).toEqual({
      ids: ["D-01"],
      masks: ["footer"],
      maxRatio: undefined,
    });
    expect(
      acceptedFor(accepted, "/pricing", { width: 1440, height: 900 }),
    ).toEqual({ ids: ["D-03"], masks: [".slider"], maxRatio: undefined });
    expect(acceptedFor([], "/", { width: 375, height: 812 })).toEqual({
      ids: [],
      masks: [],
      maxRatio: undefined,
    });
  });

  it("a case under an accepted budget passes and the report names the ledger row", () => {
    const report = buildReport({
      route: "/",
      prod: "p",
      target: "t",
      tolerance: 10,
      maxRatio: 0.001,
      cases: [
        {
          width: 375,
          height: 812,
          pixels: { count: 1500, total: 100000, ratio: 0.015 },
          accepted: { ids: ["D-02"], masks: [], maxRatio: 0.02 },
        },
        {
          width: 1440,
          height: 900,
          pixels: { count: 1500, total: 100000, ratio: 0.015 },
          accepted: { ids: [], masks: [], maxRatio: undefined },
        },
      ],
    });
    expect(report.cases.map((c: { ok: boolean }) => c.ok)).toEqual([
      true,
      false,
    ]);
    expect(report.failures.join("\n")).toMatch(/1440x900.*budget 0\.10%/);
  });

  it("reads accepted.json and rejects an entry without a ledger id or with a bad budget, by index", () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-accepted-"));
    try {
      const good = join(dir, "accepted.json");
      writeFileSync(good, JSON.stringify(accepted));
      expect(loadAccepted(good)).toEqual(accepted);
      const noId = join(dir, "no-id.json");
      writeFileSync(noId, JSON.stringify([{ mask: ["footer"] }]));
      expect(() => loadAccepted(noId)).toThrow(/no-id\.json.*\[0\].*id/);
      const badRatio = join(dir, "bad-ratio.json");
      writeFileSync(badRatio, JSON.stringify([{ id: "D-9", maxRatio: 5 }]));
      expect(() => loadAccepted(badRatio)).toThrow(/\[0\].*maxRatio/);
      const nothing = join(dir, "nothing.json");
      writeFileSync(nothing, JSON.stringify([{ id: "D-9", route: "/" }]));
      expect(() => loadAccepted(nothing)).toThrow(/D-9.*mask.*maxRatio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("routeUrl", () => {
  it("joins a route onto an origin", () => {
    expect(routeUrl("http://localhost:8080", "/pricing")).toBe(
      "http://localhost:8080/pricing",
    );
    expect(routeUrl("http://localhost:8080/", "/")).toBe(
      "http://localhost:8080/",
    );
  });

  it("keeps a base path on the origin (a Bascik build with base set)", () => {
    expect(routeUrl("http://localhost:8080/docs", "/pricing")).toBe(
      "http://localhost:8080/docs/pricing",
    );
    expect(routeUrl("https://www.example.com/docs/", "/")).toBe(
      "https://www.example.com/docs/",
    );
  });
});

describe("parseCliArgs", () => {
  it("parses the documented flags with their defaults", () => {
    const args = parseCliArgs([
      "--prod",
      "https://www.example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/",
      "--route",
      "/contact",
      "--matrix",
      "docs/migration/breakpoints.json",
      "--interactions",
      "docs/migration/interactions.json",
      "--mask",
      "[data-testid=review-carousel]",
      "--mask",
      ".cookie-notice",
      "--accepted",
      "docs/migration/accepted.json",
    ]);
    expect(args).toMatchObject({
      prod: "https://www.example.com",
      target: "http://localhost:8080",
      route: ["/", "/contact"],
      matrix: "docs/migration/breakpoints.json",
      interactions: "docs/migration/interactions.json",
      mask: ["[data-testid=review-carousel]", ".cookie-notice"],
      accepted: "docs/migration/accepted.json",
      tolerance: 10,
      maxRatio: 0.001,
      out: "artifacts/compare",
    });
  });

  it("misuse: a missing --route or a negative --tolerance names the flag", () => {
    expect(() =>
      parseCliArgs(["--prod", "a", "--target", "b", "--matrix", "m.json"]),
    ).toThrow(/--route/);
    expect(() =>
      parseCliArgs([
        "--prod",
        "a",
        "--target",
        "b",
        "--route",
        "/",
        "--matrix",
        "m.json",
        "--tolerance",
        "-1",
      ]),
    ).toThrow(/--tolerance/);
  });
});

describe("report folders (one per route under --out)", () => {
  const withRoutes = (...routes: string[]) =>
    parseCliArgs([
      "--prod",
      "a",
      "--target",
      "b",
      ...routes.flatMap((route) => ["--route", route]),
    ]);

  it("misuse: a route that is not a site path, or has a . or .. segment, is rejected by name before any capture", () => {
    for (const bad of [
      "..",
      "/..",
      "/a/../b",
      "/./x",
      "/a/.",
      "pricing",
      "https://evil.example/x",
      "/a/..?x=1",
    ]) {
      expect(() => withRoutes(bad), bad).toThrow(
        new RegExp(`--route.*${bad.replace(/[.?/\\]/g, "\\$&")}`),
      );
    }
  });

  it("misuse: the same route twice is rejected rather than overwriting its own report", () => {
    expect(() => withRoutes("/pricing", "/pricing")).toThrow(
      /--route \/pricing.*twice/,
    );
  });

  it("never names a folder outside --out: no separator, no dot segment", () => {
    const out = "/tmp/compare-out";
    for (const route of [
      "/",
      "/a/b",
      "/a%2F..%2Fb",
      "/.well-known/x",
      "/a.b",
    ]) {
      const name = reportDirName(route);
      expect(name, route).toMatch(/^[a-z0-9_-]+$/);
      expect(relative(out, resolve(out, name)), route).toBe(name);
    }
  });

  it("gives distinct routes distinct folders, also on a case-insensitive disk", () => {
    const routes = [
      "/",
      "/index",
      "/a/b",
      "/a_b",
      "/a-b",
      "/A",
      "/a",
      "/a/",
      "/search?q=1",
      "/search?q=2",
    ];
    const names = routes.map((route) => reportDirName(route).toLowerCase());
    expect(new Set(names).size).toBe(routes.length);
  });

  it("keeps the folder readable: it starts with the route's slug", () => {
    expect(reportDirName("/")).toMatch(/^index-[0-9a-f]{8}$/);
    expect(reportDirName("/pricing")).toMatch(/^pricing-[0-9a-f]{8}$/);
    expect(reportDirName("/blog/first-post")).toMatch(
      /^blog_first-post-[0-9a-f]{8}$/,
    );
    // The same route always lands in the same folder, so a rerun replaces its own report.
    expect(reportDirName("/pricing")).toBe(reportDirName("/pricing"));
  });
});

describe("project dependencies", () => {
  const emptyProject = (fn: (dir: string) => Promise<void>) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-deps-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"empty","private":true}',
      );
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it(
    "misuse: a project without Playwright gets the exact install commands",
    emptyProject(async (dir) => {
      await expect(loadPlaywright({ cwd: dir })).rejects.toThrow(
        /npm install -D playwright[\s\S]*npx playwright install chromium/,
      );
    }),
  );

  it(
    "misuse: a project without sharp gets the exact install command",
    emptyProject(async (dir) => {
      await expect(loadSharp({ cwd: dir })).rejects.toThrow(
        /npm install -D sharp/,
      );
    }),
  );

  it("loads Playwright and sharp from the project that has them", async () => {
    const playwright = await loadPlaywright({ cwd: packageDir });
    expect(typeof playwright.chromium?.launch).toBe("function");
    const sharp = await loadSharp({ cwd: packageDir });
    expect(typeof sharp).toBe("function");
  });
});
