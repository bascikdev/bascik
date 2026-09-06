/**
 * Prompt 101: ownership inventory unit tests.
 *
 * These cover the pure reconcile logic (exact replacement of rebuilt owners,
 * retention of untouched owners, obsolete-output computation) and the
 * staged/atomic finalize contract (corrupt/incompatible metadata degrades to
 * the safe additive fallback; a failed commit never breaks the previous valid
 * artifact set). The full CLI integration behavior is covered in
 * `targeted-build-owned-artifacts.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "src/pages", components: ["src/components"] },
    isBuild: true,
    generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
    only: ["blog/**"],
    minify: { identifiers: false },
  },
  shouldLog: vi.fn(() => true),
}));

import {
  reconcileOwnership,
  readOwnershipInventory,
  writeOwnershipInventory,
  finalizeOwnedArtifacts,
  validateInventory,
  ownershipTracker,
  emptyInventory,
  type OwnershipInventory,
  type OwnershipEntry,
} from "./ownership.ts";
import { manifestCollector } from "./manifest.ts";
import { cspHashCollector } from "./csp-hashes.ts";
import { serverSidecarRegistry, type ServerScriptEntry } from "./server-sidecar.ts";
import { BascikConfig } from "./config.ts";

const entry = (
  source: string,
  relSource: string,
  outputs: Array<{ file: string; route: string }>,
  scripts: string[] = [],
): OwnershipEntry => ({ source, relSource, outputs, scripts });

describe("reconcileOwnership", () => {
  const a = "/abs/src/pages/a.html";
  const b = "/abs/src/pages/b.html";
  const blog = "/abs/src/pages/blog/[slug].html";

  it("exactly replaces rebuilt owners and retains untouched owners", () => {
    const prior: OwnershipInventory = {
      ...emptyInventory(),
      owners: {
        [a]: entry(a, "pages/a.html", [{ file: "a.html", route: "/a" }], ["scriptA1"]),
        [b]: entry(b, "pages/b.html", [{ file: "b.html", route: "/b" }], ["scriptB1"]),
      },
    };
    // This build rebuilds A (script removed) and leaves B untouched.
    const current: Record<string, OwnershipEntry> = {
      [a]: entry(a, "pages/a.html", [{ file: "a.html", route: "/a" }], []),
    };
    const r = reconcileOwnership(prior, current);
    expect(r.inventory.owners[a].scripts).toEqual([]);
    // B retained untouched with its script.
    expect(r.inventory.owners[b].scripts).toEqual(["scriptB1"]);
    expect(r.obsoleteOutputs).toEqual([]);
    expect(r.degradedToAdditive).toBe(false);
  });

  it("prunes obsolete outputs for a rebuilt owner whose output set shrank", () => {
    const prior: OwnershipInventory = {
      ...emptyInventory(),
      owners: {
        [blog]: entry(blog, "pages/blog/[slug].html", [
          { file: "blog/one.html", route: "/blog/one" },
          { file: "blog/two.html", route: "/blog/two" },
        ]),
      },
    };
    const current: Record<string, OwnershipEntry> = {
      [blog]: entry(blog, "pages/blog/[slug].html", [{ file: "blog/one.html", route: "/blog/one" }]),
    };
    const r = reconcileOwnership(prior, current);
    expect(r.obsoleteOutputs.sort()).toEqual(["blog/two.html"]);
    expect(r.degradedToAdditive).toBe(false);
  });

  it("treats a missing prior inventory as the safe first-targeted (additive) build", () => {
    const current: Record<string, OwnershipEntry> = {
      [a]: entry(a, "pages/a.html", [{ file: "a.html", route: "/a" }]),
    };
    const r = reconcileOwnership(null, current);
    expect(r.degradedToAdditive).toBe(true);
    expect(r.obsoleteOutputs).toEqual([]);
    expect(r.inventory.owners[a]).toBeDefined();
  });
});

describe("ownership inventory persistence & integrity", () => {
  const tempDir = join(tmpdir(), `bascik-ownership-${Date.now()}`);

  beforeEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(join(tempDir, ".bascik"), { recursive: true });
    ownershipTracker.clear();
    manifestCollector.clear();
    cspHashCollector.clear();
    serverSidecarRegistry.clear();
    (BascikConfig as any).directory.out = tempDir;
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).generate.manifest = true;
    (BascikConfig as any).generate.cspHashes = true;
    (BascikConfig as any).only = ["blog/**"];
  });

  it("rejects corrupt ownership metadata by falling back to a safe additive build and warns", async () => {
    await writeFile(join(tempDir, ".bascik", "ownership.json"), "{ not json", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const inv = await readOwnershipInventory();
    expect(inv).toBeNull();
    const source = resolve(tempDir, "src/pages/index.html");
    ownershipTracker.recordOutput(source, "pages/index.html", "index.html", "/");
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no compatible ownership inventory"));
    // A fresh inventory is written so future builds are correct.
    const fresh = await readOwnershipInventory();
    expect(fresh?.owners[source]).toBeDefined();
    warnSpy.mockRestore();
  });

  it("fails honestly on an incompatible on-disk schema (treated as no reliable ownership)", async () => {
    await writeFile(
      join(tempDir, ".bascik", "ownership.json"),
      JSON.stringify({ ...emptyInventory(), schema: 999 }),
      "utf8",
    );
    expect(await readOwnershipInventory()).toBeNull();
  });

  it("validateInventory rejects malformed owner entries before write", () => {
    const bad: OwnershipInventory = {
      ...emptyInventory(),
      owners: {
        "/src/a.html": { source: "/src/DIFFERENT.html", relSource: "pages/a.html", outputs: [], scripts: [] },
      },
    };
    expect(() => validateInventory(bad)).toThrow(/corrupt owner entry/);
  });

  it("finalize writes ownership even when no scripts and no CSP but records outputs", async () => {
    const source = resolve(tempDir, "src/pages/index.html");
    ownershipTracker.recordOutput(source, "pages/index.html", "index.html", "/");
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
    const inv = await readOwnershipInventory();
    expect(inv?.owners[source].outputs).toEqual([{ file: "index.html", route: "/" }]);
  });

  it("a failed artifact write leaves the previous valid ownership untouched (rollback contract)", async () => {
    // Write a valid prior inventory, then force the manifest write to fail so
    // the finalize transaction aborts before the ownership is replaced.
    const source = resolve(tempDir, "src/pages/a.html");
    await writeOwnershipInventory({
      ...emptyInventory(),
      owners: { [source]: entry(source, "pages/a.html", [{ file: "a.html", route: "/a" }]) },
    });
    const prior = await readOwnershipInventory();
    expect(prior).not.toBeNull();
    ownershipTracker.recordOutput(source, "pages/a.html", "a.html", "/a");

    // Make the .bascik dir read-only so atomicWriteJson's rename fails.
    if (process.platform !== "win32") {
      await (await import("node:fs/promises")).chmod(join(tempDir, ".bascik"), 0o500);
    }
    let threw = false;
    try {
      await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
    } catch {
      threw = true;
    } finally {
      if (process.platform !== "win32") {
        await (await import("node:fs/promises")).chmod(join(tempDir, ".bascik"), 0o700);
      }
    }
    // The previous ownership file must still exist and be valid.
    const after = await readOwnershipInventory();
    expect(threw).toBe(true);
    expect(after?.owners[source].outputs).toEqual([{ file: "a.html", route: "/a" }]);
  });

  it("sidecar reconcile retains untouched owners' scripts and prunes removed scripts", async () => {
    const sourceA = resolve(tempDir, "src/pages/a.html");
    const sourceB = resolve(tempDir, "src/pages/b.html");
    // Prior build: A and B both had a server script.
    await writeOwnershipInventory({
      ...emptyInventory(),
      owners: {
        [sourceA]: entry(sourceA, "pages/a.html", [{ file: "a.html", route: "/a" }], ["scriptA"]),
        [sourceB]: entry(sourceB, "pages/b.html", [{ file: "b.html", route: "/b" }], ["scriptB"]),
      },
    });
    // Prior sidecar on disk holds both scripts.
    await writeFile(
      join(tempDir, ".bascik", "server-scripts.json"),
      JSON.stringify({
        version: "1.0.0",
        schema: 2,
        scripts: {
          scriptA: { id: "scriptA", mode: "server", source: "a-source" } as ServerScriptEntry,
          scriptB: { id: "scriptB", mode: "server", source: "b-source" } as ServerScriptEntry,
        },
      }),
      "utf8",
    );
    // This build rebuilds A (script removed) and records nothing; B untouched.
    ownershipTracker.recordOutput(sourceA, "pages/a.html", "a.html", "/a");
    serverSidecarRegistry.recordScript("scriptA", "a-source");

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });

    const sidecar = JSON.parse(await readFile(join(tempDir, ".bascik", "server-scripts.json"), "utf8"));
    // A's removed script pruned; B's untouched script retained from prior.
    expect(sidecar.scripts["scriptA"]).toBeUndefined();
    expect(sidecar.scripts["scriptB"].source).toBe("b-source");
  });
});