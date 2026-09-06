import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "src/pages", components: ["src/components"] },
    isBuild: true,
    generate: {
      manifest: true,
      cspHashes: true,
      sitemap: true,
      robots: true,
    },
    only: ["blog/**"],
  },
  shouldLog: vi.fn(() => true),
}));

import { resolveCliAction } from "./cli.ts";
import { filterPagesByOnlyGlobs } from "./targeted-build.ts";
import { manifestCollector, type BuildManifest } from "./manifest.ts";
import { cspHashCollector, type CspHashesManifest } from "./csp-hashes.ts";
import { generateSitemapFiles } from "./sitemap.ts";
import { ownershipTracker, finalizeOwnedArtifacts, writeOwnershipInventory } from "./ownership.ts";
import { BascikConfig } from "./config.ts";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("targeted build CLI parsing & glob matching", () => {
  it("parses single --only <glob>", () => {
    const decision = resolveCliAction(["--build", "--only", "blog/**"]);
    expect(decision.action).toBe("build");
    expect(decision.flags.only).toEqual(["blog/**"]);
  });

  it("parses repeated --only flags and unions them", () => {
    const decision = resolveCliAction([
      "--build",
      "--only",
      "blog/**",
      "--only",
      "about.html",
    ]);
    expect(decision.action).toBe("build");
    expect(decision.flags.only).toEqual(["blog/**", "about.html"]);
  });

  it("parses --only=<glob> inline form", () => {
    const decision = resolveCliAction(["--build", "--only=blog/**"]);
    expect(decision.action).toBe("build");
    expect(decision.flags.only).toEqual(["blog/**"]);
  });

  it("rejects --only without --build", () => {
    const devDecision = resolveCliAction(["--only", "blog/**"]);
    expect(devDecision.action).toBe("error");
    expect(devDecision.errorMessage).toContain("--only only applies to --build");

    const serverDecision = resolveCliAction(["--server", "--only", "blog/**"]);
    expect(serverDecision.action).toBe("error");
    expect(serverDecision.errorMessage).toContain("--only only applies to --build");
  });

  it("rejects --only with an empty value", () => {
    const decision = resolveCliAction(["--build", "--only="]);
    expect(decision.action).toBe("error");
    expect(decision.errorMessage).toContain("--only requires a value");
  });

  it("matches page globs relative to pages directory", () => {
    const pageFiles = [
      "src/pages/index.html",
      "src/pages/about.html",
      "src/pages/blog/post-1.html",
      "src/pages/blog/post-2.html",
      "src/pages/nested/deep/page.html",
    ];
    const pagesDir = "src/pages";

    const matched1 = filterPagesByOnlyGlobs(pageFiles, ["blog/**"], pagesDir);
    expect(matched1).toEqual([
      "src/pages/blog/post-1.html",
      "src/pages/blog/post-2.html",
    ]);

    const matched2 = filterPagesByOnlyGlobs(pageFiles, ["about.html", "nested/**"], pagesDir);
    expect(matched2).toEqual([
      "src/pages/about.html",
      "src/pages/nested/deep/page.html",
    ]);
  });

  it("throws an error when a glob matches nothing", () => {
    const pageFiles = ["src/pages/index.html"];
    const pagesDir = "src/pages";

    expect(() => {
      filterPagesByOnlyGlobs(pageFiles, ["non-existent/**"], pagesDir);
    }).toThrow(/--only "non-existent\/\*\*" matched no pages/);
  });
});

describe("targeted build artifact merging and warnings", () => {
  const tempDir = join(tmpdir(), `bascik-targeted-build-${Date.now()}`);

  beforeEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
    manifestCollector.clear();
    cspHashCollector.clear();
    ownershipTracker.clear();
    (BascikConfig as any).directory.out = tempDir;
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).generate.manifest = true;
    (BascikConfig as any).generate.cspHashes = true;
    (BascikConfig as any).generate.sitemap = true;
    (BascikConfig as any).generate.robots = true;
    (BascikConfig as any).only = ["blog/**"];
  });

  it("reconciles manifest entries on targeted build, pruning a rebuilt owner's removed output", async () => {
    const manifestDir = join(tempDir, ".bascik");
    await mkdir(manifestDir, { recursive: true });
    // Prior build: index owned both index.html and a route that will be removed.
    const initialManifest: BuildManifest = {
      version: "1.0.0",
      files: {
        "index.html": { hash: "old-index-hash", size: 100 },
        "gone.html": { hash: "old-gone-hash", size: 50 },
      },
    };
    await writeFile(join(manifestDir, "manifest.json"), JSON.stringify(initialManifest, null, 2), "utf8");
    // Prior ownership: index owned both outputs. This build re-produces index
    // with only index.html, so gone.html is obsolete for the rebuilt owner.
    const sourceIndex = resolve(tempDir, "src/pages/index.html");
    await writeOwnershipInventory({
      version: "1",
      schema: 1,
      owners: {
        [sourceIndex]: {
          source: sourceIndex,
          relSource: "pages/index.html",
          outputs: [
            { file: "index.html", route: "/" },
            { file: "gone.html", route: "/gone" },
          ],
          scripts: [],
        },
      },
    });
    ownershipTracker.recordOutput(sourceIndex, "pages/index.html", "index.html", "/");
    manifestCollector.recordFile(join(tempDir, "index.html"), "<h1>Index</h1>");

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });

    const mergedContent = await readFile(join(manifestDir, "manifest.json"), "utf8");
    const merged = JSON.parse(mergedContent) as BuildManifest;

    expect(merged.files["index.html"]).toBeDefined();
    // gone.html was owned by the rebuilt (index) owner and is no longer
    // produced, so it is pruned.
    expect(merged.files["gone.html"]).toBeUndefined();
  });

  it("reconciles csp-hashes entries on targeted build, pruning a rebuilt owner's removed route", async () => {
    const cspDir = join(tempDir, ".bascik");
    await mkdir(cspDir, { recursive: true });
    const initialCsp: CspHashesManifest = {
      "/": { scripts: ["sha256-abc"], styles: [] },
      "/gone": { scripts: [], styles: ["sha256-def"] },
    };
    await writeFile(join(cspDir, "csp-hashes.json"), JSON.stringify(initialCsp, null, 2), "utf8");
    // Prior ownership: index owned both routes; this build owns only `/`.
    const sourceIndex = resolve(tempDir, "src/pages/index.html");
    await writeOwnershipInventory({
      version: "1",
      schema: 1,
      owners: {
        [sourceIndex]: {
          source: sourceIndex,
          relSource: "pages/index.html",
          outputs: [
            { file: "index.html", route: "/" },
            { file: "gone.html", route: "/gone" },
          ],
          scripts: [],
        },
      },
    });
    ownershipTracker.recordOutput(sourceIndex, "pages/index.html", "index.html", "/");
    cspHashCollector.recordPage("/", "<script>console.log(1)</script>");

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });

    const mergedContent = await readFile(join(cspDir, "csp-hashes.json"), "utf8");
    const merged = JSON.parse(mergedContent) as CspHashesManifest;

    expect(merged["/"]).toBeDefined();
    // The rebuilt owner dropped the `/gone` route, so it is pruned from CSP.
    expect(merged["/gone"]).toBeUndefined();
  });

  it("warns and skips sitemap generation on targeted build", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    await generateSitemapFiles(["pages/blog/post-1.html"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping sitemap and robots.txt generation during targeted build"),
    );
    warnSpy.mockRestore();
  });
});
