/**
 * The text keys the parity checks match elements by, in a real browser, from tests/fixtures/refactor-parity/text-keys/:
 * production as React writes it (no whitespace between elements, a `<br>` with no space around it, the small-screen
 * menu rendered only while open) and a target with the same page as Prettier formats it, with the closed menu kept in
 * the markup as a `hidden` list. The pages look the same, so presence-by-route, overlap-diff and spacing-diff must
 * match every element. A target whose text really changed must still differ.
 *
 * Why: keys were built from raw textContent with whitespace collapsed, not removed, and included text the reader never
 * sees, so a pixel-identical fixed header was reported as one missing and one extra layer, the hero's overlaps as
 * missing and the footer as a missing section on every route at every width.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import { inPage } from "../../skills/bascik-refactor/scripts/lib/dom.mjs";
import {
  packageDir,
  serveFixtures,
  type FixtureServer,
} from "./refactor-parity-fixtures.ts";

const SCRIPTS = fileURLToPath(
  new URL("../../skills/bascik-refactor/scripts/", import.meta.url),
);

type Finding = { check: string; kind: string; message: string };
type Result = { check: string; ok: boolean; findings: Finding[] };
type CheckModule = {
  runCheck: (
    browser: unknown,
    options: Record<string, unknown>,
  ) => Promise<Result>;
};

const show = (r: Result) =>
  r.findings.map((f) => `${f.kind}: ${f.message}`).join("\n") || "(none)";

let server: FixtureServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the project's Playwright, loaded at run time
let browser: any;
let out: string;

beforeAll(async () => {
  server = await serveFixtures();
  const { chromium } = await loadPlaywright({ cwd: packageDir });
  browser = await chromium.launch();
  out = mkdtempSync(join(tmpdir(), "bascik-text-keys-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

async function run(check: string, target: "target" | "changed") {
  const mod = (await import(join(SCRIPTS, `${check}.mjs`))) as CheckModule;
  return mod.runCheck(browser, {
    prod: `${server.origin}/text-keys/prod`,
    target: `${server.origin}/text-keys/${target}`,
    route: "/",
    cases: [{ width: 1280, height: 800 }],
    out: join(out, check, target),
    settleMs: 0,
  });
}

describe("text keys ignore markup whitespace and text the reader never sees", () => {
  it("keyText reads rendered text only and textKey cuts at the same place on both sides", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const long = "Silky milk foam ".repeat(10);
      await page.setContent(
        `<header id="a"><a>MILK<br>FROTHER</a><nav><a>Home</a></nav><ul hidden><li>Menu</li></ul><span style="visibility:hidden">Ghost</span><script>var x = 1;</script></header>` +
          `<header id="b">\n  <a>\n    MILK\n    <br />\n    FROTHER\n  </a>\n  <nav>\n    <a>Home</a>\n  </nav>\n</header>` +
          `<p id="c">${long.replaceAll(" ", "")}</p><p id="d">${long}</p><div id="e" hidden><b>Closed</b> <i>panel</i></div>`,
      );
      const keys: Record<string, string> = await inPage(
        page,
        `function () { return Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, textKey(document.getElementById(id))])); }`,
      );
      expect(keys.a).toBe("HEADER:MILKFROTHERHome");
      expect(keys.b).toBe("HEADER:MILK FROTHER Home");
      // Cut after the same number of visible characters, so the stripped keys agree.
      expect(keys.c.replace(/\s+/g, "")).toBe(keys.d.replace(/\s+/g, ""));
      expect(keys.c.length).toBeLessThanOrEqual(90);
      // An element that is itself hidden keeps all its text, so a closed panel has the key it has once open.
      expect(keys.e).toBe("DIV:Closed panel");
    } finally {
      await context.close();
    }
  }, 60_000);

  it("keyText reads text inside a display: contents wrapper, which has no box of its own", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(
        `<p id="a"><span style="display:contents">Hello</span> world</p>` +
          `<p id="b">Hello world</p>` +
          // A wrapper with no box inside a hidden one, or hidden itself, still shows nothing.
          `<p id="c"><span style="display:none"><span style="display:contents">Gone</span></span> kept</p>` +
          `<p id="d"><span style="display:contents;visibility:hidden">Ghost</span> kept</p>` +
          `<p id="e"><span style="display:contents"><span style="display:contents">Deep</span></span> text</p>`,
      );
      const keys: Record<string, string> = await inPage(
        page,
        `function () { return Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, textKey(document.getElementById(id))])); }`,
      );
      expect(keys.a).toBe("P:Hello world");
      expect(keys.a).toBe(keys.b);
      expect(keys.c).toBe("P:kept");
      expect(keys.d).toBe("P:kept");
      expect(keys.e).toBe("P:Deep text");
    } finally {
      await context.close();
    }
  }, 60_000);

  it("geometry-diff: a long card link and a display: contents wrapper match across React and formatted markup", async () => {
    const { collectNodes, diffGeometry } = await import(
      join(SCRIPTS, "geometry-diff.mjs")
    );
    const snap = async (side: string) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/text-keys/${side}/`);
        return await page.evaluate(collectNodes);
      } finally {
        await context.close();
      }
    };
    const prod = await snap("prod");
    const card = Object.keys(prod).find((k) =>
      k.startsWith("A:Milk frother deluxe"),
    );
    // The card's text is longer than the cut, so where the cut lands must not depend on markup whitespace.
    expect(card?.replace(/\s+/g, "").length).toBeGreaterThan(60);
    const same = diffGeometry(prod, await snap("target"));
    expect(same, JSON.stringify(same, null, 2)).toMatchObject({
      ok: true,
      missing: [],
      extra: [],
    });
    const changed = diffGeometry(prod, await snap("changed"));
    expect(changed.missing).toContain("H1:Froth at home");
    expect(changed.extra).toContain("H1:Froth at work");
  }, 120_000);

  it("testid-carryover: a hook on a long card link stays on the same element across React and formatted markup", async () => {
    const mod = (await import(
      join(SCRIPTS, "testid-carryover.mjs")
    )) as CheckModule;
    const empty = mkdtempSync(join(out, "legacy-"));
    const check = (target: string) =>
      mod.runCheck(browser, {
        prod: `${server.origin}/text-keys/prod`,
        target: `${server.origin}/text-keys/${target}`,
        route: "/",
        cases: [{ width: 1280, height: 800 }],
        legacySrc: empty,
        targetSrc: empty,
        settleMs: 0,
      });
    const same = await check("target");
    expect(same.findings, show(same)).toEqual([]);
    // A real text change still moves the hook: the hero's heading changed.
    const changed = await check("changed");
    expect(
      changed.findings.some(
        (f) => f.kind === "moved" && /data-testid="hero"/.test(f.message),
      ),
      show(changed),
    ).toBe(true);
  }, 240_000);

  for (const check of ["presence-by-route", "overlap-diff", "spacing-diff"])
    it(`${check}: React markup and the same page formatted by Prettier match`, async () => {
      const r = await run(check, "target");
      expect(r.findings, show(r)).toEqual([]);
    }, 240_000);

  it("a real text change still differs in each check", async () => {
    const presence = await run("presence-by-route", "changed");
    expect(
      presence.findings.some(
        (f) => f.kind === "missing" && /Contact/.test(f.message),
      ),
      show(presence),
    ).toBe(true);
    const overlap = await run("overlap-diff", "changed");
    expect(
      overlap.findings.some(
        (f) => f.kind === "missing-overlap" && /Froth at home/.test(f.message),
      ),
      show(overlap),
    ).toBe(true);
    const spacing = await run("spacing-diff", "changed");
    expect(
      spacing.findings.some(
        (f) => f.kind === "missing-section" && /Copyright 2026/.test(f.message),
      ),
      show(spacing),
    ).toBe(true);
  }, 480_000);
});
