/**
 * Prompt 101: ownership inventory unit tests.
 *
 * These cover the pure reconcile logic (exact replacement of rebuilt owners,
 * retention of untouched owners, obsolete-output computation) and the
 * staged/atomic finalize contract (corrupt/incompatible metadata degrades to
 * the safe additive fallback; a failed commit never breaks the previous valid
 * artifact set). The full CLI integration behavior is covered in
 * `targeted-build-owned-artifacts.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./config.js", () => ({
  BascikConfig: {
    base: "/",
    directory: {
      out: "dist",
      pages: "src/pages",
      components: ["src/components"],
    },
    isBuild: true,
    generate: {
      manifest: true,
      cspHashes: true,
      sitemap: false,
      robots: false,
    },
    only: ["blog/**"],
    minify: { identifiers: false, html: false, css: false, js: false },
    // The component manifest (prompt 157) scopes every component once per
    // build, so the scoping config a build runs with is part of this mock.
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    scripts: { cache: { enabled: true }, onBuildScriptError: "error" },
    components: { external: [] },
  },
  shouldLog: vi.fn(() => true),
}));

// The component manifest is built from the full component list (the one
// processAllPages loads before the --only filter), which listComponents
// serves from its cache in a real build; here it is the test's list. Build
// scripts inside components go through runDirectiveHandler, mocked so the
// test can count child processes without spawning any.
const { listComponentsMock, runDirectiveHandlerMock } = vi.hoisted(() => ({
  listComponentsMock: vi.fn(),
  runDirectiveHandlerMock: vi.fn(),
}));
vi.mock("./components.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components.ts")>()),
  listComponents: listComponentsMock,
}));
vi.mock("./handler-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handler-runner.ts")>()),
  runDirectiveHandler: runDirectiveHandlerMock,
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
import {
  serverSidecarRegistry,
  SIDECAR_SCHEMA_VERSION,
  type ServerScriptEntry,
} from "./server-sidecar.ts";
import { computePageCspHashes } from "./csp-hashes.ts";
import { access } from "node:fs/promises";
import { BascikConfig } from "./config.ts";
import { privateDirFor } from "./private-dir.ts";

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
        [a]: entry(
          a,
          "pages/a.html",
          [{ file: "a.html", route: "/a" }],
          ["scriptA1"],
        ),
        [b]: entry(
          b,
          "pages/b.html",
          [{ file: "b.html", route: "/b" }],
          ["scriptB1"],
        ),
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
      [blog]: entry(blog, "pages/blog/[slug].html", [
        { file: "blog/one.html", route: "/blog/one" },
      ]),
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
  // A fresh directory per test: unique even across concurrent runs, and removed
  // afterward so repeated runs never accumulate files in the system temp dir.
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bascik-ownership-"));
    await mkdir(privateDirFor(tempDir), { recursive: true });
    ownershipTracker.clear();
    manifestCollector.clear();
    cspHashCollector.clear();
    serverSidecarRegistry.clear();
    (BascikConfig as any).directory.out = tempDir;
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).generate.manifest = true;
    (BascikConfig as any).generate.cspHashes = true;
    (BascikConfig as any).only = ["blog/**"];
    listComponentsMock.mockReset();
    listComponentsMock.mockResolvedValue({});
    runDirectiveHandlerMock.mockReset();
    runDirectiveHandlerMock.mockImplementation(async () => ({
      result: '<p class="built">built</p>',
      stdout: "",
      stderr: "",
      readsPageContext: false,
    }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(privateDirFor(tempDir), { recursive: true, force: true });
  });

  it("rejects corrupt ownership metadata by falling back to a safe additive build and warns", async () => {
    await writeFile(
      join(privateDirFor(tempDir), "ownership.json"),
      "{ not json",
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inv = await readOwnershipInventory();
    expect(inv).toBeNull();
    const source = resolve(tempDir, "src/pages/index.html");
    ownershipTracker.recordOutput(
      source,
      "pages/index.html",
      "index.html",
      "/",
    );
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no compatible ownership inventory"),
    );
    // A fresh inventory is written so future builds are correct.
    const fresh = await readOwnershipInventory();
    expect(fresh?.owners[source]).toBeDefined();
    warnSpy.mockRestore();
  });

  it("fails honestly on an incompatible on-disk schema (treated as no reliable ownership)", async () => {
    await writeFile(
      join(privateDirFor(tempDir), "ownership.json"),
      JSON.stringify({ ...emptyInventory(), schema: 999 }),
      "utf8",
    );
    expect(await readOwnershipInventory()).toBeNull();
  });

  it("validateInventory rejects malformed owner entries before write", () => {
    const bad: OwnershipInventory = {
      ...emptyInventory(),
      owners: {
        "/src/a.html": {
          source: "/src/DIFFERENT.html",
          relSource: "pages/a.html",
          outputs: [],
          scripts: [],
        },
      },
    };
    expect(() => validateInventory(bad)).toThrow(/corrupt owner entry/);
  });

  it("finalize writes ownership even when no scripts and no CSP but records outputs", async () => {
    const source = resolve(tempDir, "src/pages/index.html");
    ownershipTracker.recordOutput(
      source,
      "pages/index.html",
      "index.html",
      "/",
    );
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
    const inv = await readOwnershipInventory();
    expect(inv?.owners[source].outputs).toEqual([
      { file: "index.html", route: "/" },
    ]);
  });

  // The write is made to fail by removing write permission from the folder. Windows ignores those permission bits,
  // so nothing would fail there. The same rollback runs on every platform; only this way of forcing it is POSIX.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a failed artifact write leaves the previous valid ownership untouched (rollback contract)",
    async () => {
      // Write a valid prior inventory, then force the manifest write to fail so
      // the finalize transaction aborts before the ownership is replaced.
      const source = resolve(tempDir, "src/pages/a.html");
      await writeOwnershipInventory({
        ...emptyInventory(),
        owners: {
          [source]: entry(source, "pages/a.html", [
            { file: "a.html", route: "/a" },
          ]),
        },
      });
      const prior = await readOwnershipInventory();
      expect(prior).not.toBeNull();
      ownershipTracker.recordOutput(source, "pages/a.html", "a.html", "/a");

      // Make the .bascik dir read-only so atomicWriteJson's rename fails.
      await (
        await import("node:fs/promises")
      ).chmod(privateDirFor(tempDir), 0o500);
      let threw = false;
      try {
        await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
      } catch {
        threw = true;
      } finally {
        await (
          await import("node:fs/promises")
        ).chmod(privateDirFor(tempDir), 0o700);
      }
      // The previous ownership file must still exist and be valid.
      const after = await readOwnershipInventory();
      expect(threw).toBe(true);
      expect(after?.owners[source].outputs).toEqual([
        { file: "a.html", route: "/a" },
      ]);
    },
  );

  it("sidecar reconcile retains untouched owners' scripts and prunes removed scripts", async () => {
    const sourceA = resolve(tempDir, "src/pages/a.html");
    const sourceB = resolve(tempDir, "src/pages/b.html");
    // Prior build: A and B both had a server script.
    await writeOwnershipInventory({
      ...emptyInventory(),
      owners: {
        [sourceA]: entry(
          sourceA,
          "pages/a.html",
          [{ file: "a.html", route: "/a" }],
          ["scriptA"],
        ),
        [sourceB]: entry(
          sourceB,
          "pages/b.html",
          [{ file: "b.html", route: "/b" }],
          ["scriptB"],
        ),
      },
    });
    // Prior sidecar on disk holds both scripts.
    await writeFile(
      join(privateDirFor(tempDir), "server-scripts.json"),
      JSON.stringify({
        version: "1.0.0",
        schema: SIDECAR_SCHEMA_VERSION,
        scripts: {
          scriptA: {
            id: "scriptA",
            mode: "server",
            source: "a-source",
          } as ServerScriptEntry,
          scriptB: {
            id: "scriptB",
            mode: "server",
            source: "b-source",
          } as ServerScriptEntry,
        },
      }),
      "utf8",
    );
    // This build rebuilds A (script removed) and records nothing; B untouched.
    ownershipTracker.recordOutput(sourceA, "pages/a.html", "a.html", "/a");
    serverSidecarRegistry.recordScript("scriptA", "a-source");

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });

    const sidecar = JSON.parse(
      await readFile(
        join(privateDirFor(tempDir), "server-scripts.json"),
        "utf8",
      ),
    );
    // A's removed script pruned; B's untouched script retained from prior.
    expect(sidecar.scripts["scriptA"]).toBeUndefined();
    expect(sidecar.scripts["scriptB"].source).toBe("b-source");
  });
});

/**
 * Prompt 157: `.bascik/dist/components.json` joins the artifact transaction.
 * It exists iff the RECONCILED sidecar has page-owned server or stream
 * entries, is regenerated fully on every such build (full and targeted, so a
 * `--only` build of a static page still writes a fresh one), and goes away
 * when the last page script goes. Component-level jobs live in the sidecar
 * under the synthetic owner "components", regenerated every build and never
 * carried over. With `generate.cspHashes`, every route with a placeholder
 * lists the stable component hashes.
 */
describe("component manifest in the artifact transaction (prompt 157)", () => {
  let tempDir = "";
  const componentsPath = () => join(privateDirFor(tempDir), "components.json");
  const sidecarPath = () => join(privateDirFor(tempDir), "server-scripts.json");
  const cspPath = () => join(privateDirFor(tempDir), "csp-hashes.json");
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const readJson = async (path: string) =>
    JSON.parse(await readFile(path, "utf8"));
  const hex = (text: string) => Buffer.from(text).toString("hex");
  // Per test: the build script cache (on disk, keyed by the script text)
  // would otherwise answer a later test's build with an earlier test's run,
  // and the process counts here are each test's own.
  let nonce = "";
  let nonceCounter = 0;

  const COMPONENTS = () => ({
    "my-card": {
      fileName: "src/components/my-card/my-card.html",
      fileContent: `<div class="card"><p class="line">x</p><script>document.querySelector(".line").classList.add("seen");</script></div>`,
      cssFileContent:
        ".card { color: red } .line { margin: 0 } .seen { color: blue }",
    },
    "srv-card": {
      fileName: "src/components/srv-card/srv-card.html",
      fileContent: `<div class="wrap"><script data-bascik-server>export default () => '<p class="line">s</p>';</script></div>`,
      cssFileContent: ".wrap { margin: 0 } .line { color: red }",
    },
    "glow-card": {
      fileName: "src/components/glow-card/glow-card.html",
      fileContent: `<svg><filter id="glow"></filter></svg><div class="box"></div>`,
      cssFileContent: ".box { clip-path: url(#glow) }",
    },
    "built-card": {
      fileName: "src/components/built-card/built-card.html",
      fileContent: `<div class="shell"><script data-bascik-build>\n// ${nonce}\nexport default () => '<p class="built">built</p>';\n</script></div>`,
      cssFileContent: ".shell { margin: 0 } .built { color: red }",
    },
  });
  const componentJobId = `component_script_${hex("srv-card::1")}`;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bascik-ownership-manifest-"));
    await mkdir(privateDirFor(tempDir), { recursive: true });
    ownershipTracker.clear();
    manifestCollector.clear();
    cspHashCollector.clear();
    serverSidecarRegistry.clear();
    (BascikConfig as any).directory.out = tempDir;
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).generate.manifest = false;
    (BascikConfig as any).generate.cspHashes = false;
    (BascikConfig as any).only = undefined;
    nonce = `${process.pid}-${Date.now().toString(36)}-${++nonceCounter}`;
    listComponentsMock.mockReset();
    listComponentsMock.mockResolvedValue(COMPONENTS());
    runDirectiveHandlerMock.mockReset();
    runDirectiveHandlerMock.mockImplementation(async () => ({
      result: '<p class="built">built</p>',
      stdout: "",
      stderr: "",
      readsPageContext: false,
    }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(privateDirFor(tempDir), { recursive: true, force: true });
  });

  it('a full build with a page-owned server script writes components.json and the component jobs under owner "components"', async () => {
    const source = resolve(tempDir, "src/pages/a.html");
    ownershipTracker.recordOutput(source, "pages/a.html", "a.html", "/a");
    ownershipTracker.recordScript(source, "pages/a.html", "scriptA");
    serverSidecarRegistry.recordScript("scriptA", "a-source");

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: false });

    expect(await exists(componentsPath())).toBe(true);
    const manifest = await readJson(componentsPath());
    expect(manifest.schema).toBe(1);
    expect(Object.keys(manifest.components).sort()).toEqual(
      Object.keys(COMPONENTS()).sort(),
    );
    expect(manifest.components["srv-card"].jobs).toEqual([
      expect.objectContaining({ id: componentJobId, mode: "server" }),
    ]);

    const sidecar = await readJson(sidecarPath());
    expect(sidecar.schema).toBe(SIDECAR_SCHEMA_VERSION);
    expect(sidecar.scripts.scriptA.source).toBe("a-source");
    expect(sidecar.scripts[componentJobId]).toMatchObject({
      id: componentJobId,
      mode: "server",
      outputScope: expect.any(String),
    });

    const inventory = await readOwnershipInventory();
    expect(inventory?.owners.components).toEqual({
      source: "components",
      relSource: "components",
      outputs: [],
      scripts: [componentJobId],
    });
    expect(inventory?.owners[source].scripts).toEqual(["scriptA"]);
  });

  it('a static-only build writes no components.json, no sidecar and no "components" owner', async () => {
    const source = resolve(tempDir, "src/pages/index.html");
    ownershipTracker.recordOutput(
      source,
      "pages/index.html",
      "index.html",
      "/",
    );

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: false });

    expect(await exists(componentsPath())).toBe(false);
    expect(await exists(sidecarPath())).toBe(false);
    const inventory = await readOwnershipInventory();
    expect(inventory?.owners.components).toBeUndefined();
    expect(Object.keys(inventory?.owners ?? {})).toEqual([source]);
    // Nothing component-related ran: no build script, no component listing needed.
    expect(runDirectiveHandlerMock).not.toHaveBeenCalled();
  });

  it("a --only build of a static page regenerates the manifest from the untouched owner's scripts, runs each component build script once and never carries component jobs over", async () => {
    (BascikConfig as any).only = ["a.html"];
    const sourceA = resolve(tempDir, "src/pages/a.html");
    const sourceB = resolve(tempDir, "src/pages/b.html");
    await writeOwnershipInventory({
      ...emptyInventory(),
      owners: {
        [sourceA]: entry(sourceA, "pages/a.html", [
          { file: "a.html", route: "/a" },
        ]),
        [sourceB]: entry(
          sourceB,
          "pages/b.html",
          [{ file: "b.html", route: "/b" }],
          ["scriptB"],
        ),
        components: entry(
          "components",
          "components",
          [],
          ["component_script_old"],
        ),
      },
    });
    await writeFile(
      sidecarPath(),
      JSON.stringify({
        version: "1.0.0",
        schema: SIDECAR_SCHEMA_VERSION,
        scripts: {
          scriptB: { id: "scriptB", mode: "server", source: "b-source" },
          component_script_old: {
            id: "component_script_old",
            mode: "server",
            source: "stale-component-source",
          },
        },
      }),
      "utf8",
    );
    await writeFile(componentsPath(), '{"schema":1,"stale":true}', "utf8");
    // This process rebuilt only the static page A.
    ownershipTracker.recordOutput(sourceA, "pages/a.html", "a.html", "/a");

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });

    const manifest = await readJson(componentsPath());
    expect(manifest.stale).toBeUndefined();
    expect(Object.keys(manifest.components).sort()).toEqual(
      Object.keys(COMPONENTS()).sort(),
    );
    // The build script ran exactly once for the whole manifest build.
    expect(runDirectiveHandlerMock).toHaveBeenCalledTimes(1);

    const sidecar = await readJson(sidecarPath());
    expect(sidecar.schema).toBe(SIDECAR_SCHEMA_VERSION);
    expect(sidecar.scripts.scriptB.source).toBe("b-source");
    expect(sidecar.scripts.component_script_old).toBeUndefined();
    expect(sidecar.scripts[componentJobId]).toBeDefined();

    const inventory = await readOwnershipInventory();
    expect(inventory?.owners.components.scripts).toEqual([componentJobId]);
    expect(inventory?.owners[sourceB].scripts).toEqual(["scriptB"]);
  });

  it("removing the last page script deletes components.json while the empty sidecar remains", async () => {
    (BascikConfig as any).only = ["a.html"];
    const sourceA = resolve(tempDir, "src/pages/a.html");
    await writeOwnershipInventory({
      ...emptyInventory(),
      owners: {
        [sourceA]: entry(
          sourceA,
          "pages/a.html",
          [{ file: "a.html", route: "/a" }],
          ["scriptA"],
        ),
        components: entry("components", "components", [], [componentJobId]),
      },
    });
    await writeFile(
      sidecarPath(),
      JSON.stringify({
        version: "1.0.0",
        schema: SIDECAR_SCHEMA_VERSION,
        scripts: {
          scriptA: { id: "scriptA", mode: "server", source: "a-source" },
          [componentJobId]: {
            id: componentJobId,
            mode: "server",
            source: "component-source",
          },
        },
      }),
      "utf8",
    );
    await writeFile(componentsPath(), '{"schema":1,"components":{}}', "utf8");
    // A is rebuilt without its script.
    ownershipTracker.recordOutput(sourceA, "pages/a.html", "a.html", "/a");

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });

    expect(await exists(componentsPath())).toBe(false);
    const sidecar = await readJson(sidecarPath());
    expect(sidecar.schema).toBe(SIDECAR_SCHEMA_VERSION);
    expect(sidecar.scripts).toEqual({});
    const inventory = await readOwnershipInventory();
    expect(inventory?.owners.components).toBeUndefined();
    expect(runDirectiveHandlerMock).not.toHaveBeenCalled();
  });

  it("with generate.cspHashes, every placeholder route lists the stable component hashes and static routes do not", async () => {
    (BascikConfig as any).generate.cspHashes = true;
    (BascikConfig as any).only = ["a.html", "b.html"];
    const sourceA = resolve(tempDir, "src/pages/a.html");
    const sourceB = resolve(tempDir, "src/pages/b.html");
    const sourceC = resolve(tempDir, "src/pages/c.html");
    // C is untouched by this targeted build and keeps its script and entry.
    await writeOwnershipInventory({
      ...emptyInventory(),
      owners: {
        [sourceC]: entry(
          sourceC,
          "pages/c.html",
          [{ file: "c.html", route: "/c" }],
          ["scriptC"],
        ),
      },
    });
    await writeFile(
      sidecarPath(),
      JSON.stringify({
        version: "1.0.0",
        schema: SIDECAR_SCHEMA_VERSION,
        scripts: {
          scriptC: { id: "scriptC", mode: "stream", source: "c-source" },
        },
      }),
      "utf8",
    );
    await writeFile(
      cspPath(),
      JSON.stringify({ "/c": { scripts: [], styles: ["sha256-prior-c"] } }),
      "utf8",
    );
    ownershipTracker.recordOutput(sourceA, "pages/a.html", "a.html", "/a");
    ownershipTracker.recordScript(sourceA, "pages/a.html", "scriptA");
    serverSidecarRegistry.recordScript("scriptA", "a-source");
    ownershipTracker.recordOutput(sourceB, "pages/b.html", "b.html", "/b");
    const pageA = `<style>.page-a{}</style><script type="text/bascik-server" data-bascik-server-id="scriptA"></script>`;
    const pageB = `<style>.page-b{}</style><p>static</p>`;
    cspHashCollector.recordPage("/a", pageA);
    cspHashCollector.recordPage("/b", pageB);

    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });

    const manifest = await readJson(componentsPath());
    const stableStyles = Object.values(manifest.components)
      .filter((c: any) => c.cspStable.style && c.css?.hash)
      .map((c: any) => c.css.hash as string);
    const stableScripts = Object.values(manifest.components)
      .filter((c: any) => c.cspStable.script)
      .flatMap((c: any) => c.scriptHashes as string[]);
    // my-card, srv-card and built-card have dedupe CSS; glow-card is per instance.
    expect(stableStyles).toHaveLength(3);
    expect(manifest.components["glow-card"].css).toEqual({ perInstance: true });
    // my-card's class-only script is the one stable script hash.
    expect(stableScripts).toHaveLength(1);

    const csp = await readJson(cspPath());
    const sorted = (hashes: string[]) => [...hashes].sort();
    expect(csp["/a"].styles).toEqual(
      sorted([...computePageCspHashes(pageA).styles, ...stableStyles]),
    );
    expect(csp["/a"].scripts).toEqual(sorted(stableScripts));
    expect(csp["/c"].styles).toEqual(
      sorted(["sha256-prior-c", ...stableStyles]),
    );
    expect(csp["/c"].scripts).toEqual(sorted(stableScripts));
    // A static route carries only its own hashes.
    expect(csp["/b"]).toEqual(computePageCspHashes(pageB));
  });

  it("two targeted builds converge: an untouched placeholder route sheds a changed component's old hashes instead of accumulating them", async () => {
    (BascikConfig as any).generate.cspHashes = true;
    const sourceA = resolve(tempDir, "src/pages/a.html");
    const sourceB = resolve(tempDir, "src/pages/b.html");
    const sourceC = resolve(tempDir, "src/pages/c.html");
    const pageA = `<style>.page-a{}</style><script type="text/bascik-server" data-bascik-server-id="scriptA"></script>`;
    const pageB = `<style>.page-b{}</style><p>static</p>`;
    const stableHashes = async () => {
      const manifest = await readJson(componentsPath());
      const entries = Object.values(manifest.components) as any[];
      return {
        styles: entries
          .filter((c) => c.cspStable.style && c.css?.hash)
          .map((c) => c.css.hash as string),
        scripts: entries
          .filter((c) => c.cspStable.script)
          .flatMap((c) => c.scriptHashes as string[]),
      };
    };
    const sorted = (hashes: string[]) => [...hashes].sort();

    // Build 1: --only a.html; c is untouched with its own prior entry.
    (BascikConfig as any).only = ["a.html"];
    await writeOwnershipInventory({
      ...emptyInventory(),
      owners: {
        [sourceC]: entry(
          sourceC,
          "pages/c.html",
          [{ file: "c.html", route: "/c" }],
          ["scriptC"],
        ),
      },
    });
    await writeFile(
      sidecarPath(),
      JSON.stringify({
        version: "1.0.0",
        schema: SIDECAR_SCHEMA_VERSION,
        scripts: {
          scriptC: { id: "scriptC", mode: "stream", source: "c-source" },
        },
      }),
      "utf8",
    );
    await writeFile(
      cspPath(),
      JSON.stringify({ "/c": { scripts: [], styles: ["sha256-prior-c"] } }),
      "utf8",
    );
    ownershipTracker.recordOutput(sourceA, "pages/a.html", "a.html", "/a");
    ownershipTracker.recordScript(sourceA, "pages/a.html", "scriptA");
    serverSidecarRegistry.recordScript("scriptA", "a-source");
    cspHashCollector.recordPage("/a", pageA);
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
    const first = await stableHashes();
    const myCardHash = (await readJson(componentsPath())).components["my-card"]
      .css.hash as string;
    expect(first.styles).toContain(myCardHash);

    // Build 2 (a fresh process): my-card's stylesheet changed, --only b.html.
    ownershipTracker.clear();
    manifestCollector.clear();
    cspHashCollector.clear();
    serverSidecarRegistry.clear();
    const changed = COMPONENTS();
    changed["my-card"].cssFileContent =
      ".card { color: green } .line { margin: 1px } .seen { color: blue }";
    listComponentsMock.mockResolvedValue(changed);
    (BascikConfig as any).only = ["b.html"];
    ownershipTracker.recordOutput(sourceB, "pages/b.html", "b.html", "/b");
    cspHashCollector.recordPage("/b", pageB);
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: true });
    const second = await stableHashes();
    expect(second.styles).not.toContain(myCardHash);
    expect(second.scripts).toEqual(first.scripts);

    const csp = await readJson(cspPath());
    // What a full build would write: each route's own hashes plus the
    // current manifest's, and nothing from the previous manifest.
    expect(csp["/a"].styles).toEqual(
      sorted([...computePageCspHashes(pageA).styles, ...second.styles]),
    );
    expect(csp["/a"].styles).not.toContain(myCardHash);
    expect(csp["/a"].scripts).toEqual(sorted(second.scripts));
    expect(csp["/c"].styles).toEqual(
      sorted(["sha256-prior-c", ...second.styles]),
    );
    expect(csp["/c"].styles).not.toContain(myCardHash);
    expect(csp["/b"]).toEqual(computePageCspHashes(pageB));
  });
});
