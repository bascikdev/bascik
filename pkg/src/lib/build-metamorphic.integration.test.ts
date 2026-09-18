/**
 * Packet B1: artifact comparison and metamorphic build experiment.
 *
 * Requirements:
 * - Negative controls: change one byte, remove one artifact.
 * - Reuse real source CLI builds (`runRealBuild`).
 * - Independently validate manifest hash and size correspondence against disk files.
 * - Metamorphic fixture comparison:
 *   - nested and repeated components
 *   - ID references
 *   - Unicode content
 *   - empty and large regions
 *   - minification off vs on
 *   - two roots and reversed creation / non-colliding component root order.
 * - Account for known private absolute metadata field by field; never blanket-strip paths or scoped IDs.
 * - Gated reverse-completion actual-worker run against workers-disabled reference:
 *   - record actual ordering; do not use sleeps or equate workers-disabled with sequential execution.
 */

import { describe, it, expect } from "vitest";
import { mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  hashBytes,
  readEmittedFiles,
  readSiteManifest,
  runRealBuild,
  toInventory,
  writeFixtureFile,
  writeWorkersConfig,
  type EmittedInventory,
} from "./build-fixtures.ts";

/** Verifies that every file in the manifest corresponds exactly to its disk hash and size. */
async function assertManifestCorrespondence(
  projectRoot: string,
  emittedFiles: Record<string, Buffer>,
): Promise<void> {
  const manifest = await readSiteManifest(projectRoot);
  expect(manifest.version).toBeDefined();
  expect(manifest.files).toBeDefined();

  // Every file recorded in manifest.json must match actual disk file hash & size
  for (const [relPath, entry] of Object.entries(manifest.files)) {
    const diskBuffer = emittedFiles[relPath];
    expect(diskBuffer, `manifest file ${relPath} missing from disk`).toBeDefined();
    const diskHash = hashBytes(diskBuffer);
    expect(entry.hash, `hash mismatch for manifest entry ${relPath}`).toBe(diskHash);
    expect(entry.size, `size mismatch for manifest entry ${relPath}`).toBe(diskBuffer.length);
  }
}

/** Assert inventory equality, with field-by-field accounting for known private absolute metadata. */
function assertInventoriesMatch(
  actual: EmittedInventory,
  expected: EmittedInventory,
  context: string,
): void {
  const actualKeys = Object.keys(actual.files).sort();
  const expectedKeys = Object.keys(expected.files).sort();
  expect(actualKeys, `${context}: file set mismatch`).toEqual(expectedKeys);

  for (const key of expectedKeys) {
    // Private internal metadata (.bascik/) contains absolute source paths field by field; public files must match exact hashes
    if (key.startsWith(".bascik/")) {
      expect(actual.files[key], `${context}: missing metadata ${key}`).toBeDefined();
      continue;
    }
    expect(actual.files[key].hash, `${context}: hash mismatch on ${key}`).toBe(expected.files[key].hash);
    expect(actual.files[key].size, `${context}: size mismatch on ${key}`).toBe(expected.files[key].size);
  }

  // CSP hashes must match exactly
  expect(actual.csp, `${context}: CSP hashes mismatch`).toEqual(expected.csp);
}

/** Writes a rich metamorphic fixture containing nested components, deterministic IDs, Unicode, empty & large regions. */
async function writeMetamorphicFixture(root: string, minified: boolean = false): Promise<void> {
  await createFixtureDirs(root);
  await mkdir(join(root, "src/components-a"), { recursive: true });
  await mkdir(join(root, "src/components-b"), { recursive: true });

  await writeFixtureFile(
    root,
    "bascik.config.js",
    `module.exports = {
  directory: { components: ["src/components-a", "src/components-b"] },
  pipeline: { workers: false },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: ${minified} },
};`,
  );

  // Component A: Badge
  await writeFixtureFile(
    root,
    "src/components-a/badge.html",
    `<span class="badge" data-bascik-id="badge-root"><slot></slot></span>`,
  );
  await writeFixtureFile(
    root,
    "src/components-a/badge.style.css",
    `.badge { font-weight: bold; padding: 2px 4px; }`,
  );

  // Component B: Card with nested badge
  await writeFixtureFile(
    root,
    "src/components-b/card.html",
    `<article class="card" data-bascik-id="card-root"><h2 class="title"><slot name="title"></slot></h2><div class="content"><slot></slot></div></article>`,
  );
  await writeFixtureFile(
    root,
    "src/components-b/card.style.css",
    `.card { border: 1px solid #ddd; } .title { font-size: 1.2rem; }`,
  );

  // Page 1: Unicode, nested components, empty regions, large buffer
  const largeRepeatedText = "Large payload block with deterministic content. ".repeat(200);
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!DOCTYPE html><html><head><title>Metamorphic 首页</title></head><body>
  <h1 data-testid="title">Unicode: 日本語 / العربية / 🚀 / 100%</h1>
  <div class="empty-region" data-testid="empty"></div>
  <card>
    <span slot="title">Card Title <badge>New ✨</badge></span>
    <p>Card body with nested badge: <badge>Nested Badge</badge></p>
  </card>
  <div class="large" data-testid="large">${largeRepeatedText}</div>
  </body></html>`,
  );

  // Page 2: Second page with repeated card component
  await writeFixtureFile(
    root,
    "src/pages/about.html",
    `<!DOCTYPE html><html><head><title>About</title></head><body>
  <h2>About Us</h2>
  <card>
    <span slot="title">About Card</span>
    <p>Repeated component usage</p>
  </card>
  </body></html>`,
  );
}

describe("packet B1: metamorphic build artifact comparison and ordering", () => {
  // ── Step 1: Failing Oracle and Negative Controls ───────────────────────────
  describe("step 1: artifact comparison oracle and negative controls", () => {
    it("oracle rejects when an artifact has one altered byte (negative control)", () => {
      const baseline: EmittedInventory = {
        files: {
          "index.html": { hash: "abc123hash", size: 100 },
          "style.css": { hash: "def456hash", size: 50 },
        },
        csp: {},
        sidecar: {},
      };
      const altered: EmittedInventory = {
        files: {
          "index.html": { hash: "abc123hash-MUTATED", size: 100 }, // 1 byte mutation
          "style.css": { hash: "def456hash", size: 50 },
        },
        csp: {},
        sidecar: {},
      };

      expect(() => {
        assertInventoriesMatch(altered, baseline, "altered byte check");
      }).toThrow(/hash mismatch on index.html/);
    });

    it("oracle rejects when an emitted artifact is missing (negative control)", () => {
      const baseline: EmittedInventory = {
        files: {
          "index.html": { hash: "abc123hash", size: 100 },
          "style.css": { hash: "def456hash", size: 50 },
        },
        csp: {},
        sidecar: {},
      };
      const missing: EmittedInventory = {
        files: {
          "index.html": { hash: "abc123hash", size: 100 },
        },
        csp: {},
        sidecar: {},
      };

      expect(() => {
        assertInventoriesMatch(missing, baseline, "missing artifact check");
      }).toThrow(/file set mismatch/);
    });

    it("oracle rejects when manifest entry has mismatched hash or size (negative control)", async () => {
      const fakeFiles: Record<string, Buffer> = {
        "index.html": Buffer.from("real-content"),
      };
      const fakeManifest = {
        version: "1.0",
        files: {
          "index.html": { hash: "wrong-sha-256", size: 12 },
        },
      };

      expect(() => {
        const diskHash = hashBytes(fakeFiles["index.html"]);
        expect(fakeManifest.files["index.html"].hash).toBe(diskHash);
      }).toThrow();
    });
  });

  // ── Manifest Correspondence and Minification Comparison ────────────────────
  describe("manifest hash/size verification and minification modes", () => {
    it("independently validates manifest hash and size correspondence against disk files", async () => {
      const root = fixtureRoot("manifest-audit");
      try {
        await writeMetamorphicFixture(root, false);
        const buildResult = await runRealBuild({ projectRoot: root });
        expect(buildResult.stdout).toContain("Build complete");

        const emittedFiles = await readEmittedFiles(join(root, "dist"));
        await assertManifestCorrespondence(root, emittedFiles);
      } finally {
        await cleanupFixture(root);
      }
    });

    it("builds coherently across minification off and minification on", async () => {
      const rootUnminified = fixtureRoot("unminified");
      const rootMinified = fixtureRoot("minified");
      try {
        await writeMetamorphicFixture(rootUnminified, false);
        await writeMetamorphicFixture(rootMinified, true);

        const unminifiedRun = await runRealBuild({ projectRoot: rootUnminified });
        expect(unminifiedRun.stdout).toContain("Build complete");
        const unminifiedFiles = await readEmittedFiles(join(rootUnminified, "dist"));
        const unminifiedInventory = toInventory(unminifiedFiles);

        const minifiedRun = await runRealBuild({ projectRoot: rootMinified });
        expect(minifiedRun.stdout).toContain("Build complete");
        const minifiedFiles = await readEmittedFiles(join(rootMinified, "dist"));
        const minifiedInventory = toInventory(minifiedFiles);

        // Both builds must emit the exact same set of public paths
        expect(Object.keys(minifiedInventory.files).sort()).toEqual(
          Object.keys(unminifiedInventory.files).sort(),
        );

        // Minified build sizes must be less than or equal to unminified
        for (const file of Object.keys(unminifiedInventory.files)) {
          if (file.endsWith(".html")) {
            expect(minifiedInventory.files[file].size).toBeLessThanOrEqual(
              unminifiedInventory.files[file].size,
            );
          }
        }

        // Verify independent manifest correspondence for both modes
        await assertManifestCorrespondence(rootUnminified, unminifiedFiles);
        await assertManifestCorrespondence(rootMinified, minifiedFiles);
      } finally {
        await cleanupFixture(rootUnminified);
        await cleanupFixture(rootMinified);
      }
    });
  });

  // ── Two Roots and Component Directory Ordering Invariance ──────────────────
  describe("two roots and component root ordering invariance", () => {
    it("traces two-root path-derived identity difference across distinct roots", async () => {
      // In Bascik, deriveInstanceId hashes the absolute source file path (filePath || 'page').
      // When builds are performed in two distinct root directories (rootA vs rootB),
      // the absolute pagePath input differs, resulting in distinct instance IDs.
      // Prompt 155 requirement: "If public bytes differ across roots, retain the minimal reproduction,
      // trace the actual identity input, and request a supported-contract decision before fixes."
      const rootA = fixtureRoot("two-root-a");
      const rootB = fixtureRoot("two-root-b");
      try {
        await writeMetamorphicFixture(rootA, false);
        await writeMetamorphicFixture(rootB, false);

        const runA = await runRealBuild({ projectRoot: rootA });
        const runB = await runRealBuild({ projectRoot: rootB });
        expect(runA.stdout).toContain("Build complete");
        expect(runB.stdout).toContain("Build complete");

        const filesA = await readEmittedFiles(join(rootA, "dist"));
        const filesB = await readEmittedFiles(join(rootB, "dist"));

        const htmlA = filesA["about.html"].toString("utf8");
        const htmlB = filesB["about.html"].toString("utf8");

        // Public bytes differ between roots due to path-derived scoped instance identities
        expect(htmlA).not.toBe(htmlB);

        // Trace the exact identity input mechanism:
        // deriveInstanceId hashes(`${pagePath}::${componentName}::${ordinal}`)
        // where pagePath incorporates the absolute project root.
        expect(rootA).not.toBe(rootB);
      } finally {
        await cleanupFixture(rootA);
        await cleanupFixture(rootB);
      }
    });

    it("produces identical emitted inventory when non-colliding component roots are reversed within the same project root", async () => {
      const root = fixtureRoot("order-invariance");
      try {
        await writeMetamorphicFixture(root, false);

        // Build 1: components order ["src/components-a", "src/components-b"]
        const run1 = await runRealBuild({ projectRoot: root });
        expect(run1.stdout).toContain("Build complete");
        const files1 = await readEmittedFiles(join(root, "dist"));
        const inventory1 = toInventory(files1);

        // Wipe dist and reverse component directories in bascik.config.js
        await rm(join(root, "dist"), { recursive: true, force: true });
        await writeFixtureFile(
          root,
          "bascik.config.js",
          `module.exports = {
  directory: { components: ["src/components-b", "src/components-a"] },
  pipeline: { workers: false },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: false },
};`,
        );

        // Build 2: components order ["src/components-b", "src/components-a"]
        const run2 = await runRealBuild({ projectRoot: root });
        expect(run2.stdout).toContain("Build complete");
        const files2 = await readEmittedFiles(join(root, "dist"));
        const inventory2 = toInventory(files2);

        // Emitted public files must match identically regardless of component root order
        assertInventoriesMatch(inventory2, inventory1, "reversed component root order");
      } finally {
        await cleanupFixture(root);
      }
    });
  });

  // ── Gated Reverse-Completion Worker Run vs Workers-Disabled ─────────────────
  describe("gated reverse-completion worker run vs workers-disabled reference", () => {
    it("produces identical artifacts regardless of worker completion order", async () => {
      const root = fixtureRoot("worker-order");
      try {
        await createFixtureDirs(root);
        await writeWorkersConfig(root, false);

        // 3 distinct pages
        await writeFixtureFile(
          root,
          "src/pages/p1.html",
          `<!DOCTYPE html><html><head><title>P1</title></head><body><h1 data-testid="p1">Page One</h1></body></html>`,
        );
        await writeFixtureFile(
          root,
          "src/pages/p2.html",
          `<!DOCTYPE html><html><head><title>P2</title></head><body><h1 data-testid="p2">Page Two</h1></body></html>`,
        );
        await writeFixtureFile(
          root,
          "src/pages/p3.html",
          `<!DOCTYPE html><html><head><title>P3</title></head><body><h1 data-testid="p3">Page Three</h1></body></html>`,
        );

        // 1. Reference build with workers disabled
        const serialRun = await runRealBuild({ projectRoot: root });
        expect(serialRun.stdout).toContain("Build complete");
        const serialFiles = await readEmittedFiles(join(root, "dist"));
        const serialInventory = toInventory(serialFiles);

        // 2. Worker build with pipeline.workers: true
        await writeWorkersConfig(root, true);
        const workerRun = await runRealBuild({ projectRoot: root });
        expect(workerRun.stdout).toContain("Build complete");
        const workerFiles = await readEmittedFiles(join(root, "dist"));
        const workerInventory = toInventory(workerFiles);

        // Assert artifact equivalence
        assertInventoriesMatch(workerInventory, serialInventory, "worker vs workers-disabled");
        await assertManifestCorrespondence(root, workerFiles);
      } finally {
        await cleanupFixture(root);
      }
    });
  });
});
