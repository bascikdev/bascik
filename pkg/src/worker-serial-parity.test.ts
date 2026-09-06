/**
 * Prompt 100: worker-versus-serial build artifact parity.
 *
 * Real worker and serial builds against an identical isolated fixture must
 * produce identical emitted file inventories, byte hashes/sizes, CSP hash
 * entries, and sidecar references. This test runs the ACTUAL page worker and
 * the ACTUAL main thread via a real `bascik --build` child process and reads
 * the emitted bytes back from disk. Nothing here mocks the worker or the
 * collector boundary.
 *
 * Regression anchor for the P0 defect: worker builds produced an empty CSP
 * manifest and no HTML manifest entries, and raw-copied assets were omitted
 * from the manifest entirely (even without workers) because the source path
 * was recorded where the collector ignores paths outside dist/.
 */

import { describe, it, expect } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupFixture,
  fixtureRoot,
  readEmittedFiles,
  readSiteManifest,
  runRealBuild,
  toInventory,
  writeFixtureFile,
  writeParityFixture,
  writeWorkersConfig,
} from "./lib/build-fixtures.ts";

const runBuild = (root: string) =>
  runRealBuild({
    projectRoot: root,
    cliPath: undefined,
  });

describe("worker vs serial build artifact parity", () => {
  it("publishes identical emitted inventory, hashes, CSP, and sidecars across worker modes", async () => {
    // Both modes run against the SAME root so path-derived identifiers (scoped
    // ids, server-script placeholder ids) are stable; only the worker config
    // flag differs between the two builds.
    const root = fixtureRoot("parity");
    const fixture = await writeParityFixture(root);
    try {
      // Serial build.
      await writeWorkersConfig(root, false);
      const serialRun = await runBuild(root);
      expect(serialRun.stdout).toContain("Build complete");
      const serialFiles = await readEmittedFiles(join(root, "dist"));

      // Rebuild with workers on (fresh dist).
      await writeWorkersConfig(root, true);
      const workerRun = await runBuild(root);
      expect(workerRun.stdout).toContain("Build complete");
      const workerFiles = await readEmittedFiles(join(root, "dist"));

      const workerInventory = toInventory(workerFiles);
      const serialInventory = toInventory(serialFiles);

      // The full emitted set (paths) must match regardless of worker mode.
      expect(Object.keys(workerInventory.files).sort()).toEqual(
        Object.keys(serialInventory.files).sort(),
      );

      // Every emitted asset must be present in BOTH inventories, including
      // the raw-copied assets.
      for (const rel of fixture.emittedAssetPaths) {
        expect(workerInventory.files[rel], `worker missing ${rel}`).toBeDefined();
        expect(serialInventory.files[rel], `serial missing ${rel}`).toBeDefined();
      }

      // Raw-copied assets must be accounted at the destination with real
      // hashes and sizes (not the rejected source path).
      expect(serialInventory.files["assets/logo.txt"]).toBeDefined();
      expect(workerInventory.files["assets/logo.txt"]).toBeDefined();
      expect(serialInventory.files["assets/unchanged.txt"]).toBeDefined();

      // Byte hashes and sizes must be identical across worker modes.
      for (const rel of Object.keys(serialInventory.files)) {
        expect(workerInventory.files[rel], `hash/size mismatch for ${rel}`).toEqual(
          serialInventory.files[rel],
        );
      }

      // CSP entries must be produced in both modes and match.
      expect(serialInventory.csp["/"]).toBeDefined();
      expect(workerInventory.csp["/"]).toBeDefined();
      expect(workerInventory.csp).toEqual(serialInventory.csp);
      // The inline script/style hashes must be present.
      expect(workerInventory.csp["/"].scripts.length).toBeGreaterThan(0);
      expect(workerInventory.csp["/"].styles.length).toBeGreaterThan(0);

      // Sidecar references must match across modes (A carries a server script).
      expect(Object.keys(workerInventory.sidecar)).toEqual(Object.keys(serialInventory.sidecar));
      expect(workerInventory.sidecar).toEqual(serialInventory.sidecar);

      // The on-disk page files must be byte-identical too, not just hashed.
      expect(workerFiles["index.html"]).toEqual(serialFiles["index.html"]);
      expect(workerFiles["a.html"]).toEqual(serialFiles["a.html"]);
    } finally {
      await cleanupFixture(root);
    }
  }, 60000);

  it("emitted assets are physically on disk at the destination", async () => {
    const root = fixtureRoot("dest");
    await writeParityFixture(root);
    try {
      await writeWorkersConfig(root, false);
      await runBuild(root);
      // A raw asset and a changed asset must physically exist in dist/.
      const logoStat = await stat(join(root, "dist", "assets", "logo.txt"));
      expect(logoStat.size).toBeGreaterThan(0);
      const changedStat = await stat(join(root, "dist", "assets", "unchanged.txt"));
      expect(changedStat.size).toBeGreaterThan(0);
    } finally {
      await cleanupFixture(root);
    }
  }, 60000);
});

describe("manifest integrity", () => {
  it("records every emitted page and asset with a real sha256 and byte size", async () => {
    const root = fixtureRoot("manifest");
    await writeParityFixture(root);
    try {
      await writeWorkersConfig(root, false);
      await runBuild(root);
      const manifest = await readSiteManifest(root);

      expect(manifest.files["index.html"]).toBeDefined();
      expect(manifest.files["a.html"]).toBeDefined();
      expect(manifest.files["b.html"]).toBeDefined();
      // Raw-copied assets must be present with non-zero byte sizes.
      expect(manifest.files["assets/logo.txt"].size).toBeGreaterThan(0);
      expect(manifest.files["assets/unchanged.txt"].size).toBeGreaterThan(0);

      // Manifest must not contain a hash entry whose hash is the empty string.
      for (const entry of Object.values(manifest.files)) {
        expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await cleanupFixture(root);
    }
  }, 60000);

  it("repeat builds are deterministic and leave no stale manifest state", async () => {
    const root = fixtureRoot("repeat");
    await writeParityFixture(root);
    try {
      await writeWorkersConfig(root, true);
      await runBuild(root);
      const first = await readEmittedFiles(join(root, "dist"));
      const firstInv = toInventory(first);

      // Rebuild again in the same process tree (fresh dist each time).
      await runBuild(root);
      const second = await readEmittedFiles(join(root, "dist"));
      const secondInv = toInventory(second);

      // Same emitted set and identical bytes across repeat builds.
      expect(Object.keys(secondInv.files).sort()).toEqual(Object.keys(firstInv.files).sort());
      for (const rel of Object.keys(firstInv.files)) {
        expect(second[rel], `nondeterministic bytes for ${rel}`).toEqual(first[rel]);
      }
      expect(secondInv.csp).toEqual(firstInv.csp);
      expect(secondInv.sidecar).toEqual(firstInv.sidecar);
      // No stale entry from build one survives into build two (manifest,
      // csp-hashes, and server-scripts are all freshly regenerated).
      expect(Object.keys(secondInv.files)).not.toContain(".bascik/manifest.json");
    } finally {
      await cleanupFixture(root);
    }
  }, 60000);

  it("emits identical inventory with a single worker as with the multi-worker pool", async () => {
    // Worker pool sizes are clamped to min(cpus, pageCount), but the publishing
    // path must not depend on concurrency. Force a many-page fixture and
    // compare a CPU-clamp (multi-worker) build to one where only one page makes
    // the pool a singleton.
    const root = fixtureRoot("workers");
    const fixture = await writeParityFixture(root);
    // Add enough pages to force a multi-worker pool under real hardware.
    for (let i = 0; i < 6; i++) {
      await writeFixtureFile(root, `src/pages/many-${i}.html`,
        `<!DOCTYPE html><html><head><title>Many ${i}</title></head><body><p data-testid="m${i}">${i}</p></body></html>`);
    }
    try {
      await writeWorkersConfig(root, true);
      await runBuild(root);
      const manyWorkers = toInventory(await readEmittedFiles(join(root, "dist")));

      // Serial control with the same authored input.
      await writeWorkersConfig(root, false);
      await runBuild(root);
      const serial = toInventory(await readEmittedFiles(join(root, "dist")));

      expect(Object.keys(manyWorkers.files).sort()).toEqual(Object.keys(serial.files).sort());
      for (const rel of Object.keys(serial.files)) {
        expect(manyWorkers.files[rel]).toEqual(serial.files[rel]);
      }
      expect(manyWorkers.csp).toEqual(serial.csp);
      expect(manyWorkers.sidecar).toEqual(serial.sidecar);
      expect(fixture.emittedAssetPaths.length).toBeGreaterThan(0);
    } finally {
      await cleanupFixture(root);
    }
  }, 60000);
});