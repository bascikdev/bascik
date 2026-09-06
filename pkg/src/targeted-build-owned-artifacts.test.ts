/**
 * Prompt 101: targeted-build owned artifact transactions.
 *
 * A targeted build (`bascik --build --only …`) runs in a FRESH CLI process. Its
 * process-local collectors and in-memory route caches are empty, so without a
 * durable source-to-output ownership inventory a targeted build would:
 *   - silently drop untouched B's server-sidecar entry (the sidecar writer
 *     serializes only this process's registry), and
 *   - leave a removed generated route's HTML + manifest + CSP behind (the
 *     removed-route knowledge lived only in the in-memory
 *     templateToGeneratedRelativePaths map).
 *
 * These tests run REAL `bascik --build` and `bascik --build --only` child
 * processes against an isolated fixture, then compare the ACTUAL disk
 * inventory and metadata, not just JSON counts. A real production server is
 * started over untouched B to prove its request-time server script still works
 * after A is rebuilt.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  readEmittedFiles,
  runRealBuild,
  toInventory,
  writeFixtureFile,
  writeWorkersConfig,
} from "./lib/build-fixtures.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runBuild = (root: string, args?: string[]) =>
  runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY, args });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// pkg entry point; the same one runRealBuild uses (Node runs .ts directly).
// `--server` serves the fixture's own dist/ output (created by runBuild), so we
// spawn the source entrypoint rather than the compiled pkg/dist/index.js. The
// compiled output is gitignored (not present in the CI unit-test job, which runs
// vitest over .ts source without a prior build), so depending on it here would
// flake with ECONNREFUSED in CI. Node 24 runs .ts directly.
const PKG_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

/** Start `bascik --server` on a fixture and return a fetch helper + teardown. */
const startServerFixture = async (root: string, port: number) => {
  const child = spawn(process.execPath, [PKG_ENTRY, "--server"], {
    cwd: root,
    env: { ...process.env, BASCIK_SERVER_PORT: String(port), BASCIK_ENABLE_TLS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://localhost:${port}`;
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += d.toString(); });
  // Wait for the server to accept connections.
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const res = await fetch(`${base}/`);
      if (res.status >= 200) break;
    } catch {
      await wait(150);
    }
  }
  return {
    base,
    async close() {
      child.kill();
      await wait(150);
    },
    stderr: () => stderr,
  };
};

/**
 * Build a fixture whose `a.html` carries a server script and whose `[slug].html`
 * template emits N routes rounded up. After a full build, mutate the template
 * to emit fewer routes and the server script out of `a.html`, then run a fresh
 * targeted build that rebuilds only `a.html` and `[slug].html`.
 */
const writeOwnedFixture = async (root: string, opts: { workers: boolean }) => {
  await writeWorkersConfig(root, opts.workers);
  await writeFixtureFile(
    root,
    "src/components/card.html",
    `<article class="card"><h2><slot></slot></h2></article>`,
  );
  // Untouched B: carries a request-time server script that returns a marker.
  await writeFixtureFile(
    root,
    "src/pages/b.html",
    `<!DOCTYPE html><html><head><title>B</title></head><body>
  <p data-testid="b">B page</p>
  <script data-bascik-server>export default () => '<div data-testid="b-server">B server value</div>';</script>
  </body></html>`,
  );
  // a.html: carries a server script that we will REMOVE in the targeted step.
  await writeFixtureFile(
    root,
    "src/pages/a.html",
    `<!DOCTYPE html><html><head><title>A</title></head><body>
  <p data-testid="a">A page</p>
  <script data-bascik-server>export default () => '<div data-testid="a-server">A server value</div>';</script>
  </body></html>`,
  );
  // Dynamic template emitting two routes.
  await writeFixtureFile(
    root,
    "src/pages/blog/[slug].html",
    `<!DOCTYPE html><html><head><title>Blog</title>
  <script data-bascik-routes>console.log(JSON.stringify([
    { params: { slug: "one" }, data: { title: "One" } },
    { params: { slug: "two" }, data: { title: "Two" } },
  ]));</script></head>
  <body><h1 data-testid="post">post</h1></body></html>`,
  );
};

describe("targeted build owned artifact transactions (fresh CLI processes)", () => {
  for (const workers of [false, true]) {
    it(`preserves untouched B's sidecar and prunes rebuilt owners (workers=${workers})`, async () => {
      const root = fixtureRoot(`owned-${workers}`);
      await writeOwnedFixture(root, { workers });
      try {
        // 1. Full build: B and A both have server scripts; template emits one+two.
        const full = await runBuild(root);
        expect(full.stdout).toContain("Build complete");
        const fullInv = toInventory(await readEmittedFiles(join(root, "dist")));

        // B sidecar entry exists after full build.
        const fullSidecar = Object.values(fullInv.sidecar);
        expect(fullSidecar.some((s) => s.includes("B server value"))).toBe(true);
        expect(fullSidecar.some((s) => s.includes("A server value"))).toBe(true);
        expect(fullInv.files["blog/one.html"]).toBeDefined();
        expect(fullInv.files["blog/two.html"]).toBeDefined();

        // 2. Fresh targeted build: remove A's server script, shrink template to ONE route.
        await writeFixtureFile(
          root,
          "src/pages/a.html",
          `<!DOCTYPE html><html><head><title>A</title></head><body>
  <p data-testid="a">A page (no server script)</p></body></html>`,
        );
        await writeFixtureFile(
          root,
          "src/pages/blog/[slug].html",
          `<!DOCTYPE html><html><head><title>Blog</title>
  <script data-bascik-routes>console.log(JSON.stringify([
    { params: { slug: "one" }, data: { title: "One" } },
  ]));</script></head>
  <body><h1 data-testid="post">post</h1></body></html>`,
        );
        const targeted = await runBuild(root, ["--only", "a.html", "--only", "blog/*.html"]);
        expect(targeted.stdout).toContain("Build complete");

        const targetedInv = toInventory(await readEmittedFiles(join(root, "dist")));

        // B's sidecar entry must survive (untouched owner retained).
        const bEntry = Object.values(targetedInv.sidecar).find((s) => s.includes("B server value"));
        expect(bEntry, "untouched B sidecar entry must survive targeted rebuild of A").toBeDefined();

        // A's removed server script must be pruned.
        const aEntry = Object.values(targetedInv.sidecar).find((s) => s.includes("A server value"));
        expect(aEntry, "removed A server script must be pruned from sidecar").toBeUndefined();

        // Removed route two must be gone from disk, manifest, and CSP.
        expect(existsSync(join(root, "dist", "blog", "two.html"))).toBe(false);
        expect(targetedInv.files["blog/two.html"]).toBeUndefined();
        expect(targetedInv.csp["/blog/two"]).toBeUndefined();
        // Route one survives.
        expect(targetedInv.files["blog/one.html"]).toBeDefined();

        // Untouched B page file itself remains and its manifest/CSP entries survive.
        expect(targetedInv.files["b.html"]).toBeDefined();
        expect(targetedInv.files["a.html"]).toBeDefined();
        expect(targetedInv.csp["/b"]).toBeDefined();
      } finally {
        await cleanupFixture(root);
      }
    }, 90000);
  }

  for (const workers of [false, true]) {
    it(`untouched B keeps a working server script request-time after rebuilding A (workers=${workers})`, async () => {
      const root = fixtureRoot(`owned-server-${workers}`);
      await writeOwnedFixture(root, { workers });
      try {
        await runBuild(root);

        // Targeted rebuild of A ONLY (removes A's script). B untouched.
        await writeFixtureFile(
          root,
          "src/pages/a.html",
          `<!DOCTYPE html><html><head><title>A</title></head><body>
  <p data-testid="a">A page (no server script)</p></body></html>`,
        );
        const targeted = await runBuild(root, ["--only", "a.html"]);
        expect(targeted.stdout).toContain("Build complete");

        // Start a real production server and request B; its server script must run.
        const srv = await startServerFixture(root, 9987);
        try {
          const res = await fetch(`${srv.base}/b`);
          expect(res.status).toBe(200);
          const html = await res.text();
          expect(html).toContain("B server value");
        } finally {
          await srv.close();
        }
      } finally {
        await cleanupFixture(root);
      }
    }, 120000);
  }

  for (const workers of [false, true]) {
    it(`prunes a route set that shrinks to zero in a fresh targeted build (workers=${workers})`, async () => {
      const root = fixtureRoot(`owned-zero-${workers}`);
      await createFixtureDirs(root);
      await writeWorkersConfig(root, workers);
      try {
        await writeFixtureFile(
          root,
          "src/pages/blog/[slug].html",
          `<!DOCTYPE html><html><head><title>Blog</title>
  <script data-bascik-routes>console.log(JSON.stringify([
    { params: { slug: "one" }, data: { title: "One" } },
    { params: { slug: "two" }, data: { title: "Two" } },
  ]));</script></head>
  <body><h1>post</h1></body></html>`,
        );
        const full = await runBuild(root);
        expect(full.stdout).toContain("Build complete");
        expect(toInventory(await readEmittedFiles(join(root, "dist"))).files["blog/one.html"]).toBeDefined();
        expect(toInventory(await readEmittedFiles(join(root, "dist"))).files["blog/two.html"]).toBeDefined();

        // Template now emits zero routes.
        await writeFixtureFile(
          root,
          "src/pages/blog/[slug].html",
          `<!DOCTYPE html><html><head><title>Blog</title>
  <script data-bascik-routes>console.log(JSON.stringify([]));</script></head>
  <body><h1>post</h1></body></html>`,
        );
        const targeted = await runBuild(root, ["--only", "blog/*.html"]);
        expect(targeted.stdout).toContain("Build complete");

        const inv = toInventory(await readEmittedFiles(join(root, "dist")));
        // Both removed routes pruned from disk, manifest, and CSP.
        expect(existsSync(join(root, "dist", "blog", "one.html"))).toBe(false);
        expect(existsSync(join(root, "dist", "blog", "two.html"))).toBe(false);
        expect(inv.files["blog/one.html"]).toBeUndefined();
        expect(inv.files["blog/two.html"]).toBeUndefined();
        expect(inv.csp["/blog/one"]).toBeUndefined();
        expect(inv.csp["/blog/two"]).toBeUndefined();
      } finally {
        await cleanupFixture(root);
      }
    }, 90000);
  }

  for (const workers of [false, true]) {
    it(`zero-route shrink across TWO fresh targeted builds prunes once and stays pruned (workers=${workers})`, async () => {
      const root = fixtureRoot(`owned-zero-2-${workers}`);
      await createFixtureDirs(root);
      await writeWorkersConfig(root, workers);
      try {
        // A dynamic template that emits two routes, each with its own server
        // script, plus a second page with a server script we never touch.
        await writeFixtureFile(
          root,
          "src/pages/a.html",
          `<!DOCTYPE html><html><head><title>A</title></head><body>
  <p data-testid="a">A</p>
  <script data-bascik-server>export default () => '<div data-testid="a-server">A server</div>';</script>
  </body></html>`,
        );
        await writeFixtureFile(
          root,
          "src/pages/blog/[slug].html",
          `<!DOCTYPE html><html><head><title>Blog</title>
  <script data-bascik-routes>console.log(JSON.stringify([
    { params: { slug: "one" }, data: { title: "One" } },
    { params: { slug: "two" }, data: { title: "Two" } },
  ]));</script></head>
  <body><h1 data-testid="post">post</h1>
  <script data-bascik-server>export default () => '<div data-testid="blog-server">Blog server</div>';</script>
  </body></html>`,
        );
        const full = await runBuild(root);
        expect(full.stdout).toContain("Build complete");
        expect(toInventory(await readEmittedFiles(join(root, "dist"))).files["blog/one.html"]).toBeDefined();
        expect(toInventory(await readEmittedFiles(join(root, "dist"))).files["blog/two.html"]).toBeDefined();

        // Template now emits ZERO routes. Run TWO fresh targeted builds in a row.
        await writeFixtureFile(
          root,
          "src/pages/blog/[slug].html",
          `<!DOCTYPE html><html><head><title>Blog</title>
  <script data-bascik-routes>console.log(JSON.stringify([]));</script></head>
  <body><h1 data-testid="post">post</h1>
  <script data-bascik-server>export default () => '<div data-testid="blog-server">Blog server</div>';</script>
  </body></html>`,
        );
        const targeted1 = await runBuild(root, ["--only", "blog/*.html"]);
        expect(targeted1.stdout).toContain("Build complete");
        const targeted2 = await runBuild(root, ["--only", "blog/*.html"]);
        expect(targeted2.stdout).toContain("Build complete");

        const inv = toInventory(await readEmittedFiles(join(root, "dist")));
        // (a) Removed routes are pruned from disk, manifest, and CSP after a
        // successful staged commit on the first targeted build, and stay pruned
        // after a second fresh targeted build.
        expect(existsSync(join(root, "dist", "blog", "one.html"))).toBe(false);
        expect(existsSync(join(root, "dist", "blog", "two.html"))).toBe(false);
        expect(inv.files["blog/one.html"]).toBeUndefined();
        expect(inv.files["blog/two.html"]).toBeUndefined();
        expect(inv.csp["/blog/one"]).toBeUndefined();
        expect(inv.csp["/blog/two"]).toBeUndefined();

        // Untouched A page and its server script survive.
        expect(inv.files["a.html"]).toBeDefined();
        expect(Object.values(inv.sidecar).some((s) => s.includes("A server"))).toBe(true);

        // (b) The zero-route owner's pair of sidecar script entries is dropped
        // from the sidecar exactly once. Bascik stores server-script bodies
        // inline in server-scripts.json (no separate .js files under
        // dist/.bascik/server-scripts/), so the sidecar entry removal is the
        // only cleanup the (now inert, unreachable) bodies require.
        const blogScriptEntries = Object.values(inv.sidecar).filter((s) => s.includes("Blog server"));
        expect(blogScriptEntries, "zero-route owner's sidecar entries must be dropped").toEqual([]);
      } finally {
        await cleanupFixture(root);
      }
    }, 120000);
  }

  for (const workers of [false, true]) {
    it(`does not corrupt the previous valid artifact set when a targeted update fails (workers=${workers})`, async () => {
      const root = fixtureRoot(`owned-fail-${workers}`);
      await writeOwnedFixture(root, { workers });
      try {
        const full = await runBuild(root);
        expect(full.stdout).toContain("Build complete");
        const beforeSidecar = (await readFile(join(root, "dist", ".bascik", "server-scripts.json"), "utf8"));
        const beforeOwnership = (await readFile(join(root, "dist", ".bascik", "ownership.json"), "utf8"));

        // Corrupt a rebuilt page's source so the targeted build of A fails.
        await writeFixtureFile(
          root,
          "src/pages/a.html",
          `<!DOCTYPE html><html><head><title>A</title></head><body><p data-testid="a">broken`,
        );
        const targeted = await runBuild(root, ["--only", "a.html"]).catch((e) => ({ failed: true as const, error: e }));
        expect((targeted as { failed: true }).failed).toBe(true);

        // Prior artifact set is unchanged: B's sidecar entry, ownership, and
        // on-disk page outputs survive a failed targeted build.
        const afterSidecar = JSON.parse(await readFile(join(root, "dist", ".bascik", "server-scripts.json"), "utf8")) as {
          scripts: Record<string, { source?: string }>;
        };
        expect(Object.values(afterSidecar.scripts).some((s) => s.source?.includes("B server value"))).toBe(true);
        const afterOwnership = (await readFile(join(root, "dist", ".bascik", "ownership.json"), "utf8"));
        expect(afterOwnership).toBe(beforeOwnership);
        // A's unchanged prior output still on disk.
        expect(existsSync(join(root, "dist", "a.html"))).toBe(true);
        expect(beforeSidecar).toBeTruthy();
      } finally {
        await cleanupFixture(root);
      }
    }, 120000);
  }
});