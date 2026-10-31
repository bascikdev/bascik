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
